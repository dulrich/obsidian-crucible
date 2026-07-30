import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// `Orchestrator.scan()` — the maintenance pass: crash-lease/hang recovery, terminal
// retention, and the bucket counts behind the Scan notice.
//
// thq WP-8 rewrote this file's harness rather than deleting it. The scan used to sweep
// markdown folders, so every test here drove a fake `JobStore`; it now drives a real
// `SqliteJobStore` on `:memory:`. Two of the old tests pinned behavior that is
// *unrepresentable* post-cutover and are gone (see the WP-8 report's migration table):
// the aborted-claim recovery (a claim is one guarded UPDATE — it cannot half-apply) and
// the countFolder-not-listFolder cost guard (there are no folders to count). Everything
// else survives with the same assertion, against the real store.

globalThis.require = createRequire(import.meta.url);

const outdir = path.join(tmpdir(), 'obsidian-crucible-orchestrator-scan-tests');
const outfile = path.join(outdir, 'Orchestrator.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	stdin: {
		contents: [
			"export { Orchestrator, staleRunningMsForTimeout } from './src/orchestration/Orchestrator';",
			"export { SqliteJobStore } from './src/orchestration/db/SqliteJobStore';",
			"export { openJobsDb } from './src/orchestration/db/sqlite';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'orchestrator-scan-test-entry.ts',
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
					'globalThis.__orchestratorScanNotices = globalThis.__orchestratorScanNotices ?? [];',
					'export class Notice { constructor(message) { globalThis.__orchestratorScanNotices.push(message); } }',
					'export class TFile {}',
					'export class TFolder {}',
					'export class App {}',
					'export class Modal {}',
					'export class Setting {}',
					'export class FuzzySuggestModal {}',
					'export class FileSystemAdapter {}',
					'export function normalizePath(path) { return path; }',
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

const { Orchestrator, staleRunningMsForTimeout, SqliteJobStore, openJobsDb } = await import(pathToFileURL(outfile));

const TYPE = 'command_run';
const config = { persistence: 'db', maxParallel: 1, minIntervalMs: 0 };
const inertWorkflow = { async run() { return { status: 'done' }; } };

function makePlugin(settings = {}) {
	return {
		settings: {
			orchestrationEnabled: true,
			orchestrationQueueEnabled: true,
			orchestrationAutorunTimeoutSeconds: 600,
			orchestrationMaxConcurrent: 8,
			orchestrationJobTypeControls: {},
			orchestrationRoutineNoticesEnabled: {},
			orchestrationJobRetentionDays: 30,
			...settings,
		},
		ingestionEvents: null,
		orchestrationAutoRunner: null,
		app: { vault: { getAbstractFileByPath: () => null }, workspace: { onLayoutReady: () => {} } },
	};
}

function newOrchestrator({ plugin = makePlugin(), workflow = inertWorkflow, store = new SqliteJobStore(openJobsDb(':memory:')) } = {}) {
	const orchestrator = new Orchestrator(plugin, { openDbStore: () => store });
	orchestrator.register(TYPE, workflow, config);
	return { orchestrator, store, plugin };
}

// Inserts a job and puts it in `running` with a claim stamped `agedMs` ago, the shape a
// plugin reload leaves behind (or a job that genuinely outran its timeout).
function seedRunning(store, id, agedMs) {
	store.insert({ id, type: TYPE, created: new Date(Date.now() - agedMs).toISOString(), params: {} });
	store.claimById(id, Date.now() - agedMs);
}

test('staleRunningMsForTimeout uses timeout plus buffer, or one-hour fallback when disabled', () => {
	assert.equal(staleRunningMsForTimeout(600_000), 630_000);
	assert.equal(staleRunningMsForTimeout(0), 60 * 60_000);
});

test('scan silently requeues a claim older than the configured timeout buffer', async () => {
	globalThis.__orchestratorScanNotices = [];
	const { orchestrator, store } = newOrchestrator();
	seedRunning(store, 'job-1', 631_000);

	const report = await orchestrator.scan({ notify: false });

	assert.equal(report.recovered, 1);
	assert.equal(report.running, 0);
	assert.equal(report.inbox, 1, 'it went back to queued, not to a terminal bucket');
	assert.equal(store.get('job-1').status, 'queued');
	assert.deepEqual(globalThis.__orchestratorScanNotices, [], 'notify:false stays silent');
});

test('scan keeps recently claimed jobs running', async () => {
	const { orchestrator, store } = newOrchestrator();
	seedRunning(store, 'job-1', 629_000);

	const report = await orchestrator.scan({ notify: false });

	assert.equal(report.recovered, 0);
	assert.equal(report.running, 1);
	assert.equal(store.get('job-1').status, 'running');
});

// The stale sweep's premise is "no live timer owns this job". A run registered in THIS
// process is the counter-example. Bouncing it running → queued duplicates the job: the
// original keeps executing while a worker claims and runs the copy, both writing the
// same note.
test('scan does not re-queue a job this process is still executing, however stale its stamp', async () => {
	let release = () => {};
	const gate = new Promise(resolve => { release = resolve; });
	const { orchestrator, store } = newOrchestrator({
		workflow: { async run() { await gate; return { status: 'done' }; } },
	});
	store.insert({ id: 'job-long', type: TYPE, created: new Date().toISOString(), params: {} });

	// Start the run the way a manual per-job Run would, then age its claim past the
	// cutoff underneath it and scan while it is still in flight.
	const execution = orchestrator.runJob(TYPE, 'job-long');
	await new Promise(resolve => setTimeout(resolve, 0));
	backdateClaim(store, 'job-long', 10 * 60 * 60_000);
	assert.ok(Date.now() - store.get('job-long').claimedAt > 9 * 60 * 60_000,
		'guard against a vacuous pass: the claim really is hours stale before the scan');

	const report = await orchestrator.scan({ notify: false });

	assert.equal(report.recovered, 0, 'a live run is not a stranded job');
	assert.equal(report.running, 1);
	assert.equal(store.get('job-long').status, 'running', 'nothing was moved out from under it');

	release();
	assert.equal(await execution, 'ran');
	assert.equal(store.get('job-long').status, 'done', 'it settled itself');
});

// Backdates a live claim without touching its token — the "this job has been running
// for hours" shape, which only `isRunning` distinguishes from a crashed one.
function backdateClaim(store, id, agedMs) {
	store.db.prepare('UPDATE jobs SET claimed_at = ? WHERE id = ?').run(Date.now() - agedMs, id);
}

test('scan recovers a lease a previous plugin load left behind, whatever its age', async () => {
	// A different process token means the claiming process is gone, so the job is
	// stranded no matter how fresh the claim looks. This is the recovery that replaces
	// the markdown queue's "aborted claim" sweep (unrepresentable now — a claim is one
	// guarded UPDATE and cannot half-apply).
	const store = new SqliteJobStore(openJobsDb(':memory:'), { processToken: 'previous-load' });
	store.insert({ id: 'job-stranded', type: TYPE, created: new Date().toISOString(), params: {} });
	store.claimById('job-stranded', Date.now());

	const { orchestrator } = newOrchestrator({ store: new SqliteJobStore(store.db, { processToken: 'this-load' }) });
	const report = await orchestrator.scan({ notify: false });

	assert.equal(report.recovered, 1);
	assert.equal(store.get('job-stranded').status, 'queued');
});

test('scan runs the recovery and retention sweeps exactly once each, and folds their counts into the report', async () => {
	const recoverCalls = [];
	const pruneCalls = [];
	const dbStore = {
		recoverStale: (nowMs, staleMsForType, isProtected) => {
			recoverCalls.push({ nowMs, staleMsForType, isProtected });
			return 2;
		},
		pruneTerminal: (nowMs, retentionDays) => {
			pruneCalls.push({ nowMs, retentionDays });
			return 5;
		},
		count: () => 0,
	};
	const plugin = makePlugin({ orchestrationJobRetentionDays: 14 });
	const orchestrator = new Orchestrator(plugin, { openDbStore: () => dbStore });
	orchestrator.register(TYPE, inertWorkflow, config);

	const report = await orchestrator.scan({ notify: false });

	assert.equal(recoverCalls.length, 1, 'scan must recover exactly once');
	assert.equal(pruneCalls.length, 1, 'scan must prune exactly once');
	assert.equal(pruneCalls[0].retentionDays, 14, 'the configured retention setting reaches the prune');
	assert.equal(report.recovered, 2);
	assert.equal(report.pruned, 5);
});

test('scan reports every bucket count from the store', async () => {
	const { orchestrator, store } = newOrchestrator();
	store.insert({ id: 'q1', type: TYPE, created: '2026-01-01T00:00:01.000Z', params: {} });
	store.insert({ id: 'q2', type: TYPE, created: '2026-01-01T00:00:02.000Z', params: {} });
	for (const [id, status] of [['d1', 'done'], ['f1', 'failed'], ['f2', 'failed'], ['c1', 'cancelled']]) {
		store.insert({ id, type: TYPE, created: '2026-01-01T00:00:00.000Z', params: {} });
		store.transition(id, status, Date.now());
	}

	const report = await orchestrator.scan({ notify: false });

	assert.equal(report.inbox, 2, 'inbox is the queued bucket, as it always meant');
	assert.equal(report.running, 0);
	assert.equal(report.done, 1);
	assert.equal(report.failed, 2);
	assert.equal(report.cancelled, 1);
});

test('the Scan notice names cancelled/recovered/pruned only when they are non-zero', async () => {
	globalThis.__orchestratorScanNotices = [];
	const { orchestrator, store } = newOrchestrator();
	store.insert({ id: 'q1', type: TYPE, created: '2026-01-01T00:00:01.000Z', params: {} });

	await orchestrator.scan();
	assert.equal(globalThis.__orchestratorScanNotices.length, 1);
	assert.equal(globalThis.__orchestratorScanNotices[0], 'Orchestrate: inbox 1, running 0, done 0, failed 0');

	globalThis.__orchestratorScanNotices = [];
	seedRunning(store, 'stale', 631_000);
	store.insert({ id: 'c1', type: TYPE, created: '2026-01-01T00:00:00.000Z', params: {} });
	store.transition('c1', 'cancelled', Date.now());

	await orchestrator.scan();
	assert.match(globalThis.__orchestratorScanNotices[0], /, cancelled 1, recovered 1$/);
});

test('scan is a no-op that answers an all-zero report before any type has registered', async () => {
	// The registration-failure path: main.ts catches the throw and carries on, and the
	// silent startup scan still runs. It must not throw or force the store open.
	const orchestrator = new Orchestrator(makePlugin(), { openDbStore: () => { throw new Error('never opened'); } });

	const report = await orchestrator.scan({ notify: false });

	assert.deepEqual(report, { inbox: 0, running: 0, done: 0, failed: 0, cancelled: 0, recovered: 0, pruned: 0 });
});
