import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// `requeueServiceFailures` end-to-end, against a real `:memory:` SqliteJobStore.
//
// thq WP-8 made this the ONE home for the bulk requeue's behavior (the file was
// `failedJobRepairDb.test.mjs` while a file arm still existed alongside the db arm).
// The per-file classify/clearError/move loop is deleted, so the six file-arm tests that
// lived in tests/failedJobRepair.test.mjs migrated here as db equivalents — that file
// now covers `classifyFailedJob` and the pattern table only, which is what remains pure
// and shared. See the WP-8 report's migration table for the one test that did not
// migrate ("one job the store refuses to move does not abort the run for the rest"):
// the requeue is a single `UPDATE … WHERE failure_kind = 'service'`, so a per-row
// refusal has no representation — the statement applies to every match or to none.

globalThis.require = createRequire(import.meta.url);

const outdir = path.join(tmpdir(), 'obsidian-crucible-failedjobrepair-requeue-tests');
const outfile = path.join(outdir, 'failedJobRepairRequeue.mjs');

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
		sourcefile: 'failed-job-repair-requeue-test-entry.ts',
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
					'globalThis.__failedJobRepairNotices = globalThis.__failedJobRepairNotices ?? [];',
					'export class Notice { constructor(message) { globalThis.__failedJobRepairNotices.push(message); } }',
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

const TYPE = 'search_upsert_batch';
const OTHER_TYPE = 'youtube_tracker';
const inertWorkflow = { async run() { return { status: 'done' }; } };

