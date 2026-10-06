// search-latency-durability WP-1: the two-phase lean pooled search must be row-for-row identical
// to the single-statement SEARCH_SQL it replaced, and the startup backfill must run once.
//
// ORACLE_SEARCH_SQL below is the pre-WP-1 production statement, kept here (and only here) as the
// equivalence oracle. Every column of every pooled row is compared — not just path order —
// on a fixture with several chunks per path and tied minimum scores inside one path whose
// headings and snippets differ (audit finding 5).
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
	EMBEDDING_SPACE_BACKFILL_MARKER,
	SEARCH_HYDRATE_SQL,
	SEARCH_POOL_SQL,
	buildFtsQuery,
	createSchema,
	runPooledSearch,
	runSearch,
} from '../scripts/search-companion.mjs';

const VAULT = 'lean-vault';

const ORACLE_SEARCH_SQL = `
WITH matched AS MATERIALIZED (
  SELECT c.id AS id,
         c.path AS path,
         c.title AS title,
         c.heading AS heading,
         c.entities AS entities,
         c.metadata_json AS metadata_json,
         snippet(chunks_fts, 5, '', '', '...', 18) AS snippet,
         bm25(chunks_fts, 0.0, 0.0, 0.0, 10.0, 5.0, 1.0, 8.0) AS score_text
  FROM chunks_fts
  JOIN chunks c ON c.id = chunks_fts.id AND c.vault_id = chunks_fts.vault_id
  WHERE chunks_fts.vault_id = ? AND chunks_fts MATCH ?
),
pooled AS (
  SELECT path, id, title, heading, entities, metadata_json, snippet,
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

// Several chunks per path; inside `notes/tied.md` three chunks carry identical term statistics
// (same tokens, same lengths, one-token headings) so their bm25 ties exactly, while word order
// makes their snippets differ and their headings differ.
const ROWS = [
	{ path: 'notes/tied.md', heading: 'alpha', text: 'craft software mourning river stone lamp' },
	{ path: 'notes/tied.md', heading: 'bravo', text: 'lamp stone river mourning software craft' },
	{ path: 'notes/tied.md', heading: 'charlie', text: 'river craft lamp software stone mourning' },
	{ path: 'notes/tied.md', heading: 'delta', text: 'unrelated filler words only here today' },
	{ path: 'notes/multi.md', heading: 'one', text: 'software development is a craft of mourning and building' },
	{ path: 'notes/multi.md', heading: 'two', text: 'software again with craft again and craft once more' },
	{ path: 'notes/multi.md', heading: 'three', text: 'development only nothing else matches here' },
	{ path: 'notes/craft.md', title: 'Craft', heading: 'intro', text: 'the craft of software, the romantic ideal', entities: 'Ada Craft' },
	{ path: 'notes/craft.md', title: 'Craft', heading: 'body', text: 'building and understanding software', entities: 'Ada Craft' },
	{ path: 'notes/single.md', heading: 'x', text: 'mourning alone' },
	{ path: 'notes/other.md', heading: 'y', text: 'romantic river of stones' },
];

function makeDb(rows = ROWS) {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	const insertChunk = db.prepare(`
INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, entities)
VALUES (?, ?, ?, 'hash', ?, ?, ?, 0, ?, ?, ?) RETURNING rowid`);
	const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, id, vault_id, path, title, heading, text, entities) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
	rows.forEach((row, index) => {
		const id = `${row.path}#${index}`;
		const title = row.title ?? 'Same';
		const entities = row.entities ?? '';
		const { rowid } = insertChunk.get(id, VAULT, row.path, title, row.heading, row.text, index, JSON.stringify({ i: index }), entities);
		insertFts.run(rowid, id, VAULT, row.path, title, row.heading, row.text, entities);
	});
	return db;
}

function leanStatements(db) {
	return { pool: db.prepare(SEARCH_POOL_SQL), hydrate: db.prepare(SEARCH_HYDRATE_SQL) };
}

