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
	assert.equal(plugin.enqueued.length, 3);
	assert.deepEqual(plugin.enqueued.map(job => job.type), ['search_upsert_batch', 'search_upsert_batch', 'search_upsert_batch']);
	assert.deepEqual(plugin.enqueued.map(job => job.params.paths.length), [250, 250, 53]);
	assert.deepEqual(plugin.enqueued.map(job => job.options.priority), ['low', 'low', 'low']);
	assert.deepEqual(plugin.enqueued.map(job => job.options.lane), ['background', 'background', 'background']);
	assert.deepEqual(plugin.enqueued.map(job => job.params.batchIndex), [0, 1, 2]);
	assert.ok(plugin.enqueued.every(job => job.params.batchCount === 3));
});

// The whole point of raising the batch size: a full-vault rebuild must not create thousands
// of durable job files in one synchronous burst. At the real vault scale this asserts the
// job-file count stays in the hundreds, which is what makes the queue drainable at
// maxParallel: 1.
test('SearchRebuildWorkflow keeps a 42k-file rebuild to a few hundred job files', async () => {
	const plugin = makePlugin({
		searchManager: {
			listIndexableFiles: () => Array.from({ length: 42_000 }, (_, i) => ({ path: `note-${i}.md` })),
		},
	});
	const result = await new SearchRebuildWorkflow().run({ id: 'rebuild-2', params: {} }, { plugin });

	assert.equal(result.status, 'done');
	assert.equal(plugin.enqueued.length, 168, '42,000 files at 250/batch is 168 jobs — it was 1,680 at the old batch size of 25');
	// Every file is still covered exactly once, in order: batching must not drop a tail.
	const allPaths = plugin.enqueued.flatMap(job => job.params.paths);
	assert.equal(allPaths.length, 42_000);
	assert.equal(new Set(allPaths).size, 42_000);
	assert.equal(allPaths[0], 'note-0.md');
	assert.equal(allPaths[41_999], 'note-41999.md');
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
