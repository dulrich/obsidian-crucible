import { App, Notice, TFile } from 'obsidian';
import { CrucibleSettings, Provider, ProviderModelRef } from '../types';
import { ProviderManager } from '../providers';
import { normalizePrecision } from '../providers/shared';
import { buildSearchChunks, hashSearchContent, isSearchIndexablePath } from './chunker';
import { SearchServiceClient } from './client';
import { CompanionAvailabilityGate } from './lifecycleGate';
import { applyLinkBoost, buildLinkGraph, LinkGraph } from './linkGraph';
import {
	embeddingSpaceId,
	SearchChunk,
	SearchEmbeddingMismatchError,
	SearchEmbeddingUnavailableError,
	SearchFileState,
	SearchHealth,
	SearchResponse,
	SearchResult,
} from './types';
import { logWarn } from '../log';
import { isPathExcluded } from '../exclusions';

// Flush the upsert buffer once it reaches this many chunks. Each flush is one HTTP
// request and one SQLite transaction on the companion, so batching across files keeps
// a full rebuild to a handful of round-trips instead of one per file. ~500 chunks is
// well under the companion's 20MB request-body cap.
const SEARCH_UPSERT_FLUSH_CHUNKS = 500;
const SEARCH_PROGRESS_EVERY_FILES = 10;

// buildLinkGraph walks the full metadataCache.resolvedLinks map — on a ~42,000-note vault
// that's a real cost, so a build slower than this is logged as a follow-up rather than
// shipped silently. See the WP-6 report for a measured figure.
const SEARCH_LINK_BOOST_SLOW_BUILD_MS = 50;

// Generic "what's worth surfacing" terms appended to a sweep's free-text description so a short
// project brief still matches notes about source material, kits, and guides. Hand-tuned; not
// user-configurable yet.
const SEARCH_SWEEP_QUERY_EXPANSION = 'articles prompt kits project description relevant source repo guide';

// With semantic search on, every debounced keystroke now costs a provider round-trip to embed
// the query *before* the companion is even called — on top of the ~27ms the 3-character gate
// exists to keep companion search at. Two mitigations, both scoped to this SearchManager
// instance (which the plugin holds as a long-lived singleton, so this outlives any one modal
// and also benefits sweep mode reusing a query):
//
// 1. `queryEmbeddingCache` — keyed by trimmed query string. Typing "sustained attention"
//    re-embeds a growing prefix on every debounce tick without it, and pressing Enter would
//    re-embed the exact string type-ahead just embedded. Bounded FIFO eviction (oldest key
//    dropped once the cache is full) rather than a true LRU or a TTL — simplest thing that
//    can't grow without bound, and query strings during one session are a small, mostly-once
//    set, so eviction quality barely matters.
// 2. `embedQueryFailedAt` — once an embed attempt throws, every later `embedQuery` call (any
//    query, not just the failing one) short-circuits to `undefined` without calling the
//    provider again *for the length of the cooldown*. Without any suppression, a downed
//    embedder would show one `Notice` per keystroke and stack a provider round-trip's worth of
//    latency onto every debounce tick.
//
//    The cooldown is deliberately a window and NOT a latch-until-reload. Latching a failure is
//    a mistake this repo has already made and documented: `markCompanionOffline` used to hold
//    the availability gate for 5 minutes on a mid-operation failure, so one spurious timeout
//    made every remaining batch job defer without ever asking the companion again (see the
//    AGENTS.md quirk on the two search timeouts). The embedder is now a `restart:
//    unless-stopped` fleet container, so a container restart or a model reload is a *normal*
//    few-second blip — and a latch would turn that into "semantic is silently off until you
//    happen to reload the plugin", with the single Notice long since dismissed. One minute
//    bounds the cost of a genuine outage to one failed round-trip per minute while recovering
//    from a blip on its own.
//
//    `embedQueryFailureNotified` is separate and *does* latch for the session: the retry is
//    cheap to repeat, a toast is not.
const SEARCH_QUERY_EMBEDDING_CACHE_LIMIT = 50;
const SEARCH_QUERY_EMBED_RETRY_COOLDOWN_MS = 60_000;

