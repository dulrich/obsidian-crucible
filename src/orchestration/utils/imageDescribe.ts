/**
 * WP-3's shared describe core (`docs/multimodal-image-search.md` Decision 3): the one place
 * that turns a localized `_MD5` image into a stored `ImageDescriptionRecord`. Both
 * `image_describe_note` (one note, its embedded images) and `image_describe_batch` (a backfill
 * slice of referenced image paths) drive the same loop here, so the skip/lock/transcode/two-pass
 * contract lives in exactly one place.
 *
 * Takes **no note lock, ever** — every write here targets `plugin.imageDescriptions` (a plugin
 * data file outside the vault's note tree), never a note. Cross-note/cross-batch dedup on the
 * same image is instead serialized under the `image::<md5>` resource lock
 * (`NoteLockManager.withResourceLock`, the `yt-video::<id>` exemplar in `utils/youtubeApi.ts`),
 * so two jobs racing the same embedded image never issue two model calls for it.
 */

import { TFile } from 'obsidian';
import type CruciblePlugin from '../../main';
import { providerModality, type CrucibleSettings, type Provider } from '../../types';
import { needsVisionTranscode, transcodeToPng, extractSvgText } from '../../search/imageTranscode';
import type { ImageDescriptionStore } from '../../search/imageDescriptionStore';
import { logWarn } from '../../log';
import { imageMimeType, localizedImageInfo, extractMetadataSections, type LocalizedImageInfo } from './imageMetadata';

/** Files per `image_describe_batch` job — the `SEARCH_REBUILD_BATCH_FILES` precedent applied to
 * the image backfill: ~4,751 unique referenced images / 100 gives ~48 job files, not 4,751. */
export const IMAGE_DESCRIBE_BATCH_IMAGES = 100;

/** Enqueues between macrotask yields, so a full backfill fan-out can't freeze the UI thread. */
export const IMAGE_DESCRIBE_ENQUEUE_YIELD_EVERY = 10;

// idh-WP-1 hardening (`plans/image-describe-hardening-ux.md` WP-1): observed live, a temp-0
// repetition loop generated to the 32k context ceiling — `extraction=597888ms`, a 76k/94k-char
// degenerate record. Every provider pass and the transcode step now get a bounded worst case.
/** Per provider pass (narrative or extraction). `requestUrl` is not abortable — see `withTimeout`. */
export const IMAGE_DESCRIBE_PASS_TIMEOUT_MS = 120_000;
/** `transcodeToPng`, an in-renderer `OffscreenCanvas` conversion — much cheaper than a model call. */
export const IMAGE_DESCRIBE_TRANSCODE_TIMEOUT_MS = 30_000;
/** `pruneDegenerate` threshold: a vision record's `extraction` longer than this is the on-disk
 * trace of a runaway generation, self-healed by the backfill on every run. */
export const IMAGE_DESCRIBE_DEGENERATE_MAX_EXTRACTION_CHARS = 20_000;
/** Truncation length for a stored `failure` message — enough to diagnose, not enough for a
 * pathological error (e.g. one embedding a chunk of the runaway output itself) to bloat the store. */
const FAILURE_MESSAGE_MAX_CHARS = 500;

export class ImageDescribeConfigError extends Error {}

/**
 * Races `promise` against a `ms` timer (the `raceWorkflowTimeout` precedent in
 * `orchestration/JobBackend.ts`, applied at the single-image granularity). Obsidian's
 * `requestUrl` (and the in-renderer `OffscreenCanvas` transcode) take no `AbortSignal`, so a
 * timeout cannot cancel the underlying work — it can only stop *waiting* on it. On timeout this
 * rejects with an `Error` labeled `label`; `Promise.race` has already attached a handler to the
 * original `promise` as part of racing it, so its late settlement (abandoned, but not orphaned)
 * never surfaces as an unhandled promise rejection.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function truncateFailureMessage(e: unknown): string {
	const message = e instanceof Error ? e.message : String(e);
	return message.length > FAILURE_MESSAGE_MAX_CHARS ? `${message.slice(0, FAILURE_MESSAGE_MAX_CHARS)}…` : message;
}

/**
 * Resolves and validates the configured image description model, exactly the checks the old
 * `ImageMetadataExtractWorkflow` ran inline — centralized here so `image_describe_note`,
 * `image_describe_backfill` and `image_describe_batch` all fail with the same message instead of
 * three near-identical hand-rolled checks drifting apart.
 */
