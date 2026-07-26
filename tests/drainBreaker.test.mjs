import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// The breaker as the DRAIN sees it. tests/serviceHealth.test.mjs owns the registry's
// own state machine; everything here is about what the queue does with it, so it goes
// through the real Orchestrator + OrchestrationAutoRunner wiring rather than calling
// backends directly. The named bug this file exists for: one companion outage wrote
// 2,022 failure files while the drain swept the queue at ~40 jobs/s.
const outdir = path.join(tmpdir(), 'obsidian-crucible-drainbreaker-tests');
const outfile = path.join(outdir, 'drainBreaker.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { Orchestrator } from './src/orchestration/Orchestrator';",
			"export { OrchestrationAutoRunner, SERVICE_HEALTH_TICK_MS } from './src/orchestration/OrchestrationAutoRunner';",
			"export * from './src/orchestration/serviceHealth';",
			// The end-to-end sanity test below drives the REAL SearchUpsertFileWorkflow (not a
			// hand-rolled outage stub) through this same real registry/backend/runner wiring.
			"export { SearchUpsertFileWorkflow } from './src/orchestration/workflows/SearchIndexWorkflow';",
			"export { SearchServiceUnavailableError } from './src/search/types';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'drain-breaker-test-entry.ts',
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
					'globalThis.__drainBreakerNotices = globalThis.__drainBreakerNotices ?? [];',
					'export class Notice { constructor(message) { globalThis.__drainBreakerNotices.push(message); } }',
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
	Orchestrator,
	OrchestrationAutoRunner,
	SERVICE_HEALTH_TICK_MS,
	ServiceHealthRegistry,
	SERVICE_OPEN_WINDOW_MS,
	SearchUpsertFileWorkflow,
	SearchServiceUnavailableError,
} = await import(pathToFileURL(outfile).href);

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
// Enough turns for a drain to start, claim, run and wind down.
const settle = async (turns = 12) => { for (let i = 0; i < turns; i++) await flush(); };

const STORE_FOLDERS = {
	queued: 'queue/inbox',
	running: 'queue/running',
	done: 'queue/done',
	failed: 'queue/failed',
	cancelled: 'queue/cancelled',
};

// Same shape as tests/queueControl.test.mjs's fake, plus `setDeferred` recording — a
// service deferral must write deferUntil and land the job back in queued/, never in
// failed/.
function makeStore(initial = {}) {
	const folders = { queued: [...(initial.queued ?? [])], running: [], done: [], failed: [], cancelled: [] };
	const deferred = [];
	const errors = [];
	return {
		folders,
		deferred,
		errors,
		ensureFolders: async () => {},
		folderForStatus: (status) => STORE_FOLDERS[status],
		listFolder: async (status) => [...(folders[status] ?? [])],
		appendNotes: async () => {},
		setError: async (file, message) => { errors.push({ path: file.path, message }); },
		// failEntry stamps failureKind right after setError (WP-5); without this stub the
		// TypeError is swallowed by failEntry's never-throws catch, the job strands in
		// running/, and any test awaiting a failed/ landing hangs forever.
		setFailureKind: async () => {},
		setOutputPaths: async () => {},
		setPartial: async () => {},
		setProgress: async () => {},
		setDeferred: async (file, message, until) => { deferred.push({ message, until }); },
		move: async (file, job, toStatus) => {
			for (const bucket of Object.values(folders)) {
				const idx = bucket.findIndex(e => e.file === file);
				if (idx >= 0) bucket.splice(idx, 1);
			}
			const name = file.path.split('/').pop();
			file.path = `${STORE_FOLDERS[toStatus]}/${name}`;
			const moved = { file, job: { ...job, status: toStatus } };
			folders[toStatus].push(moved);
			return moved;
		},
	};
}

function makeBus() {
	const listeners = new Map();
	return {
		on: (name, fn) => {
			const bucket = listeners.get(name) ?? new Set();
			bucket.add(fn);
			listeners.set(name, bucket);
			return () => bucket.delete(fn);
		},
		emit: (name, payload) => { for (const fn of Array.from(listeners.get(name) ?? [])) fn(payload); },
	};
}

