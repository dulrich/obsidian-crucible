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
	mode?: 'fts' | 'vector' | 'hybrid';
	semanticAvailable?: boolean;
	message?: string;
}

export interface SearchQueryOptions {
	query: string;
	limit: number;
	queryEmbedding?: number[];
	filters?: Record<string, unknown>;
}
