import type CruciblePlugin from '../main';
import type { JobTypeConfig } from './jobTypeConfig';
import type { JobStatus, OrchestrationEnqueueOptions, OrchestrationJob, WorkflowResult } from './types';
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
 * One persistence strategy for a registered job type. `DbJobBackend` (durable,
 * SQLite-backed) is the only implementation since thq WP-8 retired the markdown
 * `FileJobBackend` and the in-memory `MemoryJobBackend`; the interface stays because
 * it is what lets the Orchestrator and the autorun drain dispatch to a backend instead
 * of branching on `config.persistence` in every method.
 */
export interface JobBackend {
	/** True when the type drains even with its per-type auto-run toggle off — the
	 * enrichment contract, now `JobTypeConfig.drainsWithoutAutorun` rather than a
	 * property of a whole backend class. */
	readonly drainsWithoutAutorun: boolean;
	/** Enqueue a job; returns the (real or synthetic) job, or null if rejected. */
	enqueue(params: Record<string, unknown>, options?: OrchestrationEnqueueOptions): Promise<OrchestrationJob | null>;
	/** Claim and run at most one job, reporting the outcome to the drain loop. */
	runNext(): Promise<RunOutcome>;
	/**
	 * Claim and run one specific queued job by key (the job id),
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
	 * `'failed'` is the case worth keeping distinct: the store refused the write, so the
	 * job *stayed queued*. The caller must not report success — and must not report it
	 * as missing either, because it is still sitting in the queue.
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
	 *    queue re-read in every listener plus `OrchestrationAutoRunner.kickAll()`,
	 *    so a per-item emit over a several-hundred-job clear is that many re-reads and
	 *    that many kicks. The Orchestrator emits once for the whole operation instead.
	 */
	clearQueued(): Promise<number>;
	/** Whether work is waiting — one indexed COUNT(*) over this type's queued rows. */
	hasPending(): boolean;
}

/**
 * WP-7 seam: backend-level list/count/progress queries for ONE job type, so the
 * reach-around consumers (queue monitor row source, intake buttons, the enrichment
 * badges, `SearchJobProgress`) read through a backend rather than a storage layer.
 * Implemented by `DbJobBackend` over already-indexed SQL — `list`/`count`/`setProgress`
 * predate this interface (see the WP-6 report's "The API WP-7 consumes").
 *
 * Kept separate from `JobBackend` rather than folded into it now that there is one
 * implementation: `JobBackend` is the *lifecycle* contract the drain dispatches on,
 * this is the *query* contract the UI reads through, and a future backend could
 * legitimately implement the first without the second (`hasJobQuerySeam` is what makes
 * that answerable instead of a crash).
 *
 * Return types are `Promise<X> | X` rather than a bare `Promise<X>`: the DB backend's
 * node:sqlite calls are synchronous, and forcing them into real Promises would be a
 * mechanical, test-breaking change (`tests/dbJobBackend.test.mjs` reads
 * `DbJobBackend.list/count/setProgress` results synchronously, with no `await`) for no
 * behavioral gain — every caller through this seam already `await`s the result, and
 * `await`ing a non-Promise value resolves it immediately.
 */
export interface JobQuerySeam {
	/** This type's rows in claim order. `limit`/`offset` map to a real SQL LIMIT. */
	list(status: JobStatus, options?: { limit?: number; offset?: number }): Promise<OrchestrationJob[]> | OrchestrationJob[];
	/** How many of this type sit in any of `statuses`. */
	count(statuses: JobStatus[]): Promise<number> | number;
	/** Progress line for a running job of this type; a no-op if the job can't be
	 * resolved (already settled, wrong type, or never existed). */
	setProgress(id: string, message: string): Promise<void> | void;
}

/** Duck-typed rather than an `instanceof` check, so a backend declares the seam by
 * carrying its methods rather than by inheriting from anything. */
export function hasJobQuerySeam(backend: JobBackend): backend is JobBackend & JobQuerySeam {
	const candidate = backend as Partial<JobQuerySeam>;
	return typeof candidate.list === 'function'
		&& typeof candidate.count === 'function'
		&& typeof candidate.setProgress === 'function';
}

/**
 * Where the `orchestration-queue-updated` payload comes from.
 *
 * The emit used to derive its counts from `JobStore.listFolder('queued'|'running')`
 * directly, which hard-wired the *file* queue into the event bus: a DB-backed backend
 * has no folders to list, and its counts are a `COUNT(*)`. This one-method abstraction
 * is the seam — anything that can answer "how many queued / how many running" can drive
 * the event, and the wire payload it produces is unchanged
 * (`{ queued: number, running: number }`).
 *
 * Still async after the cutover even though `dbQueueCountsSource` answers synchronously:
 * the emit path is already async end-to-end, and a counts source is exactly the kind of
 * thing a future backend (a remote queue, say) would need to await.
 */
export interface QueueCountsSource {
	queueCounts(): Promise<{ queued: number; running: number }>;
}

// The single "the queue changed" emit, with the current bucket counts.
// Exported (rather than staying private to the backend) because bulk operations
// have to emit exactly once for the whole batch: every listener answers this event
// with a full re-read of the queue, and the autorunner answers it with kickAll().
export async function emitQueueChanged(plugin: CruciblePlugin, source: QueueCountsSource): Promise<void> {
	const bus = plugin.ingestionEvents;
	if (!bus) return;
	try {
		const counts = await source.queueCounts();
		bus.emit('orchestration-queue-updated', { queued: counts.queued, running: counts.running });
	} catch (err) {
		logError('failed to emit orchestration-queue-updated', err);
	}
}

/**
 * Coalescing window for the per-job queue-changed emits.
 *
 * Every `orchestration-queue-updated` costs a counts query here, a full queue re-read in
 * each UI listener, and a `kickAll()` in the autorunner that can cost another query per
 * enabled type. At ~2 emits per job (claim + settle) that is quadratic in queue depth:
 * draining the 2,022-job requeue cohort ran into millions of awaited per-job frontmatter
 * reads on the main thread back when the queue was markdown. The counts are cheap now,
 * but the listener-side re-read and the kick fan-out are not, so the window stays.
 */
export const QUEUE_CHANGE_COALESCE_MS = 250;

interface QueueChangeCoalescer {
	lastEmitAt: number;
	timer: ReturnType<typeof setTimeout> | null;
}

// Per counts source (i.e. per queue), so two backends draining different types out of
// the same queue share one window rather than each getting its own. `dbQueueCountsSource`
// memoizes its adapter per SqliteJobStore, so "same queue" resolves to one key exactly
// as it did when this was keyed on the JobStore itself.
const queueChangeCoalescers = new WeakMap<QueueCountsSource, QueueChangeCoalescer>();

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
export function scheduleQueueChanged(plugin: CruciblePlugin, source: QueueCountsSource): void {
	let state = queueChangeCoalescers.get(source);
	if (!state) {
		state = { lastEmitAt: 0, timer: null };
		queueChangeCoalescers.set(source, state);
	}
	// A trailing emit is already booked; it will carry whatever this change did.
	if (state.timer) return;
	const now = Date.now();
	const since = now - state.lastEmitAt;
	if (since >= QUEUE_CHANGE_COALESCE_MS) {
		state.lastEmitAt = now;
		void emitQueueChanged(plugin, source);
		return;
	}
	const pending = state;
	pending.timer = setTimeout(() => {
		pending.timer = null;
		pending.lastEmitAt = Date.now();
		void emitQueueChanged(plugin, source);
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
