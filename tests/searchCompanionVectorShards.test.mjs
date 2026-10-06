// search-latency-tail WP-3: the vector scan sharded over worker threads reading a
// SharedArrayBuffer matrix. The sharded answer must be the inline answer exactly (ids, order,
// scores), a shard failure or a mid-scan invalidation degrades to vectorPending rather than
// throwing or serving stale hits, and shutdown leaves no thread alive.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setImmediate } from 'node:timers';

import { createSchema, createVectorBackend, runSearch, startServer } from '../scripts/search-companion.mjs';

const VAULT = 'test-vault';
const blob = values => new Uint8Array(new Float32Array(values).buffer);

// 4 workers over 13 rows → shards of 4: boundaries between rows 3|4, 7|8, 11|12. Each of those
// pairs holds an identical vector, so equal scores straddle every boundary; rows 0 and 5 point
// exactly along / against the query direction (float32 rounding lands them at or past ±1, which
// the clamp must absorb identically on both paths).
const FIXTURE = [
	[1, 1, 1], [0.2, 0.9, 0.1], [0.5, 0.5, 0], [0.3, 0.3, 0.3], [0.3, 0.3, 0.3],
	[-1, -1, -1], [0, 1, 0], [0.7, 0.1, 0.7], [0.7, 0.1, 0.7], [0.9, 0.2, 0.1],
	[0, 0, 1], [2, 0.2, 0.2], [2, 0.2, 0.2],
];

function makeDb(vectors = FIXTURE) {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	const insert = db.prepare('INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model, embedding_space, entities) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 3, ?, ?, ?)');
	vectors.forEach((v, i) => insert.run(`c${i}`, VAULT, `N${i}.md`, 'h', `T${i}`, '', `word${i} shared`, '{}', blob(v), 'm', 's', ''));
	return db;
}

// A backend whose matrix is built on a manual scheduler (inlineRowLimit below the row count puts
// it in the deferred regime, so the sharded path actually runs on a small matrix).
function shardedBackend(db, extra = {}) {
	const pending = [];
	const backend = createVectorBackend(db, { inlineRowLimit: 2, workers: 4, schedule: fn => pending.push(fn), ...extra });
	const warm = () => {
		for (let i = 0; i < 20 && !backend.prepare(VAULT, null); i++) while (pending.length > 0) pending.shift()();
		backend.stats(VAULT);
		while (pending.length > 0) pending.shift()();
		assert.equal(backend.prepare(VAULT, null), true);
	};
	warm();
	return { backend, warm };
}

test('sharded knn equals the inline scan exactly: ties across shard boundaries at the k cutoff, clamped ±1, un-normalized queries', async () => {
	const db = makeDb();
	const inline = createVectorBackend(db, { workers: 0 });
	const { backend } = shardedBackend(db);
	try {
		const queries = [[3, 3, 3], [0.6, 0.6, 0.6], [7, 0.7, 0.7], [0, 5, 0], [-2, 1, 0.5]];
		for (const query of queries) {
			for (let k = 1; k <= FIXTURE.length; k++) {
				const expected = await inline.knn(VAULT, query, k);
				const actual = await backend.knn(VAULT, query, k);
				assert.deepEqual(actual, expected, `query ${query} k=${k}`);
			}
		}
		const top = await backend.knn(VAULT, [3, 3, 3], 1);
		assert.equal(top[0].score, 1, 'the along-query row clamps to exactly 1');
		const all = await backend.knn(VAULT, [3, 3, 3], FIXTURE.length);
		assert.equal(all.at(-1).score, -1, 'the opposite row clamps to exactly -1');
		assert.ok(backend.shardStatus().shardedScans > 0, 'the sharded path actually ran');
		assert.equal(inline.shardStatus().shardedScans, 0);
	} finally {
		backend.stop();
		inline.stop();
	}
});

