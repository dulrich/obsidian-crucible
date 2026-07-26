// WP-1 — inline model catalog browser panel
// (plans/model-catalog-ux-local-inference-and-remediations.md).
//
// Bundles the real src/settings/modelCatalogBrowser.ts purely to reach its exported pure
// functions (bucketing, paging, the Use-button dedupe rule) — none of them touch the DOM or
// Obsidian's Setting/Notice machinery, so a minimal obsidian stub (mirroring
// tests/searchModalFormat.test.mjs's pattern) is enough; nothing here calls
// renderModelCatalogBrowser itself. `CrucibleSettingTab` is imported with `import type` in the
// source file, so it is erased entirely at compile time and needs no stub.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-model-catalog-browser-tests');
const outfile = path.join(outdir, 'modelCatalogBrowser.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: [path.join(import.meta.dirname, '..', 'src', 'settings', 'modelCatalogBrowser.ts')],
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
					export class Notice { constructor() {} }
					export function setIcon() {}
				`,
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	MODEL_CATALOG_BROWSER_PAGE_SIZE,
	MODEL_CATALOG_CAPABILITY_BUCKET_LABELS,
	MODEL_CATALOG_CAPABILITY_BUCKET_ORDER,
	catalogEntryDisplayName,
	catalogEntryMatchesBucket,
	clampModelCatalogPage,
	countModelsByBucket,
	filterModelsByBucket,
	formatModelCatalogPageCounter,
	modelCatalogTotalPages,
	paginateModels,
	useCatalogEntry,
} = await import(pathToFileURL(outfile));

const catalogModel = (overrides = {}) => ({ id: 'm', ...overrides });
const provider = (overrides = {}) => ({ id: 'p1', name: 'Test provider', kind: 'openai-compatible', models: [], ...overrides });

// ── Capability bucketing ─────────────────────────────────────────────────────────────────────────

test('catalogEntryMatchesBucket: "all" matches everything, including an entry with no capability signal', () => {
	assert.equal(catalogEntryMatchesBucket(catalogModel(), 'all'), true);
	assert.equal(catalogEntryMatchesBucket(catalogModel({ type: 'llm' }), 'all'), true);
});

test('catalogEntryMatchesBucket: "untagged" matches only entries inferCapabilities finds no signal for', () => {
	assert.equal(catalogEntryMatchesBucket(catalogModel(), 'untagged'), true);
	assert.equal(catalogEntryMatchesBucket(catalogModel({ type: 'llm' }), 'untagged'), false);
	assert.equal(catalogEntryMatchesBucket(catalogModel({ contextLength: 4096 }), 'untagged'), true, 'contextLength alone is not a capability signal');
});

test('catalogEntryMatchesBucket: a vlm entry matches both chat and image-extraction buckets', () => {
	const vlm = catalogModel({ type: 'vlm' });
	assert.equal(catalogEntryMatchesBucket(vlm, 'chat'), true);
	assert.equal(catalogEntryMatchesBucket(vlm, 'image-extraction'), true);
	assert.equal(catalogEntryMatchesBucket(vlm, 'embedding'), false);
});

test('countModelsByBucket: "all" equals the catalog length, and untagged/tagged entries are counted correctly', () => {
	const models = [
		catalogModel({ id: 'a', type: 'llm' }),
		catalogModel({ id: 'b', type: 'embeddings' }),
		catalogModel({ id: 'c' }), // untagged
		catalogModel({ id: 'd' }), // untagged
	];
	const counts = countModelsByBucket(models);
	assert.equal(counts.all, 4);
	assert.equal(counts.chat, 1);
	assert.equal(counts.embedding, 1);
	assert.equal(counts.untagged, 2);
	assert.equal(counts.rerank, 0);
});

test('countModelsByBucket: an entry with multiple inferred capabilities is counted in each bucket (chip counts are not mutually exclusive)', () => {
	const counts = countModelsByBucket([catalogModel({ type: 'vlm' })]);
	assert.equal(counts.chat, 1);
	assert.equal(counts['image-extraction'], 1);
	assert.equal(counts.all, 1);
});

test('MODEL_CATALOG_CAPABILITY_BUCKET_ORDER/LABELS cover exactly the five non-"all" buckets the brief specifies', () => {
	assert.deepEqual(MODEL_CATALOG_CAPABILITY_BUCKET_ORDER, ['chat', 'embedding', 'image-extraction', 'rerank', 'untagged']);
	assert.deepEqual(MODEL_CATALOG_CAPABILITY_BUCKET_LABELS, {
		all: 'All',
		chat: 'Chat',
		embedding: 'Embedding',
		'image-extraction': 'Image',
		rerank: 'Rerank',
		untagged: 'Untagged',
	});
});

test('filterModelsByBucket: "all" returns the array unchanged (by reference), everything else narrows', () => {
	const models = [catalogModel({ id: 'a', type: 'llm' }), catalogModel({ id: 'b' })];
	assert.equal(filterModelsByBucket(models, 'all'), models);
	assert.deepEqual(filterModelsByBucket(models, 'chat'), [models[0]]);
	assert.deepEqual(filterModelsByBucket(models, 'untagged'), [models[1]]);
});

// ── Display name resolution (defensive against ProviderCatalogModel.displayName not existing yet) ─

test('catalogEntryDisplayName falls back to id when displayName is absent', () => {
	assert.equal(catalogEntryDisplayName(catalogModel({ id: 'raw-id' })), 'raw-id');
});

test('catalogEntryDisplayName prefers a non-blank displayName over id', () => {
	assert.equal(catalogEntryDisplayName({ id: 'raw-id', displayName: 'Pretty Name' }), 'Pretty Name');
});

test('catalogEntryDisplayName falls back to id when displayName is present but blank/whitespace', () => {
	assert.equal(catalogEntryDisplayName({ id: 'raw-id', displayName: '   ' }), 'raw-id');
	assert.equal(catalogEntryDisplayName({ id: 'raw-id', displayName: '' }), 'raw-id');
});

// ── Paging math ──────────────────────────────────────────────────────────────────────────────────

test('modelCatalogTotalPages: exact multiples of the page size, and the "at least one page" floor for zero models', () => {
	assert.equal(modelCatalogTotalPages(0), 1, 'zero models is still 1 page (an empty one), never 0');
	assert.equal(modelCatalogTotalPages(1), 1);
	assert.equal(modelCatalogTotalPages(MODEL_CATALOG_BROWSER_PAGE_SIZE), 1, 'exactly one page size is still one page');
	assert.equal(modelCatalogTotalPages(MODEL_CATALOG_BROWSER_PAGE_SIZE + 1), 2, 'one entry over a full page starts a second page');
	assert.equal(modelCatalogTotalPages(343), Math.ceil(343 / MODEL_CATALOG_BROWSER_PAGE_SIZE), '343 (OpenRouter\'s live catalog size) paginates as expected');
});

test('clampModelCatalogPage clamps below 1 and above the last page', () => {
	assert.equal(clampModelCatalogPage(0, 100), 1);
	assert.equal(clampModelCatalogPage(-5, 100), 1);
	assert.equal(clampModelCatalogPage(999, 30), modelCatalogTotalPages(30));
	assert.equal(clampModelCatalogPage(2, 30), 2, 'an in-range page passes through unchanged');
});

test('clampModelCatalogPage treats a shrinking result set correctly: a page that no longer exists clamps to the new last page', () => {
	// Simulates: user on page 5 of a broad result set, then narrows the filter to 3 models.
	assert.equal(clampModelCatalogPage(5, 3), 1);
});

test('paginateModels slices exactly PAGE_SIZE items per page, with a partial final page', () => {
	const models = Array.from({ length: 30 }, (_, i) => catalogModel({ id: `m${i}` }));
	const page1 = paginateModels(models, 1);
	const page2 = paginateModels(models, 2);
	assert.equal(page1.length, 25);
	assert.equal(page2.length, 5);
	assert.equal(page1[0].id, 'm0');
	assert.equal(page2[0].id, 'm25');
});

test('paginateModels clamps an out-of-range page rather than returning an empty slice', () => {
	const models = Array.from({ length: 10 }, (_, i) => catalogModel({ id: `m${i}` }));
	assert.deepEqual(paginateModels(models, 99), models, 'clamps to the only page that exists');
});

test('formatModelCatalogPageCounter: exact text shape, including pluralization at the boundary', () => {
	assert.equal(formatModelCatalogPageCounter(1, 1), 'page 1 of 1 · 1 model');
	assert.equal(formatModelCatalogPageCounter(1, 2), 'page 1 of 1 · 2 models');
	assert.equal(formatModelCatalogPageCounter(2, 30), 'page 2 of 2 · 30 models');
	assert.equal(formatModelCatalogPageCounter(1, 0), 'page 1 of 1 · 0 models');
});

// ── Use button: dedupe rule ──────────────────────────────────────────────────────────────────────

test('useCatalogEntry creates a new ProviderModel and applies the catalog suggestion through the same accept path a type-ahead pick uses', () => {
	const p = provider();
	const entry = catalogModel({ id: 'text-embedding-bge-m3', type: 'embeddings', quantization: 'F16', embeddingLength: 1024 });

	const result = useCatalogEntry(p, entry);

	assert.equal(result.created, true);
	assert.equal(p.models.length, 1);
	assert.equal(p.models[0].id, 'text-embedding-bge-m3');
	assert.deepEqual(p.models[0].capabilities, ['embedding']);
	assert.equal(p.models[0].embeddingDimensions, 1024);
	assert.equal(p.models[0].embeddingVariant, 'F16');
});

test('useCatalogEntry is a no-op (created: false) when a model with this id already exists — no duplicate row, no mutation', () => {
	const existing = { id: 'already-here', label: 'Mine', capabilities: ['rerank'] };
	const p = provider({ models: [existing] });
	const before = { ...existing };

	const result = useCatalogEntry(p, catalogModel({ id: 'already-here', type: 'embeddings', embeddingLength: 768 }));

	assert.equal(result.created, false);
	assert.equal(result.model, existing, 'returns the existing row, not a new one');
	assert.equal(p.models.length, 1, 'no duplicate row was appended');
	assert.deepEqual(existing, before, 'the existing row is left completely untouched, even though the entry carries a different capability/embeddingLength');
});

test('useCatalogEntry initializes provider.models when the provider had none yet', () => {
	const p = { id: 'p2', name: 'No models yet', kind: 'openai-compatible' };
	const result = useCatalogEntry(p, catalogModel({ id: 'first' }));
	assert.equal(result.created, true);
	assert.deepEqual(p.models, [result.model]);
});
