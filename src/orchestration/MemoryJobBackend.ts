import { TFile } from 'obsidian';
import type CruciblePlugin from '../main';
import type { JobTypeConfig } from './jobTypeConfig';
import type { JobLane, JobStatus, JobType, OrchestrationEnqueueOptions, OrchestrationJob, WorkflowResult } from './types';
import type { Workflow } from './workflows/Workflow';
import { JobBackend, RunOutcome, resolveTimeoutMs, runWorkflowWithTimeout } from './JobBackend';
import { CANCELLED_BEFORE_RUN, CancelJobOutcome, RemoveQueuedOutcome, RunSettlement, RunningJobRegistry } from './cancellation';
import { MemoryJobEntry, MemoryJobQueue, MemoryJobStatus } from './MemoryJobQueue';
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
	/**
	 * Entry keys currently mid-claim — the memory-side mirror of FileJobBackend's
	 * `claiming`. `claimNext`/`claimEntry` flip an entry to `'running'` with no await
	 * before the flip, so in practice the gap before `running.begin()` registers it is
	 * a single synchronous JS turn rather than the file backend's ~2s `store.move`
	 * window — "tiny but nonzero," per the audit. Tracked anyway so `cancelJob` never
	 * depends on that gap staying zero (a future await inserted anywhere in this path
	 * would silently reopen the file-side bug here too), and so both backends answer
	 * `stopJob`'s claim-window question the same way.
	 */
	private readonly claiming = new Map<string, { promise: Promise<void>; resolve: () => void }>();

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
		this.registerClaiming(entry.key);
		return this.runEntry(entry);
	}

	// Manual per-job Run: claim the one pending entry by key and run it, bypassing the
	// gate. `empty` if it isn't pending (already running/gone).
	async runJob(key: string): Promise<RunOutcome> {
		const entry = this.queue.claimEntry(key);
		if (!entry) return 'empty';
		this.registerClaiming(entry.key);
		return this.runEntry(entry);
	}

	// Cancels the running entry with this key. A *pending* entry answers
	// 'not-running': dropping it from the queue is `removeQueued`, not an abort.
	//
	// If `key` is mid-claim (see `claiming`), wait it out first — see FileJobBackend's
	// `cancelJob` for why: without this, a `cancelJob` landing in that window answers
	// 'not-running' for an entry that is a JS turn away from executing.
	//
	// Deliberately NOT an `async` function — see the identical note on
	// FileJobBackend.cancelJob: several callers read `isCancelling(key)` synchronously
	// right after calling this, and an unconditional `async`/`await` would delay
	// `running.cancel`'s abort() by a microtask tick even when there is no claim to
	// wait for.
	cancelJob(key: string): Promise<CancelJobOutcome> {
		const claiming = this.claiming.get(key);
		if (!claiming) return this.running.cancel(key);
		return claiming.promise.then(() => this.running.cancel(key));
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

	// Registers `key` as mid-claim; resolved by `settleClaiming` once it lands in
	// `running`. `runEntry` is always called immediately after a successful claim (no
	// branch skips it), so — unlike the file backend — there is no failure path here
	// that needs its own settle: registration and settlement always pair up.
	private registerClaiming(key: string): void {
		let resolve: () => void = () => { /* replaced synchronously below */ };
		const promise = new Promise<void>(r => { resolve = r; });
		this.claiming.set(key, { promise, resolve });
	}

	private settleClaiming(key: string): void {
		const state = this.claiming.get(key);
		if (!state) return;
		this.claiming.delete(key);
		state.resolve();
	}

	private async runEntry(entry: MemoryJobEntry): Promise<RunOutcome> {
		const job = this.synthJob(entry.key, entry.params, entry.lane);
		const run = this.running.begin(entry.key);
		// Settle AFTER begin(), never before — see FileJobBackend.execute's identical
		// ordering comment for why the order matters.
		this.settleClaiming(entry.key);
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

	// Builds the OrchestrationJob view of one memory entry, read live from the queue
	// rather than assumed by the caller. Before this it hardcoded `status: 'running'`
	// unconditionally, which was only ever correct from runEntry's call site (the
	// entry really is running by then) — `enqueue()`'s call site returns the job for
	// a freshly-queued (still-pending) entry, so callers reading `.status` off an
	// enqueue result saw "running" for a job that had not started.
	private synthJob(key: string, params: Record<string, unknown>, lane?: JobLane): OrchestrationJob {
		const entry = this.queue.getEntry(key);
		return {
			id: `mem:${this.type}:${key}`,
			type: this.type,
			status: toJobStatus(entry?.status),
			priority: 'normal',
			lane: lane ?? entry?.lane ?? 'background',
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

// Maps a memory entry's own status vocabulary onto the shared `JobStatus` union the
// rest of the queue UI reads. `pending` (the memory queue's word for "not yet
// claimed") becomes `queued` (the file queue's word for the same thing) so the two
// backends read the same way to anything downstream. An entry that has already been
// swept (or never existed) reports `queued` too, rather than throwing — a caller
// asking "what job did enqueue() just hand me" should never see undefined behavior
// over a race with the sweep it does not know about.
function toJobStatus(status: MemoryJobStatus | undefined): JobStatus {
	switch (status) {
		case 'pending': return 'queued';
		case 'running': return 'running';
		case 'done': return 'done';
		case 'failed': return 'failed';
		case 'cancelled': return 'cancelled';
		default: return 'queued';
	}
}
