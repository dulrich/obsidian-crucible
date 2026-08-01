/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting, Notice } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { ProviderModelRef } from "../../types";
import { confirmDestructive } from "../destructiveActions";
import { addWarningIcon } from "../shared";
import { bindToggle, bindText, bindNumber } from "../bind";
import { ModelPickerModal, buildModelPickerOptions } from "../../modelPicker";
import { TEXT_EXTRACTABLE_CATEGORIES, deriveFileTypeGroups } from "../../fileTypes";
import { renderExtensionCheckboxGroups } from "./commands";
import { resolveProviderModelRef } from "../../search/SearchManager";
import { SearchHealth } from "../../search/types";
import { embeddingModelRefs, imageExtractionModelRefs, rerankModelRefs } from "../modelRefCollectors";
import {
	SEARCH_QUERY_LOG_DEFAULT_MAX_ENTRIES,
	SEARCH_QUERY_LOG_MAX_MAX_ENTRIES,
	SEARCH_QUERY_LOG_MIN_MAX_ENTRIES,
	normalizeMaxEntries,
} from "../../search/queryLog";

/**
 * WP-rem-R4 (F4) — the "Search" panel of the Orchestrate tab, split out of `orchestration.ts`.
 * `orchestration.ts` calls `renderOrchestrationSearchSettings` once, in the same position the
 * inline block used to occupy. Ref-collecting is delegated to the pure `modelRefCollectors.ts`;
 * the describe/dangling-ref helpers stay here since they resolve through
 * `resolveProviderModelRef` (`src/search/SearchManager.ts`, off-limits to edit this WP).
 */

// Both the description text and the inline warning below resolve through the same
// resolveProviderModelRef() SearchManager itself uses at index time — so "does this ref still
// exist" can never say yes here and no there. A dangling ref (WP-3/SE-WP-6: renaming a catalog
// entry does not rewrite the saved ref) previously showed the same generic "missing" copy as an
// intentionally-unset ref; the two are different problems (one needs a Pick, the other needs a
// fix-or-clear) and only the orphaned case gets the loud crucible-inline-warning treatment below.
function describeEmbeddingModel(tab: CrucibleSettingTab, ref: ProviderModelRef | undefined): string {
	const resolution = resolveProviderModelRef(tab.plugin.settings.providers, ref);
	if (resolution.status === 'unset') return 'No embedding model selected. Search will use FTS/BM25 only.';
	if (resolution.status === 'orphaned') return 'Selected embedding model no longer exists in its provider\'s catalog. Search will use FTS/BM25 only until this is fixed.';
	const providerName = resolution.provider.name || resolution.provider.kind;
	return `${providerName} · ${resolution.model.label || resolution.model.id}`;
}

// Names the dangling id explicitly — the description above deliberately does not, since it is
// also shown for the everyday "nothing picked yet" state and naming an id there would be noise.
function danglingRefWarning(tab: CrucibleSettingTab, ref: ProviderModelRef | undefined, label: string): string | null {
	const resolution = resolveProviderModelRef(tab.plugin.settings.providers, ref);
	if (resolution.status !== 'orphaned' || !ref) return null;
	return `${label} "${ref.modelId}" (provider "${ref.providerId}") is not in the current catalog — it was likely renamed or removed. Pick a replacement or Clear.`;
}

function describeImageExtractionModel(tab: CrucibleSettingTab, ref: ProviderModelRef | undefined): string {
	if (!ref) return 'No image description model selected. Image descriptions will not be generated.';
	const provider = tab.plugin.settings.providers.find(p => p.id === ref.providerId);
	const model = provider?.models.find(m => m.id === ref.modelId);
	if (!provider || !model) return 'Selected image description model is missing.';
	const providerName = provider.name || provider.kind;
	return `${providerName} · ${model.label || model.id}`;
}

