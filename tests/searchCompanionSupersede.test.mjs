// WP-SS2: the companion learns client+sequence identity (src/search/client.ts sends `clientId`
// + a monotonic `seq`, only when the caller supplied an AbortSignal — the interactive search
// modal, never the background SearchIndexWorkflow.sweep()) and abandons a superseded or
// already-disconnected search before paying for any SQL. These tests cover the pre-flight
// supersede drop, the disconnect check, backward compatibility for identity-less requests, and
// the holder's bounding.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
	createRequestHandler,
	createSchema,
	createSearchClientTracker,
	createSearchEndpoint,
	createStatements,
	createVectorBackend,
	MAX_SEARCH_CLIENTS,
} from '../scripts/search-companion.mjs';

const VAULT = 'ss2-supersede-vault';

function makeDb() {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	const insertChunk = db.prepare(`
INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`);
	const insertFts = db.prepare('INSERT INTO chunks_fts (id, vault_id, path, title, heading, text) VALUES (?, ?, ?, ?, ?, ?)');
	insertChunk.run('c1', VAULT, 'Alpha.md', 'hash', 'Alpha', '', 'alpha content here', 0, 0, '{}');
	insertFts.run('c1', VAULT, 'Alpha.md', 'Alpha', '', 'alpha content here');
	return db;
}

