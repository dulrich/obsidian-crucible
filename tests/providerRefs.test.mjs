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
	const result = await esbuild.build({
		entryPoints: [path.join(import.meta.dirname, '..', entryRelPath)],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'es2020',
		outfile,
		metafile: true,
		logLevel: 'silent',
	});
	const module = await import(pathToFileURL(outfile));
	// Exactly one output per build, so its input set is this entry point's whole dependency graph.
	const [output] = Object.values(result.metafile.outputs);
	return { module, inputs: Object.keys(output?.inputs ?? {}) };
}

const { module: refsModule } = await bundle('src/settings/providerRefs.ts', 'providerRefs.mjs');
const { providerRefsPointingAt } = refsModule;
const { module: capabilitiesModule } = await bundle('src/settings/modelCapabilities.ts', 'modelCapabilities.mjs');
const { modelHasCapability, providerHasChatCapableModel } = capabilitiesModule;

const { module: contractModule, inputs: contractInputs } = await bundle('src/providerModelContract.ts', 'providerModelContract.mjs');
const {
	MODEL_REF_SEPARATOR,
	formatModelRef,
	parseModelRef,
	isCompleteModelRef,
	modelRefEquals,
	bindingForMode,
	bindingModelRefs,
	normalizeAgentBinding,
} = contractModule;

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

// ── The provider/model contract module (WP-rem-R2 / review finding F2) ─────────────────────────
//
// `src/providerModelContract.ts` is the single home of the `"providerId:modelId"` parser and of the
// discriminated `AgentModelBinding` union. Everything below is executed, not text-inspected — the
// one exception is the leaf-ness guard, which asserts a dependency-graph fact (via esbuild's
// metafile, not a regex over source) because the finding's root cause was that the canonical parser
// lived somewhere unimportable and therefore got copied three times.

test('the contract module is a leaf: bundling it pulls in no other file', () => {
	assert.equal(contractInputs.length, 1, `expected a single input, got ${contractInputs.join(', ')}`);
	assert.ok(contractInputs[0].endsWith('src/providerModelContract.ts'), contractInputs[0]);
});

// ── parseModelRef / formatModelRef ─────────────────────────────────────────────────────────────

test('parseModelRef splits a well-formed ref string', () => {
	assert.deepEqual(parseModelRef('p1:m1'), { providerId: 'p1', modelId: 'm1' });
});

test('parseModelRef splits on the FIRST separator, so a model id may contain one', () => {
	assert.deepEqual(parseModelRef('p1:gemma-4-12b:q8_0'), { providerId: 'p1', modelId: 'gemma-4-12b:q8_0' });
});

test('parseModelRef trims surrounding whitespace on both halves', () => {
	assert.deepEqual(parseModelRef('  p1 : m1  '), { providerId: 'p1', modelId: 'm1' });
});

test('parseModelRef rejects every incomplete form rather than returning a partial ref', () => {
	for (const raw of ['p1', ':m1', 'p1:', ':', '   ', '', undefined, null]) {
		assert.equal(parseModelRef(raw), null, `expected null for ${JSON.stringify(raw)}`);
	}
});

test('formatModelRef round-trips through parseModelRef', () => {
	const ref = { providerId: 'local', modelId: 'openai/text-embedding-3-small' };
	assert.equal(formatModelRef(ref), `local${MODEL_REF_SEPARATOR}openai/text-embedding-3-small`);
	assert.deepEqual(parseModelRef(formatModelRef(ref)), ref);
});

test('isCompleteModelRef requires both halves', () => {
	assert.equal(isCompleteModelRef({ providerId: 'p1', modelId: 'm1' }), true);
	assert.equal(isCompleteModelRef({ providerId: 'p1', modelId: '' }), false);
	assert.equal(isCompleteModelRef({ providerId: '', modelId: 'm1' }), false);
	assert.equal(isCompleteModelRef({ providerId: '', modelId: '' }), false);
});

test('modelRefEquals compares both halves', () => {
	const ref = { providerId: 'p1', modelId: 'm1' };
	assert.equal(modelRefEquals(ref, { providerId: 'p1', modelId: 'm1' }), true);
	assert.equal(modelRefEquals(ref, { providerId: 'p1', modelId: 'm2' }), false);
	assert.equal(modelRefEquals(ref, { providerId: 'p2', modelId: 'm1' }), false);
});

// ── bindingForMode / bindingModelRefs ──────────────────────────────────────────────────────────

test('bindingForMode produces a fresh empty variant carrying only its own payload', () => {
	assert.deepEqual(bindingForMode('pinned'), { mode: 'pinned', pinned: { providerId: '', modelId: '' } });
	assert.deepEqual(bindingForMode('constrained'), { mode: 'constrained', allow: [] });
	assert.deepEqual(bindingForMode('runtime'), { mode: 'runtime' });
});

