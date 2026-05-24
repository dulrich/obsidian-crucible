import { App, Notice, TFile } from 'obsidian';
import { JobStore } from './JobStore';
import { JobType, OrchestrationJob, ScanReport, WorkflowResult } from './types';
import { Workflow } from './workflows/Workflow';
import type CruciblePlugin from '../main';

const STALE_RUNNING_MS = 60 * 60 * 1000;

export class Orchestrator {
	private app: App;
	private workflows: Map<JobType, Workflow> = new Map();

	constructor(private plugin: CruciblePlugin, private store: JobStore) {
		this.app = plugin.app;
	}

	register(type: JobType, workflow: Workflow): void {
		this.workflows.set(type, workflow);
	}

	async enqueue(type: JobType, params?: Record<string, unknown>): Promise<OrchestrationJob | null> {
		if (!this.plugin.settings.orchestrationEnabled) {
			new Notice('Orchestrate: disabled in settings.');
			return null;
		}
		if (!this.isWorkflowEnabled(type)) {
			new Notice(`Orchestrate: workflow "${type}" is disabled in settings.`);
			return null;
		}
		const job = await this.store.enqueue(type, { params });
		new Notice(`Orchestrate: queued ${type} (${job.id})`);
		void this.emitQueueUpdate();
		return job;
	}

	async runNext(): Promise<OrchestrationJob | null> {
		if (!this.plugin.settings.orchestrationEnabled) {
			new Notice('Orchestrate: disabled in settings.');
			return null;
		}
		await this.store.ensureFolders();

		const queued = await this.store.listFolder('queued');
		const next = queued[0];
		if (!next) {
			new Notice('Orchestrate: nothing to run.');
			return null;
		}

		const moved = await this.store.move(next.file, next.job, 'running');
		void this.emitQueueUpdate();
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
			const result: WorkflowResult = await workflow.run(moved.job, { plugin: this.plugin });
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
			console.error('[crucible] failed to emit orchestration-queue-updated:', err);
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
}
