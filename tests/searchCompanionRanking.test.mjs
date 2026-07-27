// Ranking tests for the zero-dependency search companion.
//
// The companion exports its pure helpers and keeps the server bootstrap behind an
// `isMainModule()` guard, so importing it here neither opens a database nor binds a port.
// Every case below runs against an in-memory SQLite database built with the companion's own
// `createSchema`, so the FTS5 configuration under test is exactly the shipped one — and no
// test ever touches the live companion on 127.0.0.1:4801.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

import {
	SCHEMA_VERSION,
	buildFtsQuery,
	createSchema,
	createVectorBackend,
	fuseSearchRows,
	migrateChunksPrimaryKey,
	migrateFtsRowidPinning,
	migrateFtsSchema,
	runSearch,
	titleMatchScore,
	tokenizeQuery,
} from '../scripts/search-companion.mjs';

const VAULT = 'test-vault';

// Every search below runs through the vector-aware path with a real backend attached, over
// vaults that hold no embeddings — so this whole file doubles as the "vector absence
// degrades, never fails" guarantee: the rankings asserted here are the pre-vector rankings.
const backends = new WeakMap();
function vectorsFor(db) {
	let backend = backends.get(db);
	if (!backend) {
		backend = createVectorBackend(db);
		backends.set(db, backend);
	}
	return backend;
}

function makeDb(rows) {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	// No embedding: these rows exercise the FTS-only path, which is still what a vault gets
	// until semantic indexing is deliberately turned on. Vector coverage lives in
	// tests/searchCompanionVector.test.mjs.
	const insertChunk = db.prepare(`
INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`);
	const insertFts = db.prepare('INSERT INTO chunks_fts (id, vault_id, path, title, heading, text) VALUES (?, ?, ?, ?, ?, ?)');
	rows.forEach((row, index) => {
		const id = row.id ?? `chunk-${index}`;
		const title = row.title ?? row.path;
		const heading = row.heading ?? '';
		insertChunk.run(id, VAULT, row.path, 'hash', title, heading, row.text, 0, index, JSON.stringify(row.metadata ?? {}));
		insertFts.run(id, VAULT, row.path, title, heading, row.text);
	});
	return db;
}

function search(db, query, limit = 10) {
	return runSearch(db, { vaultId: VAULT, query, limit, vectors: vectorsFor(db) });
}

test('title match outranks a body match for the same term', () => {
	const db = makeDb([
		{ path: 'Notes/Widget Handbook.md', title: 'Widget Handbook', text: 'A guide to assembling things in general.' },
		{ path: 'Notes/Daily.md', title: 'Daily log', text: 'the widget came up again, widget widget widget everywhere' },
	]);
	const outcome = search(db, 'widget');
	assert.equal(outcome.results.length, 2);
	assert.equal(outcome.results[0].path, 'Notes/Widget Handbook.md');
	assert.ok(outcome.results[0].score > outcome.results[1].score);
	// ...and the boost is attributable, not a mystery.
	assert.ok(outcome.results[0].attribution.titleBoost > 0);
	assert.equal(outcome.results[1].attribution.titleBoost, 0);
	assert.equal(outcome.results[1].attribution.titleRank, null);
});

test('two-term queries use AND with a trailing prefix, not the old pure OR', () => {
	const built = buildFtsQuery('crucible search');
	assert.equal(built.primary, '("crucible search") OR ("crucible" AND "search"*)');
	assert.equal(built.fallback, '("crucible" OR "search"*)');
	// The old form was a pure OR of unique terms; the AND clause is what stops a single
	// common term dragging in the whole vault.
	assert.notEqual(built.primary, '"crucible" OR "search"');
	assert.ok(built.primary.includes(' AND '));

	const db = makeDb([
		{ path: 'Both.md', title: 'Both', text: 'crucible and search live together here' },
		{ path: 'OnlyOne.md', title: 'Only one', text: 'crucible appears alone in this note' },
	]);
	const outcome = search(db, 'crucible search');
	assert.equal(outcome.fallbackUsed, false);
	assert.deepEqual(outcome.results.map(row => row.path), ['Both.md']);
});

test('prefix expansion matches a partial word', () => {
	const db = makeDb([
		{ path: 'Infra.md', title: 'Infra', text: 'kubernetes deployment strategy' },
	]);
	const built = buildFtsQuery('kubern');
	assert.equal(built.primary, '("kubern") OR ("kubern"*)');
	const outcome = search(db, 'kubern');
	assert.deepEqual(outcome.results.map(row => row.path), ['Infra.md']);
});

