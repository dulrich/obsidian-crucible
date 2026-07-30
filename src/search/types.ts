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

/**
 * One named thing this chunk is *about* — the unit of the entity facet.
 *
 * **The shape is the forward-compatibility contract, and it is the reason this is an object
 * rather than a bare string.** There are two sources of entities by design and only one of them
 * exists today: `'frontmatter'` (this sprint — the note's `author` field, extracted by
 * `extractFrontmatterEntities` in `chunker.ts`) and `'model'` (later — GLiNER2 span extraction
 * over the body text, which cannot run under crucible-inference and arrives as its own CPU
 * sidecar container). The locked decision behind that: the entity facet is ONE mechanism with
 * two sources, so the model-sourced half must be able to append into this same array, land in
 * the same FTS column, and be scored at the same bm25 weight *without a second schema bump*.
 *
 * `type` and `source` therefore ride on the wire from day one even though the companion flattens
 * every entity to its `text` for indexing (see `normalizeChunkEntities` in
 * `scripts/search-companion.mjs`). They cost nothing to carry, and carrying them is what makes
 * "add GLiNER2" a producer change rather than a protocol change. The companion deliberately
 * accepts a bare string too, so a future producer that only has text is not blocked on this type.
 *
 * `type` is an open string (`'person'` for an author) rather than a union: GLiNER2's label set is
 * configured per deployment, so pinning a union here would make every new label a plugin release.
 */
