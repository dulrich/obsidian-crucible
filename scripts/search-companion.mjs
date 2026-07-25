#!/usr/bin/env node
/* global process */
import { createServer } from 'node:http';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// Zero-dependency search companion: Node builtins only. There is no `npm install` step in
// the Dockerfile (it copies exactly this one file), so any import outside `node:*` silently
// breaks the container image.
//
// Module shape: every pure ranking helper is exported and the server bootstrap sits behind
// the `isMainModule()` guard at the bottom, so `import`ing this file for unit tests neither
// opens a database nor binds a port.

// Bumped from 1 when `chunks_fts` gained `prefix='2 3'`, which is what makes the `term*`
// expansion in buildFtsQuery cheap. An index built under schema 1 has no prefix table, so
// the client treats an older companion as "index rebuild required" rather than silently
// serving a degraded index.
//
// Bumped to 3 when embeddings moved from `embedding_json TEXT` to `embedding BLOB` +
// `embedding_dim` + `embedding_model` and the vector leg started reading them. The client's
// half of that contract is SEARCH_REQUIRED_SCHEMA_VERSION in `src/search/types.ts` — the two
// are bumped together, always.
export const SCHEMA_VERSION = 3;
export const SERVICE_VERSION = 'dev-fts-rrf-vector';

// bm25() takes one weight per column, including the UNINDEXED ones (they never match, so
// their weights are inert but the arity must line up). Unweighted bm25 let a body mention
// outrank a title match; title >> heading >> text is the whole point of the ranking upgrade.
const BM25_WEIGHTS = [0, 0, 0, 10.0, 5.0, 1.0];

const MAX_QUERY_TERMS = 24;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;

// The fused ranking needs a candidate pool deeper than the requested page: a page whose
// title matches the query can sit well below the top `limit` on raw bm25 and still deserve
// the first slot after fusion.
const SEARCH_POOL_FACTOR = 4;
const SEARCH_POOL_MIN = 40;

// Reciprocal-rank fusion constant. 60 is the value from the original RRF paper and the one
// every mainstream implementation uses; it flattens the head of each list enough that a
// strong second-list hit can overtake a weak first-list leader without swamping it.
export const RRF_K = 60;
export const RRF_TITLE_WEIGHT = 1.0;
// The vector list joins the fusion on exactly the same footing as the title list: same k,
// same reciprocal-rank shape, weight 1.0. A weight is the knob if one list turns out to
// deserve more say — it is deliberately not a score blend, because bm25 and cosine are not
// commensurable scales but their ranks are.
export const RRF_VECTOR_WEIGHT = 1.0;

// Hydration for a path the vector scan found but the FTS pool never returned. Those rows
// have no bm25 score and no FTS snippet (they did not match), so the snippet is built from
// the chunk text — see makeTextSnippet.
const HYDRATE_CHUNK_SQL = 'SELECT id, path, title, heading, text, metadata_json FROM chunks WHERE id = ?';

const FTS_TABLE_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  id UNINDEXED,
  vault_id UNINDEXED,
  path UNINDEXED,
  title,
  heading,
  text,
  prefix='2 3'
)`;

const FTS_REFILL_SQL = `INSERT INTO chunks_fts (id, vault_id, path, title, heading, text)
SELECT id, vault_id, path, title, heading, text FROM chunks`;

// One pooled query replaces the old two-query shape (ranked chunks + a second full
// `COUNT(*) MATCH` just for `total`, which doubled FTS work on every search):
//   * `matched` scores raw chunks with weighted bm25;
//   * `pooled` collapses to one row per path via MIN(score_text) — best chunk wins. SQLite
//     guarantees the bare columns (id/heading/snippet/...) come from the row that produced
//     the min when the query has exactly one min()/max() aggregate, so the winning chunk's
//     snippet and heading ride along for free;
//   * COUNT(*) OVER () is evaluated before LIMIT, so `total` is the distinct-path match
//     count without a second MATCH.
// `MATERIALIZED` is load-bearing, not a hint: without it SQLite flattens `matched` into the
// aggregate query and bm25()/snippet() throw "unable to use function bm25 in the requested
// context" — FTS5 auxiliary functions are illegal in an aggregate context.
const SEARCH_SQL = `
WITH matched AS MATERIALIZED (
  SELECT c.id AS id,
         c.path AS path,
         c.title AS title,
         c.heading AS heading,
         c.metadata_json AS metadata_json,
         snippet(chunks_fts, 5, '', '', '...', 18) AS snippet,
         bm25(chunks_fts, ${BM25_WEIGHTS.map(weight => weight.toFixed(1)).join(', ')}) AS score_text
  FROM chunks_fts
  JOIN chunks c ON c.id = chunks_fts.id
  WHERE chunks_fts.vault_id = ? AND chunks_fts MATCH ?
),
pooled AS (
  SELECT path,
         id,
         title,
         heading,
         metadata_json,
         snippet,
         MIN(score_text) AS score_text,
         COUNT(*) AS pooled_chunks
  FROM matched
  GROUP BY path
)
SELECT id, path, title, heading, metadata_json, snippet, score_text, pooled_chunks,
       COUNT(*) OVER () AS total_paths
