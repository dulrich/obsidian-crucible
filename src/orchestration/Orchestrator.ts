import { Notice } from 'obsidian';
import { JobStatus, JobType, OrchestrationEnqueueOptions, OrchestrationJob, ScanReport } from './types';
import { Workflow } from './workflows/Workflow';
import { JobTypeConfig, DEFAULT_JOB_TYPE_CONFIG } from './jobTypeConfig';
import { MinIntervalGate } from './utils/rateLimit';
import {
	JobBackend,
	QueueCountsSource,
	RunOutcome,
	emitQueueChanged,
	hasJobQuerySeam,
	resolveTimeoutMs,
} from './JobBackend';
import type { ServiceId } from './serviceHealth';
import type { CancelJobOutcome, RemoveQueuedOutcome } from './cancellation';
import { DbJobBackend, dbQueueCountsSource, dbRowToOrchestrationJob } from './DbJobBackend';
import { SqliteJobStore } from './db/SqliteJobStore';
import { SqliteUnavailableError, openJobsDb, resolveJobsDbPath } from './db/sqlite';
import { logError } from '../log';
import type CruciblePlugin from '../main';

// Backstop for jobs that slipped the per-job timeout entirely — e.g. a plugin
// reload mid-run leaves a job stranded in the running bucket. `scan()` re-queues
// these. The autorun timeout (orchestrationAutorunTimeoutSeconds) is the primary
// mechanism; this only catches what no live timer could.
const STALE_RUNNING_MS = 60 * 60 * 1000;
const STALE_RUNNING_TIMEOUT_BUFFER_MS = 30_000;

/** Default window a settled job suppresses its own auto-source re-seed for, when the
 * type declares no `terminalRetentionMs` — the same 60s `MemoryJobQueue` used. */
const DEFAULT_AUTO_SOURCE_SUPPRESSION_MS = 60_000;

export type { RunOutcome };

export function staleRunningMsForTimeout(timeoutMs: number): number {
	return timeoutMs > 0 ? timeoutMs + STALE_RUNNING_TIMEOUT_BUFFER_MS : STALE_RUNNING_MS;
}

/**
 * One candidate an auto-source offers the queue. Params only — the *key* is derived by
 * the type's own `dedupeKey`, so an auto-source physically cannot mint a key the
 * backend would dedupe differently (the drift `EnrichmentQueueAdapter.itemToSeed` had
 * to be careful about by hand).
 */
export interface JobSeed {
	params: Record<string, unknown>;
	lane?: OrchestrationJob['lane'];
}

/** A function that offers the current candidate set for a type. Called on every
 * refill, so it reads whatever the dashboard is showing right now. */
export type AutoSourceFn = () => JobSeed[];

/** How the Orchestrator obtains its shared `SqliteJobStore`. Injectable so tests can
 * hand over a `:memory:`-backed store (or one that throws) without touching the
 * vault-path resolution. */
export interface OrchestratorOptions {
	openDbStore?: () => SqliteJobStore;
}

export class Orchestrator {
	private configs: Map<JobType, JobTypeConfig> = new Map();
	private gates: Map<JobType, MinIntervalGate> = new Map();
	private backends: Map<JobType, JobBackend> = new Map();
	/** The one store every registered type shares, opened lazily on the first
	 * registration — see `dbStoreOrThrow`. Null only before any type registers. */
	private dbStore: SqliteJobStore | null = null;
	private readonly openDbStore: () => SqliteJobStore;
	/** Per-type auto-ENQUEUE sources: the candidate set a type pulls in when its queue
	 * drains empty. Registered at runtime (the enrichment source is dashboard-owned,
	 * because its items follow the dashboard's sort order) rather than declared in
	 * `JobTypeConfig`. See `refill`. */
	private readonly autoSources = new Map<JobType, AutoSourceFn>();
	private readonly autoSourceEnabled = new Set<JobType>();

	constructor(private plugin: CruciblePlugin, options: OrchestratorOptions = {}) {
		this.openDbStore = options.openDbStore
			?? (() => new SqliteJobStore(openJobsDb(resolveJobsDbPath(this.plugin.app, this.plugin.pluginDataPath('jobs.sqlite')))));
	}

