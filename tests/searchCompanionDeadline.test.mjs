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
	resolveSearchDeadlineStart,
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

// WP-3: resolveSearchDeadlineStart is the pure skew-guard helper behind the /v1/search request
// handler's deadline computation — see the module comment above its definition in
// scripts/search-companion.mjs for the full rationale.
//
// WP-SS2 widened the past-direction trust window from one budget to K=5 budgets (see the
// module comment above resolveSearchDeadlineStart) — a queue delay larger than one budget used
// to make the guard distrust sentAt and restart the deadline from receivedAt, which granted a
// full fresh budget to exactly the requests that had been queued/abandoned longest. These tests
// pin the K=5 boundary in both directions.
test('resolveSearchDeadlineStart honors a sentAt within [receivedAt - budget, receivedAt]', () => {
	const receivedAt = 10_000;
	const budgetMs = 3200;
	assert.equal(resolveSearchDeadlineStart(receivedAt - 500, receivedAt, budgetMs), receivedAt - 500, 'a sentAt comfortably inside the window is used as-is, starting the deadline earlier than receipt');
	assert.equal(resolveSearchDeadlineStart(receivedAt - budgetMs, receivedAt, budgetMs), receivedAt - budgetMs, 'the lower boundary of a single budget is inclusive');
	assert.equal(resolveSearchDeadlineStart(receivedAt, receivedAt, budgetMs), receivedAt, 'the upper boundary (no delay at all) is inclusive');
});

// WP-SS2 (a): a sentAt reporting 2 budgets' worth of queuing delay is now trusted (K=5), where
// before this change it would have fallen back to receivedAt and granted a fresh budget.
test('resolveSearchDeadlineStart (WP-SS2): a sentAt several budgets old but within K=5 is still trusted', () => {
	const receivedAt = 10_000;
	const budgetMs = 3200;
	assert.equal(resolveSearchDeadlineStart(receivedAt - 2 * budgetMs, receivedAt, budgetMs), receivedAt - 2 * budgetMs, 'two budgets of queuing delay is plausible queuing evidence, not skew, and must be honored');
	assert.equal(resolveSearchDeadlineStart(receivedAt - 5 * budgetMs, receivedAt, budgetMs), receivedAt - 5 * budgetMs, 'the K=5 lower boundary is inclusive, same as the single-budget boundary above');
});

// WP-SS2 (b): older than K budgets is still untrustworthy skew, not queuing evidence — the
// widening has a floor, it did not remove the guard.
test('resolveSearchDeadlineStart falls back to receivedAt for skew outside the K=5-budget window', () => {
	const receivedAt = 10_000;
	const budgetMs = 3200;
	assert.equal(resolveSearchDeadlineStart(receivedAt - 5 * budgetMs - 1, receivedAt, budgetMs), receivedAt, 'more than K=5 budgets into the past is untrustworthy skew, not queuing evidence');
	assert.equal(resolveSearchDeadlineStart(receivedAt - budgetMs - 1, receivedAt, budgetMs), receivedAt - budgetMs - 1, 'sanity check: this same instant used to fall back under the old K=1 window — it must now be honored');
});

// WP-SS2 (c): the future direction is unaffected by widening K — a sentAt claiming to be after
// receivedAt is impossible regardless of how the past-direction bound moved.
test('resolveSearchDeadlineStart falls back to receivedAt for a future sentAt (unchanged by the K widening)', () => {
	const receivedAt = 10_000;
	const budgetMs = 3200;
	assert.equal(resolveSearchDeadlineStart(receivedAt + 1, receivedAt, budgetMs), receivedAt, 'a sentAt claiming to be AFTER receivedAt is impossible and falls back');
	assert.equal(resolveSearchDeadlineStart(receivedAt + 50_000, receivedAt, budgetMs), receivedAt, 'an absurd future sentAt falls back the same way');
});