// Defensive fallback only — the real default lives in DEFAULT_SETTINGS.searchRerankTopN (30) and
// is what a fresh install actually gets. This exists so a corrupted/zeroed setting can't send an
// empty or absurd document count to the reranker.
const SEARCH_RERANK_DEFAULT_TOP_N = 30;

// The result of an explicit rerank() call — never a type-ahead pipeline stage, always a
// deliberate button click. `results` is the input list with its top-N candidates reordered by
// the reranker and any remainder appended unchanged; `scores` carries each reranked candidate's
// own relevance score keyed by chunkId (SearchModal uses it, together with the pre-rerank order
// it captured itself, to render the "#before → #after" line — see buildRerankRowMeta).
export interface SearchRerankOutcome {
	results: SearchResult[];
	scores: Map<string, number>;
}

// What gets sent to the reranker for a given search hit. Deliberately the same text already
// fetched for the result list (title/heading/snippet) rather than re-reading the source file —
// rerank is already a multi-hundred-ms-to-multi-second operation the user explicitly opted into;
// adding N vault reads on top of that would make it worse for no clearly-demonstrated accuracy
// win, and the snippet is what a user judges relevance by on-screen anyway.
function rerankDocumentText(result: SearchResult): string {
	return [result.title, result.heading, result.snippet].filter(Boolean).join('\n');
}

interface PreparedSearchFile {
	file: TFile;
	content: string;
	contentHash: string;
}

export interface SearchIndexOptions {
	/**
	 * Refuse to write FTS-only chunks when the embedder cannot produce vectors.
	 *
	 * Off (the default) is ordinary indexing: an embedding failure is logged and the batch is
	 * still indexed for keyword search, because keyword search working is better than the file
	 * being absent. On is the backfill path, where FTS-only chunks are the exact wrong outcome —
	 * they would mark the paths done while leaving them uncovered, so a multi-hour job could
	 * complete having produced zero vectors and report success.
	 */
	requireEmbeddings?: boolean;
	/**
	 * Cooperative cancellation for the per-file loop.
	 *
	 * A rebuild batch is the longest-running thing in the queue and its loop lives here,
	 * not in the workflow, so a checkpoint placed only around `indexFiles` would be
	 * useless — a cancelled batch would still chunk and upsert all 100 of its files.
	 * Checked per file, which is the natural item boundary; the signal is the plain Web
	 * API one, so nothing in `src/search` needs to know about orchestration.
	 */
	signal?: AbortSignal;
}

// Everything that isn't already one of the two typed embedding errors becomes "the embedder
// didn't answer", which the backfill workflow defers and retries. A width mismatch stays
// itself, because retrying a misconfiguration forever is not a recovery.
function asEmbeddingBackfillError(e: unknown): Error {
	if (e instanceof SearchEmbeddingMismatchError || e instanceof SearchEmbeddingUnavailableError) return e;
	return new SearchEmbeddingUnavailableError(`embedding failed: ${e instanceof Error ? e.message : String(e)}`);
}

export class SearchManager {
	private readonly availability = new CompanionAvailabilityGate();
	// Built lazily on the first boosted search and reused until the metadata cache says the
	// link graph moved. See linkGraph() for why this cache is load-bearing rather than a
	// micro-optimization.
	private linkGraphCache: LinkGraph | null = null;

	// See the block comment above SEARCH_QUERY_EMBEDDING_CACHE_LIMIT for why these exist and
	// their lifetimes. Neither is reset by resetIndex()/settings changes — a stale cached
	// embedding for a query string is harmless (worst case: one search runs semantic-off for a
	// query it could now answer), so there is no invalidation path to wire up.
	private readonly queryEmbeddingCache = new Map<string, number[] | undefined>();
	private embedQueryFailedAt: number | null = null;
	private embedQueryFailureNotified = false;

	constructor(
		private readonly app: App,
		private readonly settings: CrucibleSettings,
		private readonly providerManager: ProviderManager,
	) {}