	register(type: JobType, workflow: Workflow, config: JobTypeConfig = DEFAULT_JOB_TYPE_CONFIG): void {
		// Built BEFORE the config/gate maps are written: a registration whose store
		// cannot be opened throws, and a half-registered type (config present, no
		// backend) would report itself in `getConfig` while `jobTypes()` never lists it.
		const backend = this.createBackend(type, workflow, config);
		this.configs.set(type, config);
		this.gates.set(type, new MinIntervalGate(config.minIntervalMs));
		this.backends.set(type, backend);
	}

	// One arm today (`persistence` has one legal value). Kept as a dispatch rather than
	// inlined into `register` so a second backend is a `case`, not a re-derivation of
	// where the choice is made.
	private createBackend(type: JobType, workflow: Workflow, config: JobTypeConfig): JobBackend {
		switch (config.persistence) {
			case 'db':
			default:
				return new DbJobBackend(this.plugin, this.dbStoreOrThrow(), type, config, workflow);
		}
	}

	/**
	 * Opens the shared jobs DB on first use.
	 *
	 * `SqliteUnavailableError` is surfaced as a visible `Notice` + `logError` and then
	 * **rethrown**: there is no fallback storage for the queue (queue-db investigation,
	 * §Storage decision), and a type that silently registered against nothing would
	 * accept enqueues and drop them. Failing the registration is the honest outcome —
	 * the alternative is a queue that looks alive and loses work. `main.ts` catches the
	 * throw around the whole registration block, so orchestration dies and the rest of
	 * the plugin still loads.
	 */
	private dbStoreOrThrow(): SqliteJobStore {
		if (this.dbStore) return this.dbStore;
		try {
			this.dbStore = this.openDbStore();
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			new Notice(`Orchestrate: the job queue database is unavailable — ${detail}`);
			logError('failed to open the orchestration jobs database', err);
			throw err instanceof SqliteUnavailableError
				? err
				: new SqliteUnavailableError(`Could not open the orchestration jobs database: ${detail}`, err);
		}
		return this.dbStore;
	}

	/** The counts behind the bulk `orchestration-queue-updated` emits. Answers zeros
	 * before any type has registered (i.e. before a store exists) rather than throwing:
	 * an emit is a notification, and there is provably nothing to count. */
	private queueCountsProvider(): QueueCountsSource {
		const store = this.dbStore;
		if (!store) return { queueCounts: () => Promise.resolve({ queued: 0, running: 0 }) };
		return dbQueueCountsSource(store);
	}

	/**
	 * Immediate (non-coalesced) `orchestration-queue-updated` emit, using the correct
	 * combined provider — the same one `removeQueuedJob`/`clearQueued` already emit
	 * through. Public so a bulk operation that lives outside this class but still needs
	 * an exactly-once emit (`failedJobRepair`'s db+file bulk requeue) doesn't have to
	 * reach for `plugin.jobStore` directly and silently undercount once a `db` type
	 * exists.
	 */
	emitQueueChangedNow(): Promise<void> {
		return emitQueueChanged(this.plugin, this.queueCountsProvider());
	}

	/**
	 * Crash-lease + hang sweep over the queue: bounces `running → queued` any job whose
	 * claim token belongs to a previous plugin load, or whose claim has aged past the
	 * type's effective timeout + a 30s buffer (`staleRunningMsForTimeout`). A job this
	 * process is still executing is never swept. Called from `scan()`.
	 */
	recoverStaleDbJobs(): number {
		if (!this.dbStore) return 0;
		return this.dbStore.recoverStale(
			Date.now(),
			type => staleRunningMsForTimeout(resolveTimeoutMs(this.plugin, this.getConfig(type))),
			(id, type) => this.isRunning(type, id),
		);
	}

	/**
	 * Age-based terminal retention: deletes done/failed/cancelled rows settled more than
	 * `orchestrationJobRetentionDays` ago (0/blank = keep forever). This is the pruning
	 * the file queue never had — the reason 37,081 job files accumulated. Called from
	 * `scan()`.
	 */
	pruneTerminalDbJobs(): number {
		if (!this.dbStore) return 0;
		return this.dbStore.pruneTerminal(Date.now(), this.plugin.settings.orchestrationJobRetentionDays);
	}

	// ---- WP-7 seam: backend-agnostic queries for the reach-around consumers ---------

