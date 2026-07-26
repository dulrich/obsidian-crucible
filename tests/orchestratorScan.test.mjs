import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-orchestrator-scan-tests');
const outfile = path.join(outdir, 'Orchestrator.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/orchestration/Orchestrator.ts'],
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

const { Orchestrator, staleRunningMsForTimeout } = await import(pathToFileURL(outfile));

test('staleRunningMsForTimeout uses timeout plus buffer, or one-hour fallback when disabled', () => {
	assert.equal(staleRunningMsForTimeout(600_000), 630_000);
	assert.equal(staleRunningMsForTimeout(0), 60 * 60_000);
});

test('scan silently requeues jobs older than the configured timeout buffer', async () => {
	globalThis.__orchestratorScanNotices = [];
	const moved = [];
	const errors = [];
	const old = new Date(Date.now() - 631_000).toISOString();
	const store = makeStore({
		running: [{
			file: { path: 'queue/running/search.md' },
			job: { id: 'job-1', type: 'search_upsert_file', status: 'running', created: old, updated: old, params: { path: 'note.md' } },
		}],
	});
	store.move = async (file, job, status) => {
		moved.push({ file, job, status });
		return { file, job: { ...job, status } };
	};
	store.setError = async (file, error) => {
		errors.push({ file, error });
	};
	const plugin = { settings: { orchestrationAutorunTimeoutSeconds: 600 } };
	const orchestrator = new Orchestrator(plugin, store);

	const report = await orchestrator.scan({ notify: false });

	assert.equal(report.recovered, 1);
	assert.equal(report.running, 0);
	assert.deepEqual(moved.map(item => item.status), ['queued']);
	assert.match(errors[0].error, /Recovered: stale running job/);
	assert.deepEqual(globalThis.__orchestratorScanNotices, []);
});

test('scan keeps recently running jobs active', async () => {
	const fresh = new Date(Date.now() - 629_000).toISOString();
	const store = makeStore({
		running: [{
			file: { path: 'queue/running/search.md' },
			job: { id: 'job-1', type: 'search_upsert_file', status: 'running', created: fresh, updated: fresh, params: { path: 'note.md' } },
		}],
	});
	store.move = async () => {
		throw new Error('fresh job should not move');
	};
	store.setError = async () => {
		throw new Error('fresh job should not be marked stale');
	};
	const plugin = { settings: { orchestrationAutorunTimeoutSeconds: 600 } };
	const orchestrator = new Orchestrator(plugin, store);

	const report = await orchestrator.scan({ notify: false });

	assert.equal(report.recovered, 0);
	assert.equal(report.running, 1);
});

// The stale sweep's premise is "no live timer owns this job". A run registered in
// THIS process is the counter-example, and the guard used to be `isCancelling` — which
// is true only for a job someone asked to stop. A merely long job (a search batch, an
// LLM step) whose `updated` stamp aged past the cutoff was bounced running → queued
// while it was still executing, then claimed and run a second time: two concurrent
// runs of one job, both writing the same note.
test('scan does not re-queue a job this process is still executing, however stale its stamp', async () => {
	const ancient = new Date(Date.now() - 10 * 60 * 60_000).toISOString();
	const file = { path: 'queue/running/long.md' };
	const job = { id: 'job-long', type: 'command_run', status: 'running', created: ancient, updated: ancient, params: {} };
	const moves = [];
	const store = makeStore({ running: [{ file, job }] });
	store.move = async (f, j, status) => {
		moves.push(status);
		return { file: f, job: { ...j, status } };
	};

	const plugin = {
		settings: {
			orchestrationEnabled: true,
			orchestrationAutorunTimeoutSeconds: 600,
			orchestrationRoutineNoticesEnabled: {},
		},
	};
	const orchestrator = new Orchestrator(plugin, store);
	let release = () => {};
	const gate = new Promise(resolve => { release = resolve; });
	orchestrator.register('command_run', { async run() { await gate; return { status: 'done' }; } },
		{ persistence: 'file', maxParallel: 1, minIntervalMs: 0 });

	// Start the run the way the drain would, so it registers in the backend's running
	// registry, then scan while it is mid-flight.
	const execution = orchestrator.backends.get('command_run').execute({ file, job });
	await new Promise(resolve => setTimeout(resolve, 0));

	const report = await orchestrator.scan({ notify: false });

	assert.equal(report.recovered, 0, 'a live run is not a stranded job');
	assert.equal(report.running, 1);
	assert.deepEqual(moves, [], 'and nothing was moved out from under it');

	release();
	await execution;
	assert.deepEqual(moves, ['done'], 'it settled itself, exactly once');
});

function makeStore(folders) {
	return {
		ensureFolders: async () => {},
		listFolder: async (name) => folders[name] ?? [],
		appendNotes: async () => {},
		move: async (file, job, status) => ({ file, job: { ...job, status } }),
		setError: async () => {},
	};
}
