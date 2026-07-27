// idh-WP-2: Delete-Provider confirm's in-use summary (providerRefsPointingAt) and the Agents
// dropdowns' chat-capability filter (providerHasChatCapableModel). Both live in obsidian-free
// pure modules (src/settings/providerRefs.ts, src/settings/modelCapabilities.ts) specifically so
// they unit-test without bundling the settings pane — see providerRefs.ts's own header comment.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-provider-refs-tests');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

async function bundle(entryRelPath, outName) {
	const outfile = path.join(outdir, outName);
	await esbuild.build({
		entryPoints: [path.join(import.meta.dirname, '..', entryRelPath)],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'es2020',
		outfile,
		logLevel: 'silent',
	});
	return import(pathToFileURL(outfile));
}

const { providerRefsPointingAt } = await bundle('src/settings/providerRefs.ts', 'providerRefs.mjs');
const { modelHasCapability, providerHasChatCapableModel } = await bundle('src/settings/modelCapabilities.ts', 'modelCapabilities.mjs');

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

const provider = (overrides = {}) => ({ id: 'p1', name: 'Test provider', kind: 'openai-compatible', models: [], ...overrides });
const model = (overrides = {}) => ({ id: 'm1', label: 'M1', ...overrides });

function baseSettings(overrides = {}) {
	return {
		searchEmbeddingModel: undefined,
		searchRerankModel: undefined,
		imageMetadataExtractionModel: undefined,
		agents: [],
		chains: [],
		...overrides,
	};
}

// ── providerRefsPointingAt: the five surfaces ───────────────────────────────────────────────────

test('an unused provider produces no labels', () => {
	const p = provider();
	assert.deepEqual(providerRefsPointingAt(baseSettings(), p), []);
});

test('search embedding model ref is detected', () => {
	const p = provider();
	const settings = baseSettings({ searchEmbeddingModel: { providerId: 'p1', modelId: 'm1' } });
	assert.deepEqual(providerRefsPointingAt(settings, p), ['search embedding']);
});

test('search reranker model ref is detected', () => {
	const p = provider();
	const settings = baseSettings({ searchRerankModel: { providerId: 'p1', modelId: 'm1' } });
	assert.deepEqual(providerRefsPointingAt(settings, p), ['search reranker']);
});

test('image description model ref is detected', () => {
	const p = provider();
	const settings = baseSettings({ imageMetadataExtractionModel: { providerId: 'p1', modelId: 'm1' } });
	assert.deepEqual(providerRefsPointingAt(settings, p), ['image description model']);
});

test('a ref pointing at a different provider id does not match', () => {
	const p = provider({ id: 'p1' });
	const settings = baseSettings({ searchEmbeddingModel: { providerId: 'p2', modelId: 'm1' } });
	assert.deepEqual(providerRefsPointingAt(settings, p), []);
});

test('agents pinned to this provider are counted, singular and plural', () => {
	const p = provider();
	const agentPinned = (id) => ({ id, name: id, modelBinding: { mode: 'pinned', pinned: { providerId: 'p1', modelId: 'm1' } } });

	assert.deepEqual(
		providerRefsPointingAt(baseSettings({ agents: [agentPinned('a1')] }), p),
		['1 agent'],
	);
	assert.deepEqual(
		providerRefsPointingAt(baseSettings({ agents: [agentPinned('a1'), agentPinned('a2')] }), p),
		['2 agents'],
	);
});

test('agents constrained with this provider in their allowlist are counted', () => {
	const p = provider();
	const agentConstrained = {
		id: 'a1',
		name: 'a1',
		modelBinding: { mode: 'constrained', allow: [{ providerId: 'other', modelId: 'x' }, { providerId: 'p1', modelId: 'm1' }] },
	};
	assert.deepEqual(providerRefsPointingAt(baseSettings({ agents: [agentConstrained] }), p), ['1 agent']);
});

test('a runtime-mode agent never references a specific provider', () => {
	const p = provider();
	const agentRuntime = { id: 'a1', name: 'a1', modelBinding: { mode: 'runtime' } };
	assert.deepEqual(providerRefsPointingAt(baseSettings({ agents: [agentRuntime] }), p), []);
});

