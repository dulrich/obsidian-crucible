/**
 * Why the companion did not answer, distinct from "did it answer" — a probe result of
 * `refused` or `server-error` is confirmed evidence the service is down or broken; `timeout`
 * is not, because a single-threaded, synchronous-SQLite companion mid-flush on our own bulk
 * write simply does not get to the event loop in time. Treating the two the same is the bug
 * this type exists to remove: see the WP-5 residue in `plans/sprint-exit-queue-health-and-scrub.md`.
 *
 * - `refused` — the request never reached a server (connection refused/reset, DNS failure,
 *   or any other transport-level failure below the HTTP layer).
 * - `timeout` — the client gave up waiting; the companion may still be working.
 * - `server-error` — the companion answered with a 5xx: a confirmed, reachable failure.
 */
export type SearchServiceUnavailableErrorKind = 'refused' | 'timeout' | 'server-error';

// Thrown by SearchServiceClient when the companion does not respond successfully —
// timeouts, connection failures, and 5xx. Callers branch on this (instanceof) to defer
// + retry, instead of sniffing error message text. A 4xx is a real (non-retryable) bug
// and stays a plain Error.
export class SearchServiceUnavailableError extends Error {
	// Defaults to 'refused': every construction site in `client.ts` passes an explicit kind,
	// but a default keeps any other (test, future) call site conservative — refused is the
	// kind that earns the immediate confirmed-outage latch, which is the safe assumption for
	// an unclassified failure.
	constructor(message: string, public readonly kind: SearchServiceUnavailableErrorKind = 'refused') {
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

/**
 * The configured `{providerId, modelId}` embedding ref cannot ever succeed as it stands: the
 * provider is gone, the model id is not (or no longer) in that provider's catalog, or the
 * provider rejected the request outright with a 4xx. None of these self-heal on the next batch,
 * on the next restart, or ever — unlike `SearchEmbeddingUnavailableError`, retrying changes
 * nothing.
 *
 * The incident this exists for: renaming a model's id in the provider catalog does not rewrite
 * the saved ref, so `provider.models.find(m => m.id === ref.modelId)` silently stops matching.
 * Before this type existed every embed failure — orphaned ref or a genuinely offline embedder —
 * came out of `embedTexts` as the same plain `Error`, which is indistinguishable from the
 * transient case, so a stale ref got deferred and retried forever. Grouped with
 * `SearchEmbeddingMismatchError` wherever "is this a config error" is asked (both are permanent,
 * neither self-heals) — kept as a separate class because the *cause* (an unresolved ref vs. a
 * resolved model returning the wrong width) is worth keeping in the error's own name.
 */
export class SearchEmbeddingConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SearchEmbeddingConfigError';
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
	/**
	 * Which vector space `embedding` lives in — the identity that decides whether two vectors may
	 * be compared at all. See `embeddingSpaceId`.
	 *
	 * Separate from `embeddingModel` because they answer different questions: the model id says
	 * *which weights family*, the space id says *which vector space*, and the model id alone
	 * cannot express the second. Two engines serving "bge-m3" at fp32 and at Q4 report the same
	 * model id and the same 1024 width, so nothing else in the system can tell them apart.
	 *
	 * The companion stores it in `chunks.embedding_space`, reports it through /v1/files/state,
	 * and — the load-bearing part — filters the vector scan by it.
	 */
	embeddingSpace?: string;
}

/**
 * The vector-space identity of a model at a given numeric precision.
 *
 * `bge-m3` + `f16` → `bge-m3/f16`; `bge-m3` + nothing → `bge-m3`.
 *
 * The no-precision fall-through is not a corner case, it is the live path — Infinity (the
 * current embedder) exposes no dtype at all, so `precision` is `undefined` on every probe — and
 * it is doing two jobs at once. It preserves the `SearchChunk.embeddingModel` principle above
 * (same weights on a different host stay one space), and it makes the schema-4 migration free:
 * the companion backfills `embedding_space = embedding_model`, which is exactly what this
 * returns when no precision is known, so every already-embedded chunk stays covered and nothing
 * re-embeds.
 *
 * Hence the guards: an absent, blank, or non-string precision must yield the bare model id, never
 * a trailing `/`, never the literal string `"undefined"`. Either would be a *different* space id
 * from the migration's, which would silently re-embed the entire vault.
 *
 * The result is an opaque key — compared for equality, never parsed back apart — so a model id
 * that already contains a slash (`BAAI/bge-m3`, which is what the live index holds) is fine.
 */
export function embeddingSpaceId(modelId: string, precision?: string): string {
	const model = modelId.trim();
	const tag = typeof precision === 'string' ? precision.trim() : '';
	return tag ? `${model}/${tag}` : model;
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
// Bumped to 4 for `chunks.embedding_space`. An older companion binary cannot store it or filter
// the scan by it, so it would load vectors from two spaces into one matrix and cosine-score them
// against each other — precisely the silent failure that column exists to remove.
// Bumped to 5 for `chunks PRIMARY KEY (vault_id, id)`. An older companion binary still keys
// chunks on `id` alone, so two vaults sharing it silently destroy each other's rows — the
// mismatch no client-side change can compensate for. Note the consequence of honouring the
// pairing rule here: between a plugin update and a container rebuild, health reports
// `ok: false` and search is *unavailable*, not degraded. Rebuild the companion image in the
// same landing.
export const SEARCH_REQUIRED_SCHEMA_VERSION = 5;

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
	/**
	 * The single vector space behind this path's vectors, under exactly the same fail-closed
	 * conjunction as `embeddingModel` — at least one embedded chunk, one distinct non-null value,
	 * every embedded chunk labelled — and `undefined` otherwise.
	 *
	 * This, not `embeddingModel`, is what `embeddingCoverageSatisfied` compares: it is the
	 * identity that decides whether stored vectors can be scored against ones produced now.
	 * `undefined` also covers an older companion that omits the field entirely, and re-embeds
	 * rather than trusting — skipping a file that needed work is a silent permanent gap, while
	 * re-indexing one that did not costs a read.
	 */
	embeddingSpace?: string;
}

export interface SearchQueryOptions {
	query: string;
	limit: number;
	queryEmbedding?: number[];
	/**
	 * The vector space `queryEmbedding` was produced in. The companion scans only vectors from
	 * this space; a vault holding more than one degrades to keyword-only with an explanation
	 * rather than scoring across spaces. Omitted when there is no query embedding to place.
	 */
	embeddingSpace?: string;
	filters?: Record<string, unknown>;
}
