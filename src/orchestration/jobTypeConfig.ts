import type CruciblePlugin from '../main';
import type { MemoryJobSeed } from './MemoryJobQueue';
import {
	SERVICE_IMAGE_DESCRIPTION_PROVIDER,
	SERVICE_SEARCH_COMPANION,
	SERVICE_SEARCH_EMBEDDER,
	SERVICE_YOUTUBE_API,
	SERVICE_YOUTUBE_RSS,
	type ServiceId,
} from './serviceHealth';
import { coerceVideoId } from './utils/youtubeApi';

// Per-type behavior for the unified queue. File types are backed by the markdown
// JobStore (inbox/running/done/failed); memory types run in-memory under the same
// runner/gate (the folded enrichment queue). `maxParallel`/`minIntervalMs` may be
// implemented as getters so they track live settings.
export interface JobTypeConfig {
	persistence: 'file' | 'memory';
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
	 * Collapses repeat enqueues that resolve to the same key (e.g. targetPath, videoId).
	 * The backend decides the policy: file types skip the enqueue and return the
	 * existing active job; memory types reject the duplicate. Empty string = no dedupe
	 * (file) or "not enqueueable" (memory, which requires a key).
	 */
	dedupeKey?: (params: Record<string, unknown>) => string;
	/** Memory types refill from this source when the queue drains empty. */
	autoSource?: () => MemoryJobSeed[];
	/** Display fields surfaced in the dashboard for a memory entry. */
	display?: (params: Record<string, unknown>) => Record<string, unknown>;
	/** Memory cleanup window for terminal (done/failed) entries; default 60_000. */
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

// The common shape for single-worker, file-backed job types: they differ only in how repeat
// enqueues collapse, so each config below is just its dedupeKey.
export function fileJobConfig(dedupeKey?: (params: Record<string, unknown>) => string): JobTypeConfig {
	return { persistence: 'file', maxParallel: 1, minIntervalMs: 0, dedupeKey };
}

export const DEFAULT_JOB_TYPE_CONFIG: JobTypeConfig = fileJobConfig();

// File-backed, but collapses repeat requests for the same transcript onto one active
// job so rapid re-enqueues don't pile up duplicate runs on a note.
export function transcriptRefineJobConfig(): JobTypeConfig {
	return fileJobConfig((p) => (typeof p.targetPath === 'string' ? p.targetPath : ''));
}

// One queue entry per NOTE, not per video: a per-note job (params.targetPath set)
// keys on the note path so duplicate captures sharing a yt-video-id each get their
// own job (each links its own note; only the first fetches — see ensureMetadataNote).
// Standalone enrichment (no vault note yet) keys on the video id. Exported so the
// EnrichmentQueueAdapter computes the exact same keys as the orchestrator path.
export function youtubeMetadataDedupeKey(p: Record<string, unknown>): string {
	if (typeof p.targetPath === 'string' && p.targetPath) return `note:${p.targetPath}`;
	const videoId = coerceVideoId(p.videoId);
	return videoId ? `video:${videoId}` : '';
}

// File-backed channel enrichment. Shares the YouTube metadata pacing settings
// (parallelism + rate limit) so channel fetches respect the same Data API budget,
// and collapses repeat enqueues for a channel onto one active job.
export function youtubeChannelEnrichJobConfig(plugin: CruciblePlugin): JobTypeConfig {
	return {
		persistence: 'file',
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
	return { ...fileJobConfig(), services: [SERVICE_YOUTUBE_API] };
}

// The RSS tracker talks to YouTube's feed endpoints, NOT the Data API — a quota
// exhaustion on one says nothing about the other, so they are separate service ids.
export function youtubeTrackerJobConfig(): JobTypeConfig {
	return { ...fileJobConfig(), services: [SERVICE_YOUTUBE_RSS] };
}

// File-backed so triggered command runs survive restarts. Dedupes on
// commandId+target so repeat trigger fires collapse onto one active job.
export function commandRunJobConfig(): JobTypeConfig {
	return fileJobConfig((p) => {
		const commandId = typeof p.commandId === 'string' ? p.commandId.trim() : '';
		if (!commandId) return '';
		const targetPath = typeof p.targetPath === 'string' ? p.targetPath : '';
		return `${commandId}|${targetPath}`;
	});
}

// File-backed so triggered chain runs survive restarts. Dedupes on chainName+target
// so repeat trigger fires (e.g. a metadata-changed burst) collapse onto one active job.
export function chainRunJobConfig(): JobTypeConfig {
	return fileJobConfig((p) => {
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

// idh-WP-2: `services` lets the drain's `servicesHealthyFor` gate stop claiming further
// image_describe_note/image_describe_batch jobs while the infra breaker in `imageDescribe.ts`
// has reported the provider unhealthy (`ImageDescribeNoteWorkflow`/`ImageDescribeBatchWorkflow`
// return `status: 'deferred'` + `serviceUnhealthy` on a connection-class error or 3 consecutive
// timeouts). `imageDescribeBackfillJobConfig` deliberately does NOT declare it — the backfill job
// only enqueues batches and prunes the store; it never calls the provider itself.
export function imageDescribeNoteJobConfig(): JobTypeConfig {
	return { ...fileJobConfig(imageDescribeNoteDedupeKey), services: [SERVICE_IMAGE_DESCRIPTION_PROVIDER] };
}

// One backfill fan-out at a time — see searchEmbedMissingJobConfig's identical reasoning: this
// job only enqueues image_describe_batch jobs, and two concurrent fan-outs would double the
// batch count for exactly the same work.
export function imageDescribeBackfillJobConfig(): JobTypeConfig {
	return {
		...fileJobConfig(() => 'image-describe-backfill'),
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
	return { ...fileJobConfig(imageDescribeBatchDedupeKey), services: [SERVICE_IMAGE_DESCRIPTION_PROVIDER] };
}

export function searchFileJobConfig(): JobTypeConfig {
	return {
		...fileJobConfig((p) => {
			const path = typeof p.path === 'string' ? p.path : '';
			return path ? `search-file:${path}` : '';
		}),
		services: SEARCH_SERVICES,
	};
}

export function searchRebuildJobConfig(): JobTypeConfig {
	return { ...fileJobConfig(() => 'search-rebuild'), services: SEARCH_SERVICES };
}

// One backfill fan-out at a time. Expressed as `maxParallelFixed` rather than only as a
// comment, so the Queue Configuration table can show the constraint (a `serial` pill with
// this reason as its tooltip) instead of silently ignoring a number the user typed.
export function searchEmbedMissingJobConfig(): JobTypeConfig {
	return {
		...fileJobConfig(() => 'search-embed-missing'),
		services: SEARCH_SERVICES,
		maxParallelFixed: 'One backfill fan-out at a time: this job only enqueues batches, and two concurrent fan-outs '
			+ 'would double the batch count for exactly the same work. The duplicate batches are idempotent and would '
			+ 'drain as no-ops, but they would still be written to the queue as job files.',
	};
}

export function searchBatchJobConfig(): JobTypeConfig {
	return {
		...fileJobConfig((p) => {
			const rebuildId = typeof p.rebuildId === 'string' ? p.rebuildId : '';
			const batchIndex = typeof p.batchIndex === 'number' ? p.batchIndex : -1;
			return rebuildId && batchIndex >= 0 ? `search-batch:${rebuildId}:${batchIndex}` : '';
		}),
		services: SEARCH_SERVICES,
	};
}

export function searchSweepJobConfig(): JobTypeConfig {
	return {
		...fileJobConfig((p) => {
			const description = typeof p.description === 'string' ? p.description.trim() : '';
			return description ? `search-sweep:${description}` : '';
		}),
		services: SEARCH_SERVICES,
	};
}

// Memory-persistence config for the folded enrichment queue. maxParallel and the
// cooloff are read live from settings (getters) so dashboard/settings changes take
// effect without re-registering. Display fields feed the UI.
export function youtubeMetadataJobConfig(plugin: CruciblePlugin): JobTypeConfig {
	return {
		persistence: 'memory',
		get maxParallel() { return Math.max(1, plugin.settings.orchestrationYoutubeMetadataMaxParallel || 1); },
		get minIntervalMs() { return Math.max(0, plugin.settings.ingestionYoutubeEnrichRateLimitSeconds) * 1000; },
		dedupeKey: youtubeMetadataDedupeKey,
		display: (p) => ({
			title: typeof p.title === 'string' ? p.title : '',
			channelName: typeof p.channelName === 'string' ? p.channelName : '',
			target: typeof p.targetPath === 'string' ? (p.targetPath.split('/').pop() ?? '').replace(/\.md$/, '') : '',
		}),
		terminalRetentionMs: 60_000,
		services: [SERVICE_YOUTUBE_API],
	};
}
