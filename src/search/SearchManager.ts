import { App, Notice, TFile } from 'obsidian';
import { CrucibleSettings, ProviderModelRef } from '../types';
import { ProviderManager } from '../providers';
import { buildSearchChunks, hashSearchContent, isSearchIndexablePath } from './chunker';
import { SearchServiceClient } from './client';
import { CompanionAvailabilityGate } from './lifecycleGate';
import { applyLinkBoost, buildLinkGraph } from './linkGraph';
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

interface PreparedSearchFile {
	file: TFile;
	content: string;
	contentHash: string;
}

export class SearchManager {
	private readonly availability = new CompanionAvailabilityGate();

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

	private async prepareFile(file: TFile): Promise<PreparedSearchFile | null> {
		if (!isSearchIndexablePath(file.path, this.settings.searchIndexExtensions) || isPathExcluded(this.settings, file.path, 'search')) return null;
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
		if (!isSearchIndexablePath(path, this.settings.searchIndexExtensions) || isPathExcluded(this.settings, path, 'search')) return;
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

		const start = performance.now();
		const graph = buildLinkGraph(this.app);
		const elapsed = performance.now() - start;
		if (elapsed > SEARCH_LINK_BOOST_SLOW_BUILD_MS) {
			logWarn('search', `link graph build took ${elapsed.toFixed(1)}ms, exceeding the ${SEARCH_LINK_BOOST_SLOW_BUILD_MS}ms budget`);
		}

		return {
			...response,
			results: applyLinkBoost(response.results, graph, { weight: this.settings.searchLinkBoostWeight }),
		};
	}

	async sweep(description: string, limit?: number): Promise<SearchResponse> {
		const query = [
			description.trim(),
			SEARCH_SWEEP_QUERY_EXPANSION,
		].filter(Boolean).join('\n');
		return await this.search(query, limit ?? Math.max(this.settings.searchResultLimit, 24));
	}

	listIndexableFiles(): TFile[] {
		return this.app.vault.getFiles().filter(file => isSearchIndexablePath(file.path, this.settings.searchIndexExtensions) && !isPathExcluded(this.settings, file.path, 'search'));
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
		try {
			const embeddings = await this.embedTexts(ref, [query]);
			return embeddings[0];
		} catch (e) {
			new Notice(`Search: semantic query disabled for this run (${String(e instanceof Error ? e.message : e)})`);
			return undefined;
		}
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