export function resolveImageDescribeModel(plugin: CruciblePlugin): { provider: Provider; modelId: string } {
	if (!plugin.settings.imageMetadataExtractionEnabled) {
		throw new ImageDescribeConfigError('Image descriptions are disabled in settings (Crucible → Settings → Orchestrate → Image descriptions).');
	}
	const ref = plugin.settings.imageMetadataExtractionModel;
	if (!ref?.modelId) throw new ImageDescribeConfigError('No image description model configured.');
	const provider = plugin.settings.providers.find(p => p.id === ref.providerId);
	const model = provider?.models.find(m => m.id === ref.modelId);
	if (!provider || !model) throw new ImageDescribeConfigError('Configured image description model is missing.');
	if (!model.capabilities?.includes('image-extraction')) {
		throw new ImageDescribeConfigError('Configured model is not marked image-extraction capable.');
	}
	return { provider, modelId: model.id };
}

/** Pure gate mirroring `resolveImageDescribeModel` for the localize-on-write hook, which fires
 * far more often than a job resolves and must not require a `CruciblePlugin` instance to test. */
export function shouldEnqueueImageDescribe(settings: CrucibleSettings, imagePath: string): boolean {
	if (!settings.imageMetadataExtractionEnabled) return false;
	if (!localizedImageInfo(imagePath)) return false;
	const ref = settings.imageMetadataExtractionModel;
	if (!ref) return false;
	const provider = settings.providers.find(p => p.id === ref.providerId);
	if (!provider || providerModality(provider.kind) === 'cli') return false;
	const model = provider.models.find(m => m.id === ref.modelId);
	return model?.capabilities?.includes('image-extraction') === true;
}

export interface ImageDescribeTiming {
	md5: string;
	path: string;
	skipped: boolean;
	transcodeMs?: number;
	narrativeMs?: number;
	extractionMs?: number;
	totalMs: number;
}

export interface DescribeMd5ImagesOptions {
	signal?: AbortSignal;
	/** Fired once per image after its outcome settles (described, skipped, or missing-file). */
	onTiming?: (timing: ImageDescribeTiming) => void;
}

export interface DescribeMd5ImagesResult {
	/** Newly written this run (a model call, or an SVG extraction, actually happened). */
	describedCount: number;
	/** Already had a record (`store.has(md5)`) — the cross-note/cross-batch dedup path. */
	skippedCount: number;
	/** The vault file the image path pointed at no longer exists. */
	missingCount: number;
	/** A durable `kind: 'failed'` record was written this run (provider throw, timeout, or
	 * transcode failure) — the loop continued to the next image rather than aborting the batch. */
	failedCount: number;
}

/**
 * Describe every unique image in `images` (by md5), writing `plugin.imageDescriptions` records.
 * Per image: `image::<md5>` resource lock → skip if already described → SVG gets a text
 * extraction (no model call) → everything else gets WebP/AVIF transcoded in-renderer if needed,
 * then two provider calls (`narrative`, `extraction` — two requests by locked decision, never a
 * merged prompt). The signal is checked between images, not mid-pass: an in-flight model call
 * cannot be aborted (Obsidian's `requestUrl` takes no signal), so the checkpoint that actually
 * stops work lives where the next image would otherwise start.
 */
export async function describeMd5Images(
	plugin: CruciblePlugin,
	provider: Provider,
	modelId: string,
	images: LocalizedImageInfo[],
	opts: DescribeMd5ImagesOptions = {},
): Promise<DescribeMd5ImagesResult> {
	await plugin.imageDescriptions.ensureLoaded();
	let describedCount = 0;
	let skippedCount = 0;
	let missingCount = 0;
	let failedCount = 0;

	for (const image of images) {
		opts.signal?.throwIfAborted();
		// Sequential by design: one queue worker runs this loop, one model call in flight at a time.
		const outcome = await plugin.noteLocks.withResourceLock(
			'image',
			image.md5,
			'image-describe',
			() => describeOneImage(plugin, provider, modelId, image, opts),
		);
		if (outcome === 'described') describedCount++;
		else if (outcome === 'skipped') skippedCount++;
		else if (outcome === 'failed') failedCount++;
		else missingCount++;
	}

	return { describedCount, skippedCount, missingCount, failedCount };
}

type ImageOutcome = 'described' | 'skipped' | 'missing' | 'failed';

