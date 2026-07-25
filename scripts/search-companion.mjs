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
export const SCHEMA_VERSION = 2;
export const SERVICE_VERSION = 'dev-fts-rrf';

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
  embedding_json TEXT
);
${FTS_TABLE_SQL};
CREATE INDEX IF NOT EXISTS idx_chunks_vault_path ON chunks(vault_id, path);
`);

	const chunkColumns = db.prepare('PRAGMA table_info(chunks)').all().map(row => row.name);
	if (!chunkColumns.includes('content_hash')) {
		db.exec("ALTER TABLE chunks ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
	}
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

// Reciprocal-rank fusion over two rankings of the same pooled candidate set: the weighted
// bm25 order (already the row order coming out of SQL) and the title/path-match order.
// Fusing ranks rather than hand-tuning one score is the point — the two scales are not
// commensurable, but their ranks are. Rows with no title signal simply don't appear in the
// second list and contribute 0 from it.
//
// Sign convention: bm25 is negative/lower-is-better inside SQL and is negated here, so
// every score the client sees (`score`, `scoreText`, `scoreRrf`, `attribution.base`) is
// positive and higher-is-better.
export function fuseSearchRows(rows, options = {}) {
	const terms = options.terms ?? [];
	const k = options.k ?? RRF_K;
	const titleWeight = options.titleWeight ?? RRF_TITLE_WEIGHT;
	const limit = options.limit ?? rows.length;

	const entries = rows.map((row, index) => ({
		row,
		base: -Number(row.score_text ?? 0),
		titleBoost: titleMatchScore(terms, row),
		textRank: index + 1,
		titleRank: 0,
		rrf: 0,
	}));

	const titled = entries
		.filter(entry => entry.titleBoost > 0)
		.sort((a, b) => (b.titleBoost - a.titleBoost) || (a.textRank - b.textRank));
	titled.forEach((entry, index) => { entry.titleRank = index + 1; });

	for (const entry of entries) {
		entry.rrf = 1 / (k + entry.textRank) + (entry.titleRank ? titleWeight / (k + entry.titleRank) : 0);
	}
	entries.sort((a, b) => (b.rrf - a.rrf) || (a.textRank - b.textRank));

	return entries.slice(0, Math.max(0, limit)).map(entry => ({
		chunkId: entry.row.id,
		path: entry.row.path,
		title: entry.row.title,
		heading: entry.row.heading,
		snippet: entry.row.snippet,
		score: entry.rrf,
		scoreText: entry.base,
		scoreRrf: entry.rrf,
		metadata: safeJson(entry.row.metadata_json),
		// Per-stage attribution: the base score, every boost that fired, and the fused
		// value, so ranking is tunable by observation instead of guesswork. `boosts` is the
		// open slot for client-side stages (link adjacency, recency) to record themselves.
		attribution: {
			base: entry.base,
			textRank: entry.textRank,
			titleRank: entry.titleRank || null,
			titleBoost: entry.titleBoost,
			rrf: entry.rrf,
			pooledChunks: Number(entry.row.pooled_chunks ?? 1),
		},
	}));
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

	const total = rows.length > 0 ? Number(rows[0].total_paths ?? rows.length) : 0;
	const results = fuseSearchRows(rows, { terms: built.terms, limit });
	return { match, terms: built.terms, fallbackUsed, total, results };
}

function clampLimit(value) {
	const limit = Number(value ?? DEFAULT_LIMIT);
	if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(Math.floor(limit), MAX_LIMIT));
}

export function createRequestHandler(db) {
	const upsertChunk = db.prepare(`
INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  embedding_json = excluded.embedding_json
`);
	const deleteFtsById = db.prepare('DELETE FROM chunks_fts WHERE id = ?');
	const insertFts = db.prepare('INSERT INTO chunks_fts (id, vault_id, path, title, heading, text) VALUES (?, ?, ?, ?, ?, ?)');
	const deleteByPath = db.prepare('DELETE FROM chunks WHERE vault_id = ? AND path = ?');
	const selectIdsByPath = db.prepare('SELECT id FROM chunks WHERE vault_id = ? AND path = ?');
	const selectStateByPath = db.prepare(`
SELECT path, content_hash, MAX(mtime) AS mtime, COUNT(*) AS chunk_count
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
				return json(res, 200, { ok: true, version: SERVICE_VERSION, schemaVersion: SCHEMA_VERSION, vectorAvailable: false });
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
					files.push({
						path: row.path,
						contentHash: row.content_hash || undefined,
						mtime: row.mtime,
						chunkCount: row.chunk_count,
					});
				}
				return json(res, 200, { ok: true, files });
			}
			if (req.method === 'POST' && url.pathname === '/v1/chunks/upsert') {
				const body = await readJson(req);
				const chunks = Array.isArray(body.chunks) ? body.chunks : [];
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
						if (!clearedPaths.has(pathKey)) {
							for (const row of selectIdsByPath.all(vaultId, path)) deleteFtsById.run(row.id);
							deleteByPath.run(vaultId, path);
							clearedPaths.add(pathKey);
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
							chunk.embedding ? JSON.stringify(chunk.embedding) : null,
						);
						deleteFtsById.run(id);
						insertFts.run(id, vaultId, path, title, heading, text);
					}
					db.exec('COMMIT');
				} catch (e) {
					db.exec('ROLLBACK');
					throw e;
				}
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
				});
				return json(res, 200, {
					mode: 'fts',
					semanticAvailable: false,
					schemaVersion: SCHEMA_VERSION,
					match: outcome.match,
					fallbackUsed: outcome.fallbackUsed,
					total: outcome.total,
					hasMore: outcome.total > outcome.results.length,
					results: outcome.results,
				});
			}
			return json(res, 404, { ok: false, error: 'not found' });
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			// Log before replying. The client turns any 5xx into SearchServiceUnavailableError,
			// which surfaces to the user as "companion not reachable" — so without this line a
			// request that failed on its own merits is indistinguishable from a down container,
			// and `docker logs` on a perfectly healthy companion shows nothing at all. That cost
			// a long hunt during the first full rebuild.
			console.error(`[crucible-search] ${req.method} ${req.url} failed: ${message}`);
			if (e instanceof Error && e.stack) console.error(e.stack);
			return json(res, 500, { ok: false, error: message });
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
