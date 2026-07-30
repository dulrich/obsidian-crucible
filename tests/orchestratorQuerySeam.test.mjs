import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// thq WP-7: covers the backend-agnostic query seam (`JobBackend.ts`'s `JobQuerySeam` +
// `Orchestrator.listJobs`/`countJobs`/`setJobProgress`) that the queue monitor, intake
// buttons, and SearchJobProgress now go through instead of reaching around into
// `JobStore`/`SqliteJobStore` directly. See tests/dbJobBackend.test.mjs's "9. the WP-7
// seam" section for `DbJobBackend.list/count/setProgress` in isolation; this file
// exercises the same seam through `Orchestrator`, across both backends at once.

globalThis.require = createRequire(import.meta.url);

const outdir = path.join(tmpdir(), 'obsidian-crucible-orchestrator-query-seam-tests');
const outfile = path.join(outdir, 'orchestratorQuerySeam.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { Orchestrator } from './src/orchestration/Orchestrator';",
			"export { FileJobBackend } from './src/orchestration/FileJobBackend';",
			"export { SqliteJobStore } from './src/orchestration/db/SqliteJobStore';",
			"export { openJobsDb } from './src/orchestration/db/sqlite';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'orchestrator-query-seam-test-entry.ts',
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
					'globalThis.__querySeamNotices = globalThis.__querySeamNotices ?? [];',
					'export class Notice { constructor(message) { globalThis.__querySeamNotices.push(message); } }',
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

const { Orchestrator, SqliteJobStore, openJobsDb } = await import(pathToFileURL(outfile).href);

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

// --- file-store fake, mirroring tests/queueControl.test.mjs's shape ---------------

const STORE_FOLDERS = { queued: 'queue/inbox', running: 'queue/running', done: 'queue/done', failed: 'queue/failed', cancelled: 'queue/cancelled' };

function makeFileStore(initial = {}) {
	const folders = {
		queued: [...(initial.queued ?? [])],
		running: [...(initial.running ?? [])],
		done: [], failed: [], cancelled: [],
	};
	const progress = [];
	return {
		folders,
		progress,
		ensureFolders: async () => {},
		folderForStatus: status => STORE_FOLDERS[status],
		// Real JobStore.listFolder returns lane/priority/created/id-sorted rows; this
		// fake only needs the `created` tie-break (every entry below shares one lane
		// and priority) for the merge-order tests to exercise something real rather
		// than accidentally passing on insertion order.
		listFolder: async status => [...(folders[status] ?? [])].sort((a, b) => a.job.created.localeCompare(b.job.created)),
		setProgress: async (file, message) => { progress.push({ path: file.path, message }); },
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

function fileEntry(id, type, status, created) {
	// lane/priority default to what SqliteJobStore.insert would default a `normal`/
	// unspecified-priority row to ('background') — every entry in this file shares
	// them, so the merge tests below are exercising the `created` tie-break, same as
	// the db side gets for free from `insert`'s own defaulting.
	return { file: { path: `${STORE_FOLDERS[status]}/${id}.md` }, job: { id, type, status, created: created ?? '', priority: 'normal', lane: 'background', params: {} } };
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
		app: { vault: { getAbstractFileByPath: () => null }, workspace: { onLayoutReady: () => {} } },
		...overrides,
	};
}

const FILE_TYPE = 'command_run';
const DB_TYPE = 'chain_run';
const fileConfig = { persistence: 'file', minIntervalMs: 0, maxParallel: 1 };
const dbConfig = { persistence: 'db', minIntervalMs: 0, maxParallel: 1 };
const inertWorkflow = { async run() { return { status: 'done' }; } };

function newDbStore() {
	return new SqliteJobStore(openJobsDb(':memory:'));
}

// --- 1. listJobs merges file + db in claim order, honors limit --------------------

test('listJobs merges file-backed and db-backed jobs into one claim-ordered list', async () => {
	const fileStore = makeFileStore({
		queued: [
			fileEntry('file-b', FILE_TYPE, 'queued', '2026-01-01T00:00:02.000Z'),
			fileEntry('file-a', FILE_TYPE, 'queued', '2026-01-01T00:00:01.000Z'),
		],
	});
	const dbStore = newDbStore();
	const plugin = makePlugin();
	const orchestrator = new Orchestrator(plugin, fileStore, { openDbStore: () => dbStore });
	orchestrator.register(FILE_TYPE, inertWorkflow, fileConfig);
	orchestrator.register(DB_TYPE, inertWorkflow, dbConfig);

	dbStore.insert({ id: 'db-b', type: DB_TYPE, created: '2026-01-01T00:00:03.000Z', params: {} });
	dbStore.insert({ id: 'db-a', type: DB_TYPE, created: '2026-01-01T00:00:00.500Z', params: {} });

	const queued = await orchestrator.listJobs('queued');
	assert.deepEqual(queued.map(j => j.id), ['db-a', 'file-a', 'file-b', 'db-b'],
		'file (in-JS-sorted) and db (SQL-sorted) rows interleave by created, not grouped by source');

	// A status that has nothing in one of the two stores still merges cleanly.
	const running = await orchestrator.listJobs('running');
	assert.deepEqual(running, []);
});

test('listJobs limit applies to the globally merged/ordered result, not per source', async () => {
	const fileStore = makeFileStore({
		queued: [
			fileEntry('file-1', FILE_TYPE, 'queued', '2026-01-01T00:00:01.000Z'),
			fileEntry('file-2', FILE_TYPE, 'queued', '2026-01-01T00:00:02.000Z'),
		],
	});
	const dbStore = newDbStore();
	const orchestrator = new Orchestrator(makePlugin(), fileStore, { openDbStore: () => dbStore });
	orchestrator.register(FILE_TYPE, inertWorkflow, fileConfig);
	orchestrator.register(DB_TYPE, inertWorkflow, dbConfig);
	dbStore.insert({ id: 'db-1', type: DB_TYPE, created: '2026-01-01T00:00:00.100Z', params: {} });
	dbStore.insert({ id: 'db-2', type: DB_TYPE, created: '2026-01-01T00:00:03.000Z', params: {} });

	const top2 = await orchestrator.listJobs('queued', { limit: 2 });
	assert.deepEqual(top2.map(j => j.id), ['db-1', 'file-1'], 'earliest two across BOTH sources, not the first two of one');
});

test('listJobs works with no db store at all (today\'s reality — no db type registered)', async () => {
	const fileStore = makeFileStore({ queued: [fileEntry('file-1', FILE_TYPE, 'queued', '2026-01-01T00:00:01.000Z')] });
	const orchestrator = new Orchestrator(makePlugin(), fileStore);
	orchestrator.register(FILE_TYPE, inertWorkflow, fileConfig);

	const queued = await orchestrator.listJobs('queued');
	assert.deepEqual(queued.map(j => j.id), ['file-1']);
});

// --- 2. countJobs dispatches per type, scoped correctly ----------------------------

test('countJobs answers per type, ignoring other types and other statuses', async () => {
	const fileStore = makeFileStore({
		queued: [fileEntry('a', FILE_TYPE, 'queued'), fileEntry('b', 'other_type', 'queued')],
		running: [fileEntry('c', FILE_TYPE, 'running')],
	});
	const orchestrator = new Orchestrator(makePlugin(), fileStore);
	orchestrator.register(FILE_TYPE, inertWorkflow, fileConfig);

	assert.equal(await orchestrator.countJobs(FILE_TYPE, ['queued']), 1);
	assert.equal(await orchestrator.countJobs(FILE_TYPE, ['running']), 1);
	assert.equal(await orchestrator.countJobs(FILE_TYPE, ['queued', 'running']), 2);
	assert.equal(await orchestrator.countJobs('other_type', ['queued']), 0, 'other_type has no registered backend');
});

test('countJobs answers 0 for a memory-persisted type (no query seam)', async () => {
	const orchestrator = new Orchestrator(makePlugin(), makeFileStore());
	orchestrator.register('youtube_metadata_fetch', inertWorkflow, {
		persistence: 'memory', minIntervalMs: 0, maxParallel: 1, dedupeKey: p => String(p.key ?? ''),
	});
	await orchestrator.enqueue('youtube_metadata_fetch', { key: 'note:a.md' });

	assert.equal(await orchestrator.countJobs('youtube_metadata_fetch', ['queued']), 0,
		'memory types render through their own enrichmentQueue adapter, untouched by this seam');
});

// --- 3. setJobProgress dispatches to the job's own backend and emits coalesced ----

test('setJobProgress writes the file row and emits orchestration-queue-updated', async () => {
	const fileStore = makeFileStore({ running: [fileEntry('job-1', FILE_TYPE, 'running')] });
	const bus = makeBus();
	const orchestrator = new Orchestrator(makePlugin({ ingestionEvents: bus }), fileStore);
	orchestrator.register(FILE_TYPE, inertWorkflow, fileConfig);

	await orchestrator.setJobProgress(FILE_TYPE, 'job-1', 'indexing 5/10');
	await flush();

	assert.deepEqual(fileStore.progress, [{ path: 'queue/running/job-1.md', message: 'indexing 5/10' }]);
	assert.equal(bus.count('orchestration-queue-updated'), 1);
});

test('setJobProgress is a silent no-op for an id that is not running (file type)', async () => {
	const fileStore = makeFileStore();
	const bus = makeBus();
	const orchestrator = new Orchestrator(makePlugin({ ingestionEvents: bus }), fileStore);
	orchestrator.register(FILE_TYPE, inertWorkflow, fileConfig);

	await orchestrator.setJobProgress(FILE_TYPE, 'ghost-job', 'should not throw');
	await flush();

	assert.deepEqual(fileStore.progress, []);
	assert.equal(bus.count('orchestration-queue-updated'), 0);
});

test('setJobProgress writes the db row and emits orchestration-queue-updated (coalesced)', async () => {
	const dbStore = newDbStore();
	const bus = makeBus();
	const orchestrator = new Orchestrator(makePlugin({ ingestionEvents: bus }), makeFileStore(), { openDbStore: () => dbStore });
	orchestrator.register(DB_TYPE, inertWorkflow, dbConfig);
	const row = dbStore.insert({ id: 'db-job-1', type: DB_TYPE, created: '2026-01-01T00:00:00.000Z', params: {} });
	dbStore.claimById(row.id, Date.now());

	await orchestrator.setJobProgress(DB_TYPE, row.id, 'batch 3 / 10');
	await flush();

	assert.equal(dbStore.get(row.id).progress, 'batch 3 / 10');
	assert.equal(bus.count('orchestration-queue-updated'), 1);
});

test('setJobProgress is a no-op for a memory-persisted type', async () => {
	const orchestrator = new Orchestrator(makePlugin(), makeFileStore());
	orchestrator.register('youtube_metadata_fetch', inertWorkflow, {
		persistence: 'memory', minIntervalMs: 0, maxParallel: 1, dedupeKey: p => String(p.key ?? ''),
	});
	// Must not throw even though MemoryJobBackend carries no JobQuerySeam.
	await orchestrator.setJobProgress('youtube_metadata_fetch', 'whatever', 'no-op');
});
