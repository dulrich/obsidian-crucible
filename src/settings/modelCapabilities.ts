import { Provider, ProviderCatalogModel, ProviderModel, ProviderModelCapability } from '../types';

/**
 * Reading and writing a provider model's capability flags.
 *
 * These live in their own module rather than inside the settings tab because the whole bug they
 * exist to prevent is a *state* bug, not a UI one, and a state bug wants a unit test that does
 * not have to bundle the settings pane to reach it.
 *
 * The load-bearing distinction: `capabilities === undefined` means "never configured" and reads
 * as chat-only, per the legacy contract documented on `ProviderModel`. An **empty array** is a
 * different statement — the user turned every capability off — and must be honoured as such.
 *
 * Conflating the two is how a Rerank-only model kept regaining Chat across reloads. The toggles
 * write through `setModelCapability`, which re-seeded its Set from `['chat']` whenever the
 * current array was empty, so turning Chat off (leaving `[]`) and then turning Rerank on
 * produced `['chat', 'rerank']` rather than `['rerank']`. The model row is not re-rendered after
 * a toggle, so the Chat switch still *looked* off for the rest of the session and the re-added
 * capability only surfaced on the next reload — which is what made it present as a restart bug
 * rather than a toggle bug. Treating `[]` as chat on the read side compounded it: a model stored
 * as `[]` rendered its Chat toggle on while nothing had been written, so the next toggle of any
 * kind made the lie real.
 */
export function modelHasCapability(model: ProviderModel, capability: ProviderModelCapability): boolean {
	if (!model.capabilities) return capability === 'chat';
	return model.capabilities.includes(capability);
}

export function setModelCapability(model: ProviderModel, capability: ProviderModelCapability, enabled: boolean): void {
	// Seed from the legacy default only when nothing was ever configured — never when the array
	// is present and empty, which is an explicit "no capabilities", not an absence.
	const defaults: ProviderModelCapability[] = ['chat'];
	const next = new Set<ProviderModelCapability>(model.capabilities ?? defaults);
	if (enabled) next.add(capability);
	else next.delete(capability);
	model.capabilities = Array.from(next);
}

/**
 * WP-D — probe-first model configuration (plans/queue-control-model-probing-vault-isolation.md,
 * governing rule D2: "a probe never auto-writes model configuration"). Everything below this line
 * is pure state/logic with no Obsidian import, deliberately, so it can be unit-tested the same way
 * as the capability functions above — bundled standalone with esbuild, no DOM/plugin stub needed.
 * `src/settings/sections/ai.ts` is the only caller; it renders the Fetch/Surface/Accept/Reset
 * controls and calls these functions rather than reimplementing any of this inline.
 *
 * D2's four steps map onto these exports as follows:
 *   1. Fetch  → `applyFetchedCatalog` (writes only `Provider.modelCatalog`, never a `ProviderModel`)
 *   2. Surface → `deriveCatalogSuggestion` + `catalogEntrySummaryTokens` + `crossEncoderWarningText`
 *   3. Accept → `acceptCatalogSuggestion` (the only function in this file that writes a probed
 *      value onto a `ProviderModel`)
 *   4. Reset  → `resetCatalogField`
 */

/** The three `ProviderModel` fields a catalog entry can ever suggest a value for. */
export type AcceptableCatalogField = 'capabilities' | 'embeddingDimensions' | 'embeddingVariant';

/**
 * What a catalog entry suggests for a model row, with per-field presence meaning "the catalog had
 * a real signal for this field" — an absent key, not `undefined` filled in, is how "no signal" is
 * represented, and callers must not synthesize one. This is what keeps `acceptCatalogSuggestion`
 * from ever writing a value the server didn't actually report.
 */
export interface CatalogSuggestion {
	capabilities?: ProviderModelCapability[];
	embeddingDimensions?: number;
	embeddingVariant?: string;
}

/**
 * Per-model session state: which fields are currently showing a probe-accepted value (`accepted`,
 * for the UI's user-set-vs-probe-accepted marking) and what the field held immediately before the
 * most recent Accept (`snapshot`, for Reset to restore). `snapshot` is a `Map`, not a plain object,
 * specifically so "this field was snapshotted with value `undefined`" (`.has(field) === true`) is
 * distinguishable from "this field was never snapshotted" (`.has(field) === false`) — the same
 * undefined-vs-absent distinction this file's capability functions exist to protect, one level up.
 */