FROM pooled
ORDER BY score_text, path
LIMIT ?
`;

export function createSchema(db) {
	db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  heading TEXT NOT NULL,
  text TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  embedding BLOB,
  embedding_dim INTEGER,
  embedding_model TEXT
);
${FTS_TABLE_SQL};
CREATE INDEX IF NOT EXISTS idx_chunks_vault_path ON chunks(vault_id, path);
`);

	// Additive ALTERs, the same precedent `content_hash` set: a drop/refill of `chunks` would
	// throw away the FTS-backing content for no reason. `embedding_json` (schema 2) is left in
	// place on a migrated database — it is never read or written again, and every row in the
	// live index has it NULL because `searchSemanticEnabled` has always defaulted false, so
	// there is nothing to convert. A freshly created database simply never has the column.
	const chunkColumns = db.prepare('PRAGMA table_info(chunks)').all().map(row => row.name);
	if (!chunkColumns.includes('content_hash')) {
		db.exec("ALTER TABLE chunks ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
	}
	if (!chunkColumns.includes('embedding')) db.exec('ALTER TABLE chunks ADD COLUMN embedding BLOB');
	if (!chunkColumns.includes('embedding_dim')) db.exec('ALTER TABLE chunks ADD COLUMN embedding_dim INTEGER');
	if (!chunkColumns.includes('embedding_model')) db.exec('ALTER TABLE chunks ADD COLUMN embedding_model TEXT');
	db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_vault_path_hash ON chunks(vault_id, path, content_hash)');
	return migrateFtsSchema(db);
}

// `CREATE VIRTUAL TABLE IF NOT EXISTS` is a no-op against a database whose chunks_fts was
// built under schema 1, so an existing index would keep its prefix-less FTS table forever
// and every `term*` query would fall back to a full scan. `chunks` holds every indexed
// column, so the FTS table is fully derivable: drop and refill it in one transaction. That
// is lossless and deterministic, needs no user action, and leaves no window in which a
// stale FTS table serves queries. Returns true when a migration actually ran.
export function migrateFtsSchema(db) {
	const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'").get();
	const sql = typeof row?.sql === 'string' ? row.sql : '';
	if (!sql || /prefix\s*=/i.test(sql)) return false;
	db.exec('BEGIN');
	try {
		db.exec('DROP TABLE chunks_fts');
		db.exec(FTS_TABLE_SQL);
		db.exec(FTS_REFILL_SQL);
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
	return true;
}

export function openDatabase(dbPath) {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	createSchema(db);
	return db;
}

// An error whose HTTP status is part of the contract. Everything else falls through to a
// 500. The distinction matters: `SearchServiceClient` turns *any* 5xx into
// SearchServiceUnavailableError, which the UI renders as "the companion is not reachable —
// start it with home-compose up crucible-search". A malformed request answered with a 500
// therefore sends the user to restart a container that is perfectly healthy, so every
// request-side rejection (a bad vector, a width conflict) must be a 4xx.
export class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
	}
}

// ── Embedding storage ────────────────────────────────────────────────────────────────────
// float32 little-endian, stored as a BLOB. The size win over JSON (~2.7×) is the small
// reason; the real one is that a BLOB reads straight into a Float32Array with zero parse,
// so building the matrix is a memcpy per row instead of 52k JSON.parse calls on the first
// query after wake. Do not reintroduce a JSON hop.
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function encodeEmbedding(values) {
	const floats = values instanceof Float32Array ? values : Float32Array.from(values);
	if (IS_LITTLE_ENDIAN) return new Uint8Array(floats.buffer.slice(floats.byteOffset, floats.byteOffset + floats.byteLength));
	const bytes = new Uint8Array(floats.length * 4);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < floats.length; i++) view.setFloat32(i * 4, floats[i], true);
	return bytes;
}

export function decodeEmbedding(blob) {
	const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
	const dim = Math.floor(bytes.length / 4);
	const out = new Float32Array(dim);
	writeEmbeddingInto(out, 0, bytes, dim);
	return out;
}

// Copies one stored vector into `target` at `offset` floats. On a little-endian host (every
// platform this runs on) that is a straight byte copy into the matrix's own buffer; the
// DataView branch exists so a big-endian host reads the same bytes correctly rather than
// silently scoring garbage.
function writeEmbeddingInto(target, offset, bytes, dim) {
	if (IS_LITTLE_ENDIAN) {
		const view = new Uint8Array(target.buffer, target.byteOffset + offset * 4, dim * 4);
		view.set(bytes.subarray(0, dim * 4));
		return;
	}
	const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let i = 0; i < dim; i++) target[offset + i] = source.getFloat32(i * 4, true);
}

// Vectors are stored L2-normalised so cosine similarity is a plain dot product. The client
// is not trusted to have normalised — both provider clients return whatever the model
// produced — so normalisation happens here, on write and on the query vector.
export function normalizeEmbedding(values) {
	const length = Number(values?.length ?? 0);
	const floats = new Float32Array(length);
	let sum = 0;
	for (let i = 0; i < length; i++) {
		const value = values[i];
		// Strictly a number, not merely coercible: `null` and `''` both coerce to 0, which
		// would quietly turn a corrupt vector into a valid-looking one pointing somewhere
		// else in the space.
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new HttpError(400, `embedding[${i}] is not a finite number`);
		}
		floats[i] = value;
		sum += floats[i] * floats[i];
	}
	const norm = Math.sqrt(sum);
	if (!(norm > 0) || !Number.isFinite(norm)) throw new HttpError(400, 'embedding must not be a zero vector');
	for (let i = 0; i < floats.length; i++) floats[i] = floats[i] / norm;
	return floats;
}

// Validation for one inbound chunk embedding. Returns null when the chunk carries none
// (FTS-only indexing stays the default), throws HttpError(400) on anything malformed.
export function prepareChunkEmbedding(embedding, model) {
	if (embedding === undefined || embedding === null) return null;
	if (!Array.isArray(embedding) && !ArrayBuffer.isView(embedding)) {
		throw new HttpError(400, 'chunk.embedding must be an array of numbers');
	}
	if (embedding.length === 0) throw new HttpError(400, 'chunk.embedding must not be empty');
	const floats = normalizeEmbedding(embedding);
	const modelId = typeof model === 'string' && model.trim() !== '' ? model.trim() : null;
	return { bytes: encodeEmbedding(floats), dim: floats.length, model: modelId };
}