	client(): SearchServiceClient {
		return new SearchServiceClient(this.settings.searchServiceUrl, this.settings.searchVaultId);
	}

	async health(): Promise<SearchHealth> {
		return await this.client().health();
	}

	// Single authority on companion availability for both the auto-index path and the
	// orchestration workflows: caches a health probe per TTL window so a burst of jobs makes
	// at most one probe, and a known-down companion short-circuits.
	async companionAvailable(): Promise<boolean> {
		return await this.availability.available(() => this.health());
	}

	// Flip the shared cache to offline when an in-flight operation fails with
	// SearchServiceUnavailableError, so the next call defers without a fresh probe.
	// Why the companion is unavailable, when it told us — see
	// CompanionAvailabilityGate.lastUnavailableReason. Null means it never answered.
	companionUnavailableReason(): string | null {
		return this.availability.lastUnavailableReason();
	}

	// Called when an in-flight operation threw, not when a probe said "down" — so this takes
	// the short transient backoff, and carries the thrown message forward as the reason.
	// Without the reason the deferral falls back to "not reachable at <url>. Start it with
	// home-compose up", which points the user at a container that is already healthy.
	markCompanionOffline(reason?: string): void {
		this.availability.markTransientFailure(reason ?? null);
	}

	async resetIndex(): Promise<void> {
		await this.client().resetIndex();
	}

	async indexFile(file: TFile): Promise<number> {
		const result = await this.indexFiles([file]);
		return result.chunks;
	}

	// Index many files with as few round-trips as possible: build chunks per file, but
	// buffer them across files and flush in bulk upserts. A full rebuild on a large vault
	// collapses from one request/transaction per file to one per ~500 chunks.
	async indexFiles(
		files: TFile[],
		onProgress?: (files: number, chunks: number) => Promise<void>,
		options?: SearchIndexOptions,
	): Promise<{ files: number; chunks: number }> {
		const requireEmbeddings = options?.requireEmbeddings === true;
		// Fail before reading a single file rather than after chunking the vault: a backfill with
		// nothing to embed with is a configuration error, not a transient one, so it must not be
		// deferred-and-retried forever.
		if (requireEmbeddings && !this.activeEmbeddingModelId()) {
			throw new Error('Search: cannot backfill embeddings — semantic search is off or no embedding model is configured (Crucible → Settings → Orchestrate → Search).');
		}
		// Resolved once for the whole operation: it is what both halves of the vector contract are
		// measured against — which space stored vectors must already be in to count as covered,
		// and which space the ones produced here are stamped with. Deriving it can probe the
		// runtime, so it must not sit inside the per-file loop.
		const activeSpace = await this.activeEmbeddingSpaceId();
		const client = this.client();
		let buffer: SearchChunk[] = [];
		let processedFiles = 0;
		let upsertedFiles = 0;
		let totalChunks = 0;
		const preparedFiles: PreparedSearchFile[] = [];

		const flush = async (): Promise<void> => {
			if (buffer.length === 0) return;
			const batch = buffer;
			buffer = [];
			try {
				const embedded = await this.attachEmbeddings(batch, activeSpace);
				// A provider that returns fewer vectors than texts fails just as silently as one
				// that throws, so the strict path checks the count rather than only the throw.
				if (requireEmbeddings && embedded < batch.length) {
					throw new SearchEmbeddingUnavailableError(`the embedder produced vectors for only ${embedded} of ${batch.length} chunks`);
				}
			} catch (e) {
				if (requireEmbeddings) throw asEmbeddingBackfillError(e);
				logWarn('search', 'embedding generation failed; indexing FTS-only chunks for batch', e);
			}
			await client.upsertChunks(batch);
		};

		const signal = options?.signal;
		for (const file of files) {
			// Reading + hashing every file in a batch is itself minutes of work on a large
			// rebuild, so the prepare pass gets its own checkpoint rather than only the
			// indexing pass below.
			signal?.throwIfAborted();
			const prepared = await this.prepareFile(file);
			if (prepared) preparedFiles.push(prepared);
		}

		const fileStates = await this.loadFileStates(client, preparedFiles.map(item => item.file.path));

		for (const prepared of preparedFiles) {
			// Buffered chunks from files already processed are deliberately NOT flushed on
			// the way out: everything upserted so far is already in the index, and the ones
			// still in the buffer belong to files the cancelled run will simply re-index on
			// its next pass (the coverage-aware skip makes that cheap). Flushing a partial
			// buffer would write chunks for a batch the user stopped.
			signal?.throwIfAborted();
			processedFiles++;
			const stored = fileStates.get(prepared.file.path);
			// Content hash alone is not enough to skip: it says the *text* is current, not that
			// the vectors are. Turning semantic search on, or changing the embedding model, leaves
			// every already-indexed file with a matching hash and no usable vectors — which is how
			// "enable semantic later" used to be a silent no-op repairable only by resetIndex().
			if (stored && stored.contentHash === prepared.contentHash && this.embeddingCoverageSatisfied(stored, activeSpace)) {
				if (onProgress && (processedFiles === preparedFiles.length || processedFiles % SEARCH_PROGRESS_EVERY_FILES === 0)) {
					await onProgress(processedFiles, totalChunks);
				}
				continue;
			}
			const chunks = this.buildPreparedFileChunks(prepared);
			upsertedFiles++;
			totalChunks += chunks.length;
			buffer.push(...chunks);
			if (buffer.length >= SEARCH_UPSERT_FLUSH_CHUNKS) await flush();
			if (onProgress && (processedFiles === preparedFiles.length || processedFiles % SEARCH_PROGRESS_EVERY_FILES === 0)) {
				await onProgress(processedFiles, totalChunks);
			}
		}
		await flush();
		// `files` is the count actually re-indexed (content changed), not the number seen — files
		// whose content hash matched are skipped above and don't count.
		return { files: upsertedFiles, chunks: totalChunks };
	}