function makePlugin({ settings, ...overrides } = {}) {
	return {
		settings: {
			orchestrationEnabled: true,
			orchestrationQueueEnabled: true,
			orchestrationAutorunTimeoutSeconds: 0,
			orchestrationMaxConcurrent: 8,
			// Auto-run on for the types these tests drain; without it shouldDrain vetoes
			// everything and the test reads as a deadlock rather than as a gate.
			orchestrationJobTypeControls: {
				search_upsert_file: { autoRun: true },
				youtube_metadata_fetch: { autoRun: true },
				command_run: { autoRun: true },
			},
			orchestrationRoutineNoticesEnabled: {},
		},
		ingestionEvents: null,
		orchestrationAutoRunner: null,
		serviceHealth: null,
		app: {
			vault: { getAbstractFileByPath: () => null },
			workspace: { onLayoutReady: () => { /* the 5s file-drain delay never fires in tests */ } },
		},
		...overrides,
		...(settings ? { settings: { ...makePlugin().settings, ...settings } } : {}),
	};
}

const SVC = 'search-companion';
const FILE_TYPE = 'search_upsert_file';
// Only the fields the drain reads; `services` is the declaration under test.
const FILE_CONFIG = { persistence: 'file', maxParallel: 1, minIntervalMs: 0, services: [SVC] };

function queuedEntry(id, type = FILE_TYPE) {
	return { file: { path: `queue/inbox/${id}.md` }, job: { id, type, status: 'queued', params: {} } };
}

// The drain's file gate (a 5s post-layout delay) is irrelevant to what these assert,
// so it is opened directly rather than waited out.
function makeRunner(plugin, orchestrator) {
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);
	plugin.orchestrationAutoRunner = runner;
	runner.fileDrainReady = true;
	return runner;
}

// A workflow that answers with a service-level deferral: `serviceUnhealthy` alongside
// `status: 'deferred'` is the contract WP-4's workflows will emit.
function outageWorkflow(counter, kind = 'refused') {
	return {
		async run() {
			counter.calls++;
			return {
				status: 'deferred',
				error: 'connect ECONNREFUSED 127.0.0.1:4801',
				notes: 'Search companion unreachable.',
				// 1s rather than a realistic 30s purely so the backend's best-effort retry
				// timer does not hold the test process open for half a minute.
				retryAfterMs: 1000,
				serviceUnhealthy: { service: SVC, kind, reason: 'connect ECONNREFUSED 127.0.0.1:4801' },
			};
		},
	};
}

// --- 1. an outage costs at most three deferrals and ZERO failures ----------

test('a service outage stops the drain after three deferrals, with nothing in failed/', async () => {
	const counter = { calls: 0 };
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry();
	const store = makeStore({ queued: Array.from({ length: 50 }, (_, i) => queuedEntry(`job-${i}`)) });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(FILE_TYPE, outageWorkflow(counter), FILE_CONFIG);
	const runner = makeRunner(plugin, orchestrator);

	// Keep kicking: this is the "recovery kick storm" the old code answered by sweeping
	// the whole queue. Each kick must find the breaker and stop.
	for (let i = 0; i < 20; i++) {
		runner.kickAll();
		await settle();
	}

	assert.equal(plugin.serviceHealth.stateOf(SVC), 'open');
	assert.ok(counter.calls <= 2, `a refused failure counts double, so two claims open the breaker (got ${counter.calls})`);
	assert.equal(store.folders.failed.length, 0,
		'THE regression: a dependency outage produced 2,022 failure files; it must produce none');
	assert.equal(store.folders.queued.length, 50, 'every job is still queued, deferred, and will run on recovery');
	assert.equal(store.folders.running.length, 0);

	runner.dispose();
});

test('a timeout-shaped outage takes the full three deferrals, and still no failures', async () => {
	const counter = { calls: 0 };
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry();
	const store = makeStore({ queued: Array.from({ length: 30 }, (_, i) => queuedEntry(`job-${i}`)) });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(FILE_TYPE, outageWorkflow(counter, 'timeout'), FILE_CONFIG);
	const runner = makeRunner(plugin, orchestrator);

	for (let i = 0; i < 20; i++) {
		runner.kickAll();
		await settle();
	}

	assert.equal(counter.calls, 3, 'three, which is the hysteresis threshold — not thirty');
	assert.equal(store.folders.failed.length, 0);
	assert.equal(plugin.serviceHealth.stateOf(SVC), 'open');

	runner.dispose();
});

