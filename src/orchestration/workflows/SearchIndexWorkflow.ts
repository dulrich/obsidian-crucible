import { TFile } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { isSearchIndexablePath } from '../../search/chunker';

const SEARCH_PROGRESS_EVERY_FILES = 10;

export class SearchRebuildWorkflow implements Workflow {
	async run(_job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		if (!plugin.settings.searchEnabled) return { status: 'failed', error: 'Search is disabled in settings' };
		await plugin.searchManager.resetIndex();
		const progress = new SearchJobProgress(plugin, _job);
		const indexableFiles = plugin.searchManager.listIndexableFiles();
		await progress.update(`0 / ${indexableFiles.length} files indexed`);
		let files = 0;
		let chunks = 0;
		for (const file of indexableFiles) {
			files++;
			chunks += await plugin.searchManager.indexFile(file);
			if (files === indexableFiles.length || files % SEARCH_PROGRESS_EVERY_FILES === 0) {
				await progress.update(`${files} / ${indexableFiles.length} files indexed, ${chunks} chunks`);
			}
		}
		return {
			status: 'done',
			notes: `Rebuilt search index: ${files} files, ${chunks} chunks.`,
		};
	}
}

export class SearchUpsertFileWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		if (!plugin.settings.searchEnabled) return { status: 'failed', error: 'Search is disabled in settings' };
		const path = stringParam(job, 'path') || stringParam(job, 'targetPath');
		if (!path) return { status: 'failed', error: 'Missing params.path' };
		if (!isSearchIndexablePath(path)) return { status: 'done', notes: `Skipped non-indexable path: ${path}` };
		const file = plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			await plugin.searchManager.deletePath(path);
			return { status: 'done', notes: `Removed missing file from search index: ${path}` };
		}
		const chunks = await plugin.searchManager.indexFile(file);
		return {
			status: 'done',
			outputPaths: [file.path],
			notes: `Indexed ${file.path}: ${chunks} chunks.`,
		};
	}
}

export class SearchDeletePathWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		if (!plugin.settings.searchEnabled) return { status: 'failed', error: 'Search is disabled in settings' };
		const path = stringParam(job, 'path') || stringParam(job, 'oldPath');
		if (!path) return { status: 'failed', error: 'Missing params.path' };
		await plugin.searchManager.deletePath(path);
		return {
			status: 'done',
			notes: `Removed ${path} from search index.`,
		};
	}
}

export class SearchSweepWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		if (!plugin.settings.searchEnabled) return { status: 'failed', error: 'Search is disabled in settings' };
		const description = stringParam(job, 'description');
		if (!description) return { status: 'failed', error: 'Missing params.description' };
		const response = await plugin.searchManager.sweep(description);
		return {
			status: 'done',
			notes: `Sweep returned ${response.results.length} results (${response.mode ?? 'unknown'}).`,
		};
	}
}

function stringParam(job: OrchestrationJob, key: string): string {
	const value = job.params?.[key];
	return typeof value === 'string' ? value.trim() : '';
}

class SearchJobProgress {
	private file: TFile | null | undefined;

	constructor(
		private readonly plugin: WorkflowContext['plugin'],
		private readonly job: OrchestrationJob,
	) {}

	async update(message: string): Promise<void> {
		const file = await this.resolveFile();
		if (!file) return;
		await this.plugin.jobStore.setProgress(file, message);
		this.plugin.ingestionEvents?.emit('orchestration-queue-updated', { queued: 0, running: 0 });
	}

	private async resolveFile(): Promise<TFile | null> {
		if (this.file !== undefined) return this.file;
		const running = await this.plugin.jobStore.listFolder('running');
		this.file = running.find(entry => entry.job.id === this.job.id)?.file ?? null;
		return this.file;
	}
}
