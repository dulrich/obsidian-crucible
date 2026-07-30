/* eslint-disable obsidianmd/ui/sentence-case */
import { Notice, Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { Agent, AgentBindingMode, AgentExecutionMode, AgentPromptSource, Provider, ProviderCatalogModel, ProviderKind, ProviderModel, ProviderModelRef, providerModality } from "../../types";
import { agentCommandId } from "../../agents";
import { CLI_DEFAULT_TIMEOUT_SECONDS, providerSecretKey, resolveProviderConcurrencyLimit } from "../../providers";
import { FileSuggest, FolderSuggest, ProviderModelSuggest } from "../../suggesters";
import { confirmDestructive } from "../destructiveActions";
import {
	PROVIDER_KIND_LABELS,
	SearchWithContainer,
	TemplateVariableInfo,
	collectAllRefs,
	defaultCliCommand,
	modelIdPlaceholder,
	mountSecretControl,
	sortByNameWithEmptyLast,
} from "../shared";
import { bindText, bindToggle, bindDropdown, bindSearch } from "../bind";
import {
	acceptCatalogSuggestion,
	applyFetchedCatalog,
	CatalogSuggestion,
	catalogEntrySummaryTokens,
	catalogSuggestionHasChanges,
	clearAcceptedMarker,
	clearProviderModelCatalog,
	crossEncoderWarningText,
	deriveCatalogSuggestion,
	fillModelLabelIfEmpty,
	getOrCreateProbeState,
	modelHasCapability,
	probeEmbeddingDimensions,
	providerHasChatCapableModel,
	resetCatalogField,
	setModelCapability,
	setProbeStatus,
} from "../modelCapabilities";
import { renderModelCatalogBrowser } from "../modelCatalogBrowser";
import { deriveEmbeddingSpaceIdPrefill } from "../../search/types";
import { providerRefsPointingAt } from "../providerRefs";

export function renderAiSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	if (tab.editingProviderIndex !== -1) {
		const provider = tab.plugin.settings.providers[tab.editingProviderIndex];
		if (provider) {
			new Setting(containerEl).setName('Edit Provider').setHeading();
			const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
			renderEditProvider(tab, group, provider, tab.editingProviderIndex);
			return;
		}
		tab.editingProviderIndex = -1;
	}

	if (tab.editingAgentIndex !== -1) {
		const agent = tab.plugin.settings.agents[tab.editingAgentIndex];
		if (agent) {
			new Setting(containerEl).setName('Edit Agent').setHeading();
			const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
			renderEditAgent(tab, group, agent, tab.editingAgentIndex);
			return;
		}
		tab.editingAgentIndex = -1;
	}

	renderProviderListSection(tab, containerEl);
	renderAgentListSection(tab, containerEl);
}

function renderProviderListSection(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	new Setting(containerEl).setName('Providers').setHeading();
	containerEl.createEl('p', { text: 'Configure LLM connections and models. Agents reference providers when they run.' });

	const group = containerEl.createDiv({ cls: 'crucible-settings-group' });

	if (tab.plugin.settings.providers.length === 0) {
		group.createDiv({ text: 'No providers configured.', cls: 'crucible-empty-state' });
	} else {
		sortByNameWithEmptyLast(tab.plugin.settings.providers, p => p.name).forEach(({ item: provider, index }, displayIdx) => {
			if (displayIdx > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(group)
				.setName(provider.name || '(unnamed)')
				.setDesc(describeProvider(provider))
				.addExtraButton(cb => cb.setIcon('pencil').setTooltip('Edit provider').onClick(() => {
					tab.editingProviderIndex = index;
					tab.display();
				}))
				.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete provider').onClick(async () => {
					await deleteProvider(tab, index);
				}));
		});
	}

	new Setting(containerEl).addButton(bt => bt.setButtonText('Add provider').setCta().onClick(async () => {
		const id = Math.random().toString(36).substring(2, 9);
		tab.plugin.settings.providers.push({ id, name: '', kind: 'openai', models: [] });
		await tab.plugin.saveSettings();
		tab.editingProviderIndex = tab.plugin.settings.providers.length - 1;
		tab.display();
	}));
}

function describeProvider(provider: Provider): string {
	const kindLabel = PROVIDER_KIND_LABELS[provider.kind] ?? provider.kind;
	const count = provider.models?.length ?? 0;
	const summary = count === 0 ? 'no models' : count === 1 ? '1 model' : `${count} models`;
	return `${kindLabel} · ${summary}`;
}

