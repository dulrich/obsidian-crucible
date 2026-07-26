/* eslint-disable obsidianmd/ui/sentence-case */
import { Notice, setIcon } from "obsidian";
import type { CrucibleSettingTab } from "../settings";
import { Provider, ProviderCatalogModel, ProviderModel, ProviderModelCapability } from "../types";
import {
	acceptCatalogSuggestion,
	catalogEntrySummaryTokens,
	deriveCatalogSuggestion,
	deriveModelDisplayLabel,
	fillModelLabelIfEmpty,
	filterCatalogModelsForQuery,
	formatProbeStatusText,
	getOrCreateProbeState,
	getProbeStatus,
	inferCapabilities,
} from "./modelCapabilities";

/**
 * WP-1 — inline model catalog browser panel
 * (plans/model-catalog-ux-local-inference-and-remediations.md).
 *
 * Renders at the bottom of each provider's panel in Settings → AI, replacing the bare
 * `formatProbeStatusText` status line that used to be the ONLY way to see the fetched catalog
 * beyond the 100-capped, id-substring-only type-ahead. Collapsed by default (the header row IS
 * the old status line, plus an expand chevron) so a user who never browses sees no growth in the
 * panel; expanding reveals a filter box, a capability chip row, and a paged list with a **Use**
 * button per entry.
 *
 * Everything below the DOM-rendering `renderModelCatalogBrowser` is pure — no Obsidian import,
 * no DOM — for the same reason `modelCapabilities.ts` keeps its own state machine pure: paging
 * math, capability bucketing, and the Use-button's dedupe rule are exactly the kind of logic that
 * wants a unit test which doesn't have to bundle the settings pane to reach it.
 */

// ── Pure logic: capability bucketing ────────────────────────────────────────────────────────────

/** The chip row's filter buckets. `'untagged'` is `inferCapabilities(entry) === undefined` — a real, distinct bucket, not an absence of one. */
export type ModelCatalogCapabilityBucket = "all" | ProviderModelCapability | "untagged";

/** Render order for the capability-specific chips (excluding `'all'`, which always renders first when the catalog is non-empty). */
export const MODEL_CATALOG_CAPABILITY_BUCKET_ORDER: Exclude<ModelCatalogCapabilityBucket, "all">[] = [
	"chat",
	"embedding",
	"image-extraction",
	"rerank",
	"untagged",
];

export const MODEL_CATALOG_CAPABILITY_BUCKET_LABELS: Record<ModelCatalogCapabilityBucket, string> = {
	all: "All",
	chat: "Chat",
	embedding: "Embedding",
	"image-extraction": "Image",
	rerank: "Rerank",
	untagged: "Untagged",
};

/** Whether `entry` belongs to `bucket`. `'all'` always matches; `'untagged'` matches only entries `inferCapabilities` found no signal for at all. */
export function catalogEntryMatchesBucket(entry: ProviderCatalogModel, bucket: ModelCatalogCapabilityBucket): boolean {
	if (bucket === "all") return true;
	const capabilities = inferCapabilities(entry);
	if (bucket === "untagged") return capabilities === undefined;
	return capabilities !== undefined && capabilities.includes(bucket);
}

/**
 * Per-bucket counts over the full catalog (never text-filtered) — this is what decides which
 * capability chips render at all: "chips render only for non-empty buckets" per the plan, so a
 * provider whose catalog has no reranker entries simply shows no Rerank chip rather than an
 * always-zero one. `all` is always present in the result (equal to `models.length`); the caller
 * decides whether to render it (it should, whenever the catalog itself is non-empty).
 */
export function countModelsByBucket(models: ProviderCatalogModel[]): Record<ModelCatalogCapabilityBucket, number> {
	const counts: Record<ModelCatalogCapabilityBucket, number> = {
		all: models.length,
		chat: 0,
		embedding: 0,
		"image-extraction": 0,
		rerank: 0,
		untagged: 0,
	};
	for (const entry of models) {
		const capabilities = inferCapabilities(entry);
		if (capabilities === undefined) {
			counts.untagged++;
			continue;
		}
		for (const capability of capabilities) counts[capability]++;
	}
	return counts;
}

export function filterModelsByBucket(models: ProviderCatalogModel[], bucket: ModelCatalogCapabilityBucket): ProviderCatalogModel[] {
	if (bucket === "all") return models;
	return models.filter(entry => catalogEntryMatchesBucket(entry, bucket));
}

