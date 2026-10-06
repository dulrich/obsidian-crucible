// search-latency-tail WP-2: the coverage leg scans FTS rowids only and resolves them through an
// in-memory rowid map. Output must be identical to the COVERAGE_SQL form it replaces, the map
// must agree with `chunks` after every committed write (each upsert sub-batch individually —
// plan audit item 4), and a not-ready map must fall back to COVERAGE_SQL, never to "no coverage".
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
	COVERAGE_SQL,
	createCoverageMap,
	createRequestHandler,
	createSchema,
	createStatements,
	runSearch,
} from '../scripts/search-companion.mjs';

const VAULT_A = 'vault-a';
const VAULT_B = 'vault-b';

// Two vaults sharing paths AND chunk ids (ids are unique only within a vault), several chunks
// per path, terms scattered across a path's chunks so coverage differs from per-chunk AND.
const ROWS = [];
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo'];
for (const vault of [VAULT_A, VAULT_B]) {
	for (let p = 0; p < 12; p++) {
		for (let c = 0; c < 4; c++) {
			const pick = WORDS.filter((_, w) => (w * 7 + p * 3 + c * 5 + (vault === VAULT_B ? 1 : 0)) % 4 === 0);
			ROWS.push({ vault, path: `notes/p${p}.md`, id: `notes/p${p}.md#${c}`, heading: `h${c}`, text: `${pick.join(' ')} filler${c} body` });
		}
	}
}

function makeDb(rows = ROWS) {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	const insertChunk = db.prepare(`
INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, entities)
VALUES (?, ?, ?, 'hash', 'T', ?, ?, 0, 0, '{}', '') RETURNING rowid`);
	const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, id, vault_id, path, title, heading, text, entities) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
	for (const row of rows) {
		const { rowid } = insertChunk.get(row.id, row.vault, row.path, row.heading, row.text);
		insertFts.run(rowid, row.id, row.vault, row.path, 'T', row.heading, row.text, '');
	}
	return db;
}

const QUERIES = ['alpha bravo', 'alpha bravo charlie', 'delta echo f', 'alpha bravo charlie delta echo foxtrot golf hotel india juliet', 'kilo juliet hotel b', 'zzz alpha'];

function stripTimings(outcome) {
	const { timings, ...rest } = outcome;
	assert.ok(timings);
	return rest;
}

async function search(db, vaultId, query, extra = {}) {
	return stripTimings(await runSearch(db, { vaultId, query, limit: 50, rankingMode: 'coverage', ...extra }));
}

function assertMapMatchesChunks(db, map) {
	const rows = map.lookup();
	assert.ok(rows, 'map must be ready');
	const expected = new Map(db.prepare('SELECT rowid AS r, id, vault_id, path FROM chunks').all().map(r => [r.r, { id: r.id, vaultId: r.vault_id, path: r.path }]));
	assert.deepEqual(new Map([...rows].map(([k, v]) => [k, { ...v }])), expected);
}

test('rowid-map coverage output is identical to the COVERAGE_SQL form, per vault, across query shapes', async () => {
	const db = makeDb();
	const coverageMap = createCoverageMap(db);
	let used = 0;
	for (const vaultId of [VAULT_A, VAULT_B]) {
		for (const query of QUERIES) {
			const oracle = await search(db, vaultId, query, { coverageStatement: db.prepare(COVERAGE_SQL) });
			const lean = await search(db, vaultId, query, { coverageMap });
			assert.deepEqual(lean, oracle, `${vaultId} / ${query}`);
			if (lean.coverageUsed) used++;
		}
	}
	assert.ok(used >= 6, 'the fixture must actually exercise the coverage leg');
	assert.equal(coverageMap.status().ready, true);
});

test('the map never leaks another vault\'s chunk: results only carry the requested vault\'s rows', async () => {
	const db = makeDb(ROWS.filter(row => row.vault === VAULT_B || row.path === 'notes/p0.md'));
	const coverageMap = createCoverageMap(db);
	const a = await search(db, VAULT_A, 'alpha bravo charlie delta echo', { coverageMap });
	assert.ok(a.results.every(row => row.path === 'notes/p0.md'));
	assert.deepEqual(a, await search(db, VAULT_A, 'alpha bravo charlie delta echo'));
});

test('a not-ready map falls back to COVERAGE_SQL (never "no coverage") and builds off the request path above the inline limit', async () => {
	const db = makeDb();
	const scheduled = [];
	const coverageMap = createCoverageMap(db, { inlineRowLimit: 10, sliceRows: 30, schedule: fn => scheduled.push(fn) });
	const query = 'alpha bravo charlie delta';
	const oracle = await search(db, VAULT_A, query);
	assert.equal(oracle.coverageUsed, true);
	assert.deepEqual(await search(db, VAULT_A, query, { coverageMap }), oracle);
	assert.equal(coverageMap.status().ready, false);
	assert.equal(scheduled.length, 1, 'the build is scheduled, not run inline');
	// A journal committed mid-build lands in the partial map too.
	const journal = coverageMap.begin();
	journal.delete(1);
	while (scheduled.length > 0) {
		scheduled.shift()();
		if (scheduled.length === 1 && coverageMap.status().size === 30) {
			// A writer commits a delete of an already-scanned rowid while the build is mid-way.
			db.prepare('DELETE FROM chunks_fts WHERE rowid = 1').run();
			db.prepare('DELETE FROM chunks WHERE rowid = 1').run();
			coverageMap.commit(journal);
		}
	}
	assert.equal(coverageMap.status().ready, true);
	assertMapMatchesChunks(db, coverageMap);
	coverageMap.invalidate();
	assert.equal(coverageMap.status().ready, false);
});