test('at or below inlineRowLimit the scan stays inline and starts no threads', async () => {
	const db = makeDb();
	const backend = createVectorBackend(db, { workers: 4 });
	try {
		const hits = await backend.knn(VAULT, [1, 1, 1], 3);
		assert.equal(hits.length, 3);
		assert.equal(backend.shardStatus().shardedScans, 0);
		assert.equal(backend.shardStatus().alive.length, 0);
	} finally {
		backend.stop();
	}
});

test('a shard failure rejects as vectorPending, and the next scan recreates the pool with correct results', async () => {
	const db = makeDb();
	const inline = createVectorBackend(db, { workers: 0 });
	const { backend } = shardedBackend(db);
	try {
		backend.injectShardFault();
		await assert.rejects(backend.knn(VAULT, [1, 2, 3], 5), e => e.vectorPending === true);
		assert.deepEqual(await backend.knn(VAULT, [1, 2, 3], 5), await inline.knn(VAULT, [1, 2, 3], 5));
		assert.equal(backend.shardStatus().alive.length, 4);
	} finally {
		backend.stop();
	}
});

test('runSearch degrades a failed shard to keywords-only with vectorPending, never a throw', async () => {
	const db = makeDb();
	const { backend } = shardedBackend(db);
	try {
		backend.injectShardFault();
		const outcome = await runSearch(db, { vaultId: VAULT, query: 'word3', limit: 5, vectors: backend, queryEmbedding: [1, 1, 1] });
		assert.equal(outcome.vectorPending, true);
		assert.equal(outcome.vectorUsed, false);
		assert.equal(outcome.note, null);
		assert.equal(outcome.degraded, false);
		assert.ok(outcome.results.every(row => row.attribution.vectorRank == null), 'no vector-ranked rows in the degraded answer');
		const healed = await runSearch(db, { vaultId: VAULT, query: 'word3', limit: 5, vectors: backend, queryEmbedding: [1, 1, 1] });
		assert.equal(healed.vectorUsed, true);
		assert.equal(healed.vectorPending, false);
	} finally {
		backend.stop();
	}
});

test('a scan whose matrix generation was invalidated mid-flight is rejected, never returned as fresh', async () => {
	const db = makeDb();
	const { backend, warm } = shardedBackend(db);
	try {
		// The workers hold the old SharedArrayBuffer; the invalidation lands before they answer.
		const inFlight = backend.knn(VAULT, [1, 1, 1], 3);
		backend.invalidate(VAULT);
		await assert.rejects(inFlight, e => e.vectorPending === true && /changed during the scan/.test(e.message));
		warm();
		assert.equal((await backend.knn(VAULT, [1, 1, 1], 3)).length, 3);
	} finally {
		backend.stop();
	}
});

test('shutdown terminates the shard pool: no worker thread is left alive', async () => {
	const dbPath = join(mkdtempSync(join(tmpdir(), 'crucible-shards-')), 'search.sqlite');
	const seed = new DatabaseSync(dbPath);
	createSchema(seed);
	seed.close();
	const started = startServer({ port: 0, host: '127.0.0.1', dbPath }, { vectorOptions: { inlineRowLimit: 2, workers: 4 } });
	if (!started.server.listening) await once(started.server, 'listening');
	const insert = started.db.prepare('INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model, embedding_space, entities) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 3, ?, ?, ?)');
	FIXTURE.forEach((v, i) => insert.run(`c${i}`, VAULT, `N${i}.md`, 'h', 't', '', 'x', '{}', blob(v), 'm', 's', ''));
	started.vectors.prepare(VAULT, null);
	for (let i = 0; i < 50 && !started.vectors.prepare(VAULT, null); i++) await new Promise(done => setImmediate(done));
	started.vectors.stats(VAULT);
	assert.equal((await started.vectors.knn(VAULT, [1, 1, 1], 3)).length, 3);
	const workers = [...started.vectors.shardStatus().alive];
	assert.equal(workers.length, 4);
	const exited = Promise.all(workers.map(worker => once(worker, 'exit')));
	assert.deepEqual(await started.shutdown(), { drained: true });
	await exited;
	assert.equal(started.vectors.shardStatus().alive.length, 0);
	assert.ok(workers.every(worker => worker.threadId === -1), 'every shard thread has exited');
});
