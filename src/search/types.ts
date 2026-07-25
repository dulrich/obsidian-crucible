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

// The companion index schema this plugin build knows how to query. Bumped to 2 when
// `chunks_fts` gained FTS5 `prefix='2 3'`; bumped to 3 when embeddings moved from
// `embedding_json TEXT` to `embedding BLOB` + `embedding_dim` + `embedding_model` and the
// companion's vector leg started reading them. A companion reporting less than this is
// serving an index the current client cannot rely on, so the client flags "rebuild required"
// instead of silently degrading. The companion migrates its own on-disk schema on startup
// (additive ALTERs, plus the FTS rebuild), so the only mismatch that can survive is an older
// companion binary/image — which is why this constant and the companion's SCHEMA_VERSION are
// always bumped in the same change.
export const SEARCH_REQUIRED_SCHEMA_VERSION = 3;

export interface SearchHealth {
	ok: boolean;
	version?: string;
	schemaVersion?: number;
	vectorAvailable?: boolean;
	message?: string;
	rebuildRequired?: boolean;
}

// Per-stage score attribution: the base score, every boost that fired, and the fused value,
// so ranking is tunable by observation instead of guesswork. `boosts` is the open slot for
// client-side stages (link adjacency, recency) to record their own contribution.
export interface SearchScoreAttribution {
	base?: number;
	textRank?: number;
	titleRank?: number;
	titleBoost?: number;
	// Rank in the vector (cosine) list of the third RRF leg — undefined when this row never
	// entered that list (no vectors indexed, or no query embedding arrived).
	vectorRank?: number;
	rrf?: number;
	pooledChunks?: number;
	boosts?: Record<string, number>;
}

export interface SearchResult {
	chunkId: string;
	path: string;
	title: string;
	heading?: string;
	snippet: string;
	// Higher is better, everywhere. The companion negates bm25 (negative/lower-is-better in
	// SQL) on the way out, and the fused RRF value is positive by construction.
	score: number;
	scoreText?: number;
	scoreVector?: number;
	scoreRrf?: number;
	metadata?: Partial<SearchDocumentMetadata>;
	attribution?: SearchScoreAttribution;
}

export interface SearchResponse {
	results: SearchResult[];
	total?: number;
	hasMore?: boolean;
	mode?: 'fts' | 'vector' | 'hybrid';
	semanticAvailable?: boolean;
	message?: string;
	schemaVersion?: number;
	rebuildRequired?: boolean;
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
