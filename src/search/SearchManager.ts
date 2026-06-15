import { App, Notice, TFile } from 'obsidian';
import { CrucibleSettings, ProviderModelRef } from '../types';
import { ProviderManager } from '../providers';
import { buildSearchChunks, isSearchIndexablePath } from './chunker';
import { SearchServiceClient } from './client';
import { SearchChunk, SearchHealth, SearchResponse } from './types';
import { logWarn } from '../log';
import { isPathExcluded } from '../exclusions';

// Flush the upsert buffer once it reaches this many chunks. Each flush is one HTTP
// request and one SQLite transaction on the companion, so batching across files keeps
// a full rebuild to a handful of round-trips instead of one per file. ~500 chunks is
// well under the companion's 20MB request-body cap.
const SEARCH_UPSERT_FLUSH_CHUNKS = 500;
const SEARCH_PROGRESS_EVERY_FILES = 10;

export class SearchManager {
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
		let indexedFiles = 0;
		let totalChunks = 0;

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
			indexedFiles++;
			const chunks = await this.buildFileChunks(file);
			totalChunks += chunks.length;
			buffer.push(...chunks);
			if (buffer.length >= SEARCH_UPSERT_FLUSH_CHUNKS) await flush();
			if (onProgress && (indexedFiles === files.length || indexedFiles % SEARCH_PROGRESS_EVERY_FILES === 0)) {
				await onProgress(indexedFiles, totalChunks);
			}
		}
		await flush();
		return { files: indexedFiles, chunks: totalChunks };
	}

	// Read + chunk a single file with no embedding or upsert. Returns [] for files that
	// aren't indexable or are excluded from search.
	async buildFileChunks(file: TFile): Promise<SearchChunk[]> {
		if (!isSearchIndexablePath(file.path) || isPathExcluded(this.settings, file.path, 'search')) return [];
		const content = await this.app.vault.read(file);
		return buildSearchChunks({
			vaultId: this.settings.searchVaultId,
			path: file.path,
			basename: file.basename,
			extension: file.extension,
			mtime: file.stat.mtime,
			content,
			maxChars: this.settings.searchChunkMaxChars,
			overlapChars: this.settings.searchChunkOverlapChars,
		});
	}

	async deletePath(path: string): Promise<void> {
		if (!isSearchIndexablePath(path) || isPathExcluded(this.settings, path, 'search')) return;
		await this.client().deletePath(path);
	}

	async search(query: string, limit?: number): Promise<SearchResponse> {
		const queryEmbedding = await this.embedQuery(query);
		return await this.client().search({
			query,
			limit: limit ?? this.settings.searchResultLimit,
			queryEmbedding,
		});
	}

	async sweep(description: string, limit?: number): Promise<SearchResponse> {
		const query = [
			description.trim(),
			'articles prompt kits project description relevant source repo guide',
		].filter(Boolean).join('\n');
		return await this.search(query, limit ?? Math.max(this.settings.searchResultLimit, 24));
	}

	listIndexableFiles(): TFile[] {
		return this.app.vault.getFiles().filter(file => isSearchIndexablePath(file.path) && !isPathExcluded(this.settings, file.path, 'search'));
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
