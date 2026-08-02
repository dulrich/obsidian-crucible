import type CruciblePlugin from '../main';
import type { JobType } from './types';
import {
	SERVICE_IMAGE_DESCRIPTION_PROVIDER,
	SERVICE_SEARCH_COMPANION,
	SERVICE_SEARCH_EMBEDDER,
	SERVICE_X_OEMBED,
	SERVICE_YOUTUBE_API,
	type ServiceId,
} from './serviceHealth';
import { coerceVideoId } from './utils/youtubeApi';
import {
	IMAGE_DESCRIBE_BATCH_IMAGES,
	IMAGE_DESCRIBE_PASS_TIMEOUT_MS,
	IMAGE_DESCRIBE_TRANSCODE_TIMEOUT_MS,
} from './utils/imageDescribe';

// Per-type behavior for the unified queue. Every type is backed by the SQLite
// `SqliteJobStore`/`DbJobBackend` (durable, no vault files) since thq WP-8 retired the
// markdown `JobStore` and the in-memory queue. `maxParallel`/`minIntervalMs` may be
// implemented as getters so they track live settings.
export interface JobTypeConfig {
	/**
	 * Which `JobBackend` `Orchestrator.register` builds for this type.
	 *
	 * Exactly one legal value today — thq WP-8 flipped every type to `'db'` and deleted
	 * the `'file'` (markdown `JobStore`) and `'memory'` (`MemoryJobQueue`) arms. The
	 * field is deliberately kept rather than dropped: it is what states that a job type
	 * *has* a persistence strategy, so adding a second backend later is a new union
	 * member plus a `createBackend` case, not a re-derivation of where the choice lives.
	 */
	persistence: 'db';
	/**
	 * Drain READINESS: a type declaring this starts draining as soon as the plugin is
	 * up, where every other type additionally waits out the initial drain delay
	 * (`INITIAL_FILE_DRAIN_DELAY_MS`, 5s past layout-ready). It is also the flag
	 * `Orchestrator.runNext` reads to skip a type when answering a manual "Run next" —
	 * a type that drains on its own shouldn't consume the user's one explicit run.
	 *
	 * **The name is historical and overstates it.** It does NOT bypass the per-type
	 * auto-run toggle: `computeShouldDrain` (autorunGate.ts) requires `typeAutorun ===
	 * true` for every type, and only then consults this flag. It read as a gate bypass
	 * when it was a hard-coded property of `MemoryJobBackend`, and the name outlived
	 * that. Renaming it is a fleet-wide change to a settings-adjacent concept and is
	 * deliberately not folded into the cutover.
	 *
	 * It became per-type config in thq WP-8 because it used to be `false` on
	 * `FileJobBackend` and `true` on `MemoryJobBackend` — collapsing both onto one
	 * durable backend would otherwise have silently added a 5s startup delay to
	 * enrichment. Absent = false.
	 */
	drainsWithoutAutorun?: boolean;
	/** Per-type worker count for the drain (default 1). A per-type user override wins unless `maxParallelFixed` is set. */
	maxParallel: number;
	/**
	 * Marks the type as pinned to `maxParallel`, with the reason. Set it and the
	 * per-type concurrency override no longer applies, and the Queue Configuration
	 * table renders a `serial` pill carrying this string as its tooltip instead of a
	 * number input.
	 *
	 * The point is that the constraint becomes a *property the UI can read* rather
	 * than a comment above a config factory. A greyed-out input with no stated cause
	 * reads as a bug, and a live-but-ignored one is worse; a pill that explains itself
	 * states the constraint as what it actually is — a fact about the job type.
	 */
	maxParallelFixed?: string;
	/** Per-type cooloff between job starts, via a shared MinIntervalGate. 0 = none. */
	minIntervalMs: number;
	/**
	 * Collapses repeat enqueues that resolve to the same key (e.g. targetPath, videoId):
	 * a repeat enqueue skips the insert and returns the existing active job (promoting
	 * its lane/priority when the new request is more urgent). Empty string = no dedupe.
	 */
	dedupeKey?: (params: Record<string, unknown>) => string;
	/**
	 * How long a *settled* job suppresses its own auto-source re-seed; default 60_000.
	 *
	 * Only meaningful for a type that has an auto-source registered
	 * (`Orchestrator.setAutoSource`). It is the durable replacement for
	 * `MemoryJobQueue`'s terminal-retention window and exists for the same reason:
	 * `refill` skipped any key already tracked in *any* state, so a cancelled entry kept
	 * suppressing its own seed — without that, an enabled auto-source re-adds the item
	 * on the very next refill and the user's Cancel looks ignored. The suppression is
	 * not permanent; past this window the source may legitimately offer the item again.
	 */
	terminalRetentionMs?: number;
	/** Per-type execution timeout override (ms). Falls back to the global setting; 0 disables. */
	timeoutMs?: number;
	/**
	 * External dependencies this type cannot run without. The drain refuses to claim a
	 * job of this type while any of them has an open breaker
	 * (`Orchestrator.servicesHealthyFor`), and a successful run reports every one of
	 * them healthy.
	 *
	 * All-or-nothing on purpose: a type listing two services must not run on one, so a
	 * half-open recovery has to win every probe token it needs before a job is claimed.
	 * A type with no entry is always drainable — declaring nothing means "this type has
	 * no external dependency", which is the correct default for vault-local work.
	 */
	services?: ServiceId[];
}