// Reranking DOES have a dedicated model-capability checkbox now (the "Rerank" toggle in the
// Capabilities row on the AI settings tab, `sections/aiProviderModels.ts`) — `rerankModelRefs`
// above filters the Pick list to models marked with it. Point it at a provider that either speaks
// Infinity's native /rerank (a separate openai-compatible entry, typically http://127.0.0.1:4803
// with no /v1 suffix — that container is deliberately started without --url-prefix) or any chat
// model, which is scored via the slower, fuzzier complete()-based fallback instead.
function describeRerankModel(tab: CrucibleSettingTab, ref: ProviderModelRef | undefined): string {
	const resolution = resolveProviderModelRef(tab.plugin.settings.providers, ref);
	if (resolution.status === 'unset') return 'No reranker model selected. The Rerank button stays hidden on the search modal.';
	if (resolution.status === 'orphaned') return 'Selected reranker model no longer exists in its provider\'s catalog. The Rerank button stays hidden on the search modal until this is fixed.';
	const { provider, model } = resolution;
	const providerName = provider.name || provider.kind;
	// A selection made before the Rerank capability existed still works — nothing checks the flag
	// at run time, only the Pick list filters on it. Say so rather than implying it is broken, but
	// do flag it, because re-opening Pick would silently not list this model.
	if (!model.capabilities?.includes('rerank')) {
		return `${providerName} · ${model.label || model.id} — still in use, but not marked Rerank in Settings → AI, so it will not appear if you re-pick.`;
	}
	return `${providerName} · ${model.label || model.id}`;
}

export function renderOrchestrationSearchSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	new Setting(containerEl).setName('Search').setHeading();
	containerEl.createEl('p', { text: 'Vault search indexes the file types checked below through the orchestration queue. The local SQLite companion service owns storage and ranking.' });
	const searchGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });

	renderSearchHealthStatusSettings(tab, searchGroup);
	renderSearchConnectionSettings(tab, searchGroup);
	renderSearchIndexingTuningSettings(tab, searchGroup);
	renderSearchImageDescriptionSettings(tab, searchGroup);
	renderSearchRerankSettings(tab, searchGroup);
	renderSearchQueryLogSettings(tab, searchGroup);
}

// WP-SA2: session-scoped (module-level, mirrors the `describeModel` probe-cache and the client's
// own CORS-fallback-latch idiom) cache of the last manually-fetched `/health` snapshot. Read-only
// panel, no polling — the brief is explicit that this stays a manual "Refresh" affordance, not a
// timer, so the fetch happens only on click and the result survives the `statusBody.empty()` +
// re-render this function does locally (never a full `tab.display()`, which would also lose
// scroll position/edit state elsewhere on the tab for an unrelated click).
let cachedSearchHealth: SearchHealth | null = null;
let searchHealthFetchError: string | null = null;

function renderSearchHealthStatusSettings(tab: CrucibleSettingTab, searchGroup: HTMLElement) {
	const heading = new Setting(searchGroup).setName('Companion status').setHeading()
		.setDesc('Read-only. Reflects the last manual Refresh, not a live connection — click Refresh after starting/rebuilding the companion.');
	const statusBody = searchGroup.createDiv({ cls: 'crucible-search-health-status' });

	const renderBody = () => {
		statusBody.empty();
		if (searchHealthFetchError) {
			statusBody.createDiv({ cls: 'crucible-setting-warning', text: `Could not reach the search companion — ${searchHealthFetchError}` });
			return;
		}
		if (!cachedSearchHealth) {
			statusBody.createEl('p', { text: 'Not checked yet this session — click Refresh.' });
			return;
		}
		const health = cachedSearchHealth;
		const line = (label: string, value: string) => statusBody.createEl('p', { text: `${label}: ${value}` });
		line('Status', health.ok ? 'ok' : 'not ok');
		line('Version', health.version ?? 'unknown');
		line('Schema version', health.schemaVersion !== undefined ? String(health.schemaVersion) : 'unknown');
		line('Indexed chunks', health.embeddedChunks !== undefined ? String(health.embeddedChunks) : 'unknown');
		line('Vector backend', health.vectorBackend ?? 'unknown');
		line('Embedding model', health.embeddingModel ?? 'none');
		line('Embedding dimension', health.embeddingDim !== undefined ? String(health.embeddingDim) : 'unknown');
		const spaces = health.embeddingSpaces ?? [];
		line('Embedding spaces', spaces.length > 0 ? spaces.join(', ') : 'none');
		if (spaces.length > 1) {
			const warningRow = statusBody.createDiv({ cls: 'crucible-setting-warning' });
			addWarningIcon(warningRow, 'Mixed embedding spaces');
			warningRow.createSpan({ text: `Mixed vector spaces (${spaces.length}): ${spaces.join(', ')}. Some searches degrade to keyword-only until the vault is re-embedded under one space.` });
		}
		if (health.message) {
			statusBody.createDiv({ cls: 'crucible-setting-warning', text: health.message });
		}
	};

	heading.addButton(bt => bt.setButtonText('Refresh').onClick(async () => {
		bt.setDisabled(true);
		bt.setButtonText('Refreshing…');
		try {
			cachedSearchHealth = await tab.plugin.searchManager.health();
			searchHealthFetchError = null;
		} catch (e) {
			searchHealthFetchError = e instanceof Error ? e.message : String(e);
		}
		bt.setDisabled(false);
		bt.setButtonText('Refresh');
		renderBody();
	}));

	renderBody();
}

