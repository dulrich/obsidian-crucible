import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Fix C regression coverage: `OrchestrationAutoRunner.typeWorker` used to let a claim
// throw (e.g. from the JobStore.move claim-path fault) propagate straight out of
// `runNextOfType`, rejecting `drainType`'s `Promise.all`. That skipped the redrain
// replay at the end of `drainType` (a kick that landed mid-drain would be stranded
// until some unrelated later event) and surfaced as an unhandled rejection at the
// `void this.drainType(...)` call site. The fix contains the throw inside the worker's
// own try/catch so the drain — and its redrain replay — completes normally.
const outdir = path.join(tmpdir(), 'obsidian-crucible-autorunner-claim-throw-tests');
const outfile = path.join(outdir, 'autoRunnerClaimThrow.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { Orchestrator } from './src/orchestration/Orchestrator';",
			"export { OrchestrationAutoRunner } from './src/orchestration/OrchestrationAutoRunner';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'autorunner-claim-throw-test-entry.ts',
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
					'globalThis.__autoRunnerClaimThrowNotices = globalThis.__autoRunnerClaimThrowNotices ?? [];',
					'export class Notice { constructor(message) { globalThis.__autoRunnerClaimThrowNotices.push(message); } }',
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

const { Orchestrator, OrchestrationAutoRunner } = await import(pathToFileURL(outfile).href);

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async (turns = 12) => { for (let i = 0; i < turns; i++) await flush(); };

const STORE_FOLDERS = {
	queued: 'queue/inbox',
	running: 'queue/running',
	done: 'queue/done',
	failed: 'queue/failed',
	cancelled: 'queue/cancelled',
};

function makeStore(initial = {}) {
	const folders = { queued: [...(initial.queued ?? [])], running: [], done: [], failed: [], cancelled: [] };
	return {
		folders,
		ensureFolders: async () => {},
		folderForStatus: (status) => STORE_FOLDERS[status],
		listFolder: async (status) => [...(folders[status] ?? [])],
		countFolder: () => 0,
		appendNotes: async () => {},
		setError: async () => {},
		setFailureKind: async () => {},
		setOutputPaths: async () => {},
		setPartial: async () => {},
		setProgress: async () => {},
		setDeferred: async () => {},
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

function makePlugin() {
	return {
		settings: {
			orchestrationEnabled: true,
			orchestrationQueueEnabled: true,
			orchestrationAutorunTimeoutSeconds: 0,
			orchestrationMaxConcurrent: 8,
			orchestrationJobTypeControls: {
				search_upsert_file: { autoRun: true },
			},
			orchestrationRoutineNoticesEnabled: {},
		},
		ingestionEvents: null,
		orchestrationAutoRunner: null,
		serviceHealth: null,
		app: {
			vault: { getAbstractFileByPath: () => null },
			workspace: { onLayoutReady: () => {} },
		},
	};
}

function makeRunner(plugin, orchestrator) {
	const runner = new OrchestrationAutoRunner(plugin, orchestrator);
	plugin.orchestrationAutoRunner = runner;
	runner.fileDrainReady = true;
	return runner;
}

const FILE_TYPE = 'search_upsert_file';
const FILE_CONFIG = { persistence: 'file', maxParallel: 1, minIntervalMs: 0 };

function queuedEntry(id) {
	return { file: { path: `queue/inbox/${id}.md` }, job: { id, type: FILE_TYPE, status: 'queued', params: {} } };
}

test('a claim throw ends the worker iteration without crashing the drain, and is logged', async () => {
	const ran = [];
	const plugin = makePlugin();
	const store = makeStore({ queued: [queuedEntry('job-a')] });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(FILE_TYPE, { async run(job) { ran.push(job.id); return { status: 'done' }; } }, FILE_CONFIG);
	// Simulate the claim path itself throwing — e.g. the JobStore.move claim-path fault —
	// rather than a job-level failure (which the backend already turns into a settled
	// 'ran' outcome well before it reaches the runner).
	orchestrator.runNextOfType = async () => { throw new Error('claim boom: file disappeared after rename'); };
	const runner = makeRunner(plugin, orchestrator);

	let uncaught = null;
	const onUnhandled = (err) => { uncaught = err; };
	process.on('unhandledRejection', onUnhandled);

	globalThis.__CRUCIBLE_DEBUG__ = true;
	const errors = [];
	const origError = console.error;
	console.error = (...args) => errors.push(args.join(' '));
	try {
		runner.kickAll();
		await settle(20);
	} finally {
		console.error = origError;
		process.off('unhandledRejection', onUnhandled);
		delete globalThis.__CRUCIBLE_DEBUG__;
	}

	assert.equal(uncaught, null, 'the claim throw must not escape as an unhandled rejection at the drainType call site');
	assert.deepEqual(ran, [], 'the throwing claim never actually ran the job');
	assert.ok(errors.some(e => e.includes('runNextOfType threw') && e.includes('claim boom')),
		`expected the throw to be logError'd, got: ${errors.join(' | ')}`);

	runner.dispose();
});

test('a claim throw does not swallow a kick that lands mid-drain: the redrain replay still runs', async () => {
	const ran = [];
	const plugin = makePlugin();
	const store = makeStore({ queued: [] });
	const orchestrator = new Orchestrator(plugin, store);
	orchestrator.register(FILE_TYPE, { async run(job) { ran.push(job.id); return { status: 'done' }; } }, FILE_CONFIG);

	const realRunNextOfType = orchestrator.runNextOfType.bind(orchestrator);
	let calls = 0;
	orchestrator.runNextOfType = async (type) => {
		calls++;
		if (calls === 1) throw new Error('claim boom on the first (empty-queue) claim');
		return realRunNextOfType(type);
	};
	const runner = makeRunner(plugin, orchestrator);

	globalThis.__CRUCIBLE_DEBUG__ = true;
	const errors = [];
	const origError = console.error;
	console.error = (...args) => errors.push(args.join(' '));
	try {
		// Starts a drain synchronously (draining.set happens before any await inside
		// drainType/typeWorker), so the very next line lands strictly mid-drain.
		runner.kickAll();
		// A job arrives, and a second kick lands while the first drain is still in
		// flight (about to hit the injected claim throw) — this is exactly the
		// "redrainRequested" case the fix must not strand.
		store.folders.queued.push(queuedEntry('job-mid-drain'));
		runner.kickAll();

		await settle(30);
	} finally {
		console.error = origError;
		delete globalThis.__CRUCIBLE_DEBUG__;
	}

	assert.ok(calls >= 2, 'the drain reclaimed after the throw rather than dying with the worker');
	assert.deepEqual(ran, ['job-mid-drain'],
		'the job kicked in mid-drain ran via the redrain replay, proving it was not stranded by the earlier throw');
	assert.ok(errors.some(e => e.includes('runNextOfType threw')), 'the first (throwing) claim was still logged');

	runner.dispose();
});
