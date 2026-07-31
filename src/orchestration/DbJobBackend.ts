import { Notice, TFile } from 'obsidian';
import type CruciblePlugin from '../main';
import type { SqliteJobStore } from './db/SqliteJobStore';
import type { DbJobRow } from './db/types';
import type { JobTypeConfig } from './jobTypeConfig';
import type {
	JobPriority,
	JobType,
	OrchestrationEnqueueOptions,
	OrchestrationJob,
	WorkflowCancelledResult,
	WorkflowDeferredResult,
	WorkflowFailedResult,
	WorkflowResult,
} from './types';
import { assertNever } from './types';
import type { Workflow } from './workflows/Workflow';
import {
	JobBackend,
	JobQuerySeam,
	QueueCountsSource,
	RunOutcome,
	resolveTimeoutMs,
	runWorkflowWithTimeout,
	scheduleQueueChanged,
} from './JobBackend';
import { CancelJobOutcome, RemoveQueuedOutcome, RunSettlement, RunningJobRegistry } from './cancellation';
import { logError } from '../log';
import { routineJobNotice } from './notices';
import { defaultLaneForPriority, laneRank } from './lanes';
import { classifyFailedJob } from './failedJobRepair';
import { newJobId, nowIso } from './utils/dates';

/**
 * The queue backend (thq WP-6; the only one since WP-8 retired the markdown
 * `FileJobBackend` and the in-memory `MemoryJobBackend`). Every registered job type
 * gets one of these over the shared `SqliteJobStore` (thq WP-5): the enablement gates,
 * the dedupe-with-promotion collapse, the settle mapping, the failure `Notice`, the
 * deferral wake and the coalesced queue-changed emits are all as they were when jobs
 * were markdown files under `orchestrationQueueRoot`.
 *
 * Three things the storage change made *structurally* impossible rather than merely
 * fixed, which is why the corresponding recovery machinery is gone:
 *
 *  * **No rename dance.** A job's bucket is a column, not a folder, so the
 *    claim/settle path is a single guarded UPDATE rather than rename-then-frontmatter.
 *    A transition applies or it doesn't — no half-moved job, and therefore no
 *    "aborted claim" state to recover from (see `SqliteJobStore.claimNext`).
 *  * **No `claimed` set.** The markdown claim spanned an await, so two workers could
 *    race it; here the claim IS the atomic `UPDATE ... WHERE status='queued'`.
 *  * **`hasPending` is honest.** The markdown queue answered "maybe" (always true)
 *    because emptiness was only discovered during the claim; a `COUNT(*)` over an
 *    index answers it exactly.
 *
 * What is deliberately unchanged: `running`/`claiming` bookkeeping (so `isRunning`,
 * `isCancelling` and the non-async `cancelJob` behave as every caller already expects),
 * and the fact that `clearQueued` emits nothing — the Orchestrator emits once for the
 * whole bulk operation.
 */