// The companion connection + what gets indexed at all (enabled, service URL, vault id, semantic
// toggle, the embedding model picker, and the file-extension gate). Tuning knobs for an already-
// indexing setup split out into `renderSearchIndexingTuningSettings` below.
function renderSearchConnectionSettings(tab: CrucibleSettingTab, searchGroup: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	bindToggle(searchGroup, {
		name: 'Enabled',
		desc: 'When on, note lifecycle events enqueue search index jobs.',
		get: () => s.searchEnabled,
		set: (v) => { s.searchEnabled = v; },
	}, save);

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindText(searchGroup, {
		name: 'Service URL',
		desc: 'URL of the user-run SQLite search companion service.',
		placeholder: 'http://127.0.0.1:4801',
		width: 'pi-width-wide',
		get: () => s.searchServiceUrl,
		set: (v) => { s.searchServiceUrl = v.trim() || 'http://127.0.0.1:4801'; },
	}, save);

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindText(searchGroup, {
		name: 'Vault ID',
		desc: 'Collection key sent to the companion service. Use a stable value per vault.',
		placeholder: 'default',
		get: () => s.searchVaultId,
		set: (v) => { s.searchVaultId = v.trim() || 'default'; },
	}, save);

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(searchGroup, {
		name: 'Semantic indexing',
		desc: 'Generate embeddings for chunks and query vectors when an embedding model is selected. Search falls back to FTS when unavailable.',
		get: () => s.searchSemanticEnabled,
		set: (v) => { s.searchSemanticEnabled = v; },
	}, save);

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	new Setting(searchGroup)
		.setName('Embedding model')
		.setDesc(describeEmbeddingModel(tab, s.searchEmbeddingModel))
		.addButton(bt => bt.setButtonText('Pick').onClick(() => {
			const refs = embeddingModelRefs(tab.plugin.settings.providers);
			if (refs.length === 0) {
				new Notice('No embedding-capable models configured. Mark a provider model as Embedding first.');
				return;
			}
			const options = buildModelPickerOptions(tab.plugin.settings.providers, refs);
			new ModelPickerModal(tab.app, options, (ref) => {
				s.searchEmbeddingModel = ref;
				void save();
				tab.display();
			}).open();
		}))
		.addButton(bt => bt.setButtonText('Clear').onClick(async () => {
			if (!(await confirmDestructive(tab.app, s, 'model-ref-clear', {
				message: 'Clear the search embedding model reference?',
			}))) return;
			delete s.searchEmbeddingModel;
			await save();
			tab.display();
		}));
	// SE-WP-6: a renamed catalog entry silently orphans this ref (the id string stays non-empty,
	// it just stops resolving) — the picker Setting above only shows a generic "missing" desc.
	// Name the dangling id so the fix is "Pick" or "Clear", not a support thread.
	const embeddingRefWarning = danglingRefWarning(tab, s.searchEmbeddingModel, 'Embedding model');
	if (embeddingRefWarning) {
		searchGroup.createDiv({ cls: 'crucible-inline-warning', text: embeddingRefWarning });
	}

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	renderExtensionCheckboxGroups(tab, searchGroup, {
		groups: deriveFileTypeGroups(tab.app).filter(g => TEXT_EXTRACTABLE_CATEGORIES.includes(g.category)),
		heading: 'Indexable file extensions',
		description: 'Only text-extractable types are offered here — indexing an image or audio file into FTS5 is meaningless, so this list is a subset of the file-open palette\'s extension checkboxes (Commands settings). Unchecked types are skipped by every indexer path: automatic edit triggers, "Search: rebuild index", and "Search: reindex active note."',
		get: () => s.searchIndexExtensions,
		set: (extensions) => { s.searchIndexExtensions = extensions; },
		emptyMeansAll: false,
		warning: 'Changing this list does not retroactively re-index or prune existing entries — run "Search: rebuild index" afterward so the companion\'s index matches the new selection.',
	}, save);
}