async function withServer(handlerOptions, fn) {
	const db = makeDb();
	const server = createServer(createRequestHandler(db, handlerOptions));
	await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
	const base = `http://127.0.0.1:${server.address().port}`;
	const post = async body => {
		const response = await fetch(`${base}/v1/search`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		return { status: response.status, json: await response.json() };
	};
	try {
		return await fn(post, db);
	} finally {
		await new Promise(resolveClose => server.close(resolveClose));
	}
}

/* --------------------------------------------------------------------- supersede: wire-level */

test('a superseded interactive request (lower seq, same clientId) is abandoned pre-flight: fast degraded/superseded response, zero SQL run', async () => {
	const db = makeDb();
	const statements = createStatements(db);
	let searchCalls = 0;
	const realSearchStatement = statements.searchStatement;
	// A spy wrapper rather than monkey-patching the native StatementSync instance — cheap,
	// doesn't assume `.all` is an own-writable property, and proves the primary FTS scan itself
	// (not some other codepath) is what did or didn't run.
	const wiredStatements = {
		...statements,
		searchStatement: { all: (...args) => { searchCalls++; return realSearchStatement.all(...args); } },
	};

	await withServer({ statements: wiredStatements }, async post => {
		const newer = await post({ vaultId: VAULT, query: 'alpha', limit: 10, clientId: 'client-a', seq: 2 });
		assert.equal(newer.status, 200);
		assert.equal('superseded' in newer.json, false, 'the newer/highest-seq request must run and answer normally');
		assert.equal(searchCalls, 1);

		const older = await post({ vaultId: VAULT, query: 'alpha', limit: 10, clientId: 'client-a', seq: 1 });
		assert.equal(older.status, 200, 'an abandoned request is still a well-formed 200, never a 4xx/5xx');
		assert.equal(older.json.superseded, true, 'an older seq for the same clientId, arriving after a higher one, is superseded');
		assert.equal(older.json.degraded, true, 'superseded reuses the degraded shape so any caller only checking degraded already treats it as partial/empty');
		assert.deepEqual(older.json.results, []);
		assert.equal(older.json.total, 0);
		assert.equal(older.json.hasMore, false);
		assert.equal(searchCalls, 1, 'the superseded request must never reach the primary FTS scan — the SQL call count must not have advanced');
	});
});

test('equal seq for the same clientId (a duplicate/retried request) is also treated as superseded, not fresh', async () => {
	const db = makeDb();
	const statements = createStatements(db);
	let searchCalls = 0;
	const realSearchStatement = statements.searchStatement;
	const wiredStatements = {
		...statements,
		searchStatement: { all: (...args) => { searchCalls++; return realSearchStatement.all(...args); } },
	};

	await withServer({ statements: wiredStatements }, async post => {
		const first = await post({ vaultId: VAULT, query: 'alpha', limit: 10, clientId: 'client-dup', seq: 5 });
		assert.equal('superseded' in first.json, false);
		assert.equal(searchCalls, 1);

		const duplicate = await post({ vaultId: VAULT, query: 'alpha', limit: 10, clientId: 'client-dup', seq: 5 });
		assert.equal(duplicate.json.superseded, true, 'a non-strictly-higher seq never gets to re-run — only a strictly higher seq clears the client to a fresh high-water mark');
		assert.equal(searchCalls, 1);
	});
});

// Two different clientIds are two independent sequences — a low seq from a client that has
// never been seen before must never read as superseded by an unrelated client's higher seq.
test('supersede tracking is scoped per clientId — a fresh clientId at seq 1 is never superseded by another client\'s higher seq', async () => {
	await withServer({}, async post => {
		const clientOne = await post({ vaultId: VAULT, query: 'alpha', limit: 10, clientId: 'client-1', seq: 99 });
		assert.equal('superseded' in clientOne.json, false);

		const clientTwo = await post({ vaultId: VAULT, query: 'alpha', limit: 10, clientId: 'client-2', seq: 1 });
		assert.equal('superseded' in clientTwo.json, false, 'client-2 has never been seen before — its own seq 1 is its own high-water mark');
	});
});

/* -------------------------------------------------------------- backward compatibility (BC) */

test('a request WITHOUT clientId/seq behaves byte-identically to today: no supersede tracking, no superseded/degraded field', async () => {
	await withServer({}, async post => {
		const first = await post({ vaultId: VAULT, query: 'alpha', limit: 10 });
		assert.equal(first.status, 200);
		assert.equal('superseded' in first.json, false);
		assert.equal('degraded' in first.json, false);
		assert.equal(first.json.results.length, 1);

		// A second identity-less request must not be affected by the first in any way — there is
		// no seq to compare, so nothing is ever superseded on this path, however many requests
		// arrive.
		const second = await post({ vaultId: VAULT, query: 'alpha', limit: 10 });
		assert.equal('superseded' in second.json, false);
		assert.equal(second.json.results.length, 1);
	});
});

// A malformed/partial identity (clientId without seq, or vice versa, or non-numeric seq) must
// degrade to "not tracked" rather than throwing or silently misbehaving — same fail-open
// philosophy as clampSearchBudgetMs for a malformed budgetMs.
test('a malformed identity (clientId without a numeric seq, or seq without a clientId) is never tracked', async () => {
	await withServer({}, async post => {
		const noSeq = await post({ vaultId: VAULT, query: 'alpha', limit: 10, clientId: 'client-partial' });
		assert.equal('superseded' in noSeq.json, false);

		const nonNumericSeq = await post({ vaultId: VAULT, query: 'alpha', limit: 10, clientId: 'client-partial', seq: 'not-a-number' });
		assert.equal('superseded' in nonNumericSeq.json, false);

		const noClientId = await post({ vaultId: VAULT, query: 'alpha', limit: 10, seq: 7 });
		assert.equal('superseded' in noClientId.json, false);
	});
});

/* --------------------------------------------------------------------------- holder bounding */

test('createSearchClientTracker bounds its holder at MAX_SEARCH_CLIENTS, evicting the oldest client first', () => {
	const tracker = createSearchClientTracker();
	for (let i = 0; i < MAX_SEARCH_CLIENTS; i++) {
		assert.equal(tracker.isSuperseded(`client-${i}`, 1), false);
	}
	assert.equal(tracker.size(), MAX_SEARCH_CLIENTS);

	// One more distinct client pushes the holder over its cap — the oldest entry (client-0) must
	// be evicted rather than the holder growing unboundedly.
	assert.equal(tracker.isSuperseded('client-overflow', 1), false);
	assert.equal(tracker.size(), MAX_SEARCH_CLIENTS, 'the holder must not grow past its cap');

	// client-0 was evicted, so it is no longer tracked at all — a request presenting its old seq
	// again reads as a fresh client (seq 1 is its own high-water mark), not as superseded.
	assert.equal(tracker.isSuperseded('client-0', 1), false, 'an evicted client is untracked, exactly like one that was never seen');
});

test('createSearchClientTracker: a superseded (non-advancing) check does not refresh its client\'s eviction priority', () => {
	const tracker = createSearchClientTracker();
	// client-stale is recorded first (oldest), then MAX_SEARCH_CLIENTS - 1 other clients fill the
	// rest of the holder to exactly its cap.
	assert.equal(tracker.isSuperseded('client-stale', 5), false);
	for (let i = 0; i < MAX_SEARCH_CLIENTS - 1; i++) {
		assert.equal(tracker.isSuperseded(`client-fill-${i}`, 1), false);
	}
	assert.equal(tracker.size(), MAX_SEARCH_CLIENTS);

	// A superseded (non-advancing) request for client-stale must not move it to MRU position —
	// it must stay the oldest entry, not be re-inserted.
	assert.equal(tracker.isSuperseded('client-stale', 1), true, 'lower than its own recorded high-water mark (5) — superseded');

	// One more distinct client pushes the holder over its cap. If the superseded check above had
	// refreshed client-stale's position, client-fill-0 (the next-oldest) would be evicted
	// instead; asserting client-stale specifically was evicted is the direct proof it was not
	// refreshed.
	assert.equal(tracker.isSuperseded('client-overflow', 1), false);
	assert.equal(tracker.size(), MAX_SEARCH_CLIENTS);
	assert.equal(tracker.isSuperseded('client-stale', 1), false, 'client-stale was evicted (untouched by the superseded check above), so seq 1 is now its own fresh high-water mark rather than being compared against the old value of 5');
});

/* ------------------------------------------------------------------------------- disconnect */

// Fake req/res stream pair: readJson (scripts/search-companion/http.mjs) only needs
// `setEncoding`/`on('data'|'end'|'error')` off req, and the endpoint only needs `on('close')` /
// `destroyed` off res plus the json() writer's `setHeader`/`writeHead`/`end` off res — no real
// socket required, which is what makes the disconnect race deterministic instead of depending on
// real TCP teardown timing.
function fakeDisconnectedRequest(bodyObj) {
	const req = new EventEmitter();
	req.setEncoding = () => {};
	req.destroyed = false;
	const res = new EventEmitter();
	res.destroyed = false;
	res.setHeader = () => {};
	res.writeHead = () => { throw new Error('must never write a response head to an already-disconnected socket'); };
	res.end = () => { throw new Error('must never end an already-disconnected socket'); };
	// The client disconnects (its 'close' event fires) strictly before the body finishes
	// streaming — the exact ordering an aborted `fetch` produces when the abort lands mid-flight
	// rather than after the body was already fully sent.
	queueMicrotask(() => {
		res.emit('close');
		req.emit('data', JSON.stringify(bodyObj));
		req.emit('end');
	});
	return { req, res };
}

test('a request whose socket has already disconnected is skipped before runSearch — no write, no throw, zero SQL run', async () => {
	const db = makeDb();
	const statements = createStatements(db);
	let searchCalls = 0;
	const realSearchStatement = statements.searchStatement;
	const wiredStatements = {
		...statements,
		searchStatement: { all: (...args) => { searchCalls++; return realSearchStatement.all(...args); } },
	};
	const vectors = createVectorBackend(db);
	const state = { lastInteractiveSearchAt: -Infinity, searchClients: createSearchClientTracker() };
	const endpoint = createSearchEndpoint({ db, statements: wiredStatements, vectors, now: Date.now, state });

	const { req, res } = fakeDisconnectedRequest({ vaultId: VAULT, query: 'alpha', limit: 10 });
	// Must resolve cleanly (no throw, no unhandled rejection) even though `res.writeHead`/`res.end`
	// above throw synchronously if ever called.
	await endpoint(req, res, { receivedAt: Date.now() });

	assert.equal(searchCalls, 0, 'runSearch must never be reached once the socket has disconnected');
});
