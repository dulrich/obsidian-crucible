import { App, Notice, TFile } from 'obsidian';
import { JobStore } from './JobStore';
import { JobType, OrchestrationJob, ScanReport, WorkflowResult } from './types';
import { Workflow } from './workflows/Workflow';
import { JobTypeConfig, DEFAULT_JOB_TYPE_CONFIG } from './jobTypeConfig';
import { MemoryJobQueue } from './MemoryJobQueue';
import { MinIntervalGate } from './utils/rateLimit';
import { logError } from '../log';
import type CruciblePlugin from '../main';

// Backstop for jobs that slipped the per-job timeout entirely — e.g. a plugin
// reload mid-run leaves a job stranded in the running folder. `scan()` re-queues
// these. The autorun timeout (orchestrationAutorunTimeoutSeconds) is the primary
// mechanism; this only catches what no live timer could.
const STALE_RUNNING_MS = 60 * 60 * 1000;

export type RunOutcome = 'ran' | 'empty' | 'disabled';

export class Orchestrator {
	private app: App;
	private workflows: Map<JobType, Workflow> = new Map();
	private configs: Map<JobType, JobTypeConfig> = new Map();
	private memoryQueues: Map<JobType, MemoryJobQueue> = new Map();
	private gates: Map<JobType, MinIntervalGate> = new Map();
	// File paths of queued jobs a worker has picked but not yet moved to running.
	// Guards the window between listFolder and move so two workers can't claim the
	// same job (claim + check happen synchronously, with no await between them).
	private readonly claimed = new Set<string>();

	constructor(private plugin: CruciblePlugin, private store: JobStore) {
		this.app = plugin.app;
	}

	register(type: JobType, workflow: Workflow, config: JobTypeConfig = DEFAULT_JOB_TYPE_CONFIG): void {
		this.workflows.set(type, workflow);
		this.configs.set(type, config);
		this.gates.set(type, new MinIntervalGate(config.minIntervalMs));
		if (config.persistence === 'memory') {
			const queue = new MemoryJobQueue(
				config.terminalRetentionMs ?? 60_000,
				(size) => {
					this.plugin.ingestionEvents?.emit('enrichment-queue-updated', { size });
					this.plugin.orchestrationAutoRunner?.kickDrainType(type);
				},
			);
			if (config.autoSource) queue.setAutoSource(config.autoSource);
			this.memoryQueues.set(type, queue);
		}
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
		return this.memoryQueues.get(type) ?? null;
	}

	jobTypes(): JobType[] {
		return Array.from(this.configs.keys());
	}

	async enqueue(type: JobType, params?: Record<string, unknown>): Promise<OrchestrationJob | null> {
		const config = this.getConfig(type);
		if (config.persistence === 'memory') {
			return this.enqueueMemory(type, config, params ?? {});
		}
		if (!this.plugin.settings.orchestrationEnabled) {
			new Notice('Orchestrate: disabled in settings.');
			return null;
		}
		if (!this.isWorkflowEnabled(type)) {
			new Notice(`Orchestrate: workflow "${type}" is disabled in settings.`);
			return null;
		}
		if (config.dedupeKey) {
			const key = config.dedupeKey(params ?? {});
			if (key) {
				const existing = await this.findActiveFileJob(type, key, config.dedupeKey);
				if (existing) {
					new Notice(`Orchestrate: ${type} already queued for this target (${existing.id}).`);
					return existing;
				}
			}
		}
		const job = await this.store.enqueue(type, { params });
		new Notice(`Orchestrate: queued ${type} (${job.id})`);
		void this.emitQueueUpdate();
		return job;
	}

	// Finds a queued or running file-backed job of `type` whose params resolve to
	// the same dedupe key, so callers can collapse repeat enqueues (e.g. rapid
	// transcript-refine requests for the same note) onto one job.
	private async findActiveFileJob(
		type: JobType,
		key: string,
		dedupeKey: (params: Record<string, unknown>) => string,
	): Promise<OrchestrationJob | null> {
		await this.store.ensureFolders();
		const [queued, running] = await Promise.all([
			this.store.listFolder('queued'),
			this.store.listFolder('running'),
		]);
		for (const entry of [...queued, ...running]) {
			if (entry.job.type !== type) continue;
			if (dedupeKey(entry.job.params ?? {}) === key) return entry.job;
		}
		return null;
	}

