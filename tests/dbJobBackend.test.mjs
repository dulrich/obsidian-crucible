import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// See tests/sqliteJobStore.test.mjs for why this is needed: esbuild's ESM output wraps
// every `require(...)` in a shim that throws unless a real `require` is reachable at
// runtime, and `db/sqlite.ts` lazy-requires `node:sqlite` on purpose.
globalThis.require = createRequire(import.meta.url);

const outdir = path.join(tmpdir(), 'obsidian-crucible-dbjobbackend-tests');
const outfile = path.join(outdir, 'dbJobBackend.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// One bundle over the whole DB control path — the backend, the Orchestrator's
// three-way dispatch, and the storage layer underneath it — so these exercise the real
// wiring rather than a re-implementation. Mirrors tests/queueControl.test.mjs (the file
// backend's equivalent) and tests/sqliteJobStore.test.mjs (the storage layer's).
await esbuild.build({
	stdin: {
		contents: [
			"export { DbJobBackend, dbQueueCountsSource } from './src/orchestration/DbJobBackend';",
			"export { Orchestrator } from './src/orchestration/Orchestrator';",
			"export { SqliteJobStore } from './src/orchestration/db/SqliteJobStore';",
			"export { openJobsDb, SqliteUnavailableError } from './src/orchestration/db/sqlite';",
			"export { CANCELLED_BEFORE_RUN } from './src/orchestration/cancellation';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'db-job-backend-test-entry.ts',
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
					'globalThis.__dbBackendNotices = globalThis.__dbBackendNotices ?? [];',
					'export class Notice { constructor(message) { globalThis.__dbBackendNotices.push(message); } }',
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
	DbJobBackend,
	Orchestrator,
	SqliteJobStore,
	openJobsDb,
	SqliteUnavailableError,
	CANCELLED_BEFORE_RUN,
} = await import(pathToFileURL(outfile).href);

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred() {
	let resolve;
	const promise = new Promise(r => { resolve = r; });
	return { promise, resolve };
}

function notices() {
	globalThis.__dbBackendNotices = globalThis.__dbBackendNotices ?? [];
	return globalThis.__dbBackendNotices;
}

function resetNotices() {
	globalThis.__dbBackendNotices = [];
}

function newDb() {
	return openJobsDb(':memory:');
}

function newStore(db = newDb(), processToken) {
	return new SqliteJobStore(db, processToken ? { processToken } : {});
}

// Seeds queued rows straight into the store, bypassing `enqueue` — so the bulk-emit
// tests below count ONLY the emit under test and can't be perturbed by a trailing
// coalesced emit left over from a burst of enqueues.
let seedCounter = 0;
function seed(store, type, count, params = {}) {
	const ids = [];
	for (let i = 0; i < count; i++) {
		seedCounter += 1;
		const id = `seed-${String(seedCounter).padStart(6, '0')}`;
		store.insert({ id, type, created: String(seedCounter).padStart(10, '0'), params });
		ids.push(id);
	}
	return ids;
}

// A stand-in for the markdown JobStore the Orchestrator still holds. Only the surface
// the queue-changed counts source touches is needed here — no `db` test reads a file
// job, but the combined counts source sums both halves, so the file half must answer.
function makeFileStore() {
	return {
		ensureFolders: async () => {},
		listFolder: async () => [],
		countFolder: () => 0,
	};
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

function makeServiceHealth() {
	const failures = [];
	const successes = [];
	return {
		failures,
		successes,
		reportFailure: (service, kind, reason, retryAfterMs) => failures.push({ service, kind, reason, retryAfterMs }),
		reportSuccess: (service) => successes.push(service),
		isHealthy: () => true,
		isHalfOpen: () => false,
		snapshotFor: () => ({ probeInFlight: false }),
	};
}

function makePlugin({ settings, ...overrides } = {}) {
	return {
		settings: {
			orchestrationEnabled: true,
			orchestrationQueueEnabled: true,
			orchestrationAutorunTimeoutSeconds: 0,
			orchestrationMaxConcurrent: 8,
			orchestrationJobTypeControls: {},
			orchestrationRoutineNoticesEnabled: {},
			orchestrationTranscriptRefineEnabled: true,
			orchestrationJobRetentionDays: 30,
			...(settings ?? {}),
		},
		ingestionEvents: null,
		orchestrationAutoRunner: null,
		serviceHealth: null,
		app: {
			vault: { getAbstractFileByPath: () => null },
			workspace: { onLayoutReady: () => {} },
		},
		...overrides,
	};
}

// `command_run` throughout unless a test needs the enablement gate: DbJobBackend's
// isWorkflowEnabled has no settings toggle for it, so these exercise the queue path
// rather than the gate.
const TEST_TYPE = 'command_run';
const dbConfig = (dedupeKey) => ({ persistence: 'db', maxParallel: 1, minIntervalMs: 0, dedupeKey });

function backendFor(workflow, { store = newStore(), plugin = makePlugin(), config = dbConfig(), type = TEST_TYPE } = {}) {
	return { backend: new DbJobBackend(plugin, store, type, config, workflow), store, plugin };
}

const inertWorkflow = { async run() { return { status: 'done' }; } };

// Captures the delays booked with setTimeout while `fn` runs, without disabling the
// real timer (the run itself awaits promises, not timers), then releases them.
//
// Releasing matters beyond tidiness: a deferral books a real wake for its full
// `retryAfterMs` (30-90s in these tests), and a pending timer keeps the test runner's
// event loop alive for exactly that long. Every test that can book a wake — a deferral
// settle, or a claim that finds only deferred work — runs through here.
async function withTimerSpy(fn) {
	const booked = [];
	const handles = [];
	const real = globalThis.setTimeout;
	globalThis.setTimeout = (cb, delay, ...rest) => {
		booked.push(delay);
		const handle = real(cb, delay, ...rest);
		handles.push(handle);
		return handle;
	};
	try {
		return { result: await fn(), booked };
	} finally {
		globalThis.setTimeout = real;
		for (const handle of handles) clearTimeout(handle);
	}
}

// --- 1. enqueue gating ------------------------------------------------------------

test('enqueue refuses when orchestration is disabled, and says so', async () => {
	resetNotices();
	const { backend, store } = backendFor(inertWorkflow, { plugin: makePlugin({ settings: { orchestrationEnabled: false } }) });

	assert.equal(await backend.enqueue({}), null);
	assert.equal(store.count('queued'), 0, 'nothing was written');
	assert.ok(notices().some(m => m === 'Orchestrate: disabled in settings.'));
});

test('enqueue refuses when the type\'s own workflow toggle is off', async () => {
	resetNotices();
	const plugin = makePlugin({ settings: { orchestrationTranscriptRefineEnabled: false } });
	const { backend, store } = backendFor(inertWorkflow, { plugin, type: 'transcript_refine' });

	assert.equal(await backend.enqueue({ targetPath: 'notes/a.md' }), null);
	assert.equal(store.count('queued'), 0);
	assert.ok(notices().some(m => m === 'Orchestrate: workflow "transcript_refine" is disabled in settings.'));
});

test('a plain enqueue writes one queued row and hands back the job', async () => {
	const { backend, store } = backendFor(inertWorkflow);

	const job = await backend.enqueue({ targetPath: 'notes/a.md' });
	assert.ok(job.id);
	assert.equal(job.type, TEST_TYPE);
	assert.equal(job.status, 'queued');
	assert.deepEqual(job.params, { targetPath: 'notes/a.md' });
	assert.equal(store.count('queued'), 1);
});

// --- 2. dedupe + promotion --------------------------------------------------------

test('a repeat enqueue collapses onto the existing active job', async () => {
	const { backend, store } = backendFor(inertWorkflow, { config: dbConfig(p => p.targetPath ?? '') });

	const first = await backend.enqueue({ targetPath: 'notes/a.md' });
	const second = await backend.enqueue({ targetPath: 'notes/a.md' });

	assert.equal(second.id, first.id);
	assert.equal(store.count('queued'), 1, 'one job, not two');
});

test('a falsy dedupe key never collapses', async () => {
	const { backend, store } = backendFor(inertWorkflow, { config: dbConfig(() => '') });

	await backend.enqueue({ targetPath: 'notes/a.md' });
	await backend.enqueue({ targetPath: 'notes/a.md' });

	assert.equal(store.count('queued'), 2);
});

test('dedupe is per job type — two types minting the same raw key do not collapse', async () => {
	const store = newStore();
	const plugin = makePlugin();
	const key = () => 'note:notes/a.md';
	const a = new DbJobBackend(plugin, store, 'command_run', dbConfig(key), inertWorkflow);
	const b = new DbJobBackend(plugin, store, 'chain_run', dbConfig(key), inertWorkflow);

	const first = await a.enqueue({});
	const second = await b.enqueue({});

	assert.notEqual(second.id, first.id);
	assert.equal(store.count('queued'), 2, 'youtubeMetadataDedupeKey and imageDescribeNoteDedupeKey both mint note:<path>');
});

test('a repeat enqueue at a better lane/priority promotes the queued job in place', async () => {
	const { backend, store } = backendFor(inertWorkflow, { config: dbConfig(p => p.targetPath ?? '') });

	const first = await backend.enqueue({ targetPath: 'notes/a.md' });
	assert.equal(first.lane, 'background');
	assert.equal(first.priority, 'normal');

	const promoted = await backend.enqueue({ targetPath: 'notes/a.md' }, { lane: 'user', priority: 'high' });

	assert.equal(promoted.id, first.id);
	assert.equal(promoted.lane, 'user');
	assert.equal(promoted.priority, 'high');
	assert.equal(store.count('queued'), 1);
	const row = store.get(first.id);
	assert.equal(row.lane, 'user');
	assert.equal(row.priority, 'high');
});

test('a repeat enqueue never promotes a job that is already running', async () => {
	const hold = deferred();
	const workflow = { async run() { await hold.promise; return { status: 'done' }; } };
	const { backend, store } = backendFor(workflow, { config: dbConfig(p => p.targetPath ?? '') });

	const first = await backend.enqueue({ targetPath: 'notes/a.md' });
	const execution = backend.runNext();
	await flush();
	assert.equal(store.get(first.id).status, 'running');

	const again = await backend.enqueue({ targetPath: 'notes/a.md' }, { lane: 'user', priority: 'high' });
	assert.equal(again.id, first.id, 'it still collapses onto the running job');
	assert.equal(store.get(first.id).lane, 'background', 'but a running job is not re-laned');

	hold.resolve();
	await execution;
});

// --- 3. claim / settle mapping ----------------------------------------------------

test('runNext claims a queued job, runs it, and settles it done', async () => {
	const ran = [];
	const workflow = { async run(job) { ran.push(job.id); return { status: 'done', outputPaths: ['out/a.md'] }; } };
	const health = makeServiceHealth();
	const plugin = makePlugin({ serviceHealth: health });
	const { backend, store } = backendFor(workflow, { plugin, config: { ...dbConfig(), services: ['search-companion'] } });

	const job = await backend.enqueue({});
	assert.equal(await backend.runNext(), 'ran');

	assert.deepEqual(ran, [job.id]);
	const row = store.get(job.id);
	assert.equal(row.status, 'done');
	assert.deepEqual(row.outputPaths, ['out/a.md']);
	assert.ok(row.settledAt > 0, 'a terminal settle stamps settled_at for retention');
	assert.deepEqual(health.successes, ['search-companion'], 'a completed job reports every declared service healthy');
});

test('runNext answers empty on an empty queue and disabled when orchestration is off', async () => {
	const { backend } = backendFor(inertWorkflow);
	assert.equal(await backend.runNext(), 'empty');

	const off = backendFor(inertWorkflow, { plugin: makePlugin({ settings: { orchestrationEnabled: false } }) });
	assert.equal(await off.backend.runNext(), 'disabled');
});

test('a failed result lands in failed with the error, the failure kind, and the unconditional Notice', async () => {
	resetNotices();
	const workflow = { async run() { return { status: 'failed', error: 'malformed input: missing required field "path"' }; } };
	const { backend, store } = backendFor(workflow);

	const job = await backend.enqueue({});
	assert.equal(await backend.runNext(), 'ran');

	const row = store.get(job.id);
	assert.equal(row.status, 'failed');
	assert.equal(row.error, 'malformed input: missing required field "path"');
	assert.equal(row.failureKind, 'job');
	assert.ok(
		notices().includes(`Orchestrate: ${job.id} → failed (malformed input: missing required field "path")`),
		'the failure Notice is unconditional, and reads exactly as the file backend\'s does',
	);
});

test('a thrown error settles the job failed and classifies an outage-shaped message as service', async () => {
	const workflow = { async run() { throw new Error('net::ERR_CONNECTION_REFUSED'); } };
	const { backend, store } = backendFor(workflow);

	const job = await backend.enqueue({});
	assert.equal(await backend.runNext(), 'ran');

	const row = store.get(job.id);
	assert.equal(row.status, 'failed');
	assert.equal(row.failureKind, 'service');
});

test('a job-level deferral goes back to queued behind defer_until and is skipped until it expires', async () => {
	const workflow = { async run() { return { status: 'deferred', notes: 'rate limited', retryAfterMs: 60_000 }; } };
	const { backend, store } = backendFor(workflow);

	const job = await backend.enqueue({});
	const first = await withTimerSpy(() => backend.runNext());
	assert.equal(first.result, 'ran', 'a JOB-level deferral does not end the drain');

	const row = store.get(job.id);
	assert.equal(row.status, 'queued');
	assert.equal(row.progress, 'rate limited');
	assert.ok(row.deferUntil > Date.now(), 'the deferral survives the transition back to queued');
	const second = await withTimerSpy(() => backend.runNext());
	assert.equal(second.result, 'empty', 'and claimNext skips it while it is deferred');
});

test('a service-level deferral answers blocked and opens the breaker before the store write', async () => {
	const health = makeServiceHealth();
	const workflow = {
		async run() {
			return {
				status: 'deferred',
				notes: 'companion down',
				retryAfterMs: 30_000,
				serviceUnhealthy: { service: 'search-companion', kind: 'connection', reason: 'ECONNREFUSED' },
			};
		},
	};
	const { backend } = backendFor(workflow, { plugin: makePlugin({ serviceHealth: health }) });

	await backend.enqueue({});
	const { result } = await withTimerSpy(() => backend.runNext());
	assert.equal(result, 'blocked');
	assert.equal(health.failures.length, 1);
	assert.equal(health.failures[0].service, 'search-companion');
});

test('a deferral books a wake timer instead of waiting on the autorunner tick', async () => {
	const workflow = { async run() { return { status: 'deferred', notes: 'later', retryAfterMs: 45_000 }; } };
	const { backend } = backendFor(workflow);
	await backend.enqueue({});

	const { booked } = await withTimerSpy(() => backend.runNext());
	assert.ok(booked.includes(45_000), `the retry wake is scheduled for retryAfterMs; booked ${JSON.stringify(booked)}`);
});

test('a claim that finds only deferred work books a wake for the soonest one', async () => {
	const { backend, store } = backendFor(inertWorkflow);
	const job = await backend.enqueue({});
	store.setDeferred(job.id, 'deferred', Date.now() + 90_000);

	const { result, booked } = await withTimerSpy(() => backend.runNext());
	assert.equal(result, 'empty');
	assert.ok(booked.some(d => d > 80_000 && d <= 90_000), `expected a ~90s wake; booked ${JSON.stringify(booked)}`);
});

// --- 4. cancellation --------------------------------------------------------------

test('cancelling a running job settles it cancelled, and isCancelling reads true synchronously', async () => {
	const release = deferred();
	const workflow = {
		async run(_job, ctx) {
			await release.promise;
			ctx.throwIfAborted();
			return { status: 'done' };
		},
	};
	const { backend, store } = backendFor(workflow);

	const job = await backend.enqueue({});
	const execution = backend.runNext();
	await flush();
	assert.equal(backend.isRunning(job.id), true);

	const cancelling = backend.cancelJob(job.id);
	// No await between the two: several callers read this synchronously, which is why
	// cancelJob is deliberately not an `async` function in any backend.
	assert.equal(backend.isCancelling(job.id), true);

	release.resolve();
	assert.equal(await cancelling, 'cancelled');
	await execution;

	assert.equal(store.get(job.id).status, 'cancelled');
	assert.equal(store.get(job.id).error, undefined, 'a cancellation is not a diagnostic');
	assert.equal(backend.isRunning(job.id), false);
});

test('cancelling an unknown or merely queued job answers not-running', async () => {
	const { backend } = backendFor(inertWorkflow);
	const job = await backend.enqueue({});

	assert.equal(await backend.cancelJob('no-such-job'), 'not-running');
	assert.equal(await backend.cancelJob(job.id), 'not-running', 'dropping queued work is removeQueued, not an abort');
});

test('a workflow that ignores the signal reports completed, not cancelled', async () => {
	const release = deferred();
	const workflow = { async run() { await release.promise; return { status: 'done' }; } };
	const { backend, store } = backendFor(workflow);

	const job = await backend.enqueue({});
	const execution = backend.runNext();
	await flush();

	const cancelling = backend.cancelJob(job.id);
	release.resolve();
	assert.equal(await cancelling, 'completed');
	await execution;
	assert.equal(store.get(job.id).status, 'done');
});

// --- 5. runJob / removeQueued -----------------------------------------------------

test('runJob claims one specific job and ignores its deferral', async () => {
	const ran = [];
	const workflow = { async run(job) { ran.push(job.id); return { status: 'done' }; } };
	const { backend, store } = backendFor(workflow);

	const first = await backend.enqueue({ n: 1 });
	const second = await backend.enqueue({ n: 2 });
	store.setDeferred(second.id, 'deferred', Date.now() + 60_000);

	assert.equal(await backend.runJob(second.id), 'ran', 'the user asked for this job now');
	assert.deepEqual(ran, [second.id]);
	assert.equal(store.get(first.id).status, 'queued');
	assert.equal(await backend.runJob('no-such-job'), 'empty');
});

test('removeQueued retires a queued job with the shared cancelled-before-run note', async () => {
	const { backend, store } = backendFor(inertWorkflow);
	const job = await backend.enqueue({});

	assert.equal(await backend.removeQueued(job.id), 'removed');
	const row = store.get(job.id);
	assert.equal(row.status, 'cancelled');
	assert.equal(row.notes, CANCELLED_BEFORE_RUN);
	assert.equal(await backend.runNext(), 'empty', 'and it never drains afterwards');
});

test('removeQueued answers not-queued for a running job and for an unknown id', async () => {
	const hold = deferred();
	const workflow = { async run() { await hold.promise; return { status: 'done' }; } };
	const { backend, store } = backendFor(workflow);

	const job = await backend.enqueue({});
	const execution = backend.runNext();
	await flush();

	assert.equal(await backend.removeQueued(job.id), 'not-queued', 'a claimed job is cancelJob\'s business');
	assert.equal(store.get(job.id).status, 'running', 'and it was not yanked out from under the run');
	assert.equal(await backend.removeQueued('no-such-job'), 'not-queued');

	hold.resolve();
	await execution;
});

// --- 6. bulk clear, hasPending ----------------------------------------------------

test('clearQueued clears only this type, returns the count, and emits nothing itself', async () => {
	const bus = makeBus();
	const store = newStore();
	const plugin = makePlugin({ ingestionEvents: bus });
	const mine = new DbJobBackend(plugin, store, 'command_run', dbConfig(), inertWorkflow);

	// 250 > the queue monitor's 100-row render cap: a clear driven off rendered rows
	// would silently leave the remainder queued.
	seed(store, 'command_run', 250);
	seed(store, 'chain_run', 1);

	assert.equal(await mine.clearQueued(), 250, 'past any display cap — the backend clears its own view of the queue');
	assert.equal(bus.count('orchestration-queue-updated'), 0,
		'the backend emits nothing: the Orchestrator emits once for the whole bulk operation');
	assert.equal(store.countByTypeAndStatus('command_run', ['queued']), 0);
	assert.equal(store.countByTypeAndStatus('chain_run', ['queued']), 1, 'another type\'s queue is untouched');
	assert.equal(await mine.runNext(), 'empty', 'and none of them drains afterwards');
});

test('hasPending is exact and scoped to the type', async () => {
	const store = newStore();
	const plugin = makePlugin();
	const mine = new DbJobBackend(plugin, store, 'command_run', dbConfig(), inertWorkflow);
	const other = new DbJobBackend(plugin, store, 'chain_run', dbConfig(), inertWorkflow);

	assert.equal(mine.hasPending(), false, 'unlike a file type, it does not answer "maybe"');
	await other.enqueue({});
	assert.equal(mine.hasPending(), false, 'another type\'s work is not this type\'s pending work');
	await mine.enqueue({});
	assert.equal(mine.hasPending(), true);
});

// --- 7. registration dispatch + the Orchestrator's bulk emit ----------------------

test('Orchestrator.register builds a DbJobBackend for a db type, sharing one store', async () => {
	const store = newStore();
	const plugin = makePlugin();
	const orchestrator = new Orchestrator(plugin, makeFileStore(), { openDbStore: () => store });
	orchestrator.register('command_run', inertWorkflow, dbConfig());
	orchestrator.register('chain_run', inertWorkflow, dbConfig());

	await orchestrator.enqueue('command_run', {});
	await orchestrator.enqueue('chain_run', {});

	assert.equal(store.count('queued'), 2, 'both types landed in the one shared jobs DB');
	assert.equal(orchestrator.drainsWithoutAutorun('command_run'), false, 'db types drain under the autorun toggle');
	assert.equal(await orchestrator.runNextOfType('command_run'), 'ran');
});

test('a db bulk clear emits exactly one orchestration-queue-updated, carrying the DB counts', async () => {
	const bus = makeBus();
	const store = newStore();
	const orchestrator = new Orchestrator(makePlugin({ ingestionEvents: bus }), makeFileStore(), { openDbStore: () => store });
	orchestrator.register(TEST_TYPE, inertWorkflow, dbConfig());
	seed(store, TEST_TYPE, 40);

	assert.equal(await orchestrator.clearQueued(TEST_TYPE), 40);
	assert.equal(bus.count('orchestration-queue-updated'), 1,
		'every emit costs each listener a full queue re-read plus a kickAll(); 40 of them for one click is the bug');
	assert.deepEqual(bus.emitted.at(-1).payload, { queued: 0, running: 0 },
		'and the one emit carries the state after the whole clear');
});

test('a db clear that removes nothing emits nothing', async () => {
	const bus = makeBus();
	const orchestrator = new Orchestrator(makePlugin({ ingestionEvents: bus }), makeFileStore(), { openDbStore: () => newStore() });
	orchestrator.register(TEST_TYPE, inertWorkflow, dbConfig());

	assert.equal(await orchestrator.clearQueued(TEST_TYPE), 0);
	assert.equal(bus.count('orchestration-queue-updated'), 0);
});

test('a single-row db cancel emits once', async () => {
	const bus = makeBus();
	const store = newStore();
	const orchestrator = new Orchestrator(makePlugin({ ingestionEvents: bus }), makeFileStore(), { openDbStore: () => store });
	orchestrator.register(TEST_TYPE, inertWorkflow, dbConfig());
	const [id] = seed(store, TEST_TYPE, 2);

	assert.equal(await orchestrator.removeQueuedJob(TEST_TYPE, id), 'removed');
	assert.equal(bus.count('orchestration-queue-updated'), 1);
});

test('an unavailable jobs DB surfaces a Notice and fails the registration — no silent fallback', () => {
	resetNotices();
	const orchestrator = new Orchestrator(makePlugin(), makeFileStore(), {
		openDbStore: () => { throw new SqliteUnavailableError('node:sqlite is unavailable in this runtime.'); },
	});

	assert.throws(
		() => orchestrator.register(TEST_TYPE, inertWorkflow, dbConfig()),
		(err) => err instanceof SqliteUnavailableError,
	);
	assert.ok(notices().some(m => m.startsWith('Orchestrate: the job queue database is unavailable —')));
	assert.deepEqual(orchestrator.jobTypes(), [], 'a type whose backend could not be built is not half-registered');
});

// --- 8. the sweeps WP-7 calls from scan() ------------------------------------------

test('recoverStaleDbJobs requeues a lease a previous plugin load left behind, whatever its age', async () => {
	const db = newDb();
	const previousLoad = newStore(db, 'load-1');
	const current = newStore(db, 'load-2');
	const orchestrator = new Orchestrator(makePlugin(), makeFileStore(), { openDbStore: () => current });
	orchestrator.register(TEST_TYPE, inertWorkflow, dbConfig());

	const [id] = seed(current, TEST_TYPE, 1);
	previousLoad.claimById(id, Date.now());
	assert.equal(current.get(id).status, 'running', 'claimed, seconds ago, by a process that no longer exists');

	assert.equal(orchestrator.recoverStaleDbJobs(), 1, 'a foreign claim token is recoverable regardless of age');
	assert.equal(current.get(id).status, 'queued');
	assert.equal(current.get(id).error, 'Recovered: stale claim');
	assert.equal(current.get(id).claimToken, undefined);
});

test('recoverStaleDbJobs recovers an age-stale claim and never a run this process owns', async () => {
	const db = newDb();
	const store = newStore(db);
	const plugin = makePlugin({ settings: { orchestrationAutorunTimeoutSeconds: 0 } });
	const orchestrator = new Orchestrator(plugin, makeFileStore(), { openDbStore: () => store });
	const hold = deferred();
	orchestrator.register(TEST_TYPE, inertWorkflow, dbConfig());
	orchestrator.register('chain_run', { async run() { await hold.promise; return { status: 'done' }; } }, dbConfig());

	// Claimed by THIS process (token matches), but two hours ago — past the 1h window a
	// type with no per-run timeout gets.
	const [stale] = seed(store, TEST_TYPE, 1);
	store.claimById(stale, Date.now() - 2 * 60 * 60 * 1000);

	const [live] = seed(store, 'chain_run', 1);
	const execution = orchestrator.runJob('chain_run', live);
	await flush();
	// Backdate the live run's claim to the same age, so ONLY the isRunning guard can
	// keep the sweep off it.
	db.prepare('UPDATE jobs SET claimed_at = ? WHERE id = ?').run(Date.now() - 2 * 60 * 60 * 1000, live);

	assert.equal(orchestrator.recoverStaleDbJobs(), 1);
	assert.equal(store.get(stale).status, 'queued');
	assert.equal(store.get(stale).error, 'Recovered: stale claim');
	assert.equal(store.get(live).status, 'running', 'a live run is never stale, whatever the clock says');

	hold.resolve();
	assert.equal(await execution, 'ran');
	assert.equal(store.get(live).status, 'done');
});

test('pruneTerminalDbJobs deletes settled jobs past the retention setting and keeps the rest', async () => {
	const store = newStore();
	const plugin = makePlugin({ settings: { orchestrationJobRetentionDays: 30 } });
	const orchestrator = new Orchestrator(plugin, makeFileStore(), { openDbStore: () => store });
	orchestrator.register(TEST_TYPE, inertWorkflow, dbConfig());

	const [old, fresh] = seed(store, TEST_TYPE, 2);
	store.transition(old, 'done', Date.now() - 60 * 24 * 60 * 60 * 1000);
	store.transition(fresh, 'done', Date.now());

	assert.equal(orchestrator.pruneTerminalDbJobs(), 1);
	assert.equal(store.get(old), null);
	assert.ok(store.get(fresh));

	plugin.settings.orchestrationJobRetentionDays = 0;
	store.transition(fresh, 'done', Date.now() - 365 * 24 * 60 * 60 * 1000);
	assert.equal(orchestrator.pruneTerminalDbJobs(), 0, '0 means keep forever');
});

test('the sweeps are no-ops with no db type registered', () => {
	const orchestrator = new Orchestrator(makePlugin(), makeFileStore(), { openDbStore: () => { throw new Error('never opened'); } });
	orchestrator.register(TEST_TYPE, inertWorkflow, { persistence: 'file', maxParallel: 1, minIntervalMs: 0 });

	assert.equal(orchestrator.recoverStaleDbJobs(), 0);
	assert.equal(orchestrator.pruneTerminalDbJobs(), 0);
});

// --- 9. the WP-7 seam --------------------------------------------------------------

test('list/count/setProgress answer for this type only', async () => {
	const store = newStore();
	const plugin = makePlugin();
	const mine = new DbJobBackend(plugin, store, 'command_run', dbConfig(), inertWorkflow);
	const other = new DbJobBackend(plugin, store, 'chain_run', dbConfig(), inertWorkflow);

	const first = await mine.enqueue({ n: 1 });
	await mine.enqueue({ n: 2 });
	await other.enqueue({ n: 3 });

	assert.equal(mine.list('queued').length, 2);
	assert.equal(mine.list('queued', { limit: 1 }).length, 1, 'the limit is a LIMIT, not a JS slice of a mixed page');
	assert.equal(mine.count(['queued', 'running']), 2);

	mine.setProgress(first.id, 'indexing 12/100');
	assert.equal(store.get(first.id).progress, 'indexing 12/100');
});
