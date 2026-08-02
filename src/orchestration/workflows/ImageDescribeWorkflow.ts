import { TFile } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowDeferredResult, WorkflowResult } from '../types';
import { SearchServiceUnavailableError } from '../../search/types';
import { logWarn } from '../../log';
import { localizedImageInfo, type LocalizedImageInfo } from '../utils/imageMetadata';
import { SERVICE_IMAGE_DESCRIPTION_PROVIDER } from '../serviceHealth';
import {
	IMAGE_DESCRIBE_BATCH_IMAGES,
	IMAGE_DESCRIBE_DEGENERATE_MAX_EXTRACTION_CHARS,
	IMAGE_DESCRIBE_ENQUEUE_YIELD_EVERY,
	ImageDescribeConfigError,
	computeReferencedImagePaths,
	describeMd5Images,
	importLegacyImageMetadataSidecars,
	referencingNotePaths,
	resolveImageDescribeModel,
	resolveNoteImages,
	type DescribeMd5ImagesResult,
} from '../utils/imageDescribe';

/** idh-WP-2: base backoff for the image-description provider breaker (`serviceUnhealthy` below)
 * — same order of magnitude as `SearchIndexWorkflow`'s `SEARCH_RETRY_AFTER_MS`, kept as its own
 * constant rather than a shared import since the two dependencies (search companion vs. the
 * vision model's inference endpoint) recover independently. */
const IMAGE_DESCRIBE_RETRY_AFTER_MS = 30_000;

/**
 * idh-WP-2 infra breaker: `describeMd5Images` sets `abortReason`/`abortKind` when a
 * connection-class error or `IMAGE_DESCRIBE_CONSECUTIVE_TIMEOUT_LIMIT` consecutive timeouts
 * stopped the loop early. Reported as `status: 'deferred'` + `serviceUnhealthy`, not a plain
 * `'failed'` — a provider outage is a dependency-level problem, and `serviceHealth.ts`'s own
 * module comment documents the prior incident this exact mis-classification caused elsewhere
 * (one search-companion outage → 2,022 independent failure files, because nothing above the job
 * level knew the outage existed). Routing through the registry stops the drain from claiming
 * further `image_describe_note`/`image_describe_batch` jobs while it's open, and re-queues THIS
 * job with its original params — already-described/failed images are skipped via `has()` on
 * retry, so resuming naturally only attempts the images that were never reached.
 */
function breakerDeferredResult(result: DescribeMd5ImagesResult, notes: string, outputPaths?: string[]): WorkflowDeferredResult {
	const reason = result.abortReason ?? 'image description provider unhealthy';
	return {
		status: 'deferred',
		...(outputPaths && outputPaths.length > 0 ? { outputPaths } : {}),
		error: reason,
		notes,
		retryAfterMs: IMAGE_DESCRIBE_RETRY_AFTER_MS,
		serviceUnhealthy: { service: SERVICE_IMAGE_DESCRIPTION_PROVIDER, kind: result.abortKind ?? 'server-error', reason },
	};
}

/**
 * Replaces `ImageMetadataExtractWorkflow` (`docs/multimodal-image-search.md` Decision 3): one
 * job per *note*, dedupe `note:<targetPath>` (`youtubeMetadataDedupeKey` precedent), resolving
 * the note's embedded `_MD5` images and running the shared describe core over them. Takes no
 * note lock — see `imageDescribe.ts`'s module doc.
 */
