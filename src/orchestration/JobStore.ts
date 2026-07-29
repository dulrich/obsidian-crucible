import { App, Notice, TFile, TFolder, normalizePath, parseYaml } from 'obsidian';
import { ensureFolder } from '../utils';
import { updateFrontmatter } from '../frontmatter';
import { JobStatus, JobType, OrchestrationJob, JobPriority, JobLane } from './types';
import { newJobId, nowIso } from './utils/dates';
import { logError } from '../log';
import type CruciblePlugin from '../main';
import { defaultLaneForPriority, laneRank, parseLane } from './lanes';

const STATUS_FOLDER: Record<JobStatus, string> = {
	queued: 'inbox',
	running: 'running',
	done: 'done',
	failed: 'failed',
	cancelled: 'cancelled',
};

const PRIORITY_RANK: Record<JobPriority, number> = {
	high: 0,
	normal: 1,
	low: 2,
};

export interface QueuePaths {
	root: string;
	inbox: string;
	running: string;
	done: string;
	failed: string;
	cancelled: string;
}

export interface EnqueueOptions {
	priority?: JobPriority;
	lane?: JobLane;
	inputPaths?: string[];
	params?: Record<string, unknown>;
}

export class JobStore {
	private app: App;

	constructor(private plugin: CruciblePlugin) {
		this.app = plugin.app;
	}

	paths(): QueuePaths {
		const root = normalizePath(this.plugin.settings.orchestrationQueueRoot);
		return {
			root,
			inbox: `${root}/inbox`,
			running: `${root}/running`,
			done: `${root}/done`,
			failed: `${root}/failed`,
			cancelled: `${root}/cancelled`,
		};
	}

	folderForStatus(status: JobStatus): string {
		return `${this.paths().root}/${STATUS_FOLDER[status]}`;
	}

	async ensureFolders(): Promise<void> {
		const p = this.paths();
		await ensureFolder(this.app, p.inbox);
		await ensureFolder(this.app, p.running);
		await ensureFolder(this.app, p.done);
		await ensureFolder(this.app, p.failed);
		// Cancelled jobs get their own bucket rather than sharing failed/: the folder
		// is what determines a job's state, so "cancelled is not a failure" has to be
		// expressed as a folder or it isn't expressed at all.
		await ensureFolder(this.app, p.cancelled);
	}

	async enqueue(type: JobType, options: EnqueueOptions = {}): Promise<OrchestrationJob> {
		await this.ensureFolders();

		const id = newJobId(type);
		const created = nowIso();
		const job: OrchestrationJob = {
			id,
			type,
			status: 'queued',
			priority: options.priority ?? 'normal',
			lane: options.lane ?? defaultLaneForPriority(options.priority),
			created,
			updated: created,
			inputPaths: options.inputPaths ?? [],
			outputPaths: [],
			params: options.params,
		};

		const path = `${this.paths().inbox}/${id}.md`;
		const body = this.renderInitialBody(job);
		const file = await this.app.vault.create(path, body);

		await updateFrontmatter(this.app, file, (fm) => {
			fm.id = job.id;
			fm.type = job.type;
			fm.status = job.status;
			fm.priority = job.priority;
			fm.lane = job.lane;
			fm.created = job.created;
			fm.updated = job.updated;
			fm.inputPaths = job.inputPaths;
			fm.outputPaths = job.outputPaths;
			if (job.params !== undefined) fm.params = job.params;
		});

		return job;
	}

	async listFolder(status: JobStatus): Promise<Array<{ job: OrchestrationJob; file: TFile }>> {
		const folderPath = this.folderForStatus(status);
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) return [];

		const out: Array<{ job: OrchestrationJob; file: TFile }> = [];
		for (const child of folder.children) {
			if (!(child instanceof TFile) || child.extension !== 'md') continue;
			const job = await this.readJob(child);
			if (job) out.push({ job, file: child });
		}

