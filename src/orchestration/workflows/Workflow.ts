import type CruciblePlugin from '../../main';
import { OrchestrationJob, WorkflowResult } from '../types';

/**
 * The single seam every workflow sees. Kept deliberately narrow: cancellation was
 * added by widening this context rather than by changing `run`'s arity, so all 19
 * registered workflows compile unchanged and only the ones that can usefully stop
 * early were instrumented. WP-J1's `reportProgress` follows the same pattern.
 */
export interface WorkflowContext {
	plugin: CruciblePlugin;
	/**
	 * Aborted when this job's cancellation is requested. Pass it to any helper that
	 * accepts a standard `AbortSignal` (e.g. `SearchManager.indexFiles`), so the
	 * checkpoint lands inside that helper's loop rather than only around it.
	 *
	 * Cancellation is cooperative *between awaits* — Obsidian's `requestUrl` takes
	 * no signal, so an in-flight request always runs to completion. See
	 * `src/orchestration/cancellation.ts` for the full argument.
	 */
	signal: AbortSignal;
	/**
	 * Checkpoint. Throws `JobCancelledError` when cancellation has been requested;
	 * otherwise returns. Call it at the top of each iteration of a long loop, and
	 * before starting any expensive step — not between the statements of one.
	 *
	 * An entry checkpoint is applied centrally by `runWorkflowWithTimeout` before
	 * `run` is called, so no workflow needs to open with one.
	 */
	throwIfAborted(): void;
	/**
	 * WP-J1: writes this job's durable `progress` line (`DbJobBackend.setProgress` —
	 * one indexed UPDATE plus a coalesced `orchestration-queue-updated` emit, so
	 * per-item writes inside a tight loop are safe by construction). Required —
	 * `runWorkflowWithTimeout` always supplies a real closure over the job's own
	 * type+id, so no workflow needs to null-check it; a hand-built `WorkflowContext`
	 * in a test that doesn't care about progress can pass a no-op (`() => {}`).
	 *
	 * Call it from inside a long loop (batch/backfill-shaped jobs), throttled the
	 * same way `SearchManager.indexFiles`'s own `onProgress` is (every Nth item plus
	 * the final one) — not on every single iteration of a fast loop, and not so
	 * rarely that a slow loop (e.g. one image description call) sits visibly frozen
	 * in the queue monitor between updates.
	 */
	reportProgress(message: string): void;
}

export interface Workflow {
	run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult>;
}
