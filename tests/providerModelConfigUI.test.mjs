// WP-D — probe-first provider model configuration UI
// (plans/queue-control-model-probing-vault-isolation.md, governing rule D2: "a probe never
// auto-writes model configuration").
//
// Everything under test here lives in src/settings/modelCapabilities.ts, which has zero Obsidian
// import (directly or transitively) — same bundling technique as tests/modelCapabilities.test.mjs,
// no stub module required. src/settings/sections/ai.ts (the actual settings-pane rendering) and
// the AbstractInputSuggest-based src/suggesters.ts ProviderModelSuggest class are deliberately
// thin wrappers around these functions for exactly this reason: the D2 state machine needs a unit
// test that doesn't have to bundle the settings pane or stub Obsidian's suggest/DOM machinery to
// reach it.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-provider-model-config-ui-tests');
const outfile = path.join(outdir, 'modelCapabilities.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: [path.join(import.meta.dirname, '..', 'src', 'settings', 'modelCapabilities.ts')],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});
const {
	acceptCatalogSuggestion,
	applyFetchedCatalog,
	buildProviderModelSuggestRows,
	catalogEntrySummaryTokens,
	catalogSuggestionHasChanges,
	clearAcceptedMarker,
	clearProviderModelCatalog,
	crossEncoderWarningText,
	deriveCatalogSuggestion,
	deriveModelDisplayLabel,
	fillModelLabelIfEmpty,
	filterCatalogModelsForQuery,
	formatProbeStatusText,
	getOrCreateProbeState,
	getProbeStatus,
	inferCapabilities,
	precisionFromModelId,
	probeEmbeddingDimensions,
	PROVIDER_MODEL_SUGGEST_LIMIT,
	resetCatalogField,
	setProbeStatus,
} = await import(pathToFileURL(outfile));

const model = (overrides = {}) => ({ id: 'm', label: 'M', ...overrides });
const provider = (overrides = {}) => ({ id: 'p1', name: 'Test provider', kind: 'openai-compatible', models: [], ...overrides });

// ── 1. Fetch does not write model.capabilities ──────────────────────────────────────────────

test('Fetch (applyFetchedCatalog) writes only Provider.modelCatalog, never touches a ProviderModel', () => {
	const p = provider({
		models: [
			model({ id: 'a', capabilities: undefined }),
			model({ id: 'b', capabilities: [] }),
			model({ id: 'c', capabilities: ['embedding'] }),
		],
	});
	// A spread copy (not JSON round-trip) — JSON.stringify drops `capabilities: undefined` keys
	// entirely, which would make the "unchanged" assertion below pass even if applyFetchedCatalog
	// had wrongly stripped that key.
	const before = p.models.map(m => ({ ...m }));

	applyFetchedCatalog(p, [
		{ id: 'a', type: 'llm' },
		{ id: 'b', type: 'embeddings', embeddingLength: 768 },
	], '2026-01-01T00:00:00.000Z');

	assert.deepEqual(p.models, before, 'model rows must be byte-for-byte unchanged after a Fetch');
	assert.deepEqual(p.modelCatalog, {
		fetchedAt: '2026-01-01T00:00:00.000Z',
		models: [{ id: 'a', type: 'llm' }, { id: 'b', type: 'embeddings', embeddingLength: 768 }],
	});
});

// ── 2. Accept writes, and preserves the undefined-vs-[] distinction in both directions ─────────

test('Accept with NO capability signal leaves an undefined capabilities list undefined', () => {
	const m = model({ capabilities: undefined });
	const state = getOrCreateProbeState(m);
	// A catalog entry with no type/serverCapabilities carries no capability signal.
	const suggestion = deriveCatalogSuggestion({ id: 'm', ownedBy: 'system' });
	assert.equal(suggestion.capabilities, undefined, 'no signal must not synthesize a suggestion');
	acceptCatalogSuggestion(m, suggestion, state);
	assert.equal(m.capabilities, undefined, 'undefined must stay undefined, not collapse to []');
});

test('Accept with NO capability signal leaves an explicit [] as []', () => {
	const m = model({ capabilities: [] });
	const state = getOrCreateProbeState(m);
	const suggestion = deriveCatalogSuggestion({ id: 'm', ownedBy: 'system' });
	acceptCatalogSuggestion(m, suggestion, state);
	assert.deepEqual(m.capabilities, [], '[] must stay [], not be re-seeded with a default');
});

test('Accept WITH a capability signal overwrites both an undefined and an explicit [] with the derived list', () => {
	const suggestion = deriveCatalogSuggestion({ id: 'm', type: 'embeddings' });
	assert.deepEqual(suggestion.capabilities, ['embedding']);

	const mUndefined = model({ capabilities: undefined });
	acceptCatalogSuggestion(mUndefined, suggestion, getOrCreateProbeState(mUndefined));
	assert.deepEqual(mUndefined.capabilities, ['embedding']);

	const mEmpty = model({ id: 'm2', capabilities: [] });
	acceptCatalogSuggestion(mEmpty, suggestion, getOrCreateProbeState(mEmpty));
	assert.deepEqual(mEmpty.capabilities, ['embedding']);
});

test('Accept only writes the fields the catalog entry actually reported', () => {
	const m = model({ capabilities: undefined, embeddingDimensions: undefined, embeddingVariant: undefined });
	const state = getOrCreateProbeState(m);
	// ollama-shaped entry: quantization + embeddingLength, no type/serverCapabilities.
	const suggestion = deriveCatalogSuggestion({ id: 'm', quantization: 'Q4_K_M', embeddingLength: 384 });
	assert.equal(suggestion.capabilities, undefined);
	acceptCatalogSuggestion(m, suggestion, state);
	assert.equal(m.capabilities, undefined, 'no capability signal → capabilities untouched');
	assert.equal(m.embeddingDimensions, 384);
	assert.equal(m.embeddingVariant, 'Q4_K_M', 'verbatim server casing, not normalized at accept time');
});

// ── 3. Reset returns a field to user-entered state, and the marking clears ─────────────────────

test('Reset restores the pre-Accept value and clears the accepted marking', () => {
	const m = model({ capabilities: ['rerank'] });
	const state = getOrCreateProbeState(m);
	const suggestion = { capabilities: ['embedding'] };

	acceptCatalogSuggestion(m, suggestion, state);
	assert.deepEqual(m.capabilities, ['embedding']);
	assert.equal(state.accepted.capabilities, true);

	resetCatalogField(m, 'capabilities', state);
	assert.deepEqual(m.capabilities, ['rerank'], 'must restore exactly what the user had before Accept');
	assert.equal(state.accepted.capabilities, undefined, 'the probe-accepted marking must clear');
});

test('Reset restores undefined when the field was undefined before Accept', () => {
	const m = model({ embeddingDimensions: undefined });
	const state = getOrCreateProbeState(m);
	acceptCatalogSuggestion(m, { embeddingDimensions: 1024 }, state);
	assert.equal(m.embeddingDimensions, 1024);
	resetCatalogField(m, 'embeddingDimensions', state);
	assert.equal(m.embeddingDimensions, undefined);
});

test('a second Accept before Reset does not overwrite the snapshot with the first accepted value', () => {
	const m = model({ embeddingVariant: 'user-typed' });
	const state = getOrCreateProbeState(m);
	acceptCatalogSuggestion(m, { embeddingVariant: 'F16' }, state);
	assert.equal(m.embeddingVariant, 'F16');
	acceptCatalogSuggestion(m, { embeddingVariant: 'Q8_0' }, state);
	assert.equal(m.embeddingVariant, 'Q8_0');
	resetCatalogField(m, 'embeddingVariant', state);
	assert.equal(m.embeddingVariant, 'user-typed', 'must restore the ORIGINAL user value, not the intermediate accepted one');
});

test('Reset on a field that was never accepted is a no-op', () => {
	const m = model({ capabilities: ['chat'] });
	const state = getOrCreateProbeState(m);
	resetCatalogField(m, 'capabilities', state);
	assert.deepEqual(m.capabilities, ['chat']);
});

test('directly editing an accepted field clears its marking (the "override" half of D2 rule 4)', () => {
	const m = model({ capabilities: undefined });
	const state = getOrCreateProbeState(m);
	acceptCatalogSuggestion(m, { capabilities: ['embedding'] }, state);
	assert.equal(state.accepted.capabilities, true);
	clearAcceptedMarker(state, 'capabilities');
	assert.equal(state.accepted.capabilities, undefined);
	// The snapshot is dropped along with the marking: the hand-edit IS the user's value now, so the
	// next Accept must be free to snapshot it. `ai.ts` only renders Reset while the marking is set,
	// so a snapshot outliving the marking would be unreachable anyway.
	assert.equal(state.snapshot.has('capabilities'), false);
});

test('Accept → hand-edit → Accept → Reset restores the HAND-EDIT, not the pre-first-Accept value', () => {
	// The interaction the snapshot-once rule gets wrong if `clearAcceptedMarker` keeps the snapshot:
	// the second Accept would decline to re-snapshot, and Reset would silently discard the user's
	// own edit in favour of a value they had already moved away from.
	const m = model({ embeddingVariant: 'original' });
	const state = getOrCreateProbeState(m);

	acceptCatalogSuggestion(m, { embeddingVariant: 'F16' }, state);
	assert.equal(m.embeddingVariant, 'F16');

	// The user types over it; ai.ts calls clearAcceptedMarker from the field's own onChange.
	m.embeddingVariant = 'hand-edited';
	clearAcceptedMarker(state, 'embeddingVariant');

	acceptCatalogSuggestion(m, { embeddingVariant: 'Q8_0' }, state);
	assert.equal(m.embeddingVariant, 'Q8_0');

	resetCatalogField(m, 'embeddingVariant', state);
	assert.equal(m.embeddingVariant, 'hand-edited', 'Reset must restore the value the user last entered');
});

// ── 4. Free text survives ───────────────────────────────────────────────────────────────────

test('an id absent from the catalog produces no forced match — free typing is never coerced', () => {
	const catalog = [{ id: 'llama3' }, { id: 'mixtral' }];
	assert.deepEqual(filterCatalogModelsForQuery(catalog, 'my-custom-finetune-xyz'), []);
});

test('an empty catalog (probe never run, empty, or server down) also yields no matches, not an error', () => {
	assert.deepEqual(filterCatalogModelsForQuery([], 'anything'), []);
});

test('a blank query returns the full catalog unfiltered (browsing, not searching)', () => {
	const catalog = [{ id: 'a' }, { id: 'b' }];
	assert.deepEqual(filterCatalogModelsForQuery(catalog, ''), catalog);
	assert.deepEqual(filterCatalogModelsForQuery(catalog, '   '), catalog);
});

test('a substring match still surfaces the entry (so a genuine catalog id IS offered)', () => {
	const catalog = [{ id: 'text-embedding-bge-m3' }];
	assert.deepEqual(filterCatalogModelsForQuery(catalog, 'bge'), catalog);
});

// ── 5. Unreachable server vs empty-list surfaced differently, with the reason text asserted ────

test('an unreachable server and an empty list produce different, informative status text', () => {
	const p = provider();
	setProbeStatus(p, { state: 'error', reason: 'connect ECONNREFUSED 127.0.0.1:1234' });
	assert.equal(
		formatProbeStatusText(getProbeStatus(p)),
		'Could not fetch the model list: connect ECONNREFUSED 127.0.0.1:1234',
	);

	setProbeStatus(p, { state: 'ok', count: 0 });
	assert.equal(formatProbeStatusText(getProbeStatus(p)), 'The server reported no models.');

	assert.notEqual(
		formatProbeStatusText({ state: 'error', reason: 'x' }),
		formatProbeStatusText({ state: 'ok', count: 0 }),
	);
});

test('a successful fetch with results reports a count, singular and plural', () => {
	assert.equal(formatProbeStatusText({ state: 'ok', count: 1 }), '1 model found.');
	assert.equal(formatProbeStatusText({ state: 'ok', count: 3 }), '3 models found.');
});

test('an unsupported-kind rejection (e.g. anthropic/google, no listModels client) surfaces its own precise reason text', () => {
	// Mirrors the exact error ProviderManager.listModels() throws for a kind WP-C left
	// unimplemented — the settings UI must not paraphrase or genericize it.
	const reason = 'Provider kind "anthropic" does not support list available models yet';
	assert.equal(formatProbeStatusText({ state: 'error', reason }), `Could not fetch the model list: ${reason}`);
});

test('idle status (never fetched) renders no text — the settings pane omits the status line entirely', () => {
	const p = provider();
	assert.deepEqual(getProbeStatus(p), { state: 'idle' });
	assert.equal(formatProbeStatusText(getProbeStatus(p)), '');
});

// ── 6. A looksLikeCrossEncoder model is warned about but still selectable ──────────────────────

test('looksLikeCrossEncoder produces a warning but the entry is not excluded from suggestions', () => {
	const entry = { id: 'bge-reranker-v2-m3', type: 'embeddings', looksLikeCrossEncoder: true };
	const warning = crossEncoderWarningText(entry);
	assert.ok(warning && warning.length > 0, 'must produce a non-empty warning');
	assert.match(warning, /cross-encoder/i);

	// Still fully selectable: it's a normal catalog entry to the suggest filter...
	assert.deepEqual(filterCatalogModelsForQuery([entry], 'bge-reranker'), [entry]);
	// ...and Accept still writes its embedding capability — the warning never blocks or filters.
	const suggestion = deriveCatalogSuggestion(entry);
	assert.deepEqual(suggestion.capabilities, ['embedding']);
	const m = model({ id: 'bge-reranker-v2-m3', capabilities: undefined });
	acceptCatalogSuggestion(m, suggestion, getOrCreateProbeState(m));
	assert.deepEqual(m.capabilities, ['embedding']);
});

test('a normal (non-cross-encoder) entry produces no warning', () => {
	assert.equal(crossEncoderWarningText({ id: 'llama3', type: 'llm' }), undefined);
});

test('looksLikeCrossEncoder never contributes a suggested capability by itself (carried, never acted on)', () => {
	// An entry whose ONLY signal is the cross-encoder heuristic (no type, no serverCapabilities)
	// must not derive any capability suggestion from it.
	const suggestion = deriveCatalogSuggestion({ id: 'x', looksLikeCrossEncoder: true });
	assert.equal(suggestion.capabilities, undefined);
});

// ── 7. Clear-cache empties the persisted catalog, and a subsequent Fetch repopulates it ────────

test('Clear cache empties Provider.modelCatalog and clears the provider-layer session cache', () => {
	const p = provider({ modelCatalog: { fetchedAt: 't', models: [{ id: 'stale' }] } });
	const clearedIds = [];
	clearProviderModelCatalog(p, (id) => clearedIds.push(id));
	assert.equal(p.modelCatalog, undefined);
	assert.deepEqual(clearedIds, ['p1'], 'must clear ProviderManager.listModelsCache for this provider, or a stale in-session promise would survive the click');

	// A subsequent Fetch repopulates it from scratch.
	applyFetchedCatalog(p, [{ id: 'fresh' }], '2026-02-02T00:00:00.000Z');
	assert.deepEqual(p.modelCatalog, { fetchedAt: '2026-02-02T00:00:00.000Z', models: [{ id: 'fresh' }] });
});

// ── Surfacing (deriveCatalogSuggestion / catalogEntrySummaryTokens / catalogSuggestionHasChanges) ──

test('deriveCatalogSuggestion maps LM Studio native shapes: llm, vlm, embeddings', () => {
	assert.deepEqual(deriveCatalogSuggestion({ id: 'a', type: 'llm' }).capabilities, ['chat']);
	assert.deepEqual(deriveCatalogSuggestion({ id: 'b', type: 'vlm' }).capabilities, ['chat', 'image-extraction']);
	assert.deepEqual(deriveCatalogSuggestion({ id: 'c', type: 'embeddings' }).capabilities, ['embedding']);
});

test('deriveCatalogSuggestion maps ollama serverCapabilities tags, ignoring tags with no equivalent', () => {
	const suggestion = deriveCatalogSuggestion({ id: 'x', serverCapabilities: ['completion', 'tools', 'thinking'] });
	assert.deepEqual(suggestion.capabilities, ['chat']);
});

test('deriveCatalogSuggestion never fabricates embeddingDimensions — only ollama embeddingLength', () => {
	assert.equal(deriveCatalogSuggestion({ id: 'a', type: 'embeddings' }).embeddingDimensions, undefined, 'LM Studio native carries no width — must stay blank, not guessed');
	assert.equal(deriveCatalogSuggestion({ id: 'b', embeddingLength: 768 }).embeddingDimensions, 768);
});

test('catalogEntrySummaryTokens builds the provenance line pieces, e.g. "embeddings, F16"', () => {
	assert.deepEqual(catalogEntrySummaryTokens({ id: 'x', type: 'embeddings', quantization: 'F16' }), ['embeddings', 'F16']);
});

test('catalogSuggestionHasChanges is false when the model already matches, so Accept has nothing to do', () => {
	const m = model({ capabilities: ['embedding'], embeddingDimensions: 768 });
	const suggestion = { capabilities: ['embedding'], embeddingDimensions: 768 };
	assert.equal(catalogSuggestionHasChanges(m, suggestion), false);
});

test('catalogSuggestionHasChanges treats capability list order as irrelevant', () => {
	const m = model({ capabilities: ['embedding', 'chat'] });
	assert.equal(catalogSuggestionHasChanges(m, { capabilities: ['chat', 'embedding'] }), false);
});

// ── WP-8 — probe-first becomes the default (D2 amendment, plans/sprint-exit-queue-health-and-scrub.md) ──

test('WP-8: an explicit catalog pick auto-applies through the SAME acceptCatalogSuggestion/resetCatalogField path Accept uses — badge + undo is the fallback, not a new mechanism', () => {
	const m = model({ id: 'text-embedding-bge-m3', capabilities: undefined });
	const state = getOrCreateProbeState(m);
	const entry = { id: 'text-embedding-bge-m3', type: 'embeddings', quantization: 'F16', embeddingLength: 1024 };

	// This is exactly what ai.ts's ProviderModelSuggest onChoose now does: derive + accept
	// immediately, with no separate Accept click required.
	const suggestion = deriveCatalogSuggestion(entry);
	acceptCatalogSuggestion(m, suggestion, state);

	assert.deepEqual(m.capabilities, ['embedding']);
	assert.equal(m.embeddingDimensions, 1024);
	assert.equal(m.embeddingVariant, 'F16');
	assert.equal(state.accepted.capabilities, true);
	assert.equal(state.accepted.embeddingDimensions, true);
	assert.equal(state.accepted.embeddingVariant, true);

	// Undo (the per-field Reset button) restores every field to its pre-pick state.
	resetCatalogField(m, 'capabilities', state);
	resetCatalogField(m, 'embeddingDimensions', state);
	resetCatalogField(m, 'embeddingVariant', state);
	assert.equal(m.capabilities, undefined);
	assert.equal(m.embeddingDimensions, undefined);
	assert.equal(m.embeddingVariant, undefined);
});

test('WP-8: applyFetchedCatalog (background/lazy fetch) never mutates any model row, even immediately before an auto-apply pick', () => {
	// The lazy fetch and the explicit pick are two different actions gated differently — this
	// pins that the fetch half still only ever writes Provider.modelCatalog.
	const p = provider({ models: [model({ id: 'existing', capabilities: ['chat'] })] });
	const before = p.models.map(m => ({ ...m }));
	applyFetchedCatalog(p, [{ id: 'existing', type: 'embeddings' }, { id: 'new-one', type: 'llm' }]);
	assert.deepEqual(p.models, before, 'a fetch alone must not touch any existing ProviderModel');
});

test('deriveCatalogSuggestion reads OpenRouter-style inputModalities: an "image" modality suggests image-extraction (and chat)', () => {
	const suggestion = deriveCatalogSuggestion({ id: 'x', inputModalities: ['text', 'image'] });
	assert.deepEqual(new Set(suggestion.capabilities), new Set(['chat', 'image-extraction']));
});

test('deriveCatalogSuggestion reads inputModalities without "image": chat only, no image-extraction', () => {
	const suggestion = deriveCatalogSuggestion({ id: 'x', inputModalities: ['text'] });
	assert.deepEqual(suggestion.capabilities, ['chat']);
});

test('an entry with no type/serverCapabilities/inputModalities still yields no capability suggestion (contextLength alone is not a capability signal)', () => {
	assert.equal(deriveCatalogSuggestion({ id: 'x', contextLength: 1000 }).capabilities, undefined);
});

// ── WP-2: OpenRouter's embeddings-listing leg reports architecture.output_modalities ────────

test('deriveCatalogSuggestion reads OpenRouter-style outputModalities: "embeddings" suggests the embedding capability alone', () => {
	const suggestion = deriveCatalogSuggestion({ id: 'x', inputModalities: ['text'], outputModalities: ['embeddings'] });
	assert.deepEqual(suggestion.capabilities, ['embedding']);
});

test('outputModalities "embeddings" takes precedence over the inputModalities-chat branch — no chat capability is inferred', () => {
	// An OpenRouter embeddings-listing entry reports a text input modality alongside
	// output_modalities: ["embeddings"] (WP-2 pinned facts) — the entry accepts text input, but
	// that must not be read as "this model can chat."
	const suggestion = deriveCatalogSuggestion({ id: 'x', inputModalities: ['text', 'image'], outputModalities: ['embeddings'] });
	assert.deepEqual(suggestion.capabilities, ['embedding']);
});

test('outputModalities without "embeddings" falls through to the ordinary inputModalities-chat inference', () => {
	const suggestion = deriveCatalogSuggestion({ id: 'x', inputModalities: ['text'], outputModalities: ['text'] });
	assert.deepEqual(suggestion.capabilities, ['chat']);
});

test('deriveCatalogSuggestion routes a supplied describeModel() precision into embeddingVariant only when the catalog entry itself has no quantization', () => {
	// No catalog quantization signal at all (OpenRouter / plain "/models" shape) — the describeModel
	// fallback is used.
	const withFallbackOnly = deriveCatalogSuggestion({ id: 'x' }, 'f16');
	assert.equal(withFallbackOnly.embeddingVariant, 'f16');

	// The catalog's OWN reported quantization always wins over the describeModel fallback.
	const withBoth = deriveCatalogSuggestion({ id: 'x', quantization: 'Q4_K_M' }, 'f16');
	assert.equal(withBoth.embeddingVariant, 'Q4_K_M');

	// No signal at all (no quantization, no fallback) — stays absent, never guessed.
	const withNeither = deriveCatalogSuggestion({ id: 'x' });
	assert.equal(withNeither.embeddingVariant, undefined);
});

test('catalogEntrySummaryTokens surfaces inputModalities verbatim and a supportedParameters count (read, not fabricated)', () => {
	const tokens = catalogEntrySummaryTokens({
		id: 'x',
		inputModalities: ['text', 'image'],
		supportedParameters: ['tools', 'temperature', 'seed'],
	});
	assert.ok(tokens.includes('text/image'));
	assert.ok(tokens.includes('3 params'));
});

test('catalogEntrySummaryTokens omits inputModalities/supportedParameters tokens when absent', () => {
	assert.deepEqual(catalogEntrySummaryTokens({ id: 'x', type: 'llm' }), ['llm']);
});

// ── WP-1 — inline catalog browser panel: modelCapabilities.ts additions ─────────────────────────

test('inferCapabilities is exported (WP-1: the catalog browser buckets on the same signal deriveCatalogSuggestion offers)', () => {
	assert.deepEqual(inferCapabilities({ id: 'x', type: 'llm' }), ['chat']);
	assert.equal(inferCapabilities({ id: 'x' }), undefined, 'no signal at all stays undefined, never []');
});

test('filterCatalogModelsForQuery still matches on id alone when displayName is absent (pre-WP-2 shape)', () => {
	const models = [{ id: 'text-embedding-bge-m3' }, { id: 'llama-3' }];
	assert.deepEqual(filterCatalogModelsForQuery(models, 'bge'), [models[0]]);
});

test('filterCatalogModelsForQuery (WP-1) also matches a case-insensitive substring of displayName', () => {
	const models = [
		{ id: '/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf', displayName: 'BGE-M3 (F16)' },
		{ id: 'llama-3', displayName: 'Llama 3' },
	];
	assert.deepEqual(filterCatalogModelsForQuery(models, 'bge-m3'), [models[0]], 'matches displayName even though the id has no contiguous "bge-m3" substring at the same casing');
	assert.deepEqual(filterCatalogModelsForQuery(models, 'llama'), [models[1]]);
});

test('filterCatalogModelsForQuery matches either id or displayName, not just one', () => {
	const models = [
		{ id: 'qwen3-embedding-8b', displayName: 'Qwen3 Embedding' },
		{ id: 'unrelated-id', displayName: 'Also Qwen-flavored' },
	];
	const hits = filterCatalogModelsForQuery(models, 'qwen');
	assert.deepEqual(hits, models, 'first matches via id, second matches via displayName only');
});

test('filterCatalogModelsForQuery tolerates a non-string displayName (defensive cast) without throwing', () => {
	const models = [{ id: 'a', displayName: 42 }, { id: 'b' }];
	assert.deepEqual(filterCatalogModelsForQuery(models, 'a'), [models[0]]);
});

test('buildProviderModelSuggestRows: at or under the 100-row cap, overflowCount is 0 and nothing is dropped', () => {
	const models = Array.from({ length: PROVIDER_MODEL_SUGGEST_LIMIT }, (_, i) => ({ id: `model-${i}` }));
	const { rows, overflowCount } = buildProviderModelSuggestRows(models, '');
	assert.equal(rows.length, PROVIDER_MODEL_SUGGEST_LIMIT);
	assert.equal(overflowCount, 0);
});

test('buildProviderModelSuggestRows: exactly one over the cap reports overflowCount 1 and still caps rows at the limit', () => {
	const models = Array.from({ length: PROVIDER_MODEL_SUGGEST_LIMIT + 1 }, (_, i) => ({ id: `model-${i}` }));
	const { rows, overflowCount } = buildProviderModelSuggestRows(models, '');
	assert.equal(rows.length, PROVIDER_MODEL_SUGGEST_LIMIT);
	assert.equal(overflowCount, 1);
});

test('buildProviderModelSuggestRows: overflow is computed AFTER the query filter, not against the whole catalog', () => {
	const matching = Array.from({ length: 5 }, (_, i) => ({ id: `bge-${i}` }));
	const noise = Array.from({ length: 500 }, (_, i) => ({ id: `llama-${i}` }));
	const { rows, overflowCount } = buildProviderModelSuggestRows([...matching, ...noise], 'bge');
	assert.deepEqual(rows, matching);
	assert.equal(overflowCount, 0, 'the 500 non-matching entries must never count toward overflow');
});

// ── WP-3 — auto-alias: deriveModelDisplayLabel ──────────────────────────────────────────────────

test('deriveModelDisplayLabel: a file-path-shaped id (the live crucible-inference GGUF shape) derives the basename with .gguf stripped, quant suffix kept', () => {
	assert.equal(
		deriveModelDisplayLabel('/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf'),
		'bge-m3-f16',
	);
});

test('deriveModelDisplayLabel: a plain vendor/model catalog id keeps the label empty — the id is already readable', () => {
	assert.equal(deriveModelDisplayLabel('openai/text-embedding-3-small'), '');
	assert.equal(deriveModelDisplayLabel('bge-m3'), '');
});

test('deriveModelDisplayLabel: a relative path ending in .gguf (no leading slash) still counts as file-path-shaped', () => {
	assert.equal(deriveModelDisplayLabel('models/bge-reranker-v2-m3-Q8_0.gguf'), 'bge-reranker-v2-m3-Q8_0');
});

test('deriveModelDisplayLabel: a non-blank catalog displayName always wins, even over a file-path-shaped id', () => {
	assert.equal(
		deriveModelDisplayLabel('/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf', 'BGE-M3 (F16)'),
		'BGE-M3 (F16)',
	);
});

test('deriveModelDisplayLabel: a blank/whitespace displayName is treated as absent, falling through to id derivation', () => {
	assert.equal(deriveModelDisplayLabel('/models/x/bge-m3-f16.gguf', '   '), 'bge-m3-f16');
	assert.equal(deriveModelDisplayLabel('openai/text-embedding-3-small', ''), '');
});

test('fillModelLabelIfEmpty: fills an empty label from the derived label, and never touches a label the user already typed', () => {
	const entry = { id: '/models/x/bge-m3-f16.gguf', displayName: undefined };

	const empty = model({ label: '' });
	fillModelLabelIfEmpty(empty, entry);
	assert.equal(empty.label, 'bge-m3-f16');

	const userTyped = model({ label: 'My custom label' });
	fillModelLabelIfEmpty(userTyped, entry);
	assert.equal(userTyped.label, 'My custom label', 'a user-typed label is never overwritten by a pick');
});

test('fillModelLabelIfEmpty: a plain id with nothing to derive leaves the label empty rather than writing the id itself', () => {
	const m = model({ label: '' });
	fillModelLabelIfEmpty(m, { id: 'openai/text-embedding-3-small' });
	assert.equal(m.label, '');
});

// ── WP-3 — precision-from-id: deriveCatalogSuggestion's last-resort embeddingVariant source ────

test('precisionFromModelId: parses the float family (f16/f32/fp16/fp32/bf16), case-insensitively, [-_.]-separated', () => {
	assert.equal(precisionFromModelId('bge-m3-f16'), 'f16');
	assert.equal(precisionFromModelId('bge-m3-F32'), 'fp32');
	assert.equal(precisionFromModelId('bge-m3-fp16'), 'f16');
	assert.equal(precisionFromModelId('bge-m3.fp32'), 'fp32');
	assert.equal(precisionFromModelId('bge-m3_BF16'), 'bf16');
});

test('precisionFromModelId: parses the GGUF quant-scheme family (Q2_K, Q4_K_M, Q8_0), capturing the full underscore-joined suffix', () => {
	assert.equal(precisionFromModelId('bge-reranker-v2-m3-Q8_0'), 'q8_0');
	assert.equal(precisionFromModelId('some-model-Q4_K_M'), 'q4_k_m');
	assert.equal(precisionFromModelId('another-model-q2_k'), 'q2_k');
});

test('precisionFromModelId: works on a file-path-shaped id too — the basename is parsed after stripping directory and .gguf', () => {
	assert.equal(precisionFromModelId('/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf'), 'f16');
});

test('precisionFromModelId: returns undefined for an id with no trailing precision token, never a guess', () => {
	assert.equal(precisionFromModelId('bge-m3'), undefined);
	assert.equal(precisionFromModelId('openai/text-embedding-3-small'), undefined);
});

test('deriveCatalogSuggestion: id-parsed precision is a LAST resort — real quantization and describedPrecision both win over it', () => {
	// Nothing but the id itself carries a signal.
	assert.equal(deriveCatalogSuggestion({ id: 'bge-m3-f16' }).embeddingVariant, 'f16');
	assert.equal(deriveCatalogSuggestion({ id: 'bge-reranker-v2-m3-Q8_0' }).embeddingVariant, 'q8_0');

	// The catalog's own reported quantization wins over an id-parseable token.
	assert.equal(
		deriveCatalogSuggestion({ id: 'bge-m3-f16', quantization: 'Q4_K_M' }).embeddingVariant,
		'Q4_K_M',
	);

	// A describeModel() fallback wins over an id-parseable token too.
	assert.equal(deriveCatalogSuggestion({ id: 'bge-m3-f16' }, 'bf16').embeddingVariant, 'bf16');

	// No signal anywhere (no quantization, no fallback, no parseable id token) stays absent.
	assert.equal(deriveCatalogSuggestion({ id: 'bge-m3' }).embeddingVariant, undefined);
});

// ── WP-3 — dims probe: probeEmbeddingDimensions writes via the accepted-marker path ─────────────

test('probeEmbeddingDimensions writes embeddingDimensions through acceptCatalogSuggestion (badge + Reset), from a mocked embed() call', async () => {
	const m = model({ embeddingDimensions: undefined });
	const state = getOrCreateProbeState(m);
	const embed = async (inputs) => {
		assert.deepEqual(inputs, ['probe']);
		return { embeddings: [Array.from({ length: 1024 }, () => 0.1)] };
	};

	const dims = await probeEmbeddingDimensions(embed, m, state);

	assert.equal(dims, 1024);
	assert.equal(m.embeddingDimensions, 1024);
	assert.equal(state.accepted.embeddingDimensions, true, 'probe-accepted badge condition');
	assert.equal(state.snapshot.get('embeddingDimensions'), undefined, 'the pre-probe value (undefined) was snapshotted for Reset');
});

test('probeEmbeddingDimensions Reset restores the prior value via the same resetCatalogField path other probed fields use', async () => {
	const m = model({ embeddingDimensions: 42 });
	const state = getOrCreateProbeState(m);
	await probeEmbeddingDimensions(async () => ({ embeddings: [[0.1, 0.2, 0.3]] }), m, state);
	assert.equal(m.embeddingDimensions, 3);

	resetCatalogField(m, 'embeddingDimensions', state);
	assert.equal(m.embeddingDimensions, 42, 'restored to the value before the probe, not to undefined');
	assert.equal(state.accepted.embeddingDimensions, undefined);
});

test('probeEmbeddingDimensions throws (never silently no-ops) on an empty/missing embedding vector', async () => {
	const m = model();
	const state = getOrCreateProbeState(m);
	await assert.rejects(() => probeEmbeddingDimensions(async () => ({ embeddings: [] }), m, state));
	await assert.rejects(() => probeEmbeddingDimensions(async () => ({ embeddings: [[]] }), m, state));
	assert.equal(m.embeddingDimensions, undefined, 'a failed probe must not have written anything');
});
