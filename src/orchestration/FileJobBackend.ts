import { Notice, TFile } from 'obsidian';
import type CruciblePlugin from '../main';
import type { JobStore } from './JobStore';
import type { JobTypeConfig } from './jobTypeConfig';
import type { JobPriority, JobType, OrchestrationEnqueueOptions, OrchestrationJob, WorkflowResult } from './types';
import type { Workflow } from './workflows/Workflow';
import { JobBackend, RunOutcome, resolveTimeoutMs, runWorkflowWithTimeout, scheduleQueueChanged } from './JobBackend';
import { CANCELLED_BEFORE_RUN, CancelJobOutcome, RemoveQueuedOutcome, RunSettlement, RunningJobRegistry } from './cancellation';
import { logError } from '../log';
import { routineJobNotice } from './notices';
import { defaultLaneForPriority, laneRank } from './lanes';
import { classifyFailedJob } from './failedJobRepair';

// Durable, markdown-backed job type: every job is a file under
// orchestrationQueueRoot/{queued,running,done,failed}. Enqueue collapses repeats by
// `dedupeKey` onto the existing active job; the drain claims a queued file, moves it
// to running, executes the workflow under the per-type/global timeout, and moves it
// to done/failed with notes/output recorded.
export class FileJobBackend implements JobBackend {
	readonly drainsWithoutAutorun = false;
	// File paths a worker has claimed but not yet moved to running. Guards the window
	// between listFolder and move so two workers of this type can't claim the same job
	// (claim + check happen synchronously, with no await between them).
	private readonly claimed = new Set<string>();
	// Runs currently executing, keyed by job id — the same key `runJob` takes, so
	// `cancelJob(id)` addresses a job with the identifier the caller already has.
	private readonly running = new RunningJobRegistry();
	/**
	 * Job ids currently mid-claim — registered the instant `claimNext`/`claimById`
	 * decide to take a job, resolved only once that job is either registered in
	 * `running` (a real run starting) or the claim itself failed. This is what makes
	 * `cancelJob` honest during `JobStore.move`'s claim window (up to ~2s under the
	 * cache write-barrier — see the frontmatter-barrier quirk in AGENTS.md): before
	 * this, a job in that window was invisible to both `running` and `queued`
	 * (already off `this.claimed`'s callers' radar for `removeQueued`, but not yet in
	 * `running`), so `stopJob`'s two-call retry could exhaust both checks and answer
	 * `'not-found'` for a job that then visibly started running.
	 *
	 * Deliberately NOT a redesign of claiming: this only makes `cancelJob` wait out a
	 * claim already in flight before it answers, using the exact same
	 * `running`/`store.move` machinery the drain already relies on. It does not touch
	 * `isRetirable`'s stale-claim recovery semantics.
	 */
	private readonly claiming = new Map<string, { promise: Promise<void>; resolve: () => void }>();
	private retryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly plugin: CruciblePlugin,
		private readonly store: JobStore,
		private readonly type: JobType,
		private readonly config: JobTypeConfig,
		private readonly workflow: Workflow,
	) {}

	async enqueue(params: Record<string, unknown>, options: OrchestrationEnqueueOptions = {}): Promise<OrchestrationJob | null> {
		if (!this.plugin.settings.orchestrationEnabled) {
			new Notice('Orchestrate: disabled in settings.');
			return null;
		}
		if (!this.isWorkflowEnabled()) {
			new Notice(`Orchestrate: workflow "${this.type}" is disabled in settings.`);
			return null;
		}
		if (this.config.dedupeKey) {
			const key = this.config.dedupeKey(params);
			if (key) {
				const existing = await this.findActiveJob(key);
				if (existing) {
					const priority = options.priority ?? 'normal';
					const lane = options.lane ?? defaultLaneForPriority(options.priority);
					const promotesLane = existing.job.status === 'queued' && laneRank(lane) < laneRank(existing.job.lane);
					const promotesPriority = existing.job.status === 'queued'
						&& lane === existing.job.lane
						&& priorityRank(priority) < priorityRank(existing.job.priority);
					if (promotesLane || promotesPriority) {
						if (promotesLane) await this.store.setLane(existing.file, lane);
						if (promotesLane || promotesPriority) await this.store.setPriority(existing.file, priority);
						this.emitQueueUpdate();
						routineJobNotice(this.plugin, this.type, `Orchestrate: promoted ${this.type} (${existing.job.id})`);
						return { ...existing.job, lane, priority };
					}
					routineJobNotice(this.plugin, this.type, `Orchestrate: ${this.type} already queued for this target (${existing.job.id}).`);
					return existing.job;
				}
			}
		}
		const job = await this.store.enqueue(this.type, { params, priority: options.priority, lane: options.lane, inputPaths: options.inputPaths });
		routineJobNotice(this.plugin, this.type, `Orchestrate: queued ${this.type} (${job.id})`);
		this.emitQueueUpdate();
		return job;
	}

	async runNext(): Promise<RunOutcome> {
		if (!this.plugin.settings.orchestrationEnabled) return 'disabled';
		const moved = await this.claimNext();
		if (!moved) return 'empty';
		return this.execute(moved);
	}

	async runJob(id: string): Promise<RunOutcome> {
		if (!this.plugin.settings.orchestrationEnabled) return 'disabled';
		const moved = await this.claimById(id);
		if (!moved) return 'empty';
		return this.execute(moved);
	}

	// Cancels the running job with this id. A queued job is not running, so it
	// answers 'not-running' — dropping queued work is a queue operation (removing the
	// markdown file), not an abort of work in progress.
	//
	// If `id` is mid-claim (see `claiming`), wait it out first: `running.cancel` reads
	// the registry as it is *right now*, and right now the claim may simply not have
	// landed yet even though the job is seconds from executing. Waiting is what turns
	// that into an honest 'cancelled'/'completed' instead of a premature 'not-running'.
	//
	// Deliberately NOT an `async` function: several callers read `isCancelling(id)`
	// synchronously right after calling this (no await), relying on `running.cancel`'s
	// own abort() having already run by then. Wrapping the whole body in `async` would
	// insert a microtask tick before that abort() even for the common (not currently
	// claiming) case, breaking that guarantee. Only take the detour when there is
	// actually a claim to wait for.
	cancelJob(id: string): Promise<CancelJobOutcome> {
		const claiming = this.claiming.get(id);
		if (!claiming) return this.running.cancel(id);
		return claiming.promise.then(() => this.running.cancel(id));
	}

	isCancelling(id: string): boolean {
		return this.running.isCancelling(id);
	}

	isRunning(id: string): boolean {
		return this.running.isRunning(id);
	}

	// Removes one queued job of this type. A job a worker has already claimed reads as
	// `not-queued` here — it is on its way to running/, where `cancelJob` addresses it.
	async removeQueued(id: string): Promise<RemoveQueuedOutcome> {
		await this.store.ensureFolders();
		const queued = await this.store.listFolder('queued');
		const entry = queued.find(e => e.job.type === this.type && e.job.id === id && this.isRetirable(e));
		return entry ? this.retire(entry) : 'not-queued';
	}

	// Reads the queue from the store, not from anything a UI rendered: the monitor
	// caps its table at 100 rows while a search rebuild enqueues hundreds of jobs, and
	// a clear that only cleared what was on screen would be a quiet lie. No emit —
	// the Orchestrator emits once for the whole clear (see JobBackend.clearQueued).
	async clearQueued(): Promise<number> {
		await this.store.ensureFolders();
		const queued = await this.store.listFolder('queued');
		let removed = 0;
		for (const entry of queued) {
			if (entry.job.type !== this.type || !this.isRetirable(entry)) continue;
			// A job the store refused stays queued and is simply not counted — one bad
			// job must not abort the clear for the several hundred behind it.
			if (await this.retire(entry) === 'removed') removed++;
		}
		return removed;
	}

	// Retires one queued job into cancelled/.
	//
	// Two deliberate choices. (1) It takes `claimed` — the same synchronous guard
	// claimNext/claimById take — so a job can never be moved out from under a worker
	// that is between listFolder and its own move. (2) It *moves* rather than deletes:
	// in this store the folder is what records a job's state, so a job stopped before
	// it ran belongs in the same cancelled/ bucket WP-A settles aborted runs into,
	// where it stays auditable and cannot be picked up by any future failure-retry
	// policy. Moving also inherits JobStore.move's rollback invariant — a frontmatter
	// write failure renames the file back and rethrows, leaving the job fully queued,
	// which is exactly the case this must report as `'failed'` rather than swallow.
	/**
	 * Is this snapshot entry still ours to retire?
	 *
	 * `listFolder('queued')` awaits a `readJob` per file — over a 2,000-job inbox that
	 * loop is long — while Obsidian `TFile` objects are *live*: a rename mutates
	 * `file.path` in place. So an entry read early in the snapshot can, by the time we
	 * act on it, already have been claimed by a drain worker and renamed into
	 * `running/`, or even have finished and landed in `done/`. The old guard
	 * (`!claimed.has(file.path)`) could not see that: `claimed` is cleared the moment
	 * the claim's move completes, and it holds the *inbox* path anyway, so the check
	 * passed and `retire()` moved a mid-execution job into `cancelled/` — after which
	 * the workflow's own settle renamed it out again.
	 *
	 * The live path is the authoritative bucket (the folder IS the job's state), so
	 * comparing it against the queued folder is the exact "did this move?" test, and it
	 * needs no extra store round trip.
	 */
	private isRetirable(entry: { file: TFile; job: OrchestrationJob }): boolean {
		if (this.claimed.has(entry.file.path)) return false;
		if (this.running.isRunning(entry.job.id)) return false;
		const queuedFolder = this.store.folderForStatus('queued');
		return entry.file.path.startsWith(`${queuedFolder}/`);
	}

	private async retire(entry: { file: TFile; job: OrchestrationJob }): Promise<RemoveQueuedOutcome> {
		// Re-checked here, with no await between the check and the claim, so the window
		// between the caller's `find` and this call cannot be used either.
		if (!this.isRetirable(entry)) return 'not-queued';
		// `TFile.path` mutates on rename, so the key to release is the one we added, not
		// whatever the file's path reads as after the move.
		const claimPath = entry.file.path;
		this.claimed.add(claimPath);
		try {
			const moved = await this.store.move(entry.file, entry.job, 'cancelled');
			try {
				await this.store.appendNotes(moved.file, CANCELLED_BEFORE_RUN);
			} catch (err) {
				// The bucket already records the outcome; a missing note is cosmetic, and
				// re-reporting failure here would claim a job moved when it did move.
				logError(`failed to note the cancellation of queued job ${entry.job.id}`, err);
			}
			return 'removed';
		} catch (err) {
			logError(`failed to cancel queued job ${entry.job.id}; it stays queued`, err);
			return 'failed';
		} finally {
			this.claimed.delete(claimPath);
		}
	}

	// File types report "maybe": emptiness is checked lazily during the claim, so the
	// drain treats `true` as "try a claim" and `runNext` returns 'empty' when nothing
	// is actually claimable.
	hasPending(): boolean {
		return true;
	}

	refill(): void {
		/* file types have no auto-source */
	}

	// Finds a queued or running job of this type whose params resolve to the same
	// dedupe key, so callers can collapse repeat enqueues onto one job.
	private async findActiveJob(key: string): Promise<{ job: OrchestrationJob; file: TFile } | null> {
		await this.store.ensureFolders();
		const [queued, running] = await Promise.all([
			this.store.listFolder('queued'),
			this.store.listFolder('running'),
		]);
		for (const entry of [...queued, ...running]) {
			if (entry.job.type !== this.type) continue;
			if (this.config.dedupeKey?.(entry.job.params ?? {}) === key) return entry;
		}
		return null;
	}

	// Registers `id` as mid-claim; resolved by `settleClaiming` once it either lands in
	// `running` or the claim itself fails. Called synchronously at the same point `id`
	// is added to `claimed`, so a `cancelJob` arriving anywhere in the claim window
	// sees it.
	private registerClaiming(id: string): void {
		let resolve: () => void = () => { /* replaced synchronously below */ };
		const promise = new Promise<void>(r => { resolve = r; });
		this.claiming.set(id, { promise, resolve });
	}

	// Wakes any `cancelJob` waiting on `id`'s claim. Idempotent — a second call (there
	// isn't one today, but future callers should be able to rely on it) is a no-op.
	private settleClaiming(id: string): void {
		const state = this.claiming.get(id);
		if (!state) return;
		this.claiming.delete(id);
		state.resolve();
	}

	private async claimNext(): Promise<{ file: TFile; job: OrchestrationJob } | null> {
		await this.store.ensureFolders();
		const queued = await this.store.listFolder('queued');
		let nextRetryAt = Number.POSITIVE_INFINITY;
		const next = queued.find(e => {
			if (e.job.type !== this.type || this.claimed.has(e.file.path)) return false;
			const deferUntil = parseDeferredTime(e.job.deferUntil);
			if (deferUntil !== null && deferUntil > Date.now()) {
				nextRetryAt = Math.min(nextRetryAt, deferUntil);
				return false;
			}
			return true;
		});
		if (!next && Number.isFinite(nextRetryAt)) this.scheduleRetryWake(nextRetryAt - Date.now());
		if (!next) return null;
		const claimPath = next.file.path;
		this.claimed.add(claimPath);
		this.registerClaiming(next.job.id);
		try {
			const moved = await this.store.move(next.file, next.job, 'running');
			this.emitQueueUpdate();
			return moved;
		} catch (err) {
			// The claim failed — nobody will call execute() for this id, so nothing else
			// will ever settle it. A cancelJob() waiting on it would otherwise hang.
			this.settleClaiming(next.job.id);
			throw err;
		} finally {
			this.claimed.delete(claimPath);
		}
	}

	// Claim-by-id for a manual per-job Run: same synchronous claim guard as claimNext,
	// but targets one job and ignores the deferUntil gate (the user is asking for it
	// now). Returns null if it isn't queued or a worker already claimed it.
	private async claimById(id: string): Promise<{ file: TFile; job: OrchestrationJob } | null> {
		await this.store.ensureFolders();
		const queued = await this.store.listFolder('queued');
		const next = queued.find(e => e.job.type === this.type && e.job.id === id && !this.claimed.has(e.file.path));
		if (!next) return null;
		const claimPath = next.file.path;
		this.claimed.add(claimPath);
		this.registerClaiming(next.job.id);
		try {
			const moved = await this.store.move(next.file, next.job, 'running');
			this.emitQueueUpdate();
			return moved;
		} catch (err) {
			this.settleClaiming(next.job.id);
			throw err;
		} finally {
			this.claimed.delete(claimPath);
		}
	}

	// Returns the drain outcome: 'ran' for anything the drain should keep going after,
	// 'blocked' when the job came back deferred because a declared *service* is down —
	// which ends the type's drain for this pass.
	private async execute(moved: { file: TFile; job: OrchestrationJob }): Promise<RunOutcome> {
		if (!this.isWorkflowEnabled()) {
			// This id will never reach `running.begin` below — settle its claim here so a
			// concurrent cancelJob() doesn't wait forever for a run that isn't coming.
			this.settleClaiming(moved.job.id);
			await this.failEntry(moved, `Workflow "${moved.job.type}" is disabled in settings`);
			return 'ran';
		}
		// Registered for the whole of execute(), including the store moves that settle
		// the job. `isCancelling` therefore stays true until the file has left
		// running/, which is what keeps Orchestrator.scan()'s stale sweep from
		// resurrecting a job that is still winding down.
		const run = this.running.begin(moved.job.id);
		// Settle AFTER begin(), never before: a cancelJob() waiting on this id must
		// observe `running.isRunning(id) === true` the moment it wakes, or it would
		// read the same false negative this fix exists to remove — just shifted later.
		this.settleClaiming(moved.job.id);
		let settlement: RunSettlement = 'completed';
		try {
			const result = await runWorkflowWithTimeout(
				this.plugin, this.workflow, moved.job, resolveTimeoutMs(this.plugin, this.config), run.signal,
			);
			if (result.outputPaths && result.outputPaths.length > 0) {
				await this.store.setOutputPaths(moved.file, result.outputPaths);
			}
			if (result.status === 'deferred') {
				await this.deferEntry(moved, result);
				return result.serviceUnhealthy ? 'blocked' : 'ran';
			}
			if (result.notes) {
				await this.store.appendNotes(moved.file, result.notes);
				if (result.notes.startsWith('Partial:')) await this.store.setPartial(moved.file, true);
			}
			if (result.status === 'cancelled') {
				settlement = 'cancelled';
				await this.cancelEntry(moved, result);
				return 'ran';
			}
			if (result.status === 'failed') {
				await this.failEntry(moved, result.error ?? 'Workflow returned failed status', result);
				return 'ran';
			}
			await this.store.move(moved.file, moved.job, 'done');
			// A completed job is the only honest evidence that its dependencies are alive,
			// and it is evidence for ALL of them: the workflow could not have finished with
			// one of them down. This is the half-open probe's success path.
			this.reportServicesHealthy();
			this.emitQueueUpdate();
			this.emitTrackerEvent(result, 'done');
			routineJobNotice(this.plugin, this.type, `Orchestrate: ${moved.job.id} → done`);
		} catch (e) {
			await this.failEntry(moved, e instanceof Error ? e.message : String(e));
		} finally {
			run.finish(settlement);
		}
		return 'ran';
	}

	private reportServicesHealthy(): void {
		const registry = this.plugin.serviceHealth;
		if (!registry) return;
		for (const service of this.config.services ?? []) registry.reportSuccess(service);
	}

	// Terminal settle for a cancelled run. Deliberately not failEntry: no `error` is
	// written (a cancellation is not a diagnostic), the job lands in cancelled/
	// rather than failed/ so no failure-retry policy can pick it up, and the notice
	// follows the routine-notice gate rather than the unconditional failure Notice.
	private async cancelEntry(moved: { file: TFile; job: OrchestrationJob }, result: WorkflowResult): Promise<void> {
		await this.store.move(moved.file, moved.job, 'cancelled');
		this.emitQueueUpdate();
		routineJobNotice(
			this.plugin,
			this.type,
			`Orchestrate: ${moved.job.id} → cancelled${result.notes ? ` (${result.notes})` : ''}`,
		);
	}

	private async deferEntry(moved: { file: TFile; job: OrchestrationJob }, result: WorkflowResult): Promise<void> {
		// Report BEFORE the store writes: the breaker must open even if settling the job
		// file then fails, because the whole point is to stop the next claim.
		const unhealthy = result.serviceUnhealthy;
		if (unhealthy) {
			this.plugin.serviceHealth?.reportFailure(unhealthy.service, unhealthy.kind, unhealthy.reason, result.retryAfterMs);
		}
		const retryAfterMs = Math.max(1000, result.retryAfterMs ?? 30_000);
		const deferUntil = new Date(Date.now() + retryAfterMs).toISOString();
		const message = result.notes ?? result.error ?? `Deferred; retrying after ${deferUntil}`;
		await this.store.setDeferred(moved.file, message, deferUntil);
		await this.store.move(moved.file, { ...moved.job, deferUntil }, 'queued');
		// Best-effort: the autorunner's 60s tick + kickAll is the guaranteed wake now, so
		// this timer being replaceable (one per backend) is no longer a recovery hazard.
		this.scheduleRetryWake(retryAfterMs);
		this.emitQueueUpdate();
	}

	private scheduleRetryWake(delayMs: number): void {
		const delay = Math.max(1000, Math.min(delayMs, 24 * 60 * 60 * 1000));
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.emitQueueUpdate();
			this.plugin.orchestrationAutoRunner?.kickDrainType(this.type);
		}, delay);
	}

	/**
	 * Settles a job into `failed/`, and **never throws**.
	 *
	 * It is the last step of both the failure path and `execute`'s catch-all, so a
	 * store write that throws here used to take out the type worker with it: the
	 * rejection propagated through `runNext` → `typeWorker` → the `Promise.all` in
	 * `drainType`, ending that type's drain (as an unhandled rejection on the
	 * `void drainType(...)` call) AND leaving the job stranded in `running/`.
	 *
	 * The choice made here: swallow, log, and let the job stay in `running/`. It is
	 * observable there — the queue monitor renders it, and `scan()`'s stale-running
	 * sweep bounces it back to `queued/` once no live run owns it — whereas an
	 * un-drained *type* is invisible until someone notices the queue stopped moving.
	 * `JobStore.move` rolls its rename back on a frontmatter failure, so "still in
	 * running/" is a consistent state rather than a half-moved one.
	 */
	private async failEntry(
		moved: { file: TFile; job: OrchestrationJob },
		error: string,
		result?: WorkflowResult,
	): Promise<void> {
		try {
			await this.store.setError(moved.file, error);
			// Forward-looking: stamps how this failure classifies so a future sweep can
			// read frontmatter instead of re-pattern-matching `error`. Same classifier the
			// retroactive repair tool uses — single source of truth for the pattern table.
			const kind = classifyFailedJob(moved.job, error) === 'service-outage' ? 'service' : 'job';
			await this.store.setFailureKind(moved.file, kind);
			await this.store.move(moved.file, moved.job, 'failed');
			this.emitQueueUpdate();
		} catch (err) {
			logError(
				`failed to settle job ${moved.job.id} into failed/; it stays in running/ for scan() to recover (original error: ${error})`,
				err,
			);
		}
		if (result) this.emitTrackerEvent(result, 'failed');
		new Notice(`Orchestrate: ${moved.job.id} → failed (${error})`);
	}

	private isWorkflowEnabled(): boolean {
		const s = this.plugin.settings;
		switch (this.type) {
			case 'daily_brief_lite': return s.orchestrationDailyBriefEnabled;
			case 'youtube_tracker': return s.orchestrationYoutubeTrackerEnabled;
			case 'youtube_tracker_consolidate': return s.orchestrationYoutubeTrackerEnabled;
			case 'blogs_tracker': return s.orchestrationBlogsTrackerEnabled;
			case 'blogs_tracker_consolidate': return s.orchestrationBlogsTrackerEnabled;
			case 'link_scan': return s.orchestrationLinkScanEnabled;
			case 'transcript_refine': return s.orchestrationTranscriptRefineEnabled;
			case 'image_metadata_extract': return s.imageMetadataExtractionEnabled;
			default: return true;
		}
	}

	// Coalesced (leading + trailing edge): a drain settles two emits per job, and each
	// emit costs two listFolder passes here plus one per listener plus a kickAll. See
	// scheduleQueueChanged. Bulk operations still emit exactly once, from the Orchestrator.
	private emitQueueUpdate(): void {
		scheduleQueueChanged(this.plugin, this.store);
	}

	private emitTrackerEvent(result: WorkflowResult, status: 'done' | 'failed'): void {
		const bus = this.plugin.ingestionEvents;
		if (!bus) return;
		let kind: 'blog' | 'youtube' | null = null;
		if (this.type === 'blogs_tracker' || this.type === 'blogs_tracker_consolidate') kind = 'blog';
		else if (this.type === 'youtube_tracker' || this.type === 'youtube_tracker_consolidate') kind = 'youtube';
		if (!kind) return;
		const outPath = result.outputPaths?.[0];
		const runFile = outPath ? this.plugin.app.vault.getAbstractFileByPath(outPath) : null;
		bus.emit('tracker-run', {
			kind,
			runFile: runFile instanceof TFile ? runFile : null,
			status,
		});
	}
}

function priorityRank(priority: JobPriority): number {
	switch (priority) {
		case 'high': return 0;
		case 'normal': return 1;
		case 'low': return 2;
	}
}

function parseDeferredTime(value: string | undefined): number | null {
	if (!value) return null;
	const ts = Date.parse(value);
	return Number.isFinite(ts) ? ts : null;
}
