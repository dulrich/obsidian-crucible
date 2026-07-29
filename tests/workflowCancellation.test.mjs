import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-cancellation-tests');
const outfile = path.join(outdir, 'cancellation.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// One bundle over the whole cancellation path — the seam, both backends, the
// orchestrator's stale sweep, and the real NoteLockManager — so the tests exercise
// the wiring rather than a re-implementation of it.
await esbuild.build({
	stdin: {
		contents: [
			"export * from './src/orchestration/cancellation';",
			"export * from './src/orchestration/JobBackend';",
			"export { FileJobBackend } from './src/orchestration/FileJobBackend';",
			"export { MemoryJobBackend } from './src/orchestration/MemoryJobBackend';",
			"export { Orchestrator } from './src/orchestration/Orchestrator';",
			"export { NoteLockManager } from './src/orchestration/NoteLockManager';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'cancellation-test-entry.ts',
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
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
	FileJobBackend,
	MemoryJobBackend,
	NoteLockManager,
	Orchestrator,
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

// A minimal in-memory JobStore: enough surface for FileJobBackend.execute() to move
// a job between buckets and for Orchestrator.scan() to sweep them.
function makeStore(initial = {}) {
	const folders = {
		queued: [...(initial.queued ?? [])],
		running: [...(initial.running ?? [])],
		done: [],
		failed: [],
		cancelled: [],
	};
	const notes = [];
	const errors = [];
	return {
		folders,
		notes,
		errors,
		ensureFolders: async () => {},
		listFolder: async (status) => folders[status] ?? [],
		countFolder: (status) => (folders[status] ?? []).length,
		appendNotes: async (file, lines) => { notes.push({ file, lines }); },
		setError: async (file, message) => { errors.push({ file, message }); },
		setOutputPaths: async () => {},
		setPartial: async () => {},
		setDeferred: async () => {},
		setProgress: async () => {},
		move: async (file, job, toStatus) => {
			for (const bucket of Object.values(folders)) {
				const idx = bucket.findIndex(e => e.file === file);
				if (idx >= 0) bucket.splice(idx, 1);
			}
			const moved = { file, job: { ...job, status: toStatus } };
			folders[toStatus].push(moved);
			return moved;
		},
	};
}

function makePlugin(overrides = {}) {
	return {
		settings: {
			orchestrationEnabled: true,
			orchestrationAutorunTimeoutSeconds: 0,
			orchestrationRoutineNoticesEnabled: {},
			...(overrides.settings ?? {}),
		},
		ingestionEvents: null,
		orchestrationAutoRunner: null,
		app: { vault: { getAbstractFileByPath: () => null } },
		...overrides,
	};
}

// `command_run` is the type used throughout: FileJobBackend.isWorkflowEnabled has no
// settings toggle for it, so it is enabled by default and the tests exercise the
// cancellation path rather than the enablement gate.
const TEST_TYPE = 'command_run';
const TEST_CONFIG = { persistence: 'file', minIntervalMs: 0, maxParallel: 1 };

function fileBackend(workflow, { store = makeStore(), plugin = makePlugin() } = {}) {
	const backend = new FileJobBackend(plugin, store, TEST_TYPE, TEST_CONFIG, workflow);
	return { backend, store, plugin };
}

// --- the pure classification -------------------------------------------------

test('applyCancellation leaves a result alone when nothing was cancelled', () => {
	const done = { status: 'done', notes: 'fine' };
	assert.equal(applyCancellation(done, false), done);
});

test('applyCancellation rewrites failed and deferred, but never done', () => {
	assert.equal(applyCancellation({ status: 'done', notes: 'wrote the note' }, true).status, 'done',
		'work that completed must not be reported as if it never happened');

	const failed = applyCancellation({ status: 'failed', error: 'chain blew up', failureReason: 'no-api-key' }, true);
	assert.equal(failed.status, 'cancelled');
	assert.equal(failed.error, undefined, 'a cancellation is not a diagnostic error');
	assert.equal(failed.failureReason, undefined);
	assert.match(failed.notes, /chain blew up/, 'the original message survives as a note');

	const deferred_ = applyCancellation({ status: 'deferred', notes: 'companion down', retryAfterMs: 30_000 }, true);
	assert.equal(deferred_.status, 'cancelled', 'a deferral would re-queue and resurrect cancelled work');
	assert.equal(deferred_.retryAfterMs, undefined);
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

	const file = { path: 'queue/running/job-1.md' };
	const job = { id: 'job-1', type: TEST_TYPE, status: 'running', params: {} };
	const store = makeStore({ running: [{ file, job }] });
	const { backend } = fileBackend(workflow, { store });

	const execution = runExecute(backend, { file, job });

	await reachedCheckpoint.promise;
	const cancelling = backend.cancelJob('job-1');
	assert.equal(backend.isCancelling('job-1'), true, 'still settling, so still off-limits to stale recovery');

	releaseWork.resolve();
	assert.equal(await cancelling, 'cancelled');
	await execution;

	assert.deepEqual(iterations, [0], 'the loop stopped at the checkpoint after the one in flight');
	assert.equal(store.folders.cancelled.length, 1, 'the job landed in the cancelled bucket');
	assert.equal(store.folders.failed.length, 0, 'and emphatically not in failed');
	assert.equal(store.folders.cancelled[0].job.status, 'cancelled');
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

	const file = { path: 'queue/running/job-lock.md' };
	const job = { id: 'job-lock', type: TEST_TYPE, status: 'running', params: {} };
	const store = makeStore({ running: [{ file, job }] });
	const { backend } = fileBackend(workflow, { store });

	const execution = runExecute(backend, { file, job });
	await inside.promise;
	assert.equal(locks.isLocked('notes/target.md'), true);

	const cancelling = backend.cancelJob('job-lock');
	release.resolve();
	assert.equal(await cancelling, 'cancelled');
	await execution;

	assert.equal(locks.isLocked('notes/target.md'), false,
		'the abort unwound through withLock\'s finally');
	assert.equal(store.folders.cancelled.length, 1);
});

// --- 3. stale recovery must not resurrect a cancelling job ------------------

test('Orchestrator.scan() does not resurrect a cancelled job that is still settling', async () => {
	const stale = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
	const file = { path: 'queue/running/job-stale.md' };
	const job = { id: 'job-stale', type: TEST_TYPE, status: 'running', created: stale, updated: stale, params: {} };
	const store = makeStore({ running: [{ file, job }] });

	const hold = deferred();
	const workflow = {
		async run(_job, ctx) {
			await hold.promise;
			ctx.throwIfAborted();
			return { status: 'done' };
		},
	};

	const plugin = makePlugin();
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(TEST_TYPE, workflow, TEST_CONFIG);

	const execution = runExecuteViaBackend(orchestrator, TEST_TYPE, { file, job });
	await flush();

	const cancelling = orchestrator.cancelJob(TEST_TYPE, 'job-stale');
	assert.equal(orchestrator.isCancelling(TEST_TYPE, 'job-stale'), true);

	// The job is well past the stale cutoff, so without the guard this sweep would
	// bounce it running → queued and the work would run a second time.
	const midFlight = await orchestrator.scan({ notify: false });
	assert.equal(midFlight.recovered, 0, 'a live, cancelling run is not stale');
	assert.equal(store.folders.running.length, 1);
	assert.equal(store.folders.queued.length, 0, 'never re-queued');

	hold.resolve();
	assert.equal(await cancelling, 'cancelled');
	await execution;
	assert.equal(store.folders.cancelled.length, 1);

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

	const file = { path: 'queue/running/job-deaf.md' };
	const job = { id: 'job-deaf', type: TEST_TYPE, status: 'running', params: {} };
	const store = makeStore({ running: [{ file, job }] });
	const { backend } = fileBackend(workflow, { store });

	const execution = runExecute(backend, { file, job });
	await flush();

	const cancelling = backend.cancelJob('job-deaf');
	release.resolve();

	// The contract: the cancel resolves rather than hanging, and reports honestly
	// that the run finished before it could be stopped.
	assert.equal(await cancelling, 'completed');
	await execution;

	assert.equal(observed, true, 'the signal was raised; the workflow simply never checked it');
	assert.equal(store.folders.done.length, 1, 'completed work is recorded as done, not as cancelled');
	assert.equal(store.folders.cancelled.length, 0);
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

	const file = { path: 'queue/running/job-swallow.md' };
	const job = { id: 'job-swallow', type: TEST_TYPE, status: 'running', params: {} };
	const store = makeStore({ running: [{ file, job }] });
	const { backend } = fileBackend(workflow, { store });

	const execution = runExecute(backend, { file, job });
	await flush();
	const cancelling = backend.cancelJob('job-swallow');
	release.resolve();

	assert.equal(await cancelling, 'cancelled');
	await execution;
	assert.equal(store.folders.failed.length, 0, 'a cancel must not pollute failure diagnostics');
	assert.equal(store.folders.cancelled.length, 1);
});

// --- the memory backend takes the same path ---------------------------------

test('the memory backend settles a cancelled entry into the cancelled state', async () => {
	const release = deferred();
	const workflow = {
		async run(_job, ctx) {
			await release.promise;
			ctx.throwIfAborted();
			return { status: 'done' };
		},
	};
	const plugin = makePlugin();
	const backend = new MemoryJobBackend(plugin, 'youtube_metadata_fetch', {
		persistence: 'memory',
		minIntervalMs: 0,
		maxParallel: 1,
		terminalRetentionMs: 60_000,
		dedupeKey: params => String(params.key ?? ''),
	}, workflow);

	await backend.enqueue({ key: 'note:a.md' });
	const running = backend.runJob('note:a.md');
	await flush();

	const cancelling = backend.cancelJob('note:a.md');
	assert.equal(backend.isCancelling('note:a.md'), true);
	release.resolve();

	assert.equal(await cancelling, 'cancelled');
	assert.equal(await running, 'ran');
	assert.equal(backend.getQueue().getEntry('note:a.md').status, 'cancelled');
	assert.equal(backend.getQueue().getEntry('note:a.md').error, undefined,
		'cancelled entries carry no error');
});

test('cancelling a pending memory entry reports not-running', async () => {
	const workflow = { async run() { return { status: 'done' }; } };
	const backend = new MemoryJobBackend(makePlugin(), 'youtube_metadata_fetch', {
		persistence: 'memory',
		minIntervalMs: 0,
		maxParallel: 1,
		dedupeKey: params => String(params.key ?? ''),
	}, workflow);
	await backend.enqueue({ key: 'note:b.md' });
	assert.equal(await backend.cancelJob('note:b.md'), 'not-running',
		'queued work is removed by a queue operation, not by an abort');
});

// --- R1: MemoryJobBackend.synthJob reports live state, not a hardcoded 'running' -

test("enqueue() returns a job that reports the entry's real (queued) status", async () => {
	const workflow = { async run() { return { status: 'done' }; } };
	const backend = new MemoryJobBackend(makePlugin(), 'youtube_metadata_fetch', {
		persistence: 'memory',
		minIntervalMs: 0,
		maxParallel: 1,
		dedupeKey: params => String(params.key ?? ''),
	}, workflow);

	const job = await backend.enqueue({ key: 'note:c.md' });
	assert.equal(job.status, 'queued',
		'the entry has not been claimed yet — synthJob used to hardcode "running" for every caller');

	// Sanity: the same entry really does flip to running once actually claimed.
	const claimed = backend.getQueue().claimEntry('note:c.md');
	assert.equal(claimed.status, 'running');
});

// --- R2: stopJob's claim-window honesty --------------------------------------
//
// Between a drain claiming a job (removing it from `queued`) and that claim actually
// registering the run in `running`, the job used to be invisible to both — file-side
// this is JobStore.move's cache write-barrier window (up to ~2s), memory-side it is
// the near-instant gap before RunningJobRegistry.begin() runs. A cancelJob() landing
// in that window used to answer 'not-running' for a job that then visibly started.

test('FileJobBackend.cancelJob waits out an in-flight claim instead of answering not-running', async () => {
	const file = { path: 'queue/queued/job-race.md' };
	const job = { id: 'job-race', type: TEST_TYPE, status: 'queued', params: {} };
	const store = makeStore({ queued: [{ file, job }] });

	// Simulate JobStore.move's cache write-barrier: the claim (queued → running) does
	// not land until the test explicitly releases it.
	const moveGate = deferred();
	const realMove = store.move;
	store.move = async (f, j, toStatus) => {
		await moveGate.promise;
		return realMove(f, j, toStatus);
	};

	const workflow = { async run() { return { status: 'done' }; } };
	const { backend } = fileBackend(workflow, { store });

	const drain = backend.runNext(); // starts claiming; blocks inside the slowed move
	await flush();
	await flush();

	let cancelSettled = false;
	const cancelling = backend.cancelJob('job-race').then(outcome => { cancelSettled = true; return outcome; });
	await flush();
	assert.equal(cancelSettled, false,
		'a claim is in flight for this id; cancelJob must wait it out rather than answer immediately');

	moveGate.resolve(); // let the claim land
	const outcome = await cancelling;
	assert.notEqual(outcome, 'not-running',
		'the job was seconds from running; reporting not-running here is the exact lie stopJob used to tell');
	assert.ok(outcome === 'cancelled' || outcome === 'completed',
		`expected an honest terminal cancel outcome, got ${outcome}`);

	await drain;
	const settledCount = store.folders.running.length + store.folders.cancelled.length + store.folders.done.length;
	assert.equal(settledCount, 1, 'the job landed somewhere real — it did not vanish mid-claim');
});

test('a cancelJob issued before any claim starts is unaffected — still an immediate not-running', async () => {
	const store = makeStore({ queued: [] });
	const workflow = { async run() { return { status: 'done' }; } };
	const { backend } = fileBackend(workflow, { store });
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

// FileJobBackend.execute is private; the drain reaches it through runJob's claim,
// which needs a real vault. Calling it directly is the narrowest way to exercise the
// settle path without rebuilding JobStore's folder semantics in the test.
function runExecute(backend, moved) {
	return backend.execute(moved);
}

function runExecuteViaBackend(orchestrator, type, moved) {
	return orchestrator.backends.get(type).execute(moved);
}
