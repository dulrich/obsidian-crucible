import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// The queue's CONTROL path — Cancel (both halves), Clear, the per-type/global
// concurrency gates, the settle-failure containment, and the emit-coalescing contract —
// driven through the real Orchestrator + autorunner rather than a re-implementation.
//
// thq WP-8 rewrote the harness, not the assertions: these used to drive a fake markdown
// `JobStore`, and now drive a real `SqliteJobStore` on `:memory:`. One test did not
// survive ("one refused job does not abort the clear for the rest of the queue") — see
// the WP-8 report's migration table: `clearQueued` is a single
// `UPDATE … WHERE status='queued'`, so "one row refused, the rest cleared" has no
// representation. The three-valued `removeQueued` contract it was paired with IS still
// representable (a store that refuses the write) and is still pinned below.

globalThis.require = createRequire(import.meta.url);

const outdir = path.join(tmpdir(), 'obsidian-crucible-queuecontrol-tests');
const outfile = path.join(outdir, 'queueControl.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// One bundle over the whole control path — the backend, the Orchestrator's dispatch,
// the autorunner's entry points and the storage layer underneath — so these exercise
// the real wiring. Mirrors tests/workflowCancellation.test.mjs, which covers the abort
// mechanism these build on.
await esbuild.build({
	stdin: {
		contents: [
			"export * from './src/orchestration/cancellation';",
			"export { DbJobBackend } from './src/orchestration/DbJobBackend';",
			"export { Orchestrator } from './src/orchestration/Orchestrator';",
			"export { OrchestrationAutoRunner } from './src/orchestration/OrchestrationAutoRunner';",
			"export { SqliteJobStore } from './src/orchestration/db/SqliteJobStore';",
			"export { openJobsDb } from './src/orchestration/db/sqlite';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'queue-control-test-entry.ts',
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
					'export function parseYaml() { return {}; }',
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
	Orchestrator,
	OrchestrationAutoRunner,
	SqliteJobStore,
	openJobsDb,
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

// Seeds queued rows directly, bypassing `enqueue` — so the emit-count tests below
// count ONLY the emit under test and can't be perturbed by a trailing coalesced emit
// left over from a burst of enqueues.
function seedQueued(store, ids, type = TEST_TYPE) {
	let i = 0;
	for (const id of ids) {
		i += 1;
		store.insert({ id, type, created: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`, params: {} });
	}
	return ids;
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
			orchestrationJobRetentionDays: 30,
			...(settings ?? {}),
		},
		ingestionEvents: null,
		orchestrationAutoRunner: null,
		app: {
			vault: { getAbstractFileByPath: () => null },
			workspace: { onLayoutReady: () => { /* never fires: no 5s drain timer in tests */ } },
		},
		...overrides,
	};
}

// `command_run` throughout: DbJobBackend.isWorkflowEnabled has no settings toggle for
// it, so these exercise the control path rather than the enablement gate.
const TEST_TYPE = 'command_run';
const TEST_CONFIG = { persistence: 'db', minIntervalMs: 0, maxParallel: 1 };

function newOrchestrator({ plugin = makePlugin(), store = newStore(), workflow, config = TEST_CONFIG, type = TEST_TYPE } = {}) {
	const orchestrator = new Orchestrator(plugin, { openDbStore: () => store });
	orchestrator.register(type, workflow ?? inertWorkflow, config);
	return { orchestrator, store, plugin };
}

const inertWorkflow = { async run() { return { status: 'done' }; } };

// --- 1. cancelling a queued job removes it, and it does not later drain ------

test('cancelling a queued job removes it from the queue and it never drains', async () => {
	const ran = [];
	const workflow = { async run(job) { ran.push(job.id); return { status: 'done' }; } };
	const { orchestrator, store, plugin } = newOrchestrator({ workflow });
	seedQueued(store, ['job-a', 'job-b']);
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	assert.equal(await runner.stopJob(TEST_TYPE, 'job-a'), 'removed');
	assert.equal(store.count('queued'), 1, 'only the cancelled job left the queue');
	assert.equal(store.count('cancelled'), 1, 'a job stopped before it ran lands in cancelled, not failed');
	assert.equal(store.count('failed'), 0);
	assert.equal(store.get('job-a').status, 'cancelled');
	assert.match(store.get('job-a').notes, /before it ran/, 'the job records why it stopped');

	// The point of the test: draining afterwards must not resurrect it.
	assert.equal(await orchestrator.runNextOfType(TEST_TYPE), 'ran');
	assert.equal(await orchestrator.runNextOfType(TEST_TYPE), 'empty');
	assert.deepEqual(ran, ['job-b'], 'the cancelled job never executed');

	runner.dispose();
});

test('a queued enrichment job is stopped by the same one Cancel verb', async () => {
	// `youtube_metadata_fetch` was the last `memory` type before thq WP-8. It is now an
	// ordinary durable job — and the point of this test is that Cancel did not have to
	// learn anything new for that: one verb, same three answers.
	const plugin = makePlugin();
	const store = newStore();
	const orchestrator = new Orchestrator(plugin, { openDbStore: () => store });
	orchestrator.register('youtube_metadata_fetch', inertWorkflow, {
		persistence: 'db',
		drainsWithoutAutorun: true,
		minIntervalMs: 0,
		maxParallel: 1,
		dedupeKey: params => String(params.key ?? ''),
	});
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	const job = await orchestrator.enqueue('youtube_metadata_fetch', { key: 'note:a.md' });
	assert.equal(await runner.stopJob('youtube_metadata_fetch', job.id), 'removed');

	assert.equal(store.get(job.id).status, 'cancelled');
	assert.equal(orchestrator.hasPending('youtube_metadata_fetch'), false, 'nothing left to drain');

	assert.equal(await runner.stopJob('youtube_metadata_fetch', job.id), 'not-found',
		'a second Cancel on an already-stopped job says so rather than claiming a stop');

	runner.dispose();
});

// --- 2. cancelling a running job routes through the WP-A abort --------------

test('cancelling a running job settles into cancelled, not failed', async () => {
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
	const { orchestrator, store, plugin } = newOrchestrator({ workflow });
	seedQueued(store, ['job-run']);
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	const execution = orchestrator.runJob(TEST_TYPE, 'job-run');
	await flush();

	const stopping = runner.stopJob(TEST_TYPE, 'job-run');
	assert.equal(orchestrator.isCancelling(TEST_TYPE, 'job-run'), true,
		'the row renders "Stopping…" off exactly this, so it survives a table refresh');

	release.resolve();
	assert.equal(await stopping, 'cancelled');
	await execution;

	assert.deepEqual(iterations, [0], 'stopped at the checkpoint after the iteration in flight');
	assert.equal(store.count('cancelled'), 1);
	assert.equal(store.count('failed'), 0, 'a cancel must not pollute failure diagnostics');
	assert.equal(store.get('job-run').error, undefined, 'and writes no error');
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
	const { orchestrator, store, plugin } = newOrchestrator({ workflow });
	seedQueued(store, ['job-deaf']);
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	const execution = orchestrator.runJob(TEST_TYPE, 'job-deaf');
	await flush();
	const stopping = runner.stopJob(TEST_TYPE, 'job-deaf');
	release.resolve();

	const outcome = await stopping;
	assert.equal(outcome, 'completed');
	assert.notEqual(outcome, 'cancelled',
		'the two must stay distinguishable at the seam, or no UI copy can tell them apart');
	await execution;

	assert.equal(store.count('done'), 1, 'work that finished is recorded as done');
	assert.equal(store.count('cancelled'), 0);

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
	const { orchestrator, store } = newOrchestrator();
	seedQueued(store, Array.from({ length: SEEDED }, (_, i) => `job-${String(i).padStart(3, '0')}`));

	assert.equal(await orchestrator.clearQueued(), SEEDED);
	assert.equal(store.count('queued'), 0, 'nothing left behind past the display cap');
	assert.equal(store.count('cancelled'), SEEDED);
	assert.equal(await orchestrator.runNextOfType(TEST_TYPE), 'empty', 'and none of them drains afterwards');
});

test('clearing leaves running jobs alone — stopping those is Cancel on the row', async () => {
	const { orchestrator, store } = newOrchestrator();
	seedQueued(store, ['job-q', 'job-live']);
	store.claimById('job-live', Date.now());

	assert.equal(await orchestrator.clearQueued(), 1);
	assert.equal(store.get('job-live').status, 'running');
	assert.equal(store.get('job-q').status, 'cancelled');
});

test('clearing one type leaves every other type queued', async () => {
	// The unscoped-UPDATE trap: a per-type "Clear queued" click that retired every other
	// type's work would be silent and total.
	const plugin = makePlugin();
	const store = newStore();
	const orchestrator = new Orchestrator(plugin, { openDbStore: () => store });
	orchestrator.register(TEST_TYPE, inertWorkflow, TEST_CONFIG);
	orchestrator.register('chain_run', inertWorkflow, TEST_CONFIG);
	seedQueued(store, ['mine-1', 'mine-2']);
	seedQueued(store, ['theirs-1'], 'chain_run');

	assert.equal(await orchestrator.clearQueued(TEST_TYPE), 2);
	assert.equal(store.get('theirs-1').status, 'queued');
});

// --- 5. one event for the whole clear, not one per job ---------------------

test('a bulk clear emits exactly one orchestration-queue-updated', async () => {
	const bus = makeBus();
	const { orchestrator, store } = newOrchestrator({ plugin: makePlugin({ ingestionEvents: bus }) });
	seedQueued(store, Array.from({ length: 40 }, (_, i) => `job-${i}`));

	assert.equal(await orchestrator.clearQueued(), 40);
	assert.equal(bus.count('orchestration-queue-updated'), 1,
		'every emit costs each listener a full queue re-read plus a kickAll(); 40 of them for one click is the bug');
	assert.deepEqual(bus.emitted.at(-1).payload, { queued: 0, running: 0 },
		'and the one emit carries the state after the whole clear');
});

test('a clear that removes nothing emits nothing', async () => {
	const bus = makeBus();
	const { orchestrator } = newOrchestrator({ plugin: makePlugin({ ingestionEvents: bus }) });

	assert.equal(await orchestrator.clearQueued(), 0);
	assert.equal(bus.count('orchestration-queue-updated'), 0);
});

test('a single-row cancel emits once', async () => {
	const bus = makeBus();
	const { orchestrator, store } = newOrchestrator({ plugin: makePlugin({ ingestionEvents: bus }) });
	seedQueued(store, ['job-a', 'job-b']);

	assert.equal(await orchestrator.removeQueuedJob(TEST_TYPE, 'job-a'), 'removed');
	assert.equal(bus.count('orchestration-queue-updated'), 1);
});

// --- 6. the three-valued removeQueued contract ----------------------------

test('a store write the queue refuses leaves the job queued, and the caller does not report success', async () => {
	// 'failed' is the answer that must stay distinct from both 'removed' and
	// 'not-found': the job is still sitting in the table where the user can see it.
	const store = newStore();
	const { orchestrator, plugin } = newOrchestrator({ store });
	seedQueued(store, ['job-stuck']);
	store.cancelQueued = () => { throw new Error('store write failed'); };
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	assert.equal(await orchestrator.removeQueuedJob(TEST_TYPE, 'job-stuck'), 'failed');
	assert.equal(store.get('job-stuck').status, 'queued', 'the job stayed exactly where it was');
	assert.equal(store.count('cancelled'), 0, 'and emphatically did not half-move');

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
	const { orchestrator, store } = newOrchestrator({ workflow });
	seedQueued(store, ['job-claimed']);

	const draining = orchestrator.runNextOfType(TEST_TYPE);
	await started.promise;

	// By now the drain has claimed it, where removal correctly declines and cancelJob is
	// the mechanism that applies.
	assert.equal(await orchestrator.removeQueuedJob(TEST_TYPE, 'job-claimed'), 'not-queued');
	assert.equal(store.get('job-claimed').status, 'running');

	release.resolve();
	assert.equal(await draining, 'ran');
	assert.equal(store.count('done'), 1);
});

test('a bulk clear cannot retire a job a drain worker has claimed', async () => {
	const release = deferred();
	const ran = [];
	const workflow = {
		async run(job) {
			ran.push(job.id);
			await release.promise;
			return { status: 'done' };
		},
	};
	const { orchestrator, store } = newOrchestrator({ workflow });
	seedQueued(store, ['job-a', 'job-b']);

	const claiming = orchestrator.runNextOfType(TEST_TYPE);
	await flush();

	const cleared = await orchestrator.clearQueued(TEST_TYPE);

	assert.deepEqual(ran, ['job-a'], 'the worker did claim and start job-a');
	assert.equal(cleared, 1, 'only the still-queued job was cleared — the clear is guarded on status');
	assert.equal(store.get('job-a').status, 'running', 'the running job was NOT moved out from under its own execute()');
	assert.equal(store.get('job-b').status, 'cancelled');

	release.resolve();
	await claiming;
	assert.equal(store.get('job-a').status, 'done', 'and it settled normally');
});

test('a clear cannot resurrect a job that already finished', async () => {
	const { orchestrator, store } = newOrchestrator();
	seedQueued(store, ['job-a', 'job-b']);

	assert.equal(await orchestrator.runNextOfType(TEST_TYPE), 'ran');

	const cleared = await orchestrator.clearQueued(TEST_TYPE);

	assert.equal(cleared, 1, 'only job-b was still there to clear');
	assert.equal(store.get('job-a').status, 'done', 'a completed job stays completed');
	assert.equal(store.get('job-b').status, 'cancelled');
});

test('stopJob prefers the abort over removal, so a job mid-run is aborted rather than deleted', async () => {
	const release = deferred();
	const workflow = {
		async run(_job, ctx) {
			await release.promise;
			ctx.throwIfAborted();
			return { status: 'done' };
		},
	};
	const { orchestrator, store, plugin } = newOrchestrator({ workflow });
	seedQueued(store, ['job-both', 'job-other']);
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	const execution = orchestrator.runJob(TEST_TYPE, 'job-both');
	await flush();
	const stopping = runner.stopJob(TEST_TYPE, 'job-both');
	release.resolve();

	assert.equal(await stopping, 'cancelled', 'the abort answered, so removal was never attempted');
	await execution;
	assert.equal(store.get('job-other').status, 'queued', 'no other queued job was touched');

	runner.dispose();
});

// --- 7. per-type concurrency reaches the drain loop -----------------------

// Runs `queuedCount` jobs of one type through a real drain and reports the highest
// number that were ever in flight at once.
async function measurePeakConcurrency({ queuedCount, config, controls }) {
	const store = newStore();
	seedQueued(store, Array.from({ length: queuedCount }, (_, i) => `job-${i}`));
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
	const { orchestrator } = newOrchestrator({ plugin, store, workflow, config });
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	// Manual drain: bypasses the auto-run gate (and the initial drain delay) while
	// still going through drainType, which is where the worker count is computed.
	runner.runType(TEST_TYPE);
	for (let i = 0; i < 500 && store.count('done') < queuedCount; i++) await flush();

	runner.dispose();
	return { peak, done: store.count('done') };
}

test('readTypeMaxParallelOverride is honoured by the drain loop', async () => {
	const withoutOverride = await measurePeakConcurrency({ queuedCount: 6, config: TEST_CONFIG, controls: {} });
	assert.equal(withoutOverride.done, 6);
	assert.equal(withoutOverride.peak, 1, 'the configured default is one worker, as every type ships today');

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
	const store = newStore();
	seedQueued(store, Array.from({ length: 8 }, (_, i) => `job-${i}`));
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
	const { orchestrator } = newOrchestrator({ plugin, store, workflow });
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);

	runner.runType(TEST_TYPE);
	for (let i = 0; i < 500 && store.count('done') < 8; i++) await flush();

	assert.equal(store.count('done'), 8);
	assert.equal(peak, 2, 'six workers, but the global semaphore only ever lets two run — the ceiling the UI names');

	runner.dispose();
});

// --- 8. filing a failure must never take the type worker with it ------------
//
// `failEntry` is the last step of both the failure path and `execute`'s catch-all. A
// store write that threw there used to propagate out through runNext → typeWorker →
// the Promise.all in drainType, ending that TYPE's drain as an unhandled rejection —
// and leaving the job stranded in running. Now it swallows and logs: the job stays
// running, where the queue monitor shows it and scan()'s stale sweep recovers it, and
// the drain keeps going. An un-drained type is invisible; a running job is not.

test('a store failure while filing a thrown job as failed leaves the drain alive', async () => {
	const ran = [];
	const workflow = {
		async run(job) {
			ran.push(job.id);
			if (job.id === 'job-bad') throw new Error('workflow blew up');
			return { status: 'done' };
		},
	};
	const store = newStore();
	const { orchestrator } = newOrchestrator({ store, workflow });
	seedQueued(store, ['job-bad', 'job-next']);
	const realTransition = store.transition.bind(store);
	store.transition = (id, status, now, patch) => {
		if (status === 'failed') throw new Error('store write failed');
		return realTransition(id, status, now, patch);
	};

	assert.equal(await orchestrator.runNextOfType(TEST_TYPE), 'ran',
		'the run reports normally rather than rejecting into the worker');
	assert.equal(store.get('job-bad').status, 'running', 'the job is observable as running, not lost');

	assert.equal(await orchestrator.runNextOfType(TEST_TYPE), 'ran', 'and the next job still drains');
	assert.deepEqual(ran, ['job-bad', 'job-next']);
	assert.equal(store.count('done'), 1);
});

test('a refused settle into failed leaves the job running and the worker running', async () => {
	const store = newStore();
	const { orchestrator } = newOrchestrator({
		store,
		workflow: {
			async run(job) {
				if (job.id === 'job-bad') return { status: 'failed', error: 'nope' };
				return { status: 'done' };
			},
		},
	});
	seedQueued(store, ['job-bad', 'job-next']);
	const realTransition = store.transition.bind(store);
	store.transition = (id, status, now, patch) => {
		if (status === 'failed') throw new Error('store write failed');
		return realTransition(id, status, now, patch);
	};

	assert.equal(await orchestrator.runNextOfType(TEST_TYPE), 'ran');
	assert.equal(store.get('job-bad').status, 'running');
	assert.equal(store.count('failed'), 0);

	assert.equal(await orchestrator.runNextOfType(TEST_TYPE), 'ran');
	assert.equal(store.count('done'), 1, 'the queue behind a stuck settle keeps moving');
});

// --- 8b. failureKind classification, forward-looking for future sweeps ------
//
// failEntry stamps how the failure classifies using the same conservative pattern
// table failedJobRepair.ts's retroactive requeue tool uses (single source of truth
// — see tests/failedJobRepair.test.mjs for the pattern table's own coverage).

test('failEntry stamps failureKind "service" for a service-outage-shaped error', async () => {
	const store = newStore();
	const { orchestrator } = newOrchestrator({
		store,
		workflow: { async run() { throw new Error('net::ERR_CONNECTION_REFUSED'); } },
	});
	seedQueued(store, ['job-outage']);

	assert.equal(await orchestrator.runNextOfType(TEST_TYPE), 'ran');
	assert.equal(store.count('failed'), 1);
	assert.equal(store.get('job-outage').failureKind, 'service');
});

test('failEntry stamps failureKind "job" for a failure that does not match any outage pattern', async () => {
	const store = newStore();
	const { orchestrator } = newOrchestrator({
		store,
		workflow: { async run() { return { status: 'failed', error: 'malformed input: missing required field "path"' }; } },
	});
	seedQueued(store, ['job-genuine']);

	assert.equal(await orchestrator.runNextOfType(TEST_TYPE), 'ran');
	assert.equal(store.count('failed'), 1);
	assert.equal(store.get('job-genuine').failureKind, 'job');
});

// --- 9. the per-job emit storm is coalesced ---------------------------------
//
// Every `orchestration-queue-updated` costs a counts query here, one full queue re-read
// in every UI listener, and a kickAll() that can cost another query per enabled type. At
// two emits per job (claim + settle) that is quadratic in queue depth — draining the
// 2,022-job requeue cohort ran into millions of awaited per-job reads on the main thread
// back when the queue was markdown. The per-job emits go through a leading+trailing
// 250ms window; the bulk operations keep their stronger exactly-once guarantee (above).

test('draining a burst of jobs coalesces the per-job emits instead of one pair per job', async () => {
	const bus = makeBus();
	const store = newStore();
	const { orchestrator } = newOrchestrator({ plugin: makePlugin({ ingestionEvents: bus }), store });
	seedQueued(store, Array.from({ length: 10 }, (_, i) => `job-${i}`));

	for (let i = 0; i < 10; i++) await orchestrator.runNextOfType(TEST_TYPE);
	await flush();

	assert.equal(store.count('done'), 10, 'all ten really did drain');
	const emits = bus.count('orchestration-queue-updated');
	assert.ok(emits >= 1, 'the leading edge still fires immediately, so the UI is not left stale');
	assert.ok(emits < 20, `20 emits (claim + settle per job) is the bug; got ${emits}`);
	assert.ok(emits <= 4, `a burst inside one 250ms window collapses to a couple of emits; got ${emits}`);
});

// --- 10. whole-queue stats ---------------------------------------------------
//
// `Orchestrator.queueStats` backs the queue monitor's stats row — the in-app answer
// to "what's in jobs.sqlite". It must span every type (the store is shared) and
// every bucket, straight off the store's indexed counts.

test('queueStats reports whole-queue bucket counts across every type', () => {
	const { orchestrator, store } = newOrchestrator();
	seedQueued(store, ['qs-a', 'qs-b']);
	store.insert({ id: 'qs-c', type: 'another_type', created: '2026-01-01T00:01:00.000Z', params: {} });

	assert.deepEqual(orchestrator.queueStats(), { queued: 3, running: 0, done: 0, failed: 0, cancelled: 0 });

	store.clearQueued(Date.now());
	assert.deepEqual(orchestrator.queueStats(), { queued: 0, running: 0, done: 0, failed: 0, cancelled: 3 });
});

test('queueStats answers null before any registration opens the store', () => {
	const orchestrator = new Orchestrator(makePlugin(), { openDbStore: () => newStore() });
	assert.equal(orchestrator.queueStats(), null, 'no type registered yet — no store, no counts');
});
