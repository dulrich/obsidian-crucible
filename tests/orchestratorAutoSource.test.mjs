import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// The auto-ENQUEUE source, and the per-type drain flag that sits next to it.
//
// thq WP-8: `MemoryJobQueue` owned both of these and is deleted. Its auto-source
// behavior — "refill only when enabled, skip keys already tracked, and don't re-offer a
// key that just settled" — moved onto `Orchestrator.setAutoSource`/`refill`, backed by
// `SqliteJobStore.settledDedupeKeysSince` instead of an in-memory retention sweep. The
// tests from tests/memoryJobQueue.test.mjs that pinned that behavior migrated here; the
// rest of that file pinned the in-memory queue's own mechanics (claim flip, snapshot
// ordering, releaseToPending, dequeue-vs-cancel) and is covered by the store's own
// suites now — see the WP-8 report's migration table.
//
// The standing rule these encode, from the fleet memory: source-enable and
// execution-enable are separate axes. Auto-enqueue creates jobs; whether they then run
// is the type's auto-run gate. Neither implies the other.

globalThis.require = createRequire(import.meta.url);

const outdir = path.join(tmpdir(), 'obsidian-crucible-auto-source-tests');
const outfile = path.join(outdir, 'autoSource.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { Orchestrator } from './src/orchestration/Orchestrator';",
			"export { OrchestrationAutoRunner } from './src/orchestration/OrchestrationAutoRunner';",
			"export { SqliteJobStore } from './src/orchestration/db/SqliteJobStore';",
			"export { openJobsDb } from './src/orchestration/db/sqlite';",
			"export { ENRICHMENT_JOB_TYPE, youtubeMetadataJobConfig, youtubeMetadataDedupeKey } from './src/orchestration/jobTypeConfig';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'auto-source-test-entry.ts',
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
					'globalThis.__autoSourceNotices = globalThis.__autoSourceNotices ?? [];',
					'export class Notice { constructor(message) { globalThis.__autoSourceNotices.push(message); } }',
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
	SqliteJobStore,
	openJobsDb,
	ENRICHMENT_JOB_TYPE,
	youtubeMetadataJobConfig,
	youtubeMetadataDedupeKey,
} = await import(pathToFileURL(outfile).href);

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async (turns = 12) => { for (let i = 0; i < turns; i++) await flush(); };

function newStore() {
	return new SqliteJobStore(openJobsDb(':memory:'));
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
			orchestrationYoutubeMetadataMaxParallel: 1,
			ingestionYoutubeEnrichRateLimitSeconds: 0,
			...(settings ?? {}),
		},
		ingestionEvents: null,
		orchestrationAutoRunner: null,
		serviceHealth: null,
		app: { vault: { getAbstractFileByPath: () => null }, workspace: { onLayoutReady: () => {} } },
		...overrides,
	};
}

const inertWorkflow = { async run() { return { status: 'done' }; } };

// The real production config for the enrichment type, so these exercise the shipped
// dedupe key, retention window and drain flag rather than a stand-in.
function newOrchestrator({ plugin = makePlugin(), store = newStore(), workflow = inertWorkflow } = {}) {
	const orchestrator = new Orchestrator(plugin, { openDbStore: () => store });
	orchestrator.register(ENRICHMENT_JOB_TYPE, workflow, youtubeMetadataJobConfig(plugin));
	return { orchestrator, store, plugin };
}

// Params for a standalone (uncaptured-video) candidate — no targetPath, which is what
// makes youtubeMetadataDedupeKey mint `video:<id>`.
function candidate(videoId) {
	return { params: { videoId, title: `Video ${videoId}`, channelName: 'Chan' } };
}

function queuedVideoIds(store) {
	return store.list('queued', {}).map(row => row.params.videoId).sort();
}

// --- 1. the enable gate ------------------------------------------------------

