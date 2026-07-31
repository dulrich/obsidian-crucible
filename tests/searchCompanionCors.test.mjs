// WP-SS1: the companion's CORS support. `src/search/client.ts` moves the interactive search
// request from Obsidian's `requestUrl` (not abortable) onto the platform `fetch`
// (`AbortController`-abortable) — but a headless worker cannot live-verify whether Electron's
// renderer enforces CORS against a loopback `fetch`, so the companion answers defensively:
// every response (success, 4xx, 5xx, and the OPTIONS preflight itself) carries
// `Access-Control-Allow-Origin: *`, which costs nothing because this server binds loopback-only
// (src/search/AGENTS.md) and has no cookie/credential surface a permissive ACAO could leak.
//
// Same rules as the sibling companion test files: the companion exports its pure helpers and
// keeps the server bootstrap behind `isMainModule()`, so importing it opens no database and
// binds no port. The HTTP cases here bind their own ephemeral loopback server; nothing touches
// the live companion on 127.0.0.1:4801.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createRequestHandler, createSchema } from '../scripts/search-companion.mjs';

const VAULT = 'cors-test-vault';

function makeDb() {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	return db;
}

async function withServer(db, fn) {
	const server = createServer(createRequestHandler(db));
	await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		return await fn(base);
	} finally {
		await new Promise(resolveClose => server.close(resolveClose));
	}
}

test('an OPTIONS preflight to /v1/search is answered directly (204, no body) with the CORS headers a POST+JSON request needs', async () => {
	const db = makeDb();
	await withServer(db, async (base) => {
		const response = await fetch(`${base}/v1/search`, {
			method: 'OPTIONS',
			headers: {
				'Access-Control-Request-Method': 'POST',
				'Access-Control-Request-Headers': 'Content-Type',
			},
		});

		assert.equal(response.status, 204);
		assert.equal(response.headers.get('access-control-allow-origin'), '*');
		assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);
		assert.match(response.headers.get('access-control-allow-headers') ?? '', /Content-Type/i);
		const body = await response.text();
		assert.equal(body, '', 'a preflight answer carries no body');
	});
});

// The preflight handler must not be scoped to /v1/search alone — a browser/Electron renderer
// decides whether to preflight per-request, not per-endpoint, and the handler-level placement
// (before route dispatch) is what makes this true for free rather than needing a case per route.
test('OPTIONS is answered the same way for any path, including one with no route at all', async () => {
	const db = makeDb();
	await withServer(db, async (base) => {
		const response = await fetch(`${base}/v1/nope`, { method: 'OPTIONS' });
		assert.equal(response.status, 204);
		assert.equal(response.headers.get('access-control-allow-origin'), '*');
	});
});

test('a normal 200 response still carries Access-Control-Allow-Origin, and its own behavior is unchanged', async () => {
	const db = makeDb();
	await withServer(db, async (base) => {
		const response = await fetch(`${base}/v1/search`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ vaultId: VAULT, query: 'anything' }),
		});

		assert.equal(response.status, 200);
		assert.equal(response.headers.get('access-control-allow-origin'), '*');
		const json = await response.json();
		assert.equal(Array.isArray(json.results), true, 'the search endpoint itself is untouched by the CORS change');
	});
});

test('a 404 (unknown route) and a 400 (bad request body) both still carry the CORS header — an error response is not a second CORS failure on top of its own status', async () => {
	const db = makeDb();
	await withServer(db, async (base) => {
		const notFound = await fetch(`${base}/v1/nope`, { method: 'GET' });
		assert.equal(notFound.status, 404);
		assert.equal(notFound.headers.get('access-control-allow-origin'), '*');

		const badBody = await fetch(`${base}/v1/search`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ vaultId: '' }), // missing required query
		});
		assert.equal(badBody.status, 400);
		assert.equal(badBody.headers.get('access-control-allow-origin'), '*');
	});
});

test('GET /health also carries the CORS header (every route, not just /v1/search)', async () => {
	const db = makeDb();
	await withServer(db, async (base) => {
		const response = await fetch(`${base}/health`);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('access-control-allow-origin'), '*');
	});
});
