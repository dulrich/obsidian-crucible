import { type WorkflowCancelledResult, type WorkflowResult, assertNever } from './types';

/**
 * Cooperative cancellation for orchestration jobs.
 *
 * **The constraint that shapes this whole design: in-flight requests cannot be
 * aborted.** Every network call in Crucible goes through Obsidian's `requestUrl`,
 * whose `RequestUrlParam` has no `signal` field, and there are zero `fetch()`
 * callers in `src/`. So cancellation is cooperative *between awaits*: once it is
 * signalled, a workflow stops at its next checkpoint and starts no further work.
 *
 * Two consequences worth stating out loud, because they are easy to forget and
 * expensive to rediscover:
 *
 * 1. **Abort latency is bounded by the longest single in-flight request**, not by
 *    how densely checkpoints are placed. Sprinkling more `throwIfAborted()` calls
 *    around one `await requestUrl(...)` buys nothing. The granularity that matters
 *    is per-item / per-batch, which is also where the long workflows actually live
 *    (the search index loops over files, the tracker loops over feed entries).
 * 2. **A workflow that never checks its signal is not a bug that hangs anything.**
 *    The run simply finishes (or hits the per-job timeout, which is the backstop)
 *    and settles normally; `cancelJob` resolves `'completed'` rather than
 *    `'cancelled'`. Cancellation degrades — it does not deadlock.
 *
 * Migrating the search-companion client to `fetch` (loopback, our own server, a
 * real `AbortSignal`) would give true mid-request cancellation. That is recorded
 * as a future option and is deliberately out of scope here: it changes the
 * transport for the one client with its own dual-timeout design.
 */
export class JobCancelledError extends Error {
	constructor(message = 'Cancelled by user request') {
		super(message);
		this.name = 'JobCancelledError';
	}
}

export function isJobCancelledError(error: unknown): error is JobCancelledError {
	return error instanceof JobCancelledError;
}

/**
 * How a cancellation request resolved.
 *
 * - `cancelled` — the run observed the signal and settled into the cancelled
 *   terminal state.
 * - `completed` — the run settled before it observed the cancellation (it finished
 *   the work, failed on its own merits, or hit its timeout). Honest UI copy for
 *   this case is "finished before it could be stopped", not "stopped".
 * - `not-running` — no run holds that key. A *queued* job is not running, so this
 *   is what cancelling one reports; removing queued work is a queue operation, not
 *   an abort.
 */
export type CancelJobOutcome = 'cancelled' | 'completed' | 'not-running';

/**
 * How the one user-facing Cancel action resolved.
 *
 * Cancel is a single verb over two mechanisms — a *running* job is aborted
 * cooperatively (`CancelJobOutcome`), a *queued* one is removed from the queue —
 * and the union is deliberately flat so a caller never has to know which mechanism
 * applied before it can render an answer.
 *
 * - `cancelled` — a running job observed the signal and stopped.
 * - `completed` — a running job settled before it observed the signal. The honest
 *   copy is "finished before it could be stopped", *never* "stopped": with no
 *   reachable checkpoint (or with the work already done) this is the truth, and
 *   papering over it would claim the queue obeyed an instruction it did not.
 * - `removed` — the job was queued and never ran; it left the queue.
 * - `failed` — the job is queued and *stayed* queued: the store refused the move and
 *   rolled it back. Reporting this as `not-found` would be the same species of lie as
 *   reporting `completed` as "stopped" — the job is still right there.
 * - `not-found` — nothing under that key is queued or running any more.
 */
export type StopJobOutcome = 'cancelled' | 'completed' | 'removed' | 'failed' | 'not-found';

/**
 * How removing one *queued* job resolved. Deliberately three-valued rather than a
 * boolean: "it wasn't queued" and "it is queued and I could not move it" lead to
 * different, both-honest answers, and a boolean collapses them into a shrug.
 */
export type RemoveQueuedOutcome = 'removed' | 'not-queued' | 'failed';

/**
 * The note both backends record on a job stopped before it ever ran. Lives here
 * rather than in either backend so the file and memory halves of one Cancel button
 * cannot end up describing the same user action differently.
 */
export const CANCELLED_BEFORE_RUN = 'Cancelled from the queue monitor before it ran.';

/** How a run settled, as reported back by the backend that executed it. */
export type RunSettlement = 'cancelled' | 'completed';

export interface RunningJobHandle {
	/** Passed into the workflow context; aborted by `RunningJobRegistry.cancel`. */
	readonly signal: AbortSignal;
	/** True once cancellation has been requested for this run. */
	cancelRequested(): boolean;
	/**
	 * Settle the run and release anyone awaiting `cancel()`. Idempotent.
	 *
	 * Call this only after the job has fully left the `running` bucket — see
	 * `RunningJobRegistry.isCancelling`, which stale-recovery reads.
	 */
	finish(settlement: RunSettlement): void;
}

interface RunningJobState {
	controller: AbortController;
	settled: Promise<RunSettlement>;
	resolve: (settlement: RunSettlement) => void;
	done: boolean;
}

/**
 * The per-backend map of "runs currently executing", keyed the same way `runJob`
 * keys them (file job id / memory entry key), so a cancellation request addresses
 * a job with the identifier the caller already has.
 */
export class RunningJobRegistry {
	private readonly runs = new Map<string, RunningJobState>();

