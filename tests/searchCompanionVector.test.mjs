// Vector-leg tests for the zero-dependency search companion.
//
// Same rules as the ranking tests: the companion exports its pure helpers and keeps the
// server bootstrap behind `isMainModule()`, so importing it opens no database and binds no
// port. Every case here builds its own in-memory SQLite database, and the HTTP cases bind an
// ephemeral loopback port of their own — nothing ever touches the live companion on
// 127.0.0.1:4801 or the real index behind it.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
	createRequestHandler,
	createSchema,
	createVectorBackend,
	decodeEmbedding,
	encodeEmbedding,
	fuseSearchRows,
	normalizeEmbedding,
	RRF_K,
	runSearch,
} from '../scripts/search-companion.mjs';

const VAULT = 'test-vault';

function makeDb() {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	return db;
}

// Drives the real request handler over a real (ephemeral, loopback) HTTP server, so status
// codes are the ones a client would actually see rather than something a stub decided.
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
		return { status: response.status, json: await response.json() };
	};
	try {
		return await fn(call);
	} finally {
		await new Promise(resolveClose => server.close(resolveClose));
	}
}

function chunk(id, path, text, embedding, extra = {}) {
	return {
		id,
		vaultId: VAULT,
		path,
		contentHash: `hash-${id}`,
		title: extra.title ?? path.replace(/\.md$/, ''),
		heading: extra.heading ?? '',
		text,
		mtime: 0,
		ordinal: extra.ordinal ?? 0,
		metadata: {},
		...(embedding ? { embedding } : {}),
		...(extra.embeddingModel ? { embeddingModel: extra.embeddingModel } : {}),
	};
}

// ── 1. Cosine correctness ────────────────────────────────────────────────────────────────

test('cosine similarity is exactly the hand-computed value (a transposed matrix or a missed normalisation degrades silently, never loudly)', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		// Deliberately un-normalised on the wire: the companion must not trust the client to
		// have normalised, because neither provider client does.
		const upsert = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [
				chunk('a', 'A.md', 'alpha text', [3, 4, 0]),      // |v| = 5
				chunk('b', 'B.md', 'beta text', [0, 0, 2]),       // orthogonal to the query
				chunk('c', 'C.md', 'gamma text', [-3, -4, 0]),    // the exact opposite of A
			],
		});
		assert.equal(upsert.status, 200);
	});

	const backend = createVectorBackend(db);
	const hits = backend.knn(VAULT, [1, 0, 0], 3);
	const byId = new Map(hits.map(hit => [hit.id, hit.score]));
	// cos(query, [3,4,0]) = 3/5 = 0.6 ; cos(query, [0,0,2]) = 0 ; cos(query, [-3,-4,0]) = -0.6.
	assert.ok(Math.abs(byId.get('a') - 0.6) < 1e-6, `expected 0.6, got ${byId.get('a')}`);
	assert.ok(Math.abs(byId.get('b') - 0) < 1e-6, `expected 0, got ${byId.get('b')}`);
	assert.ok(Math.abs(byId.get('c') + 0.6) < 1e-6, `expected -0.6, got ${byId.get('c')}`);
	// Descending, and the ids/paths line up with their rows — a transposed index would still
	// produce plausible-looking numbers, just attached to the wrong documents.
	assert.deepEqual(hits.map(hit => hit.id), ['a', 'b', 'c']);
	assert.deepEqual(hits.map(hit => hit.path), ['A.md', 'B.md', 'C.md']);
	// A query vector is normalised on the way in too, so its magnitude cannot change scores.
	const scaled = backend.knn(VAULT, [17, 0, 0], 1);
	assert.ok(Math.abs(scaled[0].score - 0.6) < 1e-6);
	db.close();
});

test('normalizeEmbedding produces a unit vector and refuses the degenerate cases', () => {
	const unit = normalizeEmbedding([3, 4, 0]);
	assert.ok(Math.abs(Math.hypot(...unit) - 1) < 1e-6);
	assert.throws(() => normalizeEmbedding([0, 0, 0]), /zero vector/);
	assert.throws(() => normalizeEmbedding([1, Number.NaN]), /finite/);
	assert.throws(() => normalizeEmbedding([1, Infinity]), /finite/);
});

// ── 2. The one test a pool-reranking implementation fails ────────────────────────────────