test('resolveSearchDeadlineStart falls back to receivedAt when sentAt is absent or non-numeric', () => {
	// WP-SS2 note: `receivedAt` here is deliberately a realistic epoch-scale magnitude (as every
	// other real-clock test in this file already uses, e.g. the `receivedAt = 1_000_000` wire
	// tests below), not the tiny `10_000` this test used pre-widening. `Number(null)` coerces to
	// `0`, and `0` fell outside the OLD K=1 window at `receivedAt = 10_000` purely by coincidence
	// of that small fixture magnitude — widening to K=5 budgets (max budget 20_000, so at most
	// 100_000ms of trusted past-window) pulled `0` inside that window at `10_000` and made this
	// assertion fail for a reason with zero bearing on real behavior: production `receivedAt` is
	// always `Date.now()`-scale (~1.7e12), so `0` is never within even a K=5 window of it. Keep
	// this fixture at a magnitude where that stays true.
	const receivedAt = 10_000_000;
	const budgetMs = 3200;
	assert.equal(resolveSearchDeadlineStart(undefined, receivedAt, budgetMs), receivedAt, 'an older client that never sends sentAt degrades cleanly to receivedAt');
	assert.equal(resolveSearchDeadlineStart(null, receivedAt, budgetMs), receivedAt);
	assert.equal(resolveSearchDeadlineStart('not a number', receivedAt, budgetMs), receivedAt);
	assert.equal(resolveSearchDeadlineStart(NaN, receivedAt, budgetMs), receivedAt);
});