	// Memory-type enqueue: idempotent on the configured key, silent (no Notice), and
	// independent of the orchestration autorun toggle so enrichment keeps draining.
	private enqueueMemory(type: JobType, config: JobTypeConfig, params: Record<string, unknown>): OrchestrationJob | null {
		const queue = this.getMemoryQueue(type);
		if (!queue) return null;
		const key = config.idempotentKey ? config.idempotentKey(params) : '';
		if (!key) return null;
		const display = config.display ? config.display(params) : {};
		const ok = queue.enqueue(key, params, display);
		if (!ok) return null;
		return this.synthMemoryJob(type, key, params);
	}

	async runNext(): Promise<OrchestrationJob | null> {
		if (!this.plugin.settings.orchestrationEnabled) {
			new Notice('Orchestrate: disabled in settings.');
			return null;
		}
		const moved = await this.claimAndMoveNext();
		if (!moved) {
			new Notice('Orchestrate: nothing to run.');
			return null;
		}
		return await this.executeFileEntry(moved);
	}

	// Runs at most one job of the given type and reports the outcome. The unified
	// runner calls this per worker; file types claim a queued markdown job, memory
	// types claim a pending in-memory entry.
	async runNextOfType(type: JobType): Promise<RunOutcome> {
		const config = this.getConfig(type);
		if (config.persistence === 'memory') {
			return this.runMemoryNext(type);
		}
		if (!this.plugin.settings.orchestrationEnabled) return 'disabled';
		const moved = await this.claimAndMoveNext(type);
		if (!moved) return 'empty';
		await this.executeFileEntry(moved);
		return 'ran';
	}

	hasPending(type: JobType): boolean {
		const queue = this.memoryQueues.get(type);
		if (queue) return queue.hasPending();
		// File types: presence is checked lazily during the claim (listFolder), so
		// callers treat this as "maybe"; runNextOfType returns 'empty' when nothing
		// is actually claimable.
		return true;
	}

	refillMemory(type: JobType): void {
		this.memoryQueues.get(type)?.refill();
	}

	private async claimAndMoveNext(typeFilter?: JobType): Promise<{ file: TFile; job: OrchestrationJob } | null> {
		await this.store.ensureFolders();
		const queued = await this.store.listFolder('queued');
		const next = queued.find(e => (!typeFilter || e.job.type === typeFilter) && !this.claimed.has(e.file.path));
		if (!next) return null;
		this.claimed.add(next.file.path);
		try {
			const moved = await this.store.move(next.file, next.job, 'running');
			void this.emitQueueUpdate();
			return moved;
		} finally {
			this.claimed.delete(next.file.path);
		}
	}