test('the vector scan covers the FULL matrix, not the FTS candidate pool: a chunk with zero keyword overlap still surfaces', async () => {
	const db = makeDb();
	// "Sustained attention" vs "focused awareness": no shared term, near-identical vector.
	// Reranking FTS candidates could never return this row, because it is not an FTS
	// candidate at all — which is the entire reason the vector leg exists.
	await withServer(db, async call => {
		const upsert = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [
				chunk('kw', 'Keyword.md', 'sustained attention practice notes', [1, 0, 0]),
				chunk('sem', 'Semantic.md', 'gardening lawnmower rhubarb entirely unrelated prose', [0.99, 0.14, 0]),
				chunk('noise', 'Noise.md', 'sustained attention appears here too', [0, 0, 1]),
			],
		});
		assert.equal(upsert.status, 200);

		const response = await call('POST', '/v1/search', {
			vaultId: VAULT,
			query: 'sustained attention',
			limit: 10,
			queryEmbedding: [1, 0, 0],
		});
		assert.equal(response.status, 200);
		const paths = response.json.results.map(row => row.path);
		assert.ok(
			paths.includes('Semantic.md'),
			`a zero-keyword-overlap chunk must be reachable by vector alone; got ${JSON.stringify(paths)}`,
		);
		// It is a genuine vector hit: scored, ranked in the vector list, and absent from the
		// text list entirely.
		const semantic = response.json.results.find(row => row.path === 'Semantic.md');
		assert.ok(semantic.scoreVector > 0.98);
		assert.equal(semantic.attribution.textRank, null, 'it never matched the query text');
		// Rank 2 in the vector list: Keyword.md is the exact vector match (cosine 1.0) and
		// takes rank 1. What matters is that a row with no keyword overlap is *in* the list.
		assert.equal(semantic.attribution.vectorRank, 2);
		assert.ok(semantic.snippet.length > 0, 'a vector-only row still needs a snippet, or the client drops it');
		assert.equal(response.json.mode, 'hybrid');
		assert.equal(response.json.semanticAvailable, true);
		// `total` counts it too, so "N more" does not under-report the vector-only paths.
		assert.equal(response.json.total, 3);

		// And with a query that matches no text at all, the vector leg still answers.
		const semanticOnly = await call('POST', '/v1/search', {
			vaultId: VAULT,
			query: 'zzzznothingmatchesthis',
			limit: 10,
			queryEmbedding: [1, 0, 0],
		});
		assert.equal(semanticOnly.status, 200);
		assert.deepEqual(semanticOnly.json.results.map(row => row.path), ['Keyword.md', 'Semantic.md', 'Noise.md']);
		assert.equal(semanticOnly.json.mode, 'hybrid');
	});
	db.close();
});

// ── 3. Dimension conflict is a 4xx, specifically not a 5xx ───────────────────────────────

test('a width conflict inside one vault is rejected with 4xx — never 5xx, which the client reads as "the container is down"', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const first = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [chunk('a', 'A.md', 'alpha', [1, 0, 0, 0])],
		});
		assert.equal(first.status, 200);

		const conflict = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [chunk('b', 'B.md', 'beta', [0, 1, 0])],
		});
		// The status code is the assertion, not an implementation detail:
		// SearchServiceClient maps every 5xx to SearchServiceUnavailableError, which the UI
		// renders as "the companion is not reachable — start it with home-compose up
		// crucible-search". Answering a bad *request* that way would send the user off to
		// restart a perfectly healthy container, so this must be a 4xx.
		assert.equal(conflict.status, 400);
		assert.notEqual(conflict.status, 500);
		assert.match(conflict.json.error, /dimension/i);

		// Rejected atomically: the conflicting batch left nothing behind.
		const rows = db.prepare('SELECT COUNT(*) AS count FROM chunks WHERE vault_id = ?').get(VAULT);
		assert.equal(Number(rows.count), 1);

		// Mixed widths inside a single batch are the same class of error, same status.
		const mixedBatch = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [chunk('c', 'C.md', 'gamma', [1, 0, 0, 0]), chunk('d', 'D.md', 'delta', [1, 0])],
		});
		assert.equal(mixedBatch.status, 400);

		// So is a vector that is not a finite-numeric array.
		for (const bad of [[1, 'x', 0, 0], [1, null, 0, 0], [0, 0, 0, 0], [], 'not-an-array']) {
			const rejected = await call('POST', '/v1/chunks/upsert', {
				vaultId: VAULT,
				chunks: [chunk('e', 'E.md', 'epsilon', bad)],
			});
			assert.equal(rejected.status, 400, `expected 4xx for ${JSON.stringify(bad)}`);
		}

		// A *different* vault is a different vector space and is none of this vault's business.
		const otherVault = await call('POST', '/v1/chunks/upsert', {
			vaultId: 'other-vault',
			chunks: [{ ...chunk('f', 'F.md', 'zeta', [0, 1, 0]), vaultId: 'other-vault' }],
		});
		assert.equal(otherVault.status, 200);
	});
	db.close();
});

