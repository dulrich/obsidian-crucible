import type CruciblePlugin from '../main';
import type { JobStore } from './JobStore';
import type { JobTypeConfig } from './jobTypeConfig';
import type { OrchestrationEnqueueOptions, OrchestrationJob, WorkflowResult } from './types';
import type { Workflow, WorkflowContext } from './workflows/Workflow';
import { CancelJobOutcome, RemoveQueuedOutcome, applyCancellation, cancelledResultFor } from './cancellation';
import { logError } from '../log';

/**
 * How one claim-and-run attempt ended, as the drain loop reads it.
 *
 * `blocked` is the service-health outcome: a job WAS claimed and run, and it came
 * back deferred because a *dependency* is down rather than because of anything about
 * the job. It ends the type's drain for this pass — that is the whole point. Without
 * it a service-level deferral reported as `'ran'`, so the worker looped straight back
 * for the next job and swept the entire queue at ~40 jobs/s against a dead service,
 * rewriting every job file on the way past.
 */
export type RunOutcome = 'ran' | 'empty' | 'disabled' | 'blocked';

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
	/**
	 * True while THIS process is executing a run for `key`, cancelled or not.
	 *
	 * `scan()`'s stale-running sweep reads it: the sweep's premise is "no live timer
	 * owns this job", and a run registered here is the counter-example. Without it a
	 * long job whose `updated` stamp has aged past the stale cutoff gets bounced
	 * `running → queued` while it is still executing, then claimed and run a second
	 * time — two concurrent runs of one job, each writing the same note.
	 */
	isRunning(key: string): boolean;
	/**
	 * Remove one *queued* job by key — the other half of the single Cancel verb, for
	 * work that has not started. Takes the same claim guard the drain takes, so a job
	 * can never be retired out from under a worker that is about to run it.
	 *
	 * `'failed'` is the case worth keeping distinct: `JobStore.move` rolls its rename
	 * back and rethrows when the frontmatter write fails, so a throw means the job
	 * *stayed queued*. The caller must not report success — and must not report it as
	 * missing either, because it is still sitting in the queue.
	 *
	 * Deliberately does NOT emit `orchestration-queue-updated`; see `clearQueued`.
	 */
	removeQueued(key: string): Promise<RemoveQueuedOutcome>;
	/**
	 * Remove every *queued* job of this type, returning how many left the queue.
	 * Running jobs are untouched — stopping those is `cancelJob`.
	 *
	 * Two invariants a reimplementation keeps getting wrong:
	 *
	 *  * It operates on the backend's own view of the queue, never on whatever a UI
	 *    happens to be rendering (the Queue Monitor caps its table at 100 rows while
	 *    a search rebuild enqueues hundreds of jobs).
	 *  * It emits **nothing**. `orchestration-queue-updated` triggers a full
	 *    `listFolder` re-read in every listener plus `OrchestrationAutoRunner.kickAll()`,
	 *    so a per-item emit over a several-hundred-job clear is that many re-reads and
	 *    that many kicks. The Orchestrator emits once for the whole operation instead.
	 */
	clearQueued(): Promise<number>;
	/** Whether work is (or might be) waiting. File types answer "maybe" (always true). */
	hasPending(): boolean;
	/** Pull fresh candidates in (memory types only); no-op otherwise. */
	refill(): void;
}

// The single "the file queue changed" emit, with the current bucket counts.
// Exported (rather than staying private to FileJobBackend) because bulk operations
// have to emit exactly once for the whole batch: every listener answers this event
// with a full listFolder re-read, and the autorunner answers it with kickAll().
export async function emitQueueChanged(plugin: CruciblePlugin, store: JobStore): Promise<void> {
	const bus = plugin.ingestionEvents;
	if (!bus) return;
	try {
		const [queued, running] = await Promise.all([
			store.listFolder('queued'),
			store.listFolder('running'),
		]);
		bus.emit('orchestration-queue-updated', { queued: queued.length, running: running.length });
	} catch (err) {
		logError('failed to emit orchestration-queue-updated', err);
	}
}

/**
 * Coalescing window for the per-job queue-changed emits.
 *
 * Every `orchestration-queue-updated` costs two full `listFolder` passes here, a
 * `listFolder` re-read in each UI listener, and a `kickAll()` in the autorunner that
 * can cost another `listFolder` per enabled type. At ~2 emits per job (claim +
 * settle) that is quadratic in queue depth: draining the 2,022-job requeue cohort
 * ran into millions of awaited `readJob` calls on the main thread.
 */
export const QUEUE_CHANGE_COALESCE_MS = 250;

interface QueueChangeCoalescer {
	lastEmitAt: number;
	timer: ReturnType<typeof setTimeout> | null;
}

// Per JobStore (i.e. per vault queue), so two backends draining different types share
// one window rather than each getting its own.
const queueChangeCoalescers = new WeakMap<JobStore, QueueChangeCoalescer>();

/**
 * Leading-plus-trailing-edge coalesced `emitQueueChanged`, for the high-frequency
 * per-job emits (claim / defer / settle / progress).
 *
 * Leading edge matters: the first change in a quiet period still emits immediately,
 * so a single enqueue wakes the drain and refreshes the UI with no added latency. Only
 * a *storm* is collapsed, and it collapses to at most one emit per window plus a
 * trailing one carrying the settled counts.
 *
 * Bulk operations deliberately do NOT use this — `Orchestrator.clearQueued` /
 * `removeQueuedJob` emit exactly once for the whole operation, which is a stronger
 * guarantee than coalescing and is asserted by tests.
 */
export function scheduleQueueChanged(plugin: CruciblePlugin, store: JobStore): void {
	let state = queueChangeCoalescers.get(store);
	if (!state) {
		state = { lastEmitAt: 0, timer: null };
		queueChangeCoalescers.set(store, state);
	}
	// A trailing emit is already booked; it will carry whatever this change did.
	if (state.timer) return;
	const now = Date.now();
	const since = now - state.lastEmitAt;
	if (since >= QUEUE_CHANGE_COALESCE_MS) {
		state.lastEmitAt = now;
		void emitQueueChanged(plugin, store);
		return;
	}
	const pending = state;
	pending.timer = setTimeout(() => {
		pending.timer = null;
		pending.lastEmitAt = Date.now();
		void emitQueueChanged(plugin, store);
	}, QUEUE_CHANGE_COALESCE_MS - since);
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
