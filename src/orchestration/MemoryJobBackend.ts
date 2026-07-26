import { TFile } from 'obsidian';
import type CruciblePlugin from '../main';
import type { JobTypeConfig } from './jobTypeConfig';
import type { JobType, OrchestrationEnqueueOptions, OrchestrationJob, WorkflowResult } from './types';
import type { Workflow } from './workflows/Workflow';
import { JobBackend, RunOutcome, resolveTimeoutMs, runWorkflowWithTimeout } from './JobBackend';
import { CANCELLED_BEFORE_RUN, CancelJobOutcome, RemoveQueuedOutcome, RunSettlement, RunningJobRegistry } from './cancellation';
import { MemoryJobEntry, MemoryJobQueue } from './MemoryJobQueue';
import { defaultLaneForPriority } from './lanes';
import { logWarn } from '../log';

// Transient, in-memory job type (the folded enrichment queue): entries live in a
// MemoryJobQueue keyed by `dedupeKey`, drain immediately and independently of the
// autorun toggle, and forget terminal entries after a retention window. No vault
// files are written for the jobs themselves.
export class MemoryJobBackend implements JobBackend {
	readonly drainsWithoutAutorun = true;
	private readonly queue: MemoryJobQueue;
	// Keyed by memory entry key — the same key `runJob` takes.
	private readonly running = new RunningJobRegistry();

	constructor(
		private readonly plugin: CruciblePlugin,
		private readonly type: JobType,
		private readonly config: JobTypeConfig,
		private readonly workflow: Workflow,
	) {
		this.queue = new MemoryJobQueue(
			config.terminalRetentionMs ?? 60_000,
			(size) => {
				this.plugin.ingestionEvents?.emit('enrichment-queue-updated', { size });
				this.plugin.orchestrationAutoRunner?.kickDrainType(this.type);
			},
		);
		if (config.autoSource) this.queue.setAutoSource(config.autoSource);
	}

	// Exposed so the dashboard's EnrichmentQueueAdapter can read/seed the queue.
	getQueue(): MemoryJobQueue {
		return this.queue;
	}

	async enqueue(params: Record<string, unknown>, options: OrchestrationEnqueueOptions = {}): Promise<OrchestrationJob | null> {
		const key = this.config.dedupeKey ? this.config.dedupeKey(params) : '';
		if (!key) return null;
		const display = this.config.display ? this.config.display(params) : {};
		const lane = options.lane ?? defaultLaneForPriority(options.priority);
		if (!this.queue.enqueue(key, params, display, lane)) return null;
		return this.synthJob(key, params, lane);
	}

	async runNext(): Promise<RunOutcome> {
		const entry = this.queue.claimNext();
		if (!entry) return 'empty';
		return this.runEntry(entry);
	}

	// Manual per-job Run: claim the one pending entry by key and run it, bypassing the
	// gate. `empty` if it isn't pending (already running/gone).
	async runJob(key: string): Promise<RunOutcome> {
		const entry = this.queue.claimEntry(key);
		if (!entry) return 'empty';
		return this.runEntry(entry);
	}

	// Cancels the running entry with this key. A *pending* entry answers
	// 'not-running': dropping it from the queue is `removeQueued`, not an abort.
	cancelJob(key: string): Promise<CancelJobOutcome> {
		return this.running.cancel(key);
	}

	isCancelling(key: string): boolean {
		return this.running.isCancelling(key);
	}

	isRunning(key: string): boolean {
		return this.running.isRunning(key);
	}

	// The queued half of Cancel for a memory type: a pending entry is stopped by
	// marking it cancelled, which also keeps the auto-source from immediately
	// re-seeding the key (see MemoryJobQueue.cancelIfPending). There is no store to
	// refuse the write here, so this path never answers 'failed'.
	async removeQueued(key: string): Promise<RemoveQueuedOutcome> {
		return this.queue.cancelIfPending(key, CANCELLED_BEFORE_RUN) ? 'removed' : 'not-queued';
	}

	async clearQueued(): Promise<number> {
		return this.queue.clearPending(CANCELLED_BEFORE_RUN);
	}