// idh-WP-2: deleting a provider destroys its stored API key unconditionally and can orphan up to
// five other settings surfaces (search embedding/rerank, image description, agent bindings, chain
// step overrides) — this always confirms, with an in-use summary built from
// `providerRefsPointingAt` when the provider is referenced anywhere, or a simpler API-key-only
// warning when it is not (deleting the key alone still warrants a confirm).
async function deleteProvider(tab: CrucibleSettingTab, index: number) {
	const provider = tab.plugin.settings.providers[index];
	if (!provider) return;

	const providerLabel = provider.name || '(unnamed)';
	const refs = providerRefsPointingAt(tab.plugin.settings, provider);
	const message = refs.length > 0
		? `Its stored API key is deleted with it. This cannot be undone.`
		: `This provider is not currently used by search, agents, or chain steps. Its stored API key is deleted with it. This cannot be undone.`;
	const impact = refs.length > 0 ? [`Used by: ${refs.join(', ')}.`] : undefined;
	if (!(await confirmDestructive(tab.app, tab.plugin.settings, 'provider-delete', {
		title: `Delete provider "${providerLabel}"?`,
		message,
		impact,
	}))) return;

	tab.plugin.settings.providers.splice(index, 1);
	tab.editingProviderIndex = -1;
	await tab.plugin.saveSettings();
	await tab.plugin.providerManager.deleteApiKey(provider.id);
	// Belt-and-suspenders alongside deleteApiKey's own clear->forget: deleteApiKey no-ops the
	// forget half when app.secretStorage is unavailable (see SecretRegistry.clear), which would
	// otherwise leave this provider's key registered forever with nothing left to warn about.
	await tab.plugin.secretRegistry.forget(providerSecretKey(provider.id));
	tab.plugin.registerAgents();
	tab.display();
}

function renderEditProvider(tab: CrucibleSettingTab, containerEl: HTMLElement, provider: Provider, index: number) {
	const save = () => tab.plugin.saveSettings();

	new Setting(containerEl)
		.setName(`Provider: ${provider.name || '(unnamed)'}`)
		.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete provider').onClick(async () => {
			await deleteProvider(tab, index);
		}));

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	bindText(containerEl, {
		name: 'Name',
		placeholder: 'e.g. OpenRouter',
		get: () => provider.name,
		set: (v) => { provider.name = v; },
	}, save);

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	bindDropdown(containerEl, {
		name: 'Kind',
		desc: 'Determines how this provider is invoked. API kinds use HTTP; CLI kinds spawn a local command.',
		options: PROVIDER_KIND_LABELS,
		get: () => provider.kind,
		set: (v) => { provider.kind = v as ProviderKind; },
		after: () => tab.display(),
	}, save);

	const modality = providerModality(provider.kind);

	if (modality === 'api') {
		if (provider.kind === 'ollama') {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			bindText(containerEl, {
				name: 'Ollama URL',
				desc: 'Default is http://localhost:11434',
				placeholder: 'http://localhost:11434',
				get: () => provider.baseUrl || '',
				set: (v) => { provider.baseUrl = v; },
			}, save);
		} else if (provider.kind === 'openai-compatible') {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			bindText(containerEl, {
				name: 'Server URL',
				desc: 'OpenAI-compatible base URL, including the API path. For LM Studio use http://localhost:1234/v1',
				placeholder: 'http://localhost:1234/v1',
				get: () => provider.baseUrl || '',
				set: (v) => { provider.baseUrl = v; },
			}, save);

			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			mountProviderApiKeyControl(tab, containerEl, provider, {
				name: 'API Key (optional)',
				desc: 'Only required by servers configured with an API key (e.g. vLLM --api-key). Stored securely in Obsidian Secret Storage.',
			});
		} else {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			mountProviderApiKeyControl(tab, containerEl, provider, {
				name: 'API Key',
				desc: 'Stored securely in Obsidian Secret Storage.',
			});
		}
	} else {
		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		bindText(containerEl, {
			name: 'Command',
			desc: `Path or name of the executable. Leave blank to use the default for this kind.`,
			placeholder: defaultCliCommand(provider.kind),
			get: () => provider.command || '',
			set: (v) => { provider.command = v; },
		}, save);

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		bindText(containerEl, {
			name: 'Extra arguments',
			desc: 'Optional. Whitespace-separated arguments to pass before the prompt. Quotes are respected.',
			placeholder: '--no-color',
			width: 'pi-width-wide',
			get: () => provider.extraArgs || '',
			set: (v) => { provider.extraArgs = v; },
		}, save);

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		bindText(containerEl, {
			name: 'Working directory',
			desc: 'Optional. Vault-relative or absolute path. Leave blank for the process default.',
			placeholder: '/absolute/path',
			width: 'pi-width-wide',
			get: () => provider.cwd || '',
			set: (v) => { provider.cwd = v; },
		}, save);

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(containerEl)
			.setName('Timeout seconds')
			.setDesc(`Blank uses the default ${CLI_DEFAULT_TIMEOUT_SECONDS}s. Use 600 for long transcript workflows.`)
			.addText(t => {
				t.setPlaceholder(String(CLI_DEFAULT_TIMEOUT_SECONDS))
					.setValue(provider.timeoutSeconds ? String(provider.timeoutSeconds) : '')
					.onChange(async (v) => {
						const trimmed = v.trim();
						if (!trimmed) {
							delete provider.timeoutSeconds;
							await save();
							return;
						}

						const seconds = Number(trimmed);
						if (Number.isFinite(seconds) && seconds > 0) {
							provider.timeoutSeconds = Math.ceil(seconds);
							await save();
						}
					});
				t.inputEl.type = 'number';
				t.inputEl.min = '1';
				t.inputEl.step = '1';
				t.inputEl.addClass('pi-width-half');
			});

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		bindToggle(containerEl, {
			name: 'Capture run artifacts',
			desc: 'Per run, write task.md, system.md, invocation.json, response.md, progress.log to the run directory.',
			get: () => provider.cliRunArtifactsEnabled !== false,
			set: (v) => { provider.cliRunArtifactsEnabled = v; },
			after: () => tab.display(),
		}, save);

		if (provider.cliRunArtifactsEnabled !== false) {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			bindSearch(containerEl, {
				name: 'Run directory',
				desc: 'Vault-relative folder. Each run lands in <dir>/<timestamp>-<agent>/. latest.log is updated for tailing.',
				placeholder: '_crucible/cli-runs',
				width: 'pi-width-wide',
				get: () => provider.cliRunDirectory || '',
				set: (v) => { provider.cliRunDirectory = v.trim(); },
				suggest: (el) => { new FolderSuggest(tab.app, el); },
			}, save);
		}
	}

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });
	renderMaxConcurrentRequestsSetting(containerEl, provider, save);

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });
	renderProviderModelsList(tab, containerEl, provider);
}