	/** Register a run about to start. The caller must `finish()` it in a `finally`. */
	begin(key: string): RunningJobHandle {
		const controller = new AbortController();
		let resolve: (settlement: RunSettlement) => void = () => { /* replaced synchronously below */ };
		const settled = new Promise<RunSettlement>(r => { resolve = r; });
		const state: RunningJobState = { controller, settled, resolve, done: false };
		this.runs.set(key, state);
		return {
			signal: controller.signal,
			cancelRequested: () => controller.signal.aborted,
			finish: (settlement: RunSettlement) => {
				if (state.done) return;
				state.done = true;
				// Deregister only if the slot is still ours. The backends' claim guards
				// make a key collision unreachable today, but one run's settlement must
				// never be able to drop another run's registration.
				if (this.runs.get(key) === state) this.runs.delete(key);
				state.resolve(settlement);
			},
		};
	}

	/**
	 * Signal the run holding `key` and await its settlement. Resolving only once the
	 * run has settled is what lets a caller show an honest "Stopping…" → "Stopped"
	 * transition instead of claiming the work stopped the instant a button was hit.
	 */
	cancel(key: string): Promise<CancelJobOutcome> {
		const state = this.runs.get(key);
		if (!state) return Promise.resolve<CancelJobOutcome>('not-running');
		if (!state.controller.signal.aborted) {
			// The abort *reason* is the error every checkpoint throws: the Web API's
			// `signal.throwIfAborted()` throws `signal.reason`, so code that only knows
			// the standard interface (SearchManager, any future helper taking a signal)
			// raises our typed error without importing anything from orchestration.
			state.controller.abort(new JobCancelledError(`Job ${key} cancelled by user request`));
		}
		return state.settled;
	}

	/**
	 * True while a run has been signalled but has not finished settling. Stale
	 * recovery reads this: a cancelled-but-still-settling job is mid-flight, and
	 * bouncing it `running → queued` would resurrect the work the user just stopped.
	 */
	isCancelling(key: string): boolean {
		return this.runs.get(key)?.controller.signal.aborted === true;
	}

	/** True while a run is registered, cancelled or not. */
	isRunning(key: string): boolean {
		return this.runs.has(key);
	}
}

/**
 * Reconcile a workflow's own result with the fact that cancellation was requested
 * while it ran. Pure, so the classification is unit-testable away from a backend.
 *
 * The `deferred` and `failed` rewrites are the load-bearing ones:
 *
 * - **`deferred` → `cancelled`.** A deferred job is moved back to `queued` and runs
 *   again shortly. Leaving it deferred would resurrect exactly the work the user
 *   just cancelled.
 * - **`failed` → `cancelled`.** Several workflows wrap a delegated call in
 *   `try/catch` and report `{ status: 'failed' }` for anything that escapes
 *   (`ChainRunWorkflow` is the clearest case), so an abort unwinding through them
 *   arrives here as a failure. Filing it under `failed` is precisely the retry-by-
 *   policy and diagnostics pollution the cancelled state exists to prevent, so the
 *   cancellation wins and the original message is preserved as a note.
 *
 * `done` is deliberately left alone: the work really did complete before the
 * checkpoint was reached, and reporting "cancelled" would tell the user nothing
 * happened when a note was in fact written.
 *
 * The rewrites **construct** a `WorkflowCancelledResult` rather than spreading the
 * original and erasing its invalid fields back to `undefined`. A spread is the one
 * way to smuggle deferred/failed fields into the cancelled variant past the compiler,
 * and the erase-to-`undefined` shape left every cancelled result carrying dead keys
 * that read as part of the contract. `outputPaths` is carried across on purpose: it
 * is a genuine common field, and `DbJobBackend.execute` records it off the
 * *post*-cancellation result — dropping it would lose the record of a note the run
 * had already written.
 */
export function applyCancellation(result: WorkflowResult, aborted: boolean): WorkflowResult {
	if (!aborted) return result;
	switch (result.status) {
		case 'cancelled':
		case 'done':
			return result;
		case 'deferred':
			return {
				status: 'cancelled',
				...(result.outputPaths ? { outputPaths: result.outputPaths } : {}),
				notes: `Cancelled instead of deferring: ${result.notes ?? result.error ?? 'no detail'}`,
			};
		case 'failed':
			return {
				status: 'cancelled',
				...(result.outputPaths ? { outputPaths: result.outputPaths } : {}),
				notes: `Cancelled; the workflow reported: ${result.error ?? result.notes ?? 'no detail'}`,
			};
		default:
			return assertNever(result);
	}
}

/**
 * Translate a thrown error into a cancelled result, or `null` when the error has
 * nothing to do with cancellation and must keep propagating.
 */
export function cancelledResultFor(error: unknown, signal: AbortSignal): WorkflowCancelledResult | null {
	if (isJobCancelledError(error)) return { status: 'cancelled', notes: error.message };
	if (!signal.aborted) return null;
	// Something else escaped after cancellation was requested — most often a step
	// that failed *because* the cancellation tore its work out from under it, or a
	// helper that caught our error and rethrew its own. Same reasoning as the
	// `failed` rewrite above: after a cancel request we never file a failure.
	const message = error instanceof Error ? error.message : String(error);
	return { status: 'cancelled', notes: `Cancelled; the run ended with: ${message}` };
}
