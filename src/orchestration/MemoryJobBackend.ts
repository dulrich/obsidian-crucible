import { TFile } from 'obsidian';
import type CruciblePlugin from '../main';
import type { JobTypeConfig } from './jobTypeConfig';
import type { JobType, OrchestrationEnqueueOptions, OrchestrationJob, WorkflowResult } from './types';
import type { Workflow } from './workflows/Workflow';
import { JobBackend, RunOutcome, resolveTimeoutMs, runWorkflowWithTimeout } from './JobBackend';
import { MemoryJobQueue } from './MemoryJobQueue';

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

	async enqueue(params: Record<string, unknown>, _options?: OrchestrationEnqueueOptions): Promise<OrchestrationJob | null> {
		const key = this.config.dedupeKey ? this.config.dedupeKey(params) : '';
		if (!key) return null;
		const display = this.config.display ? this.config.display(params) : {};
		if (!this.queue.enqueue(key, params, display)) return null;
		return this.synthJob(key, params);
	}

	async runNext(): Promise<RunOutcome> {
		const entry = this.queue.claimNext();
		if (!entry) return 'empty';
		const job = this.synthJob(entry.key, entry.params);
		try {
			const result = await runWorkflowWithTimeout(
				this.plugin, this.workflow, job, resolveTimeoutMs(this.plugin, this.config),
			);
			if (result.status === 'failed') {
				const error = result.error ?? 'Workflow returned failed status';
				this.queue.markFailed(entry.key, error);
				// Stop auto-refilling when the API key is missing so the queue does not
				// hammer a hopeless request (mirrors the old enrichment behavior).
				if (/api key/i.test(error)) this.queue.setAutoEnabled(false);
			} else {
				this.queue.markDone(entry.key);
				this.emitMetadataEnriched(entry.key, entry.params, result);
			}
		} catch (e) {
			this.queue.markFailed(entry.key, e instanceof Error ? e.message : String(e));
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

	private synthJob(key: string, params: Record<string, unknown>): OrchestrationJob {
		return {
			id: `mem:${this.type}:${key}`,
			type: this.type,
			status: 'running',
			priority: 'normal',
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