test('refill does nothing while the auto-source is disabled', async () => {
	const { orchestrator, store } = newOrchestrator();
	orchestrator.setAutoSource(ENRICHMENT_JOB_TYPE, () => [candidate('aaaaaaaaaaa')]);

	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	assert.equal(store.count('queued'), 0, 'a registered source is not an enabled source');
	assert.equal(orchestrator.isAutoSourceEnabled(ENRICHMENT_JOB_TYPE), false);

	orchestrator.setAutoSourceEnabled(ENRICHMENT_JOB_TYPE, true);
	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	assert.deepEqual(queuedVideoIds(store), ['aaaaaaaaaaa']);
});

test('refill does nothing when the source is enabled but none is registered', async () => {
	// The dashboard clears the source on unmount while leaving the persisted preference
	// alone, so "enabled with no source" is a real steady state, not a bug.
	const { orchestrator, store } = newOrchestrator();
	orchestrator.setAutoSourceEnabled(ENRICHMENT_JOB_TYPE, true);

	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	assert.equal(store.count('queued'), 0);
});

test('refill is a no-op for a type with no source, which is every other type', async () => {
	const { orchestrator, store } = newOrchestrator();
	await orchestrator.refill('command_run');
	assert.equal(store.count('queued'), 0);
});

// --- 2. skipping what is already there ---------------------------------------

