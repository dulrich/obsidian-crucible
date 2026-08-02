import type { JobLane, JobPriority, JobStatus, JobType } from '../types';

/**
 * Structural interfaces over node:sqlite's `DatabaseSync` / prepared-statement shape —
 * narrow enough that `SqliteJobStore` never imports `node:sqlite` itself. Production
 * code gets a real implementation from `openJobsDb` (`./sqlite.ts`); tests construct
 * one against `:memory:` (or a wrapping test double) without touching the lazy-require
 * capability probe at all. This is the same "storage as a small structural interface"
 * shape as `SearchQueryLog`/`ImageDescriptionStorage` (queue-db investigation,
 * §Storage decision, precedents).
 */
export interface SqliteRunResult {
	changes: number;
	lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
	run(...params: unknown[]): SqliteRunResult;
	get(...params: unknown[]): Record<string, unknown> | undefined;
	all(...params: unknown[]): Record<string, unknown>[];
}

export interface SqliteDatabase {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

/**
 * One row of the `jobs` table, camelCased at the store boundary (JSON columns are
 * parsed here too — see `parseJsonSafe` in `SqliteJobStore.ts`).
 *
 * Deliberately NOT `OrchestrationJob` (`src/orchestration/types.ts`) — checked per the
 * WP-5 brief's item 9 and they don't fit. The DB schema (queue-db investigation +
 * this brief) adds columns the file-backed job never needed — `dedupeKey`,
 * `claimedAt`/`claimToken` (the crash-lease), `settledAt`, `notes` (a structured
 * column, not a markdown "## Notes" body), `partial` — and it drops `inputPaths` and
 * `updated`. Both are grep-verified dead on `OrchestrationJob`: `inputPaths` is
 * written to frontmatter by `JobStore.enqueue`/`readJob` and never read back anywhere
 * else in `src/`, and no schema field in the WP-5 brief's item 1 DDL corresponds to
 * `updated` (per-field writers no longer stamp a generic "last touched" time — only
 * `settled_at`, the terminal timestamp, is load-bearing for retention). WP-6/7 decide
 * whether `inputPaths` needs to move into `params` for any consumer that actually
 * wants it; nothing in this store depends on it.
 */
export interface DbJobRow {
	id: string;
	type: JobType;
	status: JobStatus;
	lane: JobLane;
	priority: JobPriority;
	created: string;
	params: Record<string, unknown>;
	error?: string;
	failureKind?: 'service' | 'job';
	deferUntil?: number;
	progress?: string;
	outputPaths: string[];
	partial: boolean;
	notes: string;
	claimedAt?: number;
	claimToken?: string;
	settledAt?: number;
	dedupeKey?: string;
}

/**
 * `SqliteJobStore.list` / `Orchestrator.listJobs` ordering mode (WP-G3). `'claim'`
 * (the default) is `lane_rank, priority_rank, created, id` — dispatch truth, and the
 * ONLY order `claimNext`/`selectClaimCandidates`/`findActive` ever use; nothing here
 * changes those. `'recency'` is `settled_at DESC, id DESC` — settlement-newest-first,
 * for rendering a *settled* bucket (done/failed/cancelled) where claim order shows
 * the oldest retained rows first and buries recent settlements behind them. Callers
 * choose per status: `'recency'` on a settled status, `'claim'` (or omitted) on
 * queued/running — see `queueFetchPlan` in `src/ingestion/sections/queueMonitor.ts`.
 */
export type JobListOrder = 'claim' | 'recency';

/** Input to `SqliteJobStore.insert`. `id`/`created` are minted by the caller via the
 * existing `newJobId`/`nowIso` (`src/orchestration/utils/dates.ts`) — the store never
 * generates or parses an id, per the WP-5 brief's hard constraint. */
export interface NewJobInput {
	id: string;
	type: JobType;
	created: string;
	lane?: JobLane;
	priority?: JobPriority;
	params?: Record<string, unknown>;
	dedupeKey?: string | null;
	deferUntil?: number | null;
}

/** Optional field bundle for `SqliteJobStore.transition`, so a caller settling a job
 * (e.g. failing it) can stamp `status` + `error`/`failureKind`/`outputPaths`/... in one
 * UPDATE instead of a transition call followed by N setter calls. Every field is
 * independently optional: omitted means "don't touch this column" (as opposed to
 * `null`/`undefined` values for nullable columns, which explicitly clear them — see
 * the `'error' in patch` checks in `SqliteJobStore.transition`). */
export interface TransitionPatch {
	error?: string | null;
	failureKind?: 'service' | 'job' | null;
	outputPaths?: string[];
	partial?: boolean;
	notes?: string;
	progress?: string | null;
}