/**
 * Display-name resolution for a catalog entry: the OpenRouter server-side display name (WP-2's
 * `ProviderCatalogModel.displayName`) when present and non-blank; else (WP-3) a file-path-shaped
 * id's derived basename (`deriveModelDisplayLabel` — the same auto-alias logic the Use button
 * applies to a newly created `ProviderModel.label`, so the browser shows the exact label a pick
 * would produce); else the raw id.
 */
export function catalogEntryDisplayName(entry: ProviderCatalogModel): string {
	return deriveModelDisplayLabel(entry.id, entry.displayName) || entry.id;
}

// ── Pure logic: paging ──────────────────────────────────────────────────────────────────────────

export const MODEL_CATALOG_BROWSER_PAGE_SIZE = 25;

export function modelCatalogTotalPages(count: number, pageSize: number = MODEL_CATALOG_BROWSER_PAGE_SIZE): number {
	return Math.max(1, Math.ceil(count / pageSize));
}

/** Clamps a (possibly stale, e.g. after a filter shrinks the result set) page number into `[1, totalPages]`. */
export function clampModelCatalogPage(page: number, count: number, pageSize: number = MODEL_CATALOG_BROWSER_PAGE_SIZE): number {
	const pages = modelCatalogTotalPages(count, pageSize);
	const normalized = Number.isFinite(page) ? Math.floor(page) : 1;
	return Math.min(Math.max(1, normalized), pages);
}

export function paginateModels(models: ProviderCatalogModel[], page: number, pageSize: number = MODEL_CATALOG_BROWSER_PAGE_SIZE): ProviderCatalogModel[] {
	const clamped = clampModelCatalogPage(page, models.length, pageSize);
	const start = (clamped - 1) * pageSize;
	return models.slice(start, start + pageSize);
}

/** "page X of Y · N models" — the paging counter's exact text, kept as a pure function so its pluralization/boundary behaviour is unit-testable. */
export function formatModelCatalogPageCounter(page: number, count: number, pageSize: number = MODEL_CATALOG_BROWSER_PAGE_SIZE): string {
	const pages = modelCatalogTotalPages(count, pageSize);
	const clamped = clampModelCatalogPage(page, count, pageSize);
	return `page ${clamped} of ${pages} · ${count} model${count === 1 ? "" : "s"}`;
}

// ── Pure logic: the Use button ──────────────────────────────────────────────────────────────────

export interface UseCatalogEntryResult {
	/** `false` means the provider already had a model configured with this id — nothing was created or mutated. */
	created: boolean;
	model: ProviderModel;
}

/**
 * The **Use** button's effect: appends a brand-new `ProviderModel` to `provider.models` and routes
 * it through the SAME probe-first pick path a type-ahead pick already uses
 * (`deriveCatalogSuggestion` + `acceptCatalogSuggestion`) — capabilities/dimensions/variant land
 * exactly as they would from picking this id in the Model field, and the per-field
 * probe-accepted/Reset affordance works identically afterward.
 *
 * Dedupes on id: if `provider.models` already has a row with this id, nothing is created or
 * mutated — the caller (the DOM renderer) is expected to surface a "already configured" Notice and
 * otherwise no-op (no save, no re-render), per the brief.
 *
 * WP-3: `label` is auto-filled via `deriveModelDisplayLabel` (always onto an empty label here,
 * since the row is brand new — the "only when empty" rule the pick path in `ai.ts` also follows is
 * trivially satisfied by construction). `resolveDescribedPrecision`, when given, is the same
 * best-effort `describeModel()` fallback the re-rendered Accept row in `ai.ts` uses
 * (`describedPrecisionFor`) — passed in rather than called directly so this function stays free of
 * any Obsidian/`CrucibleSettingTab` dependency; only used when the catalog entry itself has no
 * quantization signal, same gating as `deriveCatalogSuggestion` already applies internally.
 */
export function useCatalogEntry(
	provider: Provider,
	entry: ProviderCatalogModel,
	resolveDescribedPrecision?: (model: ProviderModel) => string | undefined,
): UseCatalogEntryResult {
	const models = provider.models ?? (provider.models = []);
	const existing = models.find(m => m.id === entry.id);
	if (existing) return { created: false, model: existing };

	const model: ProviderModel = { id: entry.id, label: "" };
	fillModelLabelIfEmpty(model, entry);
	const probeState = getOrCreateProbeState(model);
	const describedPrecision = entry.quantization === undefined ? resolveDescribedPrecision?.(model) : undefined;
	acceptCatalogSuggestion(model, deriveCatalogSuggestion(entry, describedPrecision), probeState);
	models.push(model);
	return { created: true, model };
}

