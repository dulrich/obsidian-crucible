import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Covers classifyFailedJob's pattern table and requeueServiceFailures's bulk
// requeue mechanics. FileJobBackend.failEntry's use of the SAME classifier (the
// forward-looking failureKind stamp) is tested alongside the rest of failEntry's
// behavior in tests/queueControl.test.mjs, not duplicated here.
const outdir = path.join(tmpdir(), 'obsidian-crucible-failedjobrepair-tests');
const outfile = path.join(outdir, 'failedJobRepair.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/orchestration/failedJobRepair.ts'],
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
					'globalThis.__failedJobRepairNotices = globalThis.__failedJobRepairNotices ?? [];',
					'export class Notice { constructor(message) { globalThis.__failedJobRepairNotices.push(message); } }',
					'export class Modal { constructor() {} open() {} close() {} }',
					'export class App {}',
					'export class TFile {}',
					'export class TFolder {}',
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

const { classifyFailedJob, requeueServiceFailures } = await import(pathToFileURL(outfile).href);

const JOB = { type: 'search_upsert_batch' };

// --- classifyFailedJob: the conservative pattern table -----------------------

test('classifyFailedJob matches every outage signature in the pattern table', () => {
	const mustMatch = [
		// connection-refused: both runtime shapes the real 2,022-file cohort could carry.
		'Search service /v1/index/upsert unreachable: TypeError: fetch failed: net::ERR_CONNECTION_REFUSED',
		'connect ECONNREFUSED 127.0.0.1:4801',
		// companion-unreachable
		'Search companion not reachable at http://localhost:4801/health. Start it with: home-compose up crucible-search (dev fallback: npm run search:serve)',
		'Search service /v1/index/upsert unreachable: TypeError: fetch failed',
		// companion-5xx
		'Search service /v1/search returned 503: Service Unavailable',
		'Search service /v1/index/upsert returned 500: internal error',
		// youtube-quota / youtube-5xx
		'YouTube Data API: quota exceeded',
		'YouTube Data API: HTTP 503 — Service Unavailable',
		// all-channel-feeds-failed
		'All 12 channel feeds failed to fetch.',
		'All 1 channel feeds failed to fetch.',
	];
	for (const text of mustMatch) {
		assert.equal(classifyFailedJob(JOB, text), 'service-outage', `expected a match: ${text}`);
	}
});

test('classifyFailedJob never matches the excluded genuine-failure shapes', () => {
	const mustNotMatch = [
		// video-not-found
		'YouTube Data API: video dQw4w9WgXcQ not found',
		'YouTube Data API: channel UC12345 not found',
		// bad/missing API key
		'YouTube Data API: forbidden (HTTP 403). Check the API key and Data API enablement.',
		'YouTube Data API key not configured.',
		// malformed JSON
		'YouTube Data API: malformed JSON response',
		'Unexpected token < in JSON at position 0',
		// a 4xx from the companion is a real client-side bug, not an outage
		'Search service /v1/index/upsert returned 400: width conflict',
		// cancelled
		'Job cancelled by user',
		'Cancelled before it ran',
	];
	for (const text of mustNotMatch) {
		assert.equal(classifyFailedJob(JOB, text), 'genuine', `expected no match: ${text}`);
	}
});

test('unclassifiable or missing error text is always genuine — never requeue what cannot be classified', () => {
	assert.equal(classifyFailedJob(JOB, undefined), 'genuine');
	assert.equal(classifyFailedJob(JOB, ''), 'genuine');
	assert.equal(classifyFailedJob(JOB, 'something totally unrelated happened'), 'genuine');
});

// --- requeueServiceFailures ---------------------------------------------------

function failedEntry(id, type, error) {
	return { file: { path: `queue/failed/${id}.md` }, job: { id, type, status: 'failed', params: {}, error } };
}