test('chain step args.model "providerId:modelId" strings are parsed and counted', () => {
	const p = provider();
	const chain = {
		name: 'c1',
		steps: [
			{ commandId: 'x', keepGoing: true, args: { model: 'p1:m1' } },
			{ commandId: 'y', keepGoing: true, args: { model: 'other:m2' } },
			{ commandId: 'z', keepGoing: true, args: {} },
		],
	};
	assert.deepEqual(providerRefsPointingAt(baseSettings({ chains: [chain] }), p), ['1 chain step']);
});

test('chain step ref parsing rejects malformed strings (no colon, empty halves, whitespace-only)', () => {
	const p = provider();
	const stepWith = (model) => ({ commandId: 'x', keepGoing: true, args: { model } });
	const chain = {
		name: 'c1',
		steps: [stepWith('p1'), stepWith(':m1'), stepWith('p1:'), stepWith('   '), stepWith(undefined)],
	};
	assert.deepEqual(providerRefsPointingAt(baseSettings({ chains: [chain] }), p), []);
});

test('multiple chain steps across multiple chains are all counted', () => {
	const p = provider();
	const chains = [
		{ name: 'c1', steps: [{ commandId: 'x', keepGoing: true, args: { model: 'p1:m1' } }] },
		{ name: 'c2', steps: [{ commandId: 'y', keepGoing: true, args: { model: 'p1:m2' } }] },
	];
	assert.deepEqual(providerRefsPointingAt(baseSettings({ chains }), p), ['2 chain steps']);
});

test('all five surfaces combine into one ordered summary', () => {
	const p = provider();
	const settings = baseSettings({
		searchEmbeddingModel: { providerId: 'p1', modelId: 'm1' },
		searchRerankModel: { providerId: 'p1', modelId: 'm2' },
		imageMetadataExtractionModel: { providerId: 'p1', modelId: 'm3' },
		agents: [
			{ id: 'a1', name: 'a1', modelBinding: { mode: 'pinned', pinned: { providerId: 'p1', modelId: 'm1' } } },
			{ id: 'a2', name: 'a2', modelBinding: { mode: 'constrained', allow: [{ providerId: 'p1', modelId: 'm2' }] } },
		],
		chains: [{ name: 'c1', steps: [{ commandId: 'x', keepGoing: true, args: { model: 'p1:m1' } }] }],
	});
	assert.deepEqual(
		providerRefsPointingAt(settings, p),
		['search embedding', 'search reranker', 'image description model', '2 agents', '1 chain step'],
	);
});

// ── Capability filter: modelHasCapability / providerHasChatCapableModel ────────────────────────

test('a model with capabilities === undefined counts as chat-capable (the legacy default)', () => {
	const m = model({ capabilities: undefined });
	assert.equal(modelHasCapability(m, 'chat'), true);
});

test('an explicit empty capabilities array does not count as chat-capable', () => {
	const m = model({ capabilities: [] });
	assert.equal(modelHasCapability(m, 'chat'), false);
});

test('an explicit ["chat"] counts as chat-capable', () => {
	const m = model({ capabilities: ['chat'] });
	assert.equal(modelHasCapability(m, 'chat'), true);
});

test('providerHasChatCapableModel: true when at least one model is chat-capable', () => {
	const p = provider({ models: [model({ id: 'a', capabilities: ['embedding'] }), model({ id: 'b', capabilities: undefined })] });
	assert.equal(providerHasChatCapableModel(p), true);
});

test('providerHasChatCapableModel: a provider with only embedding-capable models is excluded', () => {
	const p = provider({ models: [model({ id: 'a', capabilities: ['embedding'] }), model({ id: 'b', capabilities: ['rerank'] })] });
	assert.equal(providerHasChatCapableModel(p), false);
});

test('providerHasChatCapableModel: a provider with no models is excluded', () => {
	const p = provider({ models: [] });
	assert.equal(providerHasChatCapableModel(p), false);
});
