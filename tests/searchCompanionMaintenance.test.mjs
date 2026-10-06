// search-latency-durability WP-2: the companion never builds a vector matrix (or a cold stats
// aggregate) on a search's stack above the inline limit, says so with `vectorPending`, and
// reports its own state on GET /health.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
	createRequestHandler,
	createSchema,
	createVectorBackend,
	formatSearchLogLine,
	parseCgroupMemory,
	shouldLogSearch,
} from '../scripts/search-companion.mjs';

const VAULT = 'test-vault';

function makeDb() {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	return db;
}

function chunk(id, path, text, embedding) {
	return { id, vaultId: VAULT, path, contentHash: `hash-${id}`, title: path.replace(/\.md$/, ''), heading: '', text, mtime: 0, ordinal: 0, metadata: {}, embedding };
}

// A manual slice scheduler: nothing runs until the test drains it.
function manualScheduler() {
	const pending = [];
	return {
		schedule: fn => pending.push(fn),
		runOne: () => { const fn = pending.shift(); if (fn) fn(); return Boolean(fn); },
		drain: () => { let n = 0; while (pending.length > 0 && n++ < 10_000) pending.shift()(); },
		get size() { return pending.length; },
	};
}

async function withServer(db, options, fn) {
	const server = createServer(createRequestHandler(db, options));
	await new Promise(done => server.listen(0, '127.0.0.1', done));
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = async (method, path, body) => {
		const response = await fetch(`${base}${path}`, {
			method,
			headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, json: await response.json() };
	};
	try {
		return await fn(call);
	} finally {
		await new Promise(done => server.close(done));
	}
}

test('deferred regime: a search on a stale matrix answers FTS-only with vectorPending, the off-request rebuild then serves hybrid', async () => {
	const db = makeDb();
	const scheduler = manualScheduler();
	const vectors = createVectorBackend(db, { inlineRowLimit: 0, schedule: scheduler.schedule });
	const logged = [];
	await withServer(db, { vectors, searchLog: line => logged.push(line) }, async call => {
		const upsert = await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks: [chunk('a', 'A.md', 'alpha text', [1, 0, 0]), chunk('b', 'B.md', 'beta text', [0, 1, 0])] });
		assert.equal(upsert.status, 200);

		const first = await call('POST', '/v1/search', { vaultId: VAULT, query: 'alpha', queryEmbedding: [0, 1, 0], limit: 5 });
		assert.equal(first.status, 200);
		assert.equal(first.json.vectorPending, true);
		assert.equal(first.json.mode, 'fts');
		assert.deepEqual(first.json.results.map(row => row.path), ['A.md'], 'FTS still answers in full');
		assert.ok(scheduler.size > 0, 'the rebuild was scheduled, not run inline');
		assert.equal(vectors.status().vector, 'building');

		// Cold start: the first rebuild is the stats aggregate (the scan space is unknown until it
		// lands); the next search then schedules the matrix for the resolved space.
		scheduler.drain();
		const warming = await call('POST', '/v1/search', { vaultId: VAULT, query: 'alpha', queryEmbedding: [0, 1, 0], limit: 5 });
		assert.equal(warming.json.vectorPending, true);
		scheduler.drain();
		assert.equal(vectors.status().vector, 'ready');
		const second = await call('POST', '/v1/search', { vaultId: VAULT, query: 'alpha', queryEmbedding: [0, 1, 0], limit: 5 });
		assert.equal(second.json.vectorPending, undefined);
		assert.equal(second.json.mode, 'hybrid');
		assert.ok(second.json.results.some(row => row.path === 'B.md'), 'the vector-only hit arrives once the matrix is built');
		for (const key of ['queueMs', 'primaryMs', 'rescueMs', 'vectorMs', 'coverageMs', 'totalMs']) assert.ok(key in second.json.timings, key);
	});
	assert.equal(logged.length, 2, 'only the vectorPending searches log');
	for (const line of logged) {
		assert.match(line, /"vectorPending":true/);
		assert.doesNotMatch(line, /alpha/);
	}
});

test('an invalidation landing mid-build restarts the build, and the published matrix holds the post-invalidation rows', () => {
	const db = makeDb();
	const insert = db.prepare('INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model, embedding_space, entities) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 3, ?, ?, ?)');
	const blob = values => new Uint8Array(new Float32Array(values).buffer);
	for (let i = 0; i < 1200; i++) insert.run(`c${i}`, VAULT, `N${i}.md`, 'h', 't', '', 'x', '{}', blob([1, 0, 0]), 'm', 's', '');
	const scheduler = manualScheduler();
	// A clock that jumps 1s per read: every slice does exactly one batch and yields.
	let t = 0;
	const vectors = createVectorBackend(db, { inlineRowLimit: 0, schedule: scheduler.schedule, clock: () => (t += 1000), sliceMs: 1 });
	assert.equal(vectors.prepare(VAULT, null), false);
	scheduler.runOne();
	scheduler.runOne();
	assert.equal(vectors.status().vector, 'building');
	// A write commits mid-build and the flush invalidates.
	insert.run('late', VAULT, 'Late.md', 'h', 't', '', 'x', '{}', blob([0, 0, 1]), 'm', 's', '');
	vectors.invalidate(VAULT);
	scheduler.drain();
	assert.ok(vectors.status().restarts >= 1, 'the in-flight build was discarded and restarted');
	assert.equal(vectors.prepare(VAULT, null), true);
	const hits = vectors.knn(VAULT, [0, 0, 1], 1);
	assert.equal(hits[0].id, 'late', 'the post-invalidation row is in the published matrix');
	assert.equal(vectors.stats(VAULT).count, 1201);
});