// WP-3: the primary FTS scan (`statement.all(...)`) used to run unconditionally before any
// overBudget() checkpoint even existed — a request that arrived already doomed still paid for
// it. Injecting a `statement` stub that throws if ever called proves the pre-flight checkpoint
// actually prevents the call, not just that the response ends up looking degraded for some other
// reason.
test('pre-flight over-budget checkpoint: an already-doomed request skips the primary FTS scan entirely', () => {
	const db = makeDb([{ path: 'Alpha.md', title: 'Alpha', text: 'alpha content here' }]);
	const statement = {
		all: () => { throw new Error('the primary FTS scan must not run once the deadline has already passed'); },
	};
	const outcome = runSearch(db, { vaultId: VAULT, query: 'alpha', limit: 10, vectors: vectorsFor(db), statement, deadlineAt: 0 });
	assert.equal(outcome.degraded, true);
	assert.equal(outcome.results.length, 0);
	assert.equal(outcome.total, 0);
	assert.equal(outcome.fallbackUsed, false);
	assert.equal(outcome.match, buildFtsQuery('alpha').primary, 'match still reports the (unrun) strict-AND primary query text');
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
	// WP-3 added its own pre-flight checkpoint in front of the primary scan (a plain
	// `deadlineAt: 0` now trips THAT one too — see its own test above). This test is
	// specifically about the vector-leg checkpoint, so it needs an injected `now` that is
	// under budget for the pre-flight check (the primary scan actually runs) but over budget
	// by the time the vector-leg checkpoint is reached.
	let calls = 0;
	const deadlineAt = 1000;
	const now = () => { calls++; return calls === 1 ? 0 : 2000; };
	const outcome = runSearch(db, { vaultId: VAULT, query: 'alpha', limit: 10, vectors: vectorsFor(db), now, deadlineAt });
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

// WP-3 wire-level tests below share one shape: a single-doc, single-term query against a
// default ('current') ranking mode, with no vectors indexed, so the request handler's injected
// `now` is consulted exactly three times per request — receivedAt (1), the pre-flight
// primary-scan checkpoint (2), and the vector-leg checkpoint (3, always consulted regardless of
// whether the primary scan ran). `sequentialClock` hands back the same "50ms of real work
// happened" value for every checkpoint after receivedAt, so what actually varies between cases
// is only the deadline the request computed for itself from `sentAt`/`budgetMs` — not the clock.
function sequentialClock(values) {
	let i = 0;
	return () => (i < values.length ? values[i++] : values[values.length - 1]);
}

// The load-bearing comparison: two requests processed under the identical (simulated) 50ms of
// real work, differing only in whether `sentAt` reports a delay equal to the full default budget
// (3200ms) before the handler ever ran. Only the one that reports it arrives already doomed.
test('POST /v1/search: sentAt honored — a delay reported via sentAt starts the deadline earlier than receivedAt alone would', async () => {
	const db = makeDb([{ path: 'Alpha.md', title: 'Alpha', text: 'alpha content here' }]);
	const receivedAt = 1_000_000;

	await withSearchServer(db, async post => {
		// sentAt sits exactly at the window's lower boundary (delay == budget), which resolves
		// to a deadlineAt equal to receivedAt itself — the tightest deadline sentAt can produce
		// without being discarded as skew. See resolveSearchDeadlineStart.
		const response = await post({ vaultId: VAULT, query: 'alpha', limit: 10, sentAt: receivedAt - 3200 });
		assert.equal(response.status, 200);
		assert.equal(response.json.degraded, true, 'the queuing sentAt reports must already exhaust the default budget by the time the handler is 50ms in');
		assert.deepEqual(response.json.results, []);
	}, { now: sequentialClock([receivedAt, receivedAt + 50, receivedAt + 50]) });

	await withSearchServer(db, async post => {
		// Same simulated 50ms of work, no sentAt at all — falls back to receivedAt, gets the
		// full fresh budget, and must NOT degrade.
		const response = await post({ vaultId: VAULT, query: 'alpha', limit: 10 });
		assert.equal(response.status, 200);
		assert.equal('degraded' in response.json, false, 'without sentAt the same 50ms of work stays comfortably inside a fresh budget');
		assert.equal(response.json.results.length, 1);
	}, { now: sequentialClock([receivedAt, receivedAt + 50, receivedAt + 50]) });
});

// Skew clamp: a sentAt more than a full budget into the past, or claiming to be in the future
// relative to receivedAt, is discarded rather than honored — both must behave identically to the
// no-sentAt baseline above (same simulated clock, same non-degraded outcome).
test('POST /v1/search: skew clamp — an absurd future or past sentAt falls back to receivedAt', async () => {
	const db = makeDb([{ path: 'Alpha.md', title: 'Alpha', text: 'alpha content here' }]);
	const receivedAt = 1_000_000;

	await withSearchServer(db, async post => {
		const response = await post({ vaultId: VAULT, query: 'alpha', limit: 10, sentAt: receivedAt - 3200 - 100_000 });
		assert.equal(response.status, 200);
		assert.equal('degraded' in response.json, false, 'a sentAt far more than one budget into the past is skew, not queuing evidence, and must not be honored');
	}, { now: sequentialClock([receivedAt, receivedAt + 50, receivedAt + 50]) });

	await withSearchServer(db, async post => {
		const response = await post({ vaultId: VAULT, query: 'alpha', limit: 10, sentAt: receivedAt + 100_000 });
		assert.equal(response.status, 200);
		assert.equal('degraded' in response.json, false, 'a sentAt claiming to be after receivedAt is impossible and must not be honored');
	}, { now: sequentialClock([receivedAt, receivedAt + 50, receivedAt + 50]) });
});

// WP-SS2 wire-level acceptance case: a sentAt reporting 2 budgets' worth of queuing delay used
// to fall outside the old K=1 window (fresh budget granted, no degrade) — exactly the inversion
// this WP fixes, since that's precisely a request that has been queued/abandoned the longest.
// Under K=5 it is now trusted, correctly reads as already over budget, and degrades in ~ms.
test('POST /v1/search (WP-SS2): a sentAt 2 budgets old is trusted under K=5 and degrades', async () => {
	const db = makeDb([{ path: 'Alpha.md', title: 'Alpha', text: 'alpha content here' }]);
	const receivedAt = 1_000_000;

	await withSearchServer(db, async post => {
		const response = await post({ vaultId: VAULT, query: 'alpha', limit: 10, sentAt: receivedAt - 2 * 3200 });
		assert.equal(response.status, 200);
		assert.equal(response.json.degraded, true, 'a 2-budget-old sentAt is within the K=5 trust window and must be honored as already over budget');
		assert.deepEqual(response.json.results, []);
	}, { now: sequentialClock([receivedAt, receivedAt + 50, receivedAt + 50]) });
});

// Well-formedness of the already-doomed response: never a 5xx, still carries the shape a client
// expects (results array, total, hasMore, mode), just empty/degraded — this is the companion-side
// half of the pre-flight-skip proven at the runSearch level above ("skips the primary FTS scan
// entirely").
test('POST /v1/search: an already-over-budget request returns a fast, well-formed 200 with degraded: true', async () => {
	const db = makeDb([{ path: 'Alpha.md', title: 'Alpha', text: 'alpha content here' }]);
	const receivedAt = 1_000_000;

	await withSearchServer(db, async post => {
		const response = await post({ vaultId: VAULT, query: 'alpha', limit: 10, sentAt: receivedAt - 3200 });
		assert.equal(response.status, 200);
		assert.equal(response.json.degraded, true);
		assert.deepEqual(response.json.results, []);
		assert.equal(response.json.total, 0);
		assert.equal(response.json.hasMore, false);
		assert.equal(response.json.mode, 'fts');
		assert.equal(typeof response.json.schemaVersion, 'number');
	}, { now: sequentialClock([receivedAt, receivedAt + 50, receivedAt + 50]) });
});

// `handlerOptions` (default `{}`) threads straight through to createRequestHandler — WP-3's
// injectable `now` is what makes the sentAt/skew tests below deterministic instead of racing the
// real wall clock.
async function withSearchServer(db, fn, handlerOptions = {}) {
	const server = createServer(createRequestHandler(db, handlerOptions));
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
