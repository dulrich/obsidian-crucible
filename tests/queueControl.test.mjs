import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-queuecontrol-tests');
const outfile = path.join(outdir, 'queueControl.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// One bundle over the whole control path — both backends, the Orchestrator's dispatch
// and the autorunner's entry points — so these exercise the real wiring rather than a
// re-implementation of it. Mirrors tests/workflowCancellation.test.mjs, which covers
// the abort mechanism these build on.
await esbuild.build({
	stdin: {
		contents: [
			"export * from './src/orchestration/cancellation';",
			"export { FileJobBackend } from './src/orchestration/FileJobBackend';",
			"export { Orchestrator } from './src/orchestration/Orchestrator';",
			"export { OrchestrationAutoRunner } from './src/orchestration/OrchestrationAutoRunner';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'queue-control-test-entry.ts',
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
					'globalThis.__queueControlNotices = globalThis.__queueControlNotices ?? [];',
					'export class Notice { constructor(message) { globalThis.__queueControlNotices.push(message); } }',
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

// The memory backend is reached through Orchestrator.register (which builds it from
// the type's `persistence`), so these go through the same dispatch the UI does rather
// than constructing a backend directly.
const {
	FileJobBackend,
	Orchestrator,
	OrchestrationAutoRunner,
} = await import(pathToFileURL(outfile).href);

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred() {
	let resolve;
	const promise = new Promise(r => { resolve = r; });
	return { promise, resolve };
}

// A minimal in-memory JobStore: enough surface for the backends to move a job between
// buckets. `failMoveFor` makes the move *into cancelled/* throw without the job
// leaving its bucket, which is exactly what the real JobStore.move guarantees when the
// frontmatter write fails and it rolls the rename back. Scoped to that one transition
// so the same job can still be claimed and run normally afterwards — which is the
// whole content of the invariant.
function makeStore(initial = {}) {
	const folders = {
		queued: [...(initial.queued ?? [])],
		running: [...(initial.running ?? [])],
		done: [],
		failed: [],
		cancelled: [],
	};
	const notes = [];
	const store = {
		folders,
		notes,
		failMoveFor: initial.failMoveFor ?? null,
		ensureFolders: async () => {},
		listFolder: async (status) => [...(folders[status] ?? [])],
		appendNotes: async (file, lines) => { notes.push({ file, lines }); },
		setError: async () => {},
		setOutputPaths: async () => {},
		setPartial: async () => {},
		setDeferred: async () => {},
		setProgress: async () => {},
		move: async (file, job, toStatus) => {
			if (store.failMoveFor === job.id && toStatus === 'cancelled') {
				// Rolled back: the job is still exactly where it was.
				throw new Error(`frontmatter write failed for ${job.id}`);
			}
			for (const bucket of Object.values(folders)) {
				const idx = bucket.findIndex(e => e.file === file);
				if (idx >= 0) bucket.splice(idx, 1);
			}
			const moved = { file, job: { ...job, status: toStatus } };
			folders[toStatus].push(moved);
			return moved;
		},
	};
	return store;
}

function makeBus() {
	const emitted = [];
	return {
		emitted,
		on: () => () => {},
		emit: (name, payload) => { emitted.push({ name, payload }); },
		count: name => emitted.filter(e => e.name === name).length,
	};
}

// `settings` is pulled out of the overrides before the spread on purpose: spreading
// the whole override object last would replace the merged settings wholesale, and a
// plugin silently missing `orchestrationEnabled` makes every drain answer 'disabled'
// while the test looks like a deadlock.
function makePlugin({ settings, ...overrides } = {}) {
	return {
		settings: {
			orchestrationEnabled: true,
			orchestrationQueueEnabled: true,
			orchestrationAutorunTimeoutSeconds: 0,
			orchestrationMaxConcurrent: 8,
			orchestrationJobTypeControls: {},
			orchestrationRoutineNoticesEnabled: {},
			...(settings ?? {}),
		},
		ingestionEvents: null,
		orchestrationAutoRunner: null,
		app: {
			vault: { getAbstractFileByPath: () => null },
			workspace: { onLayoutReady: () => { /* never fires: no 5s file-drain timer in tests */ } },
		},
		...overrides,
	};
}

// `command_run` throughout: FileJobBackend.isWorkflowEnabled has no settings toggle for
// it, so these exercise the control path rather than the enablement gate.
const TEST_TYPE = 'command_run';
const TEST_CONFIG = { persistence: 'file', minIntervalMs: 0, maxParallel: 1 };

function queuedEntry(id) {
	return { file: { path: `queue/inbox/${id}.md` }, job: { id, type: TEST_TYPE, status: 'queued', params: {} } };
}

function fileBackend(workflow, { store = makeStore(), plugin = makePlugin(), config = TEST_CONFIG } = {}) {
	return { backend: new FileJobBackend(plugin, store, TEST_TYPE, config, workflow), store, plugin };
}

const inertWorkflow = { async run() { return { status: 'done' }; } };

// --- 1. cancelling a queued job removes it, and it does not later drain ------

test('cancelling a queued job removes it from the queue and it never drains', async () => {
	const ran = [];
	const workflow = { async run(job) { ran.push(job.id); return { status: 'done' }; } };
	const store = makeStore({ queued: [queuedEntry('job-a'), queuedEntry('job-b')] });
	const plugin = makePlugin();
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(TEST_TYPE, workflow, TEST_CONFIG);
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	assert.equal(await runner.stopJob(TEST_TYPE, 'job-a'), 'removed');
	assert.equal(store.folders.queued.length, 1, 'only the cancelled job left the queue');
	assert.equal(store.folders.cancelled.length, 1, 'a job stopped before it ran lands in cancelled/, not failed/');
	assert.equal(store.folders.failed.length, 0);
	assert.equal(store.folders.cancelled[0].job.id, 'job-a');
	assert.match(store.notes.at(-1).lines, /before it ran/, 'the job file records why it stopped');

	// The point of the test: draining afterwards must not resurrect it.
	assert.equal(await orchestrator.runNextOfType(TEST_TYPE), 'ran');
	assert.equal(await orchestrator.runNextOfType(TEST_TYPE), 'empty');
	assert.deepEqual(ran, ['job-b'], 'the cancelled job never executed');

	runner.dispose();
});

test('a queued memory entry is stopped by the same one Cancel verb', async () => {
	const plugin = makePlugin();
	const orchestrator = new Orchestrator(plugin, makeStore());
	orchestrator.register('youtube_metadata_fetch', inertWorkflow, {
		persistence: 'memory',
		minIntervalMs: 0,
		maxParallel: 1,
		dedupeKey: params => String(params.key ?? ''),
	});
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	await orchestrator.enqueue('youtube_metadata_fetch', { key: 'note:a.md' });
	assert.equal(await runner.stopJob('youtube_metadata_fetch', 'note:a.md'), 'removed');

	const queue = orchestrator.getMemoryQueue('youtube_metadata_fetch');
	assert.equal(queue.getEntry('note:a.md').status, 'cancelled');
	assert.equal(queue.hasPending(), false, 'nothing left to drain');

	assert.equal(await runner.stopJob('youtube_metadata_fetch', 'note:a.md'), 'not-found',
		'a second Cancel on an already-stopped entry says so rather than claiming a stop');

	runner.dispose();
});

// --- 2. cancelling a running job routes through the WP-A abort --------------

test('cancelling a running job settles into cancelled/, not failed/', async () => {
	const release = deferred();
	const iterations = [];
	const workflow = {
		async run(_job, ctx) {
			for (let i = 0; i < 4; i++) {
				ctx.throwIfAborted();
				iterations.push(i);
				if (i === 0) await release.promise;
			}
			return { status: 'done' };
		},
	};

	const entry = { file: { path: 'queue/running/job-run.md' }, job: { id: 'job-run', type: TEST_TYPE, status: 'running', params: {} } };
	const store = makeStore({ running: [entry] });
	const plugin = makePlugin();
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(TEST_TYPE, workflow, TEST_CONFIG);
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	const execution = orchestrator.backends.get(TEST_TYPE).execute(entry);
	await flush();

	const stopping = runner.stopJob(TEST_TYPE, 'job-run');
	assert.equal(orchestrator.isCancelling(TEST_TYPE, 'job-run'), true,
		'the row renders "Stopping…" off exactly this, so it survives a table refresh');

	release.resolve();
	assert.equal(await stopping, 'cancelled');
	await execution;

	assert.deepEqual(iterations, [0], 'stopped at the checkpoint after the iteration in flight');
	assert.equal(store.folders.cancelled.length, 1);
	assert.equal(store.folders.failed.length, 0, 'a cancel must not pollute failure diagnostics');
	assert.equal(orchestrator.isCancelling(TEST_TYPE, 'job-run'), false, 'settled, so the button goes live again');

	runner.dispose();
});

// --- 3. 'completed' is surfaced distinctly from 'cancelled' -----------------

test('a checkpoint-less workflow reports completed, never cancelled — the honest-copy guard', async () => {
	const release = deferred();
	const workflow = {
		async run() {
			// Never looks at the signal. There is no reachable checkpoint, so the work
			// finishes; claiming it was "stopped" would be a lie the UI would repeat.
			await release.promise;
			return { status: 'done', notes: 'finished regardless' };
		},
	};

	const entry = { file: { path: 'queue/running/job-deaf.md' }, job: { id: 'job-deaf', type: TEST_TYPE, status: 'running', params: {} } };
	const store = makeStore({ running: [entry] });
	const plugin = makePlugin();
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(TEST_TYPE, workflow, TEST_CONFIG);
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	const execution = orchestrator.backends.get(TEST_TYPE).execute(entry);
	await flush();
	const stopping = runner.stopJob(TEST_TYPE, 'job-deaf');
	release.resolve();

	const outcome = await stopping;
	assert.equal(outcome, 'completed');
	assert.notEqual(outcome, 'cancelled',
		'the two must stay distinguishable at the seam, or no UI copy can tell them apart');
	await execution;

	assert.equal(store.folders.done.length, 1, 'work that finished is recorded as done');
	assert.equal(store.folders.cancelled.length, 0);

	// And the queue-monitor copy for the two outcomes must not converge. This is the
	// exact regression the requirement guards: 'completed' quietly becoming "Stopped".
	const copy = {
		cancelled: 'Stopped.',
		completed: 'Finished before it could be stopped.',
		removed: 'Removed from the queue before it ran.',
		failed: 'Could not cancel that job; it is still queued.',
		'not-found': 'That job is no longer queued or running.',
	};
	assert.notEqual(copy.completed, copy.cancelled);
	assert.doesNotMatch(copy.completed, /^Stopped/, "'completed' must not be dressed up as a stop");

	runner.dispose();
});

// --- 4. clear reaches past the monitor's 100-row display cap ----------------

test('clearing the queue clears every job, not just the 100 the table renders', async () => {
	// QUEUE_MONITOR_RENDER_LIMIT is 100 (queueMonitor.ts); a search rebuild routinely
	// enqueues more than that, so a clear driven off rendered rows would silently
	// leave the remainder queued.
	const SEEDED = 250;
	const queued = Array.from({ length: SEEDED }, (_, i) => queuedEntry(`job-${String(i).padStart(3, '0')}`));
	const store = makeStore({ queued });
	const plugin = makePlugin();
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(TEST_TYPE, inertWorkflow, TEST_CONFIG);

	assert.equal(await orchestrator.clearQueued(), SEEDED);
	assert.equal(store.folders.queued.length, 0, 'nothing left behind past the display cap');
	assert.equal(store.folders.cancelled.length, SEEDED);
	assert.equal(await orchestrator.runNextOfType(TEST_TYPE), 'empty', 'and none of them drains afterwards');
});

test('clearing leaves running jobs alone — stopping those is Cancel on the row', async () => {
	const running = { file: { path: 'queue/running/job-live.md' }, job: { id: 'job-live', type: TEST_TYPE, status: 'running', params: {} } };
	const store = makeStore({ queued: [queuedEntry('job-q')], running: [running] });
	const orchestrator = new Orchestrator(makePlugin(), store);
	orchestrator.register(TEST_TYPE, inertWorkflow, TEST_CONFIG);

	assert.equal(await orchestrator.clearQueued(), 1);
	assert.equal(store.folders.running.length, 1);
	assert.equal(store.folders.running[0].job.id, 'job-live');
});

// --- 5. one event for the whole clear, not one per job ---------------------

test('a bulk clear emits exactly one orchestration-queue-updated', async () => {
	const bus = makeBus();
	const queued = Array.from({ length: 40 }, (_, i) => queuedEntry(`job-${i}`));
	const store = makeStore({ queued });
	const plugin = makePlugin({ ingestionEvents: bus });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(TEST_TYPE, inertWorkflow, TEST_CONFIG);

	assert.equal(await orchestrator.clearQueued(), 40);
	assert.equal(bus.count('orchestration-queue-updated'), 1,
		'every emit costs each listener a full listFolder re-read plus a kickAll(); 40 of them for one click is the bug');
	assert.deepEqual(bus.emitted.at(-1).payload, { queued: 0, running: 0 },
		'and the one emit carries the state after the whole clear');
});

test('a clear that removes nothing emits nothing', async () => {
	const bus = makeBus();
	const orchestrator = new Orchestrator(makePlugin({ ingestionEvents: bus }), makeStore());
	orchestrator.register(TEST_TYPE, inertWorkflow, TEST_CONFIG);

	assert.equal(await orchestrator.clearQueued(), 0);
	assert.equal(bus.count('orchestration-queue-updated'), 0);
});

test('a single-row cancel emits once', async () => {
	const bus = makeBus();
	const store = makeStore({ queued: [queuedEntry('job-a'), queuedEntry('job-b')] });
	const orchestrator = new Orchestrator(makePlugin({ ingestionEvents: bus }), store);
	orchestrator.register(TEST_TYPE, inertWorkflow, TEST_CONFIG);

	assert.equal(await orchestrator.removeQueuedJob(TEST_TYPE, 'job-a'), 'removed');
	assert.equal(bus.count('orchestration-queue-updated'), 1);
});

// --- 6. JobStore.move's rollback invariant --------------------------------

test('a rolled-back move leaves the job queued, and the caller does not report success', async () => {
	const store = makeStore({ queued: [queuedEntry('job-stuck')], failMoveFor: 'job-stuck' });
	const plugin = makePlugin();
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(TEST_TYPE, inertWorkflow, TEST_CONFIG);
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	assert.equal(await orchestrator.removeQueuedJob(TEST_TYPE, 'job-stuck'), 'failed');
	assert.equal(store.folders.queued.length, 1, 'the job stayed fully in its prior bucket');
	assert.equal(store.folders.cancelled.length, 0, 'and emphatically did not half-move');

	// The whole point: neither "stopped" nor "gone". Both would be wrong about a job
	// the user can still see sitting in the table.
	const outcome = await runner.stopJob(TEST_TYPE, 'job-stuck');
	assert.equal(outcome, 'failed');
	assert.notEqual(outcome, 'removed');
	assert.notEqual(outcome, 'not-found');

	// It is still claimable and still runs, because nothing about it changed.
	assert.equal(await orchestrator.runNextOfType(TEST_TYPE), 'ran');

	runner.dispose();
});

test('one refused job does not abort the clear for the rest of the queue', async () => {
	const queued = ['job-0', 'job-1', 'job-2', 'job-3'].map(queuedEntry);
	const store = makeStore({ queued, failMoveFor: 'job-1' });
	const orchestrator = new Orchestrator(makePlugin(), store);
	orchestrator.register(TEST_TYPE, inertWorkflow, TEST_CONFIG);

	assert.equal(await orchestrator.clearQueued(), 3, 'the refused job is not counted as cleared');
	assert.deepEqual(store.folders.queued.map(e => e.job.id), ['job-1']);
	assert.equal(store.folders.cancelled.length, 3);
});

// --- the claim guard ------------------------------------------------------

test('a job a worker has already claimed is not retired out from under it', async () => {
	const started = deferred();
	const release = deferred();
	const workflow = {
		async run() {
			started.resolve();
			await release.promise;
			return { status: 'done' };
		},
	};
	const store = makeStore({ queued: [queuedEntry('job-claimed')] });
	const { backend } = fileBackend(workflow, { store });

	const draining = backend.runNext();
	await started.promise;

	// By now the drain has moved it to running/, where removal correctly declines and
	// cancelJob is the mechanism that applies.
	assert.equal(await backend.removeQueued('job-claimed'), 'not-queued');
	assert.equal(store.folders.running.length, 1);

	release.resolve();
	assert.equal(await draining, 'ran');
	assert.equal(store.folders.done.length, 1);
});

test('stopJob prefers the abort over removal, so a job mid-claim is not deleted', async () => {
	const release = deferred();
	const workflow = {
		async run(_job, ctx) {
			await release.promise;
			ctx.throwIfAborted();
			return { status: 'done' };
		},
	};
	const entry = { file: { path: 'queue/running/job-both.md' }, job: { id: 'job-both', type: TEST_TYPE, status: 'running', params: {} } };
	// The same id also sits in queued/ — impossible in practice, but it pins the
	// ordering: the running job must win, not the queued lookup.
	const store = makeStore({ running: [entry], queued: [queuedEntry('job-both')] });
	const plugin = makePlugin();
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(TEST_TYPE, workflow, TEST_CONFIG);
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	const execution = orchestrator.backends.get(TEST_TYPE).execute(entry);
	await flush();
	const stopping = runner.stopJob(TEST_TYPE, 'job-both');
	release.resolve();

	assert.equal(await stopping, 'cancelled', 'the abort answered, so removal was never attempted');
	await execution;
	assert.equal(store.folders.queued.length, 1, 'the queued lookalike is untouched');

	runner.dispose();
});

// --- 7. per-type concurrency reaches the drain loop -----------------------

// Runs `queuedCount` jobs of one type through a real drain and reports the highest
// number that were ever in flight at once.
async function measurePeakConcurrency({ queuedCount, config, controls }) {
	const queued = Array.from({ length: queuedCount }, (_, i) => queuedEntry(`job-${i}`));
	const store = makeStore({ queued });
	let inFlight = 0;
	let peak = 0;
	const workflow = {
		async run() {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise(resolve => setTimeout(resolve, 5));
			inFlight--;
			return { status: 'done' };
		},
	};

	const plugin = makePlugin({ settings: { orchestrationJobTypeControls: controls } });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(TEST_TYPE, workflow, config);
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	// Manual drain: bypasses the auto-run gate (and the 5s file-drain delay) while
	// still going through drainType, which is where the worker count is computed.
	runner.runType(TEST_TYPE);
	for (let i = 0; i < 500 && store.folders.done.length < queuedCount; i++) await flush();

	runner.dispose();
	return { peak, done: store.folders.done.length };
}

test('readTypeMaxParallelOverride is honoured by the drain loop', async () => {
	const withoutOverride = await measurePeakConcurrency({ queuedCount: 6, config: TEST_CONFIG, controls: {} });
	assert.equal(withoutOverride.done, 6);
	assert.equal(withoutOverride.peak, 1, 'the configured default is one worker, as every file type ships today');

	const withOverride = await measurePeakConcurrency({
		queuedCount: 6,
		config: TEST_CONFIG,
		controls: { [TEST_TYPE]: { maxParallelOverride: 3 } },
	});
	assert.equal(withOverride.done, 6);
	assert.equal(withOverride.peak, 3, 'the override reached the drain, live, with no re-registration');
});

test('a maxParallelFixed type ignores the override rather than obeying it', async () => {
	const serialConfig = {
		...TEST_CONFIG,
		maxParallelFixed: 'one fan-out at a time: concurrent runs would double the batch count for identical work',
	};
	const result = await measurePeakConcurrency({
		queuedCount: 5,
		config: serialConfig,
		controls: { [TEST_TYPE]: { maxParallelOverride: 4 } },
	});
	assert.equal(result.done, 5);
	assert.equal(result.peak, 1,
		'a pinned type stays single-flight; the UI shows a serial pill rather than a number the runner would ignore');
});

test('the global concurrency cap still bounds a raised per-type worker count', async () => {
	const queued = Array.from({ length: 8 }, (_, i) => queuedEntry(`job-${i}`));
	const store = makeStore({ queued });
	let inFlight = 0;
	let peak = 0;
	const workflow = {
		async run() {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise(resolve => setTimeout(resolve, 5));
			inFlight--;
			return { status: 'done' };
		},
	};

	const plugin = makePlugin({
		settings: {
			orchestrationMaxConcurrent: 2,
			orchestrationJobTypeControls: { [TEST_TYPE]: { maxParallelOverride: 6 } },
		},
	});
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(TEST_TYPE, workflow, TEST_CONFIG);
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	runner.runType(TEST_TYPE);
	for (let i = 0; i < 500 && store.folders.done.length < 8; i++) await flush();

	assert.equal(store.folders.done.length, 8);
	assert.equal(peak, 2, 'six workers, but the global semaphore only ever lets two run — the ceiling the UI names');

	runner.dispose();
});
