// WP-3 (sprint-exit-queue-health-and-scrub) companion-side coverage:
//
// 1. Malformed input (F1/F5 from the WP-1 audit) must be a 4xx, never a 5xx. The client maps
//    every 5xx to SearchServiceUnavailableError — "companion not reachable" — which the caller
//    then defers and retries forever; a client bug misreported that way looks exactly like an
//    outage and never resolves on its own. `requireString`/`readJson` used to throw a plain
//    Error, which the request handler's catch-all maps to 500.
// 2. `splitUpsertSubBatches`, the pure helper behind the chunked-transaction upsert that keeps
//    `/health` responsive during a large write (see UPSERT_SUB_BATCH_CHUNKS in
//    scripts/search-companion.mjs). Pure and DB-free per the module's own shape note.
//
// Same rules as the sibling companion test files: the companion exports its pure helpers and
// keeps the server bootstrap behind `isMainModule()`, so importing it opens no database and
// binds no port. The HTTP cases here bind their own ephemeral loopback server; nothing touches
// the live companion on 127.0.0.1:4801.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
	createRequestHandler,
	createSchema,
	splitUpsertSubBatches,
	UPSERT_SUB_BATCH_CHUNKS,
} from '../scripts/search-companion.mjs';

const VAULT = 'test-vault';

function makeDb() {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	return db;
}

async function withServer(db, fn) {
	const server = createServer(createRequestHandler(db));
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
		...(extra.embedding ? { embedding: extra.embedding } : {}),
	};
}

// ── F5: malformed input is a 4xx, never a 5xx ───────────────────────────────────────────────

test('a missing required field (requireString) is rejected with 4xx, not 500', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		// No vaultId anywhere (neither top-level nor per-chunk) — requireString throws. An empty
		// `chunks` array would never reach the per-chunk requireString call at all (nothing to
		// iterate), so this needs a real chunk to exercise the check.
		const missingVault = await call('POST', '/v1/chunks/upsert', {
			chunks: [{ id: 'a', path: 'A.md', contentHash: 'h', text: 't' }],
		});
		assert.equal(missingVault.status, 400);
		assert.notEqual(missingVault.status, 500);
		assert.match(missingVault.json.error, /vaultId/);

		// A chunk missing its own required field.
		const missingChunkField = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [{ id: 'a', vaultId: VAULT, path: 'A.md', contentHash: 'h' /* no text */ }],
		});
		assert.equal(missingChunkField.status, 400);
		assert.notEqual(missingChunkField.status, 500);
	});
	db.close();
});

// A raw fetch rather than the `call` helper above, because the whole point is to send a body
// `JSON.stringify` would never produce.
test('an unparseable JSON body is rejected with 4xx, not 500', async () => {
	const db = makeDb();
	const server = createServer(createRequestHandler(db));
	await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
	try {
		const base = `http://127.0.0.1:${server.address().port}`;
		const response = await fetch(`${base}/v1/chunks/upsert`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{not valid json',
		});
		assert.equal(response.status, 400);
		assert.notEqual(response.status, 500);
		const body = await response.json();
		assert.match(body.error, /invalid JSON/i);
	} finally {
		await new Promise(resolveClose => server.close(resolveClose));
	}
	db.close();
});

test('a valid request still succeeds after the malformed-input fix (no over-correction to always-400)', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const response = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [chunk('a', 'A.md', 'alpha')],
		});
		assert.equal(response.status, 200);
	});
	db.close();
});

// ── splitUpsertSubBatches: the pure helper behind the chunked upsert ────────────────────────

test('splitUpsertSubBatches groups chunks into UPSERT_SUB_BATCH_CHUNKS-sized batches', () => {
	const chunks = Array.from({ length: UPSERT_SUB_BATCH_CHUNKS * 2 + 5 }, (_, i) => chunk(String(i), `${i}.md`, 'x'));
	const batches = splitUpsertSubBatches(chunks);

	assert.equal(batches.length, 3);
	assert.equal(batches[0].length, UPSERT_SUB_BATCH_CHUNKS);
	assert.equal(batches[1].length, UPSERT_SUB_BATCH_CHUNKS);
	assert.equal(batches[2].length, 5);
	// Every chunk survives, in order, split but not dropped or duplicated.
	assert.deepEqual(batches.flat().map(c => c.id), chunks.map(c => c.id));
});

