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

/**
 * The embedder did not produce the vectors an operation required.
 *
 * Only thrown on the *strict* indexing path (`indexFiles(..., { requireEmbeddings: true })`) —
 * ordinary indexing still degrades to FTS-only when the embedder is down, which is the right
 * default. A backfill whose whole purpose is producing vectors must not: writing FTS-only
 * chunks would mark those paths done and leave them permanently uncovered, reporting success.
 *
 * Treated as retryable by the workflow (a `restart: unless-stopped` embedder blipping is a
 * normal few-second event), so it maps to a deferral rather than a failed job.
 */
export class SearchEmbeddingUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SearchEmbeddingUnavailableError';
	}
}

/**
 * The embedder answered, but with the wrong vector width — either disagreeing with the model's
 * configured `embeddingDimensions`, or drifting between sub-batches of one operation.
 *
 * Deliberately NOT retryable: this is a configuration bug, and the companion would reject the
 * upsert with a 400 anyway. Raising it before the upsert is what saves the expensive half of
 * the operation — the check fires on the first sub-batch (≤96 texts) rather than after a full
 * 500-chunk flush has been embedded.
 */
export class SearchEmbeddingMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SearchEmbeddingMismatchError';
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
	// The id of the model that produced `embedding`, recorded per chunk so a later model switch
	// is detectable. Set only alongside `embedding`; the companion stores it in
	// `chunks.embedding_model` and reports it back through /v1/files/state.
	//
	// The *model* id alone, not provider+model: vector-space compatibility is a property of the
	// model weights, so serving `bge-m3` from Ollama and then from a TEI container is the same
	// space and must not force a full re-embed, while switching to `nomic-embed-text` must.
	embeddingModel?: string;
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
	/**
	 * True only when *every* chunk the companion holds for this path carries a vector.
	 * A partially-embedded path — what an interrupted backfill leaves behind — reports false,
	 * so the remaining chunks are not stranded.
	 *
	 * `undefined` means the companion did not report coverage at all (an older binary). That is
	 * "unknown", and the skip logic treats unknown as *uncovered* rather than covered: silently
	 * skipping is the failure this whole lifecycle exists to remove.
	 */
	hasEmbeddings?: boolean;
	/** How many of `chunkCount` chunks carry a vector. Diagnostic; the boolean drives the skip. */
	embeddedChunkCount?: number;
	/**
	 * The single model id behind this path's vectors, or `undefined` when the chunks disagree,
	 * carry no model attribution, or none are embedded. Undefined therefore fails the
	 * "coverage matches the active model" test closed, which re-embeds rather than trusting
	 * vectors of unknown origin.
	 */
	embeddingModel?: string;
}

export interface SearchQueryOptions {
	query: string;
	limit: number;
	queryEmbedding?: number[];
	filters?: Record<string, unknown>;
}