export interface ModelProbeState {
	accepted: Partial<Record<AcceptableCatalogField, true>>;
	snapshot: Map<AcceptableCatalogField, unknown>;
}

// Keyed by the live `ProviderModel` object, which is stable across settings-tab re-renders for
// the plugin's session (models are mutated in place — see `renderProviderModelsList` — never
// replaced), so this survives the `tab.display()` calls the Accept/Reset buttons trigger. It is
// intentionally NOT persisted to settings: whether a value is "probe-accepted" is a session-UI
// fact, not vault state, and does not need to survive an Obsidian restart.
const probeStateByModel = new WeakMap<ProviderModel, ModelProbeState>();

export function getOrCreateProbeState(model: ProviderModel): ModelProbeState {
	let state = probeStateByModel.get(model);
	if (!state) {
		state = { accepted: {}, snapshot: new Map() };
		probeStateByModel.set(model, state);
	}
	return state;
}

// ollama's own capability tags (from `/api/show`) that map onto a `ProviderModelCapability`.
// Tags with no Crucible-side equivalent (e.g. "tools", "thinking", "insert") are real signal from
// the server, just not one this app acts on yet — silently ignored, not an error.
function capabilitiesFromServerTags(tags: string[]): ProviderModelCapability[] {
	const inferred = new Set<ProviderModelCapability>();
	for (const tag of tags) {
		if (tag === 'completion') inferred.add('chat');
		else if (tag === 'embedding') inferred.add('embedding');
		else if (tag === 'vision') inferred.add('image-extraction');
	}
	return Array.from(inferred);
}

/**
 * Maps a catalog entry's `type`/`serverCapabilities` onto suggested `ProviderModelCapability`
 * values. Returns `undefined` — not `[]` — when the entry carries no capability signal at all
 * (e.g. plain OpenAI's ids-only listing), because `[]` means something specific downstream ("the
 * user turned everything off") and this function must never manufacture that statement out of a
 * server that simply didn't say anything.
 *
 * `looksLikeCrossEncoder` is deliberately NOT consulted here — per the plan's D2 posture ("carry,
 * never act on"), that heuristic only ever produces a warning (`crossEncoderWarningText`), never a
 * suggested capability. Inferring a `rerank` capability from it would be exactly the kind of
 * acting-on-it this field exists to prevent.
 */
function inferCapabilities(entry: ProviderCatalogModel): ProviderModelCapability[] | undefined {
	const inferred = new Set<ProviderModelCapability>();
	let hasSignal = false;

	if (entry.type === 'llm') {
		inferred.add('chat');
		hasSignal = true;
	} else if (entry.type === 'vlm') {
		inferred.add('chat');
		inferred.add('image-extraction');
		hasSignal = true;
	} else if (entry.type === 'embeddings') {
		inferred.add('embedding');
		hasSignal = true;
	}

	if (entry.serverCapabilities && entry.serverCapabilities.length > 0) {
		hasSignal = true;
		for (const cap of capabilitiesFromServerTags(entry.serverCapabilities)) inferred.add(cap);
	}

	// WP-8: OpenRouter-style `architecture.input_modalities` (surfaced here as
	// `ProviderCatalogModel.inputModalities`) is real capability signal with no equivalent in the
	// `type`-tag branches above — OpenRouter's `/models` never sets `type`. Any reported input
	// modality means the model accepts completion requests at all (`chat`); an `image` modality
	// additionally means it can see images (`image-extraction`), mirroring the `vlm` branch above
	// for a kind that reports modalities instead of a type tag.
	if (entry.inputModalities && entry.inputModalities.length > 0) {
		hasSignal = true;
		inferred.add('chat');
		if (entry.inputModalities.includes('image')) inferred.add('image-extraction');
	}

	return hasSignal ? Array.from(inferred) : undefined;
}

