import type CruciblePlugin from '../main';
import type { Orchestrator } from './Orchestrator';
import type { JobType } from './types';
import { Semaphore } from './utils/semaphore';

// Drains the unified queue per job type. Each type runs up to its configured
// `maxParallel` workers, each spaced by the type's shared MinIntervalGate, with a
// global Semaphore bounding total in-flight jobs across all types. File-backed
// types only drain while autorun is enabled; memory types (folded enrichment)
// always drain, kicked by their own queue changes.
export class OrchestrationAutoRunner {
	private enabled: boolean;
	private disposed = false;
	private unsubscribe: (() => void) | null = null;
	private readonly drainingTypes = new Set<JobType>();
	private readonly globalSem: Semaphore;

	constructor(private readonly plugin: CruciblePlugin, private readonly orchestrator: Orchestrator) {
		this.enabled = plugin.settings.orchestrationQueueAutorunEnabled === true;
		this.globalSem = new Semaphore(() => Math.max(1, plugin.settings.orchestrationMaxConcurrent || 1));
		const bus = plugin.ingestionEvents;
		if (bus) {
			this.unsubscribe = bus.on('orchestration-queue-updated', () => this.kickAll());
		}
		this.kickAll();
	}

	dispose(): void {
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (enabled) this.kickAll();
	}

	// Manual "Run next": execute a single file-backed job regardless of autorun.
	async runOnce(): Promise<void> {
		if (this.disposed) return;
		await this.orchestrator.runNext();
	}

	kickAll(): void {
		for (const type of this.orchestrator.jobTypes()) this.kickDrainType(type);
	}

	kickDrainType(type: JobType): void {
		if (this.disposed) return;
		const config = this.orchestrator.getConfig(type);
		// File types only drain under autorun; memory types always drain.
		if (config.persistence === 'file' && !this.enabled) return;
		if (this.drainingTypes.has(type)) return;
		void this.drainType(type);
	}

	private async drainType(type: JobType): Promise<void> {
		this.drainingTypes.add(type);
		try {
			const config = this.orchestrator.getConfig(type);
			const workerCount = Math.max(1, config.maxParallel);
			await Promise.all(Array.from({ length: workerCount }, () => this.typeWorker(type)));
		} finally {
			this.drainingTypes.delete(type);
		}
	}

	private async typeWorker(type: JobType): Promise<void> {
		const gate = this.orchestrator.getGate(type);
		for (;;) {
			if (this.disposed) return;
			const config = this.orchestrator.getConfig(type);
			if (config.persistence === 'file' && !this.enabled) return;

			// Memory types know precisely when they are empty (and can refill); file
			// types report "maybe", so the actual emptiness check is the claim below.
			if (config.persistence === 'memory' && !this.orchestrator.hasPending(type)) {
				this.orchestrator.refillMemory(type);
				if (!this.orchestrator.hasPending(type)) return;
			}

			// Pace per-type before taking a global slot, so a worker sleeping out its
			// cooloff does not occupy global concurrency that another type could use.
			gate.setIntervalMs(config.minIntervalMs);
			await gate.wait();

			await this.globalSem.acquire();
			let outcome: 'ran' | 'empty' | 'disabled';
			try {
				outcome = await this.orchestrator.runNextOfType(type);
			} finally {
				this.globalSem.release();
			}
			// Only a successful run keeps the worker going; 'empty' (nothing claimable,
			// possibly because a peer took the last job) and 'disabled' end it.
			if (outcome !== 'ran') return;
		}
	}
}
