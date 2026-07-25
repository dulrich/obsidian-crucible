import type CruciblePlugin from '../../main';
import { OrchestrationJob, WorkflowResult } from '../types';

/**
 * The single seam every workflow sees. Kept deliberately narrow: cancellation was
 * added by widening this context rather than by changing `run`'s arity, so all 19
 * registered workflows compile unchanged and only the ones that can usefully stop
 * early were instrumented.
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
}

export interface Workflow {
	run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult>;
}
