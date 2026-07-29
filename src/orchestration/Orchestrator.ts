import { Notice } from 'obsidian';
import { JobStore } from './JobStore';
import { JobType, OrchestrationEnqueueOptions, OrchestrationJob, ScanReport } from './types';
import { Workflow } from './workflows/Workflow';
import { JobTypeConfig, DEFAULT_JOB_TYPE_CONFIG } from './jobTypeConfig';
import { MemoryJobQueue } from './MemoryJobQueue';
import { MinIntervalGate } from './utils/rateLimit';
import { JobBackend, RunOutcome, emitQueueChanged, resolveTimeoutMs } from './JobBackend';
import type { ServiceId } from './serviceHealth';
import type { CancelJobOutcome, RemoveQueuedOutcome } from './cancellation';
import { FileJobBackend } from './FileJobBackend';
import { MemoryJobBackend } from './MemoryJobBackend';
import { logError } from '../log';
import type CruciblePlugin from '../main';

// Backstop for jobs that slipped the per-job timeout entirely — e.g. a plugin
// reload mid-run leaves a job stranded in the running folder. `scan()` re-queues
// these. The autorun timeout (orchestrationAutorunTimeoutSeconds) is the primary
// mechanism; this only catches what no live timer could.
const STALE_RUNNING_MS = 60 * 60 * 1000;
const STALE_RUNNING_TIMEOUT_BUFFER_MS = 30_000;

export type { RunOutcome };

export function staleRunningMsForTimeout(timeoutMs: number): number {
	return timeoutMs > 0 ? timeoutMs + STALE_RUNNING_TIMEOUT_BUFFER_MS : STALE_RUNNING_MS;
}

// Mirrors failedJobRepair.ts's yieldToEventLoop: lets a long recovery sweep interleave
// with the rest of the event loop rather than blocking it start-to-finish.
function yieldToEventLoop(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
}

export class Orchestrator {
	private configs: Map<JobType, JobTypeConfig> = new Map();
	private gates: Map<JobType, MinIntervalGate> = new Map();
	private backends: Map<JobType, JobBackend> = new Map();

	constructor(private plugin: CruciblePlugin, private store: JobStore) {}