test('re-embedding every path in a vault at a new width is allowed; leaving one path behind is not', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks: [chunk('a', 'A.md', 'alpha', [1, 0, 0, 0])] });
		// One path, fully replaced: nothing survives at the old width, so nothing can mix.
		const replaced = await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks: [chunk('a', 'A.md', 'alpha', [1, 0])] });
		assert.equal(replaced.status, 200);
		const state = db.prepare('SELECT embedding_dim AS dim FROM chunks WHERE id = ?').get('a');
		assert.equal(Number(state.dim), 2);
	});
	db.close();
});

// ── 4. Absence degrades, never fails ─────────────────────────────────────────────────────

test('vector absence degrades, never fails: no embeddings and no queryEmbedding both return mode "fts" with the pre-vector ordering', async () => {
	const db = makeDb();
	const embedded = makeDb();
	await withServer(db, async call => {
		// A vault with no embeddings at all.
		await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [
				chunk('a', 'Widget Handbook.md', 'a guide to assembling things in general', null, { title: 'Widget Handbook' }),
				chunk('b', 'Daily.md', 'the widget came up again, widget widget widget everywhere', null, { title: 'Daily log' }),
			],
		});
		const plain = await call('POST', '/v1/search', { vaultId: VAULT, query: 'widget', limit: 10 });
		assert.equal(plain.status, 200);
		assert.equal(plain.json.mode, 'fts');
		assert.equal(plain.json.semanticAvailable, false);
		assert.deepEqual(plain.json.results.map(row => row.path), ['Widget Handbook.md', 'Daily.md']);
		// No vector list ran, so no result carries a vector score or rank — an FTS-only
		// payload is byte-for-byte what it was before the vector leg existed.
		for (const row of plain.json.results) {
			assert.equal(Object.prototype.hasOwnProperty.call(row, 'scoreVector'), false);
			assert.equal(row.attribution.vectorRank, null);
		}
		// Sending a query embedding against a vault with no vectors changes nothing.
		const unusable = await call('POST', '/v1/search', { vaultId: VAULT, query: 'widget', limit: 10, queryEmbedding: [1, 0, 0] });
		assert.equal(unusable.json.mode, 'fts');
		assert.equal(unusable.json.semanticAvailable, false);
		assert.deepEqual(unusable.json.results, plain.json.results);
	});

	await withServer(embedded, async call => {
		// A vault that *does* have vectors, searched without a query embedding: identical
		// ordering to the FTS-only vault, and still mode 'fts'.
		await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [
				chunk('a', 'Widget Handbook.md', 'a guide to assembling things in general', [1, 0, 0], { title: 'Widget Handbook' }),
				chunk('b', 'Daily.md', 'the widget came up again, widget widget widget everywhere', [0, 1, 0], { title: 'Daily log' }),
			],
		});
		const noQueryVector = await call('POST', '/v1/search', { vaultId: VAULT, query: 'widget', limit: 10 });
		assert.equal(noQueryVector.json.mode, 'fts');
		// Honest flag: this vault *could* answer semantically, it just was not asked to.
		assert.equal(noQueryVector.json.semanticAvailable, true);
		assert.deepEqual(noQueryVector.json.results.map(row => row.path), ['Widget Handbook.md', 'Daily.md']);
		for (const row of noQueryVector.json.results) {
			assert.equal(Object.prototype.hasOwnProperty.call(row, 'scoreVector'), false);
		}

		// A query embedding of the wrong width does not fail the search and does not score
		// across two vector spaces either — it degrades to FTS and says so.
		const mismatched = await call('POST', '/v1/search', { vaultId: VAULT, query: 'widget', limit: 10, queryEmbedding: [1, 0, 0, 0] });
		assert.equal(mismatched.status, 200);
		assert.equal(mismatched.json.mode, 'fts');
		assert.match(mismatched.json.message, /dimensional/);
		assert.deepEqual(mismatched.json.results.map(row => row.path), noQueryVector.json.results.map(row => row.path));
	});
	db.close();
	embedded.close();
});