	// Read + chunk a single file with no embedding or upsert. Returns [] for files that
	// aren't indexable or are excluded from search.
	async buildFileChunks(file: TFile): Promise<SearchChunk[]> {
		const prepared = await this.prepareFile(file);
		if (!prepared) return [];
		return this.buildPreparedFileChunks(prepared);
	}

	/**
	 * The single "does this path belong in the search index" predicate — every indexing path
	 * goes through it, so the three conditions can't drift apart.
	 *
	 * The third condition is Obsidian's own Settings -> Files & links -> "Excluded files"
	 * list. Honoring it here is deliberate: `FileSuggest`/`FolderSuggest`/`folderPicker`
	 * already filter on `isUserIgnored`, so search was the odd surface out. Note the split
	 * with the file-open palette, which *deranks* user-ignored files rather than hiding them
	 * (`FileOpenIndex.isIgnoredPath`) — a path you can still reach by typing its exact name is
	 * useful; a search hit you did not ask for is not.
	 *
	 * Index-time only, exactly like `isPathExcluded`: adding a path to either exclusion list
	 * stops future indexing but does not retroactively purge rows already in the companion's
	 * database. Run `Orchestrate: Search rebuild index` to drop them.
	 */
	private isExcludedFromIndex(path: string): boolean {
		return !isSearchIndexablePath(path, this.settings.searchIndexExtensions)
			|| isPathExcluded(this.settings, path, 'search')
			|| this.app.metadataCache.isUserIgnored(path);
	}

	private async prepareFile(file: TFile): Promise<PreparedSearchFile | null> {
		if (this.isExcludedFromIndex(file.path)) return null;
		const content = await this.app.vault.read(file);
		return {
			file,
			content,
			contentHash: hashSearchContent(content),
		};
	}

	private buildPreparedFileChunks(prepared: PreparedSearchFile): SearchChunk[] {
		const { file, content, contentHash } = prepared;
		return buildSearchChunks({
			vaultId: this.settings.searchVaultId,
			path: file.path,
			basename: file.basename,
			extension: file.extension,
			mtime: file.stat.mtime,
			content,
			contentHash,
			maxChars: this.settings.searchChunkMaxChars,
			overlapChars: this.settings.searchChunkOverlapChars,
		});
	}

