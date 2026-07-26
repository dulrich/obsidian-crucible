import { TFile } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { isSearchIndexablePath } from '../../search/chunker';
import {
	SearchEmbeddingConfigError,
	SearchEmbeddingMismatchError,
	SearchEmbeddingUnavailableError,
	SearchServiceUnavailableError,
	type SearchServiceUnavailableErrorKind,
	type SearchResponse,
} from '../../search/types';
import { scheduleQueueChanged } from '../JobBackend';

const SEARCH_RETRY_AFTER_MS = 30_000;

/**
 * Files per `search_upsert_batch` job. Each batch is one durable markdown job file under the
 * queue root, claimed and moved through JobStore — so the batch size sets how many vault
 * writes a full rebuild costs before a single file is indexed.
 *
 * At the original 25 this was far too small, but the 250 that replaced it was sized against
 * a vault file count that turned out to be inflated ~7.7x: the "~42,000 markdown files"
 * figure counted the queue's own job files under `_crucible/`, which is search-excluded. The
 * real indexable corpus is ~5,500 files, so 250 produced only ~22 jobs — coarse enough that
 * a single failed batch loses 250 files of progress and the queue reports almost nothing
 * while it works. 100 gives ~55 jobs: still two orders of magnitude off the 25-era job spam,
 * with finer progress and cheaper retries.
 *
 * Batch size drives job-file count, not request size: SearchManager buffers chunks and
 * flushes every SEARCH_UPSERT_FLUSH_CHUNKS (500) regardless of how many files a batch
 * carries, so the companion's request-body cap is nowhere near in play.
 */
const SEARCH_REBUILD_BATCH_FILES = 100;

/** Enqueues between macrotask yields, so kicking off a rebuild can't freeze the UI thread. */
const SEARCH_REBUILD_ENQUEUE_YIELD_EVERY = 10;

export class SearchRebuildWorkflow implements Workflow {
	run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		return runSearchWorkflow(ctx, async () => {
			await plugin.searchManager.resetIndex();
			const indexableFiles = plugin.searchManager.listIndexableFiles();
			const batches = chunk(indexableFiles.map(file => file.path), SEARCH_REBUILD_BATCH_FILES);
			for (let i = 0; i < batches.length; i++) {
				// Per-batch checkpoint: each iteration is a real vault write, so stopping
				// here stops the queue filling with work the user just cancelled. The
				// batches already enqueued stay queued — cancelling the coordinator does
				// not retract them; that is a bulk queue operation, not an abort.
				ctx.throwIfAborted();
				const paths = batches[i] ?? [];
				await plugin.orchestrator.enqueue('search_upsert_batch', {
					paths,
					rebuildId: job.id,
					batchIndex: i,
					batchCount: batches.length,
				}, { priority: 'low', lane: 'background', inputPaths: paths });
				// `await enqueue` only yields the microtask queue; each enqueue is a real vault
				// write, so a long run of them still starves rendering. Hand the event loop a
				// macrotask periodically to keep Obsidian responsive while the queue fills.
				if ((i + 1) % SEARCH_REBUILD_ENQUEUE_YIELD_EVERY === 0) await yieldToEventLoop();
			}
			return {
				status: 'done',
				notes: `Queued search index rebuild: ${indexableFiles.length} files in ${batches.length} batches.`,
			};
		});
	}
}

/**
 * Backfill vectors for paths the index holds without usable embeddings — the "I turned semantic
 * search on after indexing" repair, and the "I changed the embedding model" repair.
 *
 * Deliberately *not* SearchRebuildWorkflow with a flag: it must never call `resetIndex()`. The
 * FTS index is what makes search work at all, and dropping it to add vectors would take search
 * offline for the hours the backfill runs.
 *
 * Resumption is a property of the existing machinery rather than new bookkeeping. Each batch is
 * a durable markdown job under the queue root, so an Obsidian restart mid-run leaves the
 * remaining batches queued on disk and the runner picks them up; and inside a batch,
 * `SearchManager`'s coverage-aware skip means a re-run of an already-embedded batch re-reads
 * nothing. Interrupting the run and re-issuing the command is therefore cheap and correct: the
 * second pass enqueues the same batches and they complete as no-ops until they reach real work.
 *
 * No pre-filter of covered paths here on purpose. Deciding "is this path covered" needs a
 * fileStates round-trip over every indexable path plus a second copy of the coverage rule, and
 * the batch workflow already applies the authoritative one; a fully-covered batch costs a single
 * state lookup and finishes in milliseconds.
 */
