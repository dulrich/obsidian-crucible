import type CruciblePlugin from '../main';
import type { Orchestrator } from './Orchestrator';
import type { JobType, OrchestrationEnqueueOptions, OrchestrationJob } from './types';
import { Semaphore } from './utils/semaphore';
import { computeShouldDrain, readTypeAutorun, readTypeMinIntervalOverride } from './autorunGate';

const INITIAL_FILE_DRAIN_DELAY_MS = 5000;

// Drains the unified queue per job type. Each type runs up to its configured
// `maxParallel` workers, each spaced by the type's shared MinIntervalGate, with a
// global Semaphore bounding total in-flight jobs across all types. File-backed
// types drain under the global Autorun toggle (modulo a per-type veto); memory
// types (folded enrichment) drain under their own per-type auto-run flag, kicked
// by their own queue changes. See autorunGate.ts for the gate model.
export class OrchestrationAutoRunner {
	private enabled: boolean;
	private disposed = false;
	private unsubscribe: (() => void) | null = null;
	// Types currently draining, and in which mode: 'manual' (Run next /
	// enqueue-and-run) ignores the auto-run gate. At most one drain runs per type,
	// so a kick that finds the type here defers instead of double-starting.
	private readonly draining = new Map<JobType, 'auto' | 'manual'>();
	// A kick that arrives while a type is mid-drain is recorded here instead of being
	// dropped, then replayed once the drain winds down — closes the lost-wakeup race
	// where a job enqueued during wind-down would wait for the next event.
	private readonly redrainRequested = new Set<JobType>();
	private readonly globalSem: Semaphore;
	private fileDrainReady = false;

	constructor(private readonly plugin: CruciblePlugin, private readonly orchestrator: Orchestrator) {
		this.enabled = plugin.settings.orchestrationQueueAutorunEnabled === true;
		this.globalSem = new Semaphore(() => Math.max(1, plugin.settings.orchestrationMaxConcurrent || 1));
		const bus = plugin.ingestionEvents;
		if (bus) {
			this.unsubscribe = bus.on('orchestration-queue-updated', () => this.kickAll());
		}
		plugin.app.workspace.onLayoutReady(() => {
			setTimeout(() => {
				if (this.disposed) return;
				this.fileDrainReady = true;
				this.kickAll();
			}, INITIAL_FILE_DRAIN_DELAY_MS);
		});
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
		if (enabled && this.fileDrainReady) this.kickAll();
	}

	// Manual "Run next": execute a single file-backed job regardless of autorun.
	async runOnce(): Promise<void> {
		if (this.disposed) return;
		await this.orchestrator.runNext();
	}

	// Manual drain of a single type, ignoring the auto-run gate: runs everything
	// currently queued for `type` (no auto-source refill happens when the type's
	// auto-run is off, so this drains only what is already enqueued). Used by the
	// enqueue-and-run buttons and the per-type "Run next" control so a job runs even
	// when both Auto toggles are off. No-op if the type is already draining.
	runType(type: JobType): void {
		if (this.disposed) return;
		if (this.draining.has(type)) return;
		if (!this.orchestrator.hasPending(type)) return;
		void this.drainType(type, 'manual');
	}

	// Central manual-kick for user-lane "Enqueue …" actions: enqueue the job, then
	// drain its type regardless of the auto-run gate (runType), so no call site has
	// to remember the kick as a separate ritual.
	async enqueueAndRun(
		type: JobType,
		params: Record<string, unknown>,
		options?: OrchestrationEnqueueOptions,
	): Promise<OrchestrationJob | null> {
		const job = await this.orchestrator.enqueue(type, params, options);
		if (job) this.runType(type);
		return job;
	}

	kickAll(): void {
		for (const type of this.orchestrator.jobTypes()) this.kickDrainType(type);
	}

	kickDrainType(type: JobType): void {
		if (this.disposed) return;
		if (!this.shouldDrain(type)) return;
		// Already draining (auto or manual): record the kick so it replays after the
		// current drain ends.
		if (this.draining.has(type)) {
			this.redrainRequested.add(type);
			return;
		}
		void this.drainType(type, 'auto');
	}

	// The auto-run gate: file types drain under the global Autorun toggle (unless
	// vetoed per-type); memory types drain only when their per-type auto-run is on.
	private shouldDrain(type: JobType): boolean {
		return computeShouldDrain({
			drainsWithoutAutorun: this.orchestrator.drainsWithoutAutorun(type),
			typeAutorun: readTypeAutorun(this.plugin.settings.orchestrationJobTypeControls, type),
			globalAutorunEnabled: this.enabled,
			fileDrainReady: this.fileDrainReady,
		});
	}

	private async drainType(type: JobType, mode: 'auto' | 'manual'): Promise<void> {
		this.draining.set(type, mode);
		try {
			const workerCount = Math.max(1, this.orchestrator.getConfig(type).maxParallel);
			await Promise.all(Array.from({ length: workerCount }, () => this.typeWorker(type)));
		} finally {
			this.draining.delete(type);
		}
		// Replay a kick that landed mid-drain so work enqueued during the wind-down
		// window isn't stranded until the next event.
		if (this.redrainRequested.delete(type) && !this.disposed && this.shouldDrain(type)) {
			this.kickDrainType(type);
		}
	}

	private async typeWorker(type: JobType): Promise<void> {
		const gate = this.orchestrator.getGate(type);
		for (;;) {
			if (this.disposed) return;
			// A manual drain ignores the auto-run gate but still stops when empty.
			if (this.draining.get(type) !== 'manual' && !this.shouldDrain(type)) return;
			const config = this.orchestrator.getConfig(type);

			// Memory types know precisely when they are empty (and can refill); file
			// types report "maybe" (hasPending === true), so this block is a no-op for
			// them and the actual emptiness check is the claim inside runNextOfType.
			if (!this.orchestrator.hasPending(type)) {
				this.orchestrator.refillMemory(type);
				if (!this.orchestrator.hasPending(type)) return;
			}

			// Pace per-type before taking a global slot, so a worker sleeping out its
			// cooloff does not occupy global concurrency that another type could use.
			// A per-type settings override (Queue Monitor rate limit) wins over the
			// type's configured cooloff.
			gate.setIntervalMs(readTypeMinIntervalOverride(this.plugin.settings.orchestrationJobTypeControls, type) ?? config.minIntervalMs);
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