// rsp-wp1: caps in-flight completion-class requests (chat, image description — not embed/rerank)
// for this provider, gated in ProviderManager (src/providers.ts). Blank keeps the default:
// resolveProviderConcurrencyLimit(provider) with maxConcurrentRequests cleared shows what that
// default actually resolves to for this provider's kind, rather than a hardcoded "1 or
// unlimited" guess drifting from the real resolution logic.
function renderMaxConcurrentRequestsSetting(containerEl: HTMLElement, provider: Provider, save: () => Promise<void>) {
	const defaultLimit = resolveProviderConcurrencyLimit({ ...provider, maxConcurrentRequests: undefined });
	const defaultLabel = Number.isFinite(defaultLimit) ? String(defaultLimit) : 'Unlimited';
	new Setting(containerEl)
		.setName('Max concurrent requests')
		.setDesc(
			`Blank uses the default (currently ${defaultLabel} for this provider): local providers `
			+ '(openai-compatible) default to 1 — a single-GPU local model gains no throughput from '
			+ 'concurrency, and extra in-flight requests just push each other\'s wall-clock time past '
			+ 'the timeout — while cloud providers default to unlimited. Applies to completion-class '
			+ 'requests only (chat, image description); embeddings and reranking are never limited.',
		)
		.addText(t => {
			t.setPlaceholder(defaultLabel)
				.setValue(provider.maxConcurrentRequests ? String(provider.maxConcurrentRequests) : '')
				.onChange(async (v) => {
					const trimmed = v.trim();
					if (!trimmed) {
						delete provider.maxConcurrentRequests;
						await save();
						return;
					}
					const n = Number(trimmed);
					if (Number.isFinite(n) && n > 0) {
						provider.maxConcurrentRequests = Math.floor(n);
						await save();
					}
				});
			t.inputEl.type = 'number';
			t.inputEl.min = '1';
			t.inputEl.step = '1';
			t.inputEl.addClass('pi-width-half');
		});
}

