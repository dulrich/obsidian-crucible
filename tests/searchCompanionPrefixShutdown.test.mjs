// search-latency-tail WP-1: the 1-char FTS prefix index migration (prefix='2 3' → '1 2 3')
// and the companion's graceful shutdown.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
	buildFtsQuery,
	createSchema,
	ftsPrefixSpecHasOneChar,
	migrateFtsSchema,
	startServer,
} from '../scripts/search-companion.mjs';

const VAULT = 'v';

function ftsSql(db) {
	return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'").get().sql;
}

// A current-schema database whose chunks_fts is rebuilt in the legacy prefix='2 3' shape.
function legacyDb() {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	const insert = db.prepare(
		"INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json) VALUES (?, ?, ?, 'h', ?, '', ?, 0, 0, '{}')",
	);
	const texts = ['software widgets', 'software wizard', 'hardware wonders', 'soft water', 'banana bread'];
	texts.forEach((text, i) => insert.run(`c${i}`, VAULT, `n${i}.md`, `n${i}`, text));
	db.exec('DROP TABLE chunks_fts');
	db.exec(`CREATE VIRTUAL TABLE chunks_fts USING fts5(id UNINDEXED, vault_id UNINDEXED, path UNINDEXED, title, heading, text, entities, prefix='2 3')`);
	db.exec('INSERT INTO chunks_fts (rowid, id, vault_id, path, title, heading, text, entities) SELECT rowid, id, vault_id, path, title, heading, text, entities FROM chunks');
	return db;
}

function matchRows(db, query) {
	return db.prepare('SELECT rowid, id, path FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rowid').all(query).map(r => ({ ...r }));
}

test('ftsPrefixSpecHasOneChar keys on the spec, not on prefix= presence', () => {
	assert.equal(ftsPrefixSpecHasOneChar("CREATE ... prefix='2 3')"), false);
	assert.equal(ftsPrefixSpecHasOneChar("CREATE ... prefix='1 2 3')"), true);
	assert.equal(ftsPrefixSpecHasOneChar("CREATE ... prefix = '1')"), true);
	assert.equal(ftsPrefixSpecHasOneChar("CREATE ... prefix='12')"), false);
	assert.equal(ftsPrefixSpecHasOneChar('CREATE ... (a, b)'), false);
});

test("prefix='2 3' migrates to '1 2 3' exactly once, preserving rowids and count", () => {
	const db = legacyDb();
	const before = db.prepare('SELECT rowid, id FROM chunks_fts ORDER BY rowid').all().map(r => ({ ...r }));
	assert.equal(migrateFtsSchema(db), true);
	assert.match(ftsSql(db), /prefix='1 2 3'/);
	const after = db.prepare('SELECT rowid, id FROM chunks_fts ORDER BY rowid').all().map(r => ({ ...r }));
	assert.deepEqual(after, before);
	assert.equal(migrateFtsSchema(db), false);
	// A full createSchema re-open is a no-op too.
	assert.equal(createSchema(db), false);
	db.close();
});

test('a 1-char trailing query returns the same rows before and after migration', () => {
	const db = legacyDb();
	const { primary, fallback } = buildFtsQuery('software w');
	const before = [matchRows(db, primary), matchRows(db, fallback)];
	assert.ok(before[0].length >= 2);
	migrateFtsSchema(db);
	assert.deepEqual([matchRows(db, primary), matchRows(db, fallback)], before);
	db.close();
});

test('a fresh database is created with the 1-char prefix and needs no migration', () => {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	assert.match(ftsSql(db), /prefix='1 2 3'/);
	assert.equal(migrateFtsSchema(db), false);
	db.close();
});

function tempDbPath() {
	return join(mkdtempSync(join(tmpdir(), 'crucible-shutdown-')), 'search.sqlite');
}

async function listening(server) {
	if (server.listening) return;
	await new Promise(done => server.once('listening', done));
}

test('shutdown stops a scheduled vector slice before closing the DB, and is idempotent', async () => {
	const pending = [];
	const started = startServer({ port: 0, host: '127.0.0.1', dbPath: tempDbPath() }, { vectorOptions: { inlineRowLimit: -1, schedule: fn => pending.push(fn) } });
	await listening(started.server);
	// inlineRowLimit -1 makes every build deferred: prepare() schedules a slice.
	assert.equal(started.vectors.prepare(VAULT, null), false);
	assert.equal(pending.length, 1);
	const first = started.shutdown();
	assert.equal(started.shutdown(), first);
	assert.deepEqual(await first, { drained: true });
	// The scheduled slice now runs against a closed DB: it must not touch it.
	assert.doesNotThrow(() => pending.shift()());
	assert.equal(started.vectors.status().vector, 'absent');
	assert.equal(started.server.listening, false);
});

test('shutdown waits for an in-flight yielding request before closing the DB, within the bound', async () => {
	let release;
	const gate = new Promise(done => { release = done; });
	let touchedAfterClose = null;
	const started = startServer(
		{ port: 0, host: '127.0.0.1', dbPath: tempDbPath() },
		{
			wrapHandler: (handler, db) => async (req, res) => {
				if (req.url === '/slow') {
					await gate;
					// Mirrors the upsert finalizer touching the DB after an async yield.
					try { db.prepare('SELECT COUNT(*) AS n FROM chunks').get(); touchedAfterClose = false; } catch { touchedAfterClose = true; }
					res.writeHead(200);
					res.end('ok');
					return;
				}
				return handler(req, res);
			},
		},
	);
	await listening(started.server);
	const url = `http://127.0.0.1:${started.server.address().port}/slow`;
	const response = fetch(url);
	// Let the request reach the handler.
	await new Promise(r => setTimeout(r, 50));
	const t0 = Date.now();
	const done = started.shutdown();
	setTimeout(() => release(), 50);
	assert.deepEqual(await done, { drained: true });
	assert.ok(Date.now() - t0 < 4500);
	assert.equal(touchedAfterClose, false);
	assert.equal((await response).status, 200);
	assert.deepEqual(await started.shutdown(), { drained: true });
});

test('shutdown gives up at the bound without closing the DB under a stuck request', async () => {
	let release;
	const gate = new Promise(done => { release = done; });
	const started = startServer(
		{ port: 0, host: '127.0.0.1', dbPath: tempDbPath() },
		{ shutdownTimeoutMs: 50, wrapHandler: () => async (_req, res) => { await gate; res.writeHead(200); res.end(); } },
	);
	await listening(started.server);
	const response = fetch(`http://127.0.0.1:${started.server.address().port}/`);
	await new Promise(r => setTimeout(r, 50));
	assert.deepEqual(await started.shutdown(), { drained: false });
	// DB still usable: it was not closed under the request.
	assert.doesNotThrow(() => started.db.prepare('SELECT 1').get());
	release();
	await response;
	started.db.close();
});