test('non-ASCII terms survive tokenization', () => {
	assert.deepEqual(tokenizeQuery('crème brûlée'), ['crème', 'brûlée']);
	assert.deepEqual(tokenizeQuery('日本語 テスト'), ['日本語', 'テスト']);
	const db = makeDb([
		{ path: 'Cafe.md', title: 'Café notes', text: 'crème brûlée, résumé, 日本語 テスト' },
		{ path: 'Other.md', title: 'Other', text: 'nothing relevant here' },
	]);
	assert.deepEqual(search(db, 'brûlée').results.map(row => row.path), ['Cafe.md']);
	assert.deepEqual(search(db, '日本語').results.map(row => row.path), ['Cafe.md']);
});

test('pooling returns exactly one row per path, scored on its best chunk', () => {
	const db = makeDb([
		{ id: 'a', path: 'Pool.md', title: 'Pool', heading: 'First', text: 'pooling mentioned once' },
		{ id: 'b', path: 'Pool.md', title: 'Pool', heading: 'Second', text: 'pooling pooling pooling pooling pooling' },
		{ id: 'c', path: 'Pool.md', title: 'Pool', heading: 'Third', text: 'pooling mentioned once again' },
		{ id: 'd', path: 'Other.md', title: 'Other', heading: 'Only', text: 'pooling elsewhere' },
	]);
	const outcome = search(db, 'pooling');
	assert.deepEqual(outcome.results.map(row => row.path).sort(), ['Other.md', 'Pool.md']);
	assert.equal(outcome.total, 2);
	const pool = outcome.results.find(row => row.path === 'Pool.md');
	assert.equal(pool.attribution.pooledChunks, 3);
	// The winning chunk's own snippet/heading/id ride along with the pooled score.
	assert.equal(pool.heading, 'Second');
	assert.equal(pool.chunkId, 'b');
});

test('total counts every matching path, not just the returned page', () => {
	const rows = [];
	for (let i = 0; i < 25; i++) rows.push({ path: `Note-${i}.md`, title: `Note ${i}`, text: 'shared needle term' });
	const outcome = search(makeDb(rows), 'needle', 5);
	assert.equal(outcome.results.length, 5);
	assert.equal(outcome.total, 25);
});

test('the OR fallback fires when the AND form yields nothing', () => {
	const db = makeDb([
		{ path: 'Alpha.md', title: 'Alpha', text: 'alpha stands alone' },
		{ path: 'Beta.md', title: 'Beta', text: 'beta stands alone' },
	]);
	const outcome = search(db, 'alpha beta');
	assert.equal(outcome.fallbackUsed, true);
	assert.equal(outcome.match, '("alpha" OR "beta"*)');
	assert.equal(outcome.results.length, 2);
	// A query that matches nothing is worse than a loose one.
	assert.equal(outcome.total, 2);
});

test('an unmatchable query returns no rows instead of an FTS5 syntax error', () => {
	const db = makeDb([{ path: 'Alpha.md', title: 'Alpha', text: 'alpha stands alone' }]);
	const outcome = search(db, '!!!');
	assert.equal(outcome.results.length, 0);
	assert.equal(outcome.total, 0);
});

test('quotes in a query are escaped rather than breaking the FTS expression', () => {
	const db = makeDb([{ path: 'Q.md', title: 'Q', text: 'say hello now' }]);
	// Quotes are not term characters, so a quoted query still tokenizes to its words.
	assert.deepEqual(buildFtsQuery('say "hello" now').terms, ['say', 'hello', 'now']);
	assert.equal(search(db, 'say "hello" now').results.length, 1);
	// A query that tokenizes to nothing falls back to a quoted literal; the `""` escaping is
	// what keeps that literal from becoming an FTS5 syntax error (which surfaces as a 500).
	assert.equal(buildFtsQuery('"').primary, '""""');
	assert.equal(search(db, '"').results.length, 0);
});

test('the term cap survives', () => {
	const query = Array.from({ length: 40 }, (_, i) => `term${i}`).join(' ');
	assert.equal(tokenizeQuery(query).length, 24);
	assert.equal(buildFtsQuery(query).terms.length, 24);
});