// ── The vector backend seam ──────────────────────────────────────────────────────────────
// Everything about *how* similarity is computed lives behind this factory. The rest of the
// companion only ever calls `stats`, `knn` and `invalidate`, and nothing outside it may
// assume a flat array or an in-process scan. That is what makes the documented escape
// hatches a swap rather than a rewrite: a `vec0` (sqlite-vec) backend becomes a `knn` that
// runs `SELECT ... MATCH` instead of a loop, and the worker-sharded variant becomes a `knn`
// that fans the same matrix — already one flat Float32Array — over a SharedArrayBuffer.
// Neither touches the search handler.
//
// Contract:
//   name                                   → string, which backend is answering (/health)
//   stats(vaultId?)                        → { count, dim, model }; cheap, never builds a matrix
//   knn(vaultId, queryVector, k)           → [{ id, path, score }] descending, length ≤ k
//   invalidate(vaultId?)                   → drop cached state (every vault when omitted)
//
// `stats` is cached and invalidated with the matrix because /v1/search consults it on every
// request to report `semanticAvailable` honestly, and an uncached COUNT over `chunks` would
// cost more than the FTS query it accompanies.
export function createVectorBackend(db) {
	const selectVectors = db.prepare(
		'SELECT id, path, embedding, embedding_dim FROM chunks WHERE vault_id = ? AND embedding IS NOT NULL ORDER BY rowid',
	);
	const statsVault = db.prepare(
		'SELECT COUNT(*) AS count, MIN(embedding_dim) AS min_dim, MAX(embedding_dim) AS max_dim FROM chunks WHERE vault_id = ? AND embedding IS NOT NULL',
	);
	const statsAll = db.prepare(
		'SELECT COUNT(*) AS count, MIN(embedding_dim) AS min_dim, MAX(embedding_dim) AS max_dim FROM chunks WHERE embedding IS NOT NULL',
	);
	const modelVault = db.prepare(
		'SELECT embedding_model AS model, COUNT(*) AS count FROM chunks WHERE vault_id = ? AND embedding IS NOT NULL GROUP BY embedding_model ORDER BY count DESC LIMIT 1',
	);
	const modelAll = db.prepare(
		'SELECT embedding_model AS model, COUNT(*) AS count FROM chunks WHERE embedding IS NOT NULL GROUP BY embedding_model ORDER BY count DESC LIMIT 1',
	);

	const statsCache = new Map();
	const matrixCache = new Map();
	const cacheKey = vaultId => (typeof vaultId === 'string' && vaultId !== '' ? vaultId : '\0all');

	function readStats(vaultId) {
		const key = cacheKey(vaultId);
		const cached = statsCache.get(key);
		if (cached) return cached;
		const scoped = typeof vaultId === 'string' && vaultId !== '';
		const row = scoped ? statsVault.get(vaultId) : statsAll.get();
		const count = Number(row?.count ?? 0);
		const minDim = row?.min_dim === null || row?.min_dim === undefined ? null : Number(row.min_dim);
		const maxDim = row?.max_dim === null || row?.max_dim === undefined ? null : Number(row.max_dim);
		// A vault holding two widths cannot be scanned as one matrix. The upsert guard makes
		// that unreachable, but reporting dim: null (→ unavailable) is the safe answer if a
		// database ever arrives in that state, rather than scoring across two vector spaces.
		const dim = count > 0 && minDim !== null && minDim === maxDim ? minDim : null;
		const modelRow = count > 0 ? (scoped ? modelVault.get(vaultId) : modelAll.get()) : null;
		const stats = { count, dim, model: modelRow?.model ?? null };
		statsCache.set(key, stats);
		return stats;
	}

	// One Float32Array of count × dim, plus parallel id/path arrays. Built lazily on the
	// first vector search for a vault and dropped wholesale on any write that touches it —
	// rebuilt rather than patched, which is simpler and cannot drift.
	function buildMatrix(vaultId) {
		const stats = readStats(vaultId);
		if (stats.count === 0 || !stats.dim) return { count: 0, dim: 0, ids: [], paths: [], matrix: null, model: null };
		const dim = stats.dim;
		const matrix = new Float32Array(stats.count * dim);
		const ids = [];
		const paths = [];
		let row = 0;
		for (const record of selectVectors.all(vaultId)) {
			const blob = record.embedding;
			if (!blob || blob.length !== dim * 4 || Number(record.embedding_dim) !== dim) continue;
			writeEmbeddingInto(matrix, row * dim, blob instanceof Uint8Array ? blob : new Uint8Array(blob), dim);
			ids.push(record.id);
			paths.push(record.path);
			row++;
		}
		return { count: row, dim, ids, paths, matrix, model: stats.model };
	}

	function ensureMatrix(vaultId) {
		const key = cacheKey(vaultId);
		let state = matrixCache.get(key);
		if (!state) {
			state = buildMatrix(vaultId);
			matrixCache.set(key, state);
		}
		return state;
	}

	return {
		name: 'brute-force-js',
		stats(vaultId) {
			return readStats(vaultId);
		},
		invalidate(vaultId) {
			if (vaultId === undefined) {
				statsCache.clear();
				matrixCache.clear();
				return;
			}
			statsCache.delete(cacheKey(vaultId));
			matrixCache.delete(cacheKey(vaultId));
			// The unscoped (/health) stats view covers every vault, so any write invalidates it.
			statsCache.delete(cacheKey(undefined));
			matrixCache.delete(cacheKey(undefined));
		},
		// Brute force over the FULL matrix — every chunk in the vault, not the FTS candidate
		// pool. Reranking FTS candidates by vector similarity cannot surface a note that
		// shares no keywords with the query, which is the entire reason this leg exists.
		// Measured 13ms at 384d / 33ms at 1024d over 52,257 chunks; the interactive ceiling
		// is ~250k chunks, past which the move is worker sharding (see the plan), not int8 —
		// int8 measured *slower* in scalar JS at this size, 19.6ms vs 12.4ms at 384d.
		knn(vaultId, queryVector, k) {
			const state = ensureMatrix(vaultId);
			if (state.count === 0) return [];
			const dim = state.dim;
			if (!queryVector || queryVector.length !== dim) {
				throw new HttpError(400, `query embedding is ${queryVector?.length ?? 0}-dimensional but this vault is indexed at ${dim}`);
			}
			const query = normalizeEmbedding(queryVector);
			const wanted = Math.max(1, Math.min(Math.floor(Number(k) || 1), state.count));
			const matrix = state.matrix;
			const best = [];
			let worst = -Infinity;
			for (let row = 0; row < state.count; row++) {
				const offset = row * dim;
				let sum = 0;
				for (let d = 0; d < dim; d++) sum += matrix[offset + d] * query[d];
				if (best.length === wanted && sum <= worst) continue;
				// Both sides are unit vectors, so the dot product *is* the cosine; the clamp
				// only absorbs float32 rounding at the ±1 ends.
				const entry = { id: state.ids[row], path: state.paths[row], score: Math.max(-1, Math.min(1, sum)) };
				let index = best.length - 1;
				best.push(entry);
				while (index >= 0 && best[index].score < entry.score) {
					best[index + 1] = best[index];
					index--;
				}
				best[index + 1] = entry;
				if (best.length > wanted) best.pop();
				worst = best[best.length - 1].score;
			}
			return best;
		},
	};
}