async function withHandler(db, options, fn) {
	const server = createServer(createRequestHandler(db, options));
	await new Promise(listening => server.listen(0, '127.0.0.1', listening));
	const base = `http://127.0.0.1:${server.address().port}`;
	const post = async (route, body) => {
		const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		return { status: response.status, json: await response.json() };
	};
	try {
		return await fn(post);
	} finally {
		await new Promise(closed => server.close(closed));
	}
}

const chunk = (path, i, text) => ({ id: `${path}#${i}`, path, contentHash: 'h', text, heading: `h${i}` });

test('the map tracks upsert, chunk delete and reset through the HTTP endpoints', async () => {
	const db = makeDb([]);
	const statements = createStatements(db);
	await withHandler(db, { statements }, async post => {
		assertMapMatchesChunks(db, statements.coverageMap);
		assert.equal((await post('/v1/chunks/upsert', { vaultId: VAULT_A, chunks: [chunk('a.md', 0, 'alpha bravo'), chunk('a.md', 1, 'charlie'), chunk('b.md', 0, 'alpha charlie')] })).status, 200);
		assert.equal((await post('/v1/chunks/upsert', { vaultId: VAULT_B, chunks: [chunk('a.md', 0, 'alpha bravo charlie')] })).status, 200);
		assertMapMatchesChunks(db, statements.coverageMap);
		// Re-upsert of a path (supersede: delete-by-path + reinsert, fewer chunks).
		assert.equal((await post('/v1/chunks/upsert', { vaultId: VAULT_A, chunks: [chunk('a.md', 0, 'delta echo')] })).status, 200);
		assertMapMatchesChunks(db, statements.coverageMap);
		const after = await search(db, VAULT_A, 'alpha charlie', { coverageMap: statements.coverageMap });
		assert.deepEqual(after, await search(db, VAULT_A, 'alpha charlie'));
		assert.equal((await post('/v1/chunks/delete', { vaultId: VAULT_A, paths: ['b.md'] })).status, 200);
		assertMapMatchesChunks(db, statements.coverageMap);
		assert.equal((await post('/v1/index/reset', { vaultId: VAULT_B })).status, 200);
		assertMapMatchesChunks(db, statements.coverageMap);
		assert.equal(statements.coverageMap.lookup().size, 1);
	});
});

test('each committed upsert sub-batch is visible mid-flush; a later sub-batch that rolls back leaves the map matching chunks', async () => {
	const db = makeDb([]);
	const statements = createStatements(db);
	let probe = null;
	const probes = [];
	// now() is constant, so a search before the flush stamps lastInteractiveSearchAt >= the
	// flush start and the upsert calls `delay` between sub-batches — the probe point.
	const delay = async () => {
		probes.push(probe());
	};
	await withHandler(db, { statements, now: () => 0, delay }, async post => {
		assert.equal((await post('/v1/chunks/upsert', { vaultId: VAULT_A, chunks: [chunk('keep.md', 0, 'kilo lima'), chunk('keep.md', 1, 'mike')] })).status, 200);
		assert.equal((await post('/v1/search', { vaultId: VAULT_A, query: 'kilo mike', rankingMode: 'coverage' })).status, 200);
		const first = Array.from({ length: 100 }, (_, i) => chunk('big.md', i, i === 0 ? 'oscar papa' : `quebec${i}`));
		// Sub-batch 2 replaces keep.md (deleting its rows) and then throws on a missing text.
		const second = [chunk('keep.md', 0, 'romeo'), { id: 'keep.md#1', path: 'keep.md', contentHash: 'h' }];
		probe = async () => {
			assertMapMatchesChunks(db, statements.coverageMap);
			return await search(db, VAULT_A, 'oscar papa', { coverageMap: statements.coverageMap });
		};
		const response = await post('/v1/chunks/upsert', { vaultId: VAULT_A, chunks: [...first, ...second] });
		assert.equal(response.status, 400);
	});
	assert.equal(probes.length, 1, 'exactly one inter-sub-batch probe');
	assert.ok((await probes[0]).results.some(row => row.path === 'big.md'), 'the first committed sub-batch is searchable mid-flush');
	assertMapMatchesChunks(db, statements.coverageMap);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE path = 'keep.md'").get().n, 2, 'rolled-back sub-batch kept keep.md');
	assert.deepEqual(await search(db, VAULT_A, 'kilo mike', { coverageMap: statements.coverageMap }), await search(db, VAULT_A, 'kilo mike'));
});
