import { Notice } from 'obsidian';
import { JobStore } from './JobStore';
import { JobType, OrchestrationEnqueueOptions, OrchestrationJob, ScanReport } from './types';
import { Workflow } from './workflows/Workflow';
import { JobTypeConfig, DEFAULT_JOB_TYPE_CONFIG } from './jobTypeConfig';
import { MemoryJobQueue } from './MemoryJobQueue';
import { MinIntervalGate } from './utils/rateLimit';
import { JobBackend, RunOutcome, emitQueueChanged, resolveTimeoutMs } from './JobBackend';
import type { CancelJobOutcome, RemoveQueuedOutcome } from './cancellation';
import { FileJobBackend } from './FileJobBackend';
import { MemoryJobBackend } from './MemoryJobBackend';
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
			if (await backend.runNext() === 'ran') return;
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

		const queued = await this.store.listFolder('queued');
		const running = await this.store.listFolder('running');
		const done = await this.store.listFolder('done');
		const failed = await this.store.listFolder('failed');
		const cancelled = await this.store.listFolder('cancelled');

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
			// Never re-home a job this process is still winding down — its own execute()
			// is about to move the file, and racing that would lose the settle.
			if (this.isCancelling(entry.job.type, entry.job.id)) continue;
			await this.backends.get(entry.job.type)?.enqueue(entry.job.params ?? {});
			await this.store.appendNotes(entry.file, 'Re-homed to the in-memory queue (type is now memory-persistence).');
			await this.store.move(entry.file, entry.job, 'done');
			migratedPaths.add(entry.file.path);
			migrated++;
		}

		let recovered = 0;
		const now = Date.now();
		for (const entry of running) {
			if (migratedPaths.has(entry.file.path)) continue;
			// A cancelled job is still in running/ until its execute() finishes moving it
			// to cancelled/, and a long workflow's `updated` stamp can already be past the
			// stale cutoff by then. Bouncing it running → queued here would resurrect
			// exactly the work the user just stopped, so cancellation wins over recovery:
			// the run is alive, the sweep's premise ("no live timer owns this") is false.
			if (this.isCancelling(entry.job.type, entry.job.id)) continue;
			const updatedRaw = entry.job.updated ?? entry.job.created;
			const updatedAt = Date.parse(updatedRaw);
			const cutoff = now - staleRunningMsForTimeout(resolveTimeoutMs(this.plugin, this.getConfig(entry.job.type)));
			if (Number.isFinite(updatedAt) && updatedAt < cutoff) {
				await this.store.setError(entry.file, `Recovered: stale running job (last updated ${updatedRaw})`);
				await this.store.move(entry.file, entry.job, 'queued');
				recovered++;
			}
		}

		const queuedMigrated = queued.filter(e => migratedPaths.has(e.file.path)).length;
		const runningMigrated = running.filter(e => migratedPaths.has(e.file.path)).length;
		const report: ScanReport = {
			inbox: queued.length - queuedMigrated,
			running: running.length - recovered - runningMigrated,
			done: done.length + migrated,
			failed: failed.length,
			cancelled: cancelled.length,
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
