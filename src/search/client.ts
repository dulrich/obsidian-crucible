import { RequestUrlResponse, requestUrl } from 'obsidian';
import { SearchChunk, SearchFileState, SearchHealth, SearchQueryOptions, SearchResponse, SearchServiceUnavailableError } from './types';

export { SearchServiceUnavailableError } from './types';

const SEARCH_SERVICE_TIMEOUT_MS = 5000;

export class SearchServiceClient {
	constructor(private readonly baseUrl: string, private readonly vaultId: string) {}

	async health(): Promise<SearchHealth> {
		const response = await this.request('/health', 'GET');
		return normalizeHealth(response.json);
	}

	async resetIndex(): Promise<void> {
		await this.post('/v1/index/reset', { vaultId: this.vaultId });
	}

	async upsertChunks(chunks: SearchChunk[]): Promise<void> {
		if (chunks.length === 0) return;
		await this.post('/v1/chunks/upsert', {
			vaultId: this.vaultId,
			chunks,
		});
	}

	async deletePath(path: string): Promise<void> {
		await this.post('/v1/chunks/delete', {
			vaultId: this.vaultId,
			paths: [path],
		});
	}

	async fileStates(paths: string[]): Promise<Map<string, SearchFileState>> {
		const uniquePaths = Array.from(new Set(paths.filter(path => path.trim().length > 0)));
		if (uniquePaths.length === 0) return new Map();
		const json = await this.post('/v1/files/state', {
			vaultId: this.vaultId,
			paths: uniquePaths,
		});
		return normalizeFileStates(json);
	}

	async search(options: SearchQueryOptions): Promise<SearchResponse> {
		const json = await this.post('/v1/search', {
			vaultId: this.vaultId,
			query: options.query,
			limit: options.limit,
			queryEmbedding: options.queryEmbedding,
			filters: options.filters,
		});
		return normalizeSearchResponse(json);
	}

	private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
		const response = await this.request(path, 'POST', JSON.stringify(body));
		return response.json;
	}

	// Single choke point for companion I/O. Timeouts, connection failures, and 5xx all mean
	// "the companion isn't answering" → SearchServiceUnavailableError (retryable). A 4xx is a
	// genuine request bug and stays a plain Error so it surfaces instead of retrying forever.
	private async request(path: string, method: string, body?: string): Promise<RequestUrlResponse> {
		let response: RequestUrlResponse;
		try {
			response = await withTimeout(requestUrl({
				url: `${this.root()}${path}`,
				method,
				headers: body ? { 'Content-Type': 'application/json' } : undefined,
				body,
			}), SEARCH_SERVICE_TIMEOUT_MS, `Search service ${path} timed out`);
		} catch (e) {
			if (e instanceof SearchServiceUnavailableError) throw e;
			throw new SearchServiceUnavailableError(`Search service ${path} unreachable: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (response.status >= 500) {
			throw new SearchServiceUnavailableError(`Search service ${path} returned ${response.status}: ${response.text}`);
		}
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Search service ${path} returned ${response.status}: ${response.text}`);
		}
		return response;
	}

	private root(): string {
		return (this.baseUrl || 'http://127.0.0.1:4801').replace(/\/$/, '');
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new SearchServiceUnavailableError(message)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function normalizeHealth(value: unknown): SearchHealth {
	if (!value || typeof value !== 'object') return { ok: true };
	const raw = value as Record<string, unknown>;
	return {
		ok: raw.ok !== false,
		version: typeof raw.version === 'string' ? raw.version : undefined,
		schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : undefined,
		vectorAvailable: typeof raw.vectorAvailable === 'boolean' ? raw.vectorAvailable : undefined,
		message: typeof raw.message === 'string' ? raw.message : undefined,
	};
}

function normalizeSearchResponse(value: unknown): SearchResponse {
	if (!value || typeof value !== 'object') return { results: [] };
	const raw = value as Record<string, unknown>;
	const results = Array.isArray(raw.results) ? raw.results : [];
	return {
		results: results.map((item) => {
			const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
			const path = stringField(row.path);
			return {
				chunkId: stringField(row.chunkId) || stringField(row.id),
				path,
				title: stringField(row.title) || path,
				heading: typeof row.heading === 'string' ? row.heading : undefined,
				snippet: stringField(row.snippet) || stringField(row.text),
				score: Number(row.score ?? 0),
				scoreText: typeof row.scoreText === 'number' ? row.scoreText : undefined,
				scoreVector: typeof row.scoreVector === 'number' ? row.scoreVector : undefined,
				scoreRrf: typeof row.scoreRrf === 'number' ? row.scoreRrf : undefined,
				metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : undefined,
			};
		}).filter(row => row.path && row.snippet),
		total: typeof raw.total === 'number' && Number.isFinite(raw.total) ? raw.total : undefined,
		hasMore: typeof raw.hasMore === 'boolean' ? raw.hasMore : undefined,
		mode: raw.mode === 'vector' || raw.mode === 'hybrid' || raw.mode === 'fts' ? raw.mode : undefined,
		semanticAvailable: typeof raw.semanticAvailable === 'boolean' ? raw.semanticAvailable : undefined,
		message: typeof raw.message === 'string' ? raw.message : undefined,
	};
}

function normalizeFileStates(value: unknown): Map<string, SearchFileState> {
	const out = new Map<string, SearchFileState>();
	if (!value || typeof value !== 'object') return out;
	const raw = value as Record<string, unknown>;
	const files = Array.isArray(raw.files) ? raw.files : [];
	for (const item of files) {
		const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
		const path = stringField(row.path);
		if (!path) continue;
		out.set(path, {
			path,
			contentHash: typeof row.contentHash === 'string' && row.contentHash ? row.contentHash : undefined,
			mtime: typeof row.mtime === 'number' && Number.isFinite(row.mtime) ? row.mtime : undefined,
			chunkCount: typeof row.chunkCount === 'number' && Number.isFinite(row.chunkCount) ? row.chunkCount : undefined,
		});
	}
	return out;
}

function stringField(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}
