import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Schema creation, the four self-detecting migrations, and the database opener — everything
// that decides what shape the SQLite file is in before a single request is served. Split out
// of the single-file companion (WP-rem-R3); the migration bodies are carried across verbatim.
//
// SCHEMA_VERSION lives here because this is the module that acts on it. Its client-side twin,
// SEARCH_REQUIRED_SCHEMA_VERSION in `src/search/types.ts`, is bumped in the same commit —
// always. See `src/search/AGENTS.md`.

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

export function openDatabase(dbPath) {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	createSchema(db);
	return db;
}