	private async executeFileEntry(moved: { file: TFile; job: OrchestrationJob }): Promise<OrchestrationJob> {
		if (!this.isWorkflowEnabled(moved.job.type)) {
			const error = `Workflow "${moved.job.type}" is disabled in settings`;
			await this.store.setError(moved.file, error);
			const failed = await this.store.move(moved.file, moved.job, 'failed');
			void this.emitQueueUpdate();
			new Notice(`Orchestrate: ${moved.job.id} → failed (${error})`);
			return failed.job;
		}

		const workflow = this.workflows.get(moved.job.type);
		if (!workflow) {
			const error = `No workflow registered for type "${moved.job.type}"`;
			await this.store.setError(moved.file, error);
			const failed = await this.store.move(moved.file, moved.job, 'failed');
			void this.emitQueueUpdate();
			new Notice(`Orchestrate: ${moved.job.id} → failed (${error})`);
			return failed.job;
		}

		try {
			const result: WorkflowResult = await this.runWorkflowWithTimeout(workflow, moved.job);
			if (result.outputPaths && result.outputPaths.length > 0) {
				await this.store.setOutputPaths(moved.file, result.outputPaths);
			}
			if (result.notes) {
				await this.store.appendNotes(moved.file, result.notes);
				if (result.notes.startsWith('Partial:')) {
					await this.store.setPartial(moved.file, true);
				}
			}
			if (result.status === 'failed') {
				const error = result.error ?? 'Workflow returned failed status';
				await this.store.setError(moved.file, error);
				const failed = await this.store.move(moved.file, moved.job, 'failed');
				void this.emitQueueUpdate();
				this.emitTrackerEvent(moved.job.type, result, 'failed');
				new Notice(`Orchestrate: ${moved.job.id} → failed (${error})`);
				return failed.job;
			}
			const done = await this.store.move(moved.file, moved.job, 'done');
			void this.emitQueueUpdate();
			this.emitTrackerEvent(moved.job.type, result, 'done');
			new Notice(`Orchestrate: ${moved.job.id} → done`);
			return done.job;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			await this.store.setError(moved.file, message);
			const failed = await this.store.move(moved.file, moved.job, 'failed');
			void this.emitQueueUpdate();
			new Notice(`Orchestrate: ${moved.job.id} → failed (${message})`);
			return failed.job;
		}
	}

	private async runMemoryNext(type: JobType): Promise<RunOutcome> {
		const queue = this.getMemoryQueue(type);
		if (!queue) return 'empty';
		const workflow = this.workflows.get(type);
		if (!workflow) return 'empty';
		const entry = queue.claimNext();
		if (!entry) return 'empty';
		const job = this.synthMemoryJob(type, entry.key, entry.params);
		try {
			const result = await this.runWorkflowWithTimeout(workflow, job);
			if (result.status === 'failed') {
				const error = result.error ?? 'Workflow returned failed status';
				queue.markFailed(entry.key, error);
				// Stop auto-refilling when the API key is missing so the queue does not
				// hammer a hopeless request (mirrors the old enrichment behavior).
				if (/api key/i.test(error)) queue.setAutoEnabled(false);
			} else {
				queue.markDone(entry.key);
				this.emitMetadataEnriched(type, entry.key, entry.params, result);
			}
		} catch (e) {
			queue.markFailed(entry.key, e instanceof Error ? e.message : String(e));
		}
		queue.sweepTerminal();
		return 'ran';
	}

