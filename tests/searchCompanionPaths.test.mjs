// WP-SA1: `POST /v1/paths` — every indexed path for a vault, aggregated in one query. Nothing
// exercised this before: `/v1/files/state` only echoes state for paths the caller already
// names, so nothing could enumerate "what does the index think exists" — the gap this endpoint
// closes for the client-side audit command (WP-SA2, a separate work package, not built here).
//
// Same rules as the sibling companion suites: the companion exports its pure helpers and keeps
// the server bootstrap behind `isMainModule()`, so importing it opens no database and binds no
// port. Every case here builds its own in-memory SQLite database and binds its own ephemeral
// loopback server — nothing touches the live companion on 127.0.0.1:4801.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createRequestHandler, createSchema } from '../scripts/search-companion.mjs';

const VAULT = 'paths-test-vault';
const OTHER_VAULT = 'paths-test-other-vault';

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

function chunk(id, vaultId, path, text, extra = {}) {
	return {
		id,
		vaultId,
		path,
		contentHash: extra.contentHash ?? `hash-${id}`,
		title: extra.title ?? path.replace(/\.md$/, ''),
		heading: extra.heading ?? '',
		text,
		mtime: extra.mtime ?? 0,
		ordinal: extra.ordinal ?? 0,
		metadata: {},
		...(extra.embedding ? { embedding: extra.embedding } : {}),
	};
}

// ── 1. Happy path: rows + totals correct on a seeded fixture ────────────────────────────────

test('lists every path in the vault with per-path chunk/embedding counts and correct totals', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const upsert = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [
				// A.md: two chunks, both embedded. Real chunkers stamp every chunk of one note
				// with the same note-level contentHash — mirrored here so the fixture exercises
				// the endpoint's normal (single content-hash group per path) path.
				chunk('a-0', VAULT, 'A.md', 'alpha one', { mtime: 100, contentHash: 'hash-a', embedding: [1, 0, 0] }),
				chunk('a-1', VAULT, 'A.md', 'alpha two', { mtime: 100, contentHash: 'hash-a', embedding: [0, 1, 0] }),
				// B.md: one chunk, no embedding — the coverage gap this endpoint must surface.
				chunk('b-0', VAULT, 'B.md', 'beta one', { mtime: 200 }),
			],
		});
		assert.equal(upsert.status, 200);

		const result = await call('POST', '/v1/paths', { vaultId: VAULT });
		assert.equal(result.status, 200);
		assert.equal(result.json.ok, true);

		const byPath = new Map(result.json.paths.map(row => [row.path, row]));
		assert.deepEqual([...byPath.keys()].sort(), ['A.md', 'B.md']);

		const a = byPath.get('A.md');
		assert.equal(a.chunkCount, 2);
		assert.equal(a.embeddedCount, 2);
		assert.equal(a.mtime, 100);
		assert.equal(a.contentHash, 'hash-a');

		const b = byPath.get('B.md');
		assert.equal(b.chunkCount, 1);
		assert.equal(b.embeddedCount, 0);
		assert.equal(b.mtime, 200);
		assert.equal(b.contentHash, 'hash-b-0');

		assert.deepEqual(result.json.totals, { paths: 2, chunks: 3, embeddedChunks: 2 });
	});
});

// ── 2. Vault scoping: a second vault's rows never leak into the first's listing ─────────────

test('scopes strictly to vaultId — a second vault sharing the database never appears', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [chunk('own-0', VAULT, 'Mine.md', 'mine text', { mtime: 1 })],
		});
		await call('POST', '/v1/chunks/upsert', {
			vaultId: OTHER_VAULT,
			chunks: [
				chunk('other-0', OTHER_VAULT, 'Theirs.md', 'their text', { mtime: 1 }),
				chunk('other-1', OTHER_VAULT, 'Theirs2.md', 'their text two', { mtime: 1 }),
			],
		});

		const mine = await call('POST', '/v1/paths', { vaultId: VAULT });
		assert.equal(mine.status, 200);
		assert.deepEqual(mine.json.paths.map(row => row.path), ['Mine.md']);
		assert.deepEqual(mine.json.totals, { paths: 1, chunks: 1, embeddedChunks: 0 });

		const theirs = await call('POST', '/v1/paths', { vaultId: OTHER_VAULT });
		assert.equal(theirs.status, 200);
		assert.deepEqual(theirs.json.paths.map(row => row.path).sort(), ['Theirs.md', 'Theirs2.md']);
		assert.deepEqual(theirs.json.totals, { paths: 2, chunks: 2, embeddedChunks: 0 });
	});
});

// ── 3. A path split across two content-hash groups (mid-rewrite) reports the majority group ─

test('a path transiently holding two content-hash groups reports the chunk-count-majority group, not an arbitrary pick', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		// Same shape selectStateByPath already handles for a single requested path: a rewrite
		// in flight can briefly leave a path with rows under both its old and new hash. Upsert
		// clears a path's existing rows only once per batch (on the first chunk it sees for that
		// path), so a single batch carrying both hashes for the same path is exactly how that
		// transient state lands in the table — one straggler under 'hash-old', two chunks under
		// 'hash-new'. The majority group must win, and the minority group's row must not be
		// double-counted into totals.
		const upsert = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [
				chunk('mixed-old', VAULT, 'Mixed.md', 'old text', { mtime: 40, contentHash: 'hash-old' }),
				chunk('mixed-new-0', VAULT, 'Mixed.md', 'new text one', { mtime: 50, contentHash: 'hash-new' }),
				chunk('mixed-new-1', VAULT, 'Mixed.md', 'new text two', { mtime: 50, contentHash: 'hash-new' }),
			],
		});
		assert.equal(upsert.status, 200);

		const result = await call('POST', '/v1/paths', { vaultId: VAULT });
		assert.equal(result.status, 200);
		const mixed = result.json.paths.find(row => row.path === 'Mixed.md');
		assert.ok(mixed, 'Mixed.md is listed exactly once');
		assert.equal(mixed.contentHash, 'hash-new');
		assert.equal(mixed.chunkCount, 2);
		// `totals` is derived from the same per-path rows `paths` lists (a straight sum over
		// them), so it stays internally consistent with what the caller can see: the minority
		// straggler row is excluded from both, not counted in totals while invisible in the
		// listing.
		assert.equal(result.json.totals.chunks, 2);
	});
});

// ── 4. Empty vault: empty array + zero totals, not an error ─────────────────────────────────

test('an unindexed (or unknown) vault answers an empty list and zeroed totals, not an error', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const result = await call('POST', '/v1/paths', { vaultId: 'never-indexed-vault' });
		assert.equal(result.status, 200);
		assert.equal(result.json.ok, true);
		assert.deepEqual(result.json.paths, []);
		assert.deepEqual(result.json.totals, { paths: 0, chunks: 0, embeddedChunks: 0 });
	});
});

// ── 5. Bad request shape: same 4xx contract as the other endpoints ──────────────────────────

test('a missing or non-string vaultId is rejected the same way every other endpoint rejects it', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const missing = await call('POST', '/v1/paths', {});
		assert.equal(missing.status, 400);
		assert.equal(missing.json.ok, false);
		assert.match(missing.json.error, /vaultId/i);

		const wrongType = await call('POST', '/v1/paths', { vaultId: 42 });
		assert.equal(wrongType.status, 400);
		assert.equal(wrongType.json.ok, false);

		const blank = await call('POST', '/v1/paths', { vaultId: '   ' });
		assert.equal(blank.status, 400);
		assert.equal(blank.json.ok, false);
	});
});