// Every search job type reaches the companion, and (with semantic search on) the
// embedding server behind it. They are listed together because the drain treats them
// all-or-nothing anyway: a companion that is down makes an embedder-only job pointless
// and vice versa, and a type that could run on one of the two would still write a
// half-indexed row.
const SEARCH_SERVICES: ServiceId[] = [SERVICE_SEARCH_COMPANION, SERVICE_SEARCH_EMBEDDER];

// The common shape for single-worker, durable job types: they differ only in how repeat
// enqueues collapse, so each config below is just its dedupeKey.
export function durableJobConfig(dedupeKey?: (params: Record<string, unknown>) => string): JobTypeConfig {
	return { persistence: 'db', maxParallel: 1, minIntervalMs: 0, dedupeKey };
}

export const DEFAULT_JOB_TYPE_CONFIG: JobTypeConfig = durableJobConfig();

// Collapses repeat requests for the same transcript onto one active job so rapid
// re-enqueues don't pile up duplicate runs on a note.
export function transcriptRefineJobConfig(): JobTypeConfig {
	return durableJobConfig((p) => (typeof p.targetPath === 'string' ? p.targetPath : ''));
}

/**
 * Marks the referenced-video mode of `youtube_metadata_fetch` (WP-J2): a video found in
 * a note's BODY rather than the video the note itself captures. Set it via
 * `referencedVideoJobParams` — never hand-roll the param, or the job silently collapses
 * onto the note's primary metadata job.
 *
 * It exists because the mode cannot be inferred from `{targetPath, videoId}` being both
 * present: every pre-existing per-note enqueue site already passes both (the
 * `yt-metadata-on-capture` trigger, the dashboard's per-row Enqueue and Enqueue-all), so
 * keying on that pair would have re-shaped every legacy key and broken the one-job-per-
 * note contract. An explicit flag leaves every existing key byte-identical.
 */
export const YOUTUBE_REFERENCED_VIDEO_PARAM = 'referencedVideo';

/**
 * The params a referenced-video `youtube_metadata_fetch` job must carry. `title` drives
 * the queue monitor's row label (`youtubeMetadataTitle`); omit it to fall back to the
 * video id.
 */
export function referencedVideoJobParams(
	targetPath: string,
	videoId: string,
	title?: string,
): Record<string, unknown> {
	return {
		targetPath,
		videoId,
		[YOUTUBE_REFERENCED_VIDEO_PARAM]: true,
		...(title ? { title } : {}),
	};
}