// The provider API-key control is identical for every kind that has one (only the
// name/desc differ between "required" and "optional" kinds) — one mount point instead
// of two verbatim copies.
function mountProviderApiKeyControl(tab: CrucibleSettingTab, containerEl: HTMLElement, provider: Provider, label: { name: string; desc: string }) {
	const apiKeySetting = new Setting(containerEl).setName(label.name).setDesc(label.desc);
	mountSecretControl(apiKeySetting, {
		load: () => tab.plugin.providerManager.loadApiKey(provider.id),
		store: (v) => tab.plugin.providerManager.storeApiKey(provider.id, v),
		clear: () => tab.plugin.providerManager.deleteApiKey(provider.id),
		expectedButMissing: () => tab.plugin.secretRegistry.isRegistered(providerSecretKey(provider.id)),
		confirm: {
			app: tab.app,
			settings: tab.plugin.settings,
			message: `Clear the stored API key for provider "${provider.name || '(unnamed)'}"? Anything using this provider will fail until a new key is set.`,
		},
	});
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

// WP-8 scope item 3: a best-effort per-model precision fallback for the embeddingVariant
// suggestion, used only when the catalog entry itself has no quantization signal (OpenRouter,
// plain OpenAI, Infinity, or a bare-`/models` local server). `ProviderManager.describeModel` is
// already session-cached per (provider, modelId), so repeated renders cost nothing once resolved —
// this WeakMap exists only to read that result *synchronously* during a render (describeModel is
// async; a render is not) and to guarantee the probe is kicked off at most once per model row.
// `status: 'pending'` and a resolved `precision: undefined` are deliberately distinct from "never
// asked" (`describedProbeByModel.get(model)` returning `undefined`) — seeing "no precision"
// once is enough; it must not re-probe every render.
//
// WP-5 (alias-catalog glue): the same probe response also carries `servedModel` — the canonical
// id the server actually resolved (e.g. a llama-swap alias `bge-m3` probed and answered as
// `bge-m3-f16`). It rides along on this one entry rather than a second WeakMap so a row that
// already triggered the precision fallback probe gets the alias-match benefit for free, with no
// second network round trip.
interface DescribedProbeEntry {
	status: 'pending' | 'done';
	precision?: string;
	servedModel?: string;
}
const describedProbeByModel = new WeakMap<ProviderModel, DescribedProbeEntry>();

// Kicks off (or reads back) the one `describeModel` probe both `describedPrecisionFor` and
// `describedServedModelFor` read from. Returns the in-flight/settled entry, or `undefined` when
// there is nothing to probe (`model.id` empty) — callers derive their own field from it rather
// than duplicating the pending/done bookkeeping.
function ensureDescribedProbe(tab: CrucibleSettingTab, provider: Provider, model: ProviderModel): DescribedProbeEntry | undefined {
	const existing = describedProbeByModel.get(model);
	if (existing) return existing;
	if (!model.id) return undefined;

	describedProbeByModel.set(model, { status: 'pending' });
	void tab.plugin.providerManager.describeModel(provider, model.id)
		.then((description) => {
			describedProbeByModel.set(model, { status: 'done', precision: description.precision, servedModel: description.servedModel });
			// Only worth a re-render if the probe actually found something to suggest — degrade
			// silently otherwise, same as a rejection below (unsupported kind, unreachable server).
			if (description.precision !== undefined || description.servedModel !== undefined) tab.display();
		})
		.catch(() => {
			describedProbeByModel.set(model, { status: 'done', precision: undefined, servedModel: undefined });
		});
	return undefined;
}

// WP-3: exported so `renderModelCatalogBrowser`'s Use button (`modelCatalogBrowser.ts`) can thread
// the exact same best-effort fallback into `useCatalogEntry` — see that function's doc comment for
// why it takes this as an injected callback rather than importing it directly (this file already
// imports `renderModelCatalogBrowser` from there, and a reverse import would be a cycle).
export function describedPrecisionFor(tab: CrucibleSettingTab, provider: Provider, model: ProviderModel): string | undefined {
	const entry = ensureDescribedProbe(tab, provider, model);
	return entry?.status === 'done' ? entry.precision : undefined;
}

// WP-5 (alias-catalog glue): the canonical id a `describeModel` probe resolved `model.id` to, or
// undefined while the probe is pending/unresolvable. Read by `resolveModelCatalogEntry` on a
// raw-id catalog miss — a row configured with a llama-swap (or similar) alias never matches the
// catalog by its own id, because the catalog enumerates canonical served ids.
export function describedServedModelFor(tab: CrucibleSettingTab, provider: Provider, model: ProviderModel): string | undefined {
	const entry = ensureDescribedProbe(tab, provider, model);
	return entry?.status === 'done' ? entry.servedModel : undefined;
}

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

function renderProviderModelsList(tab: CrucibleSettingTab, containerEl: HTMLElement, provider: Provider) {
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
			const modelRow = list.createDiv({ cls: 'crucible-provider-model-row' });
			const probeState = getOrCreateProbeState(model);

			// SE-WP-6: this is the field whose edit caused the 2026-07-25 incident — renaming a
			// model's id here does not rewrite any `{providerId, modelId}` ref that already
			// points at it (search embedding/reranker, and the same shape in agents/chains).
			// Warn *before* the rename, not only after — the settings-render half of this fix
			// (orchestration.ts's dangling-ref inline warning) can only catch it once broken.
			// WP-1: notices for this row (search-refs warning, embedding field detail,
			// cross-encoder warning, probe-suggestion provenance) are collected here and rendered
			// as ONE consolidated block at the bottom of the row, below the fields — see the
			// `crucible-model-notices` container built after the catalog-entry checks below.
			const referencedBy = searchRefsPointingAt(tab, provider, model);
			const noticeEntries: { text: string; variant?: 'info' }[] = [];
			if (referencedBy.length > 0) {
				noticeEntries.push({
					text: `Currently used as ${referencedBy.join(' and ')} (Settings → Orchestrate → Search). Changing this id will orphan that setting until it is re-picked.`,
				});
			}

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
						acceptCatalogSuggestion(model, deriveCatalogSuggestion(entry, fallbackPrecision), probeState);
						// WP-3 item 2 (auto-alias): only when the label is still empty — a value
						// the user already typed always wins, pick or no pick.
						fillModelLabelIfEmpty(model, entry);
						// WP-5 (portable space keys): when the picked served id is path-shaped (a
						// container mount point), prefill the portable override rather than letting
						// that path silently become the vector-space key — see
						// `deriveEmbeddingSpaceIdPrefill`'s doc comment. Never overwrites a value
						// already present.
						const spaceIdPrefill = deriveEmbeddingSpaceIdPrefill(entry.id, model.embeddingSpaceId);
						if (spaceIdPrefill) model.embeddingSpaceId = spaceIdPrefill;
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
				.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove model').onClick(async () => {
					if (!(await confirmDestructive(tab.app, tab.plugin.settings, 'provider-model-delete', {
						message: `Delete model "${model.label || model.id || '(unnamed)'}" from provider "${provider.name || '(unnamed)'}"?`,
					}))) return;
					models.splice(modelIndex, 1);
					await tab.plugin.saveSettings();
					tab.display();
				}));

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

			// WP-1: gated on the Embedding capability (mirroring the Probe button's existing gate
			// below) — the Rerank toggle above stays unconditional. The Embedding toggle's onChange
			// re-renders the tab, so these fields appear/disappear live as the capability changes.
			if (modelHasCapability(model, 'embedding')) {
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
				// gate is now the enclosing `if` above). Writes through the SAME accepted-marker
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
				// catalog pick (see the ProviderModelSuggest onChoose above), so unlike
				// embeddingDimensions/embeddingVariant this row carries no probe-accepted badge.
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

			// D2 rule 2 (Surface): only rendered when the current id matches a fetched catalog
			// entry. Nothing here writes to `model` — the Accept button in the notices block below
			// is the only control in this row that does.
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

function renderAgentListSection(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	new Setting(containerEl).setName('Agents').setHeading();
	containerEl.createEl('p', { text: 'An Agent binds a Provider to a system prompt and a user-prompt template. Each Agent is registered as an internal command so it can be used as a step in a Chain.' });

	if (tab.plugin.settings.providers.length === 0) {
		const empty = containerEl.createDiv({ cls: 'crucible-settings-group' });
		empty.createDiv({ text: 'Configure at least one Provider before adding agents.', cls: 'crucible-empty-state' });
	}

	const listGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });

	if (tab.plugin.settings.agents.length === 0) {
		listGroup.createDiv({ text: 'No agents configured.', cls: 'crucible-empty-state' });
	} else {
		sortByNameWithEmptyLast(tab.plugin.settings.agents, a => a.name).forEach(({ item: agent, index }, displayIdx) => {
			if (displayIdx > 0) listGroup.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(listGroup)
				.setName(agent.name || '(unnamed)')
				.setDesc(describeAgent(tab, agent))
				.addExtraButton(cb => cb.setIcon('copy').setTooltip('Duplicate agent').onClick(async () => {
					const copy = JSON.parse(JSON.stringify(agent)) as Agent;
					copy.id = Math.random().toString(36).substring(2, 9);
					copy.name = copy.name ? `${copy.name} (copy)` : '(copy)';
					tab.plugin.settings.agents.push(copy);
					await tab.plugin.saveSettings();
					tab.plugin.registerAgents();
					tab.display();
				}))
				.addExtraButton(cb => cb.setIcon('pencil').setTooltip('Edit agent').onClick(() => {
					tab.editingAgentIndex = index;
					tab.display();
				}))
				.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete agent').onClick(async () => {
					await deleteAgent(tab, index);
				}));
		});
	}

	new Setting(containerEl).addButton(bt => bt
		.setButtonText('Add agent')
		.setCta()
		.setDisabled(tab.plugin.settings.providers.length === 0)
		.onClick(async () => {
			const id = Math.random().toString(36).substring(2, 9);
			const firstProvider = tab.plugin.settings.providers[0];
			const firstModel = firstProvider?.models?.[0];
			tab.plugin.settings.agents.push({
				id,
				name: '',
				modelBinding: firstProvider && firstModel
					? { mode: 'pinned', pinned: { providerId: firstProvider.id, modelId: firstModel.id } }
					: { mode: 'runtime' },
				systemPromptSource: 'text',
				systemPromptText: '',
				systemPromptFile: '',
				userPromptSource: 'text',
				userPromptText: '{{input}}',
				userPromptFile: '',
				executionMode: 'read-only',
				requireNormalFinishReason: true
			});
			await tab.plugin.saveSettings();
			tab.plugin.registerAgents();
			tab.editingAgentIndex = tab.plugin.settings.agents.length - 1;
			tab.display();
		}));
}

