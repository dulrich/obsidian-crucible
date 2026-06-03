import type CruciblePlugin from '../main';
import type { MemoryJobSeed } from './MemoryJobQueue';
import { coerceVideoId } from './utils/youtubeApi';

// Per-type behavior for the unified queue. File types are backed by the markdown
// JobStore (inbox/running/done/failed); memory types run in-memory under the same
// runner/gate (the folded enrichment queue). `maxParallel`/`minIntervalMs` may be
// implemented as getters so they track live settings.
export interface JobTypeConfig {
	persistence: 'file' | 'memory';
	/** Per-type worker count for the drain (default 1). */
	maxParallel: number;
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
}

export const DEFAULT_JOB_TYPE_CONFIG: JobTypeConfig = {
	persistence: 'file',
	maxParallel: 1,
	minIntervalMs: 0,
};

// File-backed, but collapses repeat requests for the same transcript onto one active
// job so rapid re-enqueues don't pile up duplicate runs on a note.
export function transcriptRefineJobConfig(): JobTypeConfig {
	return {
		persistence: 'file',
		maxParallel: 1,
		minIntervalMs: 0,
		dedupeKey: (p) => (typeof p.targetPath === 'string' ? p.targetPath : ''),
	};
}

// Memory-persistence config for the folded enrichment queue. maxParallel and the
// cooloff are read live from settings (getters) so dashboard/settings changes take
// effect without re-registering. Dedupes on videoId; display fields feed the UI.
export function youtubeMetadataJobConfig(plugin: CruciblePlugin): JobTypeConfig {
	return {
		persistence: 'memory',
		get maxParallel() { return Math.max(1, plugin.settings.orchestrationYoutubeMetadataMaxParallel || 1); },
		get minIntervalMs() { return Math.max(0, plugin.settings.ingestionYoutubeEnrichRateLimitSeconds) * 1000; },
		dedupeKey: (p) => coerceVideoId(p.videoId),
		display: (p) => ({
			title: typeof p.title === 'string' ? p.title : '',
			channelName: typeof p.channelName === 'string' ? p.channelName : '',
		}),
		terminalRetentionMs: 60_000,
	};
}