	/**
	 * Jobs of ANY registered type in `status`, in claim order — what the queue monitor
	 * table renders. One query for the whole queue, not one per registered type: every
	 * type shares one table, so `list(status, {})` (no type filter) already spans them
	 * all, ordered by the same `lane_rank, priority_rank, created, id` the claim uses.
	 *
	 * `limit`/`offset` are a real SQL `LIMIT`/`OFFSET`, so a queue thousands deep costs
	 * the monitor one bounded page rather than a full read followed by a JS-side cap.
	 */
	async listJobs(status: JobStatus, options: { limit?: number; offset?: number } = {}): Promise<OrchestrationJob[]> {
		if (!this.dbStore) return [];
		return this.dbStore.list(status, options).map(dbRowToOrchestrationJob);
	}

	/**
	 * Jobs of ONE type in any of `statuses`, in claim order — what the dashboard's
	 * per-type badges read (the enrichment "queued / enriching…" cells, which used to
	 * read `MemoryJobQueue.snapshot()` through `EnrichmentQueueAdapter`). Dispatches to
	 * that type's own backend seam, which scopes the query in SQL rather than filtering
	 * an all-types page in JS.
	 */
	async listTypeJobs(type: JobType, statuses: JobStatus[]): Promise<OrchestrationJob[]> {
		const backend = this.backends.get(type);
		if (!backend || !hasJobQuerySeam(backend)) return [];
		const pages = await Promise.all(statuses.map(status => backend.list(status)));
		return pages.flat();
	}

	/**
	 * How many jobs of ONE type sit in any of `statuses` — the intake-button existence
	 * check (`intake.ts`'s "is a blogs_tracker/youtube_tracker job already active").
	 * Unlike `listJobs`, this is naturally per-type (a backend already scopes itself to
	 * one type), so it just dispatches to that type's own `JobQuerySeam.count`. A type
	 * with no backend answers 0.
	 */
	async countJobs(type: JobType, statuses: JobStatus[]): Promise<number> {
		const backend = this.backends.get(type);
		if (!backend || !hasJobQuerySeam(backend)) return 0;
		return backend.count(statuses);
	}

	/**
	 * Progress line for one running job — replaces `SearchJobProgress`'s own scan of
	 * `running/` for its TFile (`SearchIndexWorkflow.ts`). Dispatches to the job's own
	 * type's backend, which writes its own row (one indexed UPDATE) and emits its own
	 * coalesced `orchestration-queue-updated`. A type with no seam is a no-op.
	 */
	async setJobProgress(type: JobType, id: string, message: string): Promise<void> {
		const backend = this.backends.get(type);
		if (backend && hasJobQuerySeam(backend)) await backend.setProgress(id, message);
	}

	/**
	 * `failedJobRepair`'s bulk service-outage requeue. Lives here rather than on
	 * `DbJobBackend` because the requeue is queue-wide (every type shares one table),
	 * the same reason `clearQueued`/`scan()`'s sweeps are Orchestrator-level rather than
	 * per-backend.
	 *
	 * `dryRun` computes the type breakdown without writing (the preview a `ConfirmModal`
	 * shows); the live run skips that extra query — nothing downstream reads `byType`
	 * after execution, only `requeued`/`skipped` totals — and reports the actual
	 * `UPDATE`'s row count as `requeued`.
	 */
	requeueServiceOutageFailures(dryRun: boolean): { total: number; byType: Record<string, number>; requeued: number } {
		if (!this.dbStore) return { total: 0, byType: {}, requeued: 0 };
		const total = this.dbStore.count('failed');
		if (dryRun) {
			const byType = this.dbStore.serviceOutageFailedByType();
			const requeued = Object.values(byType).reduce((sum, n) => sum + n, 0);
			return { total, byType, requeued };
		}
		return { total, byType: {}, requeued: this.dbStore.requeueServiceOutageFailed() };
	}

	getConfig(type: JobType): JobTypeConfig {
		return this.configs.get(type) ?? DEFAULT_JOB_TYPE_CONFIG;
	}

	getGate(type: JobType): MinIntervalGate {
		let gate = this.gates.get(type);
		if (!gate) {
			gate = new MinIntervalGate(this.getConfig(type).minIntervalMs);
			this.gates.set(type, gate);
		}
		return gate;
	}

	jobTypes(): JobType[] {
		return Array.from(this.backends.keys());
	}