const QUERIES = ['mourning the craft of software development', 'craft software', 'river stone lamp', 'software', 'the', 'romantic ideal craft building', 'nothingmatchesthis'];

test('lean pooled search returns complete rows identical to the oracle, primary and fallback', () => {
	const db = makeDb();
	const oracle = db.prepare(ORACLE_SEARCH_SQL);
	const lean = leanStatements(db);
	let compared = 0;
	for (const query of QUERIES) {
		const built = buildFtsQuery(query);
		for (const expression of new Set([built.primary, built.fallback])) {
			for (const poolSize of [1, 2, 40]) {
				const expected = oracle.all(VAULT, expression, poolSize);
				const actual = runPooledSearch(lean, VAULT, expression, poolSize);
				assert.deepEqual(actual.map(row => ({ ...row })), expected.map(row => ({ ...row })), `${query} / ${expression} / ${poolSize}`);
				compared += expected.length;
			}
		}
	}
	assert.ok(compared > 20, 'the fixture must actually exercise matches');
});

test('the tied-minimum path picks the same representative chunk, heading and snippet as the oracle', () => {
	const db = makeDb();
	const scores = db.prepare("SELECT heading, bm25(chunks_fts, 0.0, 0.0, 0.0, 10.0, 5.0, 1.0, 8.0) AS s FROM chunks_fts WHERE vault_id = ? AND chunks_fts MATCH ? AND path = 'notes/tied.md'").all(VAULT, '"river"');
	const tied = scores.filter(row => row.s === scores[0].s);
	assert.ok(tied.length >= 3, 'fixture precondition: three chunks of one path tie on the minimum score');
	for (const expression of ['"river"', '"river" AND "lamp"', '"stone" OR "mourning"']) {
		const expected = db.prepare(ORACLE_SEARCH_SQL).all(VAULT, expression, 40).find(row => row.path === 'notes/tied.md');
		const actual = runPooledSearch(leanStatements(db), VAULT, expression, 40).find(row => row.path === 'notes/tied.md');
		assert.ok(expected);
		assert.deepEqual({ ...actual }, { ...expected });
		assert.equal(actual.pooled_chunks, 3);
	}
});

test('runSearch over the default prepared path still returns the oracle-ranked results (zero-hit rescue included)', () => {
	const db = makeDb();
	const outcome = runSearch(db, { vaultId: VAULT, query: 'mourning zzzunmatched', limit: 5 });
	assert.equal(outcome.fallbackUsed, true);
	const expected = db.prepare(ORACLE_SEARCH_SQL).all(VAULT, buildFtsQuery('mourning zzzunmatched').fallback, 40);
	assert.deepEqual(outcome.results.map(row => row.path).sort(), expected.slice(0, 5).map(row => row.path).sort());
});

test('the embedding-space backfill runs once per database file, then is skipped', () => {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	assert.ok(db.prepare('SELECT 1 FROM companion_meta WHERE key = ?').get(EMBEDDING_SPACE_BACKFILL_MARKER), 'a fresh database records the marker');
	// A pre-marker database: a legacy unattributed vector row and no marker yet.
	db.exec('DELETE FROM companion_meta');
	db.prepare("INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model) VALUES ('a', ?, 'a.md', 'h', 't', 'h', 'x', 0, 0, '{}', X'00000000', 1, 'model-a')").run(VAULT);
	createSchema(db);
	assert.equal(db.prepare("SELECT embedding_space FROM chunks WHERE id = 'a'").get().embedding_space, 'model-a');
	// With the marker present, a NULL-space row is NOT rescanned on the next boot.
	db.exec("UPDATE chunks SET embedding_space = NULL WHERE id = 'a'");
	createSchema(db);
	assert.equal(db.prepare("SELECT embedding_space FROM chunks WHERE id = 'a'").get().embedding_space, null);
});
