import type { ServiceFailureKind, ServiceId } from './serviceHealth';

// `cancelled` is a terminal bucket of its own, deliberately not a flavour of
// `failed`: a cancelled job must not read as a diagnostic failure, and must not be
// eligible for any retry policy applied to failures. Its queue folder is
// `cancelled/` — the folder is the source of truth for a file job's bucket, so a
// distinct state needs a distinct folder.
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type JobType =
	| 'daily_brief_lite'
	| 'youtube_tracker'
	| 'youtube_tracker_consolidate'
	| 'blogs_tracker'
	| 'blogs_tracker_consolidate'
	| 'transcript_refine'
	| 'link_scan'
	| 'note_link_enrich'
	| 'youtube_metadata_fetch'
	| 'youtube_channel_enrich'
	| 'youtube_channel_enrich_sweep'
	| 'x_metadata_fetch'
	| 'x_post_discover'
	| 'x_metadata_backfill'
	| 'command_run'
	| 'chain_run'
	| 'image_describe_note'
	| 'image_describe_backfill'
	| 'image_describe_batch'
	| 'search_rebuild'
	| 'search_embed_missing'
	| 'search_upsert_file'
	| 'search_upsert_batch'
	| 'search_delete_path'
	| 'search_sweep';

export type JobPriority = 'low' | 'normal' | 'high';
export type JobLane = 'user' | 'background';

export interface OrchestrationEnqueueOptions {
	priority?: JobPriority;
	lane?: JobLane;
	inputPaths?: string[];
}

export interface OrchestrationJob {
	id: string;
	type: JobType;
	status: JobStatus;
	priority: JobPriority;
	lane: JobLane;
	created: string;
	updated?: string;
	inputPaths: string[];
	outputPaths: string[];
	params?: Record<string, unknown>;
	error?: string;
	/**
	 * How `error` was classified when the job settled into `failed/`, stamped by
	 * `FileJobBackend.failEntry` via `classifyFailedJob` (`./failedJobRepair.ts`).
	 * `'service'` means the failure text matched the conservative service-outage
	 * pattern table (a dependency was down, not a bug in the job); `'job'` means it
	 * didn't. Forward-looking: lets a future sweep read frontmatter instead of
	 * re-pattern-matching `error`. Absent on jobs written before this field existed.
	 */
	failureKind?: 'service' | 'job';
	progress?: string;
	deferUntil?: string;
	/**
	 * Free-text run narration (WP-7's job-detail affordance — the queue monitor's
	 * replacement for the note file's `## Notes` section a db-backed job no longer
	 * has). Populated for db rows (`DbJobRow.notes`, always present, folded in here
	 * only when non-empty) at zero extra cost — it's already part of the row. Left
	 * undefined for file rows: the markdown body isn't read as part of a normal
	 * `list()`/`listFolder()` pass (that would cost a body read per row, on every
	 * queue-monitor render, for a field the file backend never needed structured
	 * before), so a file job's notes stay in its `## Notes` section on disk, same as
	 * always.
	 */
	notes?: string;
}

// Distinct, machine-checkable failure reasons a workflow can surface so callers can
// branch on the cause without string-matching `error`. `no-api-key` specifically
// means "credential is missing" (as opposed to a transient/rejected API response),
// so the enrichment queue can stop auto-refilling on it and only it.
export type WorkflowFailureReason = 'no-api-key';

/**
 * What every workflow outcome may carry, whatever its status. Deliberately tiny:
 * a field belongs here only when it is meaningful for *all four* terminal states.
 */
interface WorkflowResultBase {
	/** Vault paths this run wrote. Recorded on the job row by the backend. */
	outputPaths?: string[];
	/** Free-text run narration, appended to the job's notes. A `Partial:` prefix
	 * additionally flags the job row as partial. */
	notes?: string;
}

/** The work completed. */
export interface WorkflowDoneResult extends WorkflowResultBase {
	status: 'done';
}

/**
 * The run failed on its own merits — a job-level problem no retry of the *service*
 * will fix. `error` is **required**: a failure with nothing to say is not a state the
 * queue can render, diagnose or classify, and the backend used to paper over the gap
 * with a placeholder string of its own.
 *
 * A dependency being down is NOT this — it is `deferred` (see `WorkflowDeferredResult`).
 */