	// True when the type drains even with its per-type auto-run toggle off — read from
	// the backend (which reads it from `JobTypeConfig.drainsWithoutAutorun`) rather than
	// from the config map, so the autorunner asks exactly what the drain honors.
	drainsWithoutAutorun(type: JobType): boolean {
		return this.backends.get(type)?.drainsWithoutAutorun ?? false;
	}

	// ---- Auto-ENQUEUE sources -------------------------------------------------------

	/**
	 * Registers (or clears, with `null`) the candidate source for a type.
	 *
	 * Auto-ENQUEUE, never auto-run: whether the source may create jobs is this flag,
	 * whether those jobs then execute is the type's own auto-run gate. Keeping the two
	 * separate is a standing rule for any queued job type, and it is what makes
	 * "auto-enqueue on, auto-run off" a coherent (and used) configuration.
	 */
	setAutoSource(type: JobType, fn: AutoSourceFn | null): void {
		if (fn) this.autoSources.set(type, fn);
		else this.autoSources.delete(type);
	}

	setAutoSourceEnabled(type: JobType, enabled: boolean): void {
		if (enabled) this.autoSourceEnabled.add(type);
		else this.autoSourceEnabled.delete(type);
	}

	isAutoSourceEnabled(type: JobType): boolean {
		return this.autoSourceEnabled.has(type);
	}

	/**
	 * Pulls this type's auto-source candidates into the queue. The drain calls it when
	 * a type reports empty, which is exactly where `MemoryJobQueue.refill` used to sit.
	 *
	 * Two skips, both load-bearing:
	 *
	 *  * **Already active.** Handled for free by the backend's own dedupe — a seed whose
	 *    key matches a queued/running job collapses onto it rather than inserting.
	 *  * **Recently settled.** A job that just finished (or was *cancelled*) must not be
	 *    re-offered immediately, or an enabled source re-adds the item on the very next
	 *    refill and the user's Cancel looks ignored. `MemoryJobQueue` got this from
	 *    "refill skips any key tracked in any state" plus a retention sweep; the durable
	 *    equivalent is one indexed query for the keys settled inside the type's
	 *    `terminalRetentionMs` window. It expires by itself, exactly as before.
	 */
	async refill(type: JobType): Promise<void> {
		if (!this.autoSourceEnabled.has(type)) return;
		const source = this.autoSources.get(type);
		const store = this.dbStore;
		if (!source || !store) return;
		const config = this.getConfig(type);
		const windowMs = config.terminalRetentionMs ?? DEFAULT_AUTO_SOURCE_SUPPRESSION_MS;
		const suppressed = store.settledDedupeKeysSince(Date.now() - windowMs);
		for (const seed of source()) {
			const key = config.dedupeKey ? config.dedupeKey(seed.params) : '';
			if (!key) continue;
			// The stored form is type-namespaced — see `DbJobBackend.dedupeKeyFor`.
			if (suppressed.has(`${type}::${key}`)) continue;
			await this.enqueue(type, seed.params, { lane: seed.lane ?? 'background' });
		}
	}

	/**
	 * Turns the auto-source off for a type because a job failed for a reason that makes
	 * every other candidate hopeless too (today: a missing API credential). Called from
	 * the settle path rather than inferred from error text — `MemoryJobBackend` gated on
	 * the typed `failureReason` for exactly this reason, so a transient 403 whose
	 * message happens to mention "API key" can never latch the source off.
	 */
	disableAutoSource(type: JobType): void {
		this.autoSourceEnabled.delete(type);
	}

	// True while THIS process is executing a run for `key` of `type`.
	isRunning(type: JobType, key: string): boolean {
		return this.backends.get(type)?.isRunning(key) ?? false;
	}