// Tuning knobs for chunking/embedding/query behavior once indexing is already on — chunk size,
// embedding batch size, edit debounce, result limit, query timeout, and the link-adjacency boost.
function renderSearchIndexingTuningSettings(tab: CrucibleSettingTab, searchGroup: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(searchGroup, {
		name: 'Chunk max characters',
		desc: 'Target maximum chunk size before sending text to the search service.',
		placeholder: '1800',
		get: () => String(s.searchChunkMaxChars),
		set: (v) => { const n = Number(v.trim()); s.searchChunkMaxChars = Number.isFinite(n) && n >= 400 ? Math.floor(n) : 1800; },
		min: 400,
	}, save);

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(searchGroup, {
		name: 'Embedding batch size',
		desc: 'Number of chunks sent to the embedding provider per request.',
		placeholder: '24',
		get: () => String(s.searchIndexBatchSize),
		set: (v) => { const n = Number(v.trim()); s.searchIndexBatchSize = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 24; },
		min: 1,
	}, save);

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(searchGroup, {
		name: 'Automatic edit debounce',
		desc: 'Milliseconds to wait before indexing ordinary note edits. Active-note edits always wait for 30000 ms of inactivity.',
		placeholder: '5000',
		get: () => String(s.searchIndexDebounceMs),
		set: (v) => { const n = Number(v.trim()); s.searchIndexDebounceMs = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 5000; },
		min: 0,
	}, save);

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(searchGroup, {
		name: 'Result limit',
		desc: 'Default number of results shown in the search modal.',
		placeholder: '12',
		get: () => String(s.searchResultLimit),
		set: (v) => { const n = Number(v.trim()); s.searchResultLimit = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 12; },
		min: 1,
	}, save);

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(searchGroup, {
		name: 'Query timeout',
		desc: 'Milliseconds an interactive search waits before giving up. The companion also gets ~80% of this as its own cooperative deadline, so a pathological or queued-up query degrades gracefully (partial results) instead of blocking the single-threaded companion until this fires. Floored at 3000 — search/health-probe budgets, never the 60s indexing one.',
		placeholder: '4000',
		get: () => String(s.searchQueryTimeoutMs),
		set: (v) => { const n = Number(v.trim()); s.searchQueryTimeoutMs = Number.isFinite(n) && n >= 3000 ? Math.floor(n) : 4000; },
		min: 3000,
	}, save);

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(searchGroup, {
		name: 'Link-adjacency boost',
		desc: 'Boost results adjacent to two or more of the top-ranked results, using Obsidian\'s own link graph (resolved + frontmatter-property links). Client-side, applied after the companion returns — no re-index needed.',
		get: () => s.searchLinkBoostEnabled,
		set: (v) => { s.searchLinkBoostEnabled = v; },
	}, save);

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(searchGroup, {
		name: 'Link-adjacency boost weight',
		desc: 'How strongly adjacency reorders results. Uses the same RRF idiom as the companion\'s own fusion (weight / (60 + rank)), so this stays a small number — 0 disables the boost without touching the toggle above.',
		placeholder: '0.05',
		get: () => String(s.searchLinkBoostWeight),
		set: (v) => { const n = Number(v.trim()); s.searchLinkBoostWeight = Number.isFinite(n) && n >= 0 ? n : 0.05; },
		min: 0,
		step: 0.01,
	}, save);
}

function renderSearchImageDescriptionSettings(tab: CrucibleSettingTab, searchGroup: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(searchGroup, {
		name: 'Image descriptions',
		desc: 'After Localize writes an MD5-named image, enqueue a per-note job that describes its embedded images with a vision model (a narrative pass and a structured-extraction pass) and folds the descriptions into that note\'s search chunks.',
		get: () => s.imageMetadataExtractionEnabled,
		set: (v) => { s.imageMetadataExtractionEnabled = v; },
	}, save);

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	new Setting(searchGroup)
		.setName('Image description model')
		.setDesc(describeImageExtractionModel(tab, s.imageMetadataExtractionModel))
		.addButton(bt => bt.setButtonText('Pick').onClick(() => {
			const refs = imageExtractionModelRefs(tab.plugin.settings.providers);
			if (refs.length === 0) {
				new Notice('No image-extraction-capable models configured. Mark a provider model as Image first.');
				return;
			}
			const options = buildModelPickerOptions(tab.plugin.settings.providers, refs);
			new ModelPickerModal(tab.app, options, (ref) => {
				s.imageMetadataExtractionModel = ref;
				void save();
				tab.display();
			}).open();
		}))
		.addButton(bt => bt.setButtonText('Clear').onClick(async () => {
			if (!(await confirmDestructive(tab.app, s, 'model-ref-clear', {
				message: 'Clear the image description model reference?',
			}))) return;
			delete s.imageMetadataExtractionModel;
			await save();
			tab.display();
		}));
}

