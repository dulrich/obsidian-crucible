import { TFile } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { isSearchIndexablePath } from '../../search/chunker';
import type { SearchResponse } from '../../search/types';

const SEARCH_RETRY_AFTER_MS = 30_000;
const SEARCH_REBUILD_BATCH_FILES = 25;
const searchOfflineUntilByUrl = new Map<string, number>();

export class SearchRebuildWorkflow implements Workflow {
	async run(_job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		if (!plugin.settings.searchEnabled) return { status: 'failed', error: 'Search is disabled in settings' };
		const unavailable = await searchUnavailableResult(plugin);
		if (unavailable) return unavailable;
		try {
			await plugin.searchManager.resetIndex();
		} catch (e) {
			const deferred = searchErrorDeferredResult(plugin, e);
			if (deferred) return deferred;
			throw e;
		}
		const indexableFiles = plugin.searchManager.listIndexableFiles();
		const batches = chunk(indexableFiles.map(file => file.path), SEARCH_REBUILD_BATCH_FILES);
		for (let i = 0; i < batches.length; i++) {
			const paths = batches[i] ?? [];
			await plugin.orchestrator.enqueue('search_upsert_batch', {
				paths,
				rebuildId: _job.id,
				batchIndex: i,
				batchCount: batches.length,
			}, { priority: 'low', inputPaths: paths });
		}
		return {
			status: 'done',
			notes: `Queued search index rebuild: ${indexableFiles.length} files in ${batches.length} batches.`,
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
		const unavailable = await searchUnavailableResult(plugin);
		if (unavailable) return unavailable;
		const file = plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			try {
				await plugin.searchManager.deletePath(path);
			} catch (e) {
				const deferred = searchErrorDeferredResult(plugin, e);
				if (deferred) return deferred;
				throw e;
			}
			return { status: 'done', notes: `Removed missing file from search index: ${path}` };
		}
		let chunks: number;
		try {
			chunks = await plugin.searchManager.indexFile(file);
		} catch (e) {
			const deferred = searchErrorDeferredResult(plugin, e);
			if (deferred) return deferred;
			throw e;
		}
		return {
			status: 'done',
			outputPaths: [file.path],
			notes: `Indexed ${file.path}: ${chunks} chunks.`,
		};
	}
}

export class SearchUpsertBatchWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		if (!plugin.settings.searchEnabled) return { status: 'failed', error: 'Search is disabled in settings' };
		const unavailable = await searchUnavailableResult(plugin);
		if (unavailable) return unavailable;
		const paths = stringArrayParam(job, 'paths');
		if (paths.length === 0) return { status: 'failed', error: 'Missing params.paths' };
		const files = paths
			.map(path => plugin.app.vault.getAbstractFileByPath(path))
			.filter((file): file is TFile => file instanceof TFile && isSearchIndexablePath(file.path));
		const batchIndex = numberParam(job, 'batchIndex');
		const batchCount = numberParam(job, 'batchCount');
		const progress = new SearchJobProgress(plugin, job);
		const label = batchIndex >= 0 && batchCount > 0 ? `batch ${batchIndex + 1} / ${batchCount}` : 'batch';
		let indexed: number;
		let chunks: number;
		try {
			const result = await plugin.searchManager.indexFiles(files, (done, chunkCount) =>
				progress.update(`${label}: ${done} / ${files.length} files indexed, ${chunkCount} chunks`),
			);
			indexed = result.files;
			chunks = result.chunks;
		} catch (e) {
			const deferred = searchErrorDeferredResult(plugin, e);
			if (deferred) return deferred;
			throw e;
		}
		return {
			status: 'done',
			outputPaths: files.map(file => file.path),
			notes: `Indexed search ${label}: ${indexed} files, ${chunks} chunks.`,
		};
	}
}

export class SearchDeletePathWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		if (!plugin.settings.searchEnabled) return { status: 'failed', error: 'Search is disabled in settings' };
		const path = stringParam(job, 'path') || stringParam(job, 'oldPath');
		if (!path) return { status: 'failed', error: 'Missing params.path' };
		const unavailable = await searchUnavailableResult(plugin);
		if (unavailable) return unavailable;
		try {
			await plugin.searchManager.deletePath(path);
		} catch (e) {
			const deferred = searchErrorDeferredResult(plugin, e);
			if (deferred) return deferred;
			throw e;
		}
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
		const unavailable = await searchUnavailableResult(plugin);
		if (unavailable) return unavailable;
		let response: SearchResponse;
		try {
			response = await plugin.searchManager.sweep(description);
		} catch (e) {
			const deferred = searchErrorDeferredResult(plugin, e);
			if (deferred) return deferred;
			throw e;
		}
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

function stringArrayParam(job: OrchestrationJob, key: string): string[] {
	const value = job.params?.[key];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function numberParam(job: OrchestrationJob, key: string): number {
	const value = job.params?.[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : -1;
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

async function searchUnavailableResult(plugin: WorkflowContext['plugin']): Promise<WorkflowResult | null> {
	const cachedOfflineUntil = searchOfflineUntilByUrl.get(plugin.settings.searchServiceUrl) ?? 0;
	if (cachedOfflineUntil > Date.now()) return searchDeferredResult(plugin);
	const health = await plugin.searchManager.health().catch(() => null);
	if (health?.ok) {
		searchOfflineUntilByUrl.delete(plugin.settings.searchServiceUrl);
		return null;
	}
	searchOfflineUntilByUrl.set(plugin.settings.searchServiceUrl, Date.now() + SEARCH_RETRY_AFTER_MS);
	return searchDeferredResult(plugin);
}

function searchDeferredResult(plugin: WorkflowContext['plugin'], detail?: string): WorkflowResult {
	const message = `Search companion not reachable at ${plugin.settings.searchServiceUrl}. Start it with: npm run search:serve`;
	return {
		status: 'deferred',
		error: detail ? `${message} (${detail})` : message,
		notes: `${message}. Retrying shortly.`,
		retryAfterMs: SEARCH_RETRY_AFTER_MS,
	};
}

function searchErrorDeferredResult(plugin: WorkflowContext['plugin'], error: unknown): WorkflowResult | null {
	const message = error instanceof Error ? error.message : String(error);
	if (!/search service|connection|refused|timed out|network|fetch/i.test(message)) return null;
	searchOfflineUntilByUrl.set(plugin.settings.searchServiceUrl, Date.now() + SEARCH_RETRY_AFTER_MS);
	return searchDeferredResult(plugin, message);
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