test('bindingForMode is what makes a mode change drop stale variant data', () => {
	// The regression it replaces: the settings dropdown used to assign `binding.mode = v`, leaving
	// the previous mode's payload persisted underneath it.
	assert.deepEqual(Object.keys(bindingForMode('runtime')), ['mode']);
	assert.equal('pinned' in bindingForMode('constrained'), false);
	assert.equal('allow' in bindingForMode('pinned'), false);
});

test('bindingModelRefs lists a pinned ref, the whole allowlist, or nothing', () => {
	const ref = { providerId: 'p1', modelId: 'm1' };
	const other = { providerId: 'p2', modelId: 'm2' };
	assert.deepEqual(bindingModelRefs({ mode: 'pinned', pinned: ref }), [ref]);
	assert.deepEqual(bindingModelRefs({ mode: 'constrained', allow: [ref, other] }), [ref, other]);
	assert.deepEqual(bindingModelRefs({ mode: 'runtime' }), []);
});

test('bindingModelRefs omits a half-configured pinned ref, which names no model', () => {
	assert.deepEqual(bindingModelRefs({ mode: 'pinned', pinned: { providerId: 'p1', modelId: '' } }), []);
	assert.deepEqual(bindingModelRefs({ mode: 'pinned', pinned: { providerId: '', modelId: '' } }), []);
});

// ── normalizeAgentBinding: each valid variant ──────────────────────────────────────────────────

test('normalizeAgentBinding passes each already-valid variant through unchanged', () => {
	const pinned = { mode: 'pinned', pinned: { providerId: 'p1', modelId: 'm1' } };
	const constrained = { mode: 'constrained', allow: [{ providerId: 'p1', modelId: 'm1' }] };
	const runtime = { mode: 'runtime' };
	assert.deepEqual(normalizeAgentBinding(pinned), pinned);
	assert.deepEqual(normalizeAgentBinding(constrained), constrained);
	assert.deepEqual(normalizeAgentBinding(runtime), runtime);
});

test('normalizeAgentBinding is idempotent', () => {
	for (const raw of [
		{ mode: 'pinned', pinned: { providerId: 'p1', modelId: 'm1' } },
		{ mode: 'constrained', allow: [{ providerId: 'p1', modelId: 'm1' }] },
		{ mode: 'runtime', pinned: { providerId: 'stale', modelId: 'stale' } },
		{ mode: 'pinned' },
		undefined,
		{ junk: true },
	]) {
		const once = normalizeAgentBinding(raw);
		assert.deepEqual(normalizeAgentBinding(once), once);
	}
});

test('normalizeAgentBinding preserves a half-configured pinned ref instead of reinterpreting it', () => {
	// A user who just switched the dropdown to Pinned and has not chosen a provider yet is a real,
	// reachable state — it must survive a reload as "pinned, unfinished", not become runtime.
	assert.deepEqual(
		normalizeAgentBinding({ mode: 'pinned', pinned: { providerId: 'p1', modelId: '' } }),
		{ mode: 'pinned', pinned: { providerId: 'p1', modelId: '' } },
	);
});

// ── normalizeAgentBinding: legacy and malformed persisted JSON ─────────────────────────────────

test('stale pinned data left in a runtime-mode binding is dropped', () => {
	assert.deepEqual(
		normalizeAgentBinding({ mode: 'runtime', pinned: { providerId: 'p1', modelId: 'm1' } }),
		{ mode: 'runtime' },
	);
});

test('stale allow data left in a runtime- or pinned-mode binding is dropped', () => {
	assert.deepEqual(
		normalizeAgentBinding({ mode: 'runtime', allow: [{ providerId: 'p1', modelId: 'm1' }] }),
		{ mode: 'runtime' },
	);
	assert.deepEqual(
		normalizeAgentBinding({ mode: 'pinned', pinned: { providerId: 'p1', modelId: 'm1' }, allow: [{ providerId: 'p2', modelId: 'm2' }] }),
		{ mode: 'pinned', pinned: { providerId: 'p1', modelId: 'm1' } },
	);
});

test('a pinned-mode binding with no payload gains an empty one rather than staying unrepresentable', () => {
	assert.deepEqual(normalizeAgentBinding({ mode: 'pinned' }), { mode: 'pinned', pinned: { providerId: '', modelId: '' } });
	assert.deepEqual(normalizeAgentBinding({ mode: 'pinned', pinned: null }), { mode: 'pinned', pinned: { providerId: '', modelId: '' } });
});

test('a constrained-mode binding with no allowlist gains an empty one', () => {
	assert.deepEqual(normalizeAgentBinding({ mode: 'constrained' }), { mode: 'constrained', allow: [] });
	assert.deepEqual(normalizeAgentBinding({ mode: 'constrained', allow: null }), { mode: 'constrained', allow: [] });
	assert.deepEqual(normalizeAgentBinding({ mode: 'constrained', allow: 'p1:m1' }), { mode: 'constrained', allow: [] });
});