async function describeOneImage(
	plugin: CruciblePlugin,
	provider: Provider,
	modelId: string,
	image: LocalizedImageInfo,
	opts: DescribeMd5ImagesOptions,
): Promise<ImageOutcome> {
	if (plugin.imageDescriptions.has(image.md5)) {
		opts.onTiming?.({ md5: image.md5, path: image.path, skipped: true, totalMs: 0 });
		return 'skipped';
	}
	const file = plugin.app.vault.getAbstractFileByPath(image.path);
	if (!(file instanceof TFile)) {
		logWarn('image describe: referenced file is missing, skipping', image.path);
		return 'missing';
	}

	const started = Date.now();

	// idh-WP-1 per-image failure isolation: a poison image (provider throw, timeout, transcode
	// failure — SVG text extraction is cheap/local and not expected to fail, but is covered too
	// for the same reason) must not stall or fail the whole batch. Failed file jobs move to
	// `failed/` and are never retried (`FileJobBackend.ts` header comment), so an uncaught
	// exception here would silently drop every remaining image in the batch. Writing a durable
	// `kind: 'failed'` record and returning `'failed'` keeps `has()` true for this md5 — the point
	// is that a later run skips the poison image instead of retrying it forever (until
	// `pruneDegenerate` or a future manual fix clears it).
	try {
		if (image.ext === 'svg') {
			const svgText = await plugin.app.vault.read(file);
			const extracted = extractSvgText(svgText);
			// SVG text goes in `extraction`, narrative stays empty — the WP-2 chunker contract: the
			// extraction field lands under the `Image: <name> (text)` heading, which is what a
			// transcribed-text payload is, and an empty narrative simply emits no narrative chunk.
			await plugin.imageDescriptions.put({ md5: image.md5, narrative: '', extraction: extracted, kind: 'svg-text' });
			const totalMs = Date.now() - started;
			logWarn('image describe: svg text extracted', image.path, `${totalMs}ms`);
			opts.onTiming?.({ md5: image.md5, path: image.path, skipped: false, totalMs });
			return 'described';
		}

		const bytes = await plugin.app.vault.readBinary(file);
		let finalBytes = bytes;
		let finalMime = imageMimeType(image.ext);
		let transcodeMs: number | undefined;
		if (needsVisionTranscode(image.ext)) {
			const transcodeStarted = Date.now();
			const transcoded = await withTimeout(transcodeToPng(bytes, finalMime), IMAGE_DESCRIBE_TRANSCODE_TIMEOUT_MS, 'image transcode');
			finalBytes = transcoded.bytes;
			finalMime = transcoded.mime;
			transcodeMs = Date.now() - transcodeStarted;
		}

		const narrativeStarted = Date.now();
		const narrative = await withTimeout(
			plugin.providerManager.describeImage(provider, modelId, finalBytes, finalMime, 'narrative'),
			IMAGE_DESCRIBE_PASS_TIMEOUT_MS,
			'image description (narrative pass)',
		);
		const narrativeMs = Date.now() - narrativeStarted;

		const extractionStarted = Date.now();
		const extraction = await withTimeout(
			plugin.providerManager.describeImage(provider, modelId, finalBytes, finalMime, 'extraction'),
			IMAGE_DESCRIBE_PASS_TIMEOUT_MS,
			'image description (extraction pass)',
		);
		const extractionMs = Date.now() - extractionStarted;

		await plugin.imageDescriptions.put({
			md5: image.md5,
			narrative,
			extraction,
			kind: 'vision',
			providerId: provider.id,
			modelId,
		});

		const totalMs = Date.now() - started;
		logWarn(
			'image describe: vision pass complete', image.path,
			`transcode=${transcodeMs ?? 0}ms narrative=${narrativeMs}ms extraction=${extractionMs}ms total=${totalMs}ms`,
		);
		opts.onTiming?.({ md5: image.md5, path: image.path, skipped: false, transcodeMs, narrativeMs, extractionMs, totalMs });
		return 'described';
	} catch (e) {
		const failure = truncateFailureMessage(e);
		logWarn('image describe: failed, recording durable failure and continuing', image.path, failure);
		await plugin.imageDescriptions.put({ md5: image.md5, narrative: '', extraction: '', kind: 'failed', failure });
		const totalMs = Date.now() - started;
		opts.onTiming?.({ md5: image.md5, path: image.path, skipped: false, totalMs });
		return 'failed';
	}
}

/**
 * Resolve a note's embedded `_MD5` images to their `LocalizedImageInfo`, deduped by md5 (a note
 * can embed the same image twice, via wiki + markdown syntax or a genuine repeat). Reads
 * `metadataCache`'s `embeds` list directly rather than `AttachmentLocalizer.parseAttachmentRefs`
 * (an instance method on a module WP-3 does not own) — the same cache data, resolved through
 * `getFirstLinkpathDest` instead of Localize's own remote/local match classification, which this
 * caller does not need (it only wants images already on disk).
 */