	register(type: JobType, workflow: Workflow, config: JobTypeConfig = DEFAULT_JOB_TYPE_CONFIG): void {
		this.configs.set(type, config);
		this.gates.set(type, new MinIntervalGate(config.minIntervalMs));
		const backend: JobBackend = config.persistence === 'memory'
			? new MemoryJobBackend(this.plugin, type, config, workflow)
			: new FileJobBackend(this.plugin, this.store, type, config, workflow);
		this.backends.set(type, backend);
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

	getMemoryQueue(type: JobType): MemoryJobQueue | null {
		const backend = this.backends.get(type);
		return backend instanceof MemoryJobBackend ? backend.getQueue() : null;
	}

	jobTypes(): JobType[] {
		return Array.from(this.backends.keys());
	}

	// True when the type drains even with the autorun toggle off (memory types).
	drainsWithoutAutorun(type: JobType): boolean {
		return this.backends.get(type)?.drainsWithoutAutorun ?? false;
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

	// Manual "Run next": execute a single file-backed job of whichever type has one
	// queued, regardless of which type it belongs to.
	async runNext(): Promise<void> {
		if (!this.plugin.settings.orchestrationEnabled) {
			new Notice('Orchestrate: disabled in settings.');
			return;
		}
		for (const backend of this.backends.values()) {
			if (backend.drainsWithoutAutorun) continue; // skip memory types here
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
	// means the job is still queued (JobStore.move rolled back), so no caller may
	// report it cancelled — or report it missing.
	async removeQueuedJob(type: JobType, key: string): Promise<RemoveQueuedOutcome> {
		const backend = this.backends.get(type);
		if (!backend) return 'not-queued';
		const outcome = await backend.removeQueued(key);
		if (outcome === 'removed') await emitQueueChanged(this.plugin, this.store);
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
		if (cleared > 0) await emitQueueChanged(this.plugin, this.store);
		return cleared;
	}

	hasPending(type: JobType): boolean {
		return this.backends.get(type)?.hasPending() ?? false;
	}

	refillMemory(type: JobType): void {
		this.backends.get(type)?.refill();
	}

	async scan(options: { notify?: boolean } = {}): Promise<ScanReport> {
		await this.store.ensureFolders();

		// Only queued/running need their job data read — the repair loops below act on
		// them. done/failed/cancelled are needed only as counts for the report, so their
		// reads are deferred past the repair loops and taken via countFolder (see below):
		// those buckets can run into the tens of thousands, and listFolder's per-entry
		// readJob would otherwise cost ~21k needless frontmatter reads on every scan.
		const queued = await this.store.listFolder('queued');
		const running = await this.store.listFolder('running');

		// Re-home file-backed jobs whose type has since become memory-persistence
		// (e.g. youtube_metadata_fetch after it folded into the unified in-memory
		// queue). The file path can never drain them — the memory backend never
		// claims their folders, and stale recovery only bounces running→queued, so
		// such a job would sit forever. Push its params into the memory queue (which
		// drains immediately) and archive the markdown file under done/.
		const migratedPaths = new Set<string>();
		let migrated = 0;
		for (const entry of [...queued, ...running]) {
			if (this.getConfig(entry.job.type).persistence !== 'memory') continue;
			// Never re-home a job this process is executing — its own execute() is about
			// to move the file, and racing that would both lose the settle and leave a
			// duplicate of the job in the memory queue.
			if (this.isRunning(entry.job.type, entry.job.id)) continue;
			await this.backends.get(entry.job.type)?.enqueue(entry.job.params ?? {});
			await this.store.appendNotes(entry.file, 'Re-homed to the in-memory queue (type is now memory-persistence).');
			await this.store.move(entry.file, entry.job, 'done');
			migratedPaths.add(entry.file.path);
			migrated++;
		}

		// State-gated recovery, ahead of the time-based sweep below: a running/ entry
		// whose frontmatter still says `status: 'queued'` never had its claim-time
		// frontmatter write land (the JobStore.move claim-path fault — see JobStore.ts)
		// or otherwise aborted mid-claim. The folder says "claimed"; the status says
		// "never claimed" — that disagreement is itself proof the claim aborted, so this
		// bounces the job back to queued/ with no age check at all (unlike the time-based
		// sweep, an un-updated status can't be "still genuinely running").
		let recovered = 0;
		const stateRecoveredPaths = new Set<string>();
		let processed = 0;
		for (const entry of running) {
			if (migratedPaths.has(entry.file.path)) continue;
			if (entry.job.status !== 'queued') continue;
			if (this.isRunning(entry.job.type, entry.job.id)) continue;
			try {
				await this.store.setError(entry.file, 'Recovered: aborted claim');
				await this.store.move(entry.file, entry.job, 'queued');
				stateRecoveredPaths.add(entry.file.path);
				recovered++;
			} catch (err) {
				// One job the store refused to move must not abort the sweep for the rest —
				// leave it in running/ (JobStore.move rolls its own rename back on failure)
				// and let the next scan retry it.
				logError(`Orchestrator.scan: could not recover aborted-claim job ${entry.job.id}`, err);
			}
			processed++;
			if (processed % 20 === 0) await yieldToEventLoop();
		}

		const now = Date.now();
		for (const entry of running) {
			if (migratedPaths.has(entry.file.path)) continue;
			if (stateRecoveredPaths.has(entry.file.path)) continue;
			// The sweep's whole premise is "no live timer owns this job". A run registered
			// in this process is the counter-example, so it wins over recovery — whether it
			// is winding down from a cancel (still in running/ until execute() moves it) or
			// simply taking longer than the stale cutoff, which a long search batch or a
			// slow LLM step genuinely can. Bouncing either running → queued duplicates the
			// job: the original keeps executing while a worker claims and runs the copy.
			// `isRunning` subsumes the older `isCancelling` check.
			if (this.isRunning(entry.job.type, entry.job.id)) continue;
			const updatedRaw = entry.job.updated ?? entry.job.created;
			const updatedAt = Date.parse(updatedRaw);
			const cutoff = now - staleRunningMsForTimeout(resolveTimeoutMs(this.plugin, this.getConfig(entry.job.type)));
			if (Number.isFinite(updatedAt) && updatedAt < cutoff) {
				await this.store.setError(entry.file, `Recovered: stale running job (last updated ${updatedRaw})`);
				await this.store.move(entry.file, entry.job, 'queued');
				recovered++;
			}
		}

		// Deferred until after the repair loops above (see the comment at the top of this
		// method): a plain folder-children count, no per-file frontmatter reads.
		const done = this.store.countFolder('done');
		const failed = this.store.countFolder('failed');
		const cancelled = this.store.countFolder('cancelled');

		const queuedMigrated = queued.filter(e => migratedPaths.has(e.file.path)).length;
		const runningMigrated = running.filter(e => migratedPaths.has(e.file.path)).length;
		const report: ScanReport = {
			inbox: queued.length - queuedMigrated,
			running: running.length - recovered - runningMigrated,
			done: done + migrated,
			failed,
			cancelled,
			recovered,
		};

		const summary =
			`Orchestrate: inbox ${report.inbox}, running ${report.running}, done ${report.done}, failed ${report.failed}` +
			(report.cancelled > 0 ? `, cancelled ${report.cancelled}` : '') +
			(recovered > 0 ? `, recovered ${recovered}` : '') +
			(migrated > 0 ? `, re-homed ${migrated}` : '');
		if (options.notify ?? true) new Notice(summary);
		return report;
	}

}
