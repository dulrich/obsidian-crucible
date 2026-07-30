#!/usr/bin/env node
/* global process */
import { createServer } from 'node:http';
import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldEventLoop, setTimeout as sleepMs } from 'node:timers/promises';
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
//
// Bumped to 4 for `embedding_space`: the model id alone cannot distinguish two runtimes
// serving the same weights at different numeric precision (measured: fp32 vs f16 agree to
// 0.9991 cosine yet only 0.8182 top-10 rank overlap), and the vector scan now filters on it.
// The migration backfills `embedding_space = embedding_model`, so an index built before this
// column existed keeps exactly its current identity and nothing re-embeds.
//
// Bumped to 5 when `chunks` moved from `PRIMARY KEY (id)` to `PRIMARY KEY (vault_id, id)`.
// A chunk id was never vault-qualified, so two vaults sharing one companion collided on it:
// the upsert conflicted on `id` alone and re-labelled the other vault's row, its file then
// vanished from that vault's `/v1/files/state`, and a reset of *either* vault took both
// vaults' rows with it. Reproduced, not inferred. Every statement that keyed on `id` alone is
// now `(vault_id, id)`; see migrateChunksPrimaryKey for the rebuild.
//
// Bumped to 6 when every `chunks_fts` DELETE moved from keying on `vault_id`/`id` (both
// UNINDEXED FTS5 columns) to keying on `rowid`. Measured (wp3-throughput-2026-07-26, see
// src/search/AGENTS.md): at the live 53k-chunk size each per-chunk delete full-scanned the
// entire FTS index — 24.2ms/delete, ~17s per 500-chunk upsert flush, worsening as O(index
// size) with vault growth. `chunks_fts.rowid` is now pinned to the owning `chunks.rowid` at
// insert time (`INSERT INTO chunks_fts(rowid, ...)`), obtained at upsert via `RETURNING
// rowid`, so every delete is a direct rowid lookup instead of a scan. Schema 1-5 databases
// already refill `chunks_fts` from `chunks` on migration (migrateChunksPrimaryKey /
// migrateFtsSchema, both now rowid-pinning by construction since they share
// FTS_REFILL_SQL); a database already at schema 5 needs a *dedicated* one-time refill
// because neither of those migrations' structural triggers (missing PK shape, missing
// `prefix=`) fire on it — see migrateFtsRowidPinning, keyed on `PRAGMA user_version` since
// FTS5's rowid pinning leaves no trace in `sqlite_master` SQL text to structurally detect.
//
// Bumped to 7 for the **entity facet**: `chunks.entities` (an additive column) plus a dedicated
// indexed `entities` column on `chunks_fts`, so a note carrying `author: Matt Pocock` in its
// frontmatter answers the query `matt pocock` even when that name appears nowhere in its body.
// FTS5 cannot ALTER a virtual table to add a column, so this is a drop/refill of chunks_fts from
// chunks — the migrateFtsSchema precedent, lossless because chunks holds every indexed column.
// `chunks` itself is only ALTERed, never rebuilt: embeddings ride across untouched and nothing
// re-embeds. See migrateFtsEntitiesColumn. The client's half of the pairing is
// SEARCH_REQUIRED_SCHEMA_VERSION in `src/search/types.ts`; an older companion binary would accept
// `chunk.entities` on the wire and silently drop it, which is a permanent invisible gap rather
// than a visible failure — exactly what the pairing rule turns into "rebuild required".
export const SCHEMA_VERSION = 7;
export const SERVICE_VERSION = 'dev-fts-rrf-vector';

// bm25() takes one weight per column, including the UNINDEXED ones (they never match, so
// their weights are inert but the arity must line up). Unweighted bm25 let a body mention
// outrank a title match; title >> heading >> text is the whole point of the ranking upgrade.
//
// `entities` (schema 7) sits at 8.0: strong evidence, deliberately *below* title. Three reasons,
// and none of them are measured — the bake-off does not cover this column, so the value is chosen
// to be conservative rather than tuned. (1) A note *named* for something answers a query about it
// better than a note merely *authored* by someone of that name, so title must keep the top slot.
// (2) The entity field is a handful of tokens where title is a phrase and text is a page; FTS5's
// bm25 normalizes term frequency against the whole row's length, so a hit in a tiny field already
// scores high before any weight is applied, and matching title's 10.0 would compound that twice.
// (3) The failure mode of too high is worse than too low here: an over-weighted author turns
// every query containing a common first name into that author's back catalogue, whereas an
// under-weighted one still surfaces the note (it is the only leg that matches it at all) just
// further down. Raise it only against a measurement.
const BM25_WEIGHTS = [0, 0, 0, 10.0, 5.0, 1.0, 8.0];

const MAX_QUERY_TERMS = 24;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;

// WP-5: companion-side cooperative deadline for /v1/search. The server is single-threaded with
// a synchronous `DatabaseSync`, so it cannot preempt a running SQL statement — the bound is
// checked BETWEEN statements/scans (runSearch's checkpoints below), never inside one. This is
// deliberately a *server-owned* budget, separate from and shorter than the client's own
// interactive timeout (`searchQueryTimeoutMs`, `src/search/client.ts`): the two-timeout law in
// `src/search/AGENTS.md` says the interactive and indexing budgets stay separate, and this adds
// a third, narrower one scoped to a single request rather than collapsing anything.
//
// Ground truth (WP-2, clsl-wp2-search-latency-2026-07-29, 28.7k-chunk index copy): a
// pathological 15-term query totals 674-800ms server-side, ~65% of it the zero-hit loose-OR
// rescue (built.fallback) and the rest the coverage leg's per-term scans — a single request
// cannot reach the old hardcoded 5s client timeout on its own. The real 5s producer is a
// request queuing behind the companion's own upsert flush (~17s/500 chunks at the live index
// size), which this deadline does not fix (see the flush-yield note in the WP-5 report) but
// does bound: a request that lands mid-queue and only gets to run once most of its budget is
// already gone degrades to a well-formed partial response instead of running to completion
// regardless of how late it started.
const SEARCH_DEADLINE_DEFAULT_MS = 3200;
const SEARCH_DEADLINE_MIN_MS = 500;
const SEARCH_DEADLINE_MAX_MS = 20_000;

// Exported so the request handler and tests share one clamp. A client-sent `budgetMs` of 0,
// negative, NaN, or absurdly large is clamped rather than trusted outright — the deadline is a
// server-side safety valve, not something a malformed or hostile request can disable by asking
// for Infinity, nor something that can starve even the cheap primary FTS clause by asking for 0.
export function clampSearchBudgetMs(value) {
	const ms = Number(value);
	if (!Number.isFinite(ms)) return SEARCH_DEADLINE_DEFAULT_MS;
	return Math.max(SEARCH_DEADLINE_MIN_MS, Math.min(ms, SEARCH_DEADLINE_MAX_MS));
}

// WP-3: resolves the instant the cooperative deadline should start counting from.
// `receivedAt` alone (the companion's own clock, stamped once the request handler is finally
// running) is blind to whatever queued the request ahead of it — the whole point of the
// WP-3 investigation: a request queued behind an upsert flush sub-batch can burn most of its
// client-side interactive timeout before the companion's handler ever gets to run, so a
// deadline that only starts at `receivedAt` never sees that cost and the companion answers
// "in budget" long after the client has already given up and thrown the response away. `sentAt`
// is the client's own clock at send time (sent alongside `budgetMs`, src/search/client.ts),
// which does see it.
//
// Guarded against clock skew: `sentAt` must land inside `[receivedAt - budgetMs, receivedAt]` —
// a request cannot have been sent after it was received, and a `sentAt` claiming to be more
// than a full budget's worth of clock disagreement into the past is not trustworthy queuing
// evidence, just a skewed or malformed clock. Outside that window, absent, or non-numeric (an
// older client that has never heard of `sentAt`) all fall back to `receivedAt` — the same
// deadline shape this replaces, so a mixed-version fleet degrades cleanly in both directions.
export function resolveSearchDeadlineStart(sentAt, receivedAt, budgetMs) {
	const parsed = Number(sentAt);
	if (!Number.isFinite(parsed)) return receivedAt;
	if (parsed < receivedAt - budgetMs || parsed > receivedAt) return receivedAt;
	return parsed;
}

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
// The document-level term-coverage list (rankingMode 'coverage'/'blend+coverage') joins on the
// same footing as the title and vector lists, for the same reason: its scale (a fraction of the
// query's terms) is not commensurable with bm25 or cosine, but its rank is. Weight 1.0 is the
// unbiased starting point the bake-off measures against, not a tuned value.
export const RRF_COVERAGE_WEIGHT = 1.0;
// A path must cover at least this many distinct query terms to enter the coverage list at all.
// One term is not "coverage" — it is what bm25 already ranks, and at vault scale a single common
// term covers thousands of paths, so a floor of 1 would hand the coverage list to noise before
// the poolSize truncation could even see it. Two is the smallest floor that means "these terms
// co-occur in this document", which is the signal the leg exists to add. Consequently the leg is
// inert for one-term queries (where the strict AND already retrieves every covering path).
export const COVERAGE_MIN_TERMS = 2;

// Hydration for a path the vector scan found but the FTS pool never returned. Those rows
// have no bm25 score and no FTS snippet (they did not match), so the snippet is built from
// the chunk text — see makeTextSnippet.
//
// Scoped by `(vault_id, id)`, like every other chunk statement since schema 5. A chunk id is
// only unique *within* a vault, so an id-only lookup here could hydrate another vault's chunk
// into this vault's results — a cross-vault content leak, not merely a wrong snippet.
const HYDRATE_CHUNK_SQL = 'SELECT id, path, title, heading, text, entities, metadata_json FROM chunks WHERE vault_id = ? AND id = ?';

// `entities` is appended *after* `text` on purpose: `snippet(chunks_fts, 5, ...)` in SEARCH_SQL
// addresses the snippet column by index, so inserting the new column anywhere earlier would
// silently start snippeting the wrong field. Appending also keeps BM25_WEIGHTS positionally
// aligned with every weight that was already tuned.
const FTS_TABLE_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  id UNINDEXED,
  vault_id UNINDEXED,
  path UNINDEXED,
  title,
  heading,
  text,
  entities,
  prefix='2 3'
)`;

// `rowid` rides across explicitly, pinning `chunks_fts.rowid` to the owning `chunks.rowid`.
// This is schema 6's whole point: every runtime DELETE against `chunks_fts` can then key on
// `rowid` (an O(1) btree lookup) instead of `vault_id`/`id` (both UNINDEXED, so a delete keyed
// on either forces a full-table scan). Every migration that rebuilds `chunks_fts` shares this
// constant, so a rebuild triggered by an unrelated schema change (e.g. migrateChunksPrimaryKey
// on a pre-5 database) also lands correctly rowid-pinned for free.
const FTS_REFILL_SQL = `INSERT INTO chunks_fts (rowid, id, vault_id, path, title, heading, text, entities)
SELECT rowid, id, vault_id, path, title, heading, text, entities FROM chunks`;

// The whole reason schema 4 costs nothing. An index built before `embedding_space` existed
// identified its vectors by model id alone, and the client's space id degrades to exactly that
// bare model id whenever the runtime reports no precision (Infinity, the live embedder, always
// does). So copying `embedding_model` across preserves the existing identity byte for byte:
// coverage still matches, the upsert guard still passes, and not one of the already-embedded
// chunks re-embeds. A migration that instead left the column NULL — or wrote a new default —
// would silently invalidate every vector in the index and trigger a full re-embed.
//
// Run on every startup rather than only when the ALTER fires, because a *client* older than
// schema 4 talking to a schema-4 companion writes rows with a model and no space; this heals
// them under the same rule instead of leaving them permanently unattributed. Writes are also
// defaulted at insert time (see prepareChunkEmbedding), so this only ever catches rows that
// predate the running binary.
export const BACKFILL_EMBEDDING_SPACE_SQL = `UPDATE chunks
SET embedding_space = embedding_model
WHERE embedding_space IS NULL AND embedding IS NOT NULL AND embedding_model IS NOT NULL`;

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
         c.entities AS entities,
         c.metadata_json AS metadata_json,
         snippet(chunks_fts, 5, '', '', '...', 18) AS snippet,
         bm25(chunks_fts, ${BM25_WEIGHTS.map(weight => weight.toFixed(1)).join(', ')}) AS score_text
  FROM chunks_fts
  JOIN chunks c ON c.id = chunks_fts.id AND c.vault_id = chunks_fts.vault_id
  WHERE chunks_fts.vault_id = ? AND chunks_fts MATCH ?
),
pooled AS (
  SELECT path,
         id,
         title,
         heading,
         entities,
         metadata_json,
         snippet,
         MIN(score_text) AS score_text,
         COUNT(*) AS pooled_chunks
  FROM matched
  GROUP BY path
)
SELECT id, path, title, heading, entities, metadata_json, snippet, score_text, pooled_chunks,
       COUNT(*) OVER () AS total_paths
FROM pooled
ORDER BY score_text, path
LIMIT ?
`;