	/**
	 * The model id vectors should currently be produced under, or null when vectors are not
	 * part of the contract at all (semantic off, or no model picked).
	 *
	 * Null is load-bearing: it is what keeps embedding coverage *out* of the skip condition when
	 * semantic search is disabled. Folding coverage in unconditionally would make every file in
	 * an FTS-only vault look permanently stale, so every indexing pass would re-read and re-upsert
	 * the whole vault forever.
	 */
	private activeEmbeddingModelId(): string | null {
		if (!this.settings.searchSemanticEnabled) return null;
		const modelId = this.settings.searchEmbeddingModel?.modelId?.trim();
		return modelId ? modelId : null;
	}

	/**
	 * The vector space vectors should currently be produced in, or null when vectors are not part
	 * of the contract at all — the same null, for the same load-bearing reason, as
	 * `activeEmbeddingModelId`.
	 *
	 * Async because deriving it may probe the runtime (WP-2's `describeModel`), so callers resolve
	 * it *once* per operation rather than per file: `indexFiles` hoists it above the loop, and
	 * `search()` resolves it alongside the query embedding. The probe is cached per provider+model
	 * for the session inside `ProviderManager`, so this is not a round-trip per call either way.
	 */
	private async activeEmbeddingSpaceId(): Promise<string | null> {
		const modelId = this.activeEmbeddingModelId();
		if (!modelId) return null;
		return embeddingSpaceId(modelId, await this.activeEmbeddingPrecision(modelId));
	}

	/**
	 * Numeric precision for the space id, in strict precedence: what the runtime says it loaded,
	 * then what the user declared on the model, then nothing.
	 *
	 * The probe wins because it describes the weights actually running; the declared variant is
	 * the fallback for runtimes that cannot self-report (Infinity, vLLM, TEI, plain llama.cpp);
	 * and "nothing" is a first-class answer that degrades the space id to the bare model id.
	 *
	 * Both sides go through `normalizePrecision` — the one normalizer — so a hand-typed `Q4_K_M`
	 * and a probed `q4_k_m` are the same space rather than two, which is the difference between
	 * no re-embed and a full one.
	 */
	private async activeEmbeddingPrecision(modelId: string): Promise<string | undefined> {
		const ref = this.settings.searchEmbeddingModel;
		if (!ref) return undefined;
		const provider = this.settings.providers.find(p => p.id === ref.providerId);
		const declared = normalizePrecision(provider?.models.find(m => m.id === ref.modelId)?.embeddingVariant);
		if (!provider) return declared;
		return (await this.probeEmbeddingPrecision(provider, modelId)) ?? declared;
	}

	/**
	 * Best-effort `describeModel` probe. Every failure mode — a provider kind with no probe, an
	 * injected manager without the method, an unreachable metadata endpoint — is a clean unknown,
	 * never an error and never a guess: an unknown precision degrades the space id to the bare
	 * model id, which is exactly today's behaviour.
	 */
	private async probeEmbeddingPrecision(provider: Provider, modelId: string): Promise<string | undefined> {
		if (typeof this.providerManager.describeModel !== 'function') return undefined;
		try {
			const description = await this.providerManager.describeModel(provider, modelId);
			return normalizePrecision(description.precision);
		} catch {
			return undefined;
		}
	}

	/**
	 * Does the companion's stored state satisfy the *vector* half of "this file is up to date"?
	 *
	 * Three ways to answer no, all of which produce no error anywhere: the path has no vectors, it
	 * has only some (an interrupted backfill), or its vectors are in a different vector space —
	 * mixing two spaces is the failure mode that yields confidently wrong rankings. Unknown
	 * coverage (an older companion that omits the fields) also answers no: re-indexing a file that
	 * did not need it is a wasted read, skipping one that did is a permanent gap.
	 *
	 * The comparison is on the *space*, not the model id, because the model id cannot distinguish
	 * the same weights at two precisions — and a re-index in a genuinely different space is
	 * exactly what has to be detected. It costs nothing on an existing index: with no precision
	 * known the active space id *is* the bare model id, which is what the companion's schema-4
	 * migration wrote into every already-embedded chunk.
	 *
	 * `activeSpace` is resolved once by the caller rather than looked up here, because deriving it
	 * may probe the runtime and this runs once per file.
	 */
	private embeddingCoverageSatisfied(stored: SearchFileState, activeSpace: string | null): boolean {
		if (!activeSpace) return true;
		if (stored.hasEmbeddings !== true) return false;
		return stored.embeddingSpace === activeSpace;
	}