test('score sign convention: every score is higher-is-better, and order follows it', () => {
	const db = makeDb([
		{ path: 'Needle.md', title: 'Needle', text: 'needle in the title and body' },
		{ path: 'Haystack.md', title: 'Haystack', text: 'one needle buried in a lot of unrelated words here' },
	]);
	const outcome = search(db, 'needle');
	for (const row of outcome.results) {
		assert.ok(row.score > 0, 'score must be positive/higher-is-better');
		assert.ok(row.scoreText > 0, 'scoreText must be the negated bm25 (higher-is-better)');
		assert.equal(row.scoreRrf, row.score);
		assert.equal(row.attribution.base, row.scoreText);
		assert.equal(row.attribution.rrf, row.score);
	}
	const scores = outcome.results.map(row => row.score);
	assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'results must arrive sorted by descending score');
});

test('RRF fusion promotes a title hit sitting below the bm25 leader', () => {
	const rows = [
		{ id: 'a', path: 'Body.md', title: 'Unrelated body note', score_text: -9, pooled_chunks: 1 },
		{ id: 'b', path: 'Other.md', title: 'Also unrelated', score_text: -8, pooled_chunks: 1 },
		{ id: 'c', path: 'Widget.md', title: 'Widget', score_text: -1, pooled_chunks: 1 },
	];
	const fused = fuseSearchRows(rows, { terms: ['widget'], limit: 3 });
	assert.equal(fused[0].path, 'Widget.md');
	assert.equal(fused[0].attribution.textRank, 3);
	assert.equal(fused[0].attribution.titleRank, 1);
	// Fusion never inverts the sign: bm25 is negated once, on the way out.
	assert.equal(fused[0].scoreText, 1);
	assert.ok(fused.every(row => row.score > 0));
});

test('titleMatchScore ranks exact over prefix over substring over partial', () => {
	const exact = titleMatchScore(['widget'], { title: 'Widget', path: 'a/Widget.md' });
	const prefix = titleMatchScore(['widget'], { title: 'Widget handbook', path: 'a/Widget handbook.md' });
	const substring = titleMatchScore(['widget'], { title: 'The widget handbook', path: 'a/x.md' });
	const partial = titleMatchScore(['widget', 'handbook'], { title: 'Widget', path: 'a/Widget.md' });
	const none = titleMatchScore(['widget'], { title: 'Unrelated', path: 'a/b.md' });
	assert.ok(exact > prefix && prefix > substring && substring > partial && partial > none);
	assert.equal(none, 0);
	// Path-shaped tokens normalize the same way on both sides.
	assert.equal(titleMatchScore(['widget.md'], { title: 'Widget md', path: 'a/Widget.md' }), 1);
});

test('a schema-1 index migrates to the prefix FTS table, the embedding columns, and the composite key', () => {
	const db = new DatabaseSync(':memory:');
	// The schema-1 bootstrap, verbatim: no prefix= option, and embeddings still in a JSON
	// TEXT column.
	db.exec(`
CREATE TABLE chunks (
  id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, path TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, heading TEXT NOT NULL,
  text TEXT NOT NULL, mtime INTEGER NOT NULL, ordinal INTEGER NOT NULL,
  metadata_json TEXT NOT NULL, embedding_json TEXT
);
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  id UNINDEXED, vault_id UNINDEXED, path UNINDEXED, title, heading, text
);
INSERT INTO chunks VALUES ('legacy', '${VAULT}', 'Legacy.md', 'hash', 'Legacy', '', 'kubernetes deployment', 0, 0, '{}', NULL);
INSERT INTO chunks_fts VALUES ('legacy', '${VAULT}', 'Legacy.md', 'Legacy', '', 'kubernetes deployment');
`);
	// createSchema does both halves of the migration: additive ALTERs for the schema-3
	// embedding columns (the content_hash precedent — never a drop/refill of `chunks`), then
	// the FTS rebuild. It reports whether the FTS half actually ran.
	assert.equal(createSchema(db), true);
	// Idempotent: a second pass is a no-op.
	assert.equal(migrateFtsSchema(db), false);
	const columns = db.prepare('PRAGMA table_info(chunks)').all().map(row => row.name);
	for (const column of ['embedding', 'embedding_dim', 'embedding_model']) {
		assert.ok(columns.includes(column), `schema 3 must add ${column} to an existing index`);
	}
	// The legacy TEXT column is left behind untouched — every row in a real index has it
	// NULL, and dropping it would mean rebuilding the table for nothing.
	assert.ok(columns.includes('embedding_json'));
	const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_fts'").get().sql;
	assert.match(sql, /prefix\s*=/);
	// Schema 5: `chunks` is rebuilt with the composite key. The fixture above deliberately keeps
	// the schema-1 `id TEXT PRIMARY KEY` — it is the migration's *input*, not a stale copy of the
	// current shape — so this asserts the rebuild reached it, and the legacy `embedding_json`
	// column asserted above proves the rebuild carried unknown columns across rather than
	// dropping them.
	const chunksSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks'").get().sql;
	assert.match(chunksSql, /PRIMARY KEY \(vault_id, id\)/);
	assert.doesNotMatch(chunksSql, /id TEXT PRIMARY KEY/);
	// No temporary table left behind, and the row survived the rebuild.
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'chunks_migrated'").get().n, 0);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n, 1);
	// Content is rebuilt losslessly from `chunks`, and prefix queries now work.
	const outcome = search(db, 'kubern');
	assert.deepEqual(outcome.results.map(row => row.path), ['Legacy.md']);
	// Schema 6: a schema-1 database migrates through the whole chain (PK rebuild, then FTS
	// prefix rebuild) in one `createSchema` call, and both of those rebuilds share
	// FTS_REFILL_SQL — so `chunks_fts.rowid` is already pinned to `chunks.rowid` by the time
	// `createSchema` returns, with no separate rowid-pinning rebuild left to run.
	const chunkRow = db.prepare('SELECT rowid FROM chunks WHERE id = ?').get('legacy');
	const ftsRow = db.prepare('SELECT rowid FROM chunks_fts WHERE id = ?').get('legacy');
	assert.equal(ftsRow.rowid, chunkRow.rowid);
	assert.equal(migrateFtsRowidPinning(db, { alreadyRebuilt: true }), false, 'user_version was already written by createSchema, so a second pass must be a no-op');
	assert.equal(SCHEMA_VERSION, 6);
});