// The document-level term-coverage leg's one statement, run once per query term (rankingMode
// 'coverage'/'blend+coverage' only — it is never prepared-and-run on the default path).
//
// Deliberately NOT the pooled SEARCH_SQL: coverage asks a presence question, not a scoring one,
// so it must not pay for bm25() or snippet() — and because it selects no FTS5 auxiliary
// function it needs neither the MATERIALIZED CTE nor the single-min() aggregate rule that hold
// SEARCH_SQL together. It also takes no LIMIT: a truncated per-term path list would be a
// *wrong* coverage count (silently, and biased by FTS rowid order), not a cheaper one. The
// truncation that bounds the leg happens after counting, on the ranked list.
const COVERAGE_SQL = 'SELECT id, path FROM chunks_fts WHERE vault_id = ? AND chunks_fts MATCH ?';

// The canonical `chunks` shape, parameterized by table name so the primary-key migration
// builds its replacement table from the same declaration the fresh-database path uses —
// there is no second copy of this to drift.
//
// `PRIMARY KEY (vault_id, id)` is the schema-5 fix. A chunk id is derived from the note's
// path/ordinal/heading and is therefore only ever unique *within* a vault; keying on `id`
// alone made two vaults sharing one companion destroy each other's rows. `id`/`vault_id`
// carry explicit NOT NULL because SQLite does not enforce it for PRIMARY KEY columns of a
// rowid table.
//
// `extraColumnSql` carries forward any column the current shape no longer declares — today
// only `embedding_json`, left behind by schema 1/2 — so the rebuild stays lossless instead
// of quietly dropping it.
export function chunksTableSql(name, extraColumnSql = '') {
	return `CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT NOT NULL,
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
  embedding_model TEXT,
  embedding_space TEXT,
  entities TEXT NOT NULL DEFAULT '',${extraColumnSql}
  PRIMARY KEY (vault_id, id)
)`;
}

// Declaration order of the canonical columns; doubles as the migration's copy manifest.
const CHUNKS_COLUMNS = [
	'id', 'vault_id', 'path', 'content_hash', 'title', 'heading', 'text',
	'mtime', 'ordinal', 'metadata_json', 'embedding', 'embedding_dim', 'embedding_model', 'embedding_space',
	'entities',
];

export function createSchema(db) {
	db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
${chunksTableSql('chunks')};
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
	if (!chunkColumns.includes('embedding_space')) db.exec('ALTER TABLE chunks ADD COLUMN embedding_space TEXT');
	// Schema 7's half of the entity facet on the `chunks` side is exactly one additive ALTER —
	// no rebuild, no row rewrite, embeddings untouched. Existing rows land at `''`, which is
	// honestly "no entity facet known for this chunk yet" and not a claim that the note has no
	// author; they populate on the next upsert, which the client's contentHash fold guarantees
	// happens on the first indexing sweep after the upgrade (see hashSearchContent).
	if (!chunkColumns.includes('entities')) db.exec("ALTER TABLE chunks ADD COLUMN entities TEXT NOT NULL DEFAULT ''");
	db.exec(BACKFILL_EMBEDDING_SPACE_SQL);
	db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_vault_path_hash ON chunks(vault_id, path, content_hash)');
	// Order matters: the additive ALTERs above must have run first, or the rebuild's
	// INSERT ... SELECT would name columns a schema-1 table does not have yet. The PK rebuild
	// recreates chunks_fts itself, so migrateFtsSchema finds a prefix-carrying table and
	// reports false — hence the `||` rather than returning only its result.
	const pkMigrated = migrateChunksPrimaryKey(db);
	const ftsMigrated = migrateFtsSchema(db);
	// Both migrations above rebuild chunks_fts via FTS_REFILL_SQL when they run, and that SQL
	// now pins chunks_fts.rowid to chunks.rowid — so if either ran, the table is already
	// correctly rowid-pinned and a second rebuild would only cost time, not fix anything.
	const rowidMigrated = migrateFtsRowidPinning(db, { alreadyRebuilt: pkMigrated || ftsMigrated });
	// Same `alreadyRebuilt` chaining, one link further along: any of the three above rebuilt
	// chunks_fts through FTS_TABLE_SQL, which already declares `entities`, so a fourth rebuild
	// would only re-pay the (measured ~2.7s at 53k chunks) cost for nothing.
	const entitiesMigrated = migrateFtsEntitiesColumn(db, { alreadyRebuilt: pkMigrated || ftsMigrated || rowidMigrated });
	return pkMigrated || ftsMigrated || rowidMigrated || entitiesMigrated;
}

// `PRAGMA user_version` is a 4-byte integer SQLite persists in the database file header for
// exactly this purpose — a version cookie the application controls. Every other migration in
// this file detects "needs to run" structurally (a PRIMARY KEY shape in `sqlite_master`, a
// `prefix=` substring in the FTS table's stored SQL), but rowid pinning has no structural
// trace: `INSERT INTO chunks_fts(rowid, ...)` and a plain auto-assigned-rowid insert produce
// byte-identical `sqlite_master` SQL for chunks_fts, so there is nothing in the schema text to
// test. `user_version` is the version check for exactly the migrations that have no structural
// signature.
function getUserVersion(db) {
	const row = db.prepare('PRAGMA user_version').get();
	return Number(row?.user_version ?? 0);
}

function setUserVersion(db, version) {
	// PRAGMA does not accept a bound parameter, only a literal; `version` is always the
	// module-internal SCHEMA_VERSION constant, never request input.
	db.exec(`PRAGMA user_version = ${Number(version)}`);
}

