// WP-5: the companion-side cooperative deadline on POST /v1/search.
//
// The companion is single-threaded with a synchronous DatabaseSync, so it cannot preempt a
// running SQL statement — the deadline is checked BETWEEN statements/scans (runSearch's
// checkpoints), never inside one. These tests exercise `runSearch` directly (the same pattern
// as tests/searchCompanionRanking.test.mjs) with an injected `now`/`deadlineAt`, which is the
// seam the production handler also uses (computed from the client's `budgetMs`, clamped via
// `clampSearchBudgetMs`).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
	buildFtsQuery,
	clampSearchBudgetMs,
	createRequestHandler,
	createSchema,
	createVectorBackend,
	runSearch,
} from '../scripts/search-companion.mjs';

const VAULT = 'test-vault';

const backends = new WeakMap();
function vectorsFor(db) {
	let backend = backends.get(db);
	if (!backend) {
		backend = createVectorBackend(db);
		backends.set(db, backend);
	}
	return backend;
}

function makeDb(rows) {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	const insertChunk = db.prepare(`
INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`);
	const insertFts = db.prepare('INSERT INTO chunks_fts (id, vault_id, path, title, heading, text) VALUES (?, ?, ?, ?, ?, ?)');
	rows.forEach((row, index) => {
		const id = row.id ?? `chunk-${index}`;
		const title = row.title ?? row.path;
		const heading = row.heading ?? '';
		insertChunk.run(id, VAULT, row.path, 'hash', title, heading, row.text, 0, index, JSON.stringify(row.metadata ?? {}));
		insertFts.run(id, VAULT, row.path, title, heading, row.text);
	});
	return db;
}

test('clampSearchBudgetMs falls back to the default for a non-finite value and clamps to [500, 20000]', () => {
	assert.equal(clampSearchBudgetMs(undefined), 3200);
	assert.equal(clampSearchBudgetMs(NaN), 3200);
	assert.equal(clampSearchBudgetMs('not a number'), 3200);
	assert.equal(clampSearchBudgetMs(0), 500);
	assert.equal(clampSearchBudgetMs(-100), 500);
	assert.equal(clampSearchBudgetMs(999_999), 20_000);
	assert.equal(clampSearchBudgetMs(5000), 5000);
});

test('omitting deadlineAt (every pre-WP-5 call site) never degrades: the rescue still runs to completion', () => {
	const db = makeDb([
		{ path: 'Alpha.md', title: 'Alpha', text: 'alpha stands alone' },
		{ path: 'Beta.md', title: 'Beta', text: 'beta stands alone' },
	]);
	const outcome = runSearch(db, { vaultId: VAULT, query: 'alpha beta', limit: 10, vectors: vectorsFor(db) });
	assert.equal(outcome.degraded, false);
	assert.equal(outcome.fallbackUsed, true);
	assert.equal(outcome.results.length, 2);
});

test('over budget before the zero-hit rescue: the rescue is skipped and the response is marked degraded', () => {
	const db = makeDb([
		{ path: 'Alpha.md', title: 'Alpha', text: 'alpha stands alone' },
		{ path: 'Beta.md', title: 'Beta', text: 'beta stands alone' },
	]);
	// deadlineAt: 0 is always in the past against the real Date.now() default clock, so this
	// forces every checkpoint over budget without needing a fake `now`.
	const outcome = runSearch(db, { vaultId: VAULT, query: 'alpha beta', limit: 10, vectors: vectorsFor(db), deadlineAt: 0 });
	assert.equal(outcome.degraded, true);
	assert.equal(outcome.fallbackUsed, false, 'the rescue must not run once the deadline has already passed');
	assert.equal(outcome.match, buildFtsQuery('alpha beta').primary, 'match stays the (unrun) strict-AND primary, never the skipped loose-OR fallback');
	assert.equal(outcome.results.length, 0, 'whatever the strict-AND primary produced (nothing) is returned as-is, not blocked on for the rescue');
});

test('a request that finishes inside budget is byte-identical to one with no deadline at all', () => {
	const db = makeDb([
		{ path: 'Alpha.md', title: 'Alpha', text: 'alpha stands alone' },
		{ path: 'Beta.md', title: 'Beta', text: 'beta stands alone' },
	]);
	const noDeadline = runSearch(db, { vaultId: VAULT, query: 'alpha beta', limit: 10, vectors: vectorsFor(db) });
	const generousDeadline = runSearch(db, { vaultId: VAULT, query: 'alpha beta', limit: 10, vectors: vectorsFor(db), deadlineAt: Date.now() + 60_000 });
	assert.equal(generousDeadline.degraded, false);
	assert.equal(JSON.stringify(generousDeadline.results), JSON.stringify(noDeadline.results));
	assert.equal(generousDeadline.fallbackUsed, noDeadline.fallbackUsed);
	assert.equal(generousDeadline.total, noDeadline.total);
});

