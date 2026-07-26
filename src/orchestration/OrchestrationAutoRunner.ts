import type CruciblePlugin from '../main';
import type { Orchestrator } from './Orchestrator';
import type { JobType, OrchestrationEnqueueOptions, OrchestrationJob } from './types';
import type { CancelJobOutcome, StopJobOutcome } from './cancellation';
import type { RunOutcome } from './JobBackend';
import { Semaphore } from './utils/semaphore';
import { computeShouldDrain, readTypeAutorun, readTypeMinIntervalOverride, resolveMaxParallel } from './autorunGate';

const INITIAL_FILE_DRAIN_DELAY_MS = 5000;

/**
 * The guaranteed wake.
 *
 * Recovery used to hang on `FileJobBackend.scheduleRetryWake` — ONE `setTimeout` per
 * backend that every new deferral *replaced*, firing a kick through an optional chain
 * (`plugin.orchestrationAutoRunner?.kickDrainType`). Lose that timer (a later deferral
 * with a longer delay overwrites it, the optional chain is nullish during teardown, a
 * reload drops it entirely) and the queue simply stops: work sits deferred with
 * nothing scheduled to look at it again.
 *
 * This interval is the backstop that makes that failure mode uninteresting. It ticks
 * the breaker (open windows elapse into half-open) and kicks every type, so the worst
 * case for any stall is one minute rather than forever. It is a *backstop*, not the
 * primary path — transitions still kick dependent types immediately.
 */
export const SERVICE_HEALTH_TICK_MS = 60_000;

