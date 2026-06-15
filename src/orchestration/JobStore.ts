import { App, Notice, TFile, TFolder, normalizePath, parseYaml } from 'obsidian';
import { ensureFolder } from '../utils';
import { updateFrontmatter } from '../frontmatter';
import { JobStatus, JobType, OrchestrationJob, JobPriority } from './types';
import { newJobId, nowIso } from './utils/dates';
import { logError } from '../log';
import type CruciblePlugin from '../main';

const STATUS_FOLDER: Record<JobStatus, string> = {
	queued: 'inbox',
	running: 'running',
	done: 'done',
	failed: 'failed',
};

export interface QueuePaths {
	root: string;
	inbox: string;
	running: string;
	done: string;
	failed: string;
}

export interface EnqueueOptions {
	priority?: JobPriority;
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

		out.sort((a, b) => a.job.id.localeCompare(b.job.id));
		return out;
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
		const created = typeof fm.created === 'string' ? fm.created : nowIso();
		const updated = typeof fm.updated === 'string' ? fm.updated : undefined;
		const inputPaths = Array.isArray(fm.inputPaths) ? (fm.inputPaths as unknown[]).filter((v): v is string => typeof v === 'string') : [];
		const outputPaths = Array.isArray(fm.outputPaths) ? (fm.outputPaths as unknown[]).filter((v): v is string => typeof v === 'string') : [];
		const params = typeof fm.params === 'object' && fm.params !== null && !Array.isArray(fm.params)
			? (fm.params as Record<string, unknown>)
			: undefined;
		const error = typeof fm.error === 'string' ? fm.error : undefined;
		const progress = typeof fm.progress === 'string' ? fm.progress : undefined;

		return { id, type, status, priority, created, updated, inputPaths, outputPaths, params, error, progress };
	}

	async move(file: TFile, job: OrchestrationJob, toStatus: JobStatus): Promise<{ file: TFile; job: OrchestrationJob }> {
		const targetFolder = this.folderForStatus(toStatus);
		await ensureFolder(this.app, targetFolder);
		const fromPath = file.path;
		const targetPath = `${targetFolder}/${file.name}`;
		await this.app.fileManager.renameFile(file, targetPath);

		const moved = this.app.vault.getAbstractFileByPath(targetPath);
		if (!(moved instanceof TFile)) {
			throw new Error(`JobStore.move: file disappeared after rename: ${targetPath}`);
		}

		const updated = nowIso();
		try {
			await updateFrontmatter(this.app, moved, (fm) => {
				fm.status = toStatus;
				fm.updated = updated;
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
			job: { ...job, status: toStatus, updated },
		};
	}

	async setError(file: TFile, message: string): Promise<void> {
		await updateFrontmatter(this.app, file, (fm) => {
			fm.error = message;
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
