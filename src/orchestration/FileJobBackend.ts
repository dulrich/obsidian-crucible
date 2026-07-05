import { Notice, TFile } from 'obsidian';
import type CruciblePlugin from '../main';
import type { JobStore } from './JobStore';
import type { JobTypeConfig } from './jobTypeConfig';
import type { JobPriority, JobType, OrchestrationEnqueueOptions, OrchestrationJob, WorkflowResult } from './types';
import type { Workflow } from './workflows/Workflow';
import { JobBackend, RunOutcome, resolveTimeoutMs, runWorkflowWithTimeout } from './JobBackend';
import { logError } from '../log';
import { routineJobNotice } from './notices';
import { defaultLaneForPriority, laneRank } from './lanes';

// Durable, markdown-backed job type: every job is a file under
// orchestrationQueueRoot/{queued,running,done,failed}. Enqueue collapses repeats by
// `dedupeKey` onto the existing active job; the drain claims a queued file, moves it
// to running, executes the workflow under the per-type/global timeout, and moves it
// to done/failed with notes/output recorded.
export class FileJobBackend implements JobBackend {
	readonly drainsWithoutAutorun = false;
	// File paths a worker has claimed but not yet moved to running. Guards the window
	// between listFolder and move so two workers of this type can't claim the same job
	// (claim + check happen synchronously, with no await between them).
	private readonly claimed = new Set<string>();
	private retryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly plugin: CruciblePlugin,
		private readonly store: JobStore,
		private readonly type: JobType,
		private readonly config: JobTypeConfig,
		private readonly workflow: Workflow,
	) {}

	async enqueue(params: Record<string, unknown>, options: OrchestrationEnqueueOptions = {}): Promise<OrchestrationJob | null> {
		if (!this.plugin.settings.orchestrationEnabled) {
			new Notice('Orchestrate: disabled in settings.');
			return null;
		}
		if (!this.isWorkflowEnabled()) {
			new Notice(`Orchestrate: workflow "${this.type}" is disabled in settings.`);
			return null;
		}
		if (this.config.dedupeKey) {
			const key = this.config.dedupeKey(params);
			if (key) {
				const existing = await this.findActiveJob(key);
				if (existing) {
					const priority = options.priority ?? 'normal';
					const lane = options.lane ?? defaultLaneForPriority(options.priority);
					const promotesLane = existing.job.status === 'queued' && laneRank(lane) < laneRank(existing.job.lane);
					const promotesPriority = existing.job.status === 'queued'
						&& lane === existing.job.lane
						&& priorityRank(priority) < priorityRank(existing.job.priority);
					if (promotesLane || promotesPriority) {
						if (promotesLane) await this.store.setLane(existing.file, lane);
						if (promotesLane || promotesPriority) await this.store.setPriority(existing.file, priority);
						void this.emitQueueUpdate();
						routineJobNotice(this.plugin, this.type, `Orchestrate: promoted ${this.type} (${existing.job.id})`);
						return { ...existing.job, lane, priority };
					}
					routineJobNotice(this.plugin, this.type, `Orchestrate: ${this.type} already queued for this target (${existing.job.id}).`);
					return existing.job;
				}
			}
		}
		const job = await this.store.enqueue(this.type, { params, priority: options.priority, lane: options.lane, inputPaths: options.inputPaths });
		routineJobNotice(this.plugin, this.type, `Orchestrate: queued ${this.type} (${job.id})`);
		void this.emitQueueUpdate();
		return job;
	}

	async runNext(): Promise<RunOutcome> {
		if (!this.plugin.settings.orchestrationEnabled) return 'disabled';
		const moved = await this.claimNext();
		if (!moved) return 'empty';
		await this.execute(moved);
		return 'ran';
	}

	// File types report "maybe": emptiness is checked lazily during the claim, so the
	// drain treats `true` as "try a claim" and `runNext` returns 'empty' when nothing
	// is actually claimable.
	hasPending(): boolean {
		return true;
	}

	refill(): void {
		/* file types have no auto-source */
	}

	// Finds a queued or running job of this type whose params resolve to the same
	// dedupe key, so callers can collapse repeat enqueues onto one job.
	private async findActiveJob(key: string): Promise<{ job: OrchestrationJob; file: TFile } | null> {
		await this.store.ensureFolders();
		const [queued, running] = await Promise.all([
			this.store.listFolder('queued'),
			this.store.listFolder('running'),
		]);
		for (const entry of [...queued, ...running]) {
			if (entry.job.type !== this.type) continue;
			if (this.config.dedupeKey?.(entry.job.params ?? {}) === key) return entry;
		}
		return null;
	}

	private async claimNext(): Promise<{ file: TFile; job: OrchestrationJob } | null> {
		await this.store.ensureFolders();
		const queued = await this.store.listFolder('queued');
		let nextRetryAt = Number.POSITIVE_INFINITY;
		const next = queued.find(e => {
			if (e.job.type !== this.type || this.claimed.has(e.file.path)) return false;
			const deferUntil = parseDeferredTime(e.job.deferUntil);
			if (deferUntil !== null && deferUntil > Date.now()) {
				nextRetryAt = Math.min(nextRetryAt, deferUntil);
				return false;
			}
			return true;
		});
		if (!next && Number.isFinite(nextRetryAt)) this.scheduleRetryWake(nextRetryAt - Date.now());
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

	private async execute(moved: { file: TFile; job: OrchestrationJob }): Promise<void> {
		if (!this.isWorkflowEnabled()) {
			await this.failEntry(moved, `Workflow "${moved.job.type}" is disabled in settings`);
			return;
		}
		try {
			const result = await runWorkflowWithTimeout(
				this.plugin, this.workflow, moved.job, resolveTimeoutMs(this.plugin, this.config),
			);
			if (result.outputPaths && result.outputPaths.length > 0) {
				await this.store.setOutputPaths(moved.file, result.outputPaths);
			}
			if (result.status === 'deferred') {
				await this.deferEntry(moved, result);
				return;
			}
			if (result.notes) {
				await this.store.appendNotes(moved.file, result.notes);
				if (result.notes.startsWith('Partial:')) await this.store.setPartial(moved.file, true);
			}
			if (result.status === 'failed') {
				await this.failEntry(moved, result.error ?? 'Workflow returned failed status', result);
				return;
			}
			await this.store.move(moved.file, moved.job, 'done');
			void this.emitQueueUpdate();
			this.emitTrackerEvent(result, 'done');
			routineJobNotice(this.plugin, this.type, `Orchestrate: ${moved.job.id} → done`);
		} catch (e) {
			await this.failEntry(moved, e instanceof Error ? e.message : String(e));
		}
	}

	private async deferEntry(moved: { file: TFile; job: OrchestrationJob }, result: WorkflowResult): Promise<void> {
		const retryAfterMs = Math.max(1000, result.retryAfterMs ?? 30_000);
		const deferUntil = new Date(Date.now() + retryAfterMs).toISOString();
		const message = result.notes ?? result.error ?? `Deferred; retrying after ${deferUntil}`;
		await this.store.setDeferred(moved.file, message, deferUntil);
		await this.store.move(moved.file, { ...moved.job, deferUntil }, 'queued');
		this.scheduleRetryWake(retryAfterMs);
		void this.emitQueueUpdate();
	}

	private scheduleRetryWake(delayMs: number): void {
		const delay = Math.max(1000, Math.min(delayMs, 24 * 60 * 60 * 1000));
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			void this.emitQueueUpdate();
			this.plugin.orchestrationAutoRunner?.kickDrainType(this.type);
		}, delay);
	}

	private async failEntry(
		moved: { file: TFile; job: OrchestrationJob },
		error: string,
		result?: WorkflowResult,
	): Promise<void> {
		await this.store.setError(moved.file, error);
		await this.store.move(moved.file, moved.job, 'failed');
		void this.emitQueueUpdate();
		if (result) this.emitTrackerEvent(result, 'failed');
		new Notice(`Orchestrate: ${moved.job.id} → failed (${error})`);
	}

	private isWorkflowEnabled(): boolean {
		const s = this.plugin.settings;
		switch (this.type) {
			case 'daily_brief_lite': return s.orchestrationDailyBriefEnabled;
			case 'youtube_tracker': return s.orchestrationYoutubeTrackerEnabled;
			case 'youtube_tracker_consolidate': return s.orchestrationYoutubeTrackerEnabled;
			case 'blogs_tracker': return s.orchestrationBlogsTrackerEnabled;
			case 'blogs_tracker_consolidate': return s.orchestrationBlogsTrackerEnabled;
			case 'link_scan': return s.orchestrationLinkScanEnabled;
			case 'transcript_refine': return s.orchestrationTranscriptRefineEnabled;
			case 'image_metadata_extract': return s.imageMetadataExtractionEnabled;
			default: return true;
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

	private emitTrackerEvent(result: WorkflowResult, status: 'done' | 'failed'): void {
		const bus = this.plugin.ingestionEvents;
		if (!bus) return;
		let kind: 'blog' | 'youtube' | null = null;
		if (this.type === 'blogs_tracker' || this.type === 'blogs_tracker_consolidate') kind = 'blog';
		else if (this.type === 'youtube_tracker' || this.type === 'youtube_tracker_consolidate') kind = 'youtube';
		if (!kind) return;
		const outPath = result.outputPaths?.[0];
		const runFile = outPath ? this.plugin.app.vault.getAbstractFileByPath(outPath) : null;
		bus.emit('tracker-run', {
			kind,
			runFile: runFile instanceof TFile ? runFile : null,
			status,
		});
	}
}

function priorityRank(priority: JobPriority): number {
	switch (priority) {
		case 'high': return 0;
		case 'normal': return 1;
		case 'low': return 2;
	}
}

function parseDeferredTime(value: string | undefined): number | null {
	if (!value) return null;
	const ts = Date.parse(value);
	return Number.isFinite(ts) ? ts : null;
}