// ── DOM rendering ────────────────────────────────────────────────────────────────────────────────

export interface ModelCatalogBrowserDeps {
	tab: CrucibleSettingTab;
	provider: Provider;
	catalogModels: ProviderCatalogModel[];
	// WP-3: threaded through to `useCatalogEntry` for the Use button — see that function's doc
	// comment for why this is a plain injected callback rather than an import cycle back to
	// `sections/ai.ts` (the only place `describedPrecisionFor`'s WeakMap-backed cache lives).
	resolveDescribedPrecision: (model: ProviderModel) => string | undefined;
}

interface BrowserSessionState {
	expanded: boolean;
	filter: string;
	bucket: ModelCatalogCapabilityBucket;
	page: number;
}

// Session-only UI state, keyed by the live Provider object — same rationale and lifetime as
// `probeStateByModel`/`probeStatusByProvider` in modelCapabilities.ts: it must survive every
// `tab.display()` re-render the surrounding panel triggers (Accept, Fetch models, Add model, ...)
// but has no reason to persist past this Obsidian session, so it is deliberately not settings.
const sessionStateByProvider = new WeakMap<Provider, BrowserSessionState>();

function getOrCreateSessionState(provider: Provider): BrowserSessionState {
	let state = sessionStateByProvider.get(provider);
	if (!state) {
		state = { expanded: false, filter: "", bucket: "all", page: 1 };
		sessionStateByProvider.set(provider, state);
	}
	return state;
}

/**
 * Renders the browser panel into `container`. Called from `renderProviderModelsList`
 * (`sections/ai.ts`) in place of the old bare status-line paragraph.
 *
 * Two different re-render strategies are used deliberately, not interchangeably:
 *  - Expanding/collapsing the header, and clicking **Use**, go through `tab.display()` (a full
 *    settings-pane re-render) — both change state that other parts of the panel need to reflect
 *    (a newly-created model row appears in the "Models" list above; the collapsed/expanded chevron
 *    is an infrequent click with nothing focused to lose).
 *  - Typing in the filter box, clicking a capability chip, and paging do NOT call `tab.display()`
 *    — they rebuild only the results/pager DOM in place, leaving the filter `<input>` itself
 *    untouched, specifically so typing doesn't lose focus/cursor position on every keystroke the
 *    way a full settings-pane rebuild would.
 */