test('splitUpsertSubBatches returns one batch for input under the sub-batch size', () => {
	const chunks = [chunk('a', 'A.md', 'x'), chunk('b', 'B.md', 'y')];
	const batches = splitUpsertSubBatches(chunks);
	assert.equal(batches.length, 1);
	assert.equal(batches[0].length, 2);
});

test('splitUpsertSubBatches on an empty array returns no batches', () => {
	assert.deepEqual(splitUpsertSubBatches([]), []);
});

test('splitUpsertSubBatches respects a custom size and produces an exact boundary batch cleanly', () => {
	const chunks = Array.from({ length: 10 }, (_, i) => chunk(String(i), `${i}.md`, 'x'));
	const batches = splitUpsertSubBatches(chunks, 5);
	assert.equal(batches.length, 2);
	assert.equal(batches[0].length, 5);
	assert.equal(batches[1].length, 5);
});

// ── Path-aware grouping: a (vaultId, path) group must never straddle two sub-batches ────────
//
// Regression coverage for the review finding: splitting purely by count let one path's chunks
// land in two different transactions, so a width/space-conflict throw in the second sub-batch
// (a realistic mid-request failure — it fires on the first offending chunk) could leave that
// path with its old rows deleted and only some of its new rows committed. Grouping by
// (vaultId, path) first and packing whole groups guarantees a path is either fully untouched,
// fully deleted-and-replaced, or (if a throw lands inside its own group) rolled all the way
// back to its prior state — never half-written.

test('splitUpsertSubBatches keeps a single path\'s chunks whole even when the path alone exceeds the sub-batch size', () => {
	const onePath = Array.from({ length: UPSERT_SUB_BATCH_CHUNKS + 50 }, (_, i) => chunk(`p-${i}`, 'Big.md', `x${i}`));
	const batches = splitUpsertSubBatches(onePath);

	assert.equal(batches.length, 1, 'an oversized single-path group becomes one (oversized) sub-batch, not split');
	assert.equal(batches[0].length, UPSERT_SUB_BATCH_CHUNKS + 50);
	assert.deepEqual(batches[0].map(c => c.id), onePath.map(c => c.id));
});

test('splitUpsertSubBatches never lets a (vaultId, path) group straddle two sub-batches', () => {
	// Three paths of 60 chunks each: count-based packing at size 100 would put chunks 1-100
	// (all of path A, 40 of path B) in one sub-batch and the remaining 20 of path B plus all of
	// path C in the next — straddling path B. Group-aware packing must not do that.
	const groupSize = 60;
	const paths = ['A.md', 'B.md', 'C.md'];
	const chunks = paths.flatMap(path =>
		Array.from({ length: groupSize }, (_, i) => chunk(`${path}-${i}`, path, `x${i}`)));

	const batches = splitUpsertSubBatches(chunks, 100);

	assert.equal(batches.length, 3, 'each 60-chunk group gets its own sub-batch rather than packing two together and splitting the third');
	for (const batch of batches) {
		const distinctPaths = new Set(batch.map(c => c.path));
		assert.equal(distinctPaths.size, 1, `sub-batch mixed paths: ${[...distinctPaths]}`);
		assert.equal(batch.length, groupSize);
	}
});

test('splitUpsertSubBatches preserves first-seen group order, even when a caller interleaves two paths\' chunks', () => {
	// A caller need not send one path's chunks contiguously — interleave A/B/A/B and confirm
	// each group's chunks stay in their own relative order and groups come out in the order
	// their first chunk was seen (A before B), not re-sorted some other way.
	const interleaved = [
		chunk('a1', 'A.md', 'a1'),
		chunk('b1', 'B.md', 'b1'),
		chunk('a2', 'A.md', 'a2'),
		chunk('b2', 'B.md', 'b2'),
	];

	const batches = splitUpsertSubBatches(interleaved, 100);

	assert.equal(batches.length, 1, 'both groups fit in one sub-batch at this size');
	assert.deepEqual(batches[0].map(c => c.id), ['a1', 'a2', 'b1', 'b2'], 'grouped by path, group order = first-seen (A before B), chunk order within a group preserved');
});