function newDbStore() {
	return new SqliteJobStore(openJobsDb(':memory:'));
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

function makeOrchestrator({ bus = makeBus(), dbStore = newDbStore() } = {}) {
	const plugin = {
		ingestionEvents: bus,
		orchestrationAutoRunner: { kickAll: () => { plugin.kicks++; } },
		kicks: 0,
		settings: { orchestrationEnabled: true, orchestrationJobRetentionDays: 30 },
		app: { vault: { getAbstractFileByPath: () => null }, workspace: { onLayoutReady: () => {} } },
	};
	const orchestrator = new Orchestrator(plugin, { openDbStore: () => dbStore });
	orchestrator.register(TYPE, inertWorkflow, { persistence: 'db', maxParallel: 1, minIntervalMs: 0 });
	orchestrator.register(OTHER_TYPE, inertWorkflow, { persistence: 'db', maxParallel: 1, minIntervalMs: 0 });
	plugin.orchestrator = orchestrator;
	return { plugin, orchestrator, dbStore, bus };
}

let seedCounter = 0;
function seedFailed(dbStore, id, { failureKind, type = TYPE, error = 'boom' }) {
	seedCounter += 1;
	dbStore.insert({ id, type, created: `2026-01-01T00:00:00.${String(seedCounter % 1000).padStart(3, '0')}Z`, params: {} });
	dbStore.transition(id, 'failed', Date.now(), { error, failureKind });
}

test('the requeue moves failure_kind=service rows in one statement, clears their diagnostic, and emits exactly once', async () => {
	const { plugin, dbStore, bus } = makeOrchestrator();
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

	assert.equal(bus.count('orchestration-queue-updated'), 1, 'one emit for the whole run, never per job');
	assert.equal(plugin.kicks, 1, 'kicked once after the emit');
});

test('a dry run previews the breakdown by type and writes nothing', async () => {
	const { plugin, dbStore, bus } = makeOrchestrator();
	seedFailed(dbStore, 'svc-1', { failureKind: 'service' });
	seedFailed(dbStore, 'svc-2', { failureKind: 'service' });
	seedFailed(dbStore, 'svc-3', { failureKind: 'service', type: OTHER_TYPE });
	seedFailed(dbStore, 'genuine-1', { failureKind: 'job' });

	const preview = await requeueServiceFailures(plugin, { dryRun: true });

	assert.equal(preview.total, 4);
	assert.equal(preview.requeued, 3);
	assert.equal(preview.skipped, 1);
	assert.deepEqual(preview.byType, { [TYPE]: 2, [OTHER_TYPE]: 1 }, 'the confirm modal gets a per-type breakdown');

	assert.equal(dbStore.get('svc-1').status, 'failed', 'dry run mutates nothing');
	assert.equal(dbStore.get('svc-3').status, 'failed');
	assert.equal(bus.count('orchestration-queue-updated'), 0);
	assert.equal(plugin.kicks, 0);
});

test('running and queued rows are never touched', async () => {
	const { plugin, dbStore } = makeOrchestrator();
	seedFailed(dbStore, 'svc-1', { failureKind: 'service' });
	const running = dbStore.insert({ id: 'running-1', type: TYPE, created: '2026-01-01T00:00:01.000Z', params: {} });
	dbStore.claimById(running.id, Date.now());
	dbStore.insert({ id: 'queued-1', type: TYPE, created: '2026-01-01T00:00:02.000Z', params: {} });

	await requeueServiceFailures(plugin, { dryRun: false });

	assert.equal(dbStore.get('running-1').status, 'running', 'a running row is never a failed row — untouched either way');
	assert.equal(dbStore.get('queued-1').status, 'queued', 'an already-queued row is untouched');
	assert.equal(dbStore.get('svc-1').status, 'queued', 'only the failed/service row moved');
});

test('a genuine-only failed bucket requeues nothing and emits nothing', async () => {
	const { plugin, dbStore, bus } = makeOrchestrator();
	seedFailed(dbStore, 'genuine-1', { failureKind: 'job', error: 'YouTube Data API: video xyz not found' });

	const result = await requeueServiceFailures(plugin, { dryRun: false });

	assert.equal(result.requeued, 0);
	assert.equal(result.skipped, 1);
	assert.equal(dbStore.get('genuine-1').status, 'failed', 'the genuine failure is untouched');
	assert.equal(bus.count('orchestration-queue-updated'), 0);
	assert.equal(plugin.kicks, 0);
});

test('an empty failed bucket is a no-op with an all-zero breakdown', async () => {
	const { plugin, bus } = makeOrchestrator();

	const result = await requeueServiceFailures(plugin, { dryRun: false });

	assert.deepEqual(result, { total: 0, byType: {}, requeued: 0, skipped: 0 });
	assert.equal(bus.count('orchestration-queue-updated'), 0);
	assert.equal(plugin.kicks, 0);
});

test('a large cohort still requeues in full, in one statement, coalesced into one emit (the 2,022-file shape)', async () => {
	const { plugin, dbStore, bus } = makeOrchestrator();
	for (let i = 0; i < 45; i++) seedFailed(dbStore, `outage-${i}`, { failureKind: 'service' });

	const result = await requeueServiceFailures(plugin, { dryRun: false });

	assert.equal(result.requeued, 45);
	assert.equal(dbStore.count('queued'), 45);
	assert.equal(dbStore.count('failed'), 0);
	assert.equal(bus.count('orchestration-queue-updated'), 1);
	assert.equal(plugin.kicks, 1);
});

test('selection reads the stamped failure_kind column, not the error text', async () => {
	// The behavioral difference the cutover introduced, and the reason the classifier is
	// still the single source of truth: `classifyFailedJob` runs ONCE, at settle time,
	// and stamps `failure_kind`. The requeue then selects on the column. So a row whose
	// error text no longer matches any pattern still requeues if it was stamped
	// `service`, and a row whose text *would* match does not if it was stamped `job` —
	// which is what makes the bulk repair one statement instead of a per-row re-scan.
	const { plugin, dbStore } = makeOrchestrator();
	seedFailed(dbStore, 'stamped-service', { failureKind: 'service', error: 'nothing here matches a pattern' });
	seedFailed(dbStore, 'stamped-job', { failureKind: 'job', error: 'net::ERR_CONNECTION_REFUSED' });

	const result = await requeueServiceFailures(plugin, { dryRun: false });

	assert.equal(result.requeued, 1);
	assert.equal(dbStore.get('stamped-service').status, 'queued');
	assert.equal(dbStore.get('stamped-job').status, 'failed');
});

test('a requeued job is immediately claimable again — no leftover deferral or diagnostic', async () => {
	// The point of the repair: the cohort has to actually drain afterwards. A row put
	// back in `queued` still carrying `defer_until` would sit there invisibly.
	const { plugin, dbStore } = makeOrchestrator();
	seedFailed(dbStore, 'svc-1', { failureKind: 'service' });

	await requeueServiceFailures(plugin, { dryRun: false });

	const claimed = dbStore.claimNext(Date.now(), [TYPE]);
	assert.ok(claimed, 'the requeued job is claimable');
	assert.equal(claimed.id, 'svc-1');
	assert.equal(claimed.deferUntil, undefined);
	assert.equal(claimed.error, undefined);
});