export function renderModelCatalogBrowser(container: HTMLElement, deps: ModelCatalogBrowserDeps): void {
	const { tab, provider, catalogModels } = deps;
	const status = getProbeStatus(provider);
	const statusText = formatProbeStatusText(status);
	// Nothing fetched this session AND nothing persisted from a prior one — same "show nothing"
	// behaviour the old bare status line had when `catalogStatus.state === 'idle'`.
	if (statusText === "" && catalogModels.length === 0) return;

	const state = getOrCreateSessionState(provider);
	const wrap = container.createDiv({ cls: "crucible-model-catalog-browser" });

	const header = wrap.createDiv({ cls: "crucible-model-catalog-browser-header" });
	const toggle = header.createDiv({ cls: "crucible-model-catalog-browser-toggle" });
	setIcon(toggle, state.expanded ? "chevron-down" : "chevron-right");
	header.createSpan({
		cls: "crucible-model-catalog-browser-status mod-muted",
		text: statusText || `${catalogModels.length} model${catalogModels.length === 1 ? "" : "s"} in catalog.`,
	});
	header.addEventListener("click", () => {
		state.expanded = !state.expanded;
		tab.display();
	});

	if (!state.expanded) return;

	if (catalogModels.length === 0) {
		wrap.createDiv({ cls: "crucible-model-catalog-browser-body" })
			.createDiv({ text: "No models in the catalog yet — use Fetch models above.", cls: "crucible-empty-state" });
		return;
	}

	const body = wrap.createDiv({ cls: "crucible-model-catalog-browser-body" });

	const filterRow = body.createDiv({ cls: "crucible-model-catalog-browser-filter" });
	const filterInput = filterRow.createEl("input", { cls: "pi-width-wide" });
	filterInput.type = "text";
	filterInput.placeholder = "Filter by id or display name…";
	filterInput.value = state.filter;

	const chipsRow = body.createDiv({ cls: "crucible-model-catalog-browser-chips" });
	const resultsEl = body.createDiv({ cls: "crucible-model-catalog-browser-results" });

	const bucketCounts = countModelsByBucket(catalogModels);

	function renderChips(): void {
		chipsRow.empty();
		const buckets: ModelCatalogCapabilityBucket[] = ["all", ...MODEL_CATALOG_CAPABILITY_BUCKET_ORDER];
		for (const bucket of buckets) {
			const count = bucketCounts[bucket];
			if (bucket !== "all" && count === 0) continue;
			const chip = chipsRow.createSpan({
				cls: `crucible-pill crucible-model-catalog-browser-chip ${bucket === state.bucket ? "is-contrast" : "is-muted"}`,
				text: `${MODEL_CATALOG_CAPABILITY_BUCKET_LABELS[bucket]} (${count})`,
			});
			chip.tabIndex = 0;
			chip.setAttribute("role", "button");
			chip.addEventListener("click", () => {
				if (state.bucket === bucket) return;
				state.bucket = bucket;
				state.page = 1;
				renderChips();
				renderResults();
			});
			chip.addEventListener("keydown", evt => {
				if (evt.key !== "Enter" && evt.key !== " ") return;
				evt.preventDefault();
				chip.dispatchEvent(new MouseEvent("click"));
			});
		}
	}

	function renderResults(): void {
		resultsEl.empty();
		const bucketFiltered = filterModelsByBucket(catalogModels, state.bucket);
		const filtered = filterCatalogModelsForQuery(bucketFiltered, state.filter);
		const pageItems = paginateModels(filtered, state.page);
		// `paginateModels` clamps internally; mirror that clamp into session state so Prev/Next
		// (and the counter below) agree with what's actually on screen after a filter shrinks it.
		state.page = clampModelCatalogPage(state.page, filtered.length);

		if (filtered.length === 0) {
			resultsEl.createDiv({ text: "No models match this filter.", cls: "crucible-empty-state" });
			return;
		}

		const list = resultsEl.createDiv({ cls: "crucible-model-catalog-browser-list" });
		pageItems.forEach((entry, idx) => {
			if (idx > 0) list.createEl("hr", { cls: "crucible-row-divider" });
			const row = list.createDiv({ cls: "crucible-model-catalog-browser-row" });
			const main = row.createDiv({ cls: "crucible-model-catalog-browser-row-main" });
			const displayName = catalogEntryDisplayName(entry);
			main.createDiv({ cls: "crucible-model-catalog-browser-row-name", text: displayName });
			if (displayName !== entry.id) {
				main.createDiv({ cls: "crucible-model-catalog-browser-row-id mod-muted", text: entry.id });
			}
			const summary = catalogEntrySummaryTokens(entry).join(" · ");
			if (summary) main.createDiv({ cls: "crucible-model-catalog-browser-row-summary mod-muted", text: summary });

			const useBtn = row.createEl("button", { text: "Use" });
			useBtn.type = "button";
			useBtn.addEventListener("click", () => {
				const result = useCatalogEntry(provider, entry, deps.resolveDescribedPrecision);
				if (!result.created) {
					new Notice(`"${displayName}" is already configured on this provider.`);
					return;
				}
				void tab.plugin.saveSettings().then(() => tab.display());
			});
		});

		const pager = resultsEl.createDiv({ cls: "crucible-model-catalog-browser-pager" });
		const pages = modelCatalogTotalPages(filtered.length);
		const prevBtn = pager.createEl("button", { text: "Previous" });
		prevBtn.type = "button";
		prevBtn.disabled = state.page <= 1;
		prevBtn.addEventListener("click", () => {
			state.page = clampModelCatalogPage(state.page - 1, filtered.length);
			renderResults();
		});
		pager.createSpan({ cls: "crucible-model-catalog-browser-pager-counter mod-muted", text: formatModelCatalogPageCounter(state.page, filtered.length) });
		const nextBtn = pager.createEl("button", { text: "Next" });
		nextBtn.type = "button";
		nextBtn.disabled = state.page >= pages;
		nextBtn.addEventListener("click", () => {
			state.page = clampModelCatalogPage(state.page + 1, filtered.length);
			renderResults();
		});
	}

	filterInput.addEventListener("input", () => {
		state.filter = filterInput.value;
		state.page = 1;
		renderResults();
	});

	renderChips();
	renderResults();
}