test('allowlist entries that are incomplete or junk are dropped, complete ones kept in order', () => {
	assert.deepEqual(
		normalizeAgentBinding({
			mode: 'constrained',
			allow: [
				{ providerId: 'p1', modelId: 'm1' },
				{ providerId: 'p2' },
				{ modelId: 'm3' },
				null,
				42,
				'not-a-ref',
				{ providerId: 'p4', modelId: 'm4' },
			],
		}),
		{ mode: 'constrained', allow: [{ providerId: 'p1', modelId: 'm1' }, { providerId: 'p4', modelId: 'm4' }] },
	);
});

test('allowlist entries in the string form are read, and duplicates collapse first-wins', () => {
	assert.deepEqual(
		normalizeAgentBinding({ mode: 'constrained', allow: ['p1:m1', { providerId: 'p1', modelId: 'm1' }, 'p2:m2'] }),
		{ mode: 'constrained', allow: [{ providerId: 'p1', modelId: 'm1' }, { providerId: 'p2', modelId: 'm2' }] },
	);
});

test('a pinned payload stored in the string form is read rather than lost', () => {
	assert.deepEqual(
		normalizeAgentBinding({ mode: 'pinned', pinned: 'p1:m1' }),
		{ mode: 'pinned', pinned: { providerId: 'p1', modelId: 'm1' } },
	);
});

test('non-string ref fields become empty strings, and strings are trimmed', () => {
	assert.deepEqual(
		normalizeAgentBinding({ mode: 'pinned', pinned: { providerId: 7, modelId: '  m1  ' } }),
		{ mode: 'pinned', pinned: { providerId: '', modelId: 'm1' } },
	);
});

test('an unrecognized mode is recovered from whatever coherent payload is present', () => {
	assert.deepEqual(
		normalizeAgentBinding({ mode: 'legacy-auto', pinned: { providerId: 'p1', modelId: 'm1' } }),
		{ mode: 'pinned', pinned: { providerId: 'p1', modelId: 'm1' } },
	);
	assert.deepEqual(
		normalizeAgentBinding({ allow: [{ providerId: 'p1', modelId: 'm1' }] }),
		{ mode: 'constrained', allow: [{ providerId: 'p1', modelId: 'm1' }] },
	);
	// A complete pinned ref wins over an allowlist when both survive a lost mode tag.
	assert.deepEqual(
		normalizeAgentBinding({ pinned: { providerId: 'p1', modelId: 'm1' }, allow: [{ providerId: 'p2', modelId: 'm2' }] }),
		{ mode: 'pinned', pinned: { providerId: 'p1', modelId: 'm1' } },
	);
	// Nothing coherent to recover → the variant that needs no configuration.
	assert.deepEqual(normalizeAgentBinding({}), { mode: 'runtime' });
	assert.deepEqual(normalizeAgentBinding({ mode: 'pinned:', pinned: { providerId: 'p1' } }), { mode: 'runtime' });
});

test('anything that is not an object at all normalizes to runtime without throwing', () => {
	for (const raw of [undefined, null, 'runtime', 42, true, [], [{ mode: 'pinned' }], () => 'pinned']) {
		assert.deepEqual(normalizeAgentBinding(raw), { mode: 'runtime' }, `expected runtime for ${String(raw)}`);
	}
});

// ── providerRefsPointingAt over legacy/malformed bindings ──────────────────────────────────────

test('providerRefsPointingAt tolerates legacy binding shapes it now normalizes on read', () => {
	const p = provider();
	// A pinned-mode agent whose payload never landed, and a runtime-mode agent still carrying the
	// stale pinned ref the old in-place mode mutation left behind: neither references the provider.
	const agents = [
		{ id: 'a1', name: 'a1', modelBinding: { mode: 'pinned' } },
		{ id: 'a2', name: 'a2', modelBinding: { mode: 'runtime', pinned: { providerId: 'p1', modelId: 'm1' } } },
		{ id: 'a3', name: 'a3', modelBinding: undefined },
	];
	assert.deepEqual(providerRefsPointingAt(baseSettings({ agents }), p), []);
});

test('providerRefsPointingAt counts an agent whose mode tag was lost but whose ref is coherent', () => {
	const p = provider();
	const agents = [{ id: 'a1', name: 'a1', modelBinding: { pinned: { providerId: 'p1', modelId: 'm1' } } }];
	assert.deepEqual(providerRefsPointingAt(baseSettings({ agents }), p), ['1 agent']);
});

test('providerRefsPointingAt ignores incomplete allowlist entries pointing at this provider', () => {
	const p = provider();
	const agents = [{ id: 'a1', name: 'a1', modelBinding: { mode: 'constrained', allow: [{ providerId: 'p1' }] } }];
	assert.deepEqual(providerRefsPointingAt(baseSettings({ agents }), p), []);
});
