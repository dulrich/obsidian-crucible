import { TFile } from 'obsidian';
import type CruciblePlugin from '../main';
import type { JobTypeConfig } from './jobTypeConfig';
import type { JobType, OrchestrationEnqueueOptions, OrchestrationJob, WorkflowResult } from './types';
import type { Workflow } from './workflows/Workflow';
import { JobBackend, RunOutcome, resolveTimeoutMs, runWorkflowWithTimeout } from './JobBackend';
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

	private async runEntry(entry: MemoryJobEntry): Promise<RunOutcome> {
		const job = this.synthJob(entry.key, entry.params, entry.lane);
		try {
			const result = await runWorkflowWithTimeout(
				this.plugin, this.workflow, job, resolveTimeoutMs(this.plugin, this.config),
			);
			if (result.status === 'failed') {
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
				this.emitMetadataEnriched(entry.key, entry.params, result);
			}
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			this.queue.markFailed(entry.key, error);
			logWarn('job', this.type, entry.key, 'threw:', error);
		}
		this.queue.sweepTerminal();
		return 'ran';
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