test('/health reports the real dimension, model and backend instead of a hardcoded false', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const empty = await call('GET', '/health');
		assert.equal(empty.json.vectorAvailable, false);
		assert.equal(empty.json.schemaVersion, 3);
		assert.equal(empty.json.embeddingDim, null);

		await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			embeddingModel: 'ollama/bge-m3',
			chunks: [chunk('a', 'A.md', 'alpha', [1, 0, 0, 0])],
		});
		const filled = await call('GET', '/health');
		assert.equal(filled.json.vectorAvailable, true);
		assert.equal(filled.json.embeddingDim, 4);
		assert.equal(filled.json.embeddingModel, 'ollama/bge-m3');
		assert.equal(filled.json.embeddedChunks, 1);
		assert.equal(filled.json.vectorBackend, 'brute-force-js');

		// Deleting the only embedded path takes the capability back down — the flags track
		// state, they are not latched.
		await call('POST', '/v1/chunks/delete', { vaultId: VAULT, paths: ['A.md'] });
		const cleared = await call('GET', '/health');
		assert.equal(cleared.json.vectorAvailable, false);
	});
	db.close();
});

// ── 5. BLOB round-trip ───────────────────────────────────────────────────────────────────

test('an embedding BLOB round-trips bit-identically, including a negative and a denormal', () => {
	const values = Float32Array.from([
		0,
		1,
		-1,
		-0.5,
		3.4028235e38,        // float32 max
		1.401298464324817e-45, // smallest positive denormal float32
		-1.401298464324817e-45,
		1.1754944e-38,       // smallest positive normal float32
		0.1,
	]);
	const bytes = encodeEmbedding(values);
	assert.equal(bytes.length, values.length * 4);
	const back = decodeEmbedding(bytes);
	assert.equal(back.length, values.length);
	for (let i = 0; i < values.length; i++) {
		assert.ok(Object.is(back[i], values[i]), `index ${i}: ${back[i]} !== ${values[i]}`);
	}

	// …and the same holds after a trip through SQLite as a real BLOB column, which is the
	// only path that matters in production.
	const db = makeDb();
	db.prepare(`INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run('a', VAULT, 'A.md', 'hash', 'A', '', 'text', 0, 0, '{}', bytes, values.length, 'test-model');
	const stored = db.prepare('SELECT embedding FROM chunks WHERE id = ?').get('a').embedding;
	const restored = decodeEmbedding(stored);
	for (let i = 0; i < values.length; i++) {
		assert.ok(Object.is(restored[i], values[i]), `sqlite index ${i}: ${restored[i]} !== ${values[i]}`);
	}
	db.close();
});

// ── RRF, invalidation, and the seam itself ───────────────────────────────────────────────

test('three-list RRF fusion matches hand-computed 1/(k+r) arithmetic', () => {
	const rows = [
		{ id: 'a', path: 'Text.md', title: 'Unrelated body note', score_text: -9, pooled_chunks: 1 },
		{ id: 'b', path: 'Other.md', title: 'Also unrelated', score_text: -8, pooled_chunks: 1 },
	];
	const vectorRows = [{ id: 'c', path: 'Vector.md', title: 'Vector only', snippet: 'x', score_text: null, pooled_chunks: 1 }];
	const vectorScores = new Map([['Vector.md', 0.99], ['Other.md', 0.42]]);
	const fused = fuseSearchRows(rows, { terms: ['nothing'], limit: 5, vectorScores, vectorRows });

	const k = RRF_K;
	const expected = new Map([
		// text rank 1, no vector rank
		['Text.md', 1 / (k + 1)],
		// text rank 2 + vector rank 2
		['Other.md', 1 / (k + 2) + 1 / (k + 2)],
		// vector rank 1 only — no text rank at all, and it contributes nothing from that list
		['Vector.md', 1 / (k + 1)],
	]);
	for (const row of fused) {
		assert.ok(Math.abs(row.score - expected.get(row.path)) < 1e-12, `${row.path}: ${row.score} !== ${expected.get(row.path)}`);
		assert.equal(row.scoreRrf, row.score);
	}
	// Other.md appears in two lists and therefore outranks both single-list leaders — the
	// whole point of fusing ranks rather than blending incommensurable scores.
	assert.equal(fused[0].path, 'Other.md');
	assert.equal(fused[0].attribution.vectorRank, 2);
	assert.equal(fused[0].scoreVector, 0.42);
	const vectorOnly = fused.find(row => row.path === 'Vector.md');
	assert.equal(vectorOnly.attribution.textRank, null);
	assert.equal(vectorOnly.attribution.vectorRank, 1);
	assert.equal(vectorOnly.scoreVector, 0.99);
	// Ties between a text-only and a vector-only entry break toward the bm25 list.
	assert.deepEqual(fused.map(row => row.path), ['Other.md', 'Text.md', 'Vector.md']);
});

test('the in-memory matrix is dropped on every write that touches the vault', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks: [chunk('a', 'A.md', 'alpha', [1, 0, 0])] });
		const first = await call('POST', '/v1/search', { vaultId: VAULT, query: 'alpha', limit: 10, queryEmbedding: [1, 0, 0] });
		assert.equal(first.json.results.length, 1);

		// A second path added after the matrix was built must be visible immediately, or a
		// live index silently answers from a stale snapshot.
		await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks: [chunk('b', 'B.md', 'beta', [1, 0, 0])] });
		const second = await call('POST', '/v1/search', { vaultId: VAULT, query: 'zzzznomatch', limit: 10, queryEmbedding: [1, 0, 0] });
		assert.deepEqual(second.json.results.map(row => row.path).sort(), ['A.md', 'B.md']);

		await call('POST', '/v1/chunks/delete', { vaultId: VAULT, paths: ['B.md'] });
		const afterDelete = await call('POST', '/v1/search', { vaultId: VAULT, query: 'zzzznomatch', limit: 10, queryEmbedding: [1, 0, 0] });
		assert.deepEqual(afterDelete.json.results.map(row => row.path), ['A.md']);

		await call('POST', '/v1/index/reset', { vaultId: VAULT });
		const afterReset = await call('POST', '/v1/search', { vaultId: VAULT, query: 'zzzznomatch', limit: 10, queryEmbedding: [1, 0, 0] });
		assert.deepEqual(afterReset.json.results, []);
		assert.equal(afterReset.json.mode, 'fts');
		assert.equal(afterReset.json.semanticAvailable, false);
	});
	db.close();
});

test('the vector backend is a swappable seam: the search path talks to a stand-in with no knowledge of the matrix', async () => {
	const db = makeDb();
	// A backend that is not a matrix, not a scan, and not even backed by the stored vectors.
	// If the search handler ever reaches around the seam, this test stops working.
	const calls = [];
	const stub = {
		name: 'stub-backend',
		stats() { return { count: 2, dim: 3, model: 'stub-model' }; },
		invalidate(vaultId) { calls.push(`invalidate:${vaultId}`); },
		knn(vaultId, queryVector, k) {
			calls.push(`knn:${vaultId}:${queryVector.length}:${k}`);
			return [{ id: 'ghost', path: 'Ghost.md', score: 0.77 }];
		},
	};
	db.prepare(`INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`)
		.run('ghost', VAULT, 'Ghost.md', 'hash', 'Ghost', '', 'a note the FTS query will never match', 0, 0, '{}');

	const server = createServer(createRequestHandler(db, { vectors: stub }));
	await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
	try {
		const base = `http://127.0.0.1:${server.address().port}`;
		const response = await fetch(`${base}/v1/search`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ vaultId: VAULT, query: 'zzzznomatch', limit: 10, queryEmbedding: [1, 2, 3] }),
		});
		const body = await response.json();
		assert.deepEqual(body.results.map(row => row.path), ['Ghost.md']);
		assert.equal(body.results[0].scoreVector, 0.77);
		assert.equal(body.mode, 'hybrid');
		assert.ok(calls.some(entry => entry.startsWith('knn:')), 'the handler must reach the backend only through knn()');

		const health = await (await fetch(`${base}/health`)).json();
		assert.equal(health.vectorBackend, 'stub-backend');
		assert.equal(health.embeddingModel, 'stub-model');
	} finally {
		await new Promise(resolveClose => server.close(resolveClose));
	}
	db.close();
});

test('runSearch without a backend is the pre-vector code path, unchanged', () => {
	const db = makeDb();
	db.prepare(`INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`)
		.run('a', VAULT, 'A.md', 'hash', 'A', '', 'needle in a haystack', 0, 0, '{}');
	db.prepare('INSERT INTO chunks_fts (id, vault_id, path, title, heading, text) VALUES (?, ?, ?, ?, ?, ?)')
		.run('a', VAULT, 'A.md', 'A', '', 'needle in a haystack');
	// No `vectors` option at all: nothing may throw, and the outcome must report itself as
	// FTS-only rather than guessing.
	const outcome = runSearch(db, { vaultId: VAULT, query: 'needle', limit: 10, queryEmbedding: [1, 0, 0] });
	assert.deepEqual(outcome.results.map(row => row.path), ['A.md']);
	assert.equal(outcome.vectorUsed, false);
	assert.equal(outcome.semanticAvailable, false);
	assert.equal(outcome.note, null);
	db.close();
});