// Drains the unified queue per job type. Each type runs up to its configured
// `maxParallel` workers, each spaced by the type's shared MinIntervalGate, with a
// global Semaphore bounding total in-flight jobs across all types. Every type
// auto-drains only when the queue-wide Enabled switch is on and the type's own
// per-type auto-run flag is set; memory types (folded enrichment) additionally kick
// their own drains on queue changes. See autorunGate.ts for the gate model.
export class OrchestrationAutoRunner {
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
	private unsubscribeHealth: (() => void) | null = null;
	private healthTimer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly plugin: CruciblePlugin, private readonly orchestrator: Orchestrator) {
		this.globalSem = new Semaphore(() => Math.max(1, plugin.settings.orchestrationMaxConcurrent || 1));
		const bus = plugin.ingestionEvents;
		if (bus) {
			this.unsubscribe = bus.on('orchestration-queue-updated', () => this.kickAll());
		}
		// Subscribed in the constructor, not wired up by a caller: the runner is the only
		// thing that can act on a recovery, so it must not be possible to construct one
		// that isn't listening.
		const health = plugin.serviceHealth;
		if (health) {
			this.unsubscribeHealth = health.onTransition(transition => {
				// Only recoveries are actionable. An `open` transition needs no kick — the
				// drain is already refusing to claim.
				if (transition.to === 'open') return;
				for (const type of this.orchestrator.typesDependingOn(transition.service)) {
					this.kickDrainType(type);
				}
			});
			this.healthTimer = setInterval(() => {
				if (this.disposed) return;
				health.tick();
				this.kickAll();
			}, SERVICE_HEALTH_TICK_MS);
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
		this.unsubscribeHealth?.();
		this.unsubscribeHealth = null;
		if (this.healthTimer !== null) clearInterval(this.healthTimer);
		this.healthTimer = null;
	}

	// Manual "Run next": execute a single file-backed job regardless of autorun.
	async runOnce(): Promise<void> {
		if (this.disposed) return;
		await this.orchestrator.runNext();
	}

	// Manual "Run" of one specific queued job, ignoring the auto-run gate: claims and
	// runs exactly the job identified by `key` (file job id / memory entry key),
	// reusing the backend claim guards so it can't double-run a job a drain already
	// took. Bounded by the global semaphore; no per-type pacing (one-shot user intent).
	async runJob(type: JobType, key: string): Promise<RunOutcome> {
		if (this.disposed) return 'empty';
		await this.globalSem.acquire();
		try {
			return await this.orchestrator.runJob(type, key);
		} finally {
			this.globalSem.release();
		}
	}

	// Cancel one running job. Deliberately *not* gated on `disposed` and deliberately
	// not taking a global semaphore slot: cancelling is a signal, not work, and the
	// moment the runner is being torn down is precisely when a caller most wants an
	// in-flight job told to stop. Resolves once the run has settled.
	cancelJob(type: JobType, key: string): Promise<CancelJobOutcome> {
		return this.orchestrator.cancelJob(type, key);
	}

	// THE Cancel verb the UI calls: one action over the queue's two mechanisms.
	//
	// Order is not arbitrary. Abort first — `cancelJob` answers 'not-running'
	// immediately for anything that isn't executing, so trying it costs nothing and
	// asking removal first could delete a job the drain has already started. Then
	// removal, which answers `false` for a job that is running. Exactly one of the two
	// can succeed for a given key.
	//
	// The second `cancelJob` covers the one real race: a drain claiming the job in the
	// window between the two calls. Without it that job reports 'not-found' — "there's
	// nothing there" — about a job the user can still see running in the table.
	async stopJob(type: JobType, key: string): Promise<StopJobOutcome> {
		const running = await this.orchestrator.cancelJob(type, key);
		if (running !== 'not-running') return running;
		const removal = await this.orchestrator.removeQueuedJob(type, key);
		if (removal !== 'not-queued') return removal === 'removed' ? 'removed' : 'failed';
		const claimedMeanwhile = await this.orchestrator.cancelJob(type, key);
		return claimedMeanwhile === 'not-running' ? 'not-found' : claimedMeanwhile;
	}

	// Bulk clear of queued work (all types, or one). Like cancelJob, deliberately not
	// gated on `disposed` and taking no semaphore slot: emptying a queue is a signal,
	// not work, and teardown is a moment a caller may well want it.
	clearQueued(type?: JobType): Promise<number> {
		return this.orchestrator.clearQueued(type);
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
		// Non-consuming: starting a drain must not eat the single half-open probe token
		// that the worker it is about to start needs in order to claim anything.
		if (!this.orchestrator.servicesHealthyFor(type, { acquireProbe: false })) return;
		// Already draining (auto or manual): record the kick so it replays after the
		// current drain ends.
		if (this.draining.has(type)) {
			this.redrainRequested.add(type);
			return;
		}
		void this.drainType(type, 'auto');
	}

	// The auto-run gate: every type drains only when the queue-wide Enabled switch is
	// on and the type's own per-type auto-run flag is set (memory types don't wait on
	// the initial file-drain delay).
	private shouldDrain(type: JobType): boolean {
		return computeShouldDrain({
			queueEnabled: this.plugin.settings.orchestrationQueueEnabled !== false,
			drainsWithoutAutorun: this.orchestrator.drainsWithoutAutorun(type),
			typeAutorun: readTypeAutorun(this.plugin.settings.orchestrationJobTypeControls, type),
			fileDrainReady: this.fileDrainReady,
		});
	}

	private async drainType(type: JobType, mode: 'auto' | 'manual'): Promise<void> {
		this.draining.set(type, mode);
		try {
			// Read live, exactly like the per-type rate override below: a settings change
			// takes effect on the next drain without re-registering anything. A type that
			// declares itself serial (maxParallelFixed) ignores the override — see
			// resolveMaxParallel, which the Queue Configuration table also reads, so the
			// number displayed is by construction the number used.
			const workerCount = resolveMaxParallel(
				this.orchestrator.getConfig(type), this.plugin.settings.orchestrationJobTypeControls, type,
			);
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
			const manual = this.draining.get(type) === 'manual';
			if (!manual && !this.shouldDrain(type)) return;
			const config = this.orchestrator.getConfig(type);

			// The breaker, checked per claim rather than once per drain: the FIRST job of an
			// outage is always claimed before anyone knows the service is down, and it is
			// that job coming back 'blocked' that opens the breaker. Re-asking here is what
			// stops the second one. A manual drain is exempt — a user's click is intent, and
			// doubles as a probe. This is also the call that CONSUMES a half-open probe
			// token, which is why it sits immediately before the claim.
			if (!manual && !this.orchestrator.servicesHealthyFor(type)) return;

			// Memory types know precisely when they are empty (and can refill); file
			// types report "maybe" (hasPending === true), so this block is a no-op for
			// them and the actual emptiness check is the claim inside runNextOfType.
			if (!this.orchestrator.hasPending(type)) {
				this.orchestrator.refillMemory(type);
				if (!this.orchestrator.hasPending(type)) {
					// The servicesHealthyFor call above may have just acquired a half-open
					// probe token on the promise of a claim that turned out not to exist — no
					// job ran, so no verdict will ever reach the registry for it. Hand it back
					// rather than let it strand until the 5-minute stale reclaim. `manual`
					// guard: a manual drain never acquired a token here (see above), so it must
					// not release one a concurrent auto-drain of a DIFFERENT type sharing this
					// service is legitimately still holding.
					if (!manual) this.orchestrator.releaseProbesFor(type);
					return;
				}
			}

			// Pace per-type before taking a global slot, so a worker sleeping out its
			// cooloff does not occupy global concurrency that another type could use.
			// A per-type settings override (Queue Monitor rate limit) wins over the
			// type's configured cooloff.
			gate.setIntervalMs(readTypeMinIntervalOverride(this.plugin.settings.orchestrationJobTypeControls, type) ?? config.minIntervalMs);
			await gate.wait();

			await this.globalSem.acquire();
			let outcome: RunOutcome;
			try {
				outcome = await this.orchestrator.runNextOfType(type);
			} finally {
				this.globalSem.release();
			}
			// The claim may have settled with no verdict reaching the registry — 'empty'
			// (nothing there to claim), 'disabled', or a job-level defer/fail/cancel (no
			// `serviceUnhealthy`, which says nothing about the service). 'blocked' and a
			// successful 'ran' both already resolved any token via reportFailure/
			// reportSuccess, so this is a harmless no-op for them — see
			// Orchestrator.releaseProbesFor.
			if (!manual) this.orchestrator.releaseProbesFor(type);
			// Only a successful run keeps the worker going; 'empty' (nothing claimable,
			// possibly because a peer took the last job), 'disabled', and 'blocked' (the
			// job deferred because a dependency is down — the whole queue behind it would
			// defer identically) all end it.
			if (outcome !== 'ran') return;
		}
	}
}
