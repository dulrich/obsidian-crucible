import { TFile, normalizePath } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { todayInTz } from '../utils/dates';
import { ensureFolder } from '../../utils';
import { extractUrls } from '../utils/urlExtract';
import { canonicalizeUrl } from '../utils/urlCanonicalize';
import { AggregateEntry, applyLinkToRegistry, isExcluded, wikilinkFor } from '../utils/linkRegistry';
import { xMetadataRoot } from '../utils/xApi';
import { blogMetadataRoot } from '../utils/blogsApi';
import { coerceVideoId, findLinkedYtMetadataFile, youtubeMetadataRoot } from '../utils/youtubeApi';
import { referencedVideoJobParams } from '../jobTypeConfig';

// Same enqueue-burst spacing as XPostDiscoverWorkflow / YoutubeChannelEnrichSweepWorkflow:
// each enqueue writes a row and kicks the drain, so a note citing dozens of referenced
// videos shouldn't stampede it.
const ENQUEUE_CHUNK = 10;
const ENQUEUE_CHUNK_PAUSE_MS = 200;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// WP-J1's every-Nth-or-last convention (`LinkScanWorkflow`'s `LINK_SCAN_PROGRESS_EVERY_FILES`),
// reused here rather than re-declared: the registry pass and the YouTube fan-out over one
// note's URLs can both run to dozens of items, and the same throttle shape keeps the
// queue monitor's Progress cell current without a per-item store write.
const LINK_ENRICH_PROGRESS_EVERY = 10;

export function shouldReportLinkEnrichProgress(index: number, total: number, every = LINK_ENRICH_PROGRESS_EVERY): boolean {
	if (total <= 0) return false;
	return index === total || index % every === 0;
}

export function formatLinkEnrichRegistryProgress(processed: number, total: number): string {
	return `registry ${processed} / ${total} links`;
}

export function formatLinkEnrichYoutubeProgress(processed: number, total: number): string {
	return `youtube ${processed} / ${total} referenced videos`;
}

// `source_command` values stamped onto notes created by the enrichment commands
// themselves (youtubeApi.ts, xApi.ts, blogsApi.ts) — the secondary tell for a
// metadata note that a user moved out from under its configured root, where the
// root-prefix check alone would miss it.
const METADATA_SOURCE_COMMANDS = new Set([
	'youtube-fetch-video-metadata',
	'youtube-fetch-channel-metadata',
	'x-fetch-post-metadata',
	'blogs-tracker',
]);

function isMetadataSourceCommand(value: unknown): boolean {
	return typeof value === 'string' && METADATA_SOURCE_COMMANDS.has(value);
}