export class DbJobBackend implements JobBackend, JobQuerySeam {
	/**
	 * Drain readiness for this type — see `JobTypeConfig.drainsWithoutAutorun` for what
	 * it does and does not gate (its name overstates it). Per-type config since thq
	 * WP-8 rather than a per-backend constant: it was `false` on `FileJobBackend` and
	 * `true` on `MemoryJobBackend`, so collapsing both onto this one durable backend
	 * would otherwise have silently added the 5s initial-drain delay to enrichment.
	 */
	readonly drainsWithoutAutorun: boolean;
	// Runs currently executing, keyed by job id — the same key `runJob`/`cancelJob` take.
	private readonly running = new RunningJobRegistry();
	/**
	 * Job ids currently mid-claim. The window it covers is a single synchronous JS turn
	 * (node:sqlite is synchronous, and `execute` reaches `running.begin` before its
	 * first await), where the markdown queue's claim spanned a ~2s `store.move` under
	 * the metadata-cache write barrier. Tracked anyway, deliberately: `cancelJob` must
	 * never depend on that gap staying zero — a future await inserted anywhere in this
	 * path would silently reopen the "cancel answers not-running for a job that then
	 * visibly starts" bug this exists to close.
	 */
	private readonly claiming = new Map<string, { promise: Promise<void>; resolve: () => void }>();
	private retryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly plugin: CruciblePlugin,
		private readonly store: SqliteJobStore,
		private readonly type: JobType,
		private readonly config: JobTypeConfig,
		private readonly workflow: Workflow,
	) {
		this.drainsWithoutAutorun = config.drainsWithoutAutorun === true;
	}

	async enqueue(params: Record<string, unknown>, options: OrchestrationEnqueueOptions = {}): Promise<OrchestrationJob | null> {
		if (!this.plugin.settings.orchestrationEnabled) {
			new Notice('Orchestrate: disabled in settings.');
			return null;
		}
		if (!this.isWorkflowEnabled()) {
			new Notice(`Orchestrate: workflow "${this.type}" is disabled in settings.`);
			return null;
		}
		const dedupeKey = this.dedupeKeyFor(params);
		if (dedupeKey) {
			const existing = this.store.findActive(dedupeKey);
			if (existing) {
				const priority = options.priority ?? 'normal';
				const lane = options.lane ?? defaultLaneForPriority(options.priority);
				const promotesLane = existing.status === 'queued' && laneRank(lane) < laneRank(existing.lane);
				const promotesPriority = existing.status === 'queued'
					&& lane === existing.lane
					&& priorityRank(priority) < priorityRank(existing.priority);
				if (promotesLane || promotesPriority) {
					// The lane only moves when it is the lane that promoted, but priority is
					// written for either promotion.
					this.store.promote(existing.id, promotesLane ? lane : undefined, priority);
					this.emitQueueUpdate();
					routineJobNotice(this.plugin, this.type, `Orchestrate: promoted ${this.type} (${existing.id})`);
					return { ...dbRowToOrchestrationJob(existing), lane, priority };
				}
				routineJobNotice(this.plugin, this.type, `Orchestrate: ${this.type} already queued for this target (${existing.id}).`);
				return dbRowToOrchestrationJob(existing);
			}
		}
		const row = this.store.insert({
			id: newJobId(this.type),
			type: this.type,
			created: nowIso(),
			params,
			priority: options.priority,
			lane: options.lane,
			dedupeKey,
		});
		routineJobNotice(this.plugin, this.type, `Orchestrate: queued ${this.type} (${row.id})`);
		this.emitQueueUpdate();
		return dbRowToOrchestrationJob(row);
	}

	async runNext(): Promise<RunOutcome> {
		if (!this.plugin.settings.orchestrationEnabled) return 'disabled';
		const claimed = this.claimNext();
		if (!claimed) return 'empty';
		return this.execute(claimed);
	}

	async runJob(id: string): Promise<RunOutcome> {
		if (!this.plugin.settings.orchestrationEnabled) return 'disabled';
		const claimed = this.claimById(id);
		if (!claimed) return 'empty';
		return this.execute(claimed);
	}

	// Cancels the running job with this id. A queued job is not running, so it answers
	// 'not-running' — dropping queued work is `removeQueued`, not an abort.
	//
	// Deliberately NOT an `async` function: several callers read `isCancelling(id)`
	// synchronously right after calling this (no await), relying on `running.cancel`'s
	// own abort() having already run by then. An unconditional `async`/`await` would
	// delay the abort() by a microtask tick even when there is no claim to wait for.
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

	// Removes one queued job of this type. A job a worker already claimed is no longer
	// `queued`, so the guarded UPDATE inside `store.cancelQueued` refuses it and this
	// answers `not-queued` — it is running, where `cancelJob` addresses it.
	async removeQueued(id: string): Promise<RemoveQueuedOutcome> {
		const row = this.store.get(id);
		if (!row || row.type !== this.type) return 'not-queued';
		try {
			return this.store.cancelQueued(id, Date.now()) ? 'removed' : 'not-queued';
		} catch (err) {
			// The store refused the write, so the job is still queued. Reporting it
			// removed would be a lie about a row the user can still see; reporting it
			// missing would be a different lie. Same three-valued contract as the file
			// backend's rolled-back move.
			logError(`failed to cancel queued job ${id}; it stays queued`, err);
			return 'failed';
		}
	}

	// Operates on the backend's own view of the queue (one UPDATE over this type's
	// queued rows), never on whatever a UI rendered — the monitor caps its table at 100
	// rows while a rebuild enqueues hundreds. No emit: the Orchestrator emits once for
	// the whole clear (see JobBackend.clearQueued).
	async clearQueued(): Promise<number> {
		return this.store.clearQueued(Date.now(), this.type);
	}

	// Exact, unlike the markdown queue's "maybe": one indexed COUNT(*) over
	// (type, status). Scoped to this type on purpose — the autorunner asks it per type
	// before starting a worker, and an unscoped count would start a drain for a type
	// whose queue is empty every time any OTHER type had work.
	hasPending(): boolean {
		return this.store.countByTypeAndStatus(this.type, ['queued']) > 0;
	}

	// ---- WP-7 seam: the queries the reach-around consumers move onto ----------------

	/** Queue rows of this type in claim order (queue monitor; `limit` maps to LIMIT,
	 * which is what retires the monitor's 100-row JS-side cap). */
	list(status: OrchestrationJob['status'], options: { limit?: number; offset?: number } = {}): OrchestrationJob[] {
		return this.store.list(status, { ...options, type: this.type }).map(dbRowToOrchestrationJob);
	}

	/** How many jobs of this type sit in any of `statuses` (intake button state). */
	count(statuses: OrchestrationJob['status'][]): number {
		return this.store.countByTypeAndStatus(this.type, statuses);
	}

	/** Progress line for a running job — replaces `SearchJobProgress`'s scan of the
	 * running folder for its own TFile (`SearchIndexWorkflow.ts:337-352`). */
	setProgress(id: string, message: string): void {
		this.store.setProgress(id, message);
		this.emitQueueUpdate();
	}

	// ---- Claim ---------------------------------------------------------------------

	private claimNext(): DbJobRow | null {
		const now = Date.now();
		const row = this.store.claimNext(now, [this.type]);
		if (!row) {
			// Nothing claimable: if something is merely deferred, book a wake for it
			// rather than waiting on the autorunner's 60s tick. `nextDeferredWakeMs` is
			// queue-wide (the store has no per-type form); a wake for another type's job
			// costs one extra emit + kick of this type's drain, which is idempotent.
			const wakeAt = this.store.nextDeferredWakeMs();
			if (wakeAt !== null && wakeAt > now) this.scheduleRetryWake(wakeAt - now);
			return null;
		}
		this.registerClaiming(row.id);
		this.emitQueueUpdate();
		return row;
	}

	// Claim-by-id for a manual per-job Run: same guarded claim as claimNext, but
	// targets one job and ignores the deferUntil gate (the user is asking for it now).
	private claimById(id: string): DbJobRow | null {
		const row = this.store.get(id);
		if (!row || row.type !== this.type) return null;
		const claimed = this.store.claimById(id, Date.now());
		if (!claimed) return null;
		this.registerClaiming(claimed.id);
		this.emitQueueUpdate();
		return claimed;
	}

	// Registers `id` as mid-claim; resolved by `settleClaiming` once it either lands in
	// `running` or the claim itself failed. Called synchronously at the same point the
	// claim lands, so a `cancelJob` arriving anywhere in the claim window sees it.
	private registerClaiming(id: string): void {
		let resolve: () => void = () => { /* replaced synchronously below */ };
		const promise = new Promise<void>(r => { resolve = r; });
		this.claiming.set(id, { promise, resolve });
	}

	// Wakes any `cancelJob` waiting on `id`'s claim. Idempotent.
	private settleClaiming(id: string): void {
		const state = this.claiming.get(id);
		if (!state) return;
		this.claiming.delete(id);
		state.resolve();
	}

	// ---- Run / settle ----------------------------------------------------------------

	// Returns the drain outcome: 'ran' for anything the drain should keep going after,
	// 'blocked' when the job came back deferred because a declared *service* is down —
	// which ends the type's drain for this pass.
	private async execute(row: DbJobRow): Promise<RunOutcome> {
		const job = dbRowToOrchestrationJob(row);
		if (!this.isWorkflowEnabled()) {
			// This id will never reach `running.begin` below — settle its claim here so a
			// concurrent cancelJob() doesn't wait forever for a run that isn't coming.
			this.settleClaiming(job.id);
			this.failEntry(job, `Workflow "${job.type}" is disabled in settings`);
			return 'ran';
		}
		// Registered for the whole of execute(), including the transition that settles
		// the job, so `isCancelling` stays true until the row has left `running` — which
		// is what keeps the stale sweep from resurrecting a job that is winding down.
		const run = this.running.begin(job.id);
		// Settle AFTER begin(), never before: a cancelJob() waiting on this id must
		// observe `running.isRunning(id) === true` the moment it wakes.
		this.settleClaiming(job.id);
		let settlement: RunSettlement = 'completed';
		try {
			const result = await runWorkflowWithTimeout(
				this.plugin, this.workflow, job, resolveTimeoutMs(this.plugin, this.config), run.signal,
			);
			if (result.outputPaths && result.outputPaths.length > 0) {
				this.store.setOutputPaths(job.id, result.outputPaths);
			}
			// One exhaustive switch over `WorkflowResult`, with `assertNever` as the
			// backstop: adding a terminal variant becomes a compile error here rather than
			// a job that silently never settles. The old if-ladder also needed a placeholder
			// error string for a `failed` result that carried none — the union makes `error`
			// required on that variant, so that dead defensiveness is gone rather than
			// merely unreached.
			//
			// `deferred` deliberately does NOT append run notes: its message is written by
			// `deferEntry` through `setDeferred`, not as narration on a settled job.
			switch (result.status) {
				case 'deferred':
					this.deferEntry(job, result);
					return result.serviceUnhealthy ? 'blocked' : 'ran';
				case 'cancelled':
					this.appendResultNotes(job, result);
					settlement = 'cancelled';
					this.cancelEntry(job, result);
					return 'ran';
				case 'failed':
					this.appendResultNotes(job, result);
					this.failEntry(job, result.error, result);
					return 'ran';
				case 'done':
					this.appendResultNotes(job, result);
					this.store.transition(job.id, 'done', Date.now());
					// A completed job is the only honest evidence that its dependencies are alive,
					// and it is evidence for ALL of them. This is the half-open probe's success path.
					this.reportServicesHealthy();
					this.emitQueueUpdate();
					this.emitTrackerEvent(result, 'done');
					routineJobNotice(this.plugin, this.type, `Orchestrate: ${job.id} → done`);
					return 'ran';
				default:
					return assertNever(result);
			}
		} catch (e) {
			this.failEntry(job, e instanceof Error ? e.message : String(e));
		} finally {
			run.finish(settlement);
		}
		return 'ran';
	}

	// Run narration for a settled job. Extracted from the settlement ladder so each
	// terminal branch names it explicitly and `deferred`'s deliberate omission reads as
	// a decision rather than as fall-through ordering.
	private appendResultNotes(job: OrchestrationJob, result: WorkflowResult): void {
		if (!result.notes) return;
		this.store.appendNotes(job.id, result.notes);
		if (result.notes.startsWith('Partial:')) this.store.setPartial(job.id, true);
	}

	private reportServicesHealthy(): void {
		const registry = this.plugin.serviceHealth;
		if (!registry) return;
		for (const service of this.config.services ?? []) registry.reportSuccess(service);
	}

	// Terminal settle for a cancelled run. Deliberately not failEntry: no `error` is
	// written (a cancellation is not a diagnostic), the job lands in `cancelled` rather
	// than `failed` so no failure-retry policy can pick it up, and the notice follows
	// the routine-notice gate rather than the unconditional failure Notice.
	private cancelEntry(job: OrchestrationJob, result: WorkflowCancelledResult): void {
		this.store.transition(job.id, 'cancelled', Date.now());
		this.emitQueueUpdate();
		routineJobNotice(
			this.plugin,
			this.type,
			`Orchestrate: ${job.id} → cancelled${result.notes ? ` (${result.notes})` : ''}`,
		);
	}

	private deferEntry(job: OrchestrationJob, result: WorkflowDeferredResult): void {
		// Report BEFORE the store writes: the breaker must open even if settling the job
		// then fails, because the whole point is to stop the next claim.
		const unhealthy = result.serviceUnhealthy;
		if (unhealthy) {
			this.plugin.serviceHealth?.reportFailure(unhealthy.service, unhealthy.kind, unhealthy.reason, result.retryAfterMs);
		}
		const retryAfterMs = Math.max(1000, result.retryAfterMs ?? 30_000);
		const deferUntil = Date.now() + retryAfterMs;
		const message = result.notes ?? result.error ?? `Deferred; retrying after ${new Date(deferUntil).toISOString()}`;
		this.store.setDeferred(job.id, message, deferUntil);
		// Back to `queued`. A transition INTO queued deliberately leaves `defer_until`
		// alone (only non-queued targets clear it — `SqliteJobStore.transition`), so the
		// deferral written a line above survives the requeue and `claimNext` skips the
		// job until it expires.
		this.store.transition(job.id, 'queued', Date.now());
		// Best-effort: the autorunner's 60s tick + kickAll is the guaranteed wake, so one
		// replaceable timer per backend is not a recovery hazard.
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
	 * Settles a job into `failed`, and **never throws** — it is the last step of both
	 * the failure path and `execute`'s catch-all, so a store write that throws here
	 * would otherwise take out the type worker and leave the job stranded in `running`.
	 * Swallow, log, and let it stay `running`: it is observable there (the queue
	 * monitor renders it) and the stale-lease sweep bounces it back to `queued` once no
	 * live run owns it, whereas an un-drained *type* is invisible.
	 */
	private failEntry(job: OrchestrationJob, error: string, result?: WorkflowFailedResult): void {
		try {
			// Stamps how this failure classifies so a sweep can read the column instead of
			// re-pattern-matching `error`. Same classifier the retroactive repair tool uses
			// — single source of truth for the pattern table. One UPDATE here, where the
			// markdown queue needed three writes (setError, setFailureKind, move).
			const kind = classifyFailedJob(job, error) === 'service-outage' ? 'service' : 'job';
			this.store.transition(job.id, 'failed', Date.now(), { error, failureKind: kind });
			this.emitQueueUpdate();
			// WP-VF-3: the no-api-key auto-source latch that used to live here is removed.
			// It was unsound — runtime-only, and `uncapturedVideos.ts` re-asserts enable
			// from the persisted setting on every dashboard mount, so it never actually
			// stuck. Missing-key surfacing is now a UI affordance
			// (`src/ingestion/render/apiKeyAffordance.ts`) applied at the enqueue/schedule
			// sites themselves, not a queue-side kill switch. `Orchestrator.disableAutoSource`
			// stays (no other caller removed it), but nothing here calls it anymore.
		} catch (err) {
			logError(
				`failed to settle job ${job.id} into failed; it stays running for the stale sweep to recover (original error: ${error})`,
				err,
			);
		}
		if (result) this.emitTrackerEvent(result, 'failed');
		new Notice(`Orchestrate: ${job.id} → failed (${error})`);
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
			case 'image_describe_note':
			case 'image_describe_backfill':
			case 'image_describe_batch': return s.imageMetadataExtractionEnabled;
			default: return true;
		}
	}

	/**
	 * The stored dedupe key, namespaced by job type.
	 *
	 * The markdown queue got per-type dedupe for free: it walked the queue and skipped
	 * entries whose `job.type` differs before comparing keys. A single indexed
	 * `dedupe_key` lookup has no such filter, and the key functions genuinely collide
	 * across types — `youtubeMetadataDedupeKey` and `imageDescribeNoteDedupeKey` both
	 * mint `note:<path>` (`jobTypeConfig.ts`). Without the prefix, an image-describe
	 * enqueue would collapse onto a queued youtube-metadata job for the same note.
	 * The value is internal (nothing outside this file reads `dedupe_key`), so the
	 * prefix costs nothing.
	 */
	private dedupeKeyFor(params: Record<string, unknown>): string | null {
		if (!this.config.dedupeKey) return null;
		const key = this.config.dedupeKey(params);
		return key ? `${this.type}::${key}` : null;
	}

	// Coalesced (leading + trailing edge): a drain settles two emits per job, and every
	// emit costs each listener a full queue re-read plus a kickAll. Bulk operations still
	// emit exactly once, from the Orchestrator.
	private emitQueueUpdate(): void {
		scheduleQueueChanged(this.plugin, dbQueueCountsSource(this.store));
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

// Memoized per store so every backend sharing one queue shares one coalescing window:
// the coalescer keys on the resolved source's identity, and a fresh adapter object per
// call would give every emit its own window (i.e. no coalescing at all).
const dbCountsSources = new WeakMap<SqliteJobStore, QueueCountsSource>();

/** The DB queue's counts for `orchestration-queue-updated`: two indexed COUNT(*)s,
 * where the file queue needs two full folder listings. */
export function dbQueueCountsSource(store: SqliteJobStore): QueueCountsSource {
	const existing = dbCountsSources.get(store);
	if (existing) return existing;
	const source: QueueCountsSource = {
		queueCounts() {
			return Promise.resolve({ queued: store.count('queued'), running: store.count('running') });
		},
	};
	dbCountsSources.set(store, source);
	return source;
}

/**
 * The `OrchestrationJob` view of a DB row — what workflows, notices and the queue UI
 * consume. `inputPaths` is always empty (the column doesn't exist; grep-verified
 * write-only on the file side too — see `db/types.ts`'s `DbJobRow` doc), and
 * `deferUntil` is re-rendered as the ISO string `OrchestrationJob` declares from the
 * epoch-ms column.
 *
 * Exported (WP-7) so `Orchestrator.listJobs` can map DB rows the same way when
 * merging them with file-backed jobs for the queue monitor's all-types view — the
 * mapping logic has exactly one owner either way.
 */
export function dbRowToOrchestrationJob(row: DbJobRow): OrchestrationJob {
	return {
		id: row.id,
		type: row.type,
		status: row.status,
		priority: row.priority,
		lane: row.lane,
		created: row.created,
		inputPaths: [],
		outputPaths: row.outputPaths,
		params: row.params,
		error: row.error,
		failureKind: row.failureKind,
		progress: row.progress,
		deferUntil: row.deferUntil !== undefined ? new Date(row.deferUntil).toISOString() : undefined,
		notes: row.notes ? row.notes : undefined,
	};
}

function priorityRank(priority: JobPriority): number {
	switch (priority) {
		case 'high': return 0;
		case 'normal': return 1;
		case 'low': return 2;
	}
}
