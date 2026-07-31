import { ProviderCatalogModel, ProviderModel } from '../types';

/**
 * WP-rem-R4 (F4): the catalog-entry-resolution and describeModel()-probe-cache logic that used to
 * live inline in `src/settings/sections/ai.ts`'s `renderProviderModelsList`. Split out specifically
 * so it is importable and unit-testable without dragging the settings pane's Obsidian/runtime
 * graph — same rationale `modelCapabilities.ts`'s own header comment gives. Zero Obsidian import.
 *
 * `ai.ts` (now `sections/aiProviderModels.ts`) is the only caller; it wires the real
 * `ProviderManager.describeModel` call through the injected `describeModel` callback below rather
 * than this module reaching for it directly.
 */

/**
 * Which catalog entry should drive the Accept-row suggestion for this model row.
 *
 * An exact match on the row's own configured id always wins — that is server-reported truth for
 * what the row is actually configured to request. `servedModel` (the canonical id a describeModel
 * probe resolved the row's id to, when the row's id is itself an alias) is the fallback, and only
 * matters when the exact match already failed: a row configured with `bge-m3` against a llama-swap
 * catalog that lists only `bge-m3-f16` used to render no Accept row at all, even though the probe
 * had already identified exactly which catalog entry it was.
 *
 * Pure and exported so this precedence is testable without rendering the settings pane.
 */
export function resolveModelCatalogEntry(
	rawId: string,
	catalogModels: ProviderCatalogModel[],
	servedModel: string | undefined,
): ProviderCatalogModel | undefined {
	const exact = catalogModels.find(m => m.id === rawId);
	if (exact) return exact;
	if (!servedModel) return undefined;
	return catalogModels.find(m => m.id === servedModel);
}

/** What a `describeModel()` probe can tell a row beyond its own configured id. */
export interface DescribedModelProbeResult {
	precision?: string;
	servedModel?: string;
}

export interface DescribedProbeEntry {
	status: 'pending' | 'done';
	precision?: string;
	servedModel?: string;
}

// Keyed by the live `ProviderModel` object, same lifetime rationale as `modelCapabilities.ts`'s
// `probeStateByModel`: session-only, survives re-renders, not persisted.
//
// WP-8 (D2 amendment): a best-effort per-model precision fallback for the embeddingVariant
// suggestion, used only when the catalog entry itself has no quantization signal (OpenRouter,
// plain OpenAI, Infinity, or a bare-`/models` local server). The caller's `describeModel` is
// already session-cached per (provider, modelId) on its own side, so repeated renders cost nothing
// once resolved — this WeakMap exists only to read that result *synchronously* during a render
// (describeModel is async; a render is not) and to guarantee the probe is kicked off at most once
// per model row. `status: 'pending'` and a resolved `precision: undefined` are deliberately
// distinct from "never asked" (a missing WeakMap entry) — seeing "no precision" once is enough; it
// must not re-probe every render.
//
// WP-5 (alias-catalog glue): the same probe response also carries `servedModel` — the canonical id
// the server actually resolved (e.g. a llama-swap alias `bge-m3` probed and answered as
// `bge-m3-f16`). It rides along on this one entry rather than a second WeakMap so a row that
// already triggered the precision fallback probe gets the alias-match benefit for free, with no
// second network round trip.
const describedProbeByModel = new WeakMap<ProviderModel, DescribedProbeEntry>();

/**
 * Kicks off (or reads back) the one `describeModel` probe a model row needs. Returns the
 * in-flight/settled entry, or `undefined` when there is nothing to probe (`model.id` empty) —
 * callers derive their own field from it rather than duplicating the pending/done bookkeeping.
 *
 * `describeModel` and `onResolved` are injected rather than this module reaching for
 * `ProviderManager`/`CrucibleSettingTab` directly — that is what keeps this file free of any
 * Obsidian import while still being exactly what the real probe (a network call) and the real
 * re-render (`tab.display()`) end up wired to at the one call site in `aiProviderModels.ts`.
 */
export function ensureDescribedProbe(
	model: ProviderModel,
	describeModel: (modelId: string) => Promise<DescribedModelProbeResult>,
	onResolved: () => void,
): DescribedProbeEntry | undefined {
	const existing = describedProbeByModel.get(model);
	if (existing) return existing;
	if (!model.id) return undefined;

	describedProbeByModel.set(model, { status: 'pending' });
	void describeModel(model.id)
		.then((description) => {
			describedProbeByModel.set(model, { status: 'done', precision: description.precision, servedModel: description.servedModel });
			// Only worth a re-render if the probe actually found something to suggest — degrade
			// silently otherwise, same as a rejection below (unsupported kind, unreachable server).
			if (description.precision !== undefined || description.servedModel !== undefined) onResolved();
		})
		.catch(() => {
			describedProbeByModel.set(model, { status: 'done', precision: undefined, servedModel: undefined });
		});
	return undefined;
}