// Keep `.`, `/`, `:`, `@`, `-`, `_` and `'` so path- and handle-shaped queries survive, and
// use Unicode property escapes for the rest: the old `[a-z0-9_@./:-]+` class silently
// dropped every non-ASCII character, so an accented or CJK query tokenized to nothing.
const QUERY_TERM_RE = /[\p{L}\p{N}_@./:'-]+/gu;
const TERM_EDGE_PUNCTUATION_RE = /^[./:'-]+|[./:'-]+$/g;

export function tokenizeQuery(query) {
	const raw = String(query ?? '').toLowerCase().match(QUERY_TERM_RE) ?? [];
	const terms = [];
	for (const candidate of raw) {
		const term = candidate.replace(TERM_EDGE_PUNCTUATION_RE, '');
		if (!term || terms.includes(term)) continue;
		terms.push(term);
		if (terms.length >= MAX_QUERY_TERMS) break;
	}
	return terms;
}

function quoteFts(value) {
	return `"${String(value).replace(/"/g, '""')}"`;
}

// Query construction, in priority order:
//   * the whole query as a quoted phrase — a document that contains the literal phrase
//     matches this clause *and* the AND clause, so bm25 counts it twice and it floats up;
//   * AND of every term, so one common term no longer drags in the whole vault (the old
//     form was a pure OR of unique terms);
//   * `term*` prefix expansion on the trailing term, so a partial word still matches while
//     the user is still typing. `"foo"*` widens `"foo"`, it never narrows it.
// `fallback` is the loose OR form, used only when the AND form returns nothing — a query
// that matches nothing is worse than a loose one. Terms stay `""`-escaped and capped at 24
// because an FTS5 syntax error surfaces as a 500.
export function buildFtsQuery(query) {
	const terms = tokenizeQuery(query);
	if (terms.length === 0) {
		const literal = quoteFts(String(query ?? '').trim());
		return { terms, phrase: literal, primary: literal, fallback: literal };
	}
	const quoted = terms.map(quoteFts);
	const phrase = quoteFts(terms.join(' '));
	const expanded = quoted.slice(0, -1).concat(`${quoted[quoted.length - 1]}*`);
	return {
		terms,
		phrase,
		primary: `(${phrase}) OR (${expanded.join(' AND ')})`,
		fallback: `(${expanded.join(' OR ')})`,
	};
}

function normalizeForMatch(value) {
	return String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function baseName(path) {
	const tail = String(path ?? '').split('/').pop() ?? '';
	const dot = tail.lastIndexOf('.');
	return dot > 0 ? tail.slice(0, dot) : tail;
}

// The companion-side twin of the palette's basename-first tiering: how strongly does this
// page's *name* answer the query, independent of how often the body mentions it. Returned
// as 0..1, higher is better; 0 means "no title/path signal" and keeps the page out of the
// title ranking entirely so the fusion boost stays a boost.
export function titleMatchScore(terms, row = {}) {
	if (!Array.isArray(terms) || terms.length === 0) return 0;
	const phrase = normalizeForMatch(terms.join(' '));
	if (!phrase) return 0;
	const title = normalizeForMatch(row.title);
	const base = normalizeForMatch(baseName(row.path));
	const path = normalizeForMatch(row.path);
	if (title === phrase || base === phrase) return 1;
	if (title.startsWith(phrase) || base.startsWith(phrase)) return 0.85;
	if (title.includes(phrase) || base.includes(phrase)) return 0.7;
	const inTitle = terms.filter(term => title.includes(normalizeForMatch(term))).length / terms.length;
	const inPath = terms.filter(term => path.includes(normalizeForMatch(term))).length / terms.length;
	const partial = inTitle * 0.5 + inPath * 0.2;
	return partial > 0 ? Math.min(partial, 0.65) : 0;
}

// Reciprocal-rank fusion over three rankings of the same candidate set: the weighted bm25
// order (already the row order coming out of SQL), the title/path-match order, and the
// cosine order from the vector scan. Fusing ranks rather than hand-tuning one score is the
// point — the three scales are not commensurable, but their ranks are. A row missing from a
// list simply contributes 0 from it, which is how a keyword-only hit and a vector-only hit
// coexist in one ordering.
//
// `vectorRows` carries rows the vector scan found that FTS never returned; their `textRank`
// is 0 (absent from the bm25 list) rather than a made-up large rank.
//
// Sign convention: bm25 is negative/lower-is-better inside SQL and is negated here, so
// every score the client sees (`score`, `scoreText`, `scoreRrf`, `attribution.base`) is
// positive and higher-is-better. Cosine (`scoreVector`) is already higher-is-better.
export function fuseSearchRows(rows, options = {}) {
	const terms = options.terms ?? [];
	const k = options.k ?? RRF_K;
	const titleWeight = options.titleWeight ?? RRF_TITLE_WEIGHT;
	const vectorWeight = options.vectorWeight ?? RRF_VECTOR_WEIGHT;
	const vectorScores = options.vectorScores ?? null;
	const vectorRows = options.vectorRows ?? [];
	const limit = options.limit ?? (rows.length + vectorRows.length);

	const makeEntry = (row, textRank) => ({
		row,
		base: -Number(row.score_text ?? 0),
		titleBoost: titleMatchScore(terms, row),
		textRank,
		titleRank: 0,
		vectorRank: 0,
		vectorScore: vectorScores?.has(row.path) ? vectorScores.get(row.path) : null,
		rrf: 0,
	});
	// Tie-breaks fall back to bm25 order; an entry absent from that list sorts last among
	// ties rather than first, which a bare `textRank` of 0 would do.
	const textOrder = entry => entry.textRank || Number.MAX_SAFE_INTEGER;

	const entries = rows.map((row, index) => makeEntry(row, index + 1));
	for (const row of vectorRows) entries.push(makeEntry(row, 0));

	const titled = entries
		.filter(entry => entry.titleBoost > 0)
		.sort((a, b) => (b.titleBoost - a.titleBoost) || (textOrder(a) - textOrder(b)));
	titled.forEach((entry, index) => { entry.titleRank = index + 1; });

	const vectored = entries
		.filter(entry => entry.vectorScore !== null)
		.sort((a, b) => (b.vectorScore - a.vectorScore) || (textOrder(a) - textOrder(b)));
	vectored.forEach((entry, index) => { entry.vectorRank = index + 1; });

	for (const entry of entries) {
		entry.rrf = (entry.textRank ? 1 / (k + entry.textRank) : 0)
			+ (entry.titleRank ? titleWeight / (k + entry.titleRank) : 0)
			+ (entry.vectorRank ? vectorWeight / (k + entry.vectorRank) : 0);
	}
	entries.sort((a, b) => (b.rrf - a.rrf) || (textOrder(a) - textOrder(b)));

	return entries.slice(0, Math.max(0, limit)).map(entry => ({
		chunkId: entry.row.id,
		path: entry.row.path,
		title: entry.row.title,
		heading: entry.row.heading,
		snippet: entry.row.snippet,
		score: entry.rrf,
		scoreText: entry.base,
		// Omitted (not 0) when this row never entered the vector list, so an FTS-only
		// response is exactly the payload it was before the vector leg existed.
		scoreVector: entry.vectorScore === null ? undefined : entry.vectorScore,
		scoreRrf: entry.rrf,
		metadata: safeJson(entry.row.metadata_json),
		// Per-stage attribution: the base score, every boost that fired, and the fused
		// value, so ranking is tunable by observation instead of guesswork. `boosts` is the
		// open slot for client-side stages (link adjacency, recency) to record themselves.
		attribution: {
			base: entry.base,
			textRank: entry.textRank || null,
			titleRank: entry.titleRank || null,
			titleBoost: entry.titleBoost,
			vectorRank: entry.vectorRank || null,
			rrf: entry.rrf,
			pooledChunks: Number(entry.row.pooled_chunks ?? 1),
		},
	}));
}

// The vector leg: a scan of the whole matrix, pooled to one score per path, hydrated for
// any path the FTS pool never produced. It is deliberately a separate query fused in JS —
// cosine does not belong inside the FTS SQL, where `MATERIALIZED` and the bm25/snippet
// aggregate rules are already load-bearing.
//
// Degradation is silent-but-reported: a vault with no vectors, or a search with no query
// embedding, simply returns the FTS-only shape. A *mismatched* query embedding sets `note`
// instead, because scoring across two vector spaces is exactly the confidently-wrong
// failure this feature has to avoid, while failing the whole search over it would be worse
// than answering with keywords.
function runVectorLeg(db, options) {
	const outcome = { used: false, available: false, scores: null, rows: [], note: null, dim: null, model: null };
	const vectors = options.vectors;
	if (!vectors) return outcome;
	const stats = vectors.stats(options.vaultId);
	outcome.dim = stats.dim;
	outcome.model = stats.model;
	outcome.available = stats.count > 0 && Boolean(stats.dim);
	if (!outcome.available) return outcome;

	const queryEmbedding = options.queryEmbedding;
	if (!Array.isArray(queryEmbedding) && !ArrayBuffer.isView(queryEmbedding)) return outcome;
	if (queryEmbedding.length === 0) return outcome;
	if (queryEmbedding.length !== stats.dim) {
		outcome.note = `query embedding is ${queryEmbedding.length}-dimensional but this vault is indexed at ${stats.dim}; semantic ranking skipped`;
		return outcome;
	}

	let hits;
	try {
		hits = vectors.knn(options.vaultId, queryEmbedding, options.poolSize);
	} catch (e) {
		outcome.note = `${e instanceof Error ? e.message : String(e)}; semantic ranking skipped`;
		return outcome;
	}
	if (hits.length === 0) return outcome;
	outcome.used = true;

	// Pool chunk hits to their best-scoring path, mirroring what the FTS side does with
	// MIN(score_text): one row per path, scored on its strongest chunk.
	const scores = new Map();
	const bestChunk = new Map();
	for (const hit of hits) {
		const previous = scores.get(hit.path);
		if (previous === undefined || hit.score > previous) {
			scores.set(hit.path, hit.score);
			bestChunk.set(hit.path, hit.id);
		}
	}
	outcome.scores = scores;

	const known = options.knownPaths ?? new Set();
	const hydrate = options.hydrate ?? db.prepare(HYDRATE_CHUNK_SQL);
	for (const [path, chunkId] of bestChunk) {
		if (known.has(path)) continue;
		const row = hydrate.get(chunkId);
		if (!row) continue;
		outcome.rows.push({
			id: row.id,
			path: row.path,
			title: row.title,
			heading: row.heading,
			metadata_json: row.metadata_json,
			snippet: makeTextSnippet(row.text),
			// No bm25 score: this chunk did not match the query text at all. That is the
			// point of the full-matrix scan, not a gap to paper over with a fake rank.
			score_text: null,
			pooled_chunks: 1,
		});
	}
	return outcome;
}

// The FTS side gets its snippet from snippet(chunks_fts, 5, …, 18); a vector-only hit has no
// match to snippet around, so take the head of the chunk at the same token budget.
export function makeTextSnippet(text, tokens = 18) {
	const words = String(text ?? '').split(/\s+/).filter(Boolean);
	if (words.length === 0) return '';
	const head = words.slice(0, tokens).join(' ');
	return words.length > tokens ? `${head}...` : head;
}

export function runSearch(db, options) {
	const vaultId = options.vaultId;
	const limit = clampLimit(options.limit);
	const statement = options.statement ?? db.prepare(SEARCH_SQL);
	const built = buildFtsQuery(options.query);
	const poolSize = Math.max(limit * SEARCH_POOL_FACTOR, SEARCH_POOL_MIN);

	let match = built.primary;
	let rows = statement.all(vaultId, match, poolSize);
	let fallbackUsed = false;
	if (rows.length === 0 && built.fallback !== built.primary) {
		match = built.fallback;
		fallbackUsed = true;
		rows = statement.all(vaultId, match, poolSize);
	}

	const vector = runVectorLeg(db, {
		vaultId,
		vectors: options.vectors,
		queryEmbedding: options.queryEmbedding,
		poolSize,
		hydrate: options.hydrate,
		knownPaths: new Set(rows.map(row => row.path)),
	});

	// `total` stays the distinct-path FTS match count plus the paths only the vector scan
	// found. A vector-only path that FTS would also have matched *beyond* the pool is
	// counted twice; that only nudges the "N more" hint, and the alternative is a second
	// MATCH per search, which is exactly the cost the pooled CTE was built to remove.
	const ftsTotal = rows.length > 0 ? Number(rows[0].total_paths ?? rows.length) : 0;
	const total = ftsTotal + vector.rows.length;
	const results = fuseSearchRows(rows, {
		terms: built.terms,
		limit,
		vectorScores: vector.scores,
		vectorRows: vector.rows,
	});
	return {
		match,
		terms: built.terms,
		fallbackUsed,
		total,
		results,
		vectorUsed: vector.used,
		semanticAvailable: vector.available,
		embeddingDim: vector.dim,
		embeddingModel: vector.model,
		note: vector.note,
	};
}

function clampLimit(value) {
	const limit = Number(value ?? DEFAULT_LIMIT);
	if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(Math.floor(limit), MAX_LIMIT));
}

export function createRequestHandler(db, options = {}) {
	// The vector backend is injectable so a different implementation (or a test double) can
	// take over without touching a single line of the request handling below — that is the
	// seam doing its job.
	const vectors = options.vectors ?? createVectorBackend(db);
	const upsertChunk = db.prepare(`
INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  vault_id = excluded.vault_id,
  path = excluded.path,
  content_hash = excluded.content_hash,
  title = excluded.title,
  heading = excluded.heading,
  text = excluded.text,
  mtime = excluded.mtime,
  ordinal = excluded.ordinal,
  metadata_json = excluded.metadata_json,
  embedding = excluded.embedding,
  embedding_dim = excluded.embedding_dim,
  embedding_model = excluded.embedding_model
`);
	const selectVaultEmbeddingDim = db.prepare('SELECT embedding_dim AS dim FROM chunks WHERE vault_id = ? AND embedding IS NOT NULL LIMIT 1');
	const hydrateChunk = db.prepare(HYDRATE_CHUNK_SQL);
	const deleteFtsById = db.prepare('DELETE FROM chunks_fts WHERE id = ?');
	const insertFts = db.prepare('INSERT INTO chunks_fts (id, vault_id, path, title, heading, text) VALUES (?, ?, ?, ?, ?, ?)');
	const deleteByPath = db.prepare('DELETE FROM chunks WHERE vault_id = ? AND path = ?');
	const selectIdsByPath = db.prepare('SELECT id FROM chunks WHERE vault_id = ? AND path = ?');
	// One row per path: the *dominant* content-hash group (a path mid-rewrite can briefly hold
	// rows from two hashes). The embedding aggregates therefore describe that same group, which
	// is the only group the caller's contentHash comparison can match.
	//
	// `embedded_count` is deliberately a count rather than an EXISTS: full coverage is the only
	// thing that means "done". "Some chunks have vectors" is exactly the state an interrupted
	// backfill leaves behind, and reporting it as covered would strand the rest permanently.
	// `embedding_model_count`/`embedded_labelled_count` exist so a group whose chunks disagree
	// about the producing model — or whose vectors predate model attribution — reports no model
	// at all rather than an arbitrary one, which makes the client's "does coverage match the
	// active model" test fail closed.
	const selectStateByPath = db.prepare(`
SELECT
  path,
  content_hash,
  MAX(mtime) AS mtime,
  COUNT(*) AS chunk_count,
  SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded_count,
  SUM(CASE WHEN embedding IS NOT NULL AND embedding_model IS NOT NULL THEN 1 ELSE 0 END) AS embedded_labelled_count,
  COUNT(DISTINCT embedding_model) AS embedding_model_count,
  MAX(embedding_model) AS embedding_model
FROM chunks
WHERE vault_id = ? AND path = ?
GROUP BY path, content_hash
ORDER BY chunk_count DESC
LIMIT 1
`);
	const resetChunks = db.prepare('DELETE FROM chunks WHERE vault_id = ?');
	const resetFts = db.prepare('DELETE FROM chunks_fts WHERE vault_id = ?');
	const searchStatement = db.prepare(SEARCH_SQL);

	return async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
			if (req.method === 'GET' && url.pathname === '/health') {
				// Computed, not a literal: `vectorAvailable` is "this index actually holds
				// vectors the scan can use", across every vault in the database.
				const stats = vectors.stats();
				return json(res, 200, {
					ok: true,
					version: SERVICE_VERSION,
					schemaVersion: SCHEMA_VERSION,
					vectorAvailable: stats.count > 0 && Boolean(stats.dim),
					vectorBackend: vectors.name,
					embeddedChunks: stats.count,
					embeddingDim: stats.dim,
					embeddingModel: stats.model,
				});
			}
			if (req.method === 'POST' && url.pathname === '/v1/index/reset') {
				const body = await readJson(req);
				const vaultId = requireString(body.vaultId, 'vaultId');
				db.exec('BEGIN');
				try {
					resetChunks.run(vaultId);
					resetFts.run(vaultId);
					db.exec('COMMIT');
				} catch (e) {
					db.exec('ROLLBACK');
					throw e;
				}
				vectors.invalidate(vaultId);
				return json(res, 200, { ok: true });
			}
			if (req.method === 'POST' && url.pathname === '/v1/chunks/delete') {
				const body = await readJson(req);
				const vaultId = requireString(body.vaultId, 'vaultId');
				const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
				db.exec('BEGIN');
				try {
					for (const path of paths) {
						for (const row of selectIdsByPath.all(vaultId, path)) deleteFtsById.run(row.id);
						deleteByPath.run(vaultId, path);
					}
					db.exec('COMMIT');
				} catch (e) {
					db.exec('ROLLBACK');
					throw e;
				}
				vectors.invalidate(vaultId);
				return json(res, 200, { ok: true });
			}
			if (req.method === 'POST' && url.pathname === '/v1/files/state') {
				const body = await readJson(req);
				const vaultId = requireString(body.vaultId, 'vaultId');
				const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
				const files = [];
				for (const path of paths) {
					const row = selectStateByPath.get(vaultId, path);
					if (!row) continue;
					const chunkCount = Number(row.chunk_count ?? 0);
					const embeddedCount = Number(row.embedded_count ?? 0);
					const labelledCount = Number(row.embedded_labelled_count ?? 0);
					const modelCount = Number(row.embedding_model_count ?? 0);
					// Additive fields only — no on-disk schema change, so SCHEMA_VERSION stays put.
					files.push({
						path: row.path,
						contentHash: row.content_hash || undefined,
						mtime: row.mtime,
						chunkCount,
						embeddedChunkCount: embeddedCount,
						// Full coverage, never partial. See the comment on selectStateByPath.
						hasEmbeddings: chunkCount > 0 && embeddedCount === chunkCount,
						embeddingModel: embeddedCount > 0 && modelCount === 1 && labelledCount === embeddedCount && row.embedding_model
							? String(row.embedding_model)
							: undefined,
					});
				}
				return json(res, 200, { ok: true, files });
			}
			if (req.method === 'POST' && url.pathname === '/v1/chunks/upsert') {
				const body = await readJson(req);
				const chunks = Array.isArray(body.chunks) ? body.chunks : [];
				const touchedVaults = new Set();
				// Width consistency, enforced once per vault per request. Mixing two vector
				// spaces inside one index is the failure mode that produces confidently wrong
				// rankings with no error anywhere, and nothing downstream can detect it — so
				// the write is refused here, atomically (the throw rolls the whole batch back).
				const checkedVaults = new Set();
				let batchDim = null;
				db.exec('BEGIN');
				try {
					const clearedPaths = new Set();
					for (const chunk of chunks) {
						const id = requireString(chunk.id, 'chunk.id');
						const vaultId = requireString(chunk.vaultId ?? body.vaultId, 'chunk.vaultId');
						const path = requireString(chunk.path, 'chunk.path');
						const contentHash = requireString(chunk.contentHash, 'chunk.contentHash');
						const title = String(chunk.title ?? path);
						const heading = String(chunk.heading ?? '');
						const text = requireString(chunk.text, 'chunk.text');
						const mtime = Number(chunk.mtime ?? 0);
						const ordinal = Number(chunk.ordinal ?? 0);
						const pathKey = `${vaultId}\n${path}`;
						// The first chunk seen for a (vaultId, path) clears every existing row
						// for that path: an upsert is a full replace, not a merge.
						if (!clearedPaths.has(pathKey)) {
							for (const row of selectIdsByPath.all(vaultId, path)) deleteFtsById.run(row.id);
							deleteByPath.run(vaultId, path);
							clearedPaths.add(pathKey);
						}
						touchedVaults.add(vaultId);

						const embedding = prepareChunkEmbedding(chunk.embedding, chunk.embeddingModel ?? body.embeddingModel);
						if (embedding) {
							if (batchDim === null) batchDim = embedding.dim;
							else if (embedding.dim !== batchDim) {
								throw new HttpError(400, `chunk "${id}" carries a ${embedding.dim}-dimension embedding but this batch established ${batchDim}`);
							}
							if (!checkedVaults.has(vaultId)) {
								// Read *after* this path's rows were cleared, so re-embedding a
								// vault that holds exactly one path is allowed while a genuine
								// mix (other paths still at the old width) is refused.
								const existing = selectVaultEmbeddingDim.get(vaultId);
								const existingDim = existing?.dim === null || existing?.dim === undefined ? null : Number(existing.dim);
								if (existingDim && existingDim !== embedding.dim) {
									throw new HttpError(400, `vault "${vaultId}" is indexed with ${existingDim}-dimension embeddings; refusing a ${embedding.dim}-dimension vector. Reset the index before changing the embedding model.`);
								}
								checkedVaults.add(vaultId);
							}
						}

						upsertChunk.run(
							id,
							vaultId,
							path,
							contentHash,
							title,
							heading,
							text,
							Number.isFinite(mtime) ? mtime : 0,
							Number.isFinite(ordinal) ? ordinal : 0,
							JSON.stringify(chunk.metadata ?? {}),
							embedding ? embedding.bytes : null,
							embedding ? embedding.dim : null,
							embedding ? embedding.model : null,
						);
						deleteFtsById.run(id);
						insertFts.run(id, vaultId, path, title, heading, text);
					}
					db.exec('COMMIT');
				} catch (e) {
					db.exec('ROLLBACK');
					throw e;
				}
				for (const vault of touchedVaults) vectors.invalidate(vault);
				return json(res, 200, { ok: true, count: chunks.length });
			}
			if (req.method === 'POST' && url.pathname === '/v1/search') {
				const body = await readJson(req);
				const vaultId = requireString(body.vaultId, 'vaultId');
				const query = requireString(body.query, 'query');
				const outcome = runSearch(db, {
					vaultId,
					query,
					limit: body.limit,
					statement: searchStatement,
					vectors,
					// Read at last: the client has been sending this field since the search
					// modal shipped and the companion has been dropping it on the floor.
					queryEmbedding: body.queryEmbedding,
					hydrate: hydrateChunk,
				});
				const response = {
					// Computed from state, not hardcoded: 'hybrid' means a query embedding
					// arrived *and* the vault has vectors the scan actually used;
					// `semanticAvailable` means the vault could answer semantically at all.
					mode: outcome.vectorUsed ? 'hybrid' : 'fts',
					semanticAvailable: outcome.semanticAvailable,
					schemaVersion: SCHEMA_VERSION,
					match: outcome.match,
					fallbackUsed: outcome.fallbackUsed,
					total: outcome.total,
					hasMore: outcome.total > outcome.results.length,
					results: outcome.results,
				};
				if (outcome.note) response.message = outcome.note;
				return json(res, 200, response);
			}
			return json(res, 404, { ok: false, error: 'not found' });
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			// A rejection the caller can fix keeps its own 4xx; everything else is a 500.
			// The client maps 5xx (only) to SearchServiceUnavailableError → "the companion is
			// not reachable", so answering a bad request with a 500 would send the user off to
			// restart a healthy container.
			const status = e instanceof HttpError ? e.status : 500;
			// Log before replying. Without this line a request that failed on its own merits is
			// indistinguishable from a down container, and `docker logs` on a perfectly healthy
			// companion shows nothing at all. That cost a long hunt during the first full rebuild.
			if (status >= 500) {
				console.error(`[crucible-search] ${req.method} ${req.url} failed: ${message}`);
				if (e instanceof Error && e.stack) console.error(e.stack);
			} else {
				console.error(`[crucible-search] ${req.method} ${req.url} rejected (${status}): ${message}`);
			}
			return json(res, status, { ok: false, error: message });
		}
	};
}

