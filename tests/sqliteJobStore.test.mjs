import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// esbuild's ESM output wraps every `require(...)` call site in a shim that throws
// "Dynamic require ... is not supported" unless a real `require` is reachable in
// scope at runtime (its check is `typeof require !== 'undefined'`) — true for the
// plugin's actual CJS production bundle (`esbuild.config.mjs`'s `format: 'cjs'`), but
// not for these ESM test bundles. `db/sqlite.ts`'s lazy `require('node:sqlite')`
// needs a real one, so provide it as a global before importing the bundle — the
// resolution base path doesn't matter for a core module.
globalThis.require = createRequire(import.meta.url);

const outdir = path.join(tmpdir(), 'obsidian-crucible-sqlitejobstore-tests');
const outfile = path.join(outdir, 'SqliteJobStore.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// One bundle over the storage layer (SqliteJobStore + the open/migrate/probe helper)
// so these tests exercise the real wiring, including the lazy `require('node:sqlite')`
// in db/sqlite.ts, rather than a re-implementation of it. Mirrors the shape of
// tests/queueControl.test.mjs / tests/orchestratorScan.test.mjs. `db/sqlite.ts`
// imports `FileSystemAdapter` from `obsidian` (only for `instanceof` in
// `resolveJobsDbPath`, which these tests never call), so it needs the usual
// obsidian-stub resolve plugin even though `SqliteJobStore.ts` itself imports
// nothing from `obsidian`.
await esbuild.build({
	stdin: {
		contents: [
			"export { SqliteJobStore } from './src/orchestration/db/SqliteJobStore';",
			"export { openJobsDb, isSqliteAvailable, SqliteUnavailableError } from './src/orchestration/db/sqlite';",
			"export { CANCELLED_BEFORE_RUN } from './src/orchestration/cancellation';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'sqlite-job-store-test-entry.ts',
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	// `db/sqlite.ts` lazy-`require`s `node:sqlite` at call time (must stay lazy — see
	// its doc comment). esbuild doesn't recognize `node:sqlite` as a builtin by name
	// (it's too new for esbuild's static list — verified: `node:module`'s own
	// `builtinModules` doesn't list it either, which is exactly why
	// `esbuild.config.mjs` externalizes it explicitly rather than relying on
	// platform:'node' auto-detection), so without this it gets treated as an
	// unresolved bundled module and esbuild's injected ESM require-shim throws
	// "Dynamic require ... is not supported" instead of ever reaching the real
	// runtime require.
	external: ['node:sqlite'],
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: [
					'export class FileSystemAdapter {}',
					'export class App {}',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { SqliteJobStore, openJobsDb, isSqliteAvailable, SqliteUnavailableError, CANCELLED_BEFORE_RUN } =
	await import(pathToFileURL(outfile).href);

// --- helpers ---------------------------------------------------------------------

function newDb() {
	return openJobsDb(':memory:');
}

function newStore(db, processToken) {
	return new SqliteJobStore(db, processToken ? { processToken } : {});
}

let nextId = 0;
function insertJob(store, overrides = {}) {
	nextId += 1;
	const id = overrides.id ?? `job-${String(nextId).padStart(4, '0')}`;
	return store.insert({
		id,
		type: overrides.type ?? 'search_upsert_file',
		created: overrides.created ?? String(nextId).padStart(10, '0'),
		lane: overrides.lane,
		priority: overrides.priority,
		params: overrides.params,
		dedupeKey: overrides.dedupeKey,
		deferUntil: overrides.deferUntil,
	});
}

/**
 * Wraps a real SqliteDatabase so that the FIRST claim-UPDATE attempt against
 * `targetId` is preceded by a raw racer UPDATE that flips the row to `running`
 * under a different token — reproducing "SELECT saw it queued, but by UPDATE time
 * someone else already claimed it" deterministically, without needing real OS-level
 * concurrency (impossible to get from a single synchronous node:sqlite connection in
 * one test process). This is exactly the race `claimNext`'s per-candidate retry loop
 * exists for (WP-5 brief, item 3).
 */
function raceOnFirstClaim(db, targetId, racerToken) {
	let armed = true;
	return {
		exec: (sql) => db.exec(sql),
		close: () => db.close(),
		prepare: (sql) => {
			const real = db.prepare(sql);
			if (armed && /UPDATE jobs SET status = 'running'/.test(sql)) {
				return {
					run: (...params) => {
						const id = params[2];
						if (armed && id === targetId) {
							armed = false;
							db.prepare(
								`UPDATE jobs SET status = 'running', claimed_at = ?, claim_token = ? WHERE id = ? AND status = 'queued'`,
							).run(Date.now(), racerToken, targetId);
						}
						return real.run(...params);
					},
					get: (...p) => real.get(...p),
					all: (...p) => real.all(...p),
				};
			}
			return real;
		},
	};
}

// --- capability probe -------------------------------------------------------------

test('isSqliteAvailable is true under the Node 24 test runner', () => {
	assert.equal(isSqliteAvailable(), true);
});

test('openJobsDb(":memory:") opens and is immediately queryable', () => {
	const db = newDb();
	const store = newStore(db);
	assert.equal(store.count('queued'), 0);
	db.close();
});

// --- claim atomicity ---------------------------------------------------------------

test('claimNext: two separate claimers never win the same job (two claims, one winner each)', () => {
	const db = newDb();
	const storeA = newStore(db, 'proc-a');
	const storeB = newStore(db, 'proc-b');
	const j1 = insertJob(storeA, { created: '0000000001' });
	const j2 = insertJob(storeA, { created: '0000000002' });

	const now = 1_000_000;
	const wonByA = storeA.claimNext(now);
	const wonByB = storeB.claimNext(now);

	assert.ok(wonByA);
	assert.ok(wonByB);
	assert.notEqual(wonByA.id, wonByB.id);
	assert.deepEqual([wonByA.id, wonByB.id].sort(), [j1.id, j2.id].sort());
	assert.equal(storeA.count('running'), 2);
	assert.equal(storeA.count('queued'), 0);
	db.close();
});

test('claimNext: a lost race on the top-ranked candidate falls through to the next one', () => {
	const db = newDb();
	const store = newStore(db, 'proc-main');
	const first = insertJob(store, { created: '0000000001', priority: 'high', lane: 'user' });
	const second = insertJob(store, { created: '0000000002', priority: 'normal', lane: 'background' });

	const racedDb = raceOnFirstClaim(db, first.id, 'proc-racer');
	const racedStore = newStore(racedDb, 'proc-main');

	const claimed = racedStore.claimNext(2_000_000);

	assert.ok(claimed);
	assert.equal(claimed.id, second.id, 'lost race on `first` must re-select `second`, not return null');

	const firstRow = store.get(first.id);
	assert.equal(firstRow.status, 'running');
	assert.equal(firstRow.claimToken, 'proc-racer', '`first` was won by the racer, not by our store');

	const secondRow = store.get(second.id);
	assert.equal(secondRow.status, 'running');
	assert.equal(secondRow.claimToken, 'proc-main');
	db.close();
});

test('claimNext: an already-running job cannot be claimed again (changes=0 semantics at the SQL level)', () => {
	const db = newDb();
	const store = newStore(db, 'proc-1');
	const job = insertJob(store);
	const now = 5000;
	const first = store.claimNext(now);
	assert.equal(first.id, job.id);

	// Simulate a second claimer attempting the exact statement claimNext uses against
	// the same (now-running) row.
	const result = db.prepare(
		`UPDATE jobs SET status = 'running', claimed_at = ?, claim_token = ? WHERE id = ? AND status = 'queued'`,
	).run(now, 'someone-else', job.id);
	assert.equal(result.changes, 0);
	db.close();
});

// --- ordering ------------------------------------------------------------------

test('claimNext ordering: lane rank, then priority rank, then created, then id — all tiebreaks', () => {
	const db = newDb();
	const store = newStore(db, 'proc-order');

	// user(0) beats background(1) regardless of priority.
	const bgHigh = insertJob(store, { created: '0000000001', lane: 'background', priority: 'high' });
	const userLow = insertJob(store, { created: '0000000002', lane: 'user', priority: 'low' });
	// Within the same lane, high(0) < normal(1) < low(2).
	const userNormal = insertJob(store, { created: '0000000003', lane: 'user', priority: 'normal' });
	const userHigh = insertJob(store, { created: '0000000004', lane: 'user', priority: 'high' });
	// Same lane+priority: created ascending wins.
	const userHighEarlier = insertJob(store, { created: '0000000000', lane: 'user', priority: 'high' });
	// Same lane+priority+created: id lexicographic tiebreak.
	const tieB = insertJob(store, { id: 'tie-b', created: '0000000005', lane: 'user', priority: 'high' });
	const tieA = insertJob(store, { id: 'tie-a', created: '0000000005', lane: 'user', priority: 'high' });

	const order = [];
	for (let i = 0; i < 7; i++) {
		const claimed = store.claimNext(i); // distinct nowMs values are irrelevant here (no deferrals)
		order.push(claimed.id);
	}

	assert.deepEqual(order, [
		userHighEarlier.id, // user/high, created 0000000000
		userHigh.id,        // user/high, created 0000000004
		tieA.id,             // user/high, created 0000000005, id "tie-a" < "tie-b"
		tieB.id,
		userNormal.id,       // user/normal
		userLow.id,          // user/low
		bgHigh.id,           // background/* loses to every user/* row
	]);
	db.close();
});

test('claimNext: default lane derives from priority the way defaultLaneForPriority does', () => {
	const db = newDb();
	const store = newStore(db, 'proc-default-lane');
	const high = insertJob(store, { created: '0000000001' }); // priority defaults 'normal' -> lane 'background'
	assert.equal(store.get(high.id).lane, 'background');

	const explicitHigh = insertJob(store, { created: '0000000002', priority: 'high' });
	assert.equal(store.get(explicitHigh.id).lane, 'user');
	db.close();
});

// --- dedupe + promotion ----------------------------------------------------------

test('dedupe: empty/falsy keys are stored as NULL and never collapse', () => {
	const db = newDb();
	const store = newStore(db, 'proc-dedupe');
	const a = insertJob(store, { dedupeKey: '' });
	const b = insertJob(store, { dedupeKey: undefined });
	assert.equal(store.get(a.id).dedupeKey, undefined);
	assert.equal(store.get(b.id).dedupeKey, undefined);
	assert.equal(store.findActive(''), null);
	assert.equal(store.findActive(undefined), null);
	assert.equal(store.findActive(null), null);
	db.close();
});

test('findActive: matches a real dedupe key across queued+running only, not done/failed/cancelled', () => {
	const db = newDb();
	const store = newStore(db, 'proc-dedupe2');
	const queued = insertJob(store, { dedupeKey: 'video:abc', created: '0000000001' });
	const active = store.findActive('video:abc');
	assert.equal(active.id, queued.id);

	store.transition(queued.id, 'running', 1000);
	assert.equal(store.findActive('video:abc').id, queued.id);

	store.transition(queued.id, 'done', 2000);
	assert.equal(store.findActive('video:abc'), null);
});

test('promote: updates lane/priority independently and no-ops on both omitted', () => {
	const db = newDb();
	const store = newStore(db, 'proc-promote');
	const job = insertJob(store, { lane: 'background', priority: 'low' });

	const p1 = store.promote(job.id, 'user');
	assert.equal(p1.lane, 'user');
	assert.equal(p1.priority, 'low');

	const p2 = store.promote(job.id, undefined, 'high');
	assert.equal(p2.lane, 'user');
	assert.equal(p2.priority, 'high');

	const p3 = store.promote(job.id);
	assert.equal(p3.lane, 'user');
	assert.equal(p3.priority, 'high');
	db.close();
});

// --- deferral --------------------------------------------------------------------

test('deferral: claimNext skips defer_until in the future, claims once it is due, and reports the wake time', () => {
	const db = newDb();
	const store = newStore(db, 'proc-defer');
	const deferred = insertJob(store, { created: '0000000001', deferUntil: 10_000 });
	const eligible = insertJob(store, { created: '0000000002' });

	assert.equal(store.nextDeferredWakeMs(), 10_000);

	const firstClaim = store.claimNext(5_000);
	assert.equal(firstClaim.id, eligible.id, 'deferred job must be skipped while defer_until is in the future');

	const nowNothingElseQueued = store.claimNext(5_000);
	assert.equal(nowNothingElseQueued, null, 'still-deferred job must not be claimable early');

	const dueClaim = store.claimNext(10_000);
	assert.equal(dueClaim.id, deferred.id, 'defer_until <= now must become claimable');

	assert.equal(store.nextDeferredWakeMs(), null);
	db.close();
});

test('deferral: any transition out of queued clears defer_until', () => {
	const db = newDb();
	const store = newStore(db, 'proc-defer2');
	const job = insertJob(store, { deferUntil: 999_999_999 });
	store.transition(job.id, 'cancelled', 1000);
	assert.equal(store.get(job.id).deferUntil, undefined);
	db.close();
});

// --- stale recovery ----------------------------------------------------------------

test('recoverStale: a running job whose claim_token does not match this process is recovered regardless of age', () => {
	const db = newDb();
	const claimant = newStore(db, 'proc-old');
	const job = insertJob(claimant);
	const claimed = claimant.claimNext(1000);
	assert.equal(claimed.id, job.id);

	const freshProcess = newStore(db, 'proc-new');
	const recovered = freshProcess.recoverStale(1001, () => 999_999_999); // huge stale window
	assert.equal(recovered, 1);
	const row = freshProcess.get(job.id);
	assert.equal(row.status, 'queued');
	assert.equal(row.claimedAt, undefined);
	assert.equal(row.claimToken, undefined);
	assert.equal(row.error, 'Recovered: stale claim');
	db.close();
});

test('recoverStale: same-process claims recover only once claimed_at + staleMs < now (age-based)', () => {
	const db = newDb();
	const store = newStore(db, 'proc-same');
	const job = insertJob(store);
	store.claimNext(1000);

	const tooEarly = store.recoverStale(1000 + 500, () => 1000);
	assert.equal(tooEarly, 0);
	assert.equal(store.get(job.id).status, 'running');

	const justStale = store.recoverStale(1000 + 1000 + 1, () => 1000);
	assert.equal(justStale, 1);
	assert.equal(store.get(job.id).status, 'queued');
	db.close();
});

test('recoverStale: per-type stale window is resolved by the caller-supplied function', () => {
	const db = newDb();
	const store = newStore(db, 'proc-per-type');
	const fast = insertJob(store, { id: 'fast-job', type: 'search_upsert_file' });
	const slow = insertJob(store, { id: 'slow-job', type: 'youtube_tracker' });
	store.claimNext(0);
	store.claimNext(0);

	const staleMsForType = (type) => (type === 'search_upsert_file' ? 100 : 100_000);
	const recovered = store.recoverStale(500, staleMsForType);
	assert.equal(recovered, 1);
	assert.equal(store.get(fast.id).status, 'queued');
	assert.equal(store.get(slow.id).status, 'running');
	db.close();
});

// --- field writers / transition ----------------------------------------------------

test('appendNotes: joins with a newline, first call sets the whole value', () => {
	const db = newDb();
	const store = newStore(db, 'proc-notes');
	const job = insertJob(store);
	store.appendNotes(job.id, '  first line  ');
	assert.equal(store.get(job.id).notes, 'first line');
	store.appendNotes(job.id, 'second line');
	assert.equal(store.get(job.id).notes, 'first line\nsecond line');
	db.close();
});

test('transition: a terminal transition stamps settled_at, clears claim fields, and applies the patch atomically', () => {
	const db = newDb();
	const store = newStore(db, 'proc-transition');
	const job = insertJob(store);
	store.claimNext(1000);

	const settled = store.transition(job.id, 'failed', 5000, {
		error: 'boom',
		failureKind: 'job',
		outputPaths: ['a.md', 'b.md'],
		partial: true,
		notes: 'first note',
		progress: 'gave up',
	});

	assert.equal(settled.status, 'failed');
	assert.equal(settled.settledAt, 5000);
	assert.equal(settled.claimedAt, undefined);
	assert.equal(settled.claimToken, undefined);
	assert.equal(settled.error, 'boom');
	assert.equal(settled.failureKind, 'job');
	assert.deepEqual(settled.outputPaths, ['a.md', 'b.md']);
	assert.equal(settled.partial, true);
	assert.equal(settled.notes, 'first note');
	assert.equal(settled.progress, 'gave up');
});

test('transition: moving back to queued clears claim + settlement bookkeeping', () => {
	const db = newDb();
	const store = newStore(db, 'proc-requeue');
	const job = insertJob(store);
	store.claimNext(1000);
	store.transition(job.id, 'failed', 2000, { error: 'x' });
	const requeued = store.transition(job.id, 'queued', 3000, { error: null });
	assert.equal(requeued.status, 'queued');
	assert.equal(requeued.claimedAt, undefined);
	assert.equal(requeued.claimToken, undefined);
	assert.equal(requeued.settledAt, undefined);
	assert.equal(requeued.error, undefined);
	db.close();
});

test('setError/setFailureKind/clearError/setOutputPaths/setPartial/setProgress/setLane/setPriority', () => {
	const db = newDb();
	const store = newStore(db, 'proc-setters');
	const job = insertJob(store, { lane: 'background', priority: 'normal' });

	store.setError(job.id, 'oops');
	store.setFailureKind(job.id, 'service');
	assert.equal(store.get(job.id).error, 'oops');
	assert.equal(store.get(job.id).failureKind, 'service');

	store.clearError(job.id);
	assert.equal(store.get(job.id).error, undefined);
	assert.equal(store.get(job.id).failureKind, undefined);

	store.setOutputPaths(job.id, ['x.md']);
	assert.deepEqual(store.get(job.id).outputPaths, ['x.md']);

	store.setPartial(job.id, true);
	assert.equal(store.get(job.id).partial, true);

	store.setProgress(job.id, 'halfway');
	assert.equal(store.get(job.id).progress, 'halfway');

	store.setLane(job.id, 'user');
	store.setPriority(job.id, 'high');
	assert.equal(store.get(job.id).lane, 'user');
	assert.equal(store.get(job.id).priority, 'high');
	db.close();
});

test('setDeferred mirrors JobStore.setDeferred: stamps progress + defer_until, clears error', () => {
	const db = newDb();
	const store = newStore(db, 'proc-setdefer');
	const job = insertJob(store);
	store.setError(job.id, 'transient');
	store.setDeferred(job.id, 'waiting on service', 42_000);
	const row = store.get(job.id);
	assert.equal(row.progress, 'waiting on service');
	assert.equal(row.deferUntil, 42_000);
	assert.equal(row.error, undefined);
	db.close();
});

// --- bulk ops ----------------------------------------------------------------------

test('clearQueued: bulk-cancels every queued row in one call, leaves other statuses untouched, returns the count', () => {
	const db = newDb();
	const store = newStore(db, 'proc-clear');
	// Highest rank (user/high, earliest created) so it is guaranteed to be the one
	// `claimNext` picks below — q1/q2 default to background/normal and sort after it.
	const toRun = insertJob(store, { created: '0000000000', lane: 'user', priority: 'high' });
	const q1 = insertJob(store, { created: '0000000001' });
	const q2 = insertJob(store, { created: '0000000002' });
	const running = store.claimNext(0);
	assert.equal(running.id, toRun.id);

	const count = store.clearQueued(9000);
	assert.equal(count, 2);
	assert.equal(store.get(q1.id).status, 'cancelled');
	assert.equal(store.get(q1.id).notes, CANCELLED_BEFORE_RUN);
	assert.equal(store.get(q1.id).settledAt, 9000);
	assert.equal(store.get(q2.id).status, 'cancelled');
	assert.equal(store.get(running.id).status, 'running');

	const secondCall = store.clearQueued(9001);
	assert.equal(secondCall, 0);
	db.close();
});

test('clearQueued: appends onto existing notes rather than overwriting them', () => {
	const db = newDb();
	const store = newStore(db, 'proc-clear-notes');
	const job = insertJob(store);
	store.appendNotes(job.id, 'existing note');
	store.clearQueued(1);
	assert.equal(store.get(job.id).notes, `existing note\n${CANCELLED_BEFORE_RUN}`);
	db.close();
});

// --- retention -----------------------------------------------------------------

test('pruneTerminal: deletes settled rows older than the cutoff, keeps the boundary and non-terminal rows', () => {
	const db = newDb();
	const store = newStore(db, 'proc-prune');
	const retentionDays = 1;
	const dayMs = 24 * 60 * 60 * 1000;
	const now = 10 * dayMs;

	const old = insertJob(store, { id: 'old' });
	store.transition(old.id, 'done', now - dayMs - 1); // 1ms past the cutoff -> pruned

	const boundary = insertJob(store, { id: 'boundary' });
	store.transition(boundary.id, 'done', now - dayMs); // exactly at cutoff -> kept (strict <)

	const recent = insertJob(store, { id: 'recent' });
	store.transition(recent.id, 'failed', now - 10);

	const stillQueued = insertJob(store, { id: 'still-queued' });

	const pruned = store.pruneTerminal(now, retentionDays);
	assert.equal(pruned, 1);
	assert.equal(store.get(old.id), null);
	assert.ok(store.get(boundary.id));
	assert.ok(store.get(recent.id));
	assert.ok(store.get(stillQueued.id));
	db.close();
});

test('pruneTerminal: 0 or negative retention means keep forever (no-op)', () => {
	const db = newDb();
	const store = newStore(db, 'proc-prune-never');
	const job = insertJob(store);
	store.transition(job.id, 'done', 0);
	assert.equal(store.pruneTerminal(999_999_999_999, 0), 0);
	assert.equal(store.pruneTerminal(999_999_999_999, -5), 0);
	assert.ok(store.get(job.id));
	db.close();
});

// --- reads: list/count/countByTypeAndStatus/hasActive -----------------------------

test('list: returns rows for a status in claim order, respects limit and offset', () => {
	const db = newDb();
	const store = newStore(db, 'proc-list');
	const ids = [];
	for (let i = 0; i < 5; i++) {
		ids.push(insertJob(store, { created: String(i).padStart(10, '0') }).id);
	}

	assert.deepEqual(store.list('queued').map(r => r.id), ids);
	assert.deepEqual(store.list('queued', { limit: 2 }).map(r => r.id), ids.slice(0, 2));
	assert.deepEqual(store.list('queued', { limit: 2, offset: 2 }).map(r => r.id), ids.slice(2, 4));
	assert.equal(store.list('running').length, 0);
	db.close();
});

test('count/countByTypeAndStatus/hasActive', () => {
	const db = newDb();
	const store = newStore(db, 'proc-counts');
	insertJob(store, { type: 'search_upsert_file', created: '0000000001' });
	insertJob(store, { type: 'search_upsert_file', created: '0000000002' });
	insertJob(store, { type: 'youtube_tracker', created: '0000000003' });

	// Claim exactly one row; which one doesn't matter — every assertion below is
	// phrased over queued+running together so it's independent of which job won.
	store.claimNext(0);

	assert.equal(store.count('queued') + store.count('running'), 3);
	assert.equal(store.countByTypeAndStatus('search_upsert_file', ['queued', 'running']), 2);
	assert.equal(store.countByTypeAndStatus('youtube_tracker', ['queued', 'running']), 1);
	assert.equal(store.countByTypeAndStatus('youtube_tracker', ['done']), 0);
	assert.equal(store.hasActive('search_upsert_file'), true);
	assert.equal(store.hasActive('link_scan'), false);
	db.close();
});

// --- corrupted JSON tolerance -------------------------------------------------------

test('corrupted params/output_paths JSON is tolerated: get()/list() return a safe default instead of throwing', () => {
	const db = newDb();
	const store = newStore(db, 'proc-corrupt');
	const job = insertJob(store, { params: { ok: true } });
	store.setOutputPaths(job.id, ['fine.md']);

	// Simulate on-disk corruption (e.g. a hand-edited row, or a future write bug) —
	// bypass the store entirely and write invalid JSON straight into the columns.
	db.prepare('UPDATE jobs SET params = ?, output_paths = ? WHERE id = ?')
		.run('{not valid json', '[also not valid', job.id);

	const row = store.get(job.id);
	assert.deepEqual(row.params, {});
	assert.deepEqual(row.outputPaths, []);

	const listed = store.list('queued');
	assert.equal(listed.length, 1);
	assert.deepEqual(listed[0].params, {});
	db.close();
});

// --- probe / unavailable error shape -----------------------------------------------

test('SqliteUnavailableError has the expected name so callers can identify it', () => {
	const err = new SqliteUnavailableError('nope');
	assert.equal(err.name, 'SqliteUnavailableError');
	assert.ok(err instanceof Error);
});