	private async loadFileStates(client: SearchServiceClient, paths: string[]): Promise<Map<string, SearchFileState>> {
		try {
			return await client.fileStates(paths);
		} catch (e) {
			logWarn('search', 'file-state lookup failed; indexing search files normally', e);
			return new Map();
		}
	}

	async deletePath(path: string): Promise<void> {
		if (this.isExcludedFromIndex(path)) return;
		await this.client().deletePath(path);
	}

	async search(query: string, limit?: number): Promise<SearchResponse> {
		const queryEmbedding = await this.embedQuery(query);
		// Only when there is a vector to place — a keyword-only search has no space, and asking
		// for one would probe the runtime on a path that has already decided not to embed.
		const embeddingSpace = queryEmbedding ? (await this.activeEmbeddingSpaceId()) ?? undefined : undefined;
		const response = await this.client().search({
			query,
			limit: limit ?? this.settings.searchResultLimit,
			queryEmbedding,
			embeddingSpace,
		});
		return this.boostSearchResponse(response);
	}

	// Client-side link-adjacency boost (WP-6): reorders the companion's own results using
	// Obsidian's in-memory link graph. Disabled or zero weight skips graph construction
	// entirely — it must never build the graph and then multiply by zero. `sweep()` calls
	// `search()`, so sweeps get the boost too; that's intended, not an oversight.
	private boostSearchResponse(response: SearchResponse): SearchResponse {
		if (!this.settings.searchLinkBoostEnabled || !this.settings.searchLinkBoostWeight) return response;
		if (response.results.length === 0) return response;

		return {
			...response,
			results: applyLinkBoost(response.results, this.linkGraph(), { weight: this.settings.searchLinkBoostWeight }),
		};
	}

	/**
	 * The boost's graph, rebuilt only when the metadata cache has moved since the last build.
	 *
	 * Rebuilding per search cost ~70ms on this vault — over the SEARCH_LINK_BOOST_SLOW_BUILD_MS
	 * budget on its own, and more than the median companion round-trip for a typical query
	 * (~5ms for an 8-character term). Once the modal searches as the user types, that would be
	 * ~70ms of main-thread work per keystroke burst, which is the whole latency budget spent on
	 * a graph that almost never changed between two keystrokes. Invalidation is driven by
	 * `metadataCache.on('resolved')` in main.ts, which is exactly the event that fires when link
	 * resolution has settled after an edit — so a stale graph can outlive an edit only until the
	 * cache finishes resolving it, and the boost is a reordering nudge, never a filter.
	 */
	private linkGraph(): LinkGraph {
		if (this.linkGraphCache) return this.linkGraphCache;

		const start = performance.now();
		this.linkGraphCache = buildLinkGraph(this.app);
		const elapsed = performance.now() - start;
		if (elapsed > SEARCH_LINK_BOOST_SLOW_BUILD_MS) {
			logWarn('search', `link graph build took ${elapsed.toFixed(1)}ms, exceeding the ${SEARCH_LINK_BOOST_SLOW_BUILD_MS}ms budget`);
		}
		return this.linkGraphCache;
	}

	/** Drops the cached link graph; the next boosted search rebuilds it. */
	invalidateLinkGraph(): void {
		this.linkGraphCache = null;
	}

	async sweep(description: string, limit?: number): Promise<SearchResponse> {
		const query = [
			description.trim(),
			SEARCH_SWEEP_QUERY_EXPANSION,
		].filter(Boolean).join('\n');
		return await this.search(query, limit ?? Math.max(this.settings.searchResultLimit, 24));
	}

