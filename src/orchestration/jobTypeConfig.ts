import type { MemoryJobSeed } from './MemoryJobQueue';

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
	/** Memory types dedupe on this key (e.g. videoId). Required for memory types. */
	idempotentKey?: (params: Record<string, unknown>) => string;
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
