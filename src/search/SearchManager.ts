import { App, Notice, TFile } from 'obsidian';
import { CrucibleSettings, ProviderModelRef } from '../types';
import { ProviderManager } from '../providers';
import { buildSearchChunks, hashSearchContent, isSearchIndexablePath } from './chunker';
import { SearchServiceClient } from './client';
import { CompanionAvailabilityGate } from './lifecycleGate';
import { applyLinkBoost, buildLinkGraph, LinkGraph } from './linkGraph';
import { SearchChunk, SearchFileState, SearchHealth, SearchResponse } from './types';
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

interface PreparedSearchFile {
	file: TFile;
	content: string;
	contentHash: string;
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
	): Promise<{ files: number; chunks: number }> {
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
				await this.attachEmbeddings(batch);
			} catch (e) {
				logWarn('search', 'embedding generation failed; indexing FTS-only chunks for batch', e);
			}
			await client.upsertChunks(batch);
		};

		for (const file of files) {
			const prepared = await this.prepareFile(file);
			if (prepared) preparedFiles.push(prepared);
		}

		const fileStates = await this.loadFileStates(client, preparedFiles.map(item => item.file.path));

		for (const prepared of preparedFiles) {
			processedFiles++;
			const stored = fileStates.get(prepared.file.path);
			if (stored?.contentHash === prepared.contentHash) {
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
		const response = await this.client().search({
			query,
			limit: limit ?? this.settings.searchResultLimit,
			queryEmbedding,
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

	listIndexableFiles(): TFile[] {
		return this.app.vault.getFiles().filter(file => !this.isExcludedFromIndex(file.path));
	}

	private async attachEmbeddings(chunks: SearchChunk[]): Promise<void> {
		if (!this.settings.searchSemanticEnabled || chunks.length === 0) return;
		const ref = this.settings.searchEmbeddingModel;
		if (!ref) return;
		const texts = chunks.map(chunk => chunk.text);
		const embeddings = await this.embedTexts(ref, texts);
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const embedding = embeddings[i];
			if (chunk && embedding) chunk.embedding = embedding;
		}
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
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += batchSize) {
			const result = await this.providerManager.embed(provider, model.id, texts.slice(i, i + batchSize));
			out.push(...result.embeddings);
		}
		return out;
	}
}