export class ImageDescribeNoteWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const targetPath = stringParam(job, 'targetPath');
		if (!targetPath) return { status: 'failed', error: 'Missing params.targetPath' };

		let resolved;
		try {
			resolved = resolveImageDescribeModel(plugin);
		} catch (e) {
			if (e instanceof ImageDescribeConfigError) return { status: 'failed', error: e.message };
			throw e;
		}

		const file = plugin.app.vault.getAbstractFileByPath(targetPath);
		if (!(file instanceof TFile)) return { status: 'failed', error: `Note not found: ${targetPath}` };

		const images = resolveNoteImages(plugin, file);
		if (images.length === 0) {
			return { status: 'done', notes: `No localized images embedded in ${targetPath}.` };
		}

		ctx.throwIfAborted();
		// Note-scoped jobs skip the batch prefix (no batchIndex/batchCount to name) —
		// just "described so far / total" for this note's images.
		let imagesReported = 0;
		const result = await describeMd5Images(plugin, resolved.provider, resolved.modelId, images, {
			signal: ctx.signal,
			onTiming: () => {
				imagesReported++;
				ctx.reportProgress(`${imagesReported} / ${images.length} images`);
			},
		});

		const reindexNote = await reindexNotes(plugin, [file]);
		plugin.ingestionEvents?.emit('image-described', { md5Count: result.describedCount, notePaths: reindexNote.indexed });

		const baseNotes = `Described ${result.describedCount} image(s) for ${targetPath} `
			+ `(${result.skippedCount} already described, ${result.missingCount} missing files, `
			+ `${result.failedCount} failed).`
			+ (reindexNote.note ? ` ${reindexNote.note}` : '');

		if (result.abortReason) {
			return breakerDeferredResult(result, `${baseNotes} ${result.abortReason}`, [file.path]);
		}

		return {
			status: 'done',
			outputPaths: [file.path],
			notes: baseNotes,
		};
	}
}

/**
 * The backfill fan-out (`docs/multimodal-image-search.md` Decision 3): a one-time legacy
 * sidecar sweep, then enumerate every referenced `_MD5` image (invert the orphaned-attachments
 * walk) and batch `IMAGE_DESCRIBE_BATCH_IMAGES` paths per `image_describe_batch` job — never one
 * job per image (the 37,081-job-file incident, see `AGENTS.md`).
 */
export class ImageDescribeBackfillWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;

		// Refuse up front, same reasoning as SearchEmbedMissingWorkflow: enqueueing dozens of
		// batches that each independently discover the same misconfiguration wastes queue
		// writes for nothing every batch would report identically. Batches re-resolve their own
		// model reference rather than trusting this snapshot — settings can change mid-backfill.
		try {
			resolveImageDescribeModel(plugin);
		} catch (e) {
			if (e instanceof ImageDescribeConfigError) return { status: 'failed', error: e.message };
			throw e;
		}

		const importResult = await importLegacyImageMetadataSidecars(plugin, plugin.imageDescriptions);
		ctx.throwIfAborted();

		await plugin.imageDescriptions.ensureLoaded();
		// idh-WP-1 self-heal: a vision record whose extraction is degenerately long is the on-disk
		// trace of a runaway generation (a temp-0 repetition loop with no cap) that finished before
		// timing out and so never got a `kind: 'failed'` record. Pruning drops it out of `has()`,
		// so the enumeration just below re-treats it as pending and re-describes it under the new
		// per-pass `max_tokens` caps.
		const prunedMd5s = await plugin.imageDescriptions.pruneDegenerate(IMAGE_DESCRIBE_DEGENERATE_MAX_EXTRACTION_CHARS);
		ctx.throwIfAborted();

		// idh-WP-2 self-heal: transient-class failed records (infra casualties — timeouts, connection
		// errors) are cleared on every backfill start so they re-enter pending, the same shape as
		// `pruneDegenerate` above applied to a different bug class. Permanent-class failed records
		// (genuinely poison images) are left alone — skip-forever stays correct for those.
		const prunedTransientMd5s = await plugin.imageDescriptions.pruneFailed('transient');
		ctx.throwIfAborted();

		const referenced = computeReferencedImagePaths(plugin);
		const pending = referenced.filter(image => !plugin.imageDescriptions.has(image.md5));
		const batches = chunk(pending.map(image => image.path), IMAGE_DESCRIBE_BATCH_IMAGES);

		for (let i = 0; i < batches.length; i++) {
			ctx.throwIfAborted();
			const paths = batches[i] ?? [];
			await plugin.orchestrator.enqueue('image_describe_batch', {
				paths,
				backfillId: job.id,
				batchIndex: i,
				batchCount: batches.length,
			}, { priority: 'low', lane: 'background', inputPaths: paths });
			if ((i + 1) % IMAGE_DESCRIBE_ENQUEUE_YIELD_EVERY === 0) await yieldToEventLoop();
		}

		return {
			status: 'done',
			notes: `Legacy sidecars imported: ${importResult.imported}. `
				+ `Pruned ${prunedMd5s.length} degenerate description(s) for re-describe. `
				+ `Pruned ${prunedTransientMd5s.length} transient-failed description(s) for re-describe. `
				+ `Queued image description backfill: ${pending.length} referenced image(s) `
				+ `(${referenced.length - pending.length} already described) in ${batches.length} batch(es).`,
		};
	}
}