// --- 2. an open breaker means zero claims ---------------------------------

test('an already-open breaker means a drain pass claims nothing at all', async () => {
	const counter = { calls: 0 };
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry();
	for (let i = 0; i < 3; i++) plugin.serviceHealth.reportFailure(SVC, 'timeout', 'down');

	const store = makeStore({ queued: [queuedEntry('job-a'), queuedEntry('job-b')] });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(FILE_TYPE, { async run() { counter.calls++; return { status: 'done' }; } }, FILE_CONFIG);
	const runner = makeRunner(plugin, orchestrator);

	runner.kickAll();
	await settle();

	assert.equal(counter.calls, 0, 'not one job was claimed');
	assert.equal(store.folders.queued.length, 2);
	assert.equal(store.folders.running.length, 0, 'and nothing was even moved into running/');

	runner.dispose();
});

test('a type declaring no services is unaffected by another service being down', async () => {
	const ran = [];
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry();
	for (let i = 0; i < 3; i++) plugin.serviceHealth.reportFailure(SVC, 'refused', 'down');

	const store = makeStore({ queued: [queuedEntry('local-1', 'command_run')] });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register('command_run', { async run(job) { ran.push(job.id); return { status: 'done' }; } },
		{ persistence: 'file', maxParallel: 1, minIntervalMs: 0 });
	const runner = makeRunner(plugin, orchestrator);

	runner.kickAll();
	await settle();

	assert.deepEqual(ran, ['local-1'], 'vault-local work does not care that the companion is down');
	runner.dispose();
});

test('a type needing two services will not run on one: all-or-nothing', async () => {
	const counter = { calls: 0 };
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry();
	for (let i = 0; i < 3; i++) plugin.serviceHealth.reportFailure('search-embedder', 'refused', 'embedder down');

	const store = makeStore({ queued: [queuedEntry('job-a')] });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(FILE_TYPE, { async run() { counter.calls++; return { status: 'done' }; } },
		{ ...FILE_CONFIG, services: [SVC, 'search-embedder'] });
	const runner = makeRunner(plugin, orchestrator);

	runner.kickAll();
	await settle();

	assert.equal(counter.calls, 0, 'the companion is fine, but half a dependency set is not a dependency set');
	runner.dispose();
});

// --- 3. `blocked` ends the worker -----------------------------------------

test("a 'blocked' outcome ends the type worker rather than looping to the next job", async () => {
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry();
	const store = makeStore({ queued: Array.from({ length: 5 }, (_, i) => queuedEntry(`job-${i}`)) });
	const orchestrator = new Orchestrator(plugin, store);
	// Deferred WITHOUT serviceUnhealthy would keep the worker going; with it, 'blocked'.
	orchestrator.register(FILE_TYPE, outageWorkflow({ calls: 0 }), FILE_CONFIG);
	const backend = orchestrator.backends.get(FILE_TYPE);

	assert.equal(await backend.runNext(), 'blocked',
		'a service deferral is not "ran" — reporting it as ran is what let the sweep continue');
	assert.equal(store.folders.failed.length, 0);
	assert.equal(store.folders.queued.length, 5, 'the job went back to queued, deferred');
	assert.equal(store.deferred.length, 1, 'and its deferUntil was written');
});

test('a job-level deferral (no service named) still reports ran, so the drain continues', async () => {
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry();
	const store = makeStore({ queued: [queuedEntry('job-a')] });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(FILE_TYPE, {
		async run() { return { status: 'deferred', notes: 'this one note is locked', retryAfterMs: 1000 }; },
	}, FILE_CONFIG);
	const backend = orchestrator.backends.get(FILE_TYPE);

	assert.equal(await backend.runNext(), 'ran',
		'one note being busy says nothing about the service, so the queue behind it must keep moving');
	assert.equal(plugin.serviceHealth.stateOf(SVC), 'closed', 'and the breaker heard nothing');
});

// --- 4. recovery ----------------------------------------------------------