// Note-level companion to `LinkScanWorkflow`/`XPostDiscoverWorkflow`: scans ONE note's
// body links, merges every URL into the shared link registry (byte-identical writer —
// see `linkRegistry.ts`), and fans out enrichment for referenced YouTube videos and X
// posts. Enqueue-only: it never writes the scanned note itself (source-enable ≠
// execution-enable — this job only ever mints other jobs, which still need their own
// per-type auto-run gate and, for the X half, no second implementation at all).
export class LinkNoteEnrichWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const app = plugin.app;
		const settings = plugin.settings;
		const params = job.params ?? {};
		const targetPath = typeof params.targetPath === 'string' ? params.targetPath : '';
		if (!targetPath) {
			return { status: 'failed', error: 'Missing params.targetPath' };
		}

		const file = app.vault.getAbstractFileByPath(targetPath);
		if (!(file instanceof TFile)) {
			return { status: 'failed', error: `Target note not found: ${targetPath}` };
		}

		const registryRoot = normalizePath(settings.orchestrationLinkRegistryRoot);
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;

		// Refusal guards: never scan a note that IS enrichment machinery. YT metadata
		// notes embed the full video description (a URL farm) and every YT capture
		// self-references its own video at least twice — scanning them would flood the
		// registry and mint garbage referenced-video jobs from a note's own description.
		const machineryRoots = [youtubeMetadataRoot(plugin), xMetadataRoot(plugin), blogMetadataRoot(plugin), registryRoot];
		const isMachineryNote =
			isExcluded(targetPath, machineryRoots)
			|| fm?.['type'] === 'link-record'
			|| isMetadataSourceCommand(fm?.['source_command']);
		if (isMachineryNote) {
			return {
				status: 'done',
				notes: `Refused: ${targetPath} is enrichment machinery (metadata or link-registry note); `
					+ `note-level link enrichment does not scan it.`,
			};
		}

		ctx.throwIfAborted();

		const content = await app.vault.cachedRead(file);
		const urls = extractUrls(content);
		const today = todayInTz(settings.orchestrationTimezone);
		await ensureFolder(app, registryRoot);

		const wikilink = wikilinkFor(targetPath);
		const noteOwnVideoId = coerceVideoId(fm?.['yt-video-id']) || coerceVideoId(fm?.['videoId']);

		// Same per-canonical-URL aggregation shape as LinkScanWorkflow's read pass, over
		// this one note's URLs instead of the whole vault.
		const aggregate = new Map<string, AggregateEntry>();
		let sawXStatus = false;
		const ytVideoIds: string[] = [];
		const seenYt = new Set<string>();
		for (const u of urls) {
			ctx.throwIfAborted();
			const canon = canonicalizeUrl(u.raw);
			if (!canon) continue;
			let entry = aggregate.get(canon.canonical);
			if (!entry) {
				entry = { canon, sourceWikilinks: new Set<string>() };
				aggregate.set(canon.canonical, entry);
			}
			entry.sourceWikilinks.add(wikilink);
			if (canon.xStatusId) sawXStatus = true;
			if (canon.youtubeVideoId && !seenYt.has(canon.youtubeVideoId)) {
				seenYt.add(canon.youtubeVideoId);
				ytVideoIds.push(canon.youtubeVideoId);
			}
		}

		// Registry merge: every extracted URL, unconditionally — the registry write is
		// NOT self-guarded (the vault-level scan records these URLs too, and registry
		// parity matters), unlike the YouTube fan-out below.
		let registryCreated = 0;
		let registryUpdated = 0;
		let candidatesFlagged = 0;
		const outputPaths: string[] = [];
		const totalEntries = aggregate.size;
		let entriesProcessed = 0;
		for (const entry of aggregate.values()) {
			ctx.throwIfAborted();
			const result = await applyLinkToRegistry(plugin, registryRoot, today, entry);
			if (result.created) registryCreated++;
			else registryUpdated++;
			if (result.candidateFlagged) candidatesFlagged++;
			outputPaths.push(result.path);
			entriesProcessed++;
			if (shouldReportLinkEnrichProgress(entriesProcessed, totalEntries)) {
				ctx.reportProgress(formatLinkEnrichRegistryProgress(entriesProcessed, totalEntries));
			}
		}

		// X half: full reuse, no second path. One `x_post_discover` enqueue when the
		// note cites at least one X status — that workflow does its own extraction,
		// materialization probe, and per-status fan-out.
		let xDiscoverEnqueued = false;
		if (sawXStatus) {
			ctx.throwIfAborted();
			await plugin.orchestrator.enqueue(
				'x_post_discover',
				{ targetPath },
				{ priority: 'normal', lane: 'background' },
			);
			xDiscoverEnqueued = true;
		}

		// YouTube fan-out: self-guarded (drop the note's own video) and stamped-membership
		// probed (skip a video this note already links via `yt-metadata`) before enqueuing
		// via WP-J2's `referencedVideoJobParams` — never hand-rolled, or the job silently
		// collapses onto the note's primary metadata job.
		let ytEnqueued = 0;
		let ytSkippedSelf = 0;
		let ytSkippedStamped = 0;
		let pendingInChunk = 0;
		const ytTotal = ytVideoIds.length;
		let ytProcessed = 0;
		for (const videoId of ytVideoIds) {
			ctx.throwIfAborted();
			ytProcessed++;
			if (noteOwnVideoId && videoId === noteOwnVideoId) {
				ytSkippedSelf++;
			} else if (findLinkedYtMetadataFile(app, file, fm?.['yt-metadata'], videoId)) {
				ytSkippedStamped++;
			} else {
				await plugin.orchestrator.enqueue(
					'youtube_metadata_fetch',
					referencedVideoJobParams(targetPath, videoId),
					{ priority: 'normal', lane: 'background' },
				);
				ytEnqueued++;
				if (++pendingInChunk >= ENQUEUE_CHUNK) {
					pendingInChunk = 0;
					await sleep(ENQUEUE_CHUNK_PAUSE_MS);
				}
			}
			if (shouldReportLinkEnrichProgress(ytProcessed, ytTotal)) {
				ctx.reportProgress(formatLinkEnrichYoutubeProgress(ytProcessed, ytTotal));
			}
		}

		const notes =
			`Scanned ${targetPath}: ${aggregate.size} distinct link(s) `
			+ `(${registryCreated} new, ${registryUpdated} updated in registry, ${candidatesFlagged} tracked-source candidates); `
			+ `X discover ${xDiscoverEnqueued ? 'enqueued' : 'not needed (no X links)'}; `
			+ `YouTube: ${ytEnqueued} enqueued, ${ytSkippedSelf} skipped (note's own video), ${ytSkippedStamped} skipped (already stamped).`;

		return {
			status: 'done',
			outputPaths,
			notes,
		};
	}
}