function describeAgent(tab: CrucibleSettingTab, agent: Agent): string {
	const binding = agent.modelBinding;
	if (binding?.mode === 'pinned' && binding.pinned) {
		const provider = tab.plugin.settings.providers.find(p => p.id === binding.pinned!.providerId);
		const model = provider?.models?.find(m => m.id === binding.pinned!.modelId);
		const providerName = provider ? provider.name || `(unnamed ${provider.kind})` : 'unknown provider';
		const modelName = model ? model.label || model.id : binding.pinned.modelId || '(no model)';
		return `${providerName} · ${modelName} — ${agentCommandId(agent.id)}`;
	}
	if (binding?.mode === 'constrained') {
		const count = binding.allow?.length ?? 0;
		return `Constrained (${count} allowed) — ${agentCommandId(agent.id)}`;
	}
	if (binding?.mode === 'runtime') {
		return `Runtime pick — ${agentCommandId(agent.id)}`;
	}
	return `Unconfigured — ${agentCommandId(agent.id)}`;
}

async function deleteAgent(tab: CrucibleSettingTab, index: number) {
	const agent = tab.plugin.settings.agents[index];
	if (!agent) return;

	if (!(await confirmDestructive(tab.app, tab.plugin.settings, 'agent-delete', {
		message: `Delete agent "${agent.name || '(unnamed)'}"? This cannot be undone.`,
	}))) return;

	tab.plugin.settings.agents.splice(index, 1);
	tab.editingAgentIndex = -1;
	await tab.plugin.saveSettings();
	tab.plugin.registerAgents();
	tab.display();
}