test('recovery via a transition kick: the queue drains with no further enqueues', async () => {
	const ran = [];
	const plugin = makePlugin({ ingestionEvents: makeBus() });
	plugin.serviceHealth = new ServiceHealthRegistry();
	for (let i = 0; i < 3; i++) plugin.serviceHealth.reportFailure(SVC, 'refused', 'down');

	const store = makeStore({ queued: [queuedEntry('job-a'), queuedEntry('job-b'), queuedEntry('job-c')] });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(FILE_TYPE, { async run(job) { ran.push(job.id); return { status: 'done' }; } }, FILE_CONFIG);
	const runner = makeRunner(plugin, orchestrator);

	runner.kickAll();
	await settle();
	assert.deepEqual(ran, [], 'nothing drains while the breaker is open');

	// Something else observed the service working — e.g. a manual run, which bypasses
	// the breaker. The registry's transition is the only signal, and the runner
	// subscribed to it in its own constructor.
	plugin.serviceHealth.reportSuccess(SVC);
	await settle(30);

	assert.deepEqual(ran.sort(), ['job-a', 'job-b', 'job-c'],
		'no enqueue happened after recovery: the transition alone has to drain the backlog');
	runner.dispose();
});

test('recovery via the 60s backstop interval ALONE, with no queue event and no retry timer', async (t) => {
	// Only setInterval is faked: the test still needs real setTimeout to flush turns,
	// and the registry's clock is injected rather than mocked globally.
	t.mock.timers.enable({ apis: ['setInterval'] });

	const clock = { now: 5_000_000 };
	const ran = [];
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry(() => clock.now);
	for (let i = 0; i < 3; i++) plugin.serviceHealth.reportFailure(SVC, 'refused', 'down');

	const store = makeStore({ queued: [queuedEntry('job-a'), queuedEntry('job-b')] });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(FILE_TYPE, { async run(job) { ran.push(job.id); return { status: 'done' }; } }, FILE_CONFIG);
	const runner = makeRunner(plugin, orchestrator);

	runner.kickAll();
	await settle();
	assert.deepEqual(ran, [], 'open breaker: nothing runs, and nothing is scheduled to look again');

	// The open window elapses in registry time; without the interval nothing notices.
	clock.now += SERVICE_OPEN_WINDOW_MS;
	await settle();
	assert.deepEqual(ran, [], 'time passing is not by itself a wake-up');

	t.mock.timers.tick(SERVICE_HEALTH_TICK_MS);
	await settle(30);

	assert.deepEqual(ran.sort(), ['job-a', 'job-b'],
		'the interval ticks the breaker to half-open and kicks: this is the guaranteed wake that '
		+ 'replaced the single replaceable retry timer');
	assert.equal(plugin.serviceHealth.stateOf(SVC), 'closed', 'the probe job succeeded, so the breaker closed');
	runner.dispose();
});

test('half-open lets exactly one job through, and a failed probe re-opens before a second', async () => {
	const claims = [];
	const clock = { now: 7_000_000 };
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry(() => clock.now);
	for (let i = 0; i < 3; i++) plugin.serviceHealth.reportFailure(SVC, 'timeout', 'down');
	clock.now += SERVICE_OPEN_WINDOW_MS;
	plugin.serviceHealth.tick();
	assert.equal(plugin.serviceHealth.stateOf(SVC), 'half-open');

	const store = makeStore({ queued: Array.from({ length: 10 }, (_, i) => queuedEntry(`job-${i}`)) });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(FILE_TYPE, {
		async run(job) {
			claims.push(job.id);
			return {
				status: 'deferred',
				notes: 'still down',
				retryAfterMs: 1000,
				serviceUnhealthy: { service: SVC, kind: 'timeout', reason: 'still down' },
			};
		},
	}, { ...FILE_CONFIG, maxParallel: 4 });
	const runner = makeRunner(plugin, orchestrator);

	runner.kickAll();
	await settle(20);

	assert.equal(claims.length, 1, 'four workers, one probe token: exactly one job may test the water');
	assert.equal(plugin.serviceHealth.stateOf(SVC), 'open', 'and its failure re-opened the breaker at once');
	assert.equal(store.folders.failed.length, 0);
	runner.dispose();
});

// --- 5. manual runs bypass the breaker ------------------------------------