export interface WorkflowFailedResult extends WorkflowResultBase {
	status: 'failed';
	error: string;
	/** Typed cause, when the workflow can name one. Read by `DbJobBackend.failEntry`
	 * to latch a type's auto-source off — never inferred from `error`'s text. */
	failureReason?: WorkflowFailureReason;
}

/**
 * A *dependency* is unavailable, so the job goes back to `queued` and runs again
 * later. The retry/service fields live here and nowhere else, which is what makes the
 * contract structural rather than a comment: a service-level problem coming back as
 * `'failed'` is exactly the mis-classification that turned one companion outage into
 * 2,022 failure files.
 */
export interface WorkflowDeferredResult extends WorkflowResultBase {
	status: 'deferred';
	/** Why the deferral happened, when the caller has a message distinct from `notes`. */
	error?: string;
	/** How long to wait before the job becomes claimable again. */
	retryAfterMs?: number;
	/**
	 * Names the *dependency* whose outage caused this deferral, so the backend can
	 * report it to `ServiceHealthRegistry` and the drain can stop claiming jobs of
	 * every type that needs the same service.
	 *
	 * Workflows themselves never touch the registry: they describe what they saw and
	 * the backend does the reporting, which keeps workflow tests registry-free.
	 */
	serviceUnhealthy?: {
		service: ServiceId;
		kind: ServiceFailureKind;
		reason: string;
	};
}

/**
 * The run observed a cancellation request and stopped — a terminal state distinct
 * from `failed` on purpose (see `JobStatus`). Workflows rarely return it directly; it
 * is normally produced by `runWorkflowWithTimeout` from a thrown `JobCancelledError`
 * or by `applyCancellation` reconciling a result that arrived after the signal fired.
 *
 * It carries no `error` and no retry/service data by construction: a cancellation is
 * not a diagnostic, and it must not be eligible for any retry policy. Anything the
 * underlying result said survives in `notes`.
 */
export interface WorkflowCancelledResult extends WorkflowResultBase {
	status: 'cancelled';
}

/**
 * How a workflow run ended.
 *
 * A discriminated union rather than one optional-field bag, so the state model the
 * comments used to describe is enforced by the compiler: a `failed` result cannot
 * omit its `error`, a `done` result cannot carry one, and only a `deferred` result can
 * name an unhealthy service. Backends settle it with an exhaustive `switch` +
 * `assertNever`, so adding a variant is a compile error at every settlement point.
 *
 * The one hole TypeScript leaves open is a *spread* of one variant into another
 * (`{ ...deferredResult, status: 'cancelled' }` type-checks and smuggles the deferred
 * fields across). Construct each variant explicitly — `applyCancellation` does.
 */
export type WorkflowResult =
	| WorkflowDoneResult
	| WorkflowFailedResult
	| WorkflowDeferredResult
	| WorkflowCancelledResult;

/**
 * Exhaustiveness backstop for a `switch` over a closed union — the `default` branch
 * only type-checks while every variant has its own `case`. Lives beside
 * `WorkflowResult` because that is the union whose settlement it guards; the throw is
 * unreachable in a well-typed build and exists only so a JS-side caller (the test
 * suites import the compiled bundle) fails loudly instead of silently returning
 * `undefined`.
 */
export function assertNever(value: never): never {
	throw new Error(`Unhandled union member: ${JSON.stringify(value)}`);
}

export interface ScanReport {
	inbox: number;
	running: number;
	done: number;
	failed: number;
	cancelled: number;
	/**
	 * How many jobs the crash-lease + hang sweep bounced `running → queued`
	 * (`Orchestrator.recoverStaleDbJobs()`).
	 *
	 * thq WP-8: this used to count the file queue's own stale-running sweep, and the db
	 * sweep reported separately as `dbRecovered` while both queues coexisted. With the
	 * file queue gone there is exactly one recovery number, so it keeps the original
	 * name rather than the transitional one — two names for one count is the confusion,
	 * not the clarity.
	 */
	recovered: number;
	/** `Orchestrator.pruneTerminalDbJobs()`'s count: terminal rows deleted by the
	 * `orchestrationJobRetentionDays` retention policy. Genuinely distinct from
	 * `recovered` (and never had a file-side counterpart — the file queue had no
	 * pruning at all, which is why 37,081 job files accumulated). */
	pruned: number;
}