	/**
	 * Explicit, opt-in rerank of an already-fused result set — never called from the type-ahead
	 * path (only SearchModal's Rerank button calls this). Sends the top `searchRerankTopN`
	 * results to the configured reranker (native `/rerank`, or the complete()-based fallback —
	 * see ProviderManager.rerank) and returns them reordered by relevance, with any results
	 * beyond the top-N appended unchanged.
	 *
	 * Throws rather than degrading when reranking isn't configured or the call fails — this is a
	 * user-initiated action with its own pending UI, not a background degrade-to-FTS path like
	 * embedQuery(), so the caller (SearchModal) surfaces the error and leaves the prior results
	 * exactly as they were.
	 */
	async rerank(query: string, results: SearchResult[]): Promise<SearchRerankOutcome> {
		if (!this.settings.searchRerankEnabled) {
			throw new Error('Reranking is disabled. Enable it in Settings → Orchestrate → Search.');
		}
		const ref = this.settings.searchRerankModel;
		if (!ref) throw new Error('No reranker model configured in Settings → Orchestrate → Search.');
		const trimmedQuery = query.trim();
		if (!trimmedQuery) throw new Error('Cannot rerank without a search query.');
		if (results.length === 0) return { results, scores: new Map() };

		const provider = this.settings.providers.find(p => p.id === ref.providerId);
		if (!provider) throw new Error(`Reranker provider not found: ${ref.providerId}`);
		const model = provider.models.find(m => m.id === ref.modelId);
		if (!model) throw new Error(`Reranker model not found: ${ref.modelId}`);

		const topN = Math.max(1, Math.floor(this.settings.searchRerankTopN) || SEARCH_RERANK_DEFAULT_TOP_N);
		const candidates = results.slice(0, topN);
		const tail = results.slice(topN);
		const documents = candidates.map(rerankDocumentText);

		const { results: rerankResults } = await this.providerManager.rerank(provider, model.id, trimmedQuery, documents);
		// normalizeRerankResults (src/providers/shared.ts) guarantees exactly one entry per
		// candidate index, in range — so every candidate has a score. `?? 0` is defensive only.
		const scoreByIndex = new Map(rerankResults.map(r => [r.index, r.relevanceScore]));
		const ordered = candidates
			.map((result, index) => ({ result, score: scoreByIndex.get(index) ?? 0 }))
			.sort((a, b) => b.score - a.score);

		const scores = new Map<string, number>();
		const reorderedCandidates = ordered.map(({ result, score }) => {
			scores.set(result.chunkId, score);
			return result;
		});

		return { results: [...reorderedCandidates, ...tail], scores };
	}

	listIndexableFiles(): TFile[] {
		return this.app.vault.getFiles().filter(file => !this.isExcludedFromIndex(file.path));
	}