test('a manual per-job Run bypasses an open breaker — a click is intent, and a probe', async () => {
	const ran = [];
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry();
	for (let i = 0; i < 3; i++) plugin.serviceHealth.reportFailure(SVC, 'refused', 'down');

	const store = makeStore({ queued: [queuedEntry('job-a')] });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(FILE_TYPE, { async run(job) { ran.push(job.id); return { status: 'done' }; } }, FILE_CONFIG);
	const runner = makeRunner(plugin, orchestrator);

	assert.equal(await runner.runJob(FILE_TYPE, 'job-a'), 'ran');
	assert.deepEqual(ran, ['job-a']);
	assert.equal(plugin.serviceHealth.stateOf(SVC), 'closed',
		'and because it succeeded, the manual run doubled as the probe that closed the breaker');
	runner.dispose();
});

test('a manual runType drain bypasses an open breaker too', async () => {
	const ran = [];
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry();
	for (let i = 0; i < 3; i++) plugin.serviceHealth.reportFailure(SVC, 'refused', 'down');

	const store = makeStore({ queued: [queuedEntry('job-a'), queuedEntry('job-b')] });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(FILE_TYPE, { async run(job) { ran.push(job.id); return { status: 'done' }; } }, FILE_CONFIG);
	const runner = makeRunner(plugin, orchestrator);

	runner.runType(FILE_TYPE);
	await settle(20);

	assert.deepEqual(ran.sort(), ['job-a', 'job-b']);
	runner.dispose();
});

// --- 6. memory backend: released to pending, never marked done ------------

const MEMORY_TYPE = 'youtube_metadata_fetch';
const MEMORY_CONFIG = {
	persistence: 'memory',
	maxParallel: 1,
	minIntervalMs: 0,
	dedupeKey: params => String(params.key ?? ''),
	services: ['youtube-api'],
};

test('a deferred memory entry goes back to pending and is NOT marked done', async () => {
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry();
	const orchestrator = new Orchestrator(plugin, makeStore());
	orchestrator.register(MEMORY_TYPE, {
		async run() {
			return {
				status: 'deferred',
				notes: 'YouTube API quota exhausted',
				retryAfterMs: 60_000,
				serviceUnhealthy: { service: 'youtube-api', kind: 'rate-limited', reason: 'quota exhausted' },
			};
		},
	}, MEMORY_CONFIG);

	await orchestrator.enqueue(MEMORY_TYPE, { key: 'note:a.md' });
	assert.equal(await orchestrator.runNextOfType(MEMORY_TYPE), 'blocked');

	const queue = orchestrator.getMemoryQueue(MEMORY_TYPE);
	const entry = queue.getEntry('note:a.md');
	assert.equal(entry.status, 'pending',
		'THE found bug: a deferred memory job used to fall through and be marked DONE, so the work silently vanished');
	assert.equal(entry.error, undefined, 'a deferral is not a failure');
	assert.equal(plugin.serviceHealth.stateOf('youtube-api'), 'closed', 'one report is not three');
});

test('a released memory entry carries a cooloff so the drain that deferred it cannot re-claim it', async () => {
	const calls = { n: 0 };
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry();
	const orchestrator = new Orchestrator(plugin, makeStore());
	orchestrator.register(MEMORY_TYPE, {
		async run() {
			calls.n++;
			return { status: 'deferred', notes: 'not yet', retryAfterMs: 60_000 };
		},
	}, MEMORY_CONFIG);

	await orchestrator.enqueue(MEMORY_TYPE, { key: 'note:a.md' });
	await orchestrator.runNextOfType(MEMORY_TYPE);

	const queue = orchestrator.getMemoryQueue(MEMORY_TYPE);
	assert.equal(queue.getEntry('note:a.md').status, 'pending');
	assert.equal(queue.hasPending(), false, 'pending, but not yet claimable');
	assert.equal(await orchestrator.runNextOfType(MEMORY_TYPE), 'empty');
	assert.equal(calls.n, 1, 'without the cooloff this is an unbounded hot loop on one entry');
});