	private async runEntry(entry: MemoryJobEntry): Promise<RunOutcome> {
		const job = this.synthJob(entry.key, entry.params, entry.lane);
		const run = this.running.begin(entry.key);
		let settlement: RunSettlement = 'completed';
		let outcome: RunOutcome = 'ran';
		try {
			const result = await runWorkflowWithTimeout(
				this.plugin, this.workflow, job, resolveTimeoutMs(this.plugin, this.config), run.signal,
			);
			if (result.status === 'cancelled') {
				settlement = 'cancelled';
				this.queue.markCancelled(entry.key, result.notes);
			} else if (result.status === 'deferred') {
				// The branch that did not exist: a deferred memory job used to fall through
				// to the `else` and be marked DONE, so the work silently never happened. It
				// goes back to pending instead, keeping its slot and its dedupe suppression.
				//
				// `'blocked'` is reserved for the SERVICE-level case, because that is the one
				// where continuing to claim is pointless for every other entry too. A
				// job-level deferral ends only that entry's turn; the queue's other entries
				// may well be fine, so the worker keeps going and the cooloff below (the same
				// `max(1s, retryAfterMs ?? 30s)` the file backend writes into `deferUntil`) is
				// what stops the released entry being re-claimed by the very drain that just
				// deferred it.
				const unhealthy = result.serviceUnhealthy;
				if (unhealthy) {
					this.plugin.serviceHealth?.reportFailure(unhealthy.service, unhealthy.kind, unhealthy.reason, result.retryAfterMs);
					outcome = 'blocked';
				}
				this.queue.releaseToPending(entry.key, Math.max(1000, result.retryAfterMs ?? 30_000));
			} else if (result.status === 'failed') {
				const error = result.error ?? 'Workflow returned failed status';
				this.queue.markFailed(entry.key, error);
				logWarn('job', this.type, entry.key, 'failed:', error);
				// Stop auto-refilling ONLY when the credential is genuinely missing, so the
				// queue does not hammer a hopeless request. Gated on the typed reason (not a
				// substring of `error`) so a transient/rejected API response — e.g. a 403
				// whose message mentions "API key" — never latches the auto-source off.
				if (result.failureReason === 'no-api-key') this.queue.setAutoSourceEnabled(false);
			} else {
				this.queue.markDone(entry.key);
				// The job finished, so every dependency it declared was alive — the half-open
				// probe's success path for memory types.
				const registry = this.plugin.serviceHealth;
				if (registry) for (const service of this.config.services ?? []) registry.reportSuccess(service);
				this.emitMetadataEnriched(entry.key, entry.params, result);
			}
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			this.queue.markFailed(entry.key, error);
			logWarn('job', this.type, entry.key, 'threw:', error);
		} finally {
			this.queue.sweepTerminal();
			// Settled last, so a caller awaiting cancelJob() observes the entry already
			// in its terminal state rather than racing the bookkeeping above.
			run.finish(settlement);
		}
		return outcome;
	}

	hasPending(): boolean {
		return this.queue.hasPending();
	}

	refill(): void {
		this.queue.refill();
	}

	private synthJob(key: string, params: Record<string, unknown>, lane = this.queue.getEntry(key)?.lane ?? 'background'): OrchestrationJob {
		return {
			id: `mem:${this.type}:${key}`,
			type: this.type,
			status: 'running',
			priority: 'normal',
			lane,
			created: new Date().toISOString(),
			inputPaths: [],
			outputPaths: [],
			params,
		};
	}

	private emitMetadataEnriched(key: string, params: Record<string, unknown>, result: WorkflowResult): void {
		if (this.type !== 'youtube_metadata_fetch') return;
		const bus = this.plugin.ingestionEvents;
		if (!bus) return;
		const metadataPath = result.outputPaths?.[0];
		if (!metadataPath) return;
		const metadataFile = this.plugin.app.vault.getAbstractFileByPath(metadataPath);
		if (!(metadataFile instanceof TFile)) return;
		const targetPath = typeof params.targetPath === 'string' ? params.targetPath : '';
		const sourceFile = targetPath ? this.plugin.app.vault.getAbstractFileByPath(targetPath) : null;
		// Keys are no longer bare video ids (per-note jobs key on `note:<path>`), so
		// the id must come from params.
		const videoId = typeof params.videoId === 'string' ? params.videoId : key;
		bus.emit('metadata-enriched', {
			videoId,
			metadataFile,
			sourceFile: sourceFile instanceof TFile ? sourceFile : undefined,
		});
	}
}
