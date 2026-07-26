// SE-WP-6 / search plan WP-3: a broken embedding configuration must fail loudly.
//
// The 2026-07-25 incident: renaming a model's id in the provider catalog does not rewrite the
// saved `{providerId, modelId}` ref in `searchEmbeddingModel`. The orphaned ref passed
// `activeEmbeddingModelId()`'s old non-emptiness check, `embedTexts` threw a plain Error,
// `asEmbeddingBackfillError` (audit finding F4) converted EVERY embed failure into the retryable
// `SearchEmbeddingUnavailableError`, and a plain rebuild's lenient `flush()` catch swallowed it —
// 35 of 55 batches reported `done` with zero embeddings and no visible error anywhere.
//
// Every case here asserts the *absence* of the old silent behaviour as much as the presence of
// the new loud one: a config error must fail the batch (nothing upserted FTS-only for it, a
// Notice, a propagated error), while a genuinely transient failure must keep degrading to
// FTS-only exactly as before. Getting either direction wrong reproduces a real incident.
//
// No live companion or network: `client()`/`upsertChunks` are replaced with an in-memory fake, and
// `providerManager.embed` is a plain async function under test control.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-embedding-config-tests');
const managerOutfile = path.join(outdir, 'SearchManager.mjs');

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
						constructor(message) { globalThis.__searchEmbeddingConfigNotices.push(message); }
					}
					export function normalizePath(path) { return path; }
					export async function requestUrl() { throw new Error('requestUrl not stubbed'); }
				`,
				loader: 'js',
			}));
		},
	}],
	outfile: managerOutfile,
	logLevel: 'silent',
});

const { SearchManager, resolveProviderModelRef } = await import(pathToFileURL(managerOutfile));

// ── Harness ──────────────────────────────────────────────────────────────────────────────

function settings(overrides = {}) {
	return {
		excludedFolders: [],
		providers: [{
			id: 'local',
			name: 'Local',
			kind: 'openai-compatible',
			models: [{ id: 'bge-m3', label: 'bge-m3' }],
		}],
		searchVaultId: 'test-vault',
		searchServiceUrl: 'http://127.0.0.1:4899',
		searchSemanticEnabled: true,
		searchEmbeddingModel: { providerId: 'local', modelId: 'bge-m3' },
		searchChunkMaxChars: 1800,
		searchChunkOverlapChars: 200,
		searchIndexBatchSize: 24,
		searchResultLimit: 12,
		...overrides,
	};
}

function makeFile(filePath) {
	const name = filePath.split('/').pop();
	const extension = name.split('.').pop();
	return { path: filePath, basename: name.slice(0, -(extension.length + 1)), extension, stat: { mtime: 123 } };
}

function makeManager({ embed, settingsOverrides = {}, onUpsert = () => {}, contentByPath = new Map() } = {}) {
	const app = {
		metadataCache: { isUserIgnored: () => false },
		vault: { read: async (file) => contentByPath.get(file.path) ?? '# Body\n\nSome prose.' },
	};
	const embedFn = embed ?? (async () => { throw new Error('embed() must not be called in this scenario'); });
	const providerManager = { embed: embedFn };
	const manager = new SearchManager(app, settings(settingsOverrides), providerManager);
	manager.client = () => ({
		fileStates: async () => new Map(),
		upsertChunks: async (chunks) => onUpsert(chunks),
	});
	return manager;
}

// ── 1. Orphaned model id (provider exists, model id gone) ──────────────────────────────────

test('an orphaned model id fails a plain-rebuild batch loudly: nothing upserted, the error names the dangling id', async () => {
	globalThis.__searchEmbeddingConfigNotices = [];
	const upserted = [];
	const manager = makeManager({
		settingsOverrides: { searchEmbeddingModel: { providerId: 'local', modelId: 'bge-m3-f16-renamed' } },
		onUpsert: chunks => upserted.push(chunks),
	});

	await assert.rejects(
		() => manager.indexFiles([makeFile('note.md')]),
		(e) => e.name === 'SearchEmbeddingConfigError' && /bge-m3-f16-renamed/.test(e.message),
	);
	assert.equal(upserted.length, 0, 'a config error must not leave FTS-only chunks upserted for the batch');
	assert.equal(globalThis.__searchEmbeddingConfigNotices.length, 1, 'exactly one Notice for the batch');
});

// ── 2. Orphaned provider id ─────────────────────────────────────────────────────────────────

test('an orphaned provider id fails the same way, naming the dangling provider id', async () => {
	globalThis.__searchEmbeddingConfigNotices = [];
	const upserted = [];
	const manager = makeManager({
		settingsOverrides: { searchEmbeddingModel: { providerId: 'deleted-provider', modelId: 'bge-m3' } },
		onUpsert: chunks => upserted.push(chunks),
	});

	await assert.rejects(
		() => manager.indexFiles([makeFile('note.md')]),
		(e) => e.name === 'SearchEmbeddingConfigError' && /deleted-provider/.test(e.message),
	);
	assert.equal(upserted.length, 0);
});

// ── 3. A genuinely unavailable embedder still degrades to FTS-only (unchanged behavior) ────

test('service-unavailable (connection refused) on a plain rebuild still degrades to FTS-only and does not throw', async () => {
	globalThis.__searchEmbeddingConfigNotices = [];
	let embedCalls = 0;
	const upserted = [];
	const manager = makeManager({
		embed: async () => { embedCalls++; throw new Error('fetch failed: ECONNREFUSED'); },
		onUpsert: chunks => upserted.push(chunks),
	});

	const result = await manager.indexFiles([makeFile('note.md')]);
	assert.equal(result.files, 1);
	assert.equal(embedCalls, 1);
	assert.equal(upserted.length, 1, 'the batch must still be upserted, FTS-only');
	assert.equal(upserted[0][0].embedding, undefined, 'no vector attached — this is the FTS-only degradation');
	assert.equal(globalThis.__searchEmbeddingConfigNotices.length, 0, 'a transient failure is not a config error and must not fire the config Notice');
});

test('a provider 5xx on a plain rebuild also degrades to FTS-only — only 4xx is reclassified as configuration', async () => {
	const upserted = [];
	const manager = makeManager({
		embed: async () => { throw new Error('Local embeddings API returned 503: {"error":"model loading"}'); },
		onUpsert: chunks => upserted.push(chunks),
	});

	const result = await manager.indexFiles([makeFile('note.md')]);
	assert.equal(result.files, 1);
	assert.equal(upserted.length, 1);
	assert.equal(upserted[0][0].embedding, undefined);
});

test('a provider 4xx on a plain rebuild is reclassified as a config error and fails the batch loudly', async () => {
	globalThis.__searchEmbeddingConfigNotices = [];
	const upserted = [];
	const manager = makeManager({
		embed: async () => { throw new Error('Local embeddings API returned 404: {"error":"model not found"}'); },
		onUpsert: chunks => upserted.push(chunks),
	});

	await assert.rejects(
		() => manager.indexFiles([makeFile('note.md')]),
		(e) => e.name === 'SearchEmbeddingConfigError' && /404/.test(e.message),
	);
	assert.equal(upserted.length, 0);
});

// ── 4. Semantic disabled: no embedding attempted, FTS-only exactly as today ────────────────

test('with semantic search disabled, no embedding is attempted and indexing proceeds FTS-only', async () => {
	globalThis.__searchEmbeddingConfigNotices = [];
	const upserted = [];
	let embedCalls = 0;
	const manager = makeManager({
		embed: async () => { embedCalls++; return { embeddings: [[0.1]] }; },
		settingsOverrides: { searchSemanticEnabled: false },
		onUpsert: chunks => upserted.push(chunks),
	});

	const result = await manager.indexFiles([makeFile('note.md')]);
	assert.equal(result.files, 1);
	assert.equal(embedCalls, 0, 'the embedder must never be called when semantic search is off');
	assert.equal(upserted.length, 1);
	assert.equal(upserted[0][0].embedding, undefined);
	assert.equal(globalThis.__searchEmbeddingConfigNotices.length, 0);
});

// ── 5. The once-per-session notice does not fire per batch ─────────────────────────────────

test('the config-error Notice fires once for the run, not once per batch job', async () => {
	globalThis.__searchEmbeddingConfigNotices = [];
	const manager = makeManager({
		settingsOverrides: { searchEmbeddingModel: { providerId: 'local', modelId: 'gone' } },
	});

	// Three separate indexFiles() calls, simulating three independently-enqueued
	// search_upsert_batch jobs against the same long-lived SearchManager instance.
	await assert.rejects(() => manager.indexFiles([makeFile('a.md')]));
	await assert.rejects(() => manager.indexFiles([makeFile('b.md')]));
	await assert.rejects(() => manager.indexFiles([makeFile('c.md')]));

	assert.equal(globalThis.__searchEmbeddingConfigNotices.length, 1, 'one Notice for the whole run, even though every batch fails the same way');
});

// ── 6. F4: the backfill path (requireEmbeddings) must not convert a config error to retryable ─

test('F4 regression: the upfront backfill guard now resolves the ref, not just checks it is non-empty', async () => {
	let reads = 0;
	const manager = makeManager({
		settingsOverrides: { searchEmbeddingModel: { providerId: 'local', modelId: 'bge-m3-renamed' } },
	});
	// Swap in a vault.read that counts calls, so the assertion below proves the guard fires
	// *before* any file is read — not just that the promise eventually rejects.
	manager.app.vault.read = async () => { reads++; return '# Body'; };

	// Before the fix, activeEmbeddingModelId() only checked the string was non-empty, so this
	// guard passed for an orphaned ref and the backfill proceeded to enqueue/run batches that
	// each silently produced zero vectors. It must now refuse up front, before reading a file.
	await assert.rejects(
		() => manager.indexFiles([makeFile('note.md')], undefined, { requireEmbeddings: true }),
		/cannot backfill embeddings/,
	);
	assert.equal(reads, 0, 'the guard must refuse before reading a single file');
});

test('F4 regression: a config error reached mid-batch during a strict backfill propagates as itself, not as the retryable unavailable kind', async () => {
	// The ref resolves (so the upfront guard passes), but the provider rejects the request with
	// a 4xx once embedding is attempted — the scenario asEmbeddingBackfillError existed to
	// handle and, before the fix, handled wrong: it converted this into
	// SearchEmbeddingUnavailableError, which the workflow's catch treats as "defer and retry
	// forever" instead of "this configuration can never work".
	const manager = makeManager({
		embed: async () => { throw new Error('Local embeddings API returned 400: {"error":"bad request"}'); },
	});

	await assert.rejects(
		() => manager.indexFiles([makeFile('note.md')], undefined, { requireEmbeddings: true }),
		(e) => e.name === 'SearchEmbeddingConfigError',
	);
});

test('a genuinely unavailable embedder during a strict backfill still fails as the retryable kind (unchanged)', async () => {
	const manager = makeManager({
		embed: async () => { throw new Error('fetch failed: ECONNREFUSED'); },
	});

	await assert.rejects(
		() => manager.indexFiles([makeFile('note.md')], undefined, { requireEmbeddings: true }),
		(e) => e.name === 'SearchEmbeddingUnavailableError',
	);
});

// ── 7. The resolution helper itself (also the settings-render unit under test) ─────────────

test('resolveProviderModelRef: unset, orphaned (bad model id, bad provider id), and ok', () => {
	const providers = [{
		id: 'local',
		name: 'Local',
		kind: 'openai-compatible',
		models: [{ id: 'bge-m3', label: 'bge-m3' }],
	}];

	assert.deepEqual(resolveProviderModelRef(providers, undefined), { status: 'unset' });
	assert.deepEqual(resolveProviderModelRef(providers, { providerId: 'local', modelId: '' }), { status: 'unset' });
	assert.deepEqual(resolveProviderModelRef(providers, { providerId: 'local', modelId: '   ' }), { status: 'unset' });

	assert.equal(resolveProviderModelRef(providers, { providerId: 'local', modelId: 'renamed-away' }).status, 'orphaned');
	assert.equal(resolveProviderModelRef(providers, { providerId: 'missing', modelId: 'bge-m3' }).status, 'orphaned');

	const ok = resolveProviderModelRef(providers, { providerId: 'local', modelId: 'bge-m3' });
	assert.equal(ok.status, 'ok');
	assert.equal(ok.provider.id, 'local');
	assert.equal(ok.model.id, 'bge-m3');
});