test('a memory outage opens the breaker after three deferrals and stops the drain', async () => {
	const calls = { n: 0 };
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry();
	const orchestrator = new Orchestrator(plugin, makeStore());
	orchestrator.register(MEMORY_TYPE, {
		async run() {
			calls.n++;
			return {
				status: 'deferred',
				notes: 'API down',
				serviceUnhealthy: { service: 'youtube-api', kind: 'server-error', reason: '503' },
			};
		},
	}, MEMORY_CONFIG);
	const runner = makeRunner(plugin, orchestrator);

	for (let i = 0; i < 6; i++) await orchestrator.enqueue(MEMORY_TYPE, { key: `note:${i}.md` });
	for (let i = 0; i < 10; i++) {
		runner.kickAll();
		await settle();
	}

	assert.equal(calls.n, 3, 'three deferrals, then the breaker holds the remaining entries');
	assert.equal(plugin.serviceHealth.stateOf('youtube-api'), 'open');
	const queue = orchestrator.getMemoryQueue(MEMORY_TYPE);
	assert.equal(queue.snapshot().filter(e => e.status === 'failed').length, 0,
		'and none of them is a failure');
	runner.dispose();
});

test('a successful memory job reports every declared service healthy', async () => {
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry();
	for (let i = 0; i < 3; i++) plugin.serviceHealth.reportFailure('youtube-api', 'refused', 'down');

	const orchestrator = new Orchestrator(plugin, makeStore());
	orchestrator.register(MEMORY_TYPE, { async run() { return { status: 'done' }; } }, MEMORY_CONFIG);

	await orchestrator.enqueue(MEMORY_TYPE, { key: 'note:a.md' });
	// Manual per-job Run: bypasses the gate, exactly as the queue monitor's Run does.
	assert.equal(await orchestrator.runJob(MEMORY_TYPE, 'note:a.md'), 'ran');
	assert.equal(plugin.serviceHealth.stateOf('youtube-api'), 'closed');
});

// --- 7. probe-token hygiene rider (orchestrator review finding on WP-2) ----

// `Orchestrator.servicesHealthyFor(type)` (the consuming form) is called immediately
// before every claim, and for a half-open service that consumes the single-flight probe
// token. Ordinarily the claimed job's own outcome reports a verdict — success or a
// service-level failure — which resolves the token. These two tests are the cases where
// no verdict ever reaches the registry: the claim finds nothing to run, or the job
// settles at the JOB level (a bug or a locked note — nothing about the SERVICE). Without
// `Orchestrator.releaseProbesFor`, the token strands until the 5-minute stale reclaim,
// during which the non-consuming kick check (`probeInFlight`) refuses to even start a
// drain — a false wedge that looks exactly like the outage it was trying to test.

test('an empty claim while half-open releases the probe token instead of stranding it', async () => {
	const clock = { now: 8_000_000 };
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry(() => clock.now);
	for (let i = 0; i < 3; i++) plugin.serviceHealth.reportFailure('youtube-api', 'refused', 'down');
	clock.now += SERVICE_OPEN_WINDOW_MS;
	plugin.serviceHealth.tick();
	assert.equal(plugin.serviceHealth.stateOf('youtube-api'), 'half-open');

	const ran = [];
	const orchestrator = new Orchestrator(plugin, makeStore());
	orchestrator.register(MEMORY_TYPE, { async run(job) { ran.push(job.id); return { status: 'done' }; } }, MEMORY_CONFIG);
	const runner = makeRunner(plugin, orchestrator);

	// The memory queue is empty: the worker acquires the probe token (it must, to even
	// attempt a claim) and then finds nothing there to run.
	runner.kickAll();
	await settle();

	assert.deepEqual(ran, [], 'nothing ran — there was nothing queued');
	assert.equal(plugin.serviceHealth.stateOf('youtube-api'), 'half-open',
		'no job ran, so no verdict — the breaker itself is unmoved');
	assert.equal(plugin.serviceHealth.snapshotFor('youtube-api').probeInFlight, false,
		'THE regression: an empty claim used to strand the token here for the full 5-minute stale window');

	// Now something arrives. Without the fix, this kick's non-consuming pre-check would
	// see probeInFlight still true and refuse to even start a drain.
	await orchestrator.enqueue(MEMORY_TYPE, { key: 'note:a.md' });
	runner.kickAll();
	await settle(20);

	assert.deepEqual(ran, [`mem:${MEMORY_TYPE}:note:a.md`], 'the next kick could probe because the token was returned');
	runner.dispose();
});