/**
 * The Surface step: what a catalog entry would fill in, if accepted. Never mutates anything —
 * `acceptCatalogSuggestion` is the only function below that writes to a `ProviderModel`.
 *
 * `embeddingDimensions` is populated only from `entry.embeddingLength` (ollama's `/api/show` —
 * the only list-adjacent endpoint that reports embedding width at all) — never fabricated for a
 * kind that doesn't report it, per the plan's explicit "don't guess" instruction.
 *
 * `embeddingVariant` prefers the catalog's own raw `quantization` string, unnormalized (e.g. "F16",
 * not "f16") — matching `ProviderCatalogModel.quantization`'s own doc comment: normalization
 * (`normalizePrecision`) happens once, at *use* time (`SearchManager`), not at accept time, so the
 * value shown and accepted here is exactly what the server said.
 *
 * `describedPrecision` (WP-8) is a fallback for kinds whose *list* endpoint carries no quantization
 * at all — OpenRouter, plain OpenAI, Infinity, or a bare-`/models` local server (vLLM, llama.cpp,
 * LocalAI) — but whose per-model `describeModel()` probe might still know something. It is used
 * ONLY when the catalog entry itself has no signal: a real, verbatim server value always wins over
 * an already-normalized fallback, and the fallback is silently absent (never guessed) when
 * `describeModel()` also came back empty (e.g. Infinity, which exposes no dtype at either
 * endpoint). Passing it is the caller's job (`ai.ts`) — this function stays a pure, synchronous
 * transform with no knowledge of how a caller obtained the fallback value.
 */
export function deriveCatalogSuggestion(entry: ProviderCatalogModel, describedPrecision?: string): CatalogSuggestion {
	const suggestion: CatalogSuggestion = {};
	const capabilities = inferCapabilities(entry);
	if (capabilities !== undefined) suggestion.capabilities = capabilities;
	if (entry.embeddingLength !== undefined) suggestion.embeddingDimensions = entry.embeddingLength;
	if (entry.quantization !== undefined) suggestion.embeddingVariant = entry.quantization;
	else if (describedPrecision !== undefined) suggestion.embeddingVariant = describedPrecision;
	return suggestion;
}

/** Short descriptive tokens for a catalog entry, used to build the "<Provider> reports: ..." provenance line. */
export function catalogEntrySummaryTokens(entry: ProviderCatalogModel): string[] {
	const tokens: string[] = [];
	if (entry.type) tokens.push(entry.type);
	if (entry.quantization) tokens.push(entry.quantization);
	if (entry.arch) tokens.push(entry.arch);
	if (entry.ownedBy) tokens.push(entry.ownedBy);
	if (entry.contextLength) tokens.push(`${entry.contextLength} ctx`);
	if (entry.embeddingLength) tokens.push(`${entry.embeddingLength}d`);
	if (entry.serverCapabilities && entry.serverCapabilities.length > 0) tokens.push(entry.serverCapabilities.join('/'));
	// WP-8: OpenRouter's rich, previously-unread fields. `inputModalities` is worth naming outright
	// (e.g. "text/image"); `supportedParameters` is often a long list (tools, temperature, seed,
	// response_format, ...), so a count is surfaced rather than the whole thing — reading it here
	// is the point (per the plan's "currently 100% unread" note), not fabricating a token per value.
	if (entry.inputModalities && entry.inputModalities.length > 0) tokens.push(entry.inputModalities.join('/'));
	if (entry.supportedParameters && entry.supportedParameters.length > 0) tokens.push(`${entry.supportedParameters.length} params`);
	return tokens;
}

/**
 * Warn-never-block posture for a catalog entry that looks like a cross-encoder/reranker reported
 * as an embedding model (see `providers/shared.ts`'s `looksLikeCrossEncoder`/
 * `warnIfCrossEncoderEmbedder` for the same heuristic applied at index time). Returns `undefined`
 * when there's nothing to warn about; callers must render this as an advisory only — it must never
 * filter the entry out of a suggestion list or disable selecting it.
 */
export function crossEncoderWarningText(entry: ProviderCatalogModel): string | undefined {
	if (!entry.looksLikeCrossEncoder) return undefined;
	return 'This model looks like a cross-encoder / reranker (its id or reported metadata matched "rerank"/"cross-enc"), not a bi-encoder. Cross-encoder outputs are not valid similarity vectors for embedding search — verify this before accepting it as an embedding model.';
}

function capabilityListsEqual(a: ProviderModelCapability[] | undefined, b: ProviderModelCapability[] | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	if (a.length !== b.length) return false;
	const setB = new Set(b);
	return a.every(v => setB.has(v));
}