// One queue entry per NOTE, not per video: a per-note job (params.targetPath set)
// keys on the note path so duplicate captures sharing a yt-video-id each get their
// own job (each links its own note; only the first fetches — see ensureMetadataNote).
// Standalone enrichment (no vault note yet) keys on the video id. Exported so every
// enqueue path (dashboard buttons, the auto-source refill, the capture trigger)
// computes the exact same key the backend dedupes on.
//
// The referenced-video mode is the one exception, and it needs its own key shape: one
// note can cite N videos in its body, and `note:<path>` would collapse them all onto a
// single job (and onto the note's own primary metadata job besides). Only a job that
// explicitly flags itself referenced gets the composite key — every other param shape,
// including the legacy `{targetPath, videoId}` pair, keys exactly as it always has.
export function youtubeMetadataDedupeKey(p: Record<string, unknown>): string {
	const targetPath = typeof p.targetPath === 'string' ? p.targetPath : '';
	const videoId = coerceVideoId(p.videoId);
	if (targetPath && videoId && p[YOUTUBE_REFERENCED_VIDEO_PARAM] === true) {
		return `note:${targetPath}:video:${videoId}`;
	}
	if (targetPath) return `note:${targetPath}`;
	return videoId ? `video:${videoId}` : '';
}

// Channel enrichment. Shares the YouTube metadata pacing settings
// (parallelism + rate limit) so channel fetches respect the same Data API budget,
// and collapses repeat enqueues for a channel onto one active job.
export function youtubeChannelEnrichJobConfig(plugin: CruciblePlugin): JobTypeConfig {
	return {
		persistence: 'db',
		get maxParallel() { return Math.max(1, plugin.settings.orchestrationYoutubeMetadataMaxParallel || 1); },
		get minIntervalMs() { return Math.max(0, plugin.settings.ingestionYoutubeEnrichRateLimitSeconds) * 1000; },
		dedupeKey: (p) => (typeof p.channelId === 'string' && p.channelId ? `channel:${p.channelId}` : ''),
		services: [SERVICE_YOUTUBE_API],
	};
}

// The fan-out that enqueues per-channel enrichment jobs. It reads the Data API itself
// (to list what needs enriching), so it carries the same dependency as the jobs it
// seeds — a sweep that runs against a quota-exhausted API just re-enqueues work that
// cannot run.
export function youtubeChannelEnrichSweepJobConfig(): JobTypeConfig {
	return { ...durableJobConfig(), services: [SERVICE_YOUTUBE_API] };
}

// The tracker fetches each channel's uploads playlist via the Data API's
// playlistItems.list (RSS is dead — see the orchestration AGENTS.md tracker entry),
// the same upstream as metadata enrichment, so it deliberately shares the
// 'youtube-api' service breaker: one upstream, one breaker.
export function youtubeTrackerJobConfig(): JobTypeConfig {
	return { ...durableJobConfig(), services: [SERVICE_YOUTUBE_API] };
}

// Durable so triggered command runs survive restarts. Dedupes on
// commandId+target so repeat trigger fires collapse onto one active job.
export function commandRunJobConfig(): JobTypeConfig {
	return durableJobConfig((p) => {
		const commandId = typeof p.commandId === 'string' ? p.commandId.trim() : '';
		if (!commandId) return '';
		const targetPath = typeof p.targetPath === 'string' ? p.targetPath : '';
		return `${commandId}|${targetPath}`;
	});
}

// Durable so triggered chain runs survive restarts. Dedupes on chainName+target
// so repeat trigger fires (e.g. a metadata-changed burst) collapse onto one active job.
export function chainRunJobConfig(): JobTypeConfig {
	return durableJobConfig((p) => {
		const chainName = typeof p.chainName === 'string' ? p.chainName.trim() : '';
		if (!chainName) return '';
		const targetPath = typeof p.targetPath === 'string' ? p.targetPath : '';
		return `${chainName}|${targetPath}`;
	});
}

