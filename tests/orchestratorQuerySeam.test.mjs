import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// thq WP-7/WP-8: covers the backend-agnostic query seam (`JobBackend.ts`'s
// `JobQuerySeam` + `Orchestrator.listJobs`/`listTypeJobs`/`countJobs`/`setJobProgress`)
// that the queue monitor, intake buttons, enrichment badges and SearchJobProgress go
// through instead of reaching around into a storage layer directly. See
// tests/dbJobBackend.test.mjs's "9. the WP-7 seam" section for
// `DbJobBackend.list/count/setProgress` in isolation; this file exercises the same seam
// through `Orchestrator`, across several registered types at once.
//
// WP-8 note: these used to assert a two-source MERGE (a markdown file store plus the
// db). The file store is gone, so what is pinned now is the property that survived —
// `listJobs` spans EVERY registered type in one claim-ordered pass, rather than being
// scoped to whichever type a caller happens to hold.

globalThis.require = createRequire(import.meta.url);

const outdir = path.join(tmpdir(), 'obsidian-crucible-orchestrator-query-seam-tests');
const outfile = path.join(outdir, 'orchestratorQuerySeam.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { Orchestrator } from './src/orchestration/Orchestrator';",
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

const TYPE_A = 'command_run';
const TYPE_B = 'chain_run';
const config = { persistence: 'db', minIntervalMs: 0, maxParallel: 1 };
const inertWorkflow = { async run() { return { status: 'done' }; } };

function newDbStore() {
	return new SqliteJobStore(openJobsDb(':memory:'));
}

// An Orchestrator with `types` registered against one `:memory:` store.
function newOrchestrator({ plugin = makePlugin(), types = [TYPE_A, TYPE_B], store = newDbStore() } = {}) {
	const orchestrator = new Orchestrator(plugin, { openDbStore: () => store });
	for (const type of types) orchestrator.register(type, inertWorkflow, config);
	return { orchestrator, store, plugin };
}

// --- 1. listJobs spans every registered type, in claim order, honoring limit --------

test('listJobs returns jobs of ALL registered types in one claim-ordered list', async () => {
	const { orchestrator, store } = newOrchestrator();

	store.insert({ id: 'b-2', type: TYPE_B, created: '2026-01-01T00:00:03.000Z', params: {} });
	store.insert({ id: 'a-2', type: TYPE_A, created: '2026-01-01T00:00:02.000Z', params: {} });
	store.insert({ id: 'a-1', type: TYPE_A, created: '2026-01-01T00:00:01.000Z', params: {} });
	store.insert({ id: 'b-1', type: TYPE_B, created: '2026-01-01T00:00:00.500Z', params: {} });

	const queued = await orchestrator.listJobs('queued');
	assert.deepEqual(queued.map(j => j.id), ['b-1', 'a-1', 'a-2', 'b-2'],
		'ordered by created across types, never grouped by type');

	// A status with nothing in it answers cleanly rather than throwing.
	assert.deepEqual(await orchestrator.listJobs('running'), []);
});

test('listJobs limit is a real query-level cap over the globally ordered result', async () => {
	const { orchestrator, store } = newOrchestrator();
	store.insert({ id: 'a-1', type: TYPE_A, created: '2026-01-01T00:00:01.000Z', params: {} });
	store.insert({ id: 'a-2', type: TYPE_A, created: '2026-01-01T00:00:02.000Z', params: {} });
	store.insert({ id: 'b-1', type: TYPE_B, created: '2026-01-01T00:00:00.100Z', params: {} });
	store.insert({ id: 'b-2', type: TYPE_B, created: '2026-01-01T00:00:03.000Z', params: {} });

	const top2 = await orchestrator.listJobs('queued', { limit: 2 });
	assert.deepEqual(top2.map(j => j.id), ['b-1', 'a-1'], 'earliest two across ALL types, not the first two of one');

	const page2 = await orchestrator.listJobs('queued', { limit: 2, offset: 2 });
	assert.deepEqual(page2.map(j => j.id), ['a-2', 'b-2'], 'offset pages the same ordering');
});

test('listJobs answers empty before any type has registered (no store exists yet)', async () => {
	const orchestrator = new Orchestrator(makePlugin(), { openDbStore: () => { throw new Error('never opened'); } });
	assert.deepEqual(await orchestrator.listJobs('queued'), []);
});

test('listJobs carries the fields the queue monitor renders, including notes', async () => {
	// The row → OrchestrationJob mapping the Details modal depends on. `notes` is the
	// one field that only ever arrives on a db row (WP-7 left it undefined for file
	// rows); post-cutover every row can carry it.
	const { orchestrator, store } = newOrchestrator();
	const row = store.insert({ id: 'a-1', type: TYPE_A, created: '2026-01-01T00:00:01.000Z', params: { targetPath: 'note.md' } });
	store.appendNotes(row.id, 'Partial: 3 of 10 done');
	store.setProgress(row.id, 'batch 3 / 10');

	const [job] = await orchestrator.listJobs('queued');
	assert.equal(job.type, TYPE_A);
	assert.deepEqual(job.params, { targetPath: 'note.md' });
	assert.equal(job.progress, 'batch 3 / 10');
	assert.match(job.notes, /Partial: 3 of 10 done/);
});

// --- 2. listTypeJobs scopes to one type (the enrichment badges' read) --------------

test('listTypeJobs returns only that type, across the statuses asked for', async () => {
	const { orchestrator, store } = newOrchestrator();
	store.insert({ id: 'a-queued', type: TYPE_A, created: '2026-01-01T00:00:01.000Z', params: {} });
	const running = store.insert({ id: 'a-running', type: TYPE_A, created: '2026-01-01T00:00:02.000Z', params: {} });
	store.claimById(running.id, Date.now());
	store.insert({ id: 'b-queued', type: TYPE_B, created: '2026-01-01T00:00:03.000Z', params: {} });

	const jobs = await orchestrator.listTypeJobs(TYPE_A, ['running', 'queued']);
	assert.deepEqual(jobs.map(j => j.id).sort(), ['a-queued', 'a-running']);
	assert.deepEqual(jobs.map(j => j.status), ['running', 'queued'], 'statuses come back in the order requested');

	assert.deepEqual(await orchestrator.listTypeJobs(TYPE_A, []), [], 'no statuses asked for, nothing returned');
});

test('listTypeJobs answers empty for an unregistered type rather than throwing', async () => {
	const { orchestrator } = newOrchestrator({ types: [TYPE_A] });
	assert.deepEqual(await orchestrator.listTypeJobs('link_scan', ['queued']), []);
});

// --- 3. countJobs dispatches per type, scoped correctly ----------------------------

test('countJobs answers per type, ignoring other types and other statuses', async () => {
	const { orchestrator, store } = newOrchestrator();
	store.insert({ id: 'a-1', type: TYPE_A, created: '2026-01-01T00:00:01.000Z', params: {} });
	const running = store.insert({ id: 'a-2', type: TYPE_A, created: '2026-01-01T00:00:02.000Z', params: {} });
	store.claimById(running.id, Date.now());
	store.insert({ id: 'b-1', type: TYPE_B, created: '2026-01-01T00:00:03.000Z', params: {} });

	assert.equal(await orchestrator.countJobs(TYPE_A, ['queued']), 1);
	assert.equal(await orchestrator.countJobs(TYPE_A, ['running']), 1);
	assert.equal(await orchestrator.countJobs(TYPE_A, ['queued', 'running']), 2);
	assert.equal(await orchestrator.countJobs('link_scan', ['queued']), 0, 'link_scan has no registered backend');
});

// --- 4. setJobProgress dispatches to the job's own backend and emits coalesced -----

test('setJobProgress writes the row and emits orchestration-queue-updated', async () => {
	const bus = makeBus();
	const { orchestrator, store } = newOrchestrator({ plugin: makePlugin({ ingestionEvents: bus }) });
	const row = store.insert({ id: 'job-1', type: TYPE_A, created: '2026-01-01T00:00:00.000Z', params: {} });
	store.claimById(row.id, Date.now());

	await orchestrator.setJobProgress(TYPE_A, row.id, 'batch 3 / 10');
	await flush();

	assert.equal(store.get(row.id).progress, 'batch 3 / 10');
	assert.equal(bus.count('orchestration-queue-updated'), 1);
});

test('setJobProgress writes nothing for an id that does not exist, and never throws', async () => {
	const bus = makeBus();
	const { orchestrator, store } = newOrchestrator({ plugin: makePlugin({ ingestionEvents: bus }) });

	await orchestrator.setJobProgress(TYPE_A, 'ghost-job', 'should not throw');
	await flush();

	assert.equal(store.get('ghost-job'), null, 'the guarded UPDATE matched no row');
	// It DOES still emit (the backend emits after the write without checking the row
	// count), unlike the markdown backend which returned early when it could not resolve
	// the job's file. Pinned as-is rather than "fixed": the emit is coalesced, the
	// payload is correct either way, and the only caller is a progress tick for a job it
	// is actively running — a ghost id here means a bug upstream, not a hot path.
	assert.equal(bus.count('orchestration-queue-updated'), 1);
});

test('setJobProgress is a no-op for an unregistered type', async () => {
	const { orchestrator } = newOrchestrator({ types: [TYPE_A] });
	// Must not throw even though no backend (and therefore no JobQuerySeam) exists.
	await orchestrator.setJobProgress('link_scan', 'whatever', 'no-op');
});
