import { TFile } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { isSearchIndexablePath } from '../../search/chunker';
import { SearchServiceUnavailableError, type SearchResponse } from '../../search/types';

const SEARCH_RETRY_AFTER_MS = 30_000;
const SEARCH_REBUILD_BATCH_FILES = 25;

export class SearchRebuildWorkflow implements Workflow {
	run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		return runSearchWorkflow(plugin, async () => {
			await plugin.searchManager.resetIndex();
			const indexableFiles = plugin.searchManager.listIndexableFiles();
			const batches = chunk(indexableFiles.map(file => file.path), SEARCH_REBUILD_BATCH_FILES);
			for (let i = 0; i < batches.length; i++) {
				const paths = batches[i] ?? [];
				await plugin.orchestrator.enqueue('search_upsert_batch', {
					paths,
					rebuildId: job.id,
					batchIndex: i,
					batchCount: batches.length,
				}, { priority: 'low', lane: 'background', inputPaths: paths });
			}
			return {
				status: 'done',
				notes: `Queued search index rebuild: ${indexableFiles.length} files in ${batches.length} batches.`,
			};
		});
	}
}

export class SearchUpsertFileWorkflow implements Workflow {
	run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const path = stringParam(job, 'path') || stringParam(job, 'targetPath');
		if (!path) return Promise.resolve({ status: 'failed', error: 'Missing params.path' });
		if (!isSearchIndexablePath(path)) return Promise.resolve({ status: 'done', notes: `Skipped non-indexable path: ${path}` });
		return runSearchWorkflow(plugin, async () => {
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
		});
	}
}

export class SearchUpsertBatchWorkflow implements Workflow {
	run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const paths = stringArrayParam(job, 'paths');
		if (paths.length === 0) return Promise.resolve({ status: 'failed', error: 'Missing params.paths' });
		return runSearchWorkflow(plugin, async () => {
			const files = paths
				.map(path => plugin.app.vault.getAbstractFileByPath(path))
				.filter((file): file is TFile => file instanceof TFile && isSearchIndexablePath(file.path));
			const batchIndex = numberParam(job, 'batchIndex');
			const batchCount = numberParam(job, 'batchCount');
			const progress = new SearchJobProgress(plugin, job);
			const label = batchIndex >= 0 && batchCount > 0 ? `batch ${batchIndex + 1} / ${batchCount}` : 'batch';
			const result = await plugin.searchManager.indexFiles(files, (done, chunkCount) =>
				progress.update(`${label}: ${done} / ${files.length} files indexed, ${chunkCount} chunks`),
			);
			return {
				status: 'done',
				outputPaths: files.map(file => file.path),
				notes: `Indexed search ${label}: ${result.files} files, ${result.chunks} chunks.`,
			};
		});
	}
}

export class SearchDeletePathWorkflow implements Workflow {
	run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const path = stringParam(job, 'path') || stringParam(job, 'oldPath');
		if (!path) return Promise.resolve({ status: 'failed', error: 'Missing params.path' });
		return runSearchWorkflow(plugin, async () => {
			await plugin.searchManager.deletePath(path);
			return { status: 'done', notes: `Removed ${path} from search index.` };
		});
	}
}

export class SearchSweepWorkflow implements Workflow {
	run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const description = stringParam(job, 'description');
		if (!description) return Promise.resolve({ status: 'failed', error: 'Missing params.description' });
		return runSearchWorkflow(plugin, async () => {
			const response: SearchResponse = await plugin.searchManager.sweep(description);
			return {
				status: 'done',
				notes: `Sweep returned ${response.total ?? response.results.length} results (${response.mode ?? 'unknown'}).`,
			};
		});
	}
}

// Shared scaffold for every search workflow: enforce the settings toggle, gate on companion
// availability (one cached probe via SearchManager), run the operation, and translate a
// mid-flight companion outage into a quiet retryable deferral. Each workflow above is then just
// its core operation.
async function runSearchWorkflow(
	plugin: WorkflowContext['plugin'],
	run: () => Promise<WorkflowResult>,
): Promise<WorkflowResult> {
	if (!plugin.settings.searchEnabled) return { status: 'failed', error: 'Search is disabled in settings' };
	if (!(await plugin.searchManager.companionAvailable())) return searchDeferredResult(plugin);
	try {
		return await run();
	} catch (e) {
		if (e instanceof SearchServiceUnavailableError) {
			plugin.searchManager.markCompanionOffline();
			return searchDeferredResult(plugin, e.message);
		}
		throw e;
	}
}

function searchDeferredResult(plugin: WorkflowContext['plugin'], detail?: string): WorkflowResult {
	const message = `Search companion not reachable at ${plugin.settings.searchServiceUrl}. Start it with: home-compose up crucible-search (dev fallback: npm run search:serve)`;
	return {
		status: 'deferred',
		error: detail ? `${message} (${detail})` : message,
		notes: `${message}. Retrying shortly.`,
		retryAfterMs: SEARCH_RETRY_AFTER_MS,
	};
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