/** Whether accepting `suggestion` onto `model` would change anything — drives whether the Accept button is enabled. */
export function catalogSuggestionHasChanges(model: ProviderModel, suggestion: CatalogSuggestion): boolean {
	if (suggestion.capabilities !== undefined && !capabilityListsEqual(model.capabilities, suggestion.capabilities)) return true;
	if (suggestion.embeddingDimensions !== undefined && model.embeddingDimensions !== suggestion.embeddingDimensions) return true;
	if (suggestion.embeddingVariant !== undefined && model.embeddingVariant !== suggestion.embeddingVariant) return true;
	return false;
}

/**
 * The Accept step — D2's rule 3, and the ONLY function in this codebase permitted to copy a
 * probed value onto `ProviderModel.capabilities` / `embeddingDimensions` / `embeddingVariant`.
 *
 * Per-field, and only for fields `suggestion` actually carries a value for (see
 * `CatalogSuggestion`'s doc comment) — a field the catalog had no signal for is left completely
 * untouched, whatever it currently holds (`undefined` stays `undefined`, an explicit `[]` stays
 * `[]`). This is what keeps Accept from ever reintroducing the bug `setModelCapability`'s own doc
 * comment describes: collapsing "unset" and "explicitly emptied" into one state.
 *
 * The pre-accept value is snapshotted (once — a second Accept before a Reset must not overwrite
 * the *original* user value with the previous accepted one) so `resetCatalogField` can restore it.
 */
export function acceptCatalogSuggestion(model: ProviderModel, suggestion: CatalogSuggestion, state: ModelProbeState): void {
	if (suggestion.capabilities !== undefined) {
		if (!state.snapshot.has('capabilities')) state.snapshot.set('capabilities', model.capabilities);
		model.capabilities = suggestion.capabilities;
		state.accepted.capabilities = true;
	}
	if (suggestion.embeddingDimensions !== undefined) {
		if (!state.snapshot.has('embeddingDimensions')) state.snapshot.set('embeddingDimensions', model.embeddingDimensions);
		model.embeddingDimensions = suggestion.embeddingDimensions;
		state.accepted.embeddingDimensions = true;
	}
	if (suggestion.embeddingVariant !== undefined) {
		if (!state.snapshot.has('embeddingVariant')) state.snapshot.set('embeddingVariant', model.embeddingVariant);
		model.embeddingVariant = suggestion.embeddingVariant;
		state.accepted.embeddingVariant = true;
	}
}

/** The Reset step — D2's rule 4. Restores one field to what it held immediately before Accept, and clears its accepted marking. A no-op if the field was never accepted. */
export function resetCatalogField(model: ProviderModel, field: AcceptableCatalogField, state: ModelProbeState): void {
	if (state.snapshot.has(field)) {
		const prior = state.snapshot.get(field);
		if (field === 'capabilities') model.capabilities = prior as ProviderModelCapability[] | undefined;
		else if (field === 'embeddingDimensions') model.embeddingDimensions = prior as number | undefined;
		else if (field === 'embeddingVariant') model.embeddingVariant = prior as string | undefined;
		state.snapshot.delete(field);
	}
	delete state.accepted[field];
}

/**
 * "Override" — D2's rule 4 also covers a user directly editing a field that currently holds a
 * probe-accepted value: at that point it's user-set again, not the probe's, so the marking must
 * clear even though nothing goes through `resetCatalogField`. `ai.ts` calls this from the
 * capability toggles' and the dimensions/variant text fields' own `onChange` handlers.
 */
export function clearAcceptedMarker(state: ModelProbeState, field: AcceptableCatalogField): void {
	delete state.accepted[field];
	// The snapshot goes too, and that is the point rather than a tidy-up. Once the user has hand-
	// edited the field, *their* edit is the value Reset should restore — so the next Accept must be
	// free to re-snapshot it. Keeping the old snapshot would make this sequence lose the edit:
	// Accept (snapshot = original) → hand-edit → Accept again (snapshot already present, so not
	// refreshed) → Reset, which would restore the *original* and silently discard the hand-edit.
	// The snapshot-once rule in `acceptCatalogSuggestion` still holds where it was aimed: two
	// Accepts with no edit between them keep the original, because nothing clears the marker.
	// Dropping it here is also why nothing is stranded — `ai.ts` only renders the Reset control
	// while `accepted[field]` is set, so a snapshot surviving a cleared marker is unreachable.
	state.snapshot.delete(field);
}

