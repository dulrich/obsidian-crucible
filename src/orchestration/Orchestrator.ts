import { Notice } from 'obsidian';
import { JobStore } from './JobStore';
import { JobType, OrchestrationEnqueueOptions, OrchestrationJob, ScanReport } from './types';
import { Workflow } from './workflows/Workflow';
import { JobTypeConfig, DEFAULT_JOB_TYPE_CONFIG } from './jobTypeConfig';
import { MemoryJobQueue } from './MemoryJobQueue';
import { MinIntervalGate } from './utils/rateLimit';
import { JobBackend, RunOutcome, resolveTimeoutMs } from './JobBackend';
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
			recovered,
		};

		const summary =
			`Orchestrate: inbox ${report.inbox}, running ${report.running}, done ${report.done}, failed ${report.failed}` +
			(recovered > 0 ? `, recovered ${recovered}` : '') +
			(migrated > 0 ? `, re-homed ${migrated}` : '');
		if (options.notify ?? true) new Notice(summary);
		return report;
	}

}
