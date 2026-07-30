// WP-4 (render-search-provider-remediation): companion backfill throttle + once-per-flush
// matrix invalidation.
//
// Two independent behaviors, both scoped to the `/v1/chunks/upsert` flush loop
// (scripts/search-companion.mjs):
//
// (a) Interactive-priority yield — after the companion serves a `/v1/search`, the flush defers
//     its next sub-batch by INTERACTIVE_YIELD_MS (bounded per-flush by
//     INTERACTIVE_YIELD_CUMULATIVE_CAP_MS) so an interactively-searching user gets gaps between
//     ~3.4s sub-batch stalls instead of the flush immediately reclaiming the thread.
// (b) Once-per-flush invalidation — `vectors.invalidate(vault)` (and the stats drop bundled
//     into it) moved from firing after every sub-batch to firing once per completed flush, per
//     touched vault, while still firing for already-committed vaults on a mid-flush throw.
//
// Same rules as the sibling companion test files: the companion exports its pure helpers and
// keeps the server bootstrap behind `isMainModule()`, so importing it opens no database and
// binds no port. Every case here binds its own ephemeral loopback server; nothing touches the
// live companion on 127.0.0.1:4801.
//
// Both `now` and `delay` are injectable seams on `createRequestHandler` (the same pattern as
// WP-3's `now`, and WP-5's `deadlineAt`/`now` on `runSearch`) — the timing-sensitive assertions
// below drive them through a stub rather than real sleeps, per the WP-4 brief's own preference.
// The one piece of real timing these tests can't avoid is getting a concurrently-fired
// `/v1/search` to actually land *during* an in-flight flush: that's real HTTP concurrency on a
// single-threaded event loop, sequenced with `setImmediate` ticks (an event-loop yield, not a
// wall-clock sleep) rather than a fixed-duration wait.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setImmediate as tickEventLoop } from 'node:timers/promises';

import {
	createRequestHandler,
	createSchema,
	INTERACTIVE_YIELD_CUMULATIVE_CAP_MS,
	INTERACTIVE_YIELD_MS,
	splitUpsertSubBatches,
	UPSERT_SUB_BATCH_CHUNKS,
} from '../scripts/search-companion.mjs';

const VAULT = 'test-vault';

function makeDb() {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	return db;
}

// `handlerOptions` (default `{}`) threads straight through to createRequestHandler — same shape
// as `withSearchServer` in tests/searchCompanionDeadline.test.mjs.
async function withServer(db, fn, handlerOptions = {}) {
	const server = createServer(createRequestHandler(db, handlerOptions));
	await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = async (method, path, body) => {
		const response = await fetch(`${base}${path}`, {
			method,
			headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		let json;
		try { json = await response.json(); } catch { json = undefined; }
		return { status: response.status, json };
	};
	try {
		return await fn(call);
	} finally {
		await new Promise(resolveClose => server.close(resolveClose));
	}
}

function chunk(id, path, text, extra = {}) {
	return {
		id,
		vaultId: extra.vaultId ?? VAULT,
		path,
		contentHash: `hash-${id}`,
		title: extra.title ?? path.replace(/\.md$/, ''),
		heading: extra.heading ?? '',
		text,
		mtime: 0,
		ordinal: extra.ordinal ?? 0,
		metadata: {},
	};
}

// A minimal vector-backend double satisfying the seam `createRequestHandler` reads from
// (`{ name, stats, knn, invalidate }` — see the module comment above `createVectorBackend` in
// scripts/search-companion.mjs). Only `invalidate` is exercised by `/v1/chunks/upsert`; `stats`
// and `knn` are stubbed just enough to satisfy `/health` and `/v1/search`, neither of which
// these tests need working semantics from.
function stubVectors(invalidateCalls) {
	return {
		name: 'stub',
		stats: () => ({ count: 0, dim: null, spaces: [], unlabelledCount: 0 }),
		knn: () => [],
		invalidate: vaultId => invalidateCalls.push(vaultId),
	};
}

function manyChunks(count, vaultId = VAULT) {
	return Array.from({ length: count }, (_, i) => chunk(String(i), `${i}.md`, `text ${i}`, { vaultId }));
}

// Not a wall-clock sleep: yields to the event loop's 'check' phase N times, giving a
// concurrently in-flight request (like the upsert flush below) real turns to run its own
// synchronous work and reach its next `await` point before the next thing in this test fires.
async function tick(times = 4) {
	for (let i = 0; i < times; i++) await tickEventLoop();
}

// ── (b) once-per-flush invalidation ─────────────────────────────────────────────────────────

test('vectors.invalidate fires once per touched vault per flush, not once per sub-batch', async () => {
	const db = makeDb();
	const invalidateCalls = [];
	await withServer(db, async call => {
		// 3 sub-batches (100 + 100 + 7), one vault, one chunk per path.
		const chunks = manyChunks(UPSERT_SUB_BATCH_CHUNKS * 2 + 7);
		const response = await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks });
		assert.equal(response.status, 200);
		assert.equal(response.json.count, chunks.length);
	}, { vectors: stubVectors(invalidateCalls) });
	assert.deepEqual(invalidateCalls, [VAULT], 'exactly one invalidate call for the one touched vault across all 3 sub-batches, not 3');
	db.close();
});