// ── Provider-level catalog fetch/clear (D2 rules 1 and the Clear-cache control) ────────────────

export type ProviderProbeStatus =
	| { state: 'idle' }
	| { state: 'ok'; count: number }
	| { state: 'error'; reason: string };

// Same rationale as probeStateByModel: session-UI fact, keyed by the live Provider object, not
// persisted. `Provider.modelCatalog` (persisted) is the fetched data; this is just "how did the
// last fetch go", which resets to unknown on reload anyway (there's nothing stale to show).
const probeStatusByProvider = new WeakMap<Provider, ProviderProbeStatus>();

export function getProbeStatus(provider: Provider): ProviderProbeStatus {
	return probeStatusByProvider.get(provider) ?? { state: 'idle' };
}

export function setProbeStatus(provider: Provider, status: ProviderProbeStatus): void {
	probeStatusByProvider.set(provider, status);
}

/**
 * The inline status line's text. Distinguishing "the server said it has no models" from "the
 * server was unreachable" — rather than a spinner that just stops — is the specific failure mode
 * the plan calls out to avoid; `reason` carries the thrown error's message verbatim so the user
 * sees what actually went wrong (missing key, connection refused, unsupported kind, ...) rather
 * than a generic failure string.
 */
export function formatProbeStatusText(status: ProviderProbeStatus): string {
	switch (status.state) {
		case 'idle':
			return '';
		case 'ok':
			return status.count === 0
				? 'The server reported no models.'
				: `${status.count} model${status.count === 1 ? '' : 's'} found.`;
		case 'error':
			// Deliberately cause-neutral. A fetch fails for reasons that are not reachability at
			// all — an unsupported provider kind, a rejected key, a malformed response — and
			// asserting "could not reach the server" for those sends the user to debug a network
			// path that is fine. Same misattribution class as the companion client turning a 5xx
			// into "not reachable" and sending users to restart a healthy container (see the
			// search-client quirk in CLAUDE.md). `reason` carries the real cause verbatim.
			return `Could not fetch the model list: ${status.reason}`;
	}
}

/**
 * The Fetch step's only write: stamps and stores the catalog on `Provider.modelCatalog`. Never
 * touches `provider.models` — the regression this function exists to keep impossible is a probe
 * silently landing in `ProviderModel.capabilities` on arrival.
 */
export function applyFetchedCatalog(provider: Provider, models: ProviderCatalogModel[], fetchedAt: string = new Date().toISOString()): void {
	provider.modelCatalog = { fetchedAt, models };
}

/**
 * The Clear-cache control: drops the persisted catalog AND the provider layer's session cache
 * (`ProviderManager.clearModelListCache`, passed in as `clearSessionCache` so this file stays
 * Obsidian-free) — without the second half, a subsequent Fetch would silently replay whatever
 * `ProviderManager.listModels()` cached in-session, including a stale success from before the
 * server's model list changed.
 */
export function clearProviderModelCatalog(provider: Provider, clearSessionCache: (providerId?: string) => void): void {
	provider.modelCatalog = undefined;
	clearSessionCache(provider.id);
}

/**
 * The model id field's suggestion filter (`ProviderModelSuggest`, `suggesters.ts`). Kept here,
 * obsidian-free, rather than inline in that class, specifically so "free text survives" — an id
 * absent from the catalog must never be coerced, rejected, or forced to match something — is
 * directly unit-testable without bundling `suggesters.ts` (which transitively pulls in Obsidian
 * UI classes and several network-calling modules). This function only ever narrows what's
 * *offered*; `ProviderModelSuggest` never overwrites the input's value except on an explicit user
 * pick, so an empty result here simply means no dropdown — typing is untouched either way.
 */
export function filterCatalogModelsForQuery(models: ProviderCatalogModel[], query: string): ProviderCatalogModel[] {
	const trimmed = query.trim().toLowerCase();
	if (!trimmed) return models;
	return models.filter(m => m.id.toLowerCase().includes(trimmed));
}