function renderSearchRerankSettings(tab: CrucibleSettingTab, searchGroup: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	// WP-5: reranking is a deliberate, explicitly-invoked action on the search modal — never a
	// type-ahead pipeline stage (see the AGENTS.md quirk on companion search latency for why
	// that distinction matters). Off by default; the modal hides the Rerank button entirely,
	// not merely disables it, until both this toggle is on and a model is picked.
	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(searchGroup, {
		name: 'Reranking',
		desc: 'Adds an explicit "Rerank results" button to the search modal, reordering the current top results by a cross-encoder score. Never runs automatically or on type-ahead. Requires a reranker model below.',
		get: () => s.searchRerankEnabled,
		set: (v) => { s.searchRerankEnabled = v; },
	}, save);

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	new Setting(searchGroup)
		.setName('Reranker model')
		.setDesc(describeRerankModel(tab, s.searchRerankModel))
		.addButton(bt => bt.setButtonText('Pick').onClick(() => {
			const refs = rerankModelRefs(tab.plugin.settings.providers);
			if (refs.length === 0) {
				new Notice('No rerank-capable models configured. Mark a provider model as Rerank first.');
				return;
			}
			const options = buildModelPickerOptions(tab.plugin.settings.providers, refs);
			new ModelPickerModal(tab.app, options, (ref) => {
				s.searchRerankModel = ref;
				void save();
				tab.display();
			}).open();
		}))
		.addButton(bt => bt.setButtonText('Clear').onClick(async () => {
			if (!(await confirmDestructive(tab.app, s, 'model-ref-clear', {
				message: 'Clear the reranker model reference?',
			}))) return;
			delete s.searchRerankModel;
			await save();
			tab.display();
		}));
	// See the matching comment on the embedding-model warning above — same dangling-ref class,
	// same fix.
	const rerankRefWarning = danglingRefWarning(tab, s.searchRerankModel, 'Reranker model');
	if (rerankRefWarning) {
		searchGroup.createDiv({ cls: 'crucible-inline-warning', text: rerankRefWarning });
	}

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(searchGroup, {
		name: 'Rerank top N',
		desc: 'How many of the current (already-fused) top results get sent to the reranker when the button is clicked.',
		placeholder: '30',
		get: () => String(s.searchRerankTopN),
		set: (v) => { const n = Number(v.trim()); s.searchRerankTopN = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30; },
		min: 1,
	}, save);
}

function renderSearchQueryLogSettings(tab: CrucibleSettingTab, searchGroup: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	// Query logging. The copy below is deliberately blunt about what is recorded and where it
	// goes: this feature writes down what the user searches for, so a vague description of it
	// would itself be the problem. Nothing leaves the machine, and "Search: clear query log"
	// deletes the file outright.
	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(searchGroup, {
		name: 'Log searches and which result you open',
		desc: 'Records each vault search — the words you typed, the note paths it returned and in what order, '
			+ 'and which result you opened — to a local file in this plugin\'s folder. Note contents and snippets '
			+ 'are never recorded, nothing is sent anywhere, and the log is capped below. A search where you open '
			+ 'nothing is recorded as exactly that, not as a failure. Used to check that search ranking changes '
			+ 'actually help on real searches; "Search: export query log" turns it into a measurable query set.',
		get: () => s.searchQueryLogEnabled,
		set: (v) => { s.searchQueryLogEnabled = v; },
	}, save);

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(searchGroup, {
		name: 'Query log size',
		desc: 'How many searches to keep. Once full, the oldest is dropped for each new one. Clamped to 10–5000.',
		placeholder: String(SEARCH_QUERY_LOG_DEFAULT_MAX_ENTRIES),
		get: () => String(s.searchQueryLogMaxEntries),
		set: (v) => { s.searchQueryLogMaxEntries = normalizeMaxEntries(v.trim()); },
		min: SEARCH_QUERY_LOG_MIN_MAX_ENTRIES,
		max: SEARCH_QUERY_LOG_MAX_MAX_ENTRIES,
	}, save);
}
