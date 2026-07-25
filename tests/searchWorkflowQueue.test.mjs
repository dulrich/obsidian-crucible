import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-workflow-tests');
const outfile = path.join(outdir, 'SearchIndexWorkflow.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/orchestration/workflows/SearchIndexWorkflow.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: 'export class TFile {}',
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { SearchRebuildWorkflow, SearchUpsertFileWorkflow } = await import(pathToFileURL(outfile));

function makePlugin(overrides = {}) {
	const enqueued = [];
	return {
		enqueued,
		settings: {
			searchEnabled: true,
			searchServiceUrl: 'http://127.0.0.1:4801',
		},
		searchManager: {
			companionAvailable: async () => true,
			companionUnavailableReason: () => null,
			markCompanionOffline: () => {},
			health: async () => ({ ok: true }),
			resetIndex: async () => {},
			listIndexableFiles: () => [],
			...overrides.searchManager,
		},
		orchestrator: {
			enqueue: async (type, params, options) => {
				enqueued.push({ type, params, options });
				return { id: `${type}-${enqueued.length}`, type, status: 'queued', priority: options?.priority ?? 'normal', lane: options?.lane ?? 'background' };
			},
		},
		app: {
			vault: {
				getAbstractFileByPath: () => null,
			},
		},
	};
}

test('SearchRebuildWorkflow enqueues low-priority batch jobs instead of indexing inline', async () => {
	let resetCount = 0;
	const plugin = makePlugin({
		searchManager: {
			resetIndex: async () => { resetCount++; },
			listIndexableFiles: () => Array.from({ length: 553 }, (_, i) => ({ path: `note-${i}.md` })),
		},
	});
	const result = await new SearchRebuildWorkflow().run({ id: 'rebuild-1', params: {} }, { plugin });

	assert.equal(result.status, 'done');
	assert.equal(resetCount, 1);
	assert.equal(plugin.enqueued.length, 6);
	assert.ok(plugin.enqueued.every(job => job.type === 'search_upsert_batch'));
	assert.deepEqual(plugin.enqueued.map(job => job.params.paths.length), [100, 100, 100, 100, 100, 53]);
	assert.ok(plugin.enqueued.every(job => job.options.priority === 'low'));
	assert.ok(plugin.enqueued.every(job => job.options.lane === 'background'));
	assert.deepEqual(plugin.enqueued.map(job => job.params.batchIndex), [0, 1, 2, 3, 4, 5]);
	assert.ok(plugin.enqueued.every(job => job.params.batchCount === 6));
});

// Sized against the measured corpus, not the vault's raw markdown count: ~37,000 of this
// vault's ~42,000 .md files are the queue's own job files under the search-excluded
// `_crucible/`, leaving ~5,500 genuinely indexable. The batch size has to keep the job count
// well clear of the 25-era job spam (which was ~220 jobs at this scale) while staying fine
// enough that one failed batch doesn't lose a big slice of progress.
test('SearchRebuildWorkflow keeps a full-corpus rebuild to a few dozen job files', async () => {
	const CORPUS = 5_456;
	const plugin = makePlugin({
		searchManager: {
			listIndexableFiles: () => Array.from({ length: CORPUS }, (_, i) => ({ path: `note-${i}.md` })),
		},
	});
	const result = await new SearchRebuildWorkflow().run({ id: 'rebuild-2', params: {} }, { plugin });

	assert.equal(result.status, 'done');
	assert.equal(plugin.enqueued.length, 55, '5,456 files at 100/batch is 55 jobs');
	// Every file is still covered exactly once, in order: batching must not drop a tail.
	const allPaths = plugin.enqueued.flatMap(job => job.params.paths);
	assert.equal(allPaths.length, CORPUS);
	assert.equal(new Set(allPaths).size, CORPUS);
	assert.equal(allPaths[0], 'note-0.md');
	assert.equal(allPaths[CORPUS - 1], `note-${CORPUS - 1}.md`);
	// The tail batch is the remainder, not a padded or dropped one.
	assert.equal(plugin.enqueued.at(-1).params.paths.length, CORPUS % 100);
});

test('search upsert defers quietly while the companion is offline', async () => {
	const plugin = makePlugin({
		searchManager: {
			companionAvailable: async () => false,
		},
	});
	const result = await new SearchUpsertFileWorkflow().run({ id: 'upsert-1', params: { path: 'note.md' } }, { plugin });

	assert.equal(result.status, 'deferred');
	assert.match(result.error, /Search companion not reachable/);
	assert.equal(result.retryAfterMs, 30_000);
});

// A reachable companion serving an index schema this build cannot query is unavailable too,
// but telling the user to go start the container would send them to restart something that
// is already running and healthy. When the companion gave a reason, it wins.
test('search upsert surfaces the companion reason instead of the not-reachable text', async () => {
	const reason = 'Search companion index schema 1 is older than this build requires (2). Rebuild the index.';
	const plugin = makePlugin({
		searchManager: {
			companionAvailable: async () => false,
			companionUnavailableReason: () => reason,
		},
	});
	const result = await new SearchUpsertFileWorkflow().run({ id: 'upsert-2', params: { path: 'note.md' } }, { plugin });

	assert.equal(result.status, 'deferred');
	assert.equal(result.error, reason);
	assert.doesNotMatch(result.error, /not reachable/);
	assert.equal(result.retryAfterMs, 30_000);
});