test('vectors.invalidate fires once per touched vault, for every vault touched across the flush', async () => {
	const db = makeDb();
	const invalidateCalls = [];
	await withServer(db, async call => {
		// Two vaults, each spanning multiple sub-batches of their own once packed together.
		const chunks = [...manyChunks(UPSERT_SUB_BATCH_CHUNKS + 5, 'vault-a'), ...manyChunks(UPSERT_SUB_BATCH_CHUNKS + 5, 'vault-b')];
		const response = await call('POST', '/v1/chunks/upsert', { chunks });
		assert.equal(response.status, 200);
	}, { vectors: stubVectors(invalidateCalls) });
	assert.equal(invalidateCalls.length, 2, 'each touched vault is invalidated exactly once, not once per sub-batch it happened to span');
	assert.deepEqual(new Set(invalidateCalls), new Set(['vault-a', 'vault-b']));
	db.close();
});

// Correctness invariant from the brief: an early-exit/error path out of the flush must still
// invalidate for vaults a prior sub-batch already, successfully, wrote into — even though the
// invalidate call itself is now deferred to a single point at the end (or, on a throw, inside a
// `finally`) rather than firing right after each commit.
test('a mid-flush throw still invalidates the vault(s) an earlier, already-committed sub-batch wrote into', async () => {
	const db = makeDb();
	const invalidateCalls = [];
	await withServer(db, async call => {
		// Sub-batch 1: 100 valid vault-a chunks (one full sub-batch on their own, distinct
		// paths). Sub-batch 2: a single vault-b chunk missing its required `text` field, so it
		// throws (400) before ever reaching `touchedVaults.add` for vault-b, let alone COMMIT.
		const validChunks = manyChunks(UPSERT_SUB_BATCH_CHUNKS, 'vault-a');
		const badChunk = { id: 'bad', vaultId: 'vault-b', path: 'Bad.md', contentHash: 'h' };
		const response = await call('POST', '/v1/chunks/upsert', { chunks: [...validChunks, badChunk] });
		assert.equal(response.status, 400);
		assert.notEqual(response.status, 500);
	}, { vectors: stubVectors(invalidateCalls) });
	assert.deepEqual(invalidateCalls, ['vault-a'], 'vault-a\'s already-committed sub-batch must still be invalidated even though the request as a whole failed on vault-b\'s sub-batch');
	// And the DB itself agrees: vault-a's rows are really there, vault-b's aren't.
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?').get('vault-a').n, UPSERT_SUB_BATCH_CHUNKS);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?').get('vault-b').n, 0);
	db.close();
});

// ── (a) interactive-priority yield ──────────────────────────────────────────────────────────

test('a /v1/search served during a multi-sub-batch flush is answered, and defers the flush\'s next sub-batch', async () => {
	const db = makeDb();
	const delayCalls = [];
	const delay = async ms => { delayCalls.push(ms); }; // records the requested wait, resolves immediately (no real sleep)
	await withServer(db, async call => {
		// 10 sub-batches — enough real sub-batch/COMMIT work (in-memory SQLite, but still real
		// transactions) that the flush is still mid-flight by the time the concurrently-fired
		// search below reaches the server; a much smaller flush finishes before the search's own
		// connection/readJson round trip completes, which raced closed (0 interleaves, 0 defers)
		// during initial development of this test.
		const chunks = manyChunks(UPSERT_SUB_BATCH_CHUNKS * 9 + 20);
		const upsertPromise = call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks });
		// Let the upsert request actually start (receive its body, begin its first sub-batch)
		// before the search races in.
		await tick(2);
		const searchPromise = call('POST', '/v1/search', { vaultId: VAULT, query: 'text' });
		const [upsertResult, searchResult] = await Promise.all([upsertPromise, searchPromise]);
		assert.equal(upsertResult.status, 200);
		assert.equal(searchResult.status, 200, 'a search issued mid-flush must be served, not starved until the whole flush finishes');
	}, { delay });
	assert.ok(delayCalls.length >= 1, 'the flush must have deferred at least one sub-batch boundary after the interleaved search');
	for (const ms of delayCalls) {
		assert.ok(ms > 0 && ms <= INTERACTIVE_YIELD_MS, `deferral ${ms}ms must be within (0, INTERACTIVE_YIELD_MS=${INTERACTIVE_YIELD_MS}]`);
	}
	db.close();
});