test('cold stats in the deferred regime never scan on the caller stack: pending first, last-known value after an invalidation', () => {
	const db = makeDb();
	db.prepare("INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model, embedding_space, entities) VALUES ('a', ?, 'A.md', 'h', 't', '', 'x', 0, 0, '{}', ?, 3, 'm', 's', '')").run(VAULT, new Uint8Array(new Float32Array([1, 0, 0]).buffer));
	const scheduler = manualScheduler();
	const vectors = createVectorBackend(db, { inlineRowLimit: 0, schedule: scheduler.schedule });
	const cold = vectors.stats(VAULT);
	assert.equal(cold.pending, true);
	assert.equal(cold.count, 0);
	scheduler.drain();
	assert.deepEqual(vectors.stats(VAULT), { count: 1, dim: 3, model: 'm', spaces: ['s'], unlabelledCount: 0 });
	vectors.invalidate(VAULT);
	const stale = vectors.stats(VAULT);
	assert.equal(stale.pending, true);
	assert.equal(stale.count, 1, 'last-known stats keep semanticAvailable truthful while the rebuild runs');
});

test('cgroup memory parse: the live exhausted numbers read exhausted, an idle container reads ok', () => {
	const live = parseCgroupMemory({
		'memory.max': '1073741824\n',
		'memory.peak': '1073741824\n',
		'memory.current': '640192512\n',
		'memory.swap.current': '434221056\n',
		'memory.events': 'low 0\nhigh 0\nmax 29375\noom 0\noom_kill 0\n',
		'memory.stat': 'anon 1000\nfile 600000000\ninactive_file 587898880\nactive_file 100\n',
	});
	assert.deepEqual(live, { limitBytes: 1073741824, currentBytes: 640192512, swapBytes: 434221056, peakBytes: 1073741824, maxEvents: 29375, pressure: 'exhausted' });
	const idle = parseCgroupMemory({
		'memory.max': '4294967296\n',
		'memory.peak': '900000000\n',
		'memory.current': '700000000\n',
		'memory.swap.current': '0\n',
		'memory.events': 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n',
		'memory.stat': 'inactive_file 300000000\n',
	});
	assert.equal(idle.pressure, 'ok');
	// Swap alone is not pressure; max events alone are; a rise since the previous read is exhausted.
	const base = { 'memory.max': '1000', 'memory.peak': '100', 'memory.current': '100', 'memory.swap.current': '50', 'memory.stat': 'inactive_file 0', 'memory.events': 'max 0' };
	assert.equal(parseCgroupMemory(base).pressure, 'ok');
	assert.equal(parseCgroupMemory({ ...base, 'memory.events': 'max 3' }).pressure, 'pressure');
	assert.equal(parseCgroupMemory({ ...base, 'memory.events': 'max 3' }, 2).pressure, 'exhausted');
	assert.equal(parseCgroupMemory({ ...base, 'memory.current': undefined }), null);
});

test('GET /health carries the additive stateful fields and keeps every existing one', async () => {
	const db = makeDb();
	const cgroupRoot = mkdtempSync(join(tmpdir(), 'wp2-cgroup-'));
	const files = { 'memory.max': '4294967296', 'memory.peak': '900000000', 'memory.current': '700000000', 'memory.swap.current': '0', 'memory.events': 'max 0', 'memory.stat': 'inactive_file 300000000' };
	for (const [name, text] of Object.entries(files)) writeFileSync(join(cgroupRoot, name), `${text}\n`);
	await withServer(db, { cgroupRoot, startedAt: '2026-10-06T00:00:00.000Z', searchLog: () => {} }, async call => {
		await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks: [chunk('a', 'A.md', 'alpha text', [1, 0, 0])] });
		await call('POST', '/v1/search', { vaultId: VAULT, query: 'alpha', limit: 5 });
		const health = await call('GET', '/health');
		assert.equal(health.status, 200);
		for (const key of ['ok', 'version', 'schemaVersion', 'vectorAvailable', 'vectorBackend', 'embeddedChunks', 'embeddingDim', 'embeddingModel', 'embeddingSpaces', 'embeddingSpace', 'unattributedEmbeddedChunks']) assert.ok(key in health.json, key);
		assert.equal(health.json.startedAt, '2026-10-06T00:00:00.000Z');
		assert.ok(['ready', 'stale', 'building', 'absent'].includes(health.json.vector.status));
		assert.equal(health.json.indexing.flushActive, false);
		assert.equal(typeof health.json.indexing.lastFlushMs, 'number');
		assert.equal(health.json.recentSearch.count, 1);
		assert.equal(health.json.memory.pressure, 'ok');
		assert.equal(health.json.memory.limitBytes, 4294967296);
	});
});

test('the slow/degraded log line carries phase timings and flags, never the query text', () => {
	const entry = { query: 'secret diary words', match: '"secret" AND "diary"', terms: ['secret', 'diary', 'words'], totalMs: 1500, queueMs: 12, timings: { primaryMs: 900, rescueMs: 400, vectorMs: 0, coverageMs: 0 }, degraded: true, vectorPending: false };
	assert.equal(shouldLogSearch(entry), true);
	assert.equal(shouldLogSearch({ totalMs: 20 }), false);
	const line = formatSearchLogLine(entry);
	assert.doesNotMatch(line, /secret|diary|words/);
	const parsed = JSON.parse(line.replace('[crucible-search] ', ''));
	assert.equal(parsed.terms, 3);
	assert.equal(parsed.totalMs, 1500);
	assert.equal(parsed.primaryMs, 900);
	assert.equal(parsed.degraded, true);
});