// One job per NOTE, matching youtubeMetadataDedupeKey's per-note keying: several notes
// embedding the same image each get their own job (each reindexes its own note; the
// image::<md5> resource lock inside the shared describe core is what collapses the actual
// model call onto the first one to reach a given image, not this key).
export function imageDescribeNoteDedupeKey(p: Record<string, unknown>): string {
	const targetPath = typeof p.targetPath === 'string' ? p.targetPath : '';
	return targetPath ? `note:${targetPath}` : '';
}

// thq WP-4 (B-4): the generic job-level backstop (`orchestrationAutorunTimeoutSeconds`, live
// default 600s) was killing legitimately long-running image jobs — a resumed 100-image
// `image_describe_batch` needs ~16 min of serial local model time, well past the 600s default,
// and died with the popup "Orchestrate: <id> -> failed (Timed out after 600s)" while it was still
// making progress (`runs/dispatch/thq-feedback-items-investigation.md` §3). Size each image job
// type's own `timeoutMs` from its real worst-case budget instead of the one-size-fits-all
// setting, so the backstop only ever fires for a genuine hang, never for slow-but-legitimate
// serial completion.
//
// Per-image worst case: both provider passes (narrative + extraction) time out at
// IMAGE_DESCRIBE_PASS_TIMEOUT_MS each, plus one IMAGE_DESCRIBE_TRANSCODE_TIMEOUT_MS if the image
// needed transcoding = 2*120_000 + 30_000 = 270_000ms.
const IMAGE_DESCRIBE_PER_IMAGE_WORST_CASE_MS = 2 * IMAGE_DESCRIBE_PASS_TIMEOUT_MS + IMAGE_DESCRIBE_TRANSCODE_TIMEOUT_MS;
// A few minutes of slack around the boundary for claim/dispatch overhead, not part of the
// per-image budget itself.
const IMAGE_DESCRIBE_TIMEOUT_SLACK_MS = 5 * 60_000;

// image_describe_batch: IMAGE_DESCRIBE_BATCH_IMAGES (100) images per job x the 270_000ms
// per-image worst case + slack = 100 * 270_000 + 300_000 = 27_300_000ms (~7.6h). That reads huge
// for a "backstop," and it is meant to: it's a true every-image-times-out-on-every-pass ceiling,
// not the expected runtime (a healthy batch finishes in minutes). In practice the batch's
// consecutive-timeout breaker (`IMAGE_DESCRIBE_CONSECUTIVE_TIMEOUT_LIMIT`, `imageDescribe.ts`)
// aborts the job on 3 timeouts in a row long before this could ever be reached — this backstop
// exists only to catch a genuine hang outside that machinery (e.g. an await with no per-call
// timeout at all), which is exactly the class of failure a job-level timer is for.
const IMAGE_DESCRIBE_BATCH_TIMEOUT_MS =
	IMAGE_DESCRIBE_BATCH_IMAGES * IMAGE_DESCRIBE_PER_IMAGE_WORST_CASE_MS + IMAGE_DESCRIBE_TIMEOUT_SLACK_MS;

// image_describe_note: unlike the batch job (capped at IMAGE_DESCRIBE_BATCH_IMAGES per job by
// construction), a note's embedded-image count is unbounded in principle. Rather than guess a
// second images-per-job figure, take a generous multiple of the batch ceiling: 5x covers a note
// with up to ~500 embedded images at the same worst-case-per-image math, comfortably above any
// note this plugin has seen in practice, while still being a finite backstop instead of disabling
// the timeout (0) outright.
const IMAGE_DESCRIBE_NOTE_TIMEOUT_MS = IMAGE_DESCRIBE_BATCH_TIMEOUT_MS * 5;

