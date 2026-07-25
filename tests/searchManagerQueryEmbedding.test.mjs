import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Exercises SearchManager.search()'s query-embedding path: the cache that keeps a debounced
// type-ahead session from re-embedding a repeated query, and the notify-once degradation when
// the embedding provider is down. Both live entirely inside SearchManager, so — like
// searchManagerHash.test.mjs — this bundles the real SearchManager.ts against a minimal
// obsidian stub rather than mocking the module.
const outdir = path.join(tmpdir(), 'obsidian-crucible-search-manager-query-embedding-tests');
const outfile = path.join(outdir, 'SearchManager.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/SearchManager.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: `
					export class App {}
					export class FileSystemAdapter {}
					export class Notice {
						constructor(message) { globalThis.__searchManagerNotices.push(message); }
					}
					export function normalizePath(path) { return path; }
					export async function requestUrl() { throw new Error('requestUrl not stubbed'); }
				`,
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { SearchManager } = await import(pathToFileURL(outfile));

function settings(overrides = {}) {
	return {
		excludedFolders: [],
		providers: [{ id: 'p1', models: [{ id: 'm1' }] }],
		searchVaultId: 'vault',
		searchServiceUrl: 'http://127.0.0.1:4801',
		searchSemanticEnabled: true,
		searchEmbeddingModel: { providerId: 'p1', modelId: 'm1' },
		searchChunkMaxChars: 1800,
		searchChunkOverlapChars: 200,
		searchIndexBatchSize: 24,
		searchResultLimit: 12,
		...overrides,
	};
}

function makeManager({ embed, searchResponse = { results: [] } } = {}) {
	const app = { metadataCache: { isUserIgnored: () => false } };
	const providerManager = { embed };
	const manager = new SearchManager(app, settings(), providerManager);
	const searchClient = { search: async () => searchResponse };
	manager.client = () => searchClient;
	return { manager, searchClient };
}

test('a repeated query embeds once: the second identical search reuses the cached embedding', async () => {
	globalThis.__searchManagerNotices = [];
	let embedCalls = 0;
	const requestedTexts = [];
	const embed = async (_provider, _modelId, texts) => {
		embedCalls++;
		requestedTexts.push(...texts);
		return { embeddings: texts.map(() => [0.1, 0.2, 0.3]) };
	};
	const { manager, searchClient } = makeManager({ embed });
	const capturedEmbeddings = [];
	searchClient.search = async (options) => {
		capturedEmbeddings.push(options.queryEmbedding);
		return { results: [] };
	};

	await manager.search('sustained attention');
	await manager.search('sustained attention');

	assert.equal(embedCalls, 1, 'the provider must only be asked to embed the query once');
	assert.deepEqual(requestedTexts, ['sustained attention']);
	assert.deepEqual(capturedEmbeddings[0], [0.1, 0.2, 0.3]);
	assert.deepEqual(capturedEmbeddings[1], [0.1, 0.2, 0.3], 'the second search must still carry the cached embedding through to the companion');
});

test('an embedding failure notifies at most once and search still returns FTS results', async () => {
	globalThis.__searchManagerNotices = [];
	let embedCalls = 0;
	const embed = async () => {
		embedCalls++;
		throw new Error('embedder unreachable');
	};
	const ftsResults = [{ chunkId: 'c1', path: 'note.md', title: 'Note', snippet: 'body', score: 0.5 }];
	const { manager, searchClient } = makeManager({ embed });
	const capturedEmbeddings = [];
	searchClient.search = async (options) => {
		capturedEmbeddings.push(options.queryEmbedding);
		return { results: ftsResults };
	};

	const first = await manager.search('sustained attention');
	// A different query string on the second call: if notify-once only suppressed the
	// duplicate-query cache path rather than degrading globally, this would re-attempt and
	// re-notify.
	const second = await manager.search('focused awareness');

	assert.equal(first.results, ftsResults, 'search must succeed with FTS results even though semantic embedding failed');
	assert.equal(second.results, ftsResults);
	assert.equal(capturedEmbeddings[0], undefined, 'no query embedding reaches the companion after a failed embed');
	assert.equal(capturedEmbeddings[1], undefined);
	assert.equal(globalThis.__searchManagerNotices.length, 1, 'exactly one Notice for the whole run, not one per keystroke/search');
	assert.equal(embedCalls, 1, 'within the cooldown window the provider is not re-attempted, so typing does not stack failed round-trips');
});

// The suppression above is a cooldown, NOT a latch. Latching a failure until reload is the
// mistake this repo already made with markCompanionOffline's 5-minute availability latch (see
// the AGENTS.md quirk on the two search timeouts): the embedder is a restart:unless-stopped
// fleet container, so a restart or model reload is a normal few-second blip, and a latch would
// turn that into "semantic is silently off until you happen to reload the plugin".
test('the post-failure suppression expires: once the cooldown passes the embedder is retried, and a recovery is picked up without a reload', async () => {
	globalThis.__searchManagerNotices = [];
	let embedCalls = 0;
	let failing = true;
	const embed = async (_provider, _modelId, texts) => {
		embedCalls++;
		if (failing) throw new Error('embedder unreachable');
		return { embeddings: texts.map(() => [0.4, 0.5, 0.6]) };
	};
	const { manager, searchClient } = makeManager({ embed });
	const capturedEmbeddings = [];
	searchClient.search = async (options) => {
		capturedEmbeddings.push(options.queryEmbedding);
		return { results: [] };
	};

	const realNow = Date.now;
	let now = realNow();
	Date.now = () => now;
	try {
		await manager.search('first query');
		assert.equal(embedCalls, 1);

		// Still inside the cooldown: suppressed, no second attempt.
		now += 30_000;
		await manager.search('second query');
		assert.equal(embedCalls, 1, 'still suppressed 30s after the failure');

		// Past the cooldown, and the embedder is healthy again.
		failing = false;
		now += 31_000;
		await manager.search('third query');
		assert.equal(embedCalls, 2, 'the embedder is retried once the cooldown expires');
		assert.deepEqual(capturedEmbeddings[2], [0.4, 0.5, 0.6], 'a recovered embedder resumes semantic ranking without a plugin reload');

		// And recovery clears the cooldown rather than re-arming it.
		await manager.search('fourth query');
		assert.equal(embedCalls, 3);
		assert.deepEqual(capturedEmbeddings[3], [0.4, 0.5, 0.6]);
	} finally {
		Date.now = realNow;
	}

	assert.equal(globalThis.__searchManagerNotices.length, 1, 'the Notice still fires only once, even though the attempt repeats');
});
