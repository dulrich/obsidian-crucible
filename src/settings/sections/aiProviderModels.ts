/* eslint-disable obsidianmd/ui/sentence-case */
import { Notice, Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { Provider, ProviderCatalogModel, ProviderModel, ProviderModelRef } from "../../types";
import { ProviderModelSuggest } from "../../suggesters";
import { confirmDestructive } from "../destructiveActions";
import { PROVIDER_KIND_LABELS, modelIdPlaceholder } from "../shared";
import {
	acceptCatalogSuggestion,
	applyCatalogPick,
	applyFetchedCatalog,
	CatalogSuggestion,
	catalogEntrySummaryTokens,
	catalogSuggestionHasChanges,
	clearAcceptedMarker,
	clearProviderModelCatalog,
	crossEncoderWarningText,
	deriveCatalogSuggestion,
	getOrCreateProbeState,
	ModelProbeState,
	modelHasCapability,
	probeEmbeddingDimensions,
	resetCatalogField,
	setModelCapability,
	setProbeStatus,
} from "../modelCapabilities";
import { DescribedProbeEntry, ensureDescribedProbe, resolveModelCatalogEntry } from "../providerModelProbe";
import { renderModelCatalogBrowser } from "../modelCatalogBrowser";

/**
 * WP-rem-R4 (F4) — the model-catalog half of the original `sections/ai.ts`: fetch/probe status,
 * the per-model editor row (id, capabilities, embedding fields, notices, Accept), and the inline
 * catalog browser panel underneath. `sections/aiProviders.ts`'s `renderEditProvider` is the only
 * caller.
 *
 * Row rendering is split into `renderModelIdentityFields` / `renderModelCapabilityToggles` /
 * `renderModelEmbeddingFields` / `renderModelNotices` — each a cohesive sub-form the original
 * ~370-line `renderProviderModelsList` inlined as one `forEach` body. The describeModel probe cache
 * and the raw-id/servedModel catalog-entry resolution moved to the dependency-free
 * `providerModelProbe.ts` so they are unit-testable without this file's Obsidian/settings graph.
 */

interface ModelRowNotice {
	text: string;
	variant?: 'info';
}

// The "<Provider kind> reports: ..." provenance line under a surfaced suggestion — D2 rule 2
// ("show it inline as a suggestion with its provenance"). Kept here (not in modelCapabilities.ts)
// because it needs PROVIDER_KIND_LABELS, which is UI copy, not probe logic.
function buildProvenanceText(provider: Provider, entry: ProviderCatalogModel): string {
	const label = PROVIDER_KIND_LABELS[provider.kind] ?? provider.kind;
	const tokens = catalogEntrySummaryTokens(entry);
	return tokens.length > 0 ? `${label} reports: ${tokens.join(', ')}` : `${label} reports this model, but no further metadata.`;
}

// SE-WP-6: names which of the two search `{providerId, modelId}` refs currently point at this
// exact model, so the model-id editor above can warn before a rename orphans one — deliberately
// direct ref equality, not resolveProviderModelRef() (src/search/SearchManager.ts): that function
// answers "does the *saved* ref still resolve", this answers "is the *current* model, before any
// edit, the one a setting is pointing at" — a different question asked at a different time. Scoped
// to search's two refs (the only ones SE-WP-6 covers); agents/chains hold the same
// `{providerId, modelId}` shape and presumably orphan the same way, but fixing those surfaces is
// out of scope here — see the WP-6 report.
function searchRefsPointingAt(tab: CrucibleSettingTab, provider: Provider, model: ProviderModel): string[] {
	const s = tab.plugin.settings;
	const pointsHere = (ref: ProviderModelRef | undefined) => !!ref && ref.providerId === provider.id && ref.modelId === model.id;
	const labels: string[] = [];
	if (pointsHere(s.searchEmbeddingModel)) labels.push('the search embedding model');
	if (pointsHere(s.searchRerankModel)) labels.push('the search reranker model');
	return labels;
}

// WP-8 (D2 amendment — plans/sprint-exit-queue-health-and-scrub.md, "probe-first becomes the
// default"): a provider's model catalog is fetched automatically the first time its Models section
// renders, rather than requiring the user to find the Fetch models button. Session-only (a
// WeakSet, not a counter) and fires at most once per Provider object — a failure (unsupported
// kind, unreachable server) must not retry on every re-render ("no retry loops" per the brief).
// Clear cache re-arms it (see its onClick below) so clearing genuinely starts over. This never
// blocks the current synchronous render: it kicks off the fetch and, once the promise settles
// (success OR failure), triggers exactly one deferred re-render — the same "await the probe before
// re-rendering" discipline the manual Fetch models button already follows.
//
// Background/lazy fetches still never write per D2 — this only ever calls `applyFetchedCatalog`
// (Provider.modelCatalog), the same as a manual Fetch click; nothing here touches a ProviderModel.
const lazyFetchAttempted = new WeakSet<Provider>();

function maybeLazyFetchCatalog(tab: CrucibleSettingTab, provider: Provider): void {
	if (provider.modelCatalog) return;
	if (lazyFetchAttempted.has(provider)) return;
	lazyFetchAttempted.add(provider);
	void (async () => {
		try {
			const fetched = await tab.plugin.providerManager.listModels(provider);
			applyFetchedCatalog(provider, fetched);
			await tab.plugin.saveSettings();
			setProbeStatus(provider, { state: 'ok', count: fetched.length });
		} catch (err) {
			// Never for providers with an unreachable-by-design kind if a guard already exists:
			// listModels() itself throws a precise message for CLI kinds and kinds with no probe
			// client (requireCapability) — this degrades to the same status line the manual Fetch
			// button already shows for that error, not a new failure mode.
			setProbeStatus(provider, { state: 'error', reason: err instanceof Error ? err.message : String(err) });
		}
		tab.display();
	})();
}

// The one call site anywhere in this file that invokes providerManager.describeModel — everything
// else (describedPrecisionFor / describedServedModelFor) reads the shared cache
// `ensureDescribedProbe` keeps, keyed by the live ProviderModel object.
function probeForModel(tab: CrucibleSettingTab, provider: Provider, model: ProviderModel): DescribedProbeEntry | undefined {
	return ensureDescribedProbe(
		model,
		(modelId) => tab.plugin.providerManager.describeModel(provider, modelId),
		() => tab.display(),
	);
}

// WP-3 item 3 / WP-5 (alias-catalog glue): exported so `renderModelCatalogBrowser`'s Use button
// (`modelCatalogBrowser.ts`) can thread the exact same best-effort fallback into `useCatalogEntry`
// — see that function's doc comment for why it takes this as an injected callback rather than
// importing it directly (this file already imports `renderModelCatalogBrowser` from there, and a
// reverse import would be a cycle).
export function describedPrecisionFor(tab: CrucibleSettingTab, provider: Provider, model: ProviderModel): string | undefined {
	const entry = probeForModel(tab, provider, model);
	return entry?.status === 'done' ? entry.precision : undefined;
}

// WP-5 (alias-catalog glue): the canonical id a `describeModel` probe resolved `model.id` to, or
// undefined while the probe is pending/unresolvable. Read on a raw-id catalog miss — a row
// configured with a llama-swap (or similar) alias never matches the catalog by its own id, because
// the catalog enumerates canonical served ids.
function describedServedModelFor(tab: CrucibleSettingTab, provider: Provider, model: ProviderModel): string | undefined {
	const entry = probeForModel(tab, provider, model);
	return entry?.status === 'done' ? entry.servedModel : undefined;
}

export function renderProviderModelsList(tab: CrucibleSettingTab, containerEl: HTMLElement, provider: Provider) {
	new Setting(containerEl).setName('Models').setHeading();
	containerEl.createEl('p', {
		text: 'Configure one or more models. Agents bind to a (provider, model) pair, and chain steps can override via {{model}}. Picking a model from the fetched catalog auto-applies its probed capabilities and metadata — use the undo button next to a probe-applied field, or Accept, for the manual fallback.',
		cls: 'mod-muted',
	});

	maybeLazyFetchCatalog(tab, provider);

	const list = containerEl.createDiv({ cls: 'crucible-settings-group' });
	const models = provider.models ?? (provider.models = []);
	const catalogModels = provider.modelCatalog?.models ?? [];

	if (models.length === 0) {
		list.createDiv({ text: 'No models configured.', cls: 'crucible-empty-state' });
	} else {
		models.forEach((model, modelIndex) => {
			if (modelIndex > 0) list.createEl('hr', { cls: 'crucible-row-divider' });
			renderProviderModelRow(tab, list, provider, models, model, modelIndex, catalogModels);
		});
	}

	new Setting(containerEl)
		.addButton(bt => bt.setButtonText('Add model').onClick(async () => {
			models.push({ id: '', label: '', capabilities: ['chat'] });
			await tab.plugin.saveSettings();
			tab.display();
		}))
		.addButton(bt => bt.setButtonText('Fetch models').setTooltip('Query the provider\'s model-list endpoint. Picking a model from the list applies its probed capabilities and metadata automatically (undo per field below); nothing changes until you pick or Accept.').onClick(async () => {
			bt.setDisabled(true);
			try {
				const fetched = await tab.plugin.providerManager.listModels(provider);
				applyFetchedCatalog(provider, fetched);
				await tab.plugin.saveSettings();
				setProbeStatus(provider, { state: 'ok', count: fetched.length });
			} catch (err) {
				setProbeStatus(provider, { state: 'error', reason: err instanceof Error ? err.message : String(err) });
			}
			// D2: await the probe before re-rendering — a single tab.display() after the promise
			// settles, never one at loading start, so the model list never shows stale results
			// while a fetch is still in flight.
			tab.display();
		}))
		.addButton(bt => bt.setButtonText('Clear cache').setWarning().onClick(async () => {
			clearProviderModelCatalog(provider, (id) => tab.plugin.providerManager.clearModelListCache(id));
			// Re-arm the lazy fetch (WP-8): Clear cache is a deliberate "start over" action, so the
			// next time this section renders it should probe again automatically rather than
			// requiring another manual Fetch models click.
			lazyFetchAttempted.delete(provider);
			setProbeStatus(provider, { state: 'idle' });
			await tab.plugin.saveSettings();
			new Notice('Model list cache cleared');
			tab.display();
		}));

	// WP-1: the inline catalog browser panel replaces the bare status-line paragraph that used to
	// live here — its collapsed header row IS that status line (`formatProbeStatusText`), plus an
	// expand chevron into a filterable, paged view over the fetched catalog.
	renderModelCatalogBrowser(containerEl, {
		tab,
		provider,
		catalogModels,
		resolveDescribedPrecision: (m) => describedPrecisionFor(tab, provider, m),
	});
}

function renderProviderModelRow(
	tab: CrucibleSettingTab,
	list: HTMLElement,
	provider: Provider,
	models: ProviderModel[],
	model: ProviderModel,
	modelIndex: number,
	catalogModels: ProviderCatalogModel[],
): void {
	const modelRow = list.createDiv({ cls: 'crucible-provider-model-row' });
	const probeState = getOrCreateProbeState(model);

	// SE-WP-6: this is the field whose edit caused the 2026-07-25 incident — renaming a
	// model's id here does not rewrite any `{providerId, modelId}` ref that already
	// points at it (search embedding/reranker, and the same shape in agents/chains).
	// Warn *before* the rename, not only after — the settings-render half of this fix
	// (orchestration.ts's dangling-ref inline warning) can only catch it once broken.
	// WP-1: notices for this row (search-refs warning, embedding field detail,
	// cross-encoder warning, probe-suggestion provenance) are collected here and rendered
	// as ONE consolidated block at the bottom of the row, below the fields — see
	// `renderModelNotices`.
	const referencedBy = searchRefsPointingAt(tab, provider, model);
	const noticeEntries: ModelRowNotice[] = [];
	if (referencedBy.length > 0) {
		noticeEntries.push({
			text: `Currently used as ${referencedBy.join(' and ')} (Settings → Orchestrate → Search). Changing this id will orphan that setting until it is re-picked.`,
		});
	}

	renderModelIdentityFields(tab, modelRow, provider, models, model, modelIndex, catalogModels, probeState);
	renderModelCapabilityToggles(tab, modelRow, model, probeState);

	// WP-1: gated on the Embedding capability (mirroring the Probe button's existing gate
	// below) — the Rerank toggle above stays unconditional. The Embedding toggle's onChange
	// re-renders the tab, so these fields appear/disappear live as the capability changes.
	if (modelHasCapability(model, 'embedding')) {
		renderModelEmbeddingFields(tab, modelRow, provider, model, probeState, noticeEntries);
	}

	renderModelNotices(tab, modelRow, provider, model, catalogModels, probeState, noticeEntries);
}

function renderModelIdentityFields(
	tab: CrucibleSettingTab,
	modelRow: HTMLElement,
	provider: Provider,
	models: ProviderModel[],
	model: ProviderModel,
	modelIndex: number,
	catalogModels: ProviderCatalogModel[],
	probeState: ModelProbeState,
): void {
	new Setting(modelRow)
		.setName('Model')
		.addText(t => {
			t.setPlaceholder(modelIdPlaceholder(provider.kind))
				.setValue(model.id)
				.onChange(async (v) => { model.id = v; await tab.plugin.saveSettings(); })
				.inputEl.addClass('pi-width-normal');
			// WP-8 (D2 amendment): an explicit pick from the fetched catalog auto-applies
			// the probed values through the SAME acceptCatalogSuggestion path the Accept
			// button below uses — the per-field "probe-accepted" badge + its Reset button
			// is therefore already the undo affordance, with no separate mechanism to
			// build. This does not weaken D2: free typing and the lazy/background fetch
			// above still never write anything to a ProviderModel — only an explicit
			// suggest pick, which is exactly as deliberate an action as clicking Accept.
			//
			// Deferred to a macrotask: selectSuggestion() still needs to close its own
			// popup after this callback returns, and a synchronous tab.display() here
			// would tear down the settings pane's DOM (this input included) out from
			// under that close() call.
			new ProviderModelSuggest(tab.app, t.inputEl, () => catalogModels, (entry) => {
				// WP-3 item 1: the pick path now passes the same session-cached
				// describedPrecision fallback the re-rendered Accept row below already
				// does (same `quantization === undefined` gate) — before this fix only
				// the Accept row got the benefit of a describeModel()-probed precision;
				// an explicit pick from the type-ahead silently skipped it.
				const fallbackPrecision = entry.quantization === undefined
					? describedPrecisionFor(tab, provider, model)
					: undefined;
				applyCatalogPick(model, entry, deriveCatalogSuggestion(entry, fallbackPrecision), probeState);
				setTimeout(() => {
					void tab.plugin.saveSettings();
					tab.display();
				}, 0);
			});
		})
		.addText(t => t
			.setPlaceholder('Display label (optional)')
			.setValue(model.label)
			.onChange(async (v) => { model.label = v; await tab.plugin.saveSettings(); })
			.inputEl.addClass('pi-width-normal'))
		.addExtraButton(cb => cb.setIcon('x').setTooltip('Remove model').onClick(async () => {
			if (!(await confirmDestructive(tab.app, tab.plugin.settings, 'provider-model-delete', {
				message: `Delete model "${model.label || model.id || '(unnamed)'}" from provider "${provider.name || '(unnamed)'}"?`,
			}))) return;
			models.splice(modelIndex, 1);
			await tab.plugin.saveSettings();
			tab.display();
		}));
}

function renderModelCapabilityToggles(tab: CrucibleSettingTab, modelRow: HTMLElement, model: ProviderModel, probeState: ModelProbeState): void {
	const capabilities = new Setting(modelRow)
		.setName('Capabilities');
	if (probeState.accepted.capabilities) {
		capabilities.nameEl.createSpan({ cls: 'crucible-probe-accepted-badge', text: 'probe-accepted' });
		capabilities.addExtraButton(cb => cb.setIcon('undo-2').setTooltip('Reset to your entered value').onClick(async () => {
			resetCatalogField(model, 'capabilities', probeState);
			await tab.plugin.saveSettings();
			tab.display();
		}));
	}
	capabilities.controlEl.createSpan({ cls: 'crucible-inline-control-label', text: 'Chat' });
	capabilities
		.addToggle(t => t
			.setTooltip('Chat model')
			.setValue(modelHasCapability(model, 'chat'))
			.onChange(async (v) => { setModelCapability(model, 'chat', v); clearAcceptedMarker(probeState, 'capabilities'); await tab.plugin.saveSettings(); }));
	capabilities.controlEl.createSpan({ cls: 'crucible-inline-control-label', text: 'Embedding' });
	capabilities
		.addToggle(t => t
			.setTooltip('Embedding model')
			.setValue(modelHasCapability(model, 'embedding'))
			.onChange(async (v) => {
				setModelCapability(model, 'embedding', v);
				clearAcceptedMarker(probeState, 'capabilities');
				await tab.plugin.saveSettings();
				// WP-1: the Embedding dimensions / Embedding precision fields below are
				// gated on this capability — re-render so they appear/disappear live,
				// matching how the rest of the tab re-renders on a state change.
				tab.display();
			}));
	capabilities.controlEl.createSpan({ cls: 'crucible-inline-control-label', text: 'Image' });
	capabilities
		.addToggle(t => t
			.setTooltip('Image extraction model')
			.setValue(modelHasCapability(model, 'image-extraction'))
			.onChange(async (v) => { setModelCapability(model, 'image-extraction', v); clearAcceptedMarker(probeState, 'capabilities'); await tab.plugin.saveSettings(); }));
	capabilities.controlEl.createSpan({ cls: 'crucible-inline-control-label', text: 'Rerank' });
	capabilities
		.addToggle(t => t
			.setTooltip('Reranker model — a cross-encoder scoring (query, document) pairs, e.g. bge-reranker-v2-m3. Not an embedding model.')
			.setValue(modelHasCapability(model, 'rerank'))
			.onChange(async (v) => { setModelCapability(model, 'rerank', v); clearAcceptedMarker(probeState, 'capabilities'); await tab.plugin.saveSettings(); }));
}

function renderModelEmbeddingFields(
	tab: CrucibleSettingTab,
	modelRow: HTMLElement,
	provider: Provider,
	model: ProviderModel,
	probeState: ModelProbeState,
	noticeEntries: ModelRowNotice[],
): void {
	const dimsSetting = new Setting(modelRow)
		.setName('Embedding dimensions')
		.setDesc('Optional but recommended — validates embedding sub-batches early; see the notice below.');
	if (probeState.accepted.embeddingDimensions) {
		dimsSetting.nameEl.createSpan({ cls: 'crucible-probe-accepted-badge', text: 'probe-accepted' });
		dimsSetting.addExtraButton(cb => cb.setIcon('undo-2').setTooltip('Reset to your entered value').onClick(async () => {
			resetCatalogField(model, 'embeddingDimensions', probeState);
			await tab.plugin.saveSettings();
			tab.display();
		}));
	}
	dimsSetting.addText(t => {
		t.setPlaceholder('Dims')
			.setValue(model.embeddingDimensions ? String(model.embeddingDimensions) : '')
			.onChange(async (v) => {
				const n = Number(v.trim());
				if (Number.isFinite(n) && n > 0) model.embeddingDimensions = Math.floor(n);
				else delete model.embeddingDimensions;
				clearAcceptedMarker(probeState, 'embeddingDimensions');
				await tab.plugin.saveSettings();
			});
		t.inputEl.type = 'number';
		t.inputEl.min = '1';
		t.inputEl.step = '1';
		t.inputEl.addClass('pi-width-half');
	});

	// WP-3 item 3: an explicit, never-automatic one-shot embed() call — shown only where
	// it's actually useful (no width recorded yet; the embedding-capability half of the
	// gate is now the enclosing `if` in the caller). Writes through the SAME accepted-marker
	// path as every other probed field (probeEmbeddingDimensions calls
	// acceptCatalogSuggestion internally), so the badge + Reset control above already
	// covers undo; no separate mechanism needed.
	if (!model.embeddingDimensions) {
		dimsSetting.addButton(bt => bt
			.setButtonText('Probe dimensions')
			.setTooltip('Calls this model once with a short test input and reads back the vector length. A local model that needs to load first can take seconds to minutes.')
			.onClick(async () => {
				if (!model.id) {
					new Notice('Set a model id before probing dimensions.');
					return;
				}
				bt.setDisabled(true);
				bt.setButtonText('Probing…');
				new Notice('Probing embedding dimensions — a local model may need to load first, which can take a while.');
				try {
					await probeEmbeddingDimensions(
						(inputs) => tab.plugin.providerManager.embed(provider, model.id, inputs),
						model,
						probeState,
					);
					await tab.plugin.saveSettings();
					tab.display();
				} catch (err) {
					new Notice(`Could not probe embedding dimensions: ${err instanceof Error ? err.message : String(err)}`);
					bt.setButtonText('Probe dimensions');
					bt.setDisabled(false);
				}
			}));
	}

	const variantSetting = new Setting(modelRow)
		.setName('Embedding precision (fallback)')
		.setDesc('Optional — only needed if the server can\'t report precision itself; see the notice below.');
	if (probeState.accepted.embeddingVariant) {
		variantSetting.nameEl.createSpan({ cls: 'crucible-probe-accepted-badge', text: 'probe-accepted' });
		variantSetting.addExtraButton(cb => cb.setIcon('undo-2').setTooltip('Reset to your entered value').onClick(async () => {
			resetCatalogField(model, 'embeddingVariant', probeState);
			await tab.plugin.saveSettings();
			tab.display();
		}));
	}
	variantSetting.addText(t => {
		t.setPlaceholder('e.g. f16, fp32, q4_k_m')
			.setValue(model.embeddingVariant ?? '')
			.onChange(async (v) => {
				const trimmed = v.trim();
				if (trimmed) model.embeddingVariant = trimmed;
				else delete model.embeddingVariant;
				clearAcceptedMarker(probeState, 'embeddingVariant');
				await tab.plugin.saveSettings();
			});
		t.inputEl.addClass('pi-width-half');
	});

	// WP-5 (portable space keys): a plain manual override, not a probed field — nothing
	// ever writes it except the user typing here or the path-shaped auto-prefill on a
	// catalog pick (see the ProviderModelSuggest onChoose in renderModelIdentityFields), so
	// unlike embeddingDimensions/embeddingVariant this row carries no probe-accepted badge.
	new Setting(modelRow)
		.setName('Embedding space id (advanced override)')
		.setDesc('Optional — only needed when the model id above is a filesystem path; see the notice below.')
		.addText(t => {
			t.setPlaceholder('e.g. bge-m3-f16')
				.setValue(model.embeddingSpaceId ?? '')
				.onChange(async (v) => {
					const trimmed = v.trim();
					if (trimmed) model.embeddingSpaceId = trimmed;
					else delete model.embeddingSpaceId;
					await tab.plugin.saveSettings();
				});
			t.inputEl.addClass('pi-width-half');
		});

	// WP-1: the detail trimmed off the two setDescs above folds into the consolidated
	// notices block below rather than disappearing.
	noticeEntries.push({
		text: 'Embedding dimensions: indexing checks every sub-batch against it and stops on a mismatch, so a wrong-width model fails after ≤96 texts instead of after a whole flush has been embedded.',
		variant: 'info',
	});
	noticeEntries.push({
		text: 'Embedding precision (fallback): Crucible asks the server first, and a reported value always wins. The same weights at a different precision are a different vector space, so setting this when it matters (e.g. f16 vs fp32) keeps the two from being mixed. Leave empty unless you know: changing it re-embeds the vault.',
		variant: 'info',
	});
	noticeEntries.push({
		text: 'Embedding space id (advanced override): the model id above is what Crucible sends the server, but a mount-path or host-specific id (e.g. a llama.cpp container\'s /models/.../bge-m3-f16.gguf) makes a poor vector-space key — moving the mount would look like a different model and force a full re-embed. Set this to the portable identity the space should be keyed on instead; picking a path-shaped id from the catalog above prefills it automatically. Leave empty unless the model id is a path.',
		variant: 'info',
	});
}

function renderModelNotices(
	tab: CrucibleSettingTab,
	modelRow: HTMLElement,
	provider: Provider,
	model: ProviderModel,
	catalogModels: ProviderCatalogModel[],
	probeState: ModelProbeState,
	noticeEntries: ModelRowNotice[],
): void {
	// D2 rule 2 (Surface): only rendered when the current id matches a fetched catalog
	// entry. Nothing here writes to `model` — the Accept button below is the only control
	// in this row that does.
	//
	// WP-5 (alias-catalog glue): a raw-id match always wins, but a row configured with a
	// llama-swap (or similar) alias — `bge-m3`, say — never matches a catalog that
	// enumerates canonical served ids (`bge-m3-f16`), so the Accept row silently never
	// appeared even though the model was correctly identified. On a raw-id miss, fall back
	// to the canonical id `describedServedModelFor`'s probe resolved (only calling it once
	// the exact match is known to have failed, so a normally-configured row never triggers
	// an extra probe).
	const rawCatalogMatch = catalogModels.find(m => m.id === model.id);
	const catalogEntry = rawCatalogMatch ?? (model.id && catalogModels.length > 0
		? resolveModelCatalogEntry(model.id, catalogModels, describedServedModelFor(tab, provider, model))
		: undefined);
	let suggestion: CatalogSuggestion | undefined;
	if (catalogEntry) {
		const warning = crossEncoderWarningText(catalogEntry);
		if (warning) noticeEntries.push({ text: warning });

		// WP-8: when the catalog entry itself has no quantization signal (OpenRouter, plain
		// OpenAI, Infinity, or a bare-`/models` local server), a best-effort describeModel()
		// probe may still surface a normalized precision. Fires at most once per model row
		// per session and never blocks this render — see describedPrecisionFor's own doc
		// comment.
		const fallbackPrecision = catalogEntry.quantization === undefined
			? describedPrecisionFor(tab, provider, model)
			: undefined;
		const derivedSuggestion = deriveCatalogSuggestion(catalogEntry, fallbackPrecision);
		if (catalogSuggestionHasChanges(model, derivedSuggestion)) suggestion = derivedSuggestion;
	}

	// WP-1: ONE consolidated notices block at the bottom of the row, below the fields and
	// above the (provider-level) catalog browser — the search-refs rename warning, the
	// embedding-field detail folded out of the setDesc text above, the cross-encoder
	// warning, and the probe-suggestion provenance (with its still-functional Accept CTA)
	// all land here instead of being interleaved through the row. Each is pushed onto
	// `noticeEntries` (or `suggestion`) at most once above, so each renders at most once.
	if (noticeEntries.length > 0 || suggestion) {
		const notices = modelRow.createDiv({ cls: 'crucible-model-notices' });
		for (const entry of noticeEntries) {
			notices.createDiv({
				cls: entry.variant === 'info' ? 'crucible-inline-warning is-info' : 'crucible-inline-warning',
				text: entry.text,
			});
		}
		if (suggestion && catalogEntry) {
			const acceptedSuggestion = suggestion;
			const suggestionNotice = new Setting(notices)
				.setDesc(buildProvenanceText(provider, catalogEntry))
				.addButton(bt => bt.setButtonText('Accept').setCta().onClick(async () => {
					acceptCatalogSuggestion(model, acceptedSuggestion, probeState);
					await tab.plugin.saveSettings();
					tab.display();
				}));
			suggestionNotice.settingEl.addClass('crucible-inline-warning', 'is-info');
		}
	}
}
