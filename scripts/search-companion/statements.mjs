import { COVERAGE_SQL, HYDRATE_CHUNK_SQL, SEARCH_SQL } from './search.mjs';

// Every prepared statement the request handler owns, compiled once per handler instance.
// Split out of the single-file companion (WP-rem-R3) so the endpoint modules can be handed
// exactly the statements they use instead of closing over a 90-line prepare block.
//
// Preparing here rather than per request is deliberate and unchanged: compiling is cheap and
// once, whereas preparing inside a handler would put a compile on the hot path.
//
// Every statement below is keyed by `(vault_id, id)` or `(vault_id, path)`, never by `id`
// alone. A chunk id is only unique *within* a vault, so an id-only statement is a data-loss
// (or cross-vault content-leak) bug, not a style nit — see `src/search/AGENTS.md`.
export function createStatements(db) {
	// `ON CONFLICT(vault_id, id)` is the load-bearing half: under the old `ON CONFLICT(id)` an
	// upsert from vault B silently re-labelled vault A's row as B's, which is how one vault's
	// index destroyed another's. `vault_id` is no longer in the SET list because it is now part
	// of the conflict key and can only ever equal `excluded.vault_id`.
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
	// comment in `./schema.mjs`). `chunks_fts.rowid` is pinned to the owning
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
	// WP-SA1: every indexed path for a vault, one row each, in one aggregate query — the
	// `/v1/paths` endpoint's whole job, so no application-code loop over paths exists here.
	// Same "dominant content-hash group" precedent as `selectStateByPath` above (a path
	// mid-rewrite can transiently hold rows under two content hashes), generalized to every
	// path in the vault at once via a window function: `grouped` aggregates per
	// (path, content_hash) exactly like selectStateByPath's WHERE-one-path version, then
	// ROW_NUMBER()-ranks each path's groups by chunk_count so `rn = 1` keeps only the
	// majority-hash group per path — never a naive last-write-wins pick.
	const selectPathsByVault = db.prepare(`
WITH grouped AS (
  SELECT
    path,
    content_hash,
    MAX(mtime) AS mtime,
    COUNT(*) AS chunk_count,
    SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded_count,
    ROW_NUMBER() OVER (PARTITION BY path ORDER BY COUNT(*) DESC) AS rn
  FROM chunks
  WHERE vault_id = ?
  GROUP BY path, content_hash
)
SELECT path, content_hash, mtime, chunk_count, embedded_count
FROM grouped
WHERE rn = 1
ORDER BY path
`);

	return {
		upsertChunk,
		selectVaultEmbeddingDim,
		selectVaultEmbeddingSpace,
		hydrateChunk,
		deleteFtsByRowid,
		insertFts,
		deleteByPath,
		selectRowidsByPath,
		selectRowidsByVault,
		selectStateByPath,
		resetChunks,
		searchStatement,
		coverageStatement,
		selectPathsByVault,
	};
}
