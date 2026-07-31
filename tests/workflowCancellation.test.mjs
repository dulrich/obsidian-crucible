import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// The cooperative-cancellation path end to end: the pure classification, the run
// registry, the backend's settle mapping, the note lock unwinding, and the stale
// sweep's refusal to resurrect a job that is still winding down.
//
// thq WP-8 rewrote the harness, not the assertions: these drove a fake markdown
// `JobStore` (plus, for four of them, the in-memory backend) and now drive a real
// `SqliteJobStore` on `:memory:` through the one remaining backend. Nothing was
// dropped — the four memory-backend tests migrated onto `youtube_metadata_fetch`,
// which is a durable type now, so they still pin the enrichment queue's cancellation
// behavior specifically.

globalThis.require = createRequire(import.meta.url);

const outdir = path.join(tmpdir(), 'obsidian-crucible-cancellation-tests');
const outfile = path.join(outdir, 'cancellation.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// One bundle over the whole cancellation path — the seam, the backend, the
// orchestrator's stale sweep, the storage layer, and the real NoteLockManager — so the
// tests exercise the wiring rather than a re-implementation of it.
await esbuild.build({
	stdin: {
		contents: [
			"export * from './src/orchestration/cancellation';",
			"export * from './src/orchestration/JobBackend';",
			"export { DbJobBackend } from './src/orchestration/DbJobBackend';",
			"export { Orchestrator } from './src/orchestration/Orchestrator';",
			"export { NoteLockManager } from './src/orchestration/NoteLockManager';",
			"export { SqliteJobStore } from './src/orchestration/db/SqliteJobStore';",
			"export { openJobsDb } from './src/orchestration/db/sqlite';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'cancellation-test-entry.ts',
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	external: ['node:sqlite'],
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: [
					'globalThis.__cancellationNotices = globalThis.__cancellationNotices ?? [];',
					'export class Notice { constructor(message) { globalThis.__cancellationNotices.push(message); } }',
					'export class TFile {}',
					'export class TFolder {}',
					'export class App {}',
					'export class Modal {}',
					'export class Setting {}',
					'export class FuzzySuggestModal {}',
					'export class FileSystemAdapter {}',
					'export function normalizePath(p) { return p; }',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
					'export const Platform = {};',
					'export const moment = () => {};',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	DbJobBackend,
	NoteLockManager,
	Orchestrator,
	SqliteJobStore,
	openJobsDb,
	JobCancelledError,
	RunningJobRegistry,
	applyCancellation,
	cancelledResultFor,
	runWorkflowWithTimeout,
} = await import(pathToFileURL(outfile).href);

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred() {
	let resolve;
	const promise = new Promise(r => { resolve = r; });
	return { promise, resolve };
}

function newStore() {
	return new SqliteJobStore(openJobsDb(':memory:'));
}

function seedQueued(store, id, type = TEST_TYPE) {
	store.insert({ id, type, created: new Date().toISOString(), params: {} });
	return id;
}

function makePlugin(overrides = {}) {
	return {
		settings: {
			orchestrationEnabled: true,
			orchestrationQueueEnabled: true,
			orchestrationAutorunTimeoutSeconds: 0,
			orchestrationRoutineNoticesEnabled: {},
			orchestrationJobRetentionDays: 30,
			...(overrides.settings ?? {}),
		},
		ingestionEvents: null,
		orchestrationAutoRunner: null,
		app: { vault: { getAbstractFileByPath: () => null }, workspace: { onLayoutReady: () => {} } },
		...overrides,
	};
}

// `command_run` is the type used throughout: DbJobBackend.isWorkflowEnabled has no
// settings toggle for it, so it is enabled by default and the tests exercise the
// cancellation path rather than the enablement gate.
const TEST_TYPE = 'command_run';
const ENRICHMENT_TYPE = 'youtube_metadata_fetch';
const TEST_CONFIG = { persistence: 'db', minIntervalMs: 0, maxParallel: 1 };

function backendFor(workflow, { store = newStore(), plugin = makePlugin(), type = TEST_TYPE, config = TEST_CONFIG } = {}) {
	const backend = new DbJobBackend(plugin, store, type, config, workflow);
	return { backend, store, plugin };
}

// --- the pure classification -------------------------------------------------

test('applyCancellation leaves a result alone when nothing was cancelled', () => {
	const done = { status: 'done', notes: 'fine' };
	assert.equal(applyCancellation(done, false), done);
});

// rem-R1: `WorkflowResult` is a discriminated union, and the cancelled variant carries
// only `status` + the genuinely common `outputPaths`/`notes`. So these assert the
// *absence of the key* rather than "the key is present holding undefined" — the old
// spread-then-erase construction left `error: undefined` / `retryAfterMs: undefined`
// sitting on the result as if they were part of the cancelled contract.
const CANCELLED_ALLOWED_KEYS = ['status', 'outputPaths', 'notes'];

function assertCleanCancelledShape(result, label) {
	assert.equal(result.status, 'cancelled', label);
	for (const key of Object.keys(result)) {
		assert.ok(CANCELLED_ALLOWED_KEYS.includes(key),
			`${label}: cancelled results must not carry "${key}" — it belongs to another variant`);
	}
	assert.ok(!('error' in result), `${label}: a cancellation is not a diagnostic error`);
	assert.ok(!('failureReason' in result), `${label}: no failure cause on a cancellation`);
	assert.ok(!('retryAfterMs' in result), `${label}: a cancellation is never retried by policy`);
	assert.ok(!('serviceUnhealthy' in result), `${label}: service data is deferred-only`);
}

test('applyCancellation rewrites failed and deferred, but never done', () => {
	assert.equal(applyCancellation({ status: 'done', notes: 'wrote the note' }, true).status, 'done',
		'work that completed must not be reported as if it never happened');

	const failed = applyCancellation({ status: 'failed', error: 'chain blew up', failureReason: 'no-api-key' }, true);
	assertCleanCancelledShape(failed, 'failed -> cancelled');
	assert.match(failed.notes, /chain blew up/, 'the original message survives as a note');

	const deferred_ = applyCancellation({ status: 'deferred', notes: 'companion down', retryAfterMs: 30_000 }, true);
	assertCleanCancelledShape(deferred_, 'deferred -> cancelled');
	assert.match(deferred_.notes, /companion down/, 'the original message survives as a note');
});

test('applyCancellation drops variant-specific fields but keeps outputPaths', () => {
	// `outputPaths` is a genuine common field and DbJobBackend records it off the
	// POST-cancellation result, so a run that already wrote a note must not lose it.
	const fromDeferred = applyCancellation({
		status: 'deferred',
		error: 'youtube-api down',
		notes: 'all feeds failed',
		outputPaths: ['_intake/2026-07-31.md'],
		retryAfterMs: 3_600_000,
		serviceUnhealthy: { service: 'youtube-api', kind: 'rate-limited', reason: 'quota' },
	}, true);
	assertCleanCancelledShape(fromDeferred, 'deferred with service data');
	assert.deepEqual(fromDeferred.outputPaths, ['_intake/2026-07-31.md']);

	const fromFailed = applyCancellation({
		status: 'failed',
		error: 'no key',
		failureReason: 'no-api-key',
		outputPaths: ['_intake/2026-07-31.md'],
	}, true);
	assertCleanCancelledShape(fromFailed, 'failed with a typed cause');
	assert.deepEqual(fromFailed.outputPaths, ['_intake/2026-07-31.md']);

	// No outputPaths in, no empty key out.
	const bare = applyCancellation({ status: 'failed', error: 'boom' }, true);
	assert.ok(!('outputPaths' in bare), 'an absent common field stays absent');
});

test('cancelledResultFor constructs the cancelled variant and nothing else', () => {
	const aborted = new AbortController();
	aborted.abort(new JobCancelledError('stopped'));
	assertCleanCancelledShape(cancelledResultFor(new JobCancelledError('stopped'), aborted.signal), 'typed cancel');
	assertCleanCancelledShape(cancelledResultFor(new Error('step blew up'), aborted.signal), 'post-signal failure');
});

test('cancelledResultFor claims a JobCancelledError, and any error raised after the signal fired', () => {
	const idle = new AbortController();
	assert.equal(cancelledResultFor(new Error('genuine failure'), idle.signal), null);
	assert.equal(cancelledResultFor(new JobCancelledError('stopped'), idle.signal).status, 'cancelled',
		'a cancellation error is claimed even if this signal never fired');

	const aborted = new AbortController();
	aborted.abort(new JobCancelledError('stopped'));
	const claimed = cancelledResultFor(new Error('step failed mid-abort'), aborted.signal);
	assert.equal(claimed.status, 'cancelled');
	assert.match(claimed.notes, /step failed mid-abort/);
});

// --- the registry ------------------------------------------------------------

test('the registry aborts with a JobCancelledError as the signal reason', async () => {
	const registry = new RunningJobRegistry();
	const run = registry.begin('job-1');
	assert.equal(registry.isCancelling('job-1'), false);

	const pending = registry.cancel('job-1');
	assert.equal(registry.isCancelling('job-1'), true);
	assert.throws(() => run.signal.throwIfAborted(), JobCancelledError,
		'the standard Web API checkpoint must raise our typed error');

	run.finish('cancelled');
	assert.equal(await pending, 'cancelled');
	assert.equal(registry.isCancelling('job-1'), false, 'settled runs deregister');
});

test('cancelling an unknown key reports not-running rather than hanging', async () => {
	const registry = new RunningJobRegistry();
	assert.equal(await registry.cancel('nobody'), 'not-running');
});

// --- 1. a cancelled workflow settles cancelled, not failed -------------------

test('a cancelled running workflow stops at its next checkpoint and settles as cancelled', async () => {
	const reachedCheckpoint = deferred();
	const releaseWork = deferred();
	const iterations = [];
	const workflow = {
		async run(_job, ctx) {
			for (let i = 0; i < 5; i++) {
				ctx.throwIfAborted();
				iterations.push(i);
				if (i === 0) {
					reachedCheckpoint.resolve();
					await releaseWork.promise;
				}
			}
			return { status: 'done', notes: 'ran every iteration' };
		},
	};

	const { backend, store } = backendFor(workflow);
	seedQueued(store, 'job-1');

	const execution = backend.runJob('job-1');

	await reachedCheckpoint.promise;
	const cancelling = backend.cancelJob('job-1');
	assert.equal(backend.isCancelling('job-1'), true, 'still settling, so still off-limits to stale recovery');

	releaseWork.resolve();
	assert.equal(await cancelling, 'cancelled');
	await execution;

	assert.deepEqual(iterations, [0], 'the loop stopped at the checkpoint after the one in flight');
	assert.equal(store.count('cancelled'), 1, 'the job landed in the cancelled bucket');
	assert.equal(store.count('failed'), 0, 'and emphatically not in failed');
	assert.equal(store.get('job-1').status, 'cancelled');
	assert.equal(backend.isCancelling('job-1'), false, 'settled, so recovery may look at it again');
});

// --- 2. the note lock is released -------------------------------------------

test('cancellation releases the note lock — no note is left greyed out', async () => {
	const locks = new NoteLockManager();
	const inside = deferred();
	const release = deferred();
	const workflow = {
		async run(_job, ctx) {
			return locks.withLock('notes/target.md', 'test-workflow', async () => {
				inside.resolve();
				await release.promise;
				// The checkpoint sits inside the lock, exactly as a real workflow's would.
				ctx.throwIfAborted();
				return { status: 'done' };
			});
		},
	};

	const { backend, store } = backendFor(workflow);
	seedQueued(store, 'job-lock');

	const execution = backend.runJob('job-lock');
	await inside.promise;
	assert.equal(locks.isLocked('notes/target.md'), true);

	const cancelling = backend.cancelJob('job-lock');
	release.resolve();
	assert.equal(await cancelling, 'cancelled');
	await execution;

	assert.equal(locks.isLocked('notes/target.md'), false,
		'the abort unwound through withLock\'s finally');
	assert.equal(store.count('cancelled'), 1);
});

// --- 3. stale recovery must not resurrect a cancelling job ------------------

test('Orchestrator.scan() does not resurrect a cancelled job that is still settling', async () => {
	const hold = deferred();
	const workflow = {
		async run(_job, ctx) {
			await hold.promise;
			ctx.throwIfAborted();
			return { status: 'done' };
		},
	};

	const plugin = makePlugin();
	const store = newStore();
	const orchestrator = new Orchestrator(plugin, { openDbStore: () => store });
	orchestrator.register(TEST_TYPE, workflow, TEST_CONFIG);
	seedQueued(store, 'job-stale');

	const execution = orchestrator.runJob(TEST_TYPE, 'job-stale');
	await flush();
	// Backdate the claim well past the stale cutoff, so without the isRunning guard the
	// sweep below would bounce it running → queued and the work would run a second time.
	store.db.prepare('UPDATE jobs SET claimed_at = ? WHERE id = ?').run(Date.now() - 10 * 60 * 60 * 1000, 'job-stale');

	const cancelling = orchestrator.cancelJob(TEST_TYPE, 'job-stale');
	assert.equal(orchestrator.isCancelling(TEST_TYPE, 'job-stale'), true);

	const midFlight = await orchestrator.scan({ notify: false });
	assert.equal(midFlight.recovered, 0, 'a live, cancelling run is not stale');
	assert.equal(store.get('job-stale').status, 'running');
	assert.equal(store.count('queued'), 0, 'never re-queued');

	hold.resolve();
	assert.equal(await cancelling, 'cancelled');
	await execution;
	assert.equal(store.count('cancelled'), 1);

	const after = await orchestrator.scan({ notify: false });
	assert.equal(after.cancelled, 1, 'the scan report counts the cancelled bucket');
	assert.equal(after.recovered, 0);
});

// --- 4. abort degrades, it does not hang ------------------------------------

test('a workflow with no cooperative checkpoint still terminates cleanly', async () => {
	const release = deferred();
	let observed = null;
	const workflow = {
		async run(_job, ctx) {
			// Never calls throwIfAborted. Notably it does not even look at ctx.signal.
			await release.promise;
			observed = ctx.signal.aborted;
			return { status: 'done', notes: 'finished regardless' };
		},
	};

	const { backend, store } = backendFor(workflow);
	seedQueued(store, 'job-deaf');

	const execution = backend.runJob('job-deaf');
	await flush();

	const cancelling = backend.cancelJob('job-deaf');
	release.resolve();

	// The contract: the cancel resolves rather than hanging, and reports honestly
	// that the run finished before it could be stopped.
	assert.equal(await cancelling, 'completed');
	await execution;

	assert.equal(observed, true, 'the signal was raised; the workflow simply never checked it');
	assert.equal(store.count('done'), 1, 'completed work is recorded as done, not as cancelled');
	assert.equal(store.count('cancelled'), 0);
});

test('a workflow that ignores the signal and then fails is still not filed as a failure', async () => {
	const release = deferred();
	const workflow = {
		async run() {
			await release.promise;
			// Mirrors ChainRunWorkflow: it swallows everything and reports failure.
			return { status: 'failed', error: 'chain execution failed: aborted' };
		},
	};

	const { backend, store } = backendFor(workflow);
	seedQueued(store, 'job-swallow');

	const execution = backend.runJob('job-swallow');
	await flush();
	const cancelling = backend.cancelJob('job-swallow');
	release.resolve();

	assert.equal(await cancelling, 'cancelled');
	await execution;
	assert.equal(store.count('failed'), 0, 'a cancel must not pollute failure diagnostics');
	assert.equal(store.count('cancelled'), 1);
});

// --- the enrichment type takes the same path --------------------------------
//
// `youtube_metadata_fetch` was the in-memory queue's only type before thq WP-8, with
// its own settle vocabulary (pending/running/done/failed/cancelled) and its own
// backend. These four used to exercise `MemoryJobBackend`; they now exercise the same
// durable backend as everything else, which is the point — the enrichment queue no
// longer has a differently-behaved cancel.

const enrichmentConfig = {
	persistence: 'db',
	drainsWithoutAutorun: true,
	minIntervalMs: 0,
	maxParallel: 1,
	terminalRetentionMs: 60_000,
	dedupeKey: params => String(params.key ?? ''),
};

test('the enrichment type settles a cancelled job into the cancelled state, with no error', async () => {
	const release = deferred();
	const workflow = {
		async run(_job, ctx) {
			await release.promise;
			ctx.throwIfAborted();
			return { status: 'done' };
		},
	};
	const { backend, store } = backendFor(workflow, { type: ENRICHMENT_TYPE, config: enrichmentConfig });

	const job = await backend.enqueue({ key: 'note:a.md' });
	const running = backend.runJob(job.id);
	await flush();

	const cancelling = backend.cancelJob(job.id);
	assert.equal(backend.isCancelling(job.id), true);
	release.resolve();

	assert.equal(await cancelling, 'cancelled');
	assert.equal(await running, 'ran');
	assert.equal(store.get(job.id).status, 'cancelled');
	assert.equal(store.get(job.id).error, undefined, 'cancelled jobs carry no error');
});

test('cancelling a queued enrichment job reports not-running', async () => {
	const workflow = { async run() { return { status: 'done' }; } };
	const { backend } = backendFor(workflow, { type: ENRICHMENT_TYPE, config: enrichmentConfig });

	const job = await backend.enqueue({ key: 'note:b.md' });
	assert.equal(await backend.cancelJob(job.id), 'not-running',
		'queued work is removed by a queue operation, not by an abort');
});

test("enqueue() returns a job that reports its real (queued) status", async () => {
	const workflow = { async run() { return { status: 'done' }; } };
	const { backend, store } = backendFor(workflow, { type: ENRICHMENT_TYPE, config: enrichmentConfig });

	const job = await backend.enqueue({ key: 'note:c.md' });
	assert.equal(job.status, 'queued',
		'the job has not been claimed yet — the memory backend used to hardcode "running" for every caller');

	// Sanity: the same job really does flip to running once actually claimed.
	assert.equal(store.claimById(job.id, Date.now()).status, 'running');
});

// --- stopJob's claim-window honesty ------------------------------------------
//
// Between a drain claiming a job and that claim registering the run in `running`, the
// job used to be invisible to both, and a cancelJob() landing in that window answered
// 'not-running' for a job that then visibly started. On the markdown queue the window
// was JobStore.move's cache write-barrier (up to ~2s); here the claim is a synchronous
// guarded UPDATE and `execute` reaches `running.begin()` with no await in between, so
// the window is a single JS turn and cannot be opened from outside. The guard is kept
// anyway (see `claiming` in DbJobBackend), because a future await inserted anywhere in
// that path would silently reopen the bug — so the guard itself is what this pins,
// by placing an id in the claiming map the way a claim does.

test('cancelJob waits out an in-flight claim instead of answering not-running', async () => {
	const workflow = { async run() { return { status: 'done' }; } };
	const { backend } = backendFor(workflow);

	backend.registerClaiming('job-race');

	let cancelSettled = false;
	const cancelling = backend.cancelJob('job-race').then(outcome => { cancelSettled = true; return outcome; });
	await flush();
	assert.equal(cancelSettled, false,
		'a claim is in flight for this id; cancelJob must wait it out rather than answer immediately');

	// The claim lands: `execute` registers the run, then settles the claim.
	const run = backend.running.begin('job-race');
	backend.settleClaiming('job-race');
	await flush();
	assert.equal(cancelSettled, false, 'and it now waits on the RUN it just found, not on the claim');

	run.finish('cancelled');
	assert.equal(await cancelling, 'cancelled',
		'the job was a turn from running; reporting not-running here is the exact lie stopJob used to tell');
});

test('a cancelJob issued before any claim starts is unaffected — still an immediate not-running', async () => {
	const workflow = { async run() { return { status: 'done' }; } };
	const { backend } = backendFor(workflow);
	assert.equal(await backend.cancelJob('nobody-claimed-this'), 'not-running');
});

// --- the entry checkpoint is central ----------------------------------------

test('runWorkflowWithTimeout refuses to start a workflow cancelled before dispatch', async () => {
	let started = false;
	const workflow = { async run() { started = true; return { status: 'done' }; } };
	const controller = new AbortController();
	controller.abort(new JobCancelledError('cancelled before dispatch'));

	const result = await runWorkflowWithTimeout(makePlugin(), workflow, { id: 'j', type: TEST_TYPE }, 0, controller.signal);
	assert.equal(result.status, 'cancelled');
	assert.equal(started, false, 'every workflow gets an entry checkpoint for free');
});