		out.sort((a, b) => {
			const lane = laneRank(a.job.lane) - laneRank(b.job.lane);
			if (lane !== 0) return lane;
			const priority = PRIORITY_RANK[a.job.priority] - PRIORITY_RANK[b.job.priority];
			if (priority !== 0) return priority;
			// `created` is millisecond ISO for file jobs, so this tie-break makes same-lane
			// same-priority jobs claim in chronological (mint) order. Only same-millisecond
			// mints (or legacy rows with equal/missing created) fall through to the id compare,
			// which is itself now millisecond+monotonic (see newJobId in utils/dates.ts).
			const created = a.job.created.localeCompare(b.job.created);
			return created !== 0 ? created : a.job.id.localeCompare(b.job.id);
		});
		return out;
	}

	/**
	 * Count of `.md` job files directly in a status folder, without reading each one's
	 * frontmatter. `listFolder` calls `readJob` per entry (a `metadataCache.getFileCache`
	 * hit, or a raw-disk parse on a miss) purely to build sortable `OrchestrationJob`
	 * rows — overkill when the only thing a caller wants is "how many". `scan()`'s
	 * done/failed/cancelled counts are exactly that case: those buckets can run into the
	 * tens of thousands, and reading every one of them on every scan is ~21k needless
	 * reads for a number nothing else uses. Use this wherever only the count matters.
	 */
	countFolder(status: JobStatus): number {
		const folder = this.app.vault.getAbstractFileByPath(this.folderForStatus(status));
		if (!(folder instanceof TFolder)) return 0;
		let count = 0;
		for (const child of folder.children) {
			if (child instanceof TFile && child.extension === 'md') count++;
		}
		return count;
	}

	async readJob(file: TFile): Promise<OrchestrationJob | null> {
		const cached = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const fm = cached ?? (await this.parseFrontmatterFromDisk(file));
		if (!fm) return null;

		const id = typeof fm.id === 'string' ? fm.id : file.basename;
		const type = fm.type as JobType | undefined;
		if (!type) return null;
		const status = (fm.status as JobStatus | undefined) ?? 'queued';
		const priority = (fm.priority as JobPriority | undefined) ?? 'normal';
		const lane = parseLane(fm.lane, priority);
		const created = typeof fm.created === 'string' ? fm.created : nowIso();
		const updated = typeof fm.updated === 'string' ? fm.updated : undefined;
		const inputPaths = Array.isArray(fm.inputPaths) ? (fm.inputPaths as unknown[]).filter((v): v is string => typeof v === 'string') : [];
		const outputPaths = Array.isArray(fm.outputPaths) ? (fm.outputPaths as unknown[]).filter((v): v is string => typeof v === 'string') : [];
		const params = typeof fm.params === 'object' && fm.params !== null && !Array.isArray(fm.params)
			? (fm.params as Record<string, unknown>)
			: undefined;
		const error = typeof fm.error === 'string' ? fm.error : undefined;
		const failureKind = fm.failureKind === 'service' || fm.failureKind === 'job' ? fm.failureKind : undefined;
		const progress = typeof fm.progress === 'string' ? fm.progress : undefined;
		const deferUntil = typeof fm.deferUntil === 'string' ? fm.deferUntil : undefined;

		return { id, type, status, priority, lane, created, updated, inputPaths, outputPaths, params, error, failureKind, progress, deferUntil };
	}

	async move(file: TFile, job: OrchestrationJob, toStatus: JobStatus): Promise<{ file: TFile; job: OrchestrationJob }> {
		const targetFolder = this.folderForStatus(toStatus);
		await ensureFolder(this.app, targetFolder);
		const fromPath = file.path;
		const targetPath = `${targetFolder}/${file.name}`;
		await this.app.fileManager.renameFile(file, targetPath);

		// `file` is a live TFile — `renameFile` mutates its `.path` in place, so `file`
		// IS the moved file (same liveness fact already documented and depended on at
		// FileJobBackend.ts:173-189). This used to re-derive the moved file via a fresh
		// `getAbstractFileByPath(targetPath)` lookup unconditionally and throw on a miss —
		// *after* the rename but *before* the frontmatter write's rollback `try` began, so
		// a transient/lagging lookup left the file physically moved with stale frontmatter
		// (the "stranded in running/ with status: queued" incident). The lookup now only
		// runs as a fallback when the cheap identity check fails, and any failure from
		// there rolls the rename back rather than leaving the file moved-but-unresolved.
		let moved: TFile = file;
		if (moved.path !== targetPath) {
			const lookedUp = this.app.vault.getAbstractFileByPath(targetPath);
			if (lookedUp instanceof TFile) {
				moved = lookedUp;
			} else {
				try {
					await this.app.fileManager.renameFile(file, fromPath);
				} catch (rollbackErr) {
					logError(`JobStore.move: rollback to ${fromPath} failed after post-rename lookup miss`, rollbackErr);
				}
				throw new Error(`JobStore.move: file disappeared after rename: ${targetPath}`);
			}
		}

		const updated = nowIso();
		try {
			await updateFrontmatter(this.app, moved, (fm) => {
				fm.status = toStatus;
				fm.updated = updated;
				if (toStatus !== 'queued') delete fm.deferUntil;
			});
		} catch (err) {
			// The folder is the source of truth for which queue bucket a job is in, so a
			// moved file whose frontmatter still claims the old status is an inconsistent
			// state. Roll the rename back so the job stays fully in its prior bucket, then
			// surface the failure to the caller rather than leaving it moved-but-un-updated.
			try {
				await this.app.fileManager.renameFile(moved, fromPath);
			} catch (rollbackErr) {
				logError(`JobStore.move: rollback to ${fromPath} failed after frontmatter write error`, rollbackErr);
			}
			throw err;
		}

		return {
			file: moved,
			job: { ...job, status: toStatus, updated, deferUntil: toStatus === 'queued' ? job.deferUntil : undefined },
		};
	}

	async setLane(file: TFile, lane: JobLane): Promise<void> {
		await updateFrontmatter(this.app, file, (fm) => {
			fm.lane = lane;
			fm.updated = nowIso();
		});
	}

	async setPriority(file: TFile, priority: JobPriority): Promise<void> {
		await updateFrontmatter(this.app, file, (fm) => {
			fm.priority = priority;
			fm.updated = nowIso();
		});
	}

	async setDeferred(file: TFile, message: string, deferUntil: string): Promise<void> {
		await updateFrontmatter(this.app, file, (fm) => {
			fm.progress = message;
			fm.deferUntil = deferUntil;
			delete fm.error;
			fm.updated = nowIso();
		});
	}

	async setError(file: TFile, message: string): Promise<void> {
		await updateFrontmatter(this.app, file, (fm) => {
			fm.error = message;
			fm.updated = nowIso();
		});
	}

	/** Stamps how `setError`'s message was classified. Kept as its own write (rather
	 * than a parameter on `setError`) so `setError`'s existing callers — including
	 * `Orchestrator`'s stale-running recovery — are untouched. */
	async setFailureKind(file: TFile, kind: 'service' | 'job'): Promise<void> {
		await updateFrontmatter(this.app, file, (fm) => {
			fm.failureKind = kind;
		});
	}

	/**
	 * Clears a job's recorded failure before it re-enters the queue — used by the
	 * retroactive service-outage repair (`failedJobRepair.ts`) so a requeued job
	 * doesn't carry a stale `error`/`failureKind` from the run that failed it.
	 * Mirrors `setError`'s frontmatter handling.
	 */
	async clearError(file: TFile): Promise<void> {
		await updateFrontmatter(this.app, file, (fm) => {
			delete fm.error;
			delete fm.failureKind;
			fm.updated = nowIso();
		});
	}

	async setOutputPaths(file: TFile, paths: string[]): Promise<void> {
		await updateFrontmatter(this.app, file, (fm) => {
			fm.outputPaths = paths;
			fm.updated = nowIso();
		});
	}

	async setPartial(file: TFile, partial: boolean): Promise<void> {
		await updateFrontmatter(this.app, file, (fm) => {
			fm.partial = partial;
			fm.updated = nowIso();
		});
	}

	async setProgress(file: TFile, message: string): Promise<void> {
		await updateFrontmatter(this.app, file, (fm) => {
			fm.progress = message;
			fm.updated = nowIso();
		});
	}

	async appendNotes(file: TFile, lines: string): Promise<void> {
		const content = await this.app.vault.read(file);
		const marker = '## Notes';
		const idx = content.indexOf(marker);
		if (idx === -1) {
			const next = `${content.replace(/\s+$/, '')}\n\n${marker}\n${lines.trim()}\n`;
			await this.app.vault.modify(file, next);
			return;
		}
		const next = `${content.replace(/\s+$/, '')}\n${lines.trim()}\n`;
		await this.app.vault.modify(file, next);
	}

	private renderInitialBody(job: OrchestrationJob): string {
		return [
			`# Job ${job.id}`,
			'',
			`- Type: ${job.type}`,
			`- Created: ${job.created}`,
			'',
			'## Notes',
			'',
		].join('\n');
	}

	private async parseFrontmatterFromDisk(file: TFile): Promise<Record<string, unknown> | null> {
		try {
			const raw = await this.app.vault.read(file);
			const match = raw.match(/^---\n([\s\S]*?)\n---/);
			if (!match || !match[1]) return null;
			const parsed: unknown = parseYaml(match[1]);
			return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
				? (parsed as Record<string, unknown>)
				: null;
		} catch (e) {
			new Notice(`JobStore: failed to parse frontmatter for ${file.path}: ${(e as Error).message}`);
			return null;
		}
	}
}