	/**
	 * Attach vectors — and the id of the model that produced them — to a flush batch.
	 * Returns how many chunks actually came back embedded, which the strict backfill path
	 * compares against the batch size.
	 *
	 * Stamping the model per chunk is what makes a later model switch detectable at all: the
	 * companion stores it in `chunks.embedding_model` and reports it through /v1/files/state.
	 * The *space* is stamped alongside it and is the one coverage actually compares — the model id
	 * cannot tell fp32 weights from Q4 ones, which is the whole gap this closes. Both are stored:
	 * the model id stays the answer to "which weights family", the space to "which vector space".
	 */
	private async attachEmbeddings(chunks: SearchChunk[], activeSpace: string | null): Promise<number> {
		if (!this.settings.searchSemanticEnabled || chunks.length === 0) return 0;
		const ref = this.settings.searchEmbeddingModel;
		if (!ref) return 0;
		const modelId = this.activeEmbeddingModelId();
		const texts = chunks.map(chunk => chunk.text);
		const embeddings = await this.embedTexts(ref, texts);
		let embedded = 0;
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const embedding = embeddings[i];
			if (!chunk || !embedding) continue;
			chunk.embedding = embedding;
			if (modelId) chunk.embeddingModel = modelId;
			if (activeSpace) chunk.embeddingSpace = activeSpace;
			embedded++;
		}
		return embedded;
	}

	private async embedQuery(query: string): Promise<number[] | undefined> {
		if (!this.settings.searchSemanticEnabled) return undefined;
		const ref = this.settings.searchEmbeddingModel;
		if (!ref) return undefined;
		// Degrade silently while the embedder is in its post-failure cooldown — see the block
		// comment above SEARCH_QUERY_EMBEDDING_CACHE_LIMIT. Checked before the cache lookup so
		// a cooling-down run never re-attempts even a never-before-seen query string.
		if (this.embedQueryFailedAt !== null && Date.now() - this.embedQueryFailedAt < SEARCH_QUERY_EMBED_RETRY_COOLDOWN_MS) {
			return undefined;
		}

		const trimmed = query.trim();
		if (!trimmed) return undefined;
		if (this.queryEmbeddingCache.has(trimmed)) return this.queryEmbeddingCache.get(trimmed);

		try {
			const embeddings = await this.embedTexts(ref, [trimmed]);
			const embedding = embeddings[0];
			this.embedQueryFailedAt = null;
			this.cacheQueryEmbedding(trimmed, embedding);
			return embedding;
		} catch (e) {
			this.embedQueryFailedAt = Date.now();
			// The retry is cheap to repeat once a minute; a toast per retry is not. So the
			// notice fires once per session even though the attempt does not.
			if (!this.embedQueryFailureNotified) {
				this.embedQueryFailureNotified = true;
				new Notice(`Search: semantic ranking unavailable, falling back to keyword search (${String(e instanceof Error ? e.message : e)})`);
			}
			return undefined;
		}
	}

	private cacheQueryEmbedding(query: string, embedding: number[] | undefined): void {
		if (this.queryEmbeddingCache.size >= SEARCH_QUERY_EMBEDDING_CACHE_LIMIT) {
			const oldestKey: string | undefined = Array.from(this.queryEmbeddingCache.keys())[0];
			if (oldestKey !== undefined) this.queryEmbeddingCache.delete(oldestKey);
		}
		this.queryEmbeddingCache.set(query, embedding);
	}

	private async embedTexts(ref: ProviderModelRef, texts: string[]): Promise<number[][]> {
		const provider = this.settings.providers.find(p => p.id === ref.providerId);
		if (!provider) throw new Error(`Embedding provider not found: ${ref.providerId}`);
		const model = provider.models.find(m => m.id === ref.modelId);
		if (!model) throw new Error(`Embedding model not found: ${ref.modelId}`);
		const batchSize = Math.max(1, Math.min(this.settings.searchIndexBatchSize || 24, 96));
		// Both of these are already computed/configured and were being discarded. Checking them
		// per sub-batch means a width problem surfaces after ≤96 texts instead of after a whole
		// 500-chunk flush has been embedded — and before the upsert, which the companion would
		// reject with a 400 anyway. Embedding is the expensive half; this is what fails fast.
		const configured = model.embeddingDimensions && model.embeddingDimensions > 0
			? Math.floor(model.embeddingDimensions)
			: undefined;
		let observed: number | undefined;
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += batchSize) {
			const result = await this.providerManager.embed(provider, model.id, texts.slice(i, i + batchSize));
			// `dimensions` is what the provider client reported; the first row's length is the
			// fallback for a client that did not report one.
			const dimensions = result.dimensions ?? result.embeddings[0]?.length;
			if (dimensions !== undefined) {
				if (configured !== undefined && dimensions !== configured) {
					throw new SearchEmbeddingMismatchError(`Embedding model "${model.id}" is configured for ${configured} dimensions but returned ${dimensions}. Fix the model's dimensions in provider settings before indexing.`);
				}
				if (observed !== undefined && dimensions !== observed) {
					throw new SearchEmbeddingMismatchError(`Embedding model "${model.id}" returned ${dimensions} dimensions after returning ${observed} earlier in the same request; refusing to mix vector spaces.`);
				}
				observed = dimensions;
			}
			out.push(...result.embeddings);
		}
		return out;
	}
}