	// Bounds a workflow run by the per-type (or global) timeout. On timeout the
	// race rejects and the caller's catch marks the job failed; the abandoned
	// workflow promise keeps running in the background (no AbortController), but
	// any note-lock it holds is scoped to a leaf operation and releases when that
	// operation settles.
	private async runWorkflowWithTimeout(workflow: Workflow, job: OrchestrationJob): Promise<WorkflowResult> {
		const timeoutMs = this.resolveTimeoutMs(job.type);
		if (timeoutMs <= 0) return workflow.run(job, { plugin: this.plugin });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
		});
		try {
			return await Promise.race([workflow.run(job, { plugin: this.plugin }), timeout]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private resolveTimeoutMs(type: JobType): number {
		const config = this.getConfig(type);
		if (typeof config.timeoutMs === 'number') return Math.max(0, config.timeoutMs);
		return Math.max(0, this.plugin.settings.orchestrationAutorunTimeoutSeconds) * 1000;
	}

	private synthMemoryJob(type: JobType, key: string, params: Record<string, unknown>): OrchestrationJob {
		return {
			id: `mem:${type}:${key}`,
			type,
			status: 'running',
			priority: 'normal',
			created: new Date().toISOString(),
			inputPaths: [],
			outputPaths: [],
			params,
		};
	}

	async scan(): Promise<ScanReport> {
		await this.store.ensureFolders();

		const queued = await this.store.listFolder('queued');
		const running = await this.store.listFolder('running');
		const done = await this.store.listFolder('done');
		const failed = await this.store.listFolder('failed');

		let recovered = 0;
		const cutoff = Date.now() - STALE_RUNNING_MS;
		for (const entry of running) {
			const updatedRaw = entry.job.updated ?? entry.job.created;
			const updatedAt = Date.parse(updatedRaw);
			if (Number.isFinite(updatedAt) && updatedAt < cutoff) {
				await this.store.setError(entry.file, `Recovered: stale running job (last updated ${updatedRaw})`);
				await this.store.move(entry.file, entry.job, 'queued');
				recovered++;
			}
		}

		await this.ensureQueueIgnored();

		const report: ScanReport = {
			inbox: queued.length,
			running: running.length - recovered,
			done: done.length,
			failed: failed.length,
			recovered,
		};

		const summary =
			`Orchestrate: inbox ${report.inbox}, running ${report.running}, done ${report.done}, failed ${report.failed}` +
			(recovered > 0 ? `, recovered ${recovered}` : '');
		new Notice(summary);
		return report;
	}

	private isWorkflowEnabled(type: JobType): boolean {
		const s = this.plugin.settings;
		switch (type) {
			case 'daily_brief_lite': return s.orchestrationDailyBriefEnabled;
			case 'youtube_tracker': return s.orchestrationYoutubeTrackerEnabled;
			case 'youtube_tracker_consolidate': return s.orchestrationYoutubeTrackerEnabled;
			case 'blogs_tracker': return s.orchestrationBlogsTrackerEnabled;
			case 'blogs_tracker_consolidate': return s.orchestrationBlogsTrackerEnabled;
			case 'link_scan': return s.orchestrationLinkScanEnabled;
			case 'transcript_refine': return s.orchestrationTranscriptRefineEnabled;
			default: return true;
		}
	}

	private async ensureQueueIgnored(): Promise<void> {
		const root = this.store.paths().root;
		if (!this.plugin.settings.lintIgnoredFolders.includes(root)) {
			this.plugin.settings.lintIgnoredFolders = [...this.plugin.settings.lintIgnoredFolders, root];
			await this.plugin.saveSettings();
		}
	}

	private async emitQueueUpdate(): Promise<void> {
		const bus = this.plugin.ingestionEvents;
		if (!bus) return;
		try {
			const [queued, running] = await Promise.all([
				this.store.listFolder('queued'),
				this.store.listFolder('running'),
			]);
			bus.emit('orchestration-queue-updated', { queued: queued.length, running: running.length });
		} catch (err) {
			logError('failed to emit orchestration-queue-updated', err);
		}
	}

	private emitTrackerEvent(type: JobType, result: WorkflowResult, status: 'done' | 'failed'): void {
		const bus = this.plugin.ingestionEvents;
		if (!bus) return;
		let kind: 'blog' | 'youtube' | null = null;
		if (type === 'blogs_tracker' || type === 'blogs_tracker_consolidate') kind = 'blog';
		else if (type === 'youtube_tracker' || type === 'youtube_tracker_consolidate') kind = 'youtube';
		if (!kind) return;
		const outPath = result.outputPaths?.[0];
		const runFile = outPath ? this.app.vault.getAbstractFileByPath(outPath) : null;
		bus.emit('tracker-run', {
			kind,
			runFile: runFile instanceof TFile ? runFile : null,
			status,
		});
	}

	private emitMetadataEnriched(type: JobType, key: string, params: Record<string, unknown>, result: WorkflowResult): void {
		if (type !== 'youtube_metadata_fetch') return;
		const bus = this.plugin.ingestionEvents;
		if (!bus) return;
		const metadataPath = result.outputPaths?.[0];
		if (!metadataPath) return;
		const metadataFile = this.app.vault.getAbstractFileByPath(metadataPath);
		if (!(metadataFile instanceof TFile)) return;
		const targetPath = typeof params.targetPath === 'string' ? params.targetPath : '';
		const sourceFile = targetPath ? this.app.vault.getAbstractFileByPath(targetPath) : null;
		bus.emit('metadata-enriched', {
			videoId: key,
			metadataFile,
			sourceFile: sourceFile instanceof TFile ? sourceFile : undefined,
		});
	}
}