test('splitUpsertSubBatches groups a chunk missing its own vaultId with siblings using the request-level fallback', () => {
	// Mirrors the real `chunk.vaultId ?? body.vaultId` resolution in the request handler: a
	// chunk that omits vaultId must group with a sibling that states it explicitly, when both
	// resolve to the same effective vault — otherwise the two halves of one path could still
	// straddle sub-batches via a vaultId-key mismatch that isn't really a different vault at all.
	const explicit = chunk('a1', 'Shared.md', 'x1', { vaultId: VAULT });
	const implicit = { ...chunk('a2', 'Shared.md', 'x2'), vaultId: undefined };

	const batches = splitUpsertSubBatches([explicit, implicit], 100, VAULT);

	assert.equal(batches.length, 1);
	assert.equal(batches[0].length, 2, 'both chunks land in the same group/sub-batch once the fallback vaultId is applied');
});

// ── The sub-batch split does not change end-to-end upsert behavior ─────────────────────────

test('an upsert spanning multiple sub-batches still stores every chunk correctly', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const chunks = Array.from({ length: UPSERT_SUB_BATCH_CHUNKS + 10 }, (_, i) => chunk(String(i), `${i}.md`, `text ${i}`));
		const response = await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks });
		assert.equal(response.status, 200);
		assert.equal(response.json.count, chunks.length);
	});
	const rows = db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE vault_id = ?').get(VAULT);
	assert.equal(Number(rows.count), UPSERT_SUB_BATCH_CHUNKS + 10);
	db.close();
});

// The named regression: before path-aware grouping, a path with more chunks than
// UPSERT_SUB_BATCH_CHUNKS could have its old rows deleted and roughly its first
// UPSERT_SUB_BATCH_CHUNKS new rows committed in one sub-batch, then a conflict later in the
// SAME path throw in the next sub-batch — leaving the path half-indexed and committed, worse
// than the pre-split single-transaction behavior (which rolled the whole thing back). With
// path-aware grouping this single oversized path is one sub-batch/one transaction, so a
// conflict anywhere inside it rolls the WHOLE path back to its prior state.
test('a width conflict inside an oversized single-path group leaves that path\'s prior rows fully intact, not half-replaced', async () => {
	const db = makeDb();
	const path = 'Big.md';
	const pathChunkCount = UPSERT_SUB_BATCH_CHUNKS + 50; // bigger than one old count-based sub-batch

	await withServer(db, async call => {
		// Seed the path with valid, uniformly-4-dimensional chunks.
		const seed = Array.from({ length: pathChunkCount }, (_, i) => chunk(`seed-${i}`, path, `x${i}`, { embedding: [1, 0, 0, 0] }));
		const seedResponse = await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks: seed });
		assert.equal(seedResponse.status, 200);

		const before = db.prepare('SELECT id FROM chunks WHERE vault_id = ? AND path = ? ORDER BY id').all(VAULT, path);
		assert.equal(before.length, pathChunkCount);

		// Re-send the same path with all-new chunk ids, all valid, except one deep past where
		// the old count-based split would have started a second sub-batch — that chunk carries
		// a conflicting embedding width, so the request as a whole is rejected.
		const conflictIndex = UPSERT_SUB_BATCH_CHUNKS + 25;
		const replacement = Array.from({ length: pathChunkCount }, (_, i) =>
			chunk(`new-${i}`, path, `y${i}`, { embedding: i === conflictIndex ? [1, 0, 0, 0, 0, 0, 0, 0] : [1, 0, 0, 0] }));
		const conflictResponse = await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks: replacement });
		assert.equal(conflictResponse.status, 400);
		assert.notEqual(conflictResponse.status, 500);
	});

	// The path's original rows must be exactly as they were: not deleted, not partially
	// replaced with `new-*` ids.
	const after = db.prepare('SELECT id FROM chunks WHERE vault_id = ? AND path = ? ORDER BY id').all(VAULT, path);
	assert.equal(after.length, pathChunkCount, 'the path must still have all of its original chunks');
	assert.ok(after.every(row => row.id.startsWith('seed-')), 'no `new-*` chunk from the rejected request must have landed');
	db.close();
});