// idh-WP-2: `services` lets the drain's `servicesHealthyFor` gate stop claiming further
// image_describe_note/image_describe_batch jobs while the infra breaker in `imageDescribe.ts`
// has reported the provider unhealthy (`ImageDescribeNoteWorkflow`/`ImageDescribeBatchWorkflow`
// return `status: 'deferred'` + `serviceUnhealthy` on a connection-class error or 3 consecutive
// timeouts). `imageDescribeBackfillJobConfig` deliberately does NOT declare it — the backfill job
// only enqueues batches and prunes the store; it never calls the provider itself.
export function imageDescribeNoteJobConfig(): JobTypeConfig {
	return {
		...durableJobConfig(imageDescribeNoteDedupeKey),
		services: [SERVICE_IMAGE_DESCRIPTION_PROVIDER],
		timeoutMs: IMAGE_DESCRIBE_NOTE_TIMEOUT_MS,
	};
}

// One backfill fan-out at a time — see searchEmbedMissingJobConfig's identical reasoning: this
// job only enqueues image_describe_batch jobs, and two concurrent fan-outs would double the
// batch count for exactly the same work.
export function imageDescribeBackfillJobConfig(): JobTypeConfig {
	return {
		...durableJobConfig(() => 'image-describe-backfill'),
		maxParallelFixed: 'One backfill fan-out at a time: this job only enqueues batches, and two concurrent fan-outs '
			+ 'would double the batch count for exactly the same work. The duplicate batches are idempotent and would '
			+ 'drain as no-ops, but they would still be written to the queue as job files.',
	};
}

export function imageDescribeBatchDedupeKey(p: Record<string, unknown>): string {
	const backfillId = typeof p.backfillId === 'string' ? p.backfillId : '';
	const batchIndex = typeof p.batchIndex === 'number' ? p.batchIndex : -1;
	return backfillId && batchIndex >= 0 ? `image-describe:${backfillId}:${batchIndex}` : '';
}

export function imageDescribeBatchJobConfig(): JobTypeConfig {
	return {
		...durableJobConfig(imageDescribeBatchDedupeKey),
		services: [SERVICE_IMAGE_DESCRIPTION_PROVIDER],
		timeoutMs: IMAGE_DESCRIBE_BATCH_TIMEOUT_MS,
	};
}

export function searchFileJobConfig(): JobTypeConfig {
	return {
		...durableJobConfig((p) => {
			const path = typeof p.path === 'string' ? p.path : '';
			return path ? `search-file:${path}` : '';
		}),
		services: SEARCH_SERVICES,
	};
}

export function searchRebuildJobConfig(): JobTypeConfig {
	return { ...durableJobConfig(() => 'search-rebuild'), services: SEARCH_SERVICES };
}

// One backfill fan-out at a time. Expressed as `maxParallelFixed` rather than only as a
// comment, so the Queue Configuration table can show the constraint (a `serial` pill with
// this reason as its tooltip) instead of silently ignoring a number the user typed.
export function searchEmbedMissingJobConfig(): JobTypeConfig {
	return {
		...durableJobConfig(() => 'search-embed-missing'),
		services: SEARCH_SERVICES,
		maxParallelFixed: 'One backfill fan-out at a time: this job only enqueues batches, and two concurrent fan-outs '
			+ 'would double the batch count for exactly the same work. The duplicate batches are idempotent and would '
			+ 'drain as no-ops, but they would still be written to the queue as job files.',
	};
}

export function searchBatchJobConfig(): JobTypeConfig {
	return {
		...durableJobConfig((p) => {
			const rebuildId = typeof p.rebuildId === 'string' ? p.rebuildId : '';
			const batchIndex = typeof p.batchIndex === 'number' ? p.batchIndex : -1;
			return rebuildId && batchIndex >= 0 ? `search-batch:${rebuildId}:${batchIndex}` : '';
		}),
		services: SEARCH_SERVICES,
	};
}

export function searchSweepJobConfig(): JobTypeConfig {
	return {
		...durableJobConfig((p) => {
			const description = typeof p.description === 'string' ? p.description.trim() : '';
			return description ? `search-sweep:${description}` : '';
		}),
		services: SEARCH_SERVICES,
	};
}