test('a schema-5 index (composite key + FTS prefix already present) still gets the rowid-pinning rebuild', () => {
	// Simulates a real pre-6 database: `chunks` already has the composite PK, `chunks_fts`
	// already has `prefix=`, so neither migrateChunksPrimaryKey nor migrateFtsSchema's
	// structural triggers fire — the gap this test guards is exactly the one those two
	// migrations cannot see, because FTS5 leaves no schema-text trace of rowid pinning.
	const db = new DatabaseSync(':memory:');
	db.exec(`
CREATE TABLE chunks (
  id TEXT NOT NULL, vault_id TEXT NOT NULL, path TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, heading TEXT NOT NULL,
  text TEXT NOT NULL, mtime INTEGER NOT NULL, ordinal INTEGER NOT NULL,
  metadata_json TEXT NOT NULL, embedding BLOB, embedding_dim INTEGER, embedding_model TEXT,
  embedding_space TEXT,
  PRIMARY KEY (vault_id, id)
);
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  id UNINDEXED, vault_id UNINDEXED, path UNINDEXED, title, heading, text, prefix='2 3'
);
-- An extra, permanent row before 'a', not deleted, so 'a' lands at chunks.rowid 2 while its
-- chunks_fts counterpart (inserted alone, below) auto-assigns rowid 1 — a genuine mismatch to
-- migrate, not a coincidental match because each table happens to hold exactly one row.
-- (A delete-then-reinsert does NOT produce this: SQLite reassigns rowid 1 to the next insert
-- once a rowid table is emptied, which is not the scenario a live, populated index is in.)
INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json)
  VALUES ('sibling', '${VAULT}', 'Sibling.md', 'hash', 'Sibling', '', 'unrelated content', 0, 0, '{}');
INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json)
  VALUES ('a', '${VAULT}', 'A.md', 'hash', 'A', '', 'kubernetes deployment', 0, 0, '{}');
INSERT INTO chunks_fts (id, vault_id, path, title, heading, text)
  VALUES ('a', '${VAULT}', 'A.md', 'A', '', 'kubernetes deployment');
`);
	const beforeChunkRow = db.prepare('SELECT rowid FROM chunks WHERE id = ?').get('a');
	const beforeFtsRow = db.prepare('SELECT rowid FROM chunks_fts WHERE id = ?').get('a');
	assert.equal(beforeChunkRow.rowid, 2);
	assert.notEqual(beforeFtsRow.rowid, beforeChunkRow.rowid, 'fixture must start genuinely unpinned');
	assert.equal(migrateChunksPrimaryKey(db), false, 'PK already composite; must not re-trigger');
	assert.equal(migrateFtsSchema(db), false, 'prefix already present; must not re-trigger');
	assert.equal(createSchema(db), true, 'the rowid-pinning migration must still run');
	assert.equal(createSchema(db), false, 'and must be a no-op on the next startup');
	const chunkRow = db.prepare('SELECT rowid FROM chunks WHERE id = ?').get('a');
	const ftsRow = db.prepare('SELECT rowid FROM chunks_fts WHERE id = ?').get('a');
	assert.equal(ftsRow.rowid, chunkRow.rowid);
	// Searchability survived the rebuild.
	const outcome = search(db, 'kubern');
	assert.deepEqual(outcome.results.map(row => row.path), ['A.md']);
});