	/**
	 * May the drain claim a job of this type right now, as far as its declared service
	 * dependencies are concerned?
	 *
	 * Three deliberate properties:
	 *
	 *  * **No declaration means yes.** Vault-local types are unaffected by any outage.
	 *  * **All-or-nothing.** A type needing two services must not run on one, so a
	 *    partially-recovered dependency set answers `false` and any probe token taken
	 *    along the way is handed straight back — stranding one service half-open with
	 *    a token nobody will report on is how a recovery wedges.
	 *  * **`acquireProbe` splits the two callers.** The autorunner's *kick* asks "could
	 *    this type run?" and must not consume the single-flight probe token, because
	 *    the worker it is about to start would then find the token already gone and
	 *    exit without claiming anything. The worker's own pre-claim check is the one
	 *    that consumes it.
	 */
	servicesHealthyFor(type: JobType, options: { acquireProbe?: boolean } = {}): boolean {
		const services = this.getConfig(type).services;
		if (!services || services.length === 0) return true;
		const registry = this.plugin.serviceHealth;
		if (!registry) return true;

		const needProbe: ServiceId[] = [];
		for (const service of services) {
			if (registry.isHealthy(service)) continue;
			if (registry.isHalfOpen(service)) {
				needProbe.push(service);
				continue;
			}
			return false;
		}
		if (needProbe.length === 0) return true;
		if (options.acquireProbe === false) {
			// Non-consuming: a half-open service with its token still free is drainable.
			return needProbe.every(service => !registry.snapshotFor(service).probeInFlight);
		}
		const taken: ServiceId[] = [];
		for (const service of needProbe) {
			if (registry.tryAcquireProbe(service)) {
				taken.push(service);
				continue;
			}
			for (const held of taken) registry.releaseProbe(held);
			return false;
		}
		return true;
	}

	// Every registered type that declares `service` as a dependency — how a breaker
	// transition resolves which drains to kick.
	typesDependingOn(service: ServiceId): JobType[] {
		return this.jobTypes().filter(type => this.getConfig(type).services?.includes(service));
	}

	/**
	 * Hands back a half-open probe token this type's worker acquired but never resolved.
	 *
	 * `servicesHealthyFor(type)` (the consuming form) is called immediately before a
	 * claim; ordinarily the claimed job's own outcome reports a verdict to the registry
	 * — `reportSuccess`/`reportFailure` — which itself clears the token. But three
	 * things can happen between acquiring the token and a verdict landing: the claim
	 * finds nothing (`'empty'`), the type turns out to be disabled (`'disabled'`), or
	 * the job settles at the JOB level — a deferral or failure with no `serviceUnhealthy`
	 * — which says nothing about the service at all. None of those touch the registry,
	 * so without this the token strands until `ServiceHealthRegistry.tick`'s 5-minute
	 * stale reclaim, during which the non-consuming kick check
	 * (`servicesHealthyFor(type, { acquireProbe: false })`) sees `probeInFlight` still
	 * true and refuses to even start a drain — a false wedge that looks exactly like the
	 * outage it was trying to test.
	 *
	 * Safe by construction: single-flight probe acquisition means the token released
	 * here, if any, is the one THIS worker took immediately before its claim. Calling it
	 * after a real verdict already landed (a success closed the breaker, a service
	 * failure re-opened it) is a harmless no-op — `isHalfOpen` is false either way.
	 */
	releaseProbesFor(type: JobType): void {
		const services = this.getConfig(type).services;
		if (!services || services.length === 0) return;
		const registry = this.plugin.serviceHealth;
		if (!registry) return;
		for (const service of services) {
			if (registry.isHalfOpen(service) && registry.snapshotFor(service).probeInFlight) {
				registry.releaseProbe(service);
			}
		}
	}

	enqueue(type: JobType, params?: Record<string, unknown>, options?: OrchestrationEnqueueOptions): Promise<OrchestrationJob | null> {
		const backend = this.backends.get(type);
		return backend ? backend.enqueue(params ?? {}, options) : Promise.resolve(null);
	}

	// Manual "Run next": execute a single job of whichever type has one queued,
	// regardless of which type it belongs to. Types that drain without the autorun gate
	// (enrichment) are skipped: they are already draining on their own, so spending the
	// user's one explicit "Run next" on one of them would answer a different question
	// than the one asked.
	async runNext(): Promise<void> {
		if (!this.plugin.settings.orchestrationEnabled) {
			new Notice('Orchestrate: disabled in settings.');
			return;
		}
		for (const backend of this.backends.values()) {
			if (backend.drainsWithoutAutorun) continue;
			// 'blocked' means a job WAS claimed and came back service-deferred, so this
			// manual run is answered — reporting "nothing to run" would be a lie about a
			// job the user can still see in the queue.
			const outcome = await backend.runNext();
			if (outcome === 'ran' || outcome === 'blocked') return;
		}
		new Notice('Orchestrate: nothing to run.');
	}