// The enrichment queue. Durable since thq WP-8 (it was the last `memory` type), but
// its two distinguishing behaviors survive the flip as explicit config rather than as
// properties of a deleted backend: `drainsWithoutAutorun` keeps enrichment clicks
// running with the auto-run toggle off, and `terminalRetentionMs` keeps a settled entry
// from being re-offered by the Uncaptured Videos auto-source for a minute. maxParallel
// and the cooloff are read live from settings (getters) so dashboard/settings changes
// take effect without re-registering.
/**
 * The one job type the ingestion dashboard's enrichment surfaces talk about by name —
 * the auto-source registration, the "queued / enriching…" badges, and the Enrich
 * buttons. It used to live on the deleted `EnrichmentQueueAdapter`; it lives beside its
 * config now so the several dashboard modules that need it share one literal instead of
 * each spelling the type out.
 */
export const ENRICHMENT_JOB_TYPE: JobType = 'youtube_metadata_fetch';

export function youtubeMetadataJobConfig(plugin: CruciblePlugin): JobTypeConfig {
	return {
		persistence: 'db',
		drainsWithoutAutorun: true,
		get maxParallel() { return Math.max(1, plugin.settings.orchestrationYoutubeMetadataMaxParallel || 1); },
		get minIntervalMs() { return Math.max(0, plugin.settings.ingestionYoutubeEnrichRateLimitSeconds) * 1000; },
		dedupeKey: youtubeMetadataDedupeKey,
		terminalRetentionMs: 60_000,
		services: [SERVICE_YOUTUBE_API],
	};
}

// One queue entry per status id — mirrors youtubeMetadataDedupeKey's coercion
// discipline (trim, empty string when absent) so several notes/discover runs
// citing the same status collapse onto one active fetch. Exported so every
// enqueue path (discover, a future backfill/dashboard button) computes the
// exact same key the backend dedupes on.
export function xMetadataFetchDedupeKey(p: Record<string, unknown>): string {
	const statusId = typeof p.statusId === 'string' ? p.statusId.trim() : '';
	return statusId ? `status:${statusId}` : '';
}

export function xMetadataFetchJobConfig(): JobTypeConfig {
	return {
		persistence: 'db',
		maxParallel: 1,
		// Politeness on an unauthenticated, keyless endpoint (publish.x.com/oembed) —
		// deliberately a literal, not a setting: there is no quota relationship with
		// this endpoint to tune against, only a "don't hammer it" courtesy.
		minIntervalMs: 1000,
		dedupeKey: xMetadataFetchDedupeKey,
		terminalRetentionMs: 60_000,
		services: [SERVICE_X_OEMBED],
	};
}

// The fan-out that scans one note's links and enqueues x_metadata_fetch per
// undiscovered status. No `services` entry: discovery only reads the note and
// the local vault probe, never the oEmbed endpoint itself.
export function xPostDiscoverJobConfig(): JobTypeConfig {
	return durableJobConfig((p) => (typeof p.targetPath === 'string' && p.targetPath ? `note:${p.targetPath}` : ''));
}

// Registry-backfill fan-out: walks the link registry and enqueues x_metadata_fetch
// per not-yet-materialized status. Fixed dedupe key (there's only ever one backfill
// sweep in flight) and no `services` — like image-describe-backfill, it only reads
// the vault and enqueues; it never talks to the oEmbed endpoint itself, so it must
// always be runnable even while that service is unhealthy.
export function xMetadataBackfillJobConfig(): JobTypeConfig {
	return {
		...durableJobConfig(() => 'x-metadata-backfill'),
		maxParallelFixed: 'One backfill fan-out at a time: this job only enqueues x_metadata_fetch jobs, and two '
			+ 'concurrent fan-outs would double the enqueue count for exactly the same work.',
	};
}