test('no search during the flush means no interactive-yield deferral at all', async () => {
	const db = makeDb();
	const delayCalls = [];
	const delay = async ms => { delayCalls.push(ms); };
	await withServer(db, async call => {
		const chunks = manyChunks(UPSERT_SUB_BATCH_CHUNKS * 2 + 20);
		const response = await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks });
		assert.equal(response.status, 200);
	}, { delay });
	assert.deepEqual(delayCalls, [], 'a flush with no interleaved search must never call delay at all');
	db.close();
});

// Cumulative-deferral cap: a continuously-searching client must not be able to hold the flush
// open past INTERACTIVE_YIELD_CUMULATIVE_CAP_MS. The `delay` stub fires (and awaits) a further
// real search of its own every time it's invoked — deterministically simulating "the user keeps
// searching" for every sub-batch boundary after the first real interleave, without depending on
// exact wall-clock racing for more than that first one.
test('cumulative interactive-yield deferral across one flush is capped, even under continuous searching', async () => {
	const db = makeDb();
	const delayCalls = [];
	let callRef = null;
	const delay = async ms => {
		delayCalls.push(ms);
		if (callRef) {
			const searched = await callRef('POST', '/v1/search', { vaultId: VAULT, query: 'text' });
			assert.equal(searched.status, 200);
		}
	};
	// 15 sub-batches (14 boundaries) — comfortably more than the
	// ceil(INTERACTIVE_YIELD_CUMULATIVE_CAP_MS / INTERACTIVE_YIELD_MS) = 10 boundaries the cap
	// can afford to defer, so the cap has room to visibly bind before sub-batches run out.
	const subBatchCount = 15;
	await withServer(db, async call => {
		callRef = call;
		const chunks = manyChunks(UPSERT_SUB_BATCH_CHUNKS * (subBatchCount - 1) + 5);
		const upsertPromise = call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks });
		await tick();
		const primed = await call('POST', '/v1/search', { vaultId: VAULT, query: 'text' });
		assert.equal(primed.status, 200);
		const upsertResult = await upsertPromise;
		assert.equal(upsertResult.status, 200);
	}, { delay });

	const totalDeferredMs = delayCalls.reduce((sum, ms) => sum + ms, 0);
	assert.ok(totalDeferredMs <= INTERACTIVE_YIELD_CUMULATIVE_CAP_MS, `cumulative deferral ${totalDeferredMs}ms must not exceed the ${INTERACTIVE_YIELD_CUMULATIVE_CAP_MS}ms cap`);
	assert.ok(delayCalls.length >= 3, 'continuous searching must have produced more than one or two deferrals before the cap bound it');
	assert.ok(delayCalls.length < subBatchCount - 1, 'the cap must have stopped deferrals before the flush ran out of sub-batch boundaries on its own — proves the cap actually bound something rather than the flush just finishing');
	for (const ms of delayCalls) {
		assert.ok(ms > 0 && ms <= INTERACTIVE_YIELD_MS, `each individual deferral ${ms}ms must be within (0, INTERACTIVE_YIELD_MS=${INTERACTIVE_YIELD_MS}]`);
	}
	db.close();
});

// splitUpsertSubBatches sanity check specific to the fixture size used above, so a future change
// to the packing algorithm that silently changed the sub-batch count would fail loudly here
// rather than only as a mysterious change in delayCalls.length upstream.
test('fixture sanity: manyChunks(UPSERT_SUB_BATCH_CHUNKS * 14 + 5) really does split into 15 sub-batches', () => {
	const chunks = manyChunks(UPSERT_SUB_BATCH_CHUNKS * 14 + 5);
	const batches = splitUpsertSubBatches(chunks, UPSERT_SUB_BATCH_CHUNKS, VAULT);
	assert.equal(batches.length, 15);
});