// ── WP-3b: rowid-keyed chunks_fts deletes ───────────────────────────────────────────────────
//
// Schema 6 moved every chunks_fts DELETE from keying on `vault_id`/`id` (both UNINDEXED FTS5
// columns, forcing a full-index scan per delete) to keying on `rowid`, pinned 1:1 to the
// owning chunks.rowid. These tests assert the observable behavior held constant across that
// change: no duplicate/orphaned FTS rows, correct search results, correct snippets.

test('re-upserting the same path replaces rather than duplicates FTS rows', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const first = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [chunk('a', 'A.md', 'the quick brown fox')],
		});
		assert.equal(first.status, 200);

		// Same path, same chunk id, different text — an upsert is a full replace of the path.
		const second = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [chunk('a', 'A.md', 'the lazy dog sleeps')],
		});
		assert.equal(second.status, 200);

		const results = await call('POST', '/v1/search', { vaultId: VAULT, query: 'fox' });
		assert.equal(results.json.results.length, 0, 'the old text must no longer be searchable');

		const hit = await call('POST', '/v1/search', { vaultId: VAULT, query: 'lazy' });
		assert.equal(hit.json.results.length, 1, 'exactly one hit, not a duplicate from the old FTS row surviving alongside the new one');
		assert.equal(hit.json.results[0].path, 'A.md');
		assert.match(hit.json.results[0].snippet, /lazy/);
	});
	// One row in chunks_fts for this id, not two, and its rowid matches the surviving chunks row.
	const chunkRow = db.prepare('SELECT rowid FROM chunks WHERE vault_id = ? AND id = ?').get(VAULT, 'a');
	const ftsRows = db.prepare('SELECT rowid FROM chunks_fts WHERE vault_id = ? AND id = ?').all(VAULT, 'a');
	assert.equal(ftsRows.length, 1);
	assert.equal(ftsRows[0].rowid, chunkRow.rowid);
	db.close();
});

test('replacing a path with a different chunk id leaves no orphaned FTS row for the old id', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const first = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [chunk('old-id', 'A.md', 'alpha content')],
		});
		assert.equal(first.status, 200);

		// Re-index the same path under a new chunk id, as a real re-chunk (heading/ordinal
		// change) would produce via stableChunkId.
		const second = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [chunk('new-id', 'A.md', 'beta content')],
		});
		assert.equal(second.status, 200);

		const staleHit = await call('POST', '/v1/search', { vaultId: VAULT, query: 'alpha' });
		assert.equal(staleHit.json.results.length, 0, 'the old chunk id\'s FTS row must be gone, not orphaned');
	});
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks_fts WHERE vault_id = ? AND path = ?').get(VAULT, 'A.md').n, 1);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ? AND path = ?').get(VAULT, 'A.md').n, 1);
	db.close();
});

test('/v1/chunks/delete removes the FTS row along with the chunk row, leaving the index empty', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const upsert = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [chunk('a', 'A.md', 'delete me please')],
		});
		assert.equal(upsert.status, 200);

		const del = await call('POST', '/v1/chunks/delete', { vaultId: VAULT, paths: ['A.md'] });
		assert.equal(del.status, 200);

		const results = await call('POST', '/v1/search', { vaultId: VAULT, query: 'delete' });
		assert.equal(results.json.results.length, 0);
	});
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?').get(VAULT).n, 0);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks_fts WHERE vault_id = ?').get(VAULT).n, 0);
	db.close();
});

test('/v1/index/reset removes every FTS row for the vault, not just the chunks rows', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const upsert = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [chunk('a', 'A.md', 'one'), chunk('b', 'B.md', 'two'), chunk('c', 'C.md', 'three')],
		});
		assert.equal(upsert.status, 200);

		const reset = await call('POST', '/v1/index/reset', { vaultId: VAULT });
		assert.equal(reset.status, 200);
	});
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?').get(VAULT).n, 0);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks_fts WHERE vault_id = ?').get(VAULT).n, 0);
	db.close();
});