export class SearchEmbedMissingWorkflow implements Workflow {
	run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		return runSearchWorkflow(ctx, async () => {
			// Refuse up front rather than enqueueing dozens of batches that each discover the
			// same misconfiguration. A backfill against no embedder must not silently become an
			// expensive re-index that produces zero vectors.
			if (!plugin.settings.searchSemanticEnabled) {
				return { status: 'failed', error: 'Semantic search is disabled; enable it in Crucible → Settings → Orchestrate → Search before backfilling embeddings.' };
			}
			if (!plugin.settings.searchEmbeddingModel?.modelId) {
				return { status: 'failed', error: 'No embedding model is configured; pick one in Crucible → Settings → Orchestrate → Search before backfilling embeddings.' };
			}
			const indexableFiles = plugin.searchManager.listIndexableFiles();
			const batches = chunk(indexableFiles.map(file => file.path), SEARCH_REBUILD_BATCH_FILES);
			for (let i = 0; i < batches.length; i++) {
				ctx.throwIfAborted();
				const paths = batches[i] ?? [];
				await plugin.orchestrator.enqueue('search_upsert_batch', {
					paths,
					rebuildId: job.id,
					batchIndex: i,
					batchCount: batches.length,
					requireEmbeddings: true,
				}, { priority: 'low', lane: 'background', inputPaths: paths });
				if ((i + 1) % SEARCH_REBUILD_ENQUEUE_YIELD_EVERY === 0) await yieldToEventLoop();
			}
			return {
				status: 'done',
				notes: `Queued embedding backfill: ${indexableFiles.length} files in ${batches.length} batches. The FTS index is untouched; already-covered files are skipped.`,
			};
		});
	}
}