test('refill skips candidates already queued or running, and adds only the new ones', async () => {
	const { orchestrator, store } = newOrchestrator();
	const ids = ['aaaaaaaaaaa', 'bbbbbbbbbbb'];
	orchestrator.setAutoSourceEnabled(ENRICHMENT_JOB_TYPE, true);
	orchestrator.setAutoSource(ENRICHMENT_JOB_TYPE, () => ids.map(candidate));

	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	assert.deepEqual(queuedVideoIds(store), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);

	// The source offers the same list again — it always does; it is a view of what is
	// still uncaptured, not a queue of pending work.
	ids.push('ccccccccccc');
	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	assert.deepEqual(queuedVideoIds(store), ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
	assert.equal(store.count('queued'), 3, 'no duplicates: the backend dedupe collapsed the repeats');
});

test('a candidate whose dedupe key is empty is skipped rather than enqueued keyless', async () => {
	const { orchestrator, store } = newOrchestrator();
	orchestrator.setAutoSourceEnabled(ENRICHMENT_JOB_TYPE, true);
	orchestrator.setAutoSource(ENRICHMENT_JOB_TYPE, () => [{ params: { title: 'no id at all' } }]);

	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	assert.equal(store.count('queued'), 0, 'an unkeyed job could never be deduped, so it is never created');
});

// --- 3. the settled-recently suppression -------------------------------------

test('a cancelled job suppresses its own re-seed while the suppression window is live', async () => {
	// THE behavior the window exists for: without it, an enabled source re-adds the item
	// on the very next refill and the user's Cancel reads as ignored.
	const { orchestrator, store } = newOrchestrator();
	orchestrator.setAutoSourceEnabled(ENRICHMENT_JOB_TYPE, true);
	orchestrator.setAutoSource(ENRICHMENT_JOB_TYPE, () => [candidate('aaaaaaaaaaa')]);

	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	const [row] = store.list('queued', {});
	assert.equal(await orchestrator.removeQueuedJob(ENRICHMENT_JOB_TYPE, row.id), 'removed');

	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	assert.equal(store.count('queued'), 0, 'the cancelled job kept its key out of the queue');
	assert.equal(store.count('cancelled'), 1);
});

test('a done job also suppresses its re-seed — a one-shot result is not retried on every refill', async () => {
	const { orchestrator, store } = newOrchestrator();
	orchestrator.setAutoSourceEnabled(ENRICHMENT_JOB_TYPE, true);
	orchestrator.setAutoSource(ENRICHMENT_JOB_TYPE, () => [candidate('aaaaaaaaaaa')]);

	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	assert.equal(await orchestrator.runNextOfType(ENRICHMENT_JOB_TYPE), 'ran');
	assert.equal(store.count('done'), 1);

	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	assert.equal(store.count('queued'), 0);
});

test('the suppression expires on its own — nothing has to sweep it', async () => {
	// `MemoryJobQueue` needed `sweepTerminal` piggybacked onto its read paths so a quiet
	// queue would eventually forget a terminal entry. The durable form is a time window
	// over `settled_at`, so an aged-out row stops suppressing without anyone touching it.
	const { orchestrator, store } = newOrchestrator();
	orchestrator.setAutoSourceEnabled(ENRICHMENT_JOB_TYPE, true);
	orchestrator.setAutoSource(ENRICHMENT_JOB_TYPE, () => [candidate('aaaaaaaaaaa')]);

	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	const [row] = store.list('queued', {});
	await orchestrator.removeQueuedJob(ENRICHMENT_JOB_TYPE, row.id);

	// Backdate the settle past the type's terminalRetentionMs (60s).
	store.db.prepare('UPDATE jobs SET settled_at = ? WHERE id = ?').run(Date.now() - 61_000, row.id);

	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	assert.deepEqual(queuedVideoIds(store), ['aaaaaaaaaaa'],
		'past the window the source may legitimately offer the item again');
});

test('a failed job suppresses its re-seed only for the window, not forever', async () => {
	const { orchestrator, store } = newOrchestrator({
		workflow: { async run() { return { status: 'failed', error: 'transient' }; } },
	});
	orchestrator.setAutoSourceEnabled(ENRICHMENT_JOB_TYPE, true);
	orchestrator.setAutoSource(ENRICHMENT_JOB_TYPE, () => [candidate('aaaaaaaaaaa')]);

	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	assert.equal(await orchestrator.runNextOfType(ENRICHMENT_JOB_TYPE), 'ran');
	const [failed] = store.list('failed', {});

	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	assert.equal(store.count('queued'), 0, 'not retried immediately — that would be a hot loop on a broken item');

	store.db.prepare('UPDATE jobs SET settled_at = ? WHERE id = ?').run(Date.now() - 61_000, failed.id);
	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	assert.equal(store.count('queued'), 1, 'and it is offered again once the window passes');
});

// --- 4. the no-api-key latch --------------------------------------------------

test('a no-api-key failure latches the auto-source off', async () => {
	// Gated on the TYPED failureReason, never on a substring of the error text, so a
	// transient 403 whose message mentions "API key" cannot latch the source off.
	const { orchestrator, store } = newOrchestrator({
		workflow: {
			async run() {
				return { status: 'failed', error: 'YouTube Data API key not configured.', failureReason: 'no-api-key' };
			},
		},
	});
	orchestrator.setAutoSourceEnabled(ENRICHMENT_JOB_TYPE, true);
	orchestrator.setAutoSource(ENRICHMENT_JOB_TYPE, () => [candidate('aaaaaaaaaaa'), candidate('bbbbbbbbbbb')]);
	// `disableAutoSource` is reached through `plugin.orchestrator`, which main.ts wires.
	orchestrator['plugin'].orchestrator = orchestrator;

	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	assert.equal(store.count('queued'), 2);
	assert.equal(await orchestrator.runNextOfType(ENRICHMENT_JOB_TYPE), 'ran');

	assert.equal(orchestrator.isAutoSourceEnabled(ENRICHMENT_JOB_TYPE), false,
		'the credential is missing, so every other candidate is hopeless too');
});

test('an ordinary failure does not latch the auto-source off', async () => {
	const { orchestrator } = newOrchestrator({
		workflow: { async run() { return { status: 'failed', error: 'HTTP 403: check your API key' }; } },
	});
	orchestrator.setAutoSourceEnabled(ENRICHMENT_JOB_TYPE, true);
	orchestrator.setAutoSource(ENRICHMENT_JOB_TYPE, () => [candidate('aaaaaaaaaaa')]);
	orchestrator['plugin'].orchestrator = orchestrator;

	await orchestrator.refill(ENRICHMENT_JOB_TYPE);
	assert.equal(await orchestrator.runNextOfType(ENRICHMENT_JOB_TYPE), 'ran');

	assert.equal(orchestrator.isAutoSourceEnabled(ENRICHMENT_JOB_TYPE), true,
		'a message that merely mentions an API key is not a typed no-api-key verdict');
});

// --- 5. the drain reaches the source ------------------------------------------

test('the drain refills an empty type from its source and then runs what arrived', async () => {
	// The wiring `MemoryJobQueue.refill` used to provide via `refillMemory`: the type
	// worker asks the source exactly when the queue reports empty.
	const ran = [];
	const plugin = makePlugin({
		settings: { orchestrationJobTypeControls: { [ENRICHMENT_JOB_TYPE]: { autoRun: true } } },
	});
	const { orchestrator, store } = newOrchestrator({
		plugin,
		workflow: { async run(job) { ran.push(job.params.videoId); return { status: 'done' }; } },
	});
	orchestrator.setAutoSourceEnabled(ENRICHMENT_JOB_TYPE, true);
	orchestrator.setAutoSource(ENRICHMENT_JOB_TYPE, () => [candidate('aaaaaaaaaaa')]);

	const runner = new OrchestrationAutoRunner(plugin, orchestrator);
	plugin.orchestrationAutoRunner = runner;
	runner.kickAll();
	await settle(20);

	assert.deepEqual(ran, ['aaaaaaaaaaa'], 'nothing was ever enqueued by hand — the source seeded it mid-drain');
	assert.equal(store.count('done'), 1);
	runner.dispose();
});

// --- 6. the per-type drain flag ------------------------------------------------

test('the enrichment type declares drainsWithoutAutorun; ordinary types do not', () => {
	// The contract that had to survive the collapse of two backends into one: it was a
	// property of MemoryJobBackend, and is now per-type config the backend reads.
	const plugin = makePlugin();
	const { orchestrator } = newOrchestrator({ plugin });
	orchestrator.register('command_run', inertWorkflow, { persistence: 'db', maxParallel: 1, minIntervalMs: 0 });

	assert.equal(youtubeMetadataJobConfig(plugin).drainsWithoutAutorun, true);
	assert.equal(orchestrator.drainsWithoutAutorun(ENRICHMENT_JOB_TYPE), true);
	assert.equal(orchestrator.drainsWithoutAutorun('command_run'), false, 'absent means false');
});

test('a drainsWithoutAutorun type is skipped by the manual Run next, which is for the others', async () => {
	// It drains on its own, so spending the user's one explicit "Run next" on it would
	// answer a different question than the one asked.
	const ran = [];
	const plugin = makePlugin();
	const store = newStore();
	const orchestrator = new Orchestrator(plugin, { openDbStore: () => store });
	orchestrator.register(ENRICHMENT_JOB_TYPE, {
		async run(job) { ran.push(job.type); return { status: 'done' }; },
	}, youtubeMetadataJobConfig(plugin));
	orchestrator.register('command_run', {
		async run(job) { ran.push(job.type); return { status: 'done' }; },
	}, { persistence: 'db', maxParallel: 1, minIntervalMs: 0 });

	await orchestrator.enqueue(ENRICHMENT_JOB_TYPE, { videoId: 'aaaaaaaaaaa' });
	await orchestrator.enqueue('command_run', { commandId: 'x' });

	await orchestrator.runNext();
	assert.deepEqual(ran, ['command_run']);
});

// --- 7. the key the source seeds is the key the backend dedupes on -------------

test('the source supplies params only, so it cannot mint a key the backend would dedupe differently', async () => {
	// `EnrichmentQueueAdapter.itemToSeed` had to compute the dedupe key by hand and keep
	// it in step with the type's own function. Seeds carry params now and the key is
	// derived once, by the config — the drift is unrepresentable.
	const { orchestrator, store } = newOrchestrator();
	orchestrator.setAutoSourceEnabled(ENRICHMENT_JOB_TYPE, true);
	orchestrator.setAutoSource(ENRICHMENT_JOB_TYPE, () => [candidate('aaaaaaaaaaa')]);
	await orchestrator.refill(ENRICHMENT_JOB_TYPE);

	const [row] = store.list('queued', {});
	assert.equal(row.dedupeKey, `${ENRICHMENT_JOB_TYPE}::${youtubeMetadataDedupeKey(row.params)}`,
		'the stored key is exactly the type-namespaced form of its own dedupeKey(params)');

	// And a hand enqueue of the same video collapses onto it rather than duplicating.
	await orchestrator.enqueue(ENRICHMENT_JOB_TYPE, { videoId: 'aaaaaaaaaaa' });
	assert.equal(store.count('queued'), 1);
});