function makeStore(failed) {
	const folders = { queued: [], running: [], done: [], failed: [...failed], cancelled: [] };
	const cleared = [];
	const moved = [];
	return {
		folders,
		cleared,
		moved,
		ensureFolders: async () => {},
		listFolder: async (status) => [...(folders[status] ?? [])],
		clearError: async (file) => { cleared.push(file.path); },
		move: async (file, job, toStatus) => {
			const idx = folders.failed.findIndex(e => e.file === file);
			if (idx >= 0) folders.failed.splice(idx, 1);
			const movedEntry = { file, job: { ...job, status: toStatus } };
			folders[toStatus].push(movedEntry);
			moved.push({ id: job.id, toStatus });
			return movedEntry;
		},
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

// WP-7: requeueServiceFailures now dispatches its db arm through
// `plugin.orchestrator.requeueServiceOutageDbFailures` and emits through
// `plugin.orchestrator.emitQueueChangedNow()` instead of calling `emitQueueChanged`
// directly. None of these tests register a `db`-persisted type, so the db arm must
// stay a true no-op (mirrors `Orchestrator.requeueServiceOutageDbFailures`'s own
// `!this.dbStore` early return) and the emit must reproduce the exact
// `fileQueueCountsSource` shape (`{queued, running}` from two `listFolder` reads) so
// every existing emit-count/payload assertion below is unaffected.
function makeOrchestrator(store, bus) {
	return {
		requeueServiceOutageDbFailures: () => ({ total: 0, byType: {}, requeued: 0 }),
		emitQueueChangedNow: async () => {
			const [running, queued] = await Promise.all([store.listFolder('running'), store.listFolder('queued')]);
			bus.emit('orchestration-queue-updated', { queued: queued.length, running: running.length });
		},
	};
}

function makePlugin(store) {
	const kicks = [];
	const bus = makeBus();
	return {
		jobStore: store,
		ingestionEvents: bus,
		orchestrationAutoRunner: { kickAll: () => kicks.push(true) },
		orchestrator: makeOrchestrator(store, bus),
		kicks,
	};
}

function seedCohort() {
	return [
		failedEntry('outage-1', 'search_upsert_batch', 'net::ERR_CONNECTION_REFUSED'),
		failedEntry('outage-2', 'search_upsert_batch', 'Search service /v1/search returned 503: down'),
		failedEntry('outage-3', 'youtube_tracker', 'YouTube Data API: quota exceeded'),
		failedEntry('genuine-1', 'youtube_metadata_fetch', 'YouTube Data API: video xyz not found'),
	];
}

test('dry run returns the full breakdown and mutates nothing', async () => {
	const store = makeStore(seedCohort());
	const plugin = makePlugin(store);

	const result = await requeueServiceFailures(plugin, { dryRun: true });

	assert.equal(result.total, 4);
	assert.equal(result.requeued, 3);
	assert.equal(result.skipped, 1);
	assert.deepEqual(result.byType, { search_upsert_batch: 2, youtube_tracker: 1 });

	assert.equal(store.folders.failed.length, 4, 'dry run leaves every file exactly where it was');
	assert.equal(store.folders.queued.length, 0);
	assert.equal(store.cleared.length, 0, 'no error was cleared');
	assert.equal(store.moved.length, 0, 'nothing was moved');
	assert.equal(plugin.ingestionEvents.count('orchestration-queue-updated'), 0);
	assert.equal(plugin.kicks.length, 0);
});

test('execute moves matches to queued/ with their error cleared, and emits exactly once', async () => {
	const store = makeStore(seedCohort());
	const plugin = makePlugin(store);

	const result = await requeueServiceFailures(plugin, { dryRun: false });

	assert.equal(result.requeued, 3);
	assert.equal(result.skipped, 1);
	assert.deepEqual(result.byType, { search_upsert_batch: 2, youtube_tracker: 1 });

	assert.deepEqual(store.folders.queued.map(e => e.job.id).sort(), ['outage-1', 'outage-2', 'outage-3']);
	assert.equal(store.folders.failed.length, 1, 'the genuine failure was left in failed/');
	assert.equal(store.folders.failed[0].job.id, 'genuine-1');
	assert.deepEqual(
		store.cleared.sort(),
		['queue/failed/outage-1.md', 'queue/failed/outage-2.md', 'queue/failed/outage-3.md'],
		'every requeued job had its error cleared, and only those',
	);

	assert.equal(plugin.ingestionEvents.count('orchestration-queue-updated'), 1,
		'one emit for the whole run, never per job');
	assert.equal(plugin.kicks.length, 1, 'kicked once after the emit');
});

test('a genuine-only failed/ requeues nothing and emits nothing', async () => {
	const store = makeStore([failedEntry('genuine-1', 'youtube_metadata_fetch', 'YouTube Data API: video xyz not found')]);
	const plugin = makePlugin(store);

	const result = await requeueServiceFailures(plugin, { dryRun: false });

	assert.equal(result.requeued, 0);
	assert.equal(result.skipped, 1);
	assert.equal(store.folders.failed.length, 1, 'the genuine failure is untouched');
	assert.equal(plugin.ingestionEvents.count('orchestration-queue-updated'), 0);
	assert.equal(plugin.kicks.length, 0);
});

test('an empty failed/ is a no-op with an all-zero breakdown', async () => {
	const store = makeStore([]);
	const plugin = makePlugin(store);

	const result = await requeueServiceFailures(plugin, { dryRun: false });

	assert.deepEqual(result, { total: 0, byType: {}, requeued: 0, skipped: 0 });
	assert.equal(plugin.ingestionEvents.count('orchestration-queue-updated'), 0);
});

test('a large cohort still requeues in full, coalesced into one emit (the 2,022-file shape)', async () => {
	const cohort = Array.from({ length: 45 }, (_, i) => failedEntry(`outage-${i}`, 'search_upsert_batch', 'net::ERR_CONNECTION_REFUSED'));
	const store = makeStore(cohort);
	const plugin = makePlugin(store);

	const result = await requeueServiceFailures(plugin, { dryRun: false });

	assert.equal(result.requeued, 45);
	assert.equal(store.folders.queued.length, 45);
	assert.equal(store.folders.failed.length, 0);
	assert.equal(plugin.ingestionEvents.count('orchestration-queue-updated'), 1);
	assert.equal(plugin.kicks.length, 1);
});

test('one job the store refuses to move does not abort the run for the rest of the cohort', async () => {
	const cohort = seedCohort();
	const store = makeStore(cohort);
	const originalMove = store.move;
	store.move = async (file, job, toStatus) => {
		if (job.id === 'outage-2') throw new Error('frontmatter write failed');
		return originalMove(file, job, toStatus);
	};
	const plugin = makePlugin(store);

	const result = await requeueServiceFailures(plugin, { dryRun: false });

	assert.equal(result.requeued, 2, 'outage-1 and outage-3 requeued; outage-2 counted honestly, not as requeued');
	assert.equal(result.skipped, 2, 'the genuine failure plus the one the store refused');
	assert.deepEqual(store.folders.queued.map(e => e.job.id).sort(), ['outage-1', 'outage-3']);
	assert.ok(store.folders.failed.some(e => e.job.id === 'outage-2'), 'the refused job stays in failed/');
	assert.equal(plugin.ingestionEvents.count('orchestration-queue-updated'), 1, 'the rest of the run still emits once');
});