/** One `IMAGE_DESCRIBE_BATCH_IMAGES`-sized slice of a backfill. */
export class ImageDescribeBatchWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const paths = stringArrayParam(job, 'paths');
		if (paths.length === 0) return { status: 'failed', error: 'Missing params.paths' };

		let resolved;
		try {
			resolved = resolveImageDescribeModel(plugin);
		} catch (e) {
			if (e instanceof ImageDescribeConfigError) return { status: 'failed', error: e.message };
			throw e;
		}

		const images: LocalizedImageInfo[] = [];
		for (const path of paths) {
			const info = localizedImageInfo(path);
			if (info) images.push(info);
		}

		const batchIndex = numberParam(job, 'batchIndex');
		const batchCount = numberParam(job, 'batchCount');
		const label = batchIndex >= 0 && batchCount > 0 ? `batch ${batchIndex + 1} / ${batchCount}` : 'batch';

		ctx.throwIfAborted();
		let imagesReported = 0;
		const result = await describeMd5Images(plugin, resolved.provider, resolved.modelId, images, {
			signal: ctx.signal,
			onTiming: () => {
				imagesReported++;
				ctx.reportProgress(`${label}: ${imagesReported} / ${images.length} images`);
			},
		});

		// Recomputed fresh, not carried from enqueue time: paths drift between when the backfill
		// enumerated this batch and when it actually runs (a note can move or gain/lose an embed).
		const notePaths = referencingNotePaths(plugin, paths);
		const noteFiles = notePaths
			.map(path => plugin.app.vault.getAbstractFileByPath(path))
			.filter((f): f is TFile => f instanceof TFile);
		const reindexed = await reindexNotes(plugin, noteFiles);

		plugin.ingestionEvents?.emit('image-described', { md5Count: result.describedCount, notePaths: reindexed.indexed });

		const baseNotes = `Described ${label}: ${result.describedCount} new, ${result.skippedCount} already described, `
			+ `${result.missingCount} missing, ${result.failedCount} failed; reindexed ${reindexed.indexed.length} note(s).`
			+ (reindexed.note ? ` ${reindexed.note}` : '');

		if (result.abortReason) {
			return breakerDeferredResult(result, `${baseNotes} ${result.abortReason}`, paths);
		}

		return {
			status: 'done',
			outputPaths: paths,
			notes: baseNotes,
		};
	}
}

/**
 * Re-index the notes embedding a just-described image so the folded description hash
 * (WP-2) makes `SearchManager.prepareFile` do real work. Never fails the describe job over a
 * search hiccup — the description already landed durably in `plugin.imageDescriptions`
 * (content-hash-keyed, so nothing here is lost), and any future normal reindex of the note picks
 * it up regardless of whether this particular reindex attempt succeeded.
 */
async function reindexNotes(plugin: WorkflowContext['plugin'], files: TFile[]): Promise<{ indexed: string[]; note?: string }> {
	if (files.length === 0) return { indexed: [] };
	if (!plugin.settings.searchEnabled) return { indexed: [], note: 'Search is disabled; skipped reindexing.' };
	try {
		await plugin.searchManager?.indexFiles(files);
		return { indexed: files.map(f => f.path) };
	} catch (e) {
		const message = e instanceof SearchServiceUnavailableError ? e.message : String(e instanceof Error ? e.message : e);
		logWarn('image describe: reindex after description failed; a later normal reindex will pick it up', message);
		return { indexed: [], note: `Reindex deferred: ${message}` };
	}
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

function yieldToEventLoop(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

function stringParam(job: OrchestrationJob, key: string): string {
	const value = job.params?.[key];
	return typeof value === 'string' ? value.trim() : '';
}

function stringArrayParam(job: OrchestrationJob, key: string): string[] {
	const value = job.params?.[key];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function numberParam(job: OrchestrationJob, key: string): number {
	const value = job.params?.[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : -1;
}
