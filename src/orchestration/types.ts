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
	| 'youtube_metadata_fetch'
	| 'youtube_channel_enrich'
	| 'youtube_channel_enrich_sweep'
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

export interface WorkflowResult {
	/**
	 * `cancelled` means the run observed a cancellation request and stopped — a
	 * terminal state distinct from `failed` on purpose (see `JobStatus`). Workflows
	 * rarely return it directly; it is normally produced by `runWorkflowWithTimeout`
	 * from a thrown `JobCancelledError` or by `applyCancellation` reconciling a
	 * result that arrived after the signal fired.
	 */
	status: 'done' | 'failed' | 'deferred' | 'cancelled';
	outputPaths?: string[];
	error?: string;
	/** Typed cause for `status: 'failed'`, when the workflow can name one. */
	failureReason?: WorkflowFailureReason;
	notes?: string;
	retryAfterMs?: number;
	/**
	 * Names the *dependency* whose outage caused this deferral, so the backend can
	 * report it to `ServiceHealthRegistry` and the drain can stop claiming jobs of
	 * every type that needs the same service.
	 *
	 * Only ever set alongside `status: 'deferred'`. A service-level problem must never
	 * come back as `'failed'` — that is exactly the mis-classification that turned one
	 * companion outage into 2,022 failure files. Workflows themselves never touch the
	 * registry: they describe what they saw and the backend does the reporting, which
	 * keeps workflow tests registry-free.
	 */
	serviceUnhealthy?: {
		service: ServiceId;
		kind: ServiceFailureKind;
		reason: string;
	};
}

export interface ScanReport {
	inbox: number;
	running: number;
	done: number;
	failed: number;
	cancelled: number;
	recovered: number;
	/** `Orchestrator.recoverStaleDbJobs()`'s count, folded in here so the scan notice
	 * can mention it once a `db` type exists — WP-6 landed the hook, WP-7 wires it into
	 * `scan()`. Always 0 with no `db` type registered. */
	dbRecovered: number;
	/** `Orchestrator.pruneTerminalDbJobs()`'s count — same shape as `dbRecovered`. */
	dbPruned: number;
}
