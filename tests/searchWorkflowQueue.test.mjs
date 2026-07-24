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
			listIndexableFiles: () => Array.from({ length: 53 }, (_, i) => ({ path: `note-${i}.md` })),
		},
	});
	const result = await new SearchRebuildWorkflow().run({ id: 'rebuild-1', params: {} }, { plugin });

	assert.equal(result.status, 'done');
	assert.equal(resetCount, 1);
	assert.equal(plugin.enqueued.length, 3);
	assert.deepEqual(plugin.enqueued.map(job => job.type), ['search_upsert_batch', 'search_upsert_batch', 'search_upsert_batch']);
	assert.deepEqual(plugin.enqueued.map(job => job.params.paths.length), [25, 25, 3]);
	assert.deepEqual(plugin.enqueued.map(job => job.options.priority), ['low', 'low', 'low']);
	assert.deepEqual(plugin.enqueued.map(job => job.options.lane), ['background', 'background', 'background']);
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
