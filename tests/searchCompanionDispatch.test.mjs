// WP-rem-R3 (tn-review remediation, finding F3) companion-side coverage for the one seam the
// decomposition actually created: the explicit method/path dispatcher that replaced the serial
// `if (req.method === 'POST' && url.pathname === …)` ladder inside the old 473-line handler.
//
// A route ladder is not testable except through its endpoints; a table is. These tests pin the
// three properties that made the swap behavior-preserving, because each is a way the table
// could silently diverge from the ladder later:
//
//   1. The table names exactly the six live endpoints — no route added, none dropped, and a
//      typo'd key is a construction-time throw rather than a live endpoint that 404s.
//   2. Matching is exact `METHOD path` equality: wrong method, trailing slash and prefix all
//      miss, and a miss is 404 (not 405, not a redirect) — the ladder's fall-through answer.
//   3. Every declared route is genuinely wired through the real handler.
//
// Property 3 runs the real `createRequestHandler` against an in-memory database over a real
// ephemeral loopback server, per the sibling companion suites — the point being that a route
// map that type-checks but is not connected still fails here. Nothing touches the live
// companion on 127.0.0.1:4801.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
	createDispatcher,
	createRequestHandler,
	createSchema,
	ROUTE_IDS,
	routeId,
} from '../scripts/search-companion.mjs';

const VAULT = 'dispatch-test-vault';

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
			redirect: 'manual',
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

// ── 1. The table is the whole route surface ─────────────────────────────────────────────────

test('the route table names exactly the six live endpoints, in one enumerable place', () => {
	assert.deepEqual([...ROUTE_IDS], [
		'GET /health',
		'POST /v1/index/reset',
		'POST /v1/chunks/delete',
		'POST /v1/files/state',
		'POST /v1/chunks/upsert',
		'POST /v1/search',
	]);
	// Frozen: a caller cannot mutate the canonical list out from under the dispatcher.
	assert.equal(Object.isFrozen(ROUTE_IDS), true);
});

test('a route table missing an id, or carrying an unknown one, throws at construction', () => {
	const noop = () => {};
	const full = Object.fromEntries(ROUTE_IDS.map(id => [id, noop]));

	const missingOne = { ...full };
	delete missingOne['POST /v1/search'];
	assert.throws(() => createDispatcher(missingOne), /missing: \[POST \/v1\/search\]/);

	// The failure this guards against in practice: a typo'd key. It is simultaneously a
	// missing id and an unknown one, and either half is enough to fail — the alternative is a
	// live endpoint that answers 404 with nothing anywhere reporting a problem.
	assert.throws(
		() => createDispatcher({ ...missingOne, 'POST /v1/serach': noop }),
		/unknown: \[POST \/v1\/serach\]/,
	);
});

// ── 2. Exact (method, path) equality, and a miss is 404 ─────────────────────────────────────

test('lookup is exact METHOD+path equality: wrong method, trailing slash and prefix all miss', () => {
	const marker = Symbol('route');
	const dispatch = createDispatcher(Object.fromEntries(ROUTE_IDS.map(id => [id, marker])));

	assert.equal(dispatch.lookup('POST', '/v1/search'), marker);
	assert.equal(dispatch.lookup('GET', '/health'), marker);

	// Wrong method on a known path: a miss, which the handler turns into 404 rather than 405.
	assert.equal(dispatch.lookup('GET', '/v1/search'), null);
	assert.equal(dispatch.lookup('POST', '/health'), null);
	// No trailing-slash tolerance, no prefix matching, no params.
	assert.equal(dispatch.lookup('POST', '/v1/search/'), null);
	assert.equal(dispatch.lookup('POST', '/v1/search/extra'), null);
	assert.equal(dispatch.lookup('POST', '/v1'), null);
	// A request with no method at all (req.method undefined) misses rather than throwing.
	assert.equal(dispatch.lookup(undefined, '/health'), null);

	assert.equal(routeId('POST', '/v1/search'), 'POST /v1/search');
});

test('through the real handler, an unknown path and a wrong-method known path are both 404', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const unknown = await call('GET', '/v1/nope');
		assert.equal(unknown.status, 404);
		assert.deepEqual(unknown.json, { ok: false, error: 'not found' });

		// The ladder answered a POST-only path reached with GET by falling through to its final
		// 404; the table preserves that exactly, rather than promoting it to a 405.
		const wrongMethod = await call('GET', '/v1/search');
		assert.equal(wrongMethod.status, 404);
		assert.deepEqual(wrongMethod.json, { ok: false, error: 'not found' });

		const trailingSlash = await call('GET', '/health/');
		assert.equal(trailingSlash.status, 404);
	});
});

// ── 3. Every declared route is actually wired ───────────────────────────────────────────────

test('every route in the table is reachable through the real handler against a real database', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		// One minimal well-formed request per route id. The assertion is deliberately only
		// "not 404": what is under test is that the table entry resolves to a live handler, not
		// each endpoint's semantics (its own suite owns those).
		const requests = {
			'GET /health': ['GET', '/health', undefined],
			'POST /v1/index/reset': ['POST', '/v1/index/reset', { vaultId: VAULT }],
			'POST /v1/chunks/delete': ['POST', '/v1/chunks/delete', { vaultId: VAULT, paths: [] }],
			'POST /v1/files/state': ['POST', '/v1/files/state', { vaultId: VAULT, paths: [] }],
			'POST /v1/chunks/upsert': ['POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks: [] }],
			'POST /v1/search': ['POST', '/v1/search', { vaultId: VAULT, query: 'anything' }],
		};
		assert.deepEqual(Object.keys(requests).sort(), [...ROUTE_IDS].sort(), 'every route id is exercised');

		for (const id of ROUTE_IDS) {
			const [method, path, body] = requests[id];
			const result = await call(method, path, body);
			assert.notEqual(result.status, 404, `${id} resolved to a live handler`);
			assert.equal(result.status, 200, `${id} answered 200`);
		}

		// `/v1/search` is the one route whose success payload carries no `ok` flag — it answers
		// with the result shape directly — so its "this is really the search endpoint, not some
		// other handler that happens to 200" check reads that shape instead.
		const search = await call(...requests['POST /v1/search']);
		assert.equal(Array.isArray(search.json.results), true);
		assert.equal(search.json.mode, 'fts');
	});
});