function renderEditAgent(tab: CrucibleSettingTab, containerEl: HTMLElement, agent: Agent, index: number) {
	const save = () => tab.plugin.saveSettings();
	const commandId = agentCommandId(agent.id);

	new Setting(containerEl)
		.setName(`Agent: ${agent.name || '(unnamed)'}`)
		.setDesc(`Chain command: ${commandId}`)
		.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete agent').onClick(async () => {
			await deleteAgent(tab, index);
		}));

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	bindText(containerEl, {
		name: 'Name',
		placeholder: 'e.g. Summarize',
		get: () => agent.name,
		set: (v) => { agent.name = v; },
	}, save);

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	renderAgentBindingEditor(tab, containerEl, agent);

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	bindDropdown(containerEl, {
		name: 'Execution mode',
		desc: 'Read-only: CLI agents run with sandbox/tool restrictions where supported (Claude --tools Read, Codex --sandbox read-only). Edit: agent may write within its working directory. Unrestricted: no sandbox flags applied.',
		options: { 'read-only': 'Read-only (default)', edit: 'Edit', unrestricted: 'Unrestricted' },
		width: 'pi-width-wide',
		get: () => agent.executionMode || 'read-only',
		set: (v) => { agent.executionMode = v as AgentExecutionMode; },
	}, save);

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	bindToggle(containerEl, {
		name: 'Require normal API finish',
		desc: 'API agents fail when generation stops for truncation, filtering, tool calls, errors, or an unknown reason. CLI agents ignore this setting.',
		get: () => agent.requireNormalFinishReason ?? true,
		set: (v) => { agent.requireNormalFinishReason = v; },
	}, save);

	const autoSizeEl = (el: HTMLTextAreaElement) => {
		el.setCssProps({ height: 'auto' });
		el.setCssProps({ height: `${el.scrollHeight}px` });
	};

	const renderPromptEditor = (
		panelKey: string,
		label: string,
		description: string,
		placeholder: string,
		variables: TemplateVariableInfo[],
		getSource: () => AgentPromptSource,
		setSource: (v: AgentPromptSource) => Promise<void>,
		getText: () => string,
		setText: (v: string) => Promise<void>,
		getFile: () => string,
		setFile: (v: string) => Promise<void>,
	) => {
		containerEl.createEl('hr', { cls: 'crucible-row-divider' });

		new Setting(containerEl)
			.setName(label)
			.setDesc(description)
			.addDropdown(d => {
				d.addOption('text', 'Text')
				 .addOption('file', 'Vault file')
				 .setValue(getSource())
				 .onChange(async (v: AgentPromptSource) => {
					 await setSource(v);
					 tab.display();
				 });
				d.selectEl.addClass('pi-width-half');
			});

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });

		if (getSource() === 'file') {
			new Setting(containerEl)
				.setName(`${label} file`)
				.setDesc('Markdown file in your vault. Its contents are loaded each time the agent runs.')
				.addSearch(cb => {
					cb.setPlaceholder('prompts/summarize.md')
					  .setValue(getFile())
					  .onChange(async (v) => { await setFile(v); });
					const el = (cb as unknown as SearchWithContainer).containerEl;
					if (el) el.addClass('crucible-search-container', 'pi-width-wide');
					new FileSuggest(tab.app, cb.inputEl);
				});
		} else {
			const promptSetting = new Setting(containerEl)
				.setName(`${label} text`)
				.setDesc('Inline prompt template.')
				.addTextArea(t => {
					t.setPlaceholder(placeholder)
					 .setValue(getText())
					 .onChange(async (v) => {
						await setText(v);
						autoSizeEl(t.inputEl);
					 });
					t.inputEl.addClass('crucible-setting-textarea', 'pi-width-wide');
					requestAnimationFrame(() => autoSizeEl(t.inputEl));
				});
			tab.addTemplateVariablesToggle(promptSetting, panelKey, variables);
			tab.renderTemplateVariablesPanel(containerEl, panelKey, variables);
		}
	};

	renderPromptEditor(
		`agent-${index}-system-prompt`,
		'System prompt',
		'Persistent instructions for the agent. Supports template tokens like {{today}}, {{datetime:FORMAT}}.',
		'You are a helpful assistant...',
		tab.agentPromptVariables(false),
		() => agent.systemPromptSource || 'text',
		async (v) => { agent.systemPromptSource = v; await save(); },
		() => agent.systemPromptText || '',
		async (v) => { agent.systemPromptText = v; await save(); },
		() => agent.systemPromptFile || '',
		async (v) => { agent.systemPromptFile = v; await save(); },
	);

	renderPromptEditor(
		`agent-${index}-user-prompt`,
		'User prompt template',
		'Template for the user message. {{input}} (or {{value}}) is replaced by the runtime input passed to the agent.',
		'Summarize the following:\n\n{{input}}',
		tab.agentPromptVariables(true),
		() => agent.userPromptSource || 'text',
		async (v) => { agent.userPromptSource = v; await save(); },
		() => agent.userPromptText || '',
		async (v) => { agent.userPromptText = v; await save(); },
		() => agent.userPromptFile || '',
		async (v) => { agent.userPromptFile = v; await save(); },
	);
}