// Schema 4 → 5: `chunks` keyed by `(vault_id, id)` instead of `id` alone.
//
// SQLite cannot ALTER a primary key, so this is the standard rebuild: create the replacement,
// INSERT ... SELECT every column across, drop, rename. It is a **rebuild, not a reindex** —
// no chunk text is re-read and no vector is recomputed, so an index with embeddings keeps
// every one of them.
//
// Why the copy cannot lose a row: the new key is strictly *weaker* than the old one. The old
// table enforced `id` unique across the whole database, which implies `(vault_id, id)` unique,
// so no two source rows can collide on the new key regardless of what the data happens to
// look like. That is a proof from the old constraint, not an observation about today's ids.
//
// `rowid` rides across explicitly so the vector matrix's `ORDER BY rowid` build order is
// unchanged by the migration, and chunks_fts is dropped and refilled from `chunks` in the
// same transaction (the `migrateFtsSchema` precedent, and what makes "chunks_fts is exactly
// derived from chunks" true by construction on the other side of a primary-key change —
// which is the invariant the newly `(vault_id, id)`-scoped FTS delete relies on).
//
// Returns true when a migration actually ran.
export function migrateChunksPrimaryKey(db) {
	const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks'").get();
	const sql = typeof row?.sql === 'string' ? row.sql : '';
	if (!sql) return false;
	if (/PRIMARY\s+KEY\s*\(\s*vault_id\s*,\s*id\s*\)/i.test(sql)) return false;

	const extras = db.prepare('PRAGMA table_info(chunks)').all().filter(column => !CHUNKS_COLUMNS.includes(column.name));
	const extraColumnSql = extras.map(column => {
		const notNull = column.notnull ? ' NOT NULL' : '';
		const dflt = column.dflt_value === null || column.dflt_value === undefined ? '' : ` DEFAULT ${column.dflt_value}`;
		return `\n  ${column.name} ${column.type || 'TEXT'}${notNull}${dflt},`;
	}).join('');
	const columnList = [...CHUNKS_COLUMNS, ...extras.map(column => column.name)].join(', ');

	db.exec('BEGIN');
	try {
		db.exec('DROP TABLE IF EXISTS chunks_migrated');
		db.exec(chunksTableSql('chunks_migrated', extraColumnSql));
		db.exec(`INSERT INTO chunks_migrated (rowid, ${columnList}) SELECT rowid, ${columnList} FROM chunks`);
		db.exec('DROP TABLE chunks');
		db.exec('ALTER TABLE chunks_migrated RENAME TO chunks');
		// Dropped with the old table; recreated by the same statements createSchema uses.
		db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_vault_path ON chunks(vault_id, path)');
		db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_vault_path_hash ON chunks(vault_id, path, content_hash)');
		db.exec('DROP TABLE IF EXISTS chunks_fts');
		db.exec(FTS_TABLE_SQL);
		db.exec(FTS_REFILL_SQL);
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
	return true;
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

// Schema 5 → 6: every `chunks_fts` DELETE moves from keying on `vault_id`/`id` (both
// UNINDEXED, so a delete keyed on either forces a full-table scan — measured 24.2ms/delete at
// the live 53k-chunk size) to keying on `rowid` (an O(1) btree lookup). That requires
// `chunks_fts.rowid` to actually equal the owning `chunks.rowid`, which only a rebuild through
// the now rowid-pinning FTS_REFILL_SQL establishes — see the SCHEMA_VERSION=6 comment.
//
// `options.alreadyRebuilt` lets the caller skip the rebuild here when migrateChunksPrimaryKey
// or migrateFtsSchema already rebuilt chunks_fts in this same createSchema() call: they share
// FTS_REFILL_SQL, so their rebuild is already rowid-pinned and repeating it would only cost
// the (measured ~2.7s at 53k chunks) rebuild time for no correctness gain. The version cookie
// is still written in that case, so a later startup doesn't re-check via a different path.
//
// The version target is a fixed literal (6), deliberately NOT the live SCHEMA_VERSION
// constant: this migration's job is "has the rowid-pinning rebuild happened", a question with
// one fixed answer forever. Comparing against SCHEMA_VERSION would tie this migration's
// re-trigger condition to every future, unrelated schema bump — a schema 7 change with no
// user_version write of its own would make `getUserVersion(db) >= SCHEMA_VERSION` false again
// and force a full, needless chunks_fts rebuild on every subsequent startup.
//
// Returns true when this function performed the rebuild itself (not when it only wrote the
// version cookie for a rebuild one of its siblings already did).
const FTS_ROWID_PINNING_VERSION = 6;
export function migrateFtsRowidPinning(db, options = {}) {
	if (getUserVersion(db) >= FTS_ROWID_PINNING_VERSION) return false;
	let rebuilt = false;
	if (!options.alreadyRebuilt) {
		db.exec('BEGIN');
		try {
			db.exec('DROP TABLE IF EXISTS chunks_fts');
			db.exec(FTS_TABLE_SQL);
			db.exec(FTS_REFILL_SQL);
			db.exec('COMMIT');
		} catch (e) {
			db.exec('ROLLBACK');
			throw e;
		}
		rebuilt = true;
	}
	setUserVersion(db, FTS_ROWID_PINNING_VERSION);
	return rebuilt;
}

// Schema 6 → 7: `chunks_fts` gains an indexed `entities` column (the entity facet — see the
// SCHEMA_VERSION comment). FTS5 has no `ALTER TABLE ... ADD COLUMN`, and
// `CREATE VIRTUAL TABLE IF NOT EXISTS` is a no-op against an existing table, so the only way to
// add a column to a live index is the migrateFtsSchema shape: drop and refill from `chunks` in
// one transaction.
//
// **Why that is lossless, and the argument is structural rather than empirical.** `chunks_fts`
// holds no state of its own: every column it declares is copied verbatim from `chunks` by
// FTS_REFILL_SQL, and `chunks` is the durable table. So the FTS table is a pure function of
// `chunks`, and dropping a pure function's cached output cannot lose information — the same
// reasoning migrateFtsSchema and migrateChunksPrimaryKey (which also refills it) already rest on.
// The `chunks` side of this bump is one additive ALTER, so no row is rewritten, no embedding is
// touched, and nothing re-embeds. Rows that predate the column refill with `entities = ''` and
// are re-upserted with real entity text on the next indexing sweep.
//
// **Detection is structural AND cookied, deliberately both.** Unlike rowid pinning, this change
// *does* leave a trace in `sqlite_master` — the column name is in chunks_fts's stored SQL — and
// the structural test is the authoritative one because it cannot be defeated by a cookie that is
// missing, stale, or written by a database file restored from elsewhere. `user_version` is
// advanced to 7 alongside it so the version cookie stays monotone with SCHEMA_VERSION and
// migrateFtsRowidPinning's `>= 6` check keeps reporting satisfied.
//
// The version target is a fixed literal for the same reason FTS_ROWID_PINNING_VERSION is: this
// migration answers "has the entities rebuild happened", a question with one permanent answer.
// Comparing against SCHEMA_VERSION would re-trigger it on every future unrelated bump.
//
// Returns true only when this function performed the rebuild itself.
const FTS_ENTITIES_VERSION = 7;
export function migrateFtsEntitiesColumn(db, options = {}) {
	const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'").get();
	const sql = typeof row?.sql === 'string' ? row.sql : '';
	if (!sql) return false;
	// Bounded on both sides so the test is the column *name* and not a substring of some future
	// option or column (`entities_json`, `prefix='entities'`).
	const hasColumn = /(^|[\s(,])entities(\s|,|\))/i.test(sql);
	let rebuilt = false;
	if (!hasColumn && !options.alreadyRebuilt) {
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
		rebuilt = true;
	}
	if (getUserVersion(db) < FTS_ENTITIES_VERSION) setUserVersion(db, FTS_ENTITIES_VERSION);
	return rebuilt;
}

// The entity facet's flattening rule: a chunk's `entities` arrive structured
// (`{ text, type, source }` — see `SearchEntity` in `src/search/types.ts`) and exactly one part
// of them, the text, reaches FTS. That asymmetry is the forward-compatibility design, not an
// oversight: GLiNER2-sourced entities will arrive in the same array with `source: 'model'` and a
// model-assigned `type`, land in this same column, and be scored at this same bm25 weight —
// producing no schema event at all. Persisting `type`/`source` would only be needed for a
// *typed* query surface ("notes whose author is X" as distinct from "notes mentioning X"), which
// nothing asks for; when something does, it is an additive `entities_json` column, and it does
// not disturb this column, its weight, or anything indexed here.
//
// Three inbound forms are accepted, so a producer is never blocked on the object shape: an array
// of entity objects, an array of bare strings, and a single scalar. Everything else — nested
// arrays, nulls, objects without a usable `text` — is dropped rather than stringified, because
// `[object Object]` in an index column is a junk term that matches nothing and dilutes bm25.
//
// Deduplication is by text alone (not by type), and the bounds are the same as the client's, so
// this reproduces `entityIndexText` in `src/search/chunker.ts` exactly. That agreement is
// load-bearing: the client folds its version of this string into `contentHash`, so if the two
// rules diverged, the hash would describe text the index does not hold.
const MAX_CHUNK_ENTITIES = 32;
const MAX_ENTITY_TEXT_CHARS = 200;
export function normalizeChunkEntities(value) {
	if (value === undefined || value === null) return '';
	const list = Array.isArray(value) ? value : [value];
	const texts = [];
	const seen = new Set();
	for (const entry of list) {
		const raw = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry.text : entry;
		if (typeof raw !== 'string' && typeof raw !== 'number') continue;
		const text = String(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_ENTITY_TEXT_CHARS);
		if (!text) continue;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		texts.push(text);
		if (texts.length >= MAX_CHUNK_ENTITIES) break;
	}
	return texts.join('\n');
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

// Trimmed non-empty string, or null. The one place "no value" is decided for both the model id
// and the space id, so `''`, `'   '` and a missing field cannot mean three different things.
function optionalId(value) {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// Validation for one inbound chunk embedding. Returns null when the chunk carries none
// (FTS-only indexing stays the default), throws HttpError(400) on anything malformed.
//
// `space` is the vector-space identity — model id plus normalized precision when the runtime
// could report one (`bge-m3/f16`), the bare model id when it could not. It defaults to the model
// id for exactly that reason: a client that sends no space is asserting today's semantics, which
// *are* "the space is the model", and that default is what makes the schema-4 migration and an
// older client both land on the same identity rather than two.
export function prepareChunkEmbedding(embedding, model, space) {
	if (embedding === undefined || embedding === null) return null;
	if (!Array.isArray(embedding) && !ArrayBuffer.isView(embedding)) {
		throw new HttpError(400, 'chunk.embedding must be an array of numbers');
	}
	if (embedding.length === 0) throw new HttpError(400, 'chunk.embedding must not be empty');
	const floats = normalizeEmbedding(embedding);
	const modelId = optionalId(model);
	return { bytes: encodeEmbedding(floats), dim: floats.length, model: modelId, space: optionalId(space) ?? modelId };
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
//   stats(vaultId?, space?)                → { count, dim, model, spaces, unlabelledCount };
//                                            cheap, never builds a matrix
//   knn(vaultId, queryVector, k, space?)   → [{ id, path, score }] descending, length ≤ k
//   invalidate(vaultId?)                   → drop cached state (every vault when omitted)
//
// `space` narrows both to one embedding space; omitted means "every vector in the vault", which
// is correct only when the vault holds exactly one space — deciding that is resolveScanSpace's
// job, not the backend's.
//
// `stats` is cached and invalidated with the matrix because /v1/search consults it on every
// request to report `semanticAvailable` honestly, and an uncached COUNT over `chunks` would
// cost more than the FTS query it accompanies.
export function createVectorBackend(db) {
	// `(? IS NULL OR embedding_space = ?)` is the space filter on every statement below: bind
	// null and the statement is the vault-wide form it was before schema 4, bind a space and it
	// is scoped, with no second prepared statement to keep in sync.
	const selectVectors = db.prepare(
		'SELECT id, path, embedding, embedding_dim, embedding_space FROM chunks WHERE vault_id = ? AND embedding IS NOT NULL AND (? IS NULL OR embedding_space = ?) ORDER BY rowid',
	);
	// Grouped by space rather than a flat COUNT/MIN/MAX, so one query answers both "how big is
	// this matrix" and "how many distinct spaces is this index holding" — the latter being what
	// makes a mixed index visible instead of inferred.
	const groupsVault = db.prepare(
		'SELECT embedding_space AS space, COUNT(*) AS count, MIN(embedding_dim) AS min_dim, MAX(embedding_dim) AS max_dim FROM chunks WHERE vault_id = ? AND embedding IS NOT NULL AND (? IS NULL OR embedding_space = ?) GROUP BY embedding_space',
	);
	const groupsAll = db.prepare(
		'SELECT embedding_space AS space, COUNT(*) AS count, MIN(embedding_dim) AS min_dim, MAX(embedding_dim) AS max_dim FROM chunks WHERE embedding IS NOT NULL AND (? IS NULL OR embedding_space = ?) GROUP BY embedding_space',
	);
	const modelVault = db.prepare(
		'SELECT embedding_model AS model, COUNT(*) AS count FROM chunks WHERE vault_id = ? AND embedding IS NOT NULL AND (? IS NULL OR embedding_space = ?) GROUP BY embedding_model ORDER BY count DESC LIMIT 1',
	);
	const modelAll = db.prepare(
		'SELECT embedding_model AS model, COUNT(*) AS count FROM chunks WHERE embedding IS NOT NULL AND (? IS NULL OR embedding_space = ?) GROUP BY embedding_model ORDER BY count DESC LIMIT 1',
	);

	// Two-level caches: vault → space → value. Nesting (rather than one composite string key)
	// buys two things. The keys are `null` for "all vaults"/"no space filter" — a real Map key,
	// so there is no in-band sentinel string to collide with a real vault id or to smuggle a
	// control character into this file, which has happened here before. And invalidating a vault
	// is one delete of its whole inner map, so a write can never leave a matrix built for one
	// space alive under another — the silent version of the very bug the space filter fixes.
	const statsCache = new Map();
	const matrixCache = new Map();
	const vaultKey = vaultId => (typeof vaultId === 'string' && vaultId !== '' ? vaultId : null);
	const spaceKey = space => (typeof space === 'string' && space !== '' ? space : null);

	function cached(cache, vaultId, space, build) {
		const outer = vaultKey(vaultId);
		let inner = cache.get(outer);
		if (!inner) {
			inner = new Map();
			cache.set(outer, inner);
		}
		const key = spaceKey(space);
		let value = inner.get(key);
		if (value === undefined) {
			value = build();
			inner.set(key, value);
		}
		return value;
	}

	function readStats(vaultId, space) {
		return cached(statsCache, vaultId, space, () => {
			const scoped = vaultKey(vaultId) !== null;
			const filter = spaceKey(space);
			const rows = scoped ? groupsVault.all(vaultId, filter, filter) : groupsAll.all(filter, filter);
			let count = 0;
			let minDim = null;
			let maxDim = null;
			let unlabelledCount = 0;
			const spaces = [];
			for (const row of rows) {
				const groupCount = Number(row.count ?? 0);
				count += groupCount;
				const low = row.min_dim === null || row.min_dim === undefined ? null : Number(row.min_dim);
				const high = row.max_dim === null || row.max_dim === undefined ? null : Number(row.max_dim);
				if (low !== null) minDim = minDim === null ? low : Math.min(minDim, low);
				if (high !== null) maxDim = maxDim === null ? high : Math.max(maxDim, high);
				if (typeof row.space === 'string' && row.space !== '') spaces.push(row.space);
				else unlabelledCount += groupCount;
			}
			spaces.sort();
			// A vault holding two widths cannot be scanned as one matrix. The upsert guard makes
			// that unreachable, but reporting dim: null (→ unavailable) is the safe answer if a
			// database ever arrives in that state, rather than scoring across two vector spaces.
			const dim = count > 0 && minDim !== null && minDim === maxDim ? minDim : null;
			const modelRow = count > 0 ? (scoped ? modelVault.get(vaultId, filter, filter) : modelAll.get(filter, filter)) : null;
			return { count, dim, model: modelRow?.model ?? null, spaces, unlabelledCount };
		});
	}

	// One Float32Array of count × dim, plus parallel id/path arrays. Built lazily on the
	// first vector search for a vault and dropped wholesale on any write that touches it —
	// rebuilt rather than patched, which is simpler and cannot drift.
	//
	// Scoped to `space` when one is given, and the row filter is in SQL, not a post-filter in
	// JS: scoring a query against vectors from another space is the failure this whole work
	// package exists to remove, so those rows must never reach the matrix in the first place.
	function buildMatrix(vaultId, space) {
		const stats = readStats(vaultId, space);
		if (stats.count === 0 || !stats.dim) return { count: 0, dim: 0, ids: [], paths: [], matrix: null, model: null };
		const dim = stats.dim;
		const matrix = new Float32Array(stats.count * dim);
		const ids = [];
		const paths = [];
		let row = 0;
		const filter = spaceKey(space);
		for (const record of selectVectors.all(vaultId, filter, filter)) {
			const blob = record.embedding;
			if (!blob || blob.length !== dim * 4 || Number(record.embedding_dim) !== dim) continue;
			writeEmbeddingInto(matrix, row * dim, blob instanceof Uint8Array ? blob : new Uint8Array(blob), dim);
			ids.push(record.id);
			paths.push(record.path);
			row++;
		}
		return { count: row, dim, ids, paths, matrix, model: stats.model };
	}

	function ensureMatrix(vaultId, space) {
		return cached(matrixCache, vaultId, space, () => buildMatrix(vaultId, space));
	}

	return {
		name: 'brute-force-js',
		stats(vaultId, space) {
			return readStats(vaultId, space);
		},
		invalidate(vaultId) {
			if (vaultId === undefined) {
				statsCache.clear();
				matrixCache.clear();
				return;
			}
			// Drops every space's entry for this vault, not just the one that was written.
			statsCache.delete(vaultKey(vaultId));
			matrixCache.delete(vaultKey(vaultId));
			// The unscoped (/health) stats view covers every vault, so any write invalidates it.
			statsCache.delete(null);
			matrixCache.delete(null);
		},
		// Brute force over the FULL matrix — every chunk in the vault, not the FTS candidate
		// pool. Reranking FTS candidates by vector similarity cannot surface a note that
		// shares no keywords with the query, which is the entire reason this leg exists.
		// Measured 13ms at 384d / 33ms at 1024d over 52,257 chunks; the interactive ceiling
		// is ~250k chunks, past which the move is worker sharding (see the plan), not int8 —
		// int8 measured *slower* in scalar JS at this size, 19.6ms vs 12.4ms at 384d.
		knn(vaultId, queryVector, k, space) {
			const state = ensureMatrix(vaultId, space);
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
//
// `expanded` is the per-term FTS5 expression list the two clauses are assembled from (the
// trailing term already prefix-expanded). It is exported on the result so the coverage leg
// can ask "does THIS one term appear anywhere in this path" using exactly the same notion of
// a term the primary clause uses — a second, subtly different quoting/expansion rule would
// make coverage disagree with bm25 about what matched.
export function buildFtsQuery(query) {
	const terms = tokenizeQuery(query);
	if (terms.length === 0) {
		const literal = quoteFts(String(query ?? '').trim());
		return { terms, phrase: literal, primary: literal, fallback: literal, expanded: [] };
	}
	const quoted = terms.map(quoteFts);
	const phrase = quoteFts(terms.join(' '));
	const expanded = quoted.slice(0, -1).concat(`${quoted[quoted.length - 1]}*`);
	return {
		terms,
		phrase,
		primary: `(${phrase}) OR (${expanded.join(' AND ')})`,
		fallback: `(${expanded.join(' OR ')})`,
		expanded,
	};
}

// Ranking modes (`rankingMode` on POST /v1/search). Two candidate directions from the WP-4
// diagnosis, selectable per request so a bake-off could measure them against each other before
// either became the default.
//
//   current         the pre-bake-off ranking: strict AND primary, loose-OR only as a zero-hit rescue
//   blend           always run the loose-OR fallback too and union its pooled rows in
//   coverage        add a document-level term-coverage leg as a fourth RRF rank
//   blend+coverage  both
//
// The two are orthogonal on purpose — blend widens the *bm25 candidate pool*, coverage adds a
// *separate retrieval leg* (structurally the vector leg's twin) without touching the FTS
// clause at all — so the four modes form a clean 2x2 for the bake-off.
//
// **The default is `'coverage'`, by measurement, not inspection** (eval-harness
// `measurements/fsq-bakeoff-2026-07-26/run.md`; 46 graded queries against a copy of the live
// index): the only mode that improved every headline metric with zero rank-1 losses — MRR +15%,
// R@25 +26%, 8 targets rescued / 0 lost, sign test p = 0.00052, +3–14ms p50 on realistic 1–4
// term queries. The entire win is the split-terms family (terms present in a note but never
// co-occurring in one chunk — the per-chunk implicit AND root cause). `blend` measured
// net-negative on its own (MRR −13%, every severe rank-1 displacement in the sweep, 5.4x
// latency at 5–8 terms) — do not promote it to default; it remains a per-request option.
// `'current'` remains selectable per request as the pre-flip baseline.
export const RANKING_MODES = Object.freeze(['current', 'blend', 'coverage', 'blend+coverage']);
export const DEFAULT_RANKING_MODE = 'coverage';

// An unrecognized mode is a 400, not a silent degrade to the default. A typo in a bake-off
// harness that quietly measured the default four times would be indistinguishable from a real
// null result, which is the one failure this flag exists to avoid. Absent/empty is not a typo —
// that is every existing client, and it means the default.
export function parseRankingMode(value) {
	if (value === undefined || value === null || value === '') return DEFAULT_RANKING_MODE;
	const mode = String(value).trim().toLowerCase();
	if (!RANKING_MODES.includes(mode)) {
		throw new HttpError(400, `unknown rankingMode "${String(value)}"; expected one of ${RANKING_MODES.join(', ')}`);
	}
	return mode;
}

export function rankingModeFlags(mode) {
	const resolved = RANKING_MODES.includes(mode) ? mode : DEFAULT_RANKING_MODE;
	return {
		mode: resolved,
		blend: resolved === 'blend' || resolved === 'blend+coverage',
		coverage: resolved === 'coverage' || resolved === 'blend+coverage',
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

// Which of the query's terms this row's entity facet accounts for — the reason an entity hit is
// *visible* rather than merely effective.
//
// Without it the facet is invisible in the response: an author match raises the row's bm25 (the
// `entities` column carries weight 8.0) and nothing anywhere says why, so a result that looks
// unrelated to every word on the page is indistinguishable from a ranking bug. The rest of
// `attribution` exists for exactly that reason and this is its entity-facet entry.
//
// Returns `null` — not `[]` — for a row whose entity text is empty, so the attribution keys are
// omitted entirely rather than asserting "this row has entities, none matched". `[]` is that
// second, different statement and is reported as such. This is the same "omitted, not 0" rule
// `scoreVector` and the coverage keys follow.
//
// Matching is whole-word-or-prefix against the normalized entity text, which mirrors what the
// FTS clause actually did: every term is a whole word except the trailing one, which
// buildFtsQuery prefix-expands as `term*`. Applying the prefix rule to every term slightly
// over-reports a non-trailing partial (`mat` would credit `Matt`); the alternative under-reports
// the trailing term on every type-ahead query, which is the common case.
export function matchedEntityTerms(terms, entitiesText) {
	const normalized = normalizeForMatch(entitiesText);
	if (!normalized) return null;
	// Leading-space padding turns one `includes` into "starts at a word boundary", which is both
	// the whole-word and the prefix test at once — and it keeps working for a term that
	// normalizes to more than one word (`bge-m3/f16`-shaped tokens do).
	const haystack = ` ${normalized}`;
	const hits = [];
	for (const term of Array.isArray(terms) ? terms : []) {
		const needle = normalizeForMatch(term);
		if (!needle || hits.includes(term)) continue;
		if (haystack.includes(` ${needle}`)) hits.push(term);
	}
	return hits;
}

// Reciprocal-rank fusion over three rankings of the same candidate set: the weighted bm25
// order (already the row order coming out of SQL), the title/path-match order, and the
// cosine order from the vector scan. Fusing ranks rather than hand-tuning one score is the
// point — the three scales are not commensurable, but their ranks are. A row missing from a
// list simply contributes 0 from it, which is how a keyword-only hit and a vector-only hit
// coexist in one ordering.
//
// `vectorRows` carries rows the vector scan found that FTS never returned; their `textRank`
// is 0 (absent from the bm25 list) rather than a made-up large rank. `coverageRows` is the
// exact same arrangement for the optional document-level term-coverage leg, which is why the
// two share `makeEntry` rather than growing a second row shape.
//
// The coverage list is opt-in (`rankingMode`): with `coverageScores` absent, nothing about
// this function's output changes — not the ordering, and not the payload, since the two
// coverage attribution keys are then never written at all. That is the same "omitted, not 0"
// rule `scoreVector` already follows.
//
// Sign convention: bm25 is negative/lower-is-better inside SQL and is negated here, so
// every score the client sees (`score`, `scoreText`, `scoreRrf`, `attribution.base`) is
// positive and higher-is-better. Cosine (`scoreVector`) is already higher-is-better, and so
// is coverage (a 0..1 fraction of the query's terms found anywhere in the document).
export function fuseSearchRows(rows, options = {}) {
	const terms = options.terms ?? [];
	const k = options.k ?? RRF_K;
	const titleWeight = options.titleWeight ?? RRF_TITLE_WEIGHT;
	const vectorWeight = options.vectorWeight ?? RRF_VECTOR_WEIGHT;
	const coverageWeight = options.coverageWeight ?? RRF_COVERAGE_WEIGHT;
	const vectorScores = options.vectorScores ?? null;
	const vectorRows = options.vectorRows ?? [];
	const coverageScores = options.coverageScores ?? null;
	const coverageRows = options.coverageRows ?? [];
	const limit = options.limit ?? (rows.length + vectorRows.length + coverageRows.length);

	const makeEntry = (row, textRank) => ({
		row,
		base: -Number(row.score_text ?? 0),
		titleBoost: titleMatchScore(terms, row),
		// Attribution only — the entity facet's effect on ranking is already inside `score_text`
		// (it is an indexed bm25 column, not a separate leg), so nothing here feeds the fusion.
		// Reporting it is the point: see matchedEntityTerms.
		entityTerms: matchedEntityTerms(terms, row.entities),
		textRank,
		titleRank: 0,
		vectorRank: 0,
		coverageRank: 0,
		vectorScore: vectorScores?.has(row.path) ? vectorScores.get(row.path) : null,
		coverageScore: coverageScores?.has(row.path) ? coverageScores.get(row.path) : null,
		rrf: 0,
	});
	// Tie-breaks fall back to bm25 order; an entry absent from that list sorts last among
	// ties rather than first, which a bare `textRank` of 0 would do.
	const textOrder = entry => entry.textRank || Number.MAX_SAFE_INTEGER;

	const entries = rows.map((row, index) => makeEntry(row, index + 1));
	for (const row of vectorRows) entries.push(makeEntry(row, 0));
	for (const row of coverageRows) entries.push(makeEntry(row, 0));

	const titled = entries
		.filter(entry => entry.titleBoost > 0)
		.sort((a, b) => (b.titleBoost - a.titleBoost) || (textOrder(a) - textOrder(b)));
	titled.forEach((entry, index) => { entry.titleRank = index + 1; });

	const vectored = entries
		.filter(entry => entry.vectorScore !== null)
		.sort((a, b) => (b.vectorScore - a.vectorScore) || (textOrder(a) - textOrder(b)));
	vectored.forEach((entry, index) => { entry.vectorRank = index + 1; });

	// Coverage ties are common by construction (every path covering 3 of 5 terms scores the
	// same), so the bm25 tie-break carries real weight here: among equally-covering paths the
	// one the strict AND already liked stays ahead, and coverage-only paths sort behind them
	// in the order the leg produced.
	const covered = entries
		.filter(entry => entry.coverageScore !== null)
		.sort((a, b) => (b.coverageScore - a.coverageScore) || (textOrder(a) - textOrder(b)));
	covered.forEach((entry, index) => { entry.coverageRank = index + 1; });

	for (const entry of entries) {
		entry.rrf = (entry.textRank ? 1 / (k + entry.textRank) : 0)
			+ (entry.titleRank ? titleWeight / (k + entry.titleRank) : 0)
			+ (entry.vectorRank ? vectorWeight / (k + entry.vectorRank) : 0)
			+ (entry.coverageRank ? coverageWeight / (k + entry.coverageRank) : 0);
	}
	entries.sort((a, b) => (b.rrf - a.rrf) || (textOrder(a) - textOrder(b)));

	return entries.slice(0, Math.max(0, limit)).map(entry => {
		// Per-stage attribution: the base score, every boost that fired, and the fused
		// value, so ranking is tunable by observation instead of guesswork. `boosts` is the
		// open slot for client-side stages (link adjacency, recency) to record themselves.
		const attribution = {
			base: entry.base,
			textRank: entry.textRank || null,
			titleRank: entry.titleRank || null,
			titleBoost: entry.titleBoost,
			vectorRank: entry.vectorRank || null,
			rrf: entry.rrf,
			pooledChunks: Number(entry.row.pooled_chunks ?? 1),
		};
		// Appended only for a row that actually carries an entity facet, so a vault with no
		// `author:` frontmatter anywhere gets the same object, key for key, it got before schema
		// 7 — the same rule the coverage keys below follow. An empty array is a real answer
		// ("this note names entities, none of them answered your query"), not a missing one.
		if (entry.entityTerms) attribution.entityTerms = entry.entityTerms;
		// Appended only when the coverage leg actually ran, so a default-mode response is the
		// same object, with the same keys in the same order, that it was before this existed.
		if (coverageScores) {
			attribution.coverageRank = entry.coverageRank || null;
			attribution.coverageScore = entry.coverageScore;
		}
		return {
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
			attribution,
		};
	});
}

// Which embedding space — if any — this request's vector scan may cover.
//
// The rule the whole feature turns on: a query vector may only ever be scored against vectors
// produced in the same space. Two same-width spaces in one vault used to load into one matrix
// and get cosine-scored against each other, with nothing anywhere reporting it.
//
// Returns `{ space, note, skip }`:
//   space  → bind as the scan's filter; null means "no filter needed", which is only ever
//            returned when the vault holds exactly one space (or reports none at all)
//   skip   → answer with keywords alone; `note` says why. Never an error: failing a whole
//            search over a transient model switch is worse than answering without vectors,
//            exactly as the query-width mismatch already decided.
//   note   → also set on the non-skip mixed-index path, because a scan that silently covered
//            only part of the index would be the quiet half of the same bug.
//
// A backend reporting no `spaces` at all (a test double, an older seam implementation) is
// treated as single-space rather than unusable: unknown must not disable semantic search.
export function resolveScanSpace(stats, requested) {
	const spaces = Array.isArray(stats?.spaces) ? stats.spaces.filter(space => typeof space === 'string' && space !== '') : [];
	const unlabelled = Number(stats?.unlabelledCount ?? 0) > 0;
	const distinct = spaces.length + (unlabelled ? 1 : 0);
	const want = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : null;
	const listed = () => (unlabelled ? [...spaces, '(unattributed)'] : spaces).map(space => `"${space}"`).join(', ');

	if (distinct === 0) return { space: null, note: null, skip: false };

	if (distinct === 1) {
		// Unattributed vectors: legitimate for an index written before this column existed and
		// not yet restarted through the migration. There is no way to prove they share the
		// query's space, so a request that names one degrades rather than assuming.
		if (unlabelled) {
			if (!want) return { space: null, note: null, skip: false };
			return {
				space: null,
				skip: true,
				note: `this vault's vectors carry no embedding-space attribution, so they cannot be matched against a query embedded in "${want}"; semantic ranking skipped until the index is rebuilt`,
			};
		}
		const only = spaces[0];
		if (want && want !== only) {
			return {
				space: null,
				skip: true,
				note: `this vault is indexed in embedding space "${only}" but the query was embedded in "${want}"; semantic ranking skipped`,
			};
		}
		// One space, and either the query agrees or predates the field: scan it all, exactly as
		// before schema 4.
		return { space: null, note: null, skip: false };
	}

	if (!want) {
		return {
			space: null,
			skip: true,
			note: `this vault holds ${distinct} embedding spaces (${listed()}) and the query named none, so no scan can be scored honestly; semantic ranking skipped until the index is rebuilt`,
		};
	}
	if (!spaces.includes(want)) {
		return {
			space: null,
			skip: true,
			note: `this vault holds ${distinct} embedding spaces (${listed()}), none of them "${want}"; semantic ranking skipped`,
		};
	}
	return {
		space: want,
		skip: false,
		note: `this vault holds ${distinct} embedding spaces (${listed()}); semantic ranking covered only "${want}"`,
	};
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
	const outcome = { used: false, available: false, scores: null, rows: [], note: null, dim: null, model: null, space: null };
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

	// Space before width: a mixed index can hold a space this query has no business scanning at
	// all, and the width it would be compared against is the *scanned* space's, not the vault's.
	const resolved = resolveScanSpace(stats, options.embeddingSpace);
	outcome.space = resolved.space;
	outcome.note = resolved.note;
	if (resolved.skip) return outcome;
	const scanStats = resolved.space ? vectors.stats(options.vaultId, resolved.space) : stats;
	outcome.dim = scanStats.dim;

	if (queryEmbedding.length !== scanStats.dim) {
		outcome.note = `query embedding is ${queryEmbedding.length}-dimensional but this vault is indexed at ${scanStats.dim}; semantic ranking skipped`;
		return outcome;
	}

	let hits;
	try {
		hits = vectors.knn(options.vaultId, queryEmbedding, options.poolSize, resolved.space);
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
		const row = hydrate.get(options.vaultId, chunkId);
		if (!row) continue;
		outcome.rows.push({
			id: row.id,
			path: row.path,
			title: row.title,
			heading: row.heading,
			// Hydrated for attribution parity: a vector-only row still reports which of the
			// query's terms its entity facet accounts for, so "why is this here" reads the same
			// whichever leg produced the row.
			entities: row.entities,
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

// The document-level term-coverage leg (rankingMode 'coverage'/'blend+coverage'): how many of
// the query's terms appear in ANY chunk of a given path, regardless of whether any single chunk
// holds them all. It is the WP-4 diagnosis' candidate 2 — the root cause there is that FTS5's
// implicit AND is per *chunk*, so a note whose terms are legitimately present but scattered
// across its own headings can never satisfy a multi-term AND, and at vault scale the loose-OR
// rescue is starved because some unrelated document coincidentally does.
//
// Structurally this is the vector leg's twin, and deliberately so: a separate retrieval whose
// ranking joins the fusion, contributing hydrated rows for paths the FTS pool never returned
// (`score_text: null` — they did not match the FTS clause, and inventing a bm25 rank for them
// would be a lie). It therefore changes nothing about what qualifies for the *bm25* candidate
// pool; the strict AND stays exactly the query it was.
//
// Cost shape, since this is the leg's only real risk: one FTS MATCH per query term, presence-
// only (no bm25/snippet), so it is cheaper per term than a search but scales with how much of
// the index each term matches — the same variable that governs search latency generally (see
// src/search/AGENTS.md). That is measured by the bake-off, not guessed at here.
function runCoverageLeg(db, options) {
	const outcome = { used: false, scores: null, rows: [], degraded: false };
	const terms = Array.isArray(options.terms) ? options.terms : [];
	const expanded = Array.isArray(options.expanded) ? options.expanded : [];
	// Fewer than two terms cannot express co-occurrence, and a one-term query's strict AND is
	// that single term — the FTS pool already holds every path this leg could name.
	if (terms.length < COVERAGE_MIN_TERMS || expanded.length !== terms.length) return outcome;

	const statement = options.statement ?? db.prepare(COVERAGE_SQL);
	// WP-5: the deadline this leg's own comment already called out as the real cost risk (up to
	// MAX_QUERY_TERMS FTS scans, measured +580ms at 9+ terms) — checked BETWEEN term scans, never
	// inside one. `now`/`deadlineAt` default to a real clock / no deadline so every pre-WP-5 call
	// site (every existing test, every plugin request today) is unaffected.
	const now = options.now ?? Date.now;
	const deadlineAt = options.deadlineAt ?? Infinity;
	// Distinct terms per path, and per chunk: the path count is the coverage score, the chunk
	// count picks which chunk to hydrate for a path the FTS pool never returned (the one that
	// covers the most of the query is the one worth showing the user).
	const pathTerms = new Map();
	const chunkTerms = new Map();
	const chunkPath = new Map();
	for (const expression of expanded) {
		// Stopping early still returns real, if partial, coverage: every term already scanned
		// stays in pathTerms/chunkTerms, so a path's score (count / terms.length, computed below)
		// can only be an UNDERcount of its true coverage, never an overcount — safe in the
		// direction that matters for an additive, never-authoritative fourth RRF leg.
		if (now() >= deadlineAt) {
			outcome.degraded = true;
			break;
		}
		// A path/chunk can appear many times for one term; the Sets make the count distinct-by-
		// term rather than by-hit, which is what "how many of the query's terms" means.
		const seenPaths = new Set();
		const seenChunks = new Set();
		for (const row of statement.all(options.vaultId, expression)) {
			if (!seenPaths.has(row.path)) {
				seenPaths.add(row.path);
				pathTerms.set(row.path, (pathTerms.get(row.path) ?? 0) + 1);
			}
			if (!seenChunks.has(row.id)) {
				seenChunks.add(row.id);
				chunkTerms.set(row.id, (chunkTerms.get(row.id) ?? 0) + 1);
				chunkPath.set(row.id, row.path);
			}
		}
	}
	if (pathTerms.size === 0) return outcome;

	const scores = new Map();
	for (const [path, count] of pathTerms) {
		if (count < COVERAGE_MIN_TERMS) continue;
		scores.set(path, count / terms.length);
	}
	if (scores.size === 0) return outcome;
	outcome.used = true;

	// Truncate the *ranked* list, never the per-term path lists: counting first and cutting
	// afterwards is what keeps every surviving coverage score exact.
	const ranked = [...scores.entries()]
		.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.slice(0, Math.max(0, options.poolSize ?? scores.size));
	outcome.scores = new Map(ranked);

	// Best-covering chunk per path, for the paths that need hydrating.
	const bestChunk = new Map();
	for (const [chunkId, count] of chunkTerms) {
		const path = chunkPath.get(chunkId);
		const previous = bestChunk.get(path);
		if (previous === undefined || count > previous.count) bestChunk.set(path, { id: chunkId, count });
	}

	const known = options.knownPaths ?? new Set();
	const hydrate = options.hydrate ?? db.prepare(HYDRATE_CHUNK_SQL);
	for (const [path] of ranked) {
		if (known.has(path)) continue;
		const best = bestChunk.get(path);
		if (!best) continue;
		const row = hydrate.get(options.vaultId, best.id);
		if (!row) continue;
		outcome.rows.push({
			id: row.id,
			path: row.path,
			title: row.title,
			heading: row.heading,
			// Same attribution parity as the vector leg's hydrated rows.
			entities: row.entities,
			metadata_json: row.metadata_json,
			snippet: makeTextSnippet(row.text),
			score_text: null,
			pooled_chunks: 1,
		});
	}
	return outcome;
}

// Union the loose-OR fallback's pooled rows into the primary AND's, for rankingMode 'blend'.
//
// A path present in both keeps the *primary* row: its bm25 reflects a real strict match, and
// the two scores are not comparable anyway (different MATCH expressions mean different term
// sets and different IDF), which is also why the fallback-only rows are appended in their own
// bm25 order rather than merge-sorted into the primary's. `fuseSearchRows` reads position as
// textRank, so appending is exactly the statement "every strict-AND match outranks every
// loose-OR-only one on the text leg" — the blend widens recall without demoting the rows the
// current mode already trusts.
export function blendPooledRows(primaryRows, fallbackRows) {
	const seen = new Set(primaryRows.map(row => row.path));
	const added = [];
	for (const row of fallbackRows) {
		if (seen.has(row.path)) continue;
		seen.add(row.path);
		added.push(row);
	}
	return { rows: added.length > 0 ? primaryRows.concat(added) : primaryRows, added: added.length };
}

export function runSearch(db, options) {
	const vaultId = options.vaultId;
	const limit = clampLimit(options.limit);
	const statement = options.statement ?? db.prepare(SEARCH_SQL);
	const built = buildFtsQuery(options.query);
	const poolSize = Math.max(limit * SEARCH_POOL_FACTOR, SEARCH_POOL_MIN);
	const ranking = rankingModeFlags(options.rankingMode ?? DEFAULT_RANKING_MODE);
	// WP-5 cooperative deadline. `now`/`deadlineAt` default to a real clock / no deadline
	// (Infinity), so every call site that does not opt in — every existing test, and any future
	// caller that omits `deadlineAt` — runs exactly the pre-WP-5 code path and can never produce
	// a `degraded` response. A request that finishes inside budget is therefore byte-identical to
	// before this change; only a request that is genuinely over budget at a checkpoint changes
	// shape at all.
	const now = options.now ?? Date.now;
	const deadlineAt = options.deadlineAt ?? Infinity;
	let degraded = false;
	const overBudget = () => now() >= deadlineAt;

	let match = built.primary;
	let matchFallback = null;
	let fallbackUsed = false;
	let blendedTotal = null;
	// WP-3 pre-flight checkpoint: every checkpoint below this line assumes the primary scan
	// already ran and only bounds what happens *after* it — so a request that arrives already
	// over budget (queued behind one or more upsert sub-batches before the handler even got to
	// run) still paid for the scan itself. Check first and skip it entirely when already doomed;
	// the rescue/vector/coverage checkpoints further down all call overBudget() on their own and
	// see the same expired deadline, so they fall out with no special-casing beyond this.
	let rows;
	if (overBudget()) {
		degraded = true;
		rows = [];
	} else {
		rows = statement.all(vaultId, match, poolSize);
	}
	// `fallbackUsed` reports what actually contributed to this response, and that reading is
	// the same in both branches — it just cannot be observed the same way. Under 'current' the
	// loose-OR only ever runs *instead of* the primary (which returned nothing), so "it ran" and
	// "it contributed" are the same event and the flag keeps its exact historical assignment,
	// true even in the degenerate case where the rescue itself also matched nothing. Under
	// 'blend' both queries always run, so "it ran" would be true on every multi-term search and
	// carry no information; the flag therefore reports whether the loose-OR contributed any path
	// the strict AND had not already found.
	// The two-term floor is not cosmetic: with one term the AND clause *is* that term, so the
	// loose-OR form matches exactly the same set and blending it in can only cost a second full
	// FTS scan for zero added paths — and a one- or two-character prefix query is the most
	// expensive scan the companion runs (see src/search/AGENTS.md's latency table).
	if (ranking.blend && built.terms.length >= 2 && built.fallback !== built.primary) {
		// WP-5 checkpoint: the blend fallback is a second full bm25/snippet/pooled scan, exactly
		// as expensive as the zero-hit rescue below. `blend` is not the default mode, but a
		// caller that explicitly asked for it still gets the same budget protection.
		if (overBudget()) {
			degraded = true;
		} else {
			matchFallback = built.fallback;
			const fallbackRows = statement.all(vaultId, matchFallback, poolSize);
			const blended = blendPooledRows(rows, fallbackRows);
			rows = blended.rows;
			fallbackUsed = blended.added > 0;
			// The loose-OR match set is a strict superset of the primary's (a document matching
			// the phrase, or every term in one chunk, matches the OR of those terms too), so the
			// OR's own distinct-path count is exactly the blended candidate total — no double
			// counting.
			if (fallbackRows.length > 0) blendedTotal = Number(fallbackRows[0].total_paths ?? fallbackRows.length);
		}
	} else if (rows.length === 0 && built.fallback !== built.primary) {
		// WP-5 checkpoint, and the load-bearing one: WP-2 measured the zero-hit loose-OR rescue
		// as ~65% of a pathological query's total server-side cost (~435-454ms of ~674-800ms). It
		// is one monolithic prepared statement — there is no internal checkpoint to add inside
		// it — so the only place to bound it is the gate immediately before running it at all. On
		// budget exceed, skip the rescue and return exactly what the strict-AND primary produced
		// (here, zero rows), marked degraded rather than blocking to completion regardless of how
		// much of the budget the primary clause and any queuing ahead of this request already
		// spent.
		if (overBudget()) {
			degraded = true;
		} else {
			match = built.fallback;
			fallbackUsed = true;
			rows = statement.all(vaultId, match, poolSize);
		}
	}

	// WP-5 checkpoint around the vector leg: normally 13-33ms (a KNN scan), but a matrix rebuild
	// mid-backfill measures up to ~800ms (src/search/AGENTS.md). Skipped entirely over budget
	// rather than degrading it internally — like the rescue, it is not worth a partial-scan
	// checkpoint on its own, and a search missing its semantic leg is exactly the existing
	// FTS-only degrade path (`vector.available: false`), not a new failure shape.
	let vector = { used: false, available: false, scores: null, rows: [], note: null, dim: null, model: null, space: null };
	if (overBudget()) {
		degraded = true;
	} else {
		vector = runVectorLeg(db, {
			vaultId,
			vectors: options.vectors,
			queryEmbedding: options.queryEmbedding,
			embeddingSpace: options.embeddingSpace,
			poolSize,
			hydrate: options.hydrate,
			knownPaths: new Set(rows.map(row => row.path)),
		});
	}

	let coverage = { used: false, scores: null, rows: [], degraded: false };
	if (ranking.coverage) {
		if (overBudget()) {
			degraded = true;
		} else {
			coverage = runCoverageLeg(db, {
				vaultId,
				terms: built.terms,
				expanded: built.expanded,
				poolSize,
				statement: options.coverageStatement,
				hydrate: options.hydrate,
				// Both already-present sets, so one path never enters the fusion twice.
				knownPaths: new Set([...rows.map(row => row.path), ...vector.rows.map(row => row.path)]),
				now,
				deadlineAt,
			});
			if (coverage.degraded) degraded = true;
		}
	}

	// `total` stays the distinct-path FTS match count plus the paths only the vector scan
	// found. A vector-only path that FTS would also have matched *beyond* the pool is
	// counted twice; that only nudges the "N more" hint, and the alternative is a second
	// MATCH per search, which is exactly the cost the pooled CTE was built to remove. The
	// coverage leg's extra paths are counted on exactly the same terms.
	const ftsTotal = blendedTotal ?? (rows.length > 0 ? Number(rows[0].total_paths ?? rows.length) : 0);
	const total = ftsTotal + vector.rows.length + coverage.rows.length;
	const results = fuseSearchRows(rows, {
		terms: built.terms,
		limit,
		vectorScores: vector.scores,
		vectorRows: vector.rows,
		coverageScores: coverage.scores,
		coverageRows: coverage.rows,
	});
	return {
		match,
		matchFallback,
		rankingMode: ranking.mode,
		terms: built.terms,
		fallbackUsed,
		coverageUsed: coverage.used,
		total,
		results,
		vectorUsed: vector.used,
		semanticAvailable: vector.available,
		embeddingDim: vector.dim,
		embeddingModel: vector.model,
		embeddingSpace: vector.space,
		note: vector.note,
		degraded,
	};
}

function clampLimit(value) {
	const limit = Number(value ?? DEFAULT_LIMIT);
	if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(Math.floor(limit), MAX_LIMIT));
}

// A bulk upsert used to run as one BEGIN/COMMIT transaction over every chunk in the request —
// hundreds at a time. `node:sqlite`'s `DatabaseSync` is synchronous, so that whole transaction
// ran without ever yielding the event loop, and a `/health` request arriving mid-upsert simply
// queued behind it: measured 17 such probe timeouts in one indexing run, each landing right
// before a +500 chunk counter jump on a companion that was never actually down (see
// SEARCH_PROBE_TIMEOUT_ESCALATION_THRESHOLD on the client side, which is the other half of
// this fix). Splitting into sub-batches, each its own transaction with an event-loop yield
// between them, lets a pending `/health` (or any other request) get serviced between chunks
// of the upsert instead of only after all of it completes.
//
// Chunk upserts are idempotent per `(vault_id, id)` (a full replace, not a merge — see
// upsertChunk below), so a sub-batch committing before a later one in the same request throws
// is safe: re-sending the request repeats already-correct work rather than corrupting it. That
// idempotency guarantee holds only at the granularity of a whole PATH, though: the first chunk
// seen for a `(vaultId, path)` deletes every existing row for that path before any new rows for
// it are inserted (a full replace, not a merge — see `clearedPaths` below), so if that path's
// chunks were split across two sub-batches and the second one throws, the path would be left
// with its old rows deleted and only some of its new rows committed — stale AND wrong, and
// worse than the pre-split behavior (one transaction, so a throw anywhere rolled the whole
// request back and left the path's previous rows untouched). `splitUpsertSubBatches` therefore
// groups by `(vaultId, path)` first and packs whole groups into sub-batches, letting a
// sub-batch overflow the target size rather than splitting a group. The invariant this
// guarantees: a path's chunks never span sub-batches, so a mid-request failure can leave a path
// stale (untouched, if its sub-batch never ran) or fully-new (committed, if its sub-batch did)
// but never half-written.
export const UPSERT_SUB_BATCH_CHUNKS = 100;

// WP-4: interactive-priority yield. A sub-batch is an uninterruptible ~3.4s synchronous
// transaction (measured at the ~17s/500-chunk throughput this file's other comments cite) —
// `yieldEventLoop()` between sub-batches only lets a QUEUED request start, it does not make the
// flush loop stand aside once a search has actually landed. Without this, a user actively
// searching mid-backfill gets exactly one sub-batch's worth of latency per query and then the
// flush immediately claims the thread again for another 3.4s block. 1500ms is chosen as roughly
// the gap a person leaves between typing a query and its follow-up (a refined term, a repeat
// search) — long enough that a follow-up query lands in the open window and gets served promptly
// rather than queuing behind another full sub-batch, short enough that the backfill still visibly
// grinds forward between searches rather than looking stalled.
export const INTERACTIVE_YIELD_MS = 1500;

// Bounds INTERACTIVE_YIELD_MS's total cost across one flush. Deferral is deliberately per-search
// (see lastInteractiveSearchAt below) so it decays on its own once queries stop arriving, but a
// user who searches continuously — or a scripted client polling — must not be able to hold the
// flush loop open indefinitely; a backfill has to finish. 15s caps the worst case to roughly ten
// extra sub-batch-sized gaps before the flush runs the rest of its sub-batches back-to-back
// regardless of further searches.
export const INTERACTIVE_YIELD_CUMULATIVE_CAP_MS = 15_000;

// Pure and exported for unit testing without a database — see the module-shape note at the top
// of this file. `size <= 0` is treated as "no splitting" (one batch) rather than looping
// forever.
//
// `fallbackVaultId` mirrors the per-chunk `chunk.vaultId ?? body.vaultId` resolution the request
// handler applies when actually writing each chunk (a chunk may omit its own `vaultId` and rely
// on the request's top-level one). Grouping on `chunk.vaultId` alone, ignoring that fallback,
// could split what is really one (vaultId, path) group in two — one sub-group keyed on the
// explicit vaultId a sibling chunk happened to repeat, one keyed on `undefined` — which would
// silently reopen the same straddling bug this helper exists to close. Pass it whenever the
// caller has a request-level `vaultId` to fall back to.
export function splitUpsertSubBatches(chunks, size = UPSERT_SUB_BATCH_CHUNKS, fallbackVaultId) {
	if (!Array.isArray(chunks) || chunks.length === 0) return [];
	const target = size > 0 ? size : Infinity;

	// Group by (vaultId, path), preserving first-seen order. Callers already send one path's
	// chunks contiguously in practice, but this does not assume it — every chunk is grouped by
	// identity, not by position, so even a caller that interleaves two paths' chunks still gets
	// each path's chunks packed together, never split.
	const groups = [];
	const groupIndexByKey = new Map();
	for (const chunk of chunks) {
		const vaultId = (chunk && chunk.vaultId) ?? fallbackVaultId;
		const key = `${vaultId}\n${chunk && chunk.path}`;
		let index = groupIndexByKey.get(key);
		if (index === undefined) {
			index = groups.length;
			groupIndexByKey.set(key, index);
			groups.push([]);
		}
		groups[index].push(chunk);
	}

	// Pack whole groups into sub-batches of ~`size`, letting a sub-batch overflow rather than
	// split a group — see the invariant documented above UPSERT_SUB_BATCH_CHUNKS. A single path
	// with more than `size` chunks becomes its own oversized sub-batch; that's the pre-existing
	// atomicity for that path, not a regression.
	const batches = [];
	let current = [];
	let currentCount = 0;
	for (const group of groups) {
		if (current.length > 0 && currentCount + group.length > target) {
			batches.push(current);
			current = [];
			currentCount = 0;
		}
		current.push(...group);
		currentCount += group.length;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

export function createRequestHandler(db, options = {}) {
	// The vector backend is injectable so a different implementation (or a test double) can
	// take over without touching a single line of the request handling below — that is the
	// seam doing its job.
	const vectors = options.vectors ?? createVectorBackend(db);
	// WP-3: injectable clock, same pattern as runSearch's own `now` option below — production
	// always gets the real Date.now via the default, and a real-HTTP test can inject a
	// controlled clock so the sentAt/skew deadline math is deterministic instead of racing the
	// wall clock.
	const now = options.now ?? Date.now;
	// WP-4: injectable pause, same pattern and same reason as `now` above — production always
	// gets the real `setTimeout` promise, and a real-HTTP test can inject a stub that records the
	// requested duration and resolves immediately, so the interactive-yield/cumulative-cap tests
	// are deterministic instead of actually sleeping 1500ms+ per case.
	const delay = options.delay ?? sleepMs;
	// WP-4: shared across every request this handler instance processes (not per-request state) —
	// the flush loop below needs to know whether a search landed *during this flush*, and a
	// search is necessarily a different request than the upsert. Read/written only through `now`
	// so it participates in the same injected-clock determinism as the rest of the deadline math.
	let lastInteractiveSearchAt = -Infinity;
	// Every statement below is keyed by `(vault_id, id)` or `(vault_id, path)`, never by `id`
	// alone. `ON CONFLICT(vault_id, id)` is the load-bearing half: under the old `ON
	// CONFLICT(id)` an upsert from vault B silently re-labelled vault A's row as B's, which is
	// how one vault's index destroyed another's. `vault_id` is no longer in the SET list
	// because it is now part of the conflict key and can only ever equal `excluded.vault_id`.
	// `RETURNING rowid` is schema 6's other half: the caller needs the chunk's `chunks.rowid` —
	// unchanged by an ON CONFLICT UPDATE, freshly assigned by a plain INSERT — to pin the
	// matching `chunks_fts` row to the same rowid. Works identically for both branches, so the
	// caller does not need to know which one fired.
	const upsertChunk = db.prepare(`
INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model, embedding_space, entities)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(vault_id, id) DO UPDATE SET
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
  embedding_model = excluded.embedding_model,
  embedding_space = excluded.embedding_space,
  entities = excluded.entities
RETURNING rowid
`);
	const selectVaultEmbeddingDim = db.prepare('SELECT embedding_dim AS dim FROM chunks WHERE vault_id = ? AND embedding IS NOT NULL LIMIT 1');
	// The space twin of selectVaultEmbeddingDim, and read at the same moment for the same reason.
	// `embedding_space IS NOT NULL` skips unattributed legacy rows rather than reading their NULL
	// as a conflicting space: they carry no claim to contradict.
	const selectVaultEmbeddingSpace = db.prepare('SELECT embedding_space AS space FROM chunks WHERE vault_id = ? AND embedding IS NOT NULL AND embedding_space IS NOT NULL LIMIT 1');
	const hydrateChunk = db.prepare(HYDRATE_CHUNK_SQL);
	// Schema 6: keyed on `rowid`, an O(1) btree lookup, instead of `vault_id`/`id` — both
	// UNINDEXED FTS5 columns, so a delete keyed on either forced a full scan of the whole FTS
	// index (measured 24.2ms/delete at the live 53k-chunk size; see the SCHEMA_VERSION=6
	// comment at the top of the file). `chunks_fts.rowid` is pinned to the owning
	// `chunks.rowid` by FTS_REFILL_SQL and by `insertFts` below, so this is still exactly as
	// vault-scoped as the old `(vault_id, id)` key was — the rowid it deletes can only ever be
	// one specific chunk of one specific vault, it just no longer has to be told which vault
	// to find that out.
	const deleteFtsByRowid = db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
	const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, id, vault_id, path, title, heading, text, entities) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
	const deleteByPath = db.prepare('DELETE FROM chunks WHERE vault_id = ? AND path = ?');
	// Renamed from selectIdsByPath: both call sites only ever fed the result straight into an
	// FTS delete, and that delete is now rowid-keyed, so `rowid` is the only column either one
	// needs.
	const selectRowidsByPath = db.prepare('SELECT rowid FROM chunks WHERE vault_id = ? AND path = ?');
	// Reset scans `chunks` (indexed on `vault_id` via idx_chunks_vault_path) for the rowids to
	// delete, rather than `DELETE FROM chunks_fts WHERE vault_id = ?` — that key is UNINDEXED
	// on chunks_fts too, the same cost this whole schema bump removes everywhere else.
	const selectRowidsByVault = db.prepare('SELECT rowid FROM chunks WHERE vault_id = ?');
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
  MAX(embedding_model) AS embedding_model,
  SUM(CASE WHEN embedding IS NOT NULL AND embedding_space IS NOT NULL THEN 1 ELSE 0 END) AS embedded_spaced_count,
  COUNT(DISTINCT embedding_space) AS embedding_space_count,
  MAX(embedding_space) AS embedding_space
FROM chunks
WHERE vault_id = ? AND path = ?
GROUP BY path, content_hash
ORDER BY chunk_count DESC
LIMIT 1
`);
	const resetChunks = db.prepare('DELETE FROM chunks WHERE vault_id = ?');
	const searchStatement = db.prepare(SEARCH_SQL);
	// Prepared alongside the search statement even though only a non-default `rankingMode`
	// ever runs it — preparing is cheap and once, whereas preparing per request would put a
	// compile on the hot path of the mode we may be about to make the default.
	const coverageStatement = db.prepare(COVERAGE_SQL);

	return async (req, res) => {
		// WP-3: captured as the FIRST statement of the request handler, before anything else —
		// including the URL parse and, further down, `await readJson`, which is itself a yield
		// point a queued upsert flush sub-batch can preempt. This is what lets the /v1/search
		// deadline (below) account for the time a request spent waiting for this handler to even
		// start running, on top of whatever `sentAt` the client itself reports.
		const receivedAt = now();
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
					// Distinct spaces across every vault, so a mixed index is *visible* here
					// rather than inferred from searches that quietly went keyword-only. More
					// than one entry — or any unattributed vectors alongside attributed ones —
					// means some search will degrade; see resolveScanSpace.
					embeddingSpaces: stats.spaces ?? [],
					embeddingSpace: (stats.spaces ?? []).length === 1 && !stats.unlabelledCount ? stats.spaces[0] : null,
					unattributedEmbeddedChunks: stats.unlabelledCount ?? 0,
				});
			}
			if (req.method === 'POST' && url.pathname === '/v1/index/reset') {
				const body = await readJson(req);
				const vaultId = requireString(body.vaultId, 'vaultId');
				db.exec('BEGIN');
				try {
					// Rowids are read from `chunks` (vault_id-indexed via idx_chunks_vault_path)
					// *before* resetChunks deletes them — chunks_fts carries no independent record
					// of which rowids belonged to this vault, only chunks does.
					for (const row of selectRowidsByVault.all(vaultId)) deleteFtsByRowid.run(row.rowid);
					resetChunks.run(vaultId);
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
						for (const row of selectRowidsByPath.all(vaultId, path)) deleteFtsByRowid.run(row.rowid);
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
					const spacedCount = Number(row.embedded_spaced_count ?? 0);
					const spaceCount = Number(row.embedding_space_count ?? 0);
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
						// Same fail-closed conjunction as embeddingModel, deliberately — at least one
						// embedded chunk, exactly one distinct non-null value, and every embedded
						// chunk labelled. Anything else reports undefined, which the client reads as
						// "unknown" and therefore re-embeds rather than trusting.
						embeddingSpace: embeddedCount > 0 && spaceCount === 1 && spacedCount === embeddedCount && row.embedding_space
							? String(row.embedding_space)
							: undefined,
					});
				}
				return json(res, 200, { ok: true, files });
			}
			if (req.method === 'POST' && url.pathname === '/v1/chunks/upsert') {
				const body = await readJson(req);
				const chunks = Array.isArray(body.chunks) ? body.chunks : [];
				const touchedVaults = new Set();
				// Width *and* space consistency, enforced once per vault per REQUEST — across every
				// sub-batch below, not reset per sub-batch, so splitting the transaction does not
				// weaken the check. Mixing two vector spaces inside one index is the failure mode
				// that produces confidently wrong rankings with no error anywhere — and width alone
				// does not catch it: bge-m3 is 1024d under every quantization, so an fp32 index and
				// a Q4 re-index pass a width check unchanged. Both are refused here.
				//
				// Deliberately *not* also a per-batch space check, unlike `batchDim`. A mixed-width
				// batch cannot be stored coherently at all, whereas chunks disagreeing about their
				// producing model inside one batch is a state /v1/files/state already reports
				// fail-closed (it answers `undefined`, so the client re-embeds) and the scan filter
				// already survives. Refusing it here would only delete that defence's test coverage.
				const checkedVaults = new Set();
				const clearedPaths = new Set();
				let batchDim = null;
				// Split into sub-batches, each its own transaction, so a `/health` request (or
				// anything else) queued behind a large upsert gets serviced between them instead of
				// only after the whole thing completes. See UPSERT_SUB_BATCH_CHUNKS. `body.vaultId`
				// is passed as the fallback so grouping matches the same `chunk.vaultId ?? body.vaultId`
				// resolution used below when a chunk omits its own vaultId.
				const subBatches = splitUpsertSubBatches(chunks, UPSERT_SUB_BATCH_CHUNKS, body.vaultId);
				// WP-4: this flush's own interactive-yield state. `flushStartedAt` scopes
				// `lastInteractiveSearchAt` (shared across every request this handler instance
				// processes, since a search always arrives as a separate request from the flush) to
				// "served during THIS flush" — a search served before this flush even started must
				// not trigger a deferral here. `cumulativeDeferMs` is this flush's own running total
				// against INTERACTIVE_YIELD_CUMULATIVE_CAP_MS; it is a fresh local for every
				// /v1/chunks/upsert request, so the cap never carries over between flushes.
				const flushStartedAt = now();
				let cumulativeDeferMs = 0;
				try {
				for (let batchIndex = 0; batchIndex < subBatches.length; batchIndex++) {
					const subBatch = subBatches[batchIndex];
					db.exec('BEGIN');
					try {
						for (const chunk of subBatch) {
							const id = requireString(chunk.id, 'chunk.id');
							const vaultId = requireString(chunk.vaultId ?? body.vaultId, 'chunk.vaultId');
							const path = requireString(chunk.path, 'chunk.path');
							const contentHash = requireString(chunk.contentHash, 'chunk.contentHash');
							const title = String(chunk.title ?? path);
							const heading = String(chunk.heading ?? '');
							const text = requireString(chunk.text, 'chunk.text');
							const mtime = Number(chunk.mtime ?? 0);
							const ordinal = Number(chunk.ordinal ?? 0);
							// Never a 400: a malformed entity is dropped, not refused. Unlike a
							// wrong-width vector — which cannot be stored coherently at all and so
							// must fail loudly — a junk `author:` value is user-authored text that
							// should cost the note its facet, not its entire indexing.
							const entities = normalizeChunkEntities(chunk.entities);
							const pathKey = `${vaultId}\n${path}`;
							// The first chunk seen for a (vaultId, path) clears every existing row
							// for that path: an upsert is a full replace, not a merge.
							if (!clearedPaths.has(pathKey)) {
								for (const row of selectRowidsByPath.all(vaultId, path)) deleteFtsByRowid.run(row.rowid);
								deleteByPath.run(vaultId, path);
								clearedPaths.add(pathKey);
							}
							touchedVaults.add(vaultId);

							const embedding = prepareChunkEmbedding(
								chunk.embedding,
								chunk.embeddingModel ?? body.embeddingModel,
								chunk.embeddingSpace ?? body.embeddingSpace,
							);
							if (embedding) {
								if (batchDim === null) batchDim = embedding.dim;
								else if (embedding.dim !== batchDim) {
									throw new HttpError(400, `chunk "${id}" carries a ${embedding.dim}-dimension embedding but this batch established ${batchDim}`);
								}
								if (!checkedVaults.has(vaultId)) {
									// Read *after* this path's rows were cleared, so re-embedding a
									// vault that holds exactly one path is allowed while a genuine
									// mix (other paths still at the old width, or in the old space)
									// is refused.
									const existing = selectVaultEmbeddingDim.get(vaultId);
									const existingDim = existing?.dim === null || existing?.dim === undefined ? null : Number(existing.dim);
									if (existingDim && existingDim !== embedding.dim) {
										throw new HttpError(400, `vault "${vaultId}" is indexed with ${existingDim}-dimension embeddings; refusing a ${embedding.dim}-dimension vector. Reset the index before changing the embedding model.`);
									}
									const existingSpace = optionalId(selectVaultEmbeddingSpace.get(vaultId)?.space);
									if (existingSpace && embedding.space && existingSpace !== embedding.space) {
										throw new HttpError(400, `vault "${vaultId}" is indexed in embedding space "${existingSpace}"; refusing a vector from "${embedding.space}". Two spaces in one index cannot be compared, so reset the index before changing the embedding model or its precision.`);
									}
									checkedVaults.add(vaultId);
								}
							}

							// `.get()`, not `.run()`: the RETURNING clause makes this a row-producing
							// statement, and the chunk's rowid is what pins the chunks_fts row below
							// to the right rowid — see the comment on `upsertChunk`'s declaration.
							const { rowid } = upsertChunk.get(
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
								embedding ? embedding.space : null,
								entities,
							);
							deleteFtsByRowid.run(rowid);
							insertFts.run(rowid, id, vaultId, path, title, heading, text, entities);
						}
						db.exec('COMMIT');
					} catch (e) {
						db.exec('ROLLBACK');
						throw e;
					}
					if (batchIndex < subBatches.length - 1) {
						await yieldEventLoop();
						// WP-4: interactive-priority yield — see INTERACTIVE_YIELD_MS's declaration for
						// the full rationale. `lastInteractiveSearchAt >= flushStartedAt` is what scopes
						// this to a search that landed DURING this flush (the plain `yieldEventLoop()`
						// above is what let it interleave at all); a search from before the flush began
						// must not retrigger a deferral here. Per-search and self-decaying: once
						// `INTERACTIVE_YIELD_MS` has elapsed since the last search with no further one
						// arriving, `remaining` goes non-positive and this becomes a no-op again on its
						// own, with no separate "reset" step needed. Bounded in total by
						// `INTERACTIVE_YIELD_CUMULATIVE_CAP_MS` so continuous searching cannot stall the
						// flush indefinitely.
						if (lastInteractiveSearchAt >= flushStartedAt) {
							const remaining = INTERACTIVE_YIELD_MS - (now() - lastInteractiveSearchAt);
							const budgetLeft = INTERACTIVE_YIELD_CUMULATIVE_CAP_MS - cumulativeDeferMs;
							if (remaining > 0 && budgetLeft > 0) {
								const waitMs = Math.min(remaining, budgetLeft);
								await delay(waitMs);
								cumulativeDeferMs += waitMs;
							}
						}
					}
				}
				} finally {
					// WP-4: once per completed flush, per touched vault — moved off the per-sub-batch
					// schedule above. During an active backfill, invalidating after every ~100-chunk
					// commit meant the ~117MB/28.7k-chunk matrix (and `statsCache`, dropped on the same
					// call) was rebuilt on effectively every search, at a measured ~800ms each; the
					// matrix was never warm for the duration of the backfill. Trade-off, deliberate: a
					// newly-upserted chunk is not vector-searchable until the WHOLE flush finishes, not
					// after its own sub-batch. The `try { ... } finally` (rather than only invalidating
					// after the loop) is what preserves the correctness invariant on a mid-flush throw:
					// `touchedVaults` already holds every vault an EARLIER, successfully-committed
					// sub-batch wrote into by the time a LATER sub-batch fails, and those vaults' cached
					// matrix/stats are genuinely stale regardless of the later failure — they must still
					// be invalidated here rather than left stale because the request as a whole 500s.
					// (A vault that only appears here because it belongs to this request's own
					// rolled-back sub-batch gets an extra, harmless invalidate: `invalidate` never
					// discards real data, it only forces the next read to rebuild from whatever is
					// actually on disk.)
					for (const vault of touchedVaults) vectors.invalidate(vault);
				}
				return json(res, 200, { ok: true, count: chunks.length });
			}
			if (req.method === 'POST' && url.pathname === '/v1/search') {
				const body = await readJson(req);
				const vaultId = requireString(body.vaultId, 'vaultId');
				const query = requireString(body.query, 'query');
				// WP-5: the client's own cooperative-deadline hint (~80% of its own interactive
				// timeout, per src/search/client.ts), clamped server-side so it stays a safety
				// valve rather than something a malformed request can widen or disable. Absent
				// from an older client, which is exactly why clampSearchBudgetMs falls back to
				// SEARCH_DEADLINE_DEFAULT_MS instead of requiring the field.
				const budgetMs = clampSearchBudgetMs(body.budgetMs);
				// WP-3: `body.sentAt` (src/search/client.ts) lets the deadline start counting
				// from the client's own send time instead of only from `receivedAt` — see
				// resolveSearchDeadlineStart for the skew guard. `receivedAt` was captured as the
				// very first statement of this handler, above, so it already reflects the queue
				// wait ahead of `readJson`; `sentAt` reaches further back, past the wait for this
				// handler to start running at all.
				const deadlineAt = resolveSearchDeadlineStart(body.sentAt, receivedAt, budgetMs) + budgetMs;
				const outcome = runSearch(db, {
					vaultId,
					query,
					limit: body.limit,
					statement: searchStatement,
					vectors,
					// Read at last: the client has been sending this field since the search
					// modal shipped and the companion has been dropping it on the floor.
					queryEmbedding: body.queryEmbedding,
					// Which vector space the query embedding was produced in. Absent from an
					// older client, which is why "no space named" still scans a single-space
					// vault rather than refusing.
					embeddingSpace: body.embeddingSpace,
					// Absent means 'current', i.e. every existing client keeps exactly the
					// ranking it has today. A *present but unrecognized* value is a 400 (see
					// parseRankingMode), never a silent degrade to the default.
					rankingMode: parseRankingMode(body.rankingMode),
					hydrate: hydrateChunk,
					coverageStatement,
					deadlineAt,
					// Same injected clock as receivedAt above, so every overBudget() checkpoint
					// inside runSearch reads the same (real, or test-controlled) time source.
					now,
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
				// Only when a caller opted out of the default: a 'current' response stays the
				// exact payload it has always been, key for key.
				if (outcome.rankingMode !== DEFAULT_RANKING_MODE) {
					response.rankingMode = outcome.rankingMode;
					response.coverageUsed = outcome.coverageUsed;
					if (outcome.matchFallback) response.matchFallback = outcome.matchFallback;
				}
				if (outcome.note) response.message = outcome.note;
				// WP-5: additive-only. A request that finished inside budget carries no
				// `degraded` field at all, so it stays byte-identical to the pre-deadline
				// response shape — the client tolerates its absence unconditionally
				// (normalizeSearchResponse), which is what makes this safe against both an old
				// client talking to this companion and this companion answering an old client.
				if (outcome.degraded) response.degraded = true;
				// WP-4: mark this instant (per the injected clock, same as everything else above)
				// as the most recent interactive search served. A concurrently in-flight upsert
				// flush reads this at its next sub-batch boundary to decide whether to open an
				// interactive-priority gap — see INTERACTIVE_YIELD_MS.
				lastInteractiveSearchAt = now();
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

// F5: malformed input is a 4xx, never a 5xx — the request handler's catch-all maps anything
// that is not an HttpError to 500, and the client maps any 5xx to SearchServiceUnavailableError
// ("companion not reachable"), which the caller then defers and retries forever. A too-large or
// unparseable body, or a missing required field, is a client bug, not a companion outage, so
// every rejection below is an explicit HttpError(400) rather than a plain Error.
function readJson(req) {
	return new Promise((resolveBody, reject) => {
		let raw = '';
		req.setEncoding('utf8');
		req.on('data', chunk => {
			raw += chunk;
			if (raw.length > 20_000_000) reject(new HttpError(400, 'request body too large'));
		});
		req.on('end', () => {
			try {
				resolveBody(raw ? JSON.parse(raw) : {});
			} catch (e) {
				reject(new HttpError(400, `invalid JSON body: ${e instanceof Error ? e.message : String(e)}`));
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
	if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `Missing ${name}`);
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
