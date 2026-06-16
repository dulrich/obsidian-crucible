// Thrown by SearchServiceClient when the companion does not respond successfully —
// timeouts, connection failures, and 5xx. Callers branch on this (instanceof) to defer
// + retry, instead of sniffing error message text. A 4xx is a real (non-retryable) bug
// and stays a plain Error.
export class SearchServiceUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SearchServiceUnavailableError';
	}
}

export interface SearchDocumentMetadata {
	title: string;
	created?: string;
	modified?: string;
	source?: string;
	tags: string[];
	frontmatter: Record<string, unknown>;
}

export interface SearchChunk {
	id: string;
	vaultId: string;
	path: string;
	contentHash: string;
	title: string;
	heading: string;
	text: string;
	mtime: number;
	ordinal: number;
	metadata: SearchDocumentMetadata;
	embedding?: number[];
}

export interface SearchHealth {
	ok: boolean;
	version?: string;
	schemaVersion?: number;
	vectorAvailable?: boolean;
	message?: string;
}

export interface SearchResult {
	chunkId: string;
	path: string;
	title: string;
	heading?: string;
	snippet: string;
	score: number;
	scoreText?: number;
	scoreVector?: number;
	scoreRrf?: number;
	metadata?: Partial<SearchDocumentMetadata>;
}

export interface SearchResponse {
	results: SearchResult[];
	total?: number;
	hasMore?: boolean;
	mode?: 'fts' | 'vector' | 'hybrid';
	semanticAvailable?: boolean;
	message?: string;
}

export interface SearchFileState {
	path: string;
	contentHash?: string;
	mtime?: number;
	chunkCount?: number;
}

export interface SearchQueryOptions {
	query: string;
	limit: number;
	queryEmbedding?: number[];
	filters?: Record<string, unknown>;
}