test('a job-level failure while half-open releases the probe without a verdict', async () => {
	const clock = { now: 9_000_000 };
	const plugin = makePlugin();
	plugin.serviceHealth = new ServiceHealthRegistry(() => clock.now);
	for (let i = 0; i < 3; i++) plugin.serviceHealth.reportFailure(SVC, 'refused', 'down');
	clock.now += SERVICE_OPEN_WINDOW_MS;
	plugin.serviceHealth.tick();
	assert.equal(plugin.serviceHealth.stateOf(SVC), 'half-open');

	const store = makeStore({ queued: [queuedEntry('job-a')] });
	const orchestrator = new Orchestrator(plugin, store);
	let calls = 0;
	// A job-level failure — no `serviceUnhealthy` — says nothing about the SERVICE at
	// all (a malformed param, a bug, a locked note); it must not resolve the probe
	// either way, but it must still hand the token back so the next probe can happen.
	orchestrator.register(FILE_TYPE, {
		async run() { calls++; throw new Error('boom: unrelated job-level bug'); },
	}, FILE_CONFIG);
	const runner = makeRunner(plugin, orchestrator);

	runner.kickAll();
	await settle();

	assert.equal(calls, 1, 'the probe job did run — that is what makes it a probe');
	assert.equal(store.folders.failed.length, 1, 'a job-level failure, recorded as such');
	assert.equal(plugin.serviceHealth.stateOf(SVC), 'half-open', 'a job-level failure says nothing about the service');
	assert.equal(plugin.serviceHealth.snapshotFor(SVC).probeInFlight, false,
		'THE regression: the token used to strand here until the 5-minute stale reclaim');

	// Next claim may probe again — prove it rather than just checking the flag.
	store.folders.queued.push(queuedEntry('job-b'));
	runner.kickAll();
	await settle();
	assert.equal(calls, 2, 'a later probe was possible because the first one released cleanly');

	runner.dispose();
});

// --- 8. end-to-end: workflow -> backend -> registry -> drain (the sprint promise) ----

// Every other test in this file proves the breaker mechanics against a HAND-ROLLED
// `outageWorkflow` stub. This is the one test the sprint promised: a companion-refused
// outage, observed by the REAL SearchUpsertFileWorkflow exactly as `client.ts` would
// classify it, flows through the real deferral/backend/registry/drain wiring end to end.
test('a companion-refused outage flows workflow -> backend -> registry -> drain stops', async () => {
	const plugin = makePlugin({ settings: { searchEnabled: true, searchServiceUrl: 'http://127.0.0.1:4801' } });
	plugin.serviceHealth = new ServiceHealthRegistry();
	plugin.searchManager = {
		companionAvailable: async () => true,
		companionUnavailableReason: () => null,
		markCompanionOffline: () => {},
		// deletePath is what SearchUpsertFileWorkflow calls when the target path resolves to
		// no file — the plugin.app.vault stub below always returns null, so every job takes
		// this branch. This is the one place the simulated outage is injected: everything
		// upstream of it (job claim, the workflow's own gate-and-catch scaffold) is real.
		deletePath: async () => { throw new SearchServiceUnavailableError('connect ECONNREFUSED 127.0.0.1:4801', 'refused'); },
	};

	const queued = Array.from({ length: 10 }, (_, i) => ({
		file: { path: `queue/inbox/search-${i}.md` },
		job: { id: `search-${i}`, type: 'search_upsert_file', status: 'queued', params: { path: `note-${i}.md` } },
	}));
	const store = makeStore({ queued });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register('search_upsert_file', new SearchUpsertFileWorkflow(),
		{ persistence: 'file', maxParallel: 1, minIntervalMs: 0, services: [SVC] });
	const runner = makeRunner(plugin, orchestrator);
	// search_upsert_file isn't in makePlugin()'s default autoRun map — opt it in, exactly
	// like the fixture already does for the other types this file drains.
	plugin.settings.orchestrationJobTypeControls.search_upsert_file = { autoRun: true };

	for (let i = 0; i < 20; i++) {
		runner.kickAll();
		await settle();
	}

	assert.equal(plugin.serviceHealth.stateOf(SVC), 'open',
		'the REAL workflow\'s serviceUnhealthy flowed all the way through the backend to the registry, which opened the breaker');
	assert.equal(store.folders.failed.length, 0,
		'a service outage observed through the real workflow must still never write a failure file');
	assert.equal(store.folders.queued.length, 10, 'the queue behind the outage is untouched, ready to resume on recovery');
	assert.equal(store.folders.running.length, 0);

	runner.dispose();
});