// End-to-end sign check: a companion payload run through the real client normalizer must
// still be higher-is-better on the other side, with attribution intact.
const outdir = path.join(tmpdir(), 'obsidian-crucible-companion-ranking-tests');
const outfile = path.join(outdir, 'client.mjs');
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/client.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: `
					export async function requestUrl() {
						return globalThis.__companionResponse;
					}
				`,
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});
const { SearchServiceClient, SEARCH_REQUIRED_SCHEMA_VERSION } = await import(pathToFileURL(outfile));

test('the client sees the companion score convention unchanged (higher is better)', async () => {
	const db = makeDb([
		{ path: 'Needle.md', title: 'Needle', text: 'needle in the title and body' },
		{ path: 'Haystack.md', title: 'Haystack', text: 'one needle buried in a lot of unrelated words' },
	]);
	const outcome = search(db, 'needle');
	// Both flags are taken from the outcome, never written as literals: a vault with no
	// embeddings must *compute* its way to fts/false, and the day it stops doing that this
	// assertion is what notices.
	assert.equal(outcome.vectorUsed, false);
	assert.equal(outcome.semanticAvailable, false);
	globalThis.__companionResponse = {
		status: 200,
		json: {
			mode: outcome.vectorUsed ? 'hybrid' : 'fts',
			semanticAvailable: outcome.semanticAvailable,
			schemaVersion: SCHEMA_VERSION,
			total: outcome.total,
			hasMore: false,
			results: outcome.results,
		},
	};
	const response = await new SearchServiceClient('http://127.0.0.1:1', VAULT).search({ query: 'needle', limit: 10 });
	assert.equal(response.rebuildRequired, undefined);
	assert.deepEqual(response.results.map(row => row.path), outcome.results.map(row => row.path));
	assert.equal(response.results[0].score, outcome.results[0].score);
	assert.ok(response.results[0].score > response.results[1].score);
	assert.ok(response.results[0].scoreText > 0);
	assert.equal(response.results[0].scoreRrf, response.results[0].score);
	assert.equal(response.results[0].attribution.base, outcome.results[0].scoreText);
	assert.equal(response.results[0].attribution.textRank, 1);
});

test('a companion on the old schema surfaces "rebuild required" instead of serving silently', async () => {
	const client = new SearchServiceClient('http://127.0.0.1:1', VAULT);
	globalThis.__companionResponse = {
		status: 200,
		json: { mode: 'fts', schemaVersion: SEARCH_REQUIRED_SCHEMA_VERSION - 1, results: [] },
	};
	const response = await client.search({ query: 'needle', limit: 10 });
	assert.equal(response.rebuildRequired, true);
	assert.match(response.message, /rebuild required/i);

	globalThis.__companionResponse = {
		status: 200,
		json: { ok: true, version: 'legacy', schemaVersion: SEARCH_REQUIRED_SCHEMA_VERSION - 1 },
	};
	const health = await client.health();
	assert.equal(health.ok, false, 'an unqueryable index must not read as an available companion');
	assert.equal(health.rebuildRequired, true);

	globalThis.__companionResponse = {
		status: 200,
		json: { ok: true, version: 'dev', schemaVersion: SEARCH_REQUIRED_SCHEMA_VERSION },
	};
	const current = await client.health();
	assert.equal(current.ok, true);
	assert.equal(current.rebuildRequired, undefined);

	// An absent schemaVersion is "can't tell", not evidence of a stale index.
	globalThis.__companionResponse = { status: 200, json: { ok: true, version: 'dev' } };
	const unknown = await client.health();
	assert.equal(unknown.ok, true);
	assert.equal(unknown.rebuildRequired, undefined);
});