	// Runs at most one job of the given type and reports the outcome. The unified
	// runner calls this per worker.
	runNextOfType(type: JobType): Promise<RunOutcome> {
		const backend = this.backends.get(type);
		return backend ? backend.runNext() : Promise.resolve('empty');
	}

	// Manual per-job Run: run one specific queued job (by key) of the given type,
	// bypassing the auto-run gate. `empty` if it isn't claimable.
	runJob(type: JobType, key: string): Promise<RunOutcome> {
		const backend = this.backends.get(type);
		return backend ? backend.runJob(key) : Promise.resolve('empty');
	}

	// Cooperative cancellation of one running job, mirroring runJob's dispatch. The
	// promise resolves once the run has settled, so a caller can distinguish "stopped"
	// from "finished before it could be stopped" instead of guessing.
	cancelJob(type: JobType, key: string): Promise<CancelJobOutcome> {
		const backend = this.backends.get(type);
		return backend ? backend.cancelJob(key) : Promise.resolve<CancelJobOutcome>('not-running');
	}

	// True while a cancelled run of `type` is still settling.
	isCancelling(type: JobType, key: string): boolean {
		return this.backends.get(type)?.isCancelling(key) ?? false;
	}

	// Removes one queued (not running) job, mirroring runJob's dispatch. `'failed'`
	// means the store refused the write and the job is still queued, so no caller may
	// report it cancelled — or report it missing.
	async removeQueuedJob(type: JobType, key: string): Promise<RemoveQueuedOutcome> {
		const backend = this.backends.get(type);
		if (!backend) return 'not-queued';
		const outcome = await backend.removeQueued(key);
		if (outcome === 'removed') await emitQueueChanged(this.plugin, this.queueCountsProvider());
		return outcome;
	}

	// Removes every queued job — of one type, or of all types when `type` is omitted.
	// Running jobs are untouched.
	//
	// The emit is here, once, rather than in the backends: `orchestration-queue-updated`
	// costs every listener a full listFolder re-read plus a kickAll(), so clearing a
	// 400-job rebuild queue through a per-item emit would be 400 of each for one click.
	async clearQueued(type?: JobType): Promise<number> {
		const backends = type
			? [this.backends.get(type)].filter((b): b is JobBackend => !!b)
			: Array.from(this.backends.values());
		let cleared = 0;
		for (const backend of backends) cleared += await backend.clearQueued();
		if (cleared > 0) await emitQueueChanged(this.plugin, this.queueCountsProvider());
		return cleared;
	}

	hasPending(type: JobType): boolean {
		return this.backends.get(type)?.hasPending() ?? false;
	}

	/**
	 * The maintenance pass: recover, prune, report.
	 *
	 * Post-cutover this is three indexed statements and five `COUNT(*)`s, where the
	 * file-queue version listed two folders' worth of markdown, re-homed jobs whose type
	 * had changed persistence, and ran two repair loops with an event-loop yield every
	 * 20 entries. Two of those are gone because they are *unrepresentable*, not because
	 * they were dropped: re-homing existed to rescue jobs stranded by a file→memory type
	 * flip (there is one persistence kind now), and the aborted-claim recovery existed
	 * because `JobStore.move` could rename a file and then fail to write its status (a
	 * claim is one guarded UPDATE now — it applies or it doesn't).
	 *
	 * The counts keep their `ScanReport` field names and now report bucket counts from
	 * the DB; `inbox` is the queued bucket, which is what it always meant.
	 */
	async scan(options: { notify?: boolean } = {}): Promise<ScanReport> {
		const recovered = this.recoverStaleDbJobs();
		const pruned = this.pruneTerminalDbJobs();
		const store = this.dbStore;

		const report: ScanReport = {
			inbox: store?.count('queued') ?? 0,
			running: store?.count('running') ?? 0,
			done: store?.count('done') ?? 0,
			failed: store?.count('failed') ?? 0,
			cancelled: store?.count('cancelled') ?? 0,
			recovered,
			pruned,
		};

		const summary =
			`Orchestrate: inbox ${report.inbox}, running ${report.running}, done ${report.done}, failed ${report.failed}` +
			(report.cancelled > 0 ? `, cancelled ${report.cancelled}` : '') +
			(recovered > 0 ? `, recovered ${recovered}` : '') +
			(pruned > 0 ? `, pruned ${pruned}` : '');
		if (options.notify ?? true) new Notice(summary);
		return report;
	}

}