function renderAgentBindingEditor(tab: CrucibleSettingTab, containerEl: HTMLElement, agent: Agent) {
	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	const binding = agent.modelBinding ?? (agent.modelBinding = { mode: 'runtime' });

	new Setting(containerEl)
		.setName('Model selection')
		.setDesc('How this agent picks a (provider, model) when invoked.')
		.addDropdown(d => {
			d.addOption('pinned', 'Pinned: always use one model')
			 .addOption('constrained', 'Constrained: pick from an allowlist at run time')
			 .addOption('runtime', 'Runtime: pick from all configured models at run time')
			 .setValue(binding.mode)
			 .onChange(async (v: AgentBindingMode) => {
				 binding.mode = v;
				 await tab.plugin.saveSettings();
				 tab.display();
			 });
			d.selectEl.addClass('pi-width-wide');
		});

	const allProviders = tab.plugin.settings.providers;
	const hasAnyModels = allProviders.some(p => (p.models ?? []).length > 0);

	if (binding.mode === 'pinned') {
		containerEl.createEl('hr', { cls: 'crucible-row-divider' });

		if (!hasAnyModels) {
			containerEl.createDiv({ text: 'Add at least one model to a provider to pin.', cls: 'crucible-empty-state' });
			return;
		}

		const pinned = binding.pinned ?? (binding.pinned = { providerId: '', modelId: '' });

		// idh-WP-2: an agent binds to a model it will chat-complete against, so both dropdowns below
		// are filtered to chat-capable providers/models (modelHasCapability, never a raw
		// capabilities?.includes('chat') — see that function's doc comment for the undefined-means-
		// chat-only legacy trap). A saved selection that no longer qualifies (its model was toggled
		// off Chat, or was the provider's only chat-capable model and lost it) is never silently
		// dropped from the dropdown or cleared from settings — it stays offered, marked
		// "(not chat-capable)", exactly mirroring describeRerankModel's still-in-use-but-unmarked
		// precedent (orchestration.ts).
		const selectedProvider = allProviders.find(p => p.id === pinned.providerId);
		const chatCapableProviders = allProviders.filter(p => providerHasChatCapableModel(p));
		const providerOptions = selectedProvider && !providerHasChatCapableModel(selectedProvider)
			? [...chatCapableProviders, selectedProvider]
			: chatCapableProviders;

		new Setting(containerEl)
			.setName('Provider')
			.addDropdown(d => {
				if (!pinned.providerId || !selectedProvider) {
					d.addOption('', 'Select a provider...');
				}
				providerOptions.forEach(p => {
					const label = p.name || `(unnamed ${p.kind})`;
					d.addOption(p.id, providerHasChatCapableModel(p) ? label : `${label} (not chat-capable)`);
				});
				d.setValue(pinned.providerId)
				 .onChange(async (v) => {
					 pinned.providerId = v;
					 // Reset modelId if it doesn't belong to the new provider.
					 const newProvider = allProviders.find(p => p.id === v);
					 if (!newProvider?.models?.some(m => m.id === pinned.modelId)) {
						 pinned.modelId = '';
					 }
					 await tab.plugin.saveSettings();
					 tab.display();
				 });
				d.selectEl.addClass('pi-width-normal');
			});

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });

		const provider = allProviders.find(p => p.id === pinned.providerId);
		const models = provider?.models ?? [];
		const selectedModel = models.find(m => m.id === pinned.modelId);
		const chatCapableModels = models.filter(m => modelHasCapability(m, 'chat'));
		const modelOptions = selectedModel && !modelHasCapability(selectedModel, 'chat')
			? [...chatCapableModels, selectedModel]
			: chatCapableModels;

		new Setting(containerEl)
			.setName('Model')
			.addDropdown(d => {
				if (models.length === 0) {
					d.addOption('', 'No models on this provider');
				} else if (modelOptions.length === 0) {
					d.addOption('', 'No chat-capable models on this provider');
				} else {
					if (!pinned.modelId || !selectedModel) {
						d.addOption('', 'Select a model...');
					}
					modelOptions.forEach(m => {
						const label = m.label || m.id;
						d.addOption(m.id, modelHasCapability(m, 'chat') ? label : `${label} (not chat-capable)`);
					});
				}
				d.setValue(pinned.modelId)
				 .onChange(async (v) => {
					 pinned.modelId = v;
					 await tab.plugin.saveSettings();
				 });
				d.selectEl.addClass('pi-width-normal');
			});
	} else if (binding.mode === 'constrained') {
		containerEl.createEl('hr', { cls: 'crucible-row-divider' });

		if (!hasAnyModels) {
			containerEl.createDiv({ text: 'Add at least one model to a provider to populate the allowlist.', cls: 'crucible-empty-state' });
			return;
		}

		const allow = binding.allow ?? (binding.allow = []);

		new Setting(containerEl)
			.setName('Allowed models')
			.setDesc('When this agent runs, the user picks one of these. Chain steps may also override via the model arg.');

		const list = containerEl.createDiv({ cls: 'crucible-settings-group' });

		if (allow.length === 0) {
			list.createDiv({ text: 'No models allowed. Add at least one.', cls: 'crucible-empty-state' });
		} else {
			allow.forEach((ref, allowIndex) => {
				if (allowIndex > 0) list.createEl('hr', { cls: 'crucible-row-divider' });
				const provider = allProviders.find(p => p.id === ref.providerId);
				const model = provider?.models?.find((m: ProviderModel) => m.id === ref.modelId);
				const label = provider && model
					? `${provider.name || provider.kind} · ${model.label || model.id}${modelHasCapability(model, 'chat') ? '' : ' (not chat-capable)'}`
					: `${ref.providerId}:${ref.modelId} (missing)`;
				new Setting(list)
					.setName(label)
					.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove').onClick(async () => {
						if (!(await confirmDestructive(tab.app, tab.plugin.settings, 'constrained-binding-model-delete', {
							message: `Remove "${label}" from the allowed models list?`,
						}))) return;
						allow.splice(allowIndex, 1);
						await tab.plugin.saveSettings();
						tab.display();
					}));
			});
		}

		// idh-WP-2: only chat-capable models are offered to add — a non-chat model (or a provider
		// with none) simply never appears here, same filter as the pinned dropdowns above.
		const addable = collectAllRefs(allProviders).filter(ref => {
			if (allow.some(a => a.providerId === ref.providerId && a.modelId === ref.modelId)) return false;
			const refProvider = allProviders.find(p => p.id === ref.providerId);
			const refModel = refProvider?.models?.find(m => m.id === ref.modelId);
			return !!refModel && modelHasCapability(refModel, 'chat');
		});

		if (addable.length > 0) {
			let pendingProvider = '';
			let pendingModel = '';
			new Setting(containerEl)
				.setName('Add to allowlist')
				.addDropdown(d => {
					d.addOption('', 'Pick a model...');
					addable.forEach(ref => {
						const provider = allProviders.find(p => p.id === ref.providerId);
						const model = provider?.models?.find(m => m.id === ref.modelId);
						const label = provider && model
							? `${provider.name || provider.kind} · ${model.label || model.id}`
							: `${ref.providerId}:${ref.modelId}`;
						d.addOption(`${ref.providerId}:${ref.modelId}`, label);
					});
					d.onChange((v) => {
						const sep = v.indexOf(':');
						if (sep === -1) { pendingProvider = ''; pendingModel = ''; return; }
						pendingProvider = v.slice(0, sep);
						pendingModel = v.slice(sep + 1);
					});
					d.selectEl.addClass('pi-width-wide');
				})
				.addButton(bt => bt.setButtonText('Add').onClick(async () => {
					if (!pendingProvider || !pendingModel) return;
					allow.push({ providerId: pendingProvider, modelId: pendingModel });
					await tab.plugin.saveSettings();
					tab.display();
				}));
		}
	} else {
		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		containerEl.createEl('p', {
			text: 'When invoked, this agent will open a picker showing every configured (provider, model) pair. Chain steps may bypass the picker via the model arg.',
			cls: 'mod-muted',
		});
	}
}
