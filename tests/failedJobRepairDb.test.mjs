import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// thq WP-7: the db arm of failedJobRepair's bulk service-outage requeue.
// tests/failedJobRepair.test.mjs covers classifyFailedJob and the FILE arm's per-file
// loop (unchanged by this WP, driven through a fake `plugin.orchestrator` that keeps
// the db arm a no-op). This file covers the real db arm — `Orchestrator.
// requeueServiceOutageDbFailures` / `SqliteJobStore.requeueServiceOutageFailed` —
// against a real `:memory:` SqliteJobStore, and the combined file+db result
// `requeueServiceFailures` produces when both queues have a service-outage cohort.

globalThis.require = createRequire(import.meta.url);

const outdir = path.join(tmpdir(), 'obsidian-crucible-failedjobrepair-db-tests');
const outfile = path.join(outdir, 'failedJobRepairDb.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { Orchestrator } from './src/orchestration/Orchestrator';",
			"export { requeueServiceFailures } from './src/orchestration/failedJobRepair';",
			"export { SqliteJobStore } from './src/orchestration/db/SqliteJobStore';",
			"export { openJobsDb } from './src/orchestration/db/sqlite';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'failed-job-repair-db-test-entry.ts',
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
					'globalThis.__failedJobRepairDbNotices = globalThis.__failedJobRepairDbNotices ?? [];',
					'export class Notice { constructor(message) { globalThis.__failedJobRepairDbNotices.push(message); } }',
					'export class Modal { constructor() {} open() {} close() {} }',
					'export class TFile {}',
					'export class TFolder {}',
					'export class App {}',
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

const { Orchestrator, requeueServiceFailures, SqliteJobStore, openJobsDb } = await import(pathToFileURL(outfile).href);

const DB_TYPE = 'search_upsert_batch';
const inertWorkflow = { async run() { return { status: 'done' }; } };

function newDbStore() {
	return new SqliteJobStore(openJobsDb(':memory:'));
}

function makeFileStore(initial = {}) {
	// No file-side failed/ cohort in these tests — an empty, well-formed fake so the
	// file arm's own loop (unchanged) runs and contributes zeros.
	return {
		ensureFolders: async () => {},
		listFolder: async status => [...(initial[status] ?? [])],
	};
}

function makeBus() {
	const emitted = [];
	return {
		emitted,
		on: () => () => {},
		emit: (name, payload) => emitted.push({ name, payload }),
		count: name => emitted.filter(e => e.name === name).length,
	};
}

function makeOrchestrator({ fileStore = makeFileStore(), bus = makeBus(), dbStore = newDbStore() } = {}) {
	const plugin = {
		jobStore: fileStore,
		ingestionEvents: bus,
		orchestrationAutoRunner: { kickAll: () => { plugin.kicks++; } },
		kicks: 0,
		settings: { orchestrationEnabled: true, orchestrationJobRetentionDays: 30 },
		app: { vault: { getAbstractFileByPath: () => null }, workspace: { onLayoutReady: () => {} } },
	};
	const orchestrator = new Orchestrator(plugin, fileStore, { openDbStore: () => dbStore });
	orchestrator.register(DB_TYPE, inertWorkflow, { persistence: 'db', maxParallel: 1, minIntervalMs: 0 });
	plugin.orchestrator = orchestrator;
	return { plugin, orchestrator, dbStore, bus };
}

let seedCounter = 0;
function seedFailed(dbStore, id, { failureKind, type = DB_TYPE }) {
	seedCounter += 1;
	dbStore.insert({ id, type, created: `2026-01-01T00:00:00.${String(seedCounter).padStart(3, '0')}Z`, params: {} });
	dbStore.transition(id, 'failed', Date.now(), { error: 'boom', failureKind });
}

test('the db arm requeues failure_kind=service rows in one statement, and leaves genuine failures alone', async () => {
	const { plugin, dbStore } = makeOrchestrator();
	seedFailed(dbStore, 'svc-1', { failureKind: 'service' });
	seedFailed(dbStore, 'svc-2', { failureKind: 'service' });
	seedFailed(dbStore, 'genuine-1', { failureKind: 'job' });

	const result = await requeueServiceFailures(plugin, { dryRun: false });

	assert.equal(result.requeued, 2);
	assert.equal(result.skipped, 1);
	assert.deepEqual(result.byType, {}, 'live-run byType is empty — nothing downstream reads it post-execution');

	assert.equal(dbStore.get('svc-1').status, 'queued');
	assert.equal(dbStore.get('svc-1').error, undefined, 'error cleared on requeue');
	assert.equal(dbStore.get('svc-1').failureKind, undefined, 'failure_kind cleared on requeue');
	assert.equal(dbStore.get('svc-2').status, 'queued');
	assert.equal(dbStore.get('genuine-1').status, 'failed', 'a genuine failure is left exactly where it was');
	assert.equal(dbStore.get('genuine-1').error, 'boom');
});

test('a dry run previews the breakdown by type and writes nothing', async () => {
	const { plugin, dbStore, bus } = makeOrchestrator();
	seedFailed(dbStore, 'svc-1', { failureKind: 'service' });
	seedFailed(dbStore, 'svc-2', { failureKind: 'service' });
	seedFailed(dbStore, 'genuine-1', { failureKind: 'job' });

	const preview = await requeueServiceFailures(plugin, { dryRun: true });

	assert.equal(preview.total, 3);
	assert.equal(preview.requeued, 2);
	assert.equal(preview.skipped, 1);
	assert.deepEqual(preview.byType, { [DB_TYPE]: 2 });

	assert.equal(dbStore.get('svc-1').status, 'failed', 'dry run mutates nothing');
	assert.equal(dbStore.get('svc-2').status, 'failed');
	assert.equal(bus.count('orchestration-queue-updated'), 0);
});

test('running and queued rows are never touched by the db arm', async () => {
	const { plugin, dbStore } = makeOrchestrator();
	seedFailed(dbStore, 'svc-1', { failureKind: 'service' });
	const running = dbStore.insert({ id: 'running-1', type: DB_TYPE, created: '2026-01-01T00:00:01.000Z', params: {} });
	dbStore.claimById(running.id, Date.now());
	dbStore.insert({ id: 'queued-1', type: DB_TYPE, created: '2026-01-01T00:00:02.000Z', params: {} });

	await requeueServiceFailures(plugin, { dryRun: false });

	assert.equal(dbStore.get('running-1').status, 'running', 'a running row is never a failed row — untouched either way');
	assert.equal(dbStore.get('queued-1').status, 'queued', 'an already-queued row is untouched');
	assert.equal(dbStore.get('svc-1').status, 'queued', 'only the failed/service row moved');
});

test('the combined file+db result emits exactly once and kicks once', async () => {
	const fileFailedEntry = {
		file: { path: 'queue/failed/file-svc-1.md' },
		job: { id: 'file-svc-1', type: 'youtube_tracker', status: 'failed', params: {}, error: 'All 3 channel feeds failed to fetch.' },
	};
	const fileStore = {
		ensureFolders: async () => {},
		listFolder: async status => (status === 'failed' ? [fileFailedEntry] : []),
		clearError: async () => {},
		move: async (file, job, toStatus) => ({ file, job: { ...job, status: toStatus } }),
	};
	const { plugin, dbStore, bus } = makeOrchestrator({ fileStore });
	seedFailed(dbStore, 'svc-1', { failureKind: 'service' });

	const result = await requeueServiceFailures(plugin, { dryRun: false });

	assert.equal(result.requeued, 2, 'one file-arm match plus one db-arm match');
	assert.equal(result.total, 2);
	assert.deepEqual(result.byType, { youtube_tracker: 1 }, 'file-arm byType survives the merge; live-run db byType is empty by design');
	assert.equal(bus.count('orchestration-queue-updated'), 1, 'one emit for the whole combined run, not one per arm');
	assert.equal(plugin.kicks, 1);
});

test('an empty db queue combined with a genuine-only file failed/ requeues and emits nothing', async () => {
	const fileFailedEntry = {
		file: { path: 'queue/failed/genuine.md' },
		job: { id: 'genuine', type: 'youtube_metadata_fetch', status: 'failed', params: {}, error: 'YouTube Data API: video xyz not found' },
	};
	const fileStore = {
		ensureFolders: async () => {},
		listFolder: async status => (status === 'failed' ? [fileFailedEntry] : []),
	};
	const { plugin, bus } = makeOrchestrator({ fileStore });

	const result = await requeueServiceFailures(plugin, { dryRun: false });

	assert.equal(result.requeued, 0);
	assert.equal(result.skipped, 1);
	assert.equal(bus.count('orchestration-queue-updated'), 0);
	assert.equal(plugin.kicks, 0);
});
