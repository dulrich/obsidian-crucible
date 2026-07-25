import type CruciblePlugin from '../main';
import type { JobTypeConfig } from './jobTypeConfig';
import type { OrchestrationEnqueueOptions, OrchestrationJob, WorkflowResult } from './types';
import type { Workflow, WorkflowContext } from './workflows/Workflow';
import { CancelJobOutcome, applyCancellation, cancelledResultFor } from './cancellation';

export type RunOutcome = 'ran' | 'empty' | 'disabled';

/**
 * One persistence strategy for a registered job type. `FileJobBackend` (durable,
 * markdown-backed) and `MemoryJobBackend` (transient, in-memory) implement this so
 * the Orchestrator and the autorun drain dispatch to a backend instead of branching
 * on `config.persistence` in every method.
 */
export interface JobBackend {
	/** True when the type drains even with the autorun toggle off (memory types). */
	readonly drainsWithoutAutorun: boolean;
	/** Enqueue a job; returns the (real or synthetic) job, or null if rejected. */
	enqueue(params: Record<string, unknown>, options?: OrchestrationEnqueueOptions): Promise<OrchestrationJob | null>;
	/** Claim and run at most one job, reporting the outcome to the drain loop. */
	runNext(): Promise<RunOutcome>;
	/**
	 * Claim and run one specific queued job by key (file job id / memory entry key),
	 * bypassing the auto-run gate. Reuses the same claim guard as the drain, so it
	 * cannot double-run a job a worker already claimed. `empty` if not found/claimable.
	 */
	runJob(key: string): Promise<RunOutcome>;
	/**
	 * Request cooperative cancellation of the *running* job identified by `key` (the
	 * same key `runJob` takes) and await its settlement. Mirrors `runJob`'s shape so
	 * a caller that can run one job can stop that same job.
	 *
	 * Resolves only once the run has settled and its job has left the `running`
	 * bucket, which is what lets a UI show an honest "Stopping…" → "Stopped"
	 * transition. See `CancelJobOutcome` for what each answer means; note that a
	 * *queued* job answers `'not-running'` — removing queued work is a queue
	 * operation, not an abort.
	 */
	cancelJob(key: string): Promise<CancelJobOutcome>;
	/**
	 * True while a run for `key` has been signalled to cancel and has not finished
	 * settling. Stale recovery consults this so a cancelled-but-still-settling job
	 * isn't bounced `running → queued` and re-run.
	 */
	isCancelling(key: string): boolean;
	/** Whether work is (or might be) waiting. File types answer "maybe" (always true). */
	hasPending(): boolean;
	/** Pull fresh candidates in (memory types only); no-op otherwise. */
	refill(): void;
}

// Resolves the effective per-run timeout: a per-type override if set, else the
// global autorun setting; 0 disables. Shared by both backends.
export function resolveTimeoutMs(plugin: CruciblePlugin, config: JobTypeConfig): number {
	if (typeof config.timeoutMs === 'number') return Math.max(0, config.timeoutMs);
	return Math.max(0, plugin.settings.orchestrationAutorunTimeoutSeconds) * 1000;
}

// Runs a workflow under `signal` and bounds it by `timeoutMs`.
//
// The two interruptions are different animals and both are needed:
//
//   * `signal` is *cooperative* — the workflow stops at its next checkpoint. It is
//     the mechanism a user's Cancel drives, and the run is awaited to completion so
//     everything it holds (the note lock above all) unwinds through its own
//     `finally` blocks.
//   * `timeoutMs` is the *backstop* — the race rejects and the caller settles the
//     job while the abandoned workflow promise keeps running in the background.
//     It is what stops a workflow with no checkpoint from pinning a queue slot
//     forever after it has been cancelled.
//
// An entry checkpoint is applied here, centrally, so every registered workflow gets
// "don't start work that was cancelled between claim and dispatch" for free and no
// workflow has to open with a boilerplate check. Per-iteration checkpoints are the
// part that must be placed by hand, and only in the loop-shaped workflows.
export async function runWorkflowWithTimeout(
	plugin: CruciblePlugin,
	workflow: Workflow,
	job: OrchestrationJob,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<WorkflowResult> {
	const ctx: WorkflowContext = { plugin, signal, throwIfAborted: () => signal.throwIfAborted() };
	try {
		signal.throwIfAborted();
		const result = timeoutMs <= 0
			? await workflow.run(job, ctx)
			: await raceWorkflowTimeout(workflow.run(job, ctx), timeoutMs);
		return applyCancellation(result, signal.aborted);
	} catch (e) {
		const cancelled = cancelledResultFor(e, signal);
		if (cancelled) return cancelled;
		throw e;
	}
}

async function raceWorkflowTimeout(run: Promise<WorkflowResult>, timeoutMs: number): Promise<WorkflowResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
	});
	try {
		return await Promise.race([run, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