export interface SearchEntity {
	text: string;
	type: string;
	source: 'frontmatter' | 'model';
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
	/**
	 * The entity facet for this chunk — see `SearchEntity`. Omitted entirely (not `[]`) when the
	 * note names none, so a vault with no `author:` frontmatter sends byte-for-byte the payload it
	 * sent before this facet existed.
	 *
	 * Every chunk of a note carries the note's full entity list, not just chunk 0. That is a
	 * ranking decision, not a convenience: FTS5's implicit AND is per *chunk*, so an entity
	 * present only on chunk 0 could never co-occur with a body term found in chunk 4 — the exact
	 * split-terms failure the WP-4 quality diagnosis identified as the root cause of misses. The
	 * per-path pooling (`MIN(score_text)` in the companion's `SEARCH_SQL`) then collapses the
	 * duplication back to one row per path, so the repetition costs index bytes and nothing else.
	 *
	 * The emitted text is folded into `contentHash` (see `hashSearchContent`), so editing an
	 * author — or changing the extraction rule — re-indexes the note instead of being stranded by
	 * the coverage-aware skip.
	 */
	entities?: SearchEntity[];
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

// Recognized local-model weights file extensions — the tell that a configured/served id is a
// filesystem path rather than a model identity (a served id like `bge-m3` or a Hub-style
// `BAAI/bge-m3` never carries one of these).
const MODEL_WEIGHTS_FILE_EXTENSIONS = /\.(?:gguf|ggml|bin|safetensors|onnx|pt|pth)$/i;

/**
 * Does `modelId` look like a filesystem path rather than a model identity?
 *
 * Two independent tells, either sufficient on its own: an absolute path (llama-server/vLLM mount
 * points are always absolute, e.g. `/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf`), or a
 * trailing weights-file extension (covers a relative mount or a bare filename some configs
 * report, e.g. `bge-m3-f16.gguf`).
 *
 * Deliberately NOT triggered by a bare slash — `BAAI/bge-m3` (Hugging Face Hub org/repo
 * shorthand, what the live index holds today) is a legitimate, portable model id and must key its
 * own space exactly as before. A mount path is path-shaped; a Hub-style id merely contains a
 * separator its own ecosystem uses on purpose.
 */
export function isPathShapedModelId(modelId: string): boolean {
	const trimmed = modelId.trim();
	if (!trimmed) return false;
	return trimmed.startsWith('/') || MODEL_WEIGHTS_FILE_EXTENSIONS.test(trimmed);
}

/**
 * The portable slice of a path-shaped model id: its basename, weights extension stripped.
 *
 * `/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf` → `bge-m3-f16`. A mitigation, not a fix —
 * two servers hosting the same weights under differently-named files (`bge-m3-f16` vs LM
 * Studio's `text-embedding-bge-m3@f16`) still key different spaces, so this must never be
 * presented as making spaces portable *across* servers, only as removing the mount-path/host
 * specificity *within* one.
 *
 * Only meaningful when `isPathShapedModelId(modelId)` is true; callers that skip that check on a
 * non-path id merely get the id back unchanged (basename of a string with no `/` is the string
 * itself, and it carries no weights extension to strip), so calling this unconditionally is safe
 * but the two-step (check, then normalize) form is what documents intent at call sites.
 */
export function normalizePathShapedModelId(modelId: string): string {
	const trimmed = modelId.trim();
	const lastSlash = trimmed.lastIndexOf('/');
	const basename = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
	return basename.replace(MODEL_WEIGHTS_FILE_EXTENSIONS, '');
}

/**
 * The model-identity half of the space key, per the WP-1/WP-5 precedence: an explicit
 * `ProviderModel.embeddingSpaceId` wins outright (it is a stated fact, not an inference); failing
 * that, a path-shaped `id` keys on its normalized basename; failing that, `id` is used verbatim —
 * exactly today's behaviour, which is the no-re-embed guarantee for every model id that was never
 * path-shaped to begin with.
 *
 * Takes only the two plain fields it needs (not the whole `ProviderModel`) so this module — which
 * has no other dependency on `../types` — stays a leaf the companion-facing types can import
 * freely.
 */
export function resolveEmbeddingSpaceModelId(model: { id: string; embeddingSpaceId?: string }): string {
	const explicit = model.embeddingSpaceId?.trim();
	if (explicit) return explicit;
	return isPathShapedModelId(model.id) ? normalizePathShapedModelId(model.id) : model.id;
}

/**
 * The settings-UI half of the portable-space-key fix: what to prefill `ProviderModel.
 * embeddingSpaceId` with after a catalog pick lands `pickedId` in the model's `id` field, or
 * `undefined` to leave the field untouched. Lives beside `isPathShapedModelId`/
 * `normalizePathShapedModelId` (the primitives it composes) rather than in the settings section
 * that calls it, so it stays testable without bundling the settings pane — see
 * `src/settings/sections/ai.ts`'s `ProviderModelSuggest` `onChoose` callback for the call site.
 *
 * Two guards, both load-bearing: (1) never overwrites a value already present — a user-entered
 * override, or one an earlier pick already prefilled, always wins over a later pick; (2) only
 * fires when `pickedId` is path-shaped (`isPathShapedModelId`) — a plain served id, including a
 * Hub-style `BAAI/bge-m3`, is already a fine, portable space key and must not gain a redundant
 * override. See `ProviderModel.embeddingSpaceId`'s doc comment (`src/types.ts`) for why a
 * path-shaped served id — a container mount path — is the one case worth defaulting away from.
 */
export function deriveEmbeddingSpaceIdPrefill(pickedId: string, currentValue: string | undefined): string | undefined {
	if (currentValue?.trim()) return undefined;
	return isPathShapedModelId(pickedId) ? normalizePathShapedModelId(pickedId) : undefined;
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
// Bumped to 6 when `chunks_fts` deletes moved from keying on `vault_id`/`id` (UNINDEXED FTS5
// columns, forcing a full-index scan per delete — measured 24.2ms/delete at the live
// 53k-chunk size, ~17s per 500-chunk upsert flush) to keying on `rowid`. An older companion
// binary's `chunks_fts.rowid` is not pinned to the owning `chunks.rowid`, so a client talking
// to it would have no rowid contract to rely on even though nothing in the wire protocol
// itself changed — the mismatch is entirely server-internal, but the pairing rule still
// applies uniformly rather than special-casing "this bump changed no client-visible field."
// Bumped to 7 for the entity facet: `chunks.entities` plus a dedicated indexed `entities` column
// on `chunks_fts` (see `SearchEntity`). An older companion binary has neither, so it would accept
// every `chunk.entities` this client sends and silently drop it — the note would index, report a
// current `contentHash`, and never match its own author. That is a silent permanent gap of
// exactly the kind the pairing rule exists to turn into a loud "rebuild required".
export const SEARCH_REQUIRED_SCHEMA_VERSION = 7;

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
	/**
	 * WP-5: the companion hit its own cooperative per-request deadline and returned a
	 * well-formed *partial* response — the zero-hit rescue was skipped, the coverage leg stopped
	 * scanning further terms, or the vector leg was skipped outright — rather than blocking until
	 * every leg finished. Additive and optional: an in-budget response omits the field entirely
	 * (byte-identical to the pre-WP-5 shape), and a companion that predates this change never
	 * sends it, which normalizes to the same `undefined`. The client does not retry on this — a
	 * degraded response is still a real, ranked answer, just possibly missing the rescue/coverage/
	 * vector contribution.
	 */
	degraded?: boolean;
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

/**
 * Which ranking the companion should apply to this request. Two candidate directions from the
 * WP-4 quality diagnosis, implemented behind this flag so a bake-off can measure them against
 * each other before either becomes the default:
 *
 * - `current` — the shipped ranking (strict per-chunk AND, loose-OR only as a zero-hit rescue).
 * - `blend` — always run the loose-OR fallback too and union its pooled rows into the pool.
 * - `coverage` — add a document-level term-coverage leg as a fourth RRF-fused rank.
 * - `blend+coverage` — both.
 *
 * Omitting the field means `current`, so a plugin that never sets it gets exactly today's
 * behavior; the companion answers a *present but unrecognized* value with a 400 rather than
 * quietly ranking by something other than what was asked for.
 */
export type SearchRankingMode = 'current' | 'blend' | 'coverage' | 'blend+coverage';

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
	/**
	 * Opt out of the companion's default ranking for this one request. Left undefined by every
	 * plugin call site today — the field is not sent at all then, so no companion behavior
	 * changes — and set only by measurement harnesses until a bake-off picks a winner.
	 */
	rankingMode?: SearchRankingMode;
	filters?: Record<string, unknown>;
}