export function startServer({ port, host, dbPath }) {
	const db = openDatabase(dbPath);
	const server = createServer(createRequestHandler(db));
	server.listen(port, host, () => {
		process.stdout.write(`Crucible search companion listening on http://${host}:${port}\n`);
		process.stdout.write(`SQLite database: ${dbPath}\n`);
		process.stdout.write(`Schema version: ${SCHEMA_VERSION}\n`);
	});
	return { server, db };
}

function readJson(req) {
	return new Promise((resolveBody, reject) => {
		let raw = '';
		req.setEncoding('utf8');
		req.on('data', chunk => {
			raw += chunk;
			if (raw.length > 20_000_000) reject(new Error('request body too large'));
		});
		req.on('end', () => {
			try {
				resolveBody(raw ? JSON.parse(raw) : {});
			} catch (e) {
				reject(e);
			}
		});
		req.on('error', reject);
	});
}

function json(res, status, body) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

function requireString(value, name) {
	if (typeof value !== 'string' || value.trim() === '') throw new Error(`Missing ${name}`);
	return value.trim();
}

function safeJson(value) {
	try {
		return JSON.parse(String(value || '{}'));
	} catch {
		return {};
	}
}

// The listen host defaults to loopback everywhere except inside the container: the API is
// unauthenticated with full index write access, so the loopback bind is the entire security
// boundary for a bare `node scripts/search-companion.mjs` run. Only the Dockerfile /
// docker-compose set CRUCIBLE_SEARCH_HOST=0.0.0.0, because a loopback bind inside a
// container is unreachable from the host even with a published port.
export function parseArgs(argv) {
	const args = new Map();
	for (let i = 2; i < argv.length; i += 2) {
		args.set(argv[i], argv[i + 1]);
	}
	return {
		port: Number(args.get('--port') ?? process.env.CRUCIBLE_SEARCH_PORT ?? 4801),
		host: args.get('--host') ?? process.env.CRUCIBLE_SEARCH_HOST ?? '127.0.0.1',
		dbPath: resolve(args.get('--db') ?? process.env.CRUCIBLE_SEARCH_DB ?? '.crucible/search.sqlite'),
	};
}

// The server bootstrap runs only when this file is the entry point, so a unit test can
// import the ranking helpers without opening a database or binding a port. The container's
// CMD passes a *relative* path and Node resolves module URLs through realpath, so compare
// both forms — getting this wrong makes the container start and do nothing.
function isMainModule() {
	const entry = process.argv[1];
	if (!entry) return false;
	const self = fileURLToPath(import.meta.url);
	const absolute = resolve(entry);
	if (absolute === self) return true;
	try {
		return realpathSync(absolute) === self;
	} catch {
		return false;
	}
}

if (isMainModule()) {
	startServer(parseArgs(process.argv));
}