export class SearchUpsertFileWorkflow implements Workflow {
	run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const path = stringParam(job, 'path') || stringParam(job, 'targetPath');
		if (!path) return Promise.resolve({ status: 'failed', error: 'Missing params.path' });
		if (!isSearchIndexablePath(path, plugin.settings.searchIndexExtensions)) return Promise.resolve({ status: 'done', notes: `Skipped non-indexable path: ${path}` });
		return runSearchWorkflow(ctx, async () => {
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
		return runSearchWorkflow(ctx, async () => {
			const files = paths
				.map(path => plugin.app.vault.getAbstractFileByPath(path))
				.filter((file): file is TFile => file instanceof TFile && isSearchIndexablePath(file.path, plugin.settings.searchIndexExtensions));
			const batchIndex = numberParam(job, 'batchIndex');
			const batchCount = numberParam(job, 'batchCount');
			const progress = new SearchJobProgress(plugin, job);
			// Set by SearchEmbedMissingWorkflow only: this batch exists to produce vectors, so
			// FTS-only chunks are a failure rather than a graceful degradation.
			const requireEmbeddings = booleanParam(job, 'requireEmbeddings');
			const label = batchIndex >= 0 && batchCount > 0 ? `batch ${batchIndex + 1} / ${batchCount}` : 'batch';
			try {
				// The signal goes *into* indexFiles rather than being checked around it:
				// the per-file loop lives there, so this is the only placement that can
				// stop a batch part-way instead of after all 100 of its files.
				const result = await plugin.searchManager.indexFiles(files, (done, chunkCount) =>
					progress.update(`${label}: ${done} / ${files.length} files indexed, ${chunkCount} chunks`),
				{ requireEmbeddings, signal: ctx.signal });
				return {
					status: 'done',
					outputPaths: files.map(file => file.path),
					notes: `Indexed search ${label}: ${result.files} files, ${result.chunks} chunks${requireEmbeddings ? ' (embeddings required)' : ''}.`,
				};
			} catch (e) {
				// A stopped embedder is a normal few-second event for a `restart: unless-stopped`
				// container, so defer and retry rather than failing the batch — the alternative
				// is one blip failing every remaining batch of a multi-hour run. A width
				// mismatch is NOT this error and propagates, because retrying a
				// misconfiguration forever is not a recovery.
				if (!(e instanceof SearchEmbeddingUnavailableError)) throw e;
				return {
					status: 'deferred',
					error: e.message,
					notes: `Embedding backfill ${label} deferred: ${e.message}. Retrying shortly.`,
					retryAfterMs: SEARCH_RETRY_AFTER_MS,
					// 'timeout' is a default, not a measurement: SearchEmbeddingUnavailableError
					// carries no finer-grained kind of its own (unlike SearchServiceUnavailableError,
					// which has one per transport outcome) — the embedder simply didn't produce
					// vectors, and 'timeout' is the conservative choice within ServiceFailureKind for
					// "answered badly/slowly" as opposed to a confirmed refusal.
					serviceUnhealthy: { service: 'search-embedder', kind: 'timeout', reason: e.message },
				};
			}
		});
	}
}

export class SearchDeletePathWorkflow implements Workflow {
	run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const path = stringParam(job, 'path') || stringParam(job, 'oldPath');
		if (!path) return Promise.resolve({ status: 'failed', error: 'Missing params.path' });
		return runSearchWorkflow(ctx, async () => {
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
		return runSearchWorkflow(ctx, async () => {
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
	ctx: WorkflowContext,
	run: () => Promise<WorkflowResult>,
): Promise<WorkflowResult> {
	const { plugin } = ctx;
	if (!plugin.settings.searchEnabled) return { status: 'failed', error: 'Search is disabled in settings' };
	// The availability probe is a network round-trip, so re-check afterwards rather
	// than committing to work a cancellation arrived during. No exception here to read a
	// `kind` from — the companion was already known-down from a prior probe/failure — so
	// this deferral names the service with the same conservative default kind
	// SearchServiceUnavailableError itself defaults to for an unclassified failure.
	if (!(await plugin.searchManager.companionAvailable())) return searchDeferredResult(plugin, 'refused');
	ctx.throwIfAborted();
	try {
		return await run();
	} catch (e) {
		// A JobCancelledError is not a companion outage — it must reach
		// runWorkflowWithTimeout untouched, or a cancelled search job would settle as a
		// retryable deferral and re-run.
		if (e instanceof SearchServiceUnavailableError) {
			// The thrown message becomes the gate's reason, so searchDeferredResult picks it up
			// as the primary text — passing it again as `detail` would just print it twice.
			plugin.searchManager.markCompanionOffline(e.message);
			return searchDeferredResult(plugin, e.kind);
		}
		// Permanent, job-level, loud — WP-6's whole point. An orphaned embedding ref or a
		// vector-width mismatch will not self-heal on the next batch, the next file, or
		// ever, so it must never come back as a deferral (which the breaker would read as
		// "search-embedder is down" and keep probing forever). This is the one place both
		// permanent kinds are caught: SearchUpsertBatchWorkflow's own catch only intercepts
		// SearchEmbeddingUnavailableError and rethrows everything else, including these,
		// straight here; SearchUpsertFileWorkflow's plain indexFile() call has no catch of
		// its own and lands here directly too.
		if (e instanceof SearchEmbeddingConfigError || e instanceof SearchEmbeddingMismatchError) {
			return { status: 'failed', error: e.message };
		}
		throw e;
	}
}

// "Unavailable" is not always "not running": a reachable companion serving an index schema
// this build cannot query is also unavailable, and the start-the-container instruction would
// send the user to restart something already healthy. Prefer the companion's own reason when
// it gave one; fall back to the not-reachable text only when nothing answered.
function searchDeferredResult(
	plugin: WorkflowContext['plugin'],
	kind: SearchServiceUnavailableErrorKind,
	detail?: string,
): WorkflowResult {
	const reason = plugin.searchManager.companionUnavailableReason();
	const message = reason
		?? `Search companion not reachable at ${plugin.settings.searchServiceUrl}. Start it with: home-compose up crucible-search (dev fallback: npm run search:serve)`;
	return {
		status: 'deferred',
		error: detail ? `${message} (${detail})` : message,
		notes: `${message}. Retrying shortly.`,
		retryAfterMs: SEARCH_RETRY_AFTER_MS,
		// SearchServiceUnavailableErrorKind ('refused'|'timeout'|'server-error') is a strict
		// subset of ServiceFailureKind — every value maps straight across, and
		// 'rate-limited' (the one ServiceFailureKind member with no counterpart here) is
		// simply never produced by this path.
		serviceUnhealthy: { service: 'search-companion', kind, reason: message },
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

function booleanParam(job: OrchestrationJob, key: string): boolean {
	return job.params?.[key] === true;
}

function numberParam(job: OrchestrationJob, key: string): number {
	const value = job.params?.[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : -1;
}

function yieldToEventLoop(): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, 0));
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
		// Was `emit('orchestration-queue-updated', { queued: 0, running: 0 })` — a
		// FABRICATED payload every 10 files, which every listener rendered as "the queue
		// is empty" and the autorunner answered with a full kickAll(). It goes through
		// the shared coalescer instead, so the counts are real and a long batch cannot
		// out-emit the 250ms window.
		scheduleQueueChanged(this.plugin, this.plugin.jobStore);
	}

	private async resolveFile(): Promise<TFile | null> {
		if (this.file !== undefined) return this.file;
		const running = await this.plugin.jobStore.listFolder('running');
		this.file = running.find(entry => entry.job.id === this.job.id)?.file ?? null;
		return this.file;
	}
}