export function resolveNoteImages(plugin: CruciblePlugin, file: TFile): LocalizedImageInfo[] {
	const embeds = plugin.app.metadataCache.getFileCache(file)?.embeds ?? [];
	const byMd5 = new Map<string, LocalizedImageInfo>();
	for (const embed of embeds) {
		if (!embed.link) continue;
		const dest = plugin.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
		if (!dest) continue;
		const info = localizedImageInfo(dest.path);
		if (!info) continue;
		if (!byMd5.has(info.md5)) byMd5.set(info.md5, info);
	}
	return [...byMd5.values()];
}

/**
 * Every vault path whose target (per `metadataCache.resolvedLinks`) is one of `imagePaths`.
 * Recomputed at batch runtime rather than captured at enqueue time — paths drift between when a
 * backfill enumerates its images and when the batch actually runs (a note can move, or gain/lose
 * an embed) — so this is the authoritative "which notes need reindexing" answer, not a cache of
 * the enqueue-time answer.
 */
export function referencingNotePaths(plugin: CruciblePlugin, imagePaths: string[]): string[] {
	const targets = new Set(imagePaths);
	const notes = new Set<string>();
	const resolved = plugin.app.metadataCache.resolvedLinks;
	for (const source in resolved) {
		const linksFromSource = resolved[source];
		for (const target in linksFromSource) {
			if (targets.has(target)) {
				notes.add(source);
				break;
			}
		}
	}
	return [...notes];
}

export interface ReferencedImage {
	path: string;
	md5: string;
	ext: string;
}

/**
 * Inverts `computeOrphanedAttachmentRows`'s walk (`src/ingestion/data/orphanedAttachments.ts`):
 * same `resolvedLinks` flatten + `MD5_NAME_RE` + `classifyLocalizeMediaType` filters, but keeps
 * the *referenced* images instead of the orphaned ones. `classifyLocalizeMediaType('svg')`
 * returns `'images'` (svg is a native Obsidian embed format), so SVGs are already included here
 * without a special case.
 */
export function computeReferencedImagePaths(plugin: CruciblePlugin): ReferencedImage[] {
	const referenced = new Set<string>();
	const resolved = plugin.app.metadataCache.resolvedLinks;
	for (const source in resolved) {
		for (const target in resolved[source]) referenced.add(target);
	}

	const rows: ReferencedImage[] = [];
	for (const file of plugin.app.vault.getFiles()) {
		if (!referenced.has(file.path)) continue;
		const info = localizedImageInfo(file.path);
		if (!info) continue;
		rows.push({ path: file.path, md5: info.md5, ext: info.ext });
	}
	return rows;
}

/** `<32-hex>_MD5.md` — the legacy `image_metadata_extract` sidecar naming convention. */
const LEGACY_SIDECAR_NAME_RE = /^([a-f0-9]{32})_MD5\.md$/i;

export interface LegacySidecarImportResult {
	imported: number;
}

/**
 * One-time import of any `image_metadata_extract`-era sidecar notes (`docs/multimodal-image-search.md`
 * Decision 5: repurpose + migrate). Likely a no-op — the feature shipped default-off — but must
 * be cheap when it is: one vault scan, no per-file network or model call. Each matching sidecar's
 * Description/Extracted-text sections become a `kind: 'imported'` record keyed by the md5 in its
 * filename, then the sidecar is trashed (vault trash — the Orphaned Attachments precedent), same
 * as `Lint: repair attachment links` never hard-deletes.
 */
export async function importLegacyImageMetadataSidecars(
	plugin: CruciblePlugin,
	store: ImageDescriptionStore,
): Promise<LegacySidecarImportResult> {
	let imported = 0;
	for (const file of plugin.app.vault.getMarkdownFiles()) {
		const match = LEGACY_SIDECAR_NAME_RE.exec(file.name);
		if (!match?.[1]) continue;
		const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
		if (frontmatter?.['image-metadata-schema'] === undefined) continue;

		const md5 = match[1].toLowerCase();
		const content = await plugin.app.vault.read(file);
		const sections = extractMetadataSections(content);
		const providerId = typeof frontmatter['image-metadata-provider'] === 'string' ? frontmatter['image-metadata-provider'] : undefined;
		const modelId = typeof frontmatter['image-metadata-model'] === 'string' ? frontmatter['image-metadata-model'] : undefined;
		await store.put({
			md5,
			narrative: sections.description,
			extraction: sections.extractedText,
			kind: 'imported',
			providerId,
			modelId,
		});
		await plugin.app.fileManager.trashFile(file);
		imported++;
	}
	return { imported };
}