test('vector leg is skipped once the deadline has already passed, degrading gracefully to the FTS results already in hand', () => {
	const db = makeDb([{ path: 'Alpha.md', title: 'Alpha', text: 'alpha content here' }]);
	const outcome = runSearch(db, { vaultId: VAULT, query: 'alpha', limit: 10, vectors: vectorsFor(db), deadlineAt: 0 });
	assert.equal(outcome.degraded, true);
	assert.equal(outcome.vectorUsed, false);
	assert.equal(outcome.results.length, 1, 'the primary FTS match still returns in full — only the (never-populated, in this fixture) vector leg is skipped');
});

// The split-terms fixture from searchCompanionRanking.test.mjs: coverage is the leg that
// rescues a document whose terms are present but scattered across its own chunks, and it never
// runs unless a strict-AND decoy is also in play (otherwise the primary already returns rows and
// there's nothing to demonstrate about a *partial* coverage scan).
function makeSplitTermsDb() {
	return makeDb([
		{ id: 't1', path: 'Target.md', title: 'Killing the bloat', heading: 'Intro', text: 'matt pocock walks through the whole approach here' },
		{ id: 't2', path: 'Target.md', title: 'Killing the bloat', heading: 'Measure', text: 'measure the context window, then prune the skills you never load' },
		{ id: 'd1', path: 'Decoy.md', title: 'Unrelated roundup', heading: 'Links', text: 'matt pocock context skills all name-dropped in one throwaway paragraph' },
	]);
}

test('coverage leg: a checkpoint BETWEEN term scans stops scanning further terms, degrading rather than rescuing the split-terms target', () => {
	const db = makeSplitTermsDb();
	// The query tokenizes to 4 terms: matt, pocock, context, skills. Decoy.md matches every term
	// in one chunk, so the strict-AND primary already returns a row — the rescue/vector
	// checkpoints are never even reached as "over budget" (rows.length !== 0, no vectors indexed).
	// `now` is under budget for the first coverage-leg term scan and over budget starting with
	// the second, so exactly one of the four terms is ever scanned.
	let calls = 0;
	const deadlineAt = 1000;
	const now = () => { calls++; return calls <= 1 ? 0 : 2000; };
	const outcome = runSearch(db, {
		vaultId: VAULT,
		query: 'matt pocock context skills',
		limit: 10,
		rankingMode: 'coverage',
		vectors: vectorsFor(db),
		now,
		deadlineAt,
	});
	assert.equal(outcome.degraded, true);
	// Only ONE term ('matt') was scanned before the checkpoint broke the loop, so no path can
	// reach COVERAGE_MIN_TERMS (2) — the coverage leg contributes nothing this round, and the
	// split-terms rescue it exists for does not fire. This is the direct, observable effect of
	// the checkpoint actually stopping mid-scan rather than only gating entry to the leg.
	assert.equal(outcome.coverageUsed, false);
	assert.deepEqual(outcome.results.map(row => row.path), ['Decoy.md']);
	assert.equal(calls >= 2, true, 'the checkpoint must have been consulted more than once (i.e. actually mid-loop, not only once on entry)');
});

test('coverage leg: with a deadline that never expires, the split-terms target is still rescued exactly as before', () => {
	const db = makeSplitTermsDb();
	const outcome = runSearch(db, {
		vaultId: VAULT,
		query: 'matt pocock context skills',
		limit: 10,
		rankingMode: 'coverage',
		vectors: vectorsFor(db),
		deadlineAt: Date.now() + 60_000,
	});
	assert.equal(outcome.degraded, false);
	assert.equal(outcome.coverageUsed, true);
	assert.ok(outcome.results.map(row => row.path).includes('Target.md'), 'the split-terms target is reachable when the coverage leg runs to completion');
});

// Wire-level contract: a request that finishes inside budget must be byte-for-byte the same
// response shape as before WP-5 — no `degraded` key at all, not `degraded: false`. This is what
// makes the change safe for every existing client (the field's absence is what
// normalizeSearchResponse treats as "not degraded"). Real HTTP server, matching
// tests/searchCompanionRanking.test.mjs's withSearchServer pattern, so this also proves
// `body.budgetMs` is accepted on the wire without breaking anything.
test('POST /v1/search: an in-budget response carries no degraded key at all', async () => {
	const db = makeDb([{ path: 'Note.md', title: 'Note', text: 'ordinary needle content' }]);
	await withSearchServer(db, async post => {
		const response = await post({ vaultId: VAULT, query: 'needle', limit: 10, budgetMs: 60_000 });
		assert.equal(response.status, 200);
		assert.equal('degraded' in response.json, false);
	});
});

async function withSearchServer(db, fn) {
	const server = createServer(createRequestHandler(db));
	await new Promise(listening => server.listen(0, '127.0.0.1', listening));
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
		return await fn(post);
	} finally {
		await new Promise(closed => server.close(closed));
	}
}
