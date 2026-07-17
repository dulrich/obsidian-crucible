/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting, Notice, TextComponent } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { CrucibleSettings, CurrencyCache, GeocodeCacheEntry, ProviderModelRef } from "../../types";
import { FileSuggest, FolderSuggest, CurrencySuggest, LocationSuggest } from "../../suggesters";
import { isValidTimezone } from "../../orchestration/utils/dates";
import { YOUTUBE_DATA_API_SECRET_KEY, deleteYoutubeApiKey, loadYoutubeApiKey, storeYoutubeApiKey } from "../../orchestration/utils/youtubeApi";
import { addWarningIcon, mountSecretControl } from "../shared";
import { bindToggle, bindText, bindNumber, bindSearch, bindTextArea, bindDropdown } from "../bind";
import { ModelPickerModal, buildModelPickerOptions } from "../../modelPicker";
import type { JobType } from "../../orchestration/types";

interface WorkflowMeta {
	id: string;
	name: string;
	description: string;
	enabledKey: keyof CrucibleSettings;
	render: (containerEl: HTMLElement) => void;
}

function getWorkflowMeta(tab: CrucibleSettingTab): WorkflowMeta[] {
	return [
		{
			id: 'daily_brief_lite',
			name: 'Daily Brief Lite',
			description: 'Fetch FX rates and weather, then inject them into today\'s daily note.',
			enabledKey: 'orchestrationDailyBriefEnabled',
			render: (el) => renderEditDailyBriefWorkflow(tab, el),
		},
		{
			id: 'transcript_refine',
			name: 'Transcript Refine',
			description: 'Run an AI chain against a target transcript note.',
			enabledKey: 'orchestrationTranscriptRefineEnabled',
			render: (el) => renderEditTranscriptRefineWorkflow(tab, el),
		},
		{
			id: 'youtube_tracker',
			name: 'YouTube Tracker',
			description: 'Poll configured YouTube channels for new videos and create intake notes.',
			enabledKey: 'orchestrationYoutubeTrackerEnabled',
			render: (el) => renderEditYoutubeTrackerWorkflow(tab, el),
		},
		{
			id: 'blogs_tracker',
			name: 'Blogs Tracker',
			description: 'Poll configured blog RSS feeds for new posts and create intake notes.',
			enabledKey: 'orchestrationBlogsTrackerEnabled',
			render: (el) => renderEditBlogsTrackerWorkflow(tab, el),
		},
		{
			id: 'link_scan',
			name: 'Link Scan',
			description: 'Scan the vault for URLs and build a canonical link registry.',
			enabledKey: 'orchestrationLinkScanEnabled',
			render: (el) => renderEditLinkScanWorkflow(tab, el),
		},
	];
}

function getWorkflowWarning(tab: CrucibleSettingTab, workflowId: string): string | null {
	if (workflowId === 'daily_brief_lite' && !tab.plugin.settings.dailyEnabled) {
		return 'Daily is disabled; this workflow will fail with a warning until Daily is enabled.';
	}
	return null;
}

function embeddingModelRefs(tab: CrucibleSettingTab): ProviderModelRef[] {
	const refs: ProviderModelRef[] = [];
	for (const provider of tab.plugin.settings.providers) {
		for (const model of provider.models ?? []) {
			if (model.capabilities?.includes('embedding')) {
				refs.push({ providerId: provider.id, modelId: model.id });
			}
		}
	}
	return refs;
}

function imageExtractionModelRefs(tab: CrucibleSettingTab): ProviderModelRef[] {
	const refs: ProviderModelRef[] = [];
	for (const provider of tab.plugin.settings.providers) {
		for (const model of provider.models ?? []) {
			if (model.capabilities?.includes('image-extraction')) {
				refs.push({ providerId: provider.id, modelId: model.id });
			}
		}
	}
	return refs;
}

function describeEmbeddingModel(tab: CrucibleSettingTab, ref: ProviderModelRef | undefined): string {
	if (!ref) return 'No embedding model selected. Search will use FTS/BM25 only.';
	const provider = tab.plugin.settings.providers.find(p => p.id === ref.providerId);
	const model = provider?.models.find(m => m.id === ref.modelId);
	if (!provider || !model) return 'Selected embedding model is missing. Search will use FTS/BM25 only.';
	const providerName = provider.name || provider.kind;
	return `${providerName} · ${model.label || model.id}`;
}

function describeImageExtractionModel(tab: CrucibleSettingTab, ref: ProviderModelRef | undefined): string {
	if (!ref) return 'No image extraction model selected. Localized image metadata will not be generated.';
	const provider = tab.plugin.settings.providers.find(p => p.id === ref.providerId);
	const model = provider?.models.find(m => m.id === ref.modelId);
	if (!provider || !model) return 'Selected image extraction model is missing.';
	const providerName = provider.name || provider.kind;
	return `${providerName} · ${model.label || model.id}`;
}

const ROUTINE_NOTICE_JOB_TYPES: JobType[] = [
	'daily_brief_lite',
	'youtube_tracker',
	'youtube_tracker_consolidate',
	'blogs_tracker',
	'blogs_tracker_consolidate',
	'transcript_refine',
	'link_scan',
	'youtube_metadata_fetch',
	'command_run',
	'image_metadata_extract',
	'search_rebuild',
	'search_upsert_file',
	'search_upsert_batch',
	'search_delete_path',
	'search_sweep',
];

export function renderOrchestrationSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();
	const workflows = getWorkflowMeta(tab);

	if (tab.editingWorkflowId !== null) {
		const meta = workflows.find(w => w.id === tab.editingWorkflowId);
		if (meta) {
			const heading = new Setting(containerEl).setName(`Edit Workflow: ${meta.name}`).setHeading();
			const warning = getWorkflowWarning(tab, meta.id);
			if (warning) addWarningIcon(heading.nameEl, warning);
			const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
			if (warning) {
				group.createDiv({ cls: 'crucible-setting-warning', text: warning });
			}
			meta.render(group);
			return;
		}
		tab.editingWorkflowId = null;
	}

	new Setting(containerEl).setName('Orchestrate').setHeading();
	containerEl.createEl('p', { text: 'Vault-native deterministic job runner. Jobs are markdown files in queue folders that move through inbox → running → done | failed. Manual execution only — use the "Orchestrate: Scan" and "Orchestrate: Run next" commands.' });

	const globalGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });

	bindToggle(globalGroup, {
		name: 'Enabled',
		desc: 'When off, scan and run-next show a notice and do nothing.',
		get: () => s.orchestrationEnabled,
		set: (v) => { s.orchestrationEnabled = v; },
	}, save);

	globalGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(globalGroup, {
		name: 'Max concurrent jobs',
		desc: 'Upper bound on total jobs running at once across all types when the queue drains.',
		placeholder: '3',
		get: () => String(s.orchestrationMaxConcurrent),
		set: (v) => { const n = Number(v.trim()); s.orchestrationMaxConcurrent = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3; },
		min: 1,
	}, save);

	globalGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(globalGroup, {
		name: 'Autorun job timeout (seconds)',
		desc: 'A running job that exceeds this is marked failed so the drain keeps moving. 0 disables (relies on the hourly stale-job recovery).',
		placeholder: '600',
		get: () => String(s.orchestrationAutorunTimeoutSeconds),
		set: (v) => { const n = Number(v.trim()); s.orchestrationAutorunTimeoutSeconds = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 600; },
		min: 0,
	}, save);

	globalGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindText(globalGroup, {
		name: 'Queue folder root',
		desc: 'Vault folder containing inbox/, running/, done/, failed/ subfolders.',
		placeholder: '_crucible/orchestration/queue',
		get: () => s.orchestrationQueueRoot,
		set: (v) => { s.orchestrationQueueRoot = v.trim() || '_crucible/orchestration/queue'; },
	}, save);

	globalGroup.createEl('hr', { cls: 'crucible-row-divider' });
	let tzWarning: HTMLElement | null = null;
	const setTzWarningVisibility = (valid: boolean) => {
		if (!tzWarning) return;
		if (valid) tzWarning.addClass('is-hidden');
		else tzWarning.removeClass('is-hidden');
	};
	const tzSetting = new Setting(globalGroup)
		.setName('Timezone')
		.setDesc('IANA timezone name used to determine "today" for date-bound workflows.')
		.addText(t => t
			.setPlaceholder('America/Mexico_City')
			.setValue(s.orchestrationTimezone)
			.onChange(async (v) => {
				const next = v.trim() || 'America/Mexico_City';
				s.orchestrationTimezone = next;
				await save();
				setTzWarningVisibility(isValidTimezone(next));
			})
			.inputEl.addClass('pi-width-normal'));
	tzWarning = tzSetting.descEl.createEl('div', {
		cls: 'crucible-tz-warning',
		text: 'Warning: this timezone is not recognized by Intl.DateTimeFormat.',
	});
	setTzWarningVisibility(isValidTimezone(s.orchestrationTimezone));

	new Setting(containerEl).setName('Routine notices').setHeading();
	containerEl.createEl('p', { text: 'Routine queue notices are quiet by default. Failures and explicit command feedback still show.' });
	const noticesGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	ROUTINE_NOTICE_JOB_TYPES.forEach((type, index) => {
		if (index > 0) noticesGroup.createEl('hr', { cls: 'crucible-row-divider' });
		bindToggle(noticesGroup, {
			name: type,
			desc: 'Show routine queued, promoted, duplicate, and completed notices for this job type.',
			get: () => s.orchestrationRoutineNoticesEnabled[type] === true,
			set: (v) => { s.orchestrationRoutineNoticesEnabled = { ...s.orchestrationRoutineNoticesEnabled, [type]: v }; },
		}, save);
	});

	// --- Search ---
	new Setting(containerEl).setName('Search').setHeading();
	containerEl.createEl('p', { text: 'Vault search indexes Markdown, QMD, and text notes through the orchestration queue. The local SQLite companion service owns storage and ranking.' });
	const searchGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });

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
		placeholder: 'http://127.0.0.1:8765',
		width: 'pi-width-wide',
		get: () => s.searchServiceUrl,
		set: (v) => { s.searchServiceUrl = v.trim() || 'http://127.0.0.1:8765'; },
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
			const refs = embeddingModelRefs(tab);
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
			delete s.searchEmbeddingModel;
			await save();
			tab.display();
		}));

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
	bindToggle(searchGroup, {
		name: 'Image metadata extraction',
		desc: 'After Localize writes an MD5-named image, enqueue a job that creates a sibling Markdown metadata note for search.',
		get: () => s.imageMetadataExtractionEnabled,
		set: (v) => { s.imageMetadataExtractionEnabled = v; },
	}, save);

	searchGroup.createEl('hr', { cls: 'crucible-row-divider' });
	new Setting(searchGroup)
		.setName('Image extraction model')
		.setDesc(describeImageExtractionModel(tab, s.imageMetadataExtractionModel))
		.addButton(bt => bt.setButtonText('Pick').onClick(() => {
			const refs = imageExtractionModelRefs(tab);
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
			delete s.imageMetadataExtractionModel;
			await save();
			tab.display();
		}));

	// --- Workflows list ---
	new Setting(containerEl).setName('Workflows').setHeading();
	containerEl.createEl('p', { text: 'Toggle workflows on or off here. Click the pencil to edit a workflow\'s settings.' });

	const workflowsGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	workflows.forEach((meta, index) => {
		if (index > 0) workflowsGroup.createEl('hr', { cls: 'crucible-row-divider' });
		const setting = bindToggle(workflowsGroup, {
			name: meta.name,
			desc: meta.description,
			tooltip: 'Enabled',
			get: () => s[meta.enabledKey] as boolean,
			set: (v) => { (s[meta.enabledKey] as boolean) = v; },
		}, save);
		setting.addExtraButton(cb => cb.setIcon('pencil').setTooltip('Edit workflow').onClick(() => {
			tab.editingWorkflowId = meta.id;
			tab.display();
		}));
		const warning = getWorkflowWarning(tab, meta.id);
		if (warning) addWarningIcon(setting.nameEl, warning);
	});

	// --- Triggers ---
	new Setting(containerEl).setName('Triggers').setHeading();
	containerEl.createEl('p', { text: 'Code-defined rules that enqueue jobs automatically on note lifecycle events or schedules. Triggered work runs through the queue (dedupe, pacing, timeouts, note locks).' });

	const triggersGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	const triggers = tab.plugin.triggers?.listFounding() ?? [];
	triggers.forEach((trigger, index) => {
		if (index > 0) triggersGroup.createEl('hr', { cls: 'crucible-row-divider' });
		bindToggle(triggersGroup, {
			name: trigger.id,
			desc: trigger.description,
			tooltip: 'Enabled',
			get: () => s.orchestrationTriggersEnabled[trigger.id] ?? true,
			set: (v) => { s.orchestrationTriggersEnabled = { ...s.orchestrationTriggersEnabled, [trigger.id]: v }; },
		}, save);
	});

	triggersGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(triggersGroup, {
		name: 'YouTube tracker interval (minutes)',
		desc: 'Schedule for youtube-tracker-schedule. 0 disables the schedule.',
		placeholder: '0',
		get: () => String(s.orchestrationYoutubeTrackerIntervalMinutes),
		set: (v) => { const n = Number(v.trim()); s.orchestrationYoutubeTrackerIntervalMinutes = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; },
		min: 0,
	}, save);
	triggersGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(triggersGroup, {
		name: 'Blog tracker interval (minutes)',
		desc: 'Schedule for blogs-tracker-schedule. 0 disables the schedule.',
		placeholder: '0',
		get: () => String(s.orchestrationBlogsTrackerIntervalMinutes),
		set: (v) => { const n = Number(v.trim()); s.orchestrationBlogsTrackerIntervalMinutes = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; },
		min: 0,
	}, save);

	// --- Actions ---
	new Setting(containerEl).setName('Actions').setHeading();
	const actions = containerEl.createDiv({ cls: 'crucible-settings-group' });
	new Setting(actions)
		.setName('Scan now')
		.setDesc('Ensure queue folders exist, count jobs, and recover any job stuck in running for more than an hour.')
		.addButton(bt => bt.setButtonText('Scan').onClick(async () => {
			await tab.plugin.orchestrator.scan();
		}));
	actions.createEl('hr', { cls: 'crucible-row-divider' });
	new Setting(actions)
		.setName('Run next')
		.setDesc('Pick the oldest job in inbox and execute it.')
		.addButton(bt => bt.setButtonText('Run next').onClick(async () => {
			await tab.plugin.orchestrator.runNext();
		}));

	// --- Ingestion Dashboard ---
	new Setting(containerEl).setName('Ingestion dashboard').setHeading();
	containerEl.createEl('p', { text: 'Live view of clippings, transcripts, tracker runs, and uncaptured posts/videos. Open via the "Crucible: Open ingestion dashboard" command.' });

	const ingestionGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });

	bindSearch(ingestionGroup, {
		name: 'Clipper inbox folder',
		desc: 'Markdown files directly under this folder are shown in the "Unprocessed Clippings" section.',
		placeholder: '_clippings/inbox',
		get: () => s.ingestionClipperInboxFolder,
		set: (v) => { s.ingestionClipperInboxFolder = v.trim() || '_clippings/inbox'; },
		suggest: (el) => { new FolderSuggest(tab.app, el); },
	}, save);

	ingestionGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(ingestionGroup, {
		name: 'Reading speed (words per minute)',
		desc: 'Used to estimate read time for unrefined transcripts.',
		placeholder: '250',
		get: () => String(s.ingestionReadingWpm),
		set: (v) => { const n = Number(v.trim()); s.ingestionReadingWpm = Number.isFinite(n) && n > 0 ? n : 250; },
	}, save);

	ingestionGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(ingestionGroup, {
		name: 'Auto-enrich YouTube metadata',
		desc: 'When on, the dashboard drains the Uncaptured Videos list (in current sort order) through the YouTube Data API. Requires a configured API key.',
		get: () => s.ingestionYoutubeAutoEnrichEnabled === true,
		set: (v) => { s.ingestionYoutubeAutoEnrichEnabled = v; },
	}, save);

	ingestionGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(ingestionGroup, {
		name: 'Enrichment rate limit (seconds)',
		desc: 'Minimum seconds between YouTube Data API requests when draining the enrichment queue.',
		placeholder: '2',
		get: () => String(s.ingestionYoutubeEnrichRateLimitSeconds),
		set: (v) => { const n = Number(v.trim()); s.ingestionYoutubeEnrichRateLimitSeconds = Number.isFinite(n) && n >= 0 ? n : 2; },
	}, save);

	ingestionGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(ingestionGroup, {
		name: 'Enrichment parallelism',
		desc: 'How many YouTube metadata fetches run at once (still bounded by the rate limit and the global max concurrent jobs).',
		placeholder: '1',
		get: () => String(s.orchestrationYoutubeMetadataMaxParallel),
		set: (v) => { const n = Number(v.trim()); s.orchestrationYoutubeMetadataMaxParallel = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1; },
		min: 1,
	}, save);
}

function renderEditDailyBriefWorkflow(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	bindText(containerEl, {
		name: 'Target section',
		desc: 'Header to inject the brief under (e.g. # Daily Brief). If empty, defaults to "Daily Brief: External Context".',
		placeholder: '# Daily Brief: External Context',
		get: () => s.orchestrationDailyBriefTargetSection,
		set: (v) => { s.orchestrationDailyBriefTargetSection = v; },
	}, save);

	// Currency pairs
	new Setting(containerEl).setName('Currency pairs').setHeading();
	containerEl.createEl('p', { text: 'FX rates to fetch from api.frankfurter.app. Base and quote are ISO codes (e.g. USD, MXN); start typing to pick from the supported list. Label is shown in the brief.' });

	const loadCurrencyCache = () => s.orchestrationDailyBriefCurrencyCache;
	const saveCurrencyCache = async (cache: CurrencyCache) => {
		s.orchestrationDailyBriefCurrencyCache = cache;
		await save();
	};

	const fxGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	const fxPairs = s.orchestrationDailyBriefFxPairs;
	if (fxPairs.length === 0) {
		fxGroup.createDiv({ text: 'No currency pairs configured.', cls: 'crucible-empty-state' });
	} else {
		fxPairs.forEach((pair, index) => {
			if (index > 0) fxGroup.createEl('hr', { cls: 'crucible-row-divider' });
			const row = new Setting(fxGroup);
			let labelText: TextComponent;
			const maybeAutoTitle = () => {
				if (!pair.label && pair.base && pair.quote) {
					pair.label = `${pair.base} → ${pair.quote}`;
					labelText.setValue(pair.label);
				}
			};
			let baseText: TextComponent;
			row.addText(t => {
				baseText = t;
				t.setPlaceholder('base (USD)')
					.setValue(pair.base)
					.onChange(async (v) => { pair.base = v.trim().toUpperCase(); maybeAutoTitle(); await save(); });
				t.inputEl.addClass('pi-width-small');
				new CurrencySuggest(tab.app, t.inputEl, loadCurrencyCache, saveCurrencyCache, async (c) => {
					pair.base = c.code;
					baseText.setValue(c.code);
					maybeAutoTitle();
					await save();
				});
			});
			let quoteText: TextComponent;
			row.addText(t => {
				quoteText = t;
				t.setPlaceholder('quote (MXN)')
					.setValue(pair.quote)
					.onChange(async (v) => { pair.quote = v.trim().toUpperCase(); maybeAutoTitle(); await save(); });
				t.inputEl.addClass('pi-width-small');
				new CurrencySuggest(tab.app, t.inputEl, loadCurrencyCache, saveCurrencyCache, async (c) => {
					pair.quote = c.code;
					quoteText.setValue(c.code);
					maybeAutoTitle();
					await save();
				});
			});
			row.addText(t => {
				labelText = t;
				t.setPlaceholder('label (USD → MXN)')
					.setValue(pair.label)
					.onChange(async (v) => { pair.label = v; await save(); });
				t.inputEl.addClass('pi-width-normal');
			});
			row.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove pair').onClick(async () => {
				fxPairs.splice(index, 1);
				await save();
				tab.display();
			}));
		});
	}

	new Setting(containerEl)
		.addButton(bt => bt.setButtonText('Add currency pair').onClick(async () => {
			fxPairs.push({ base: '', quote: '', label: '' });
			await save();
			tab.display();
		}))
		.addButton(bt => bt.setButtonText('Clear cache').setWarning().onClick(async () => {
			s.orchestrationDailyBriefCurrencyCache = undefined;
			await save();
			new Notice('Currency list cache cleared');
		}));

	// Weather locations
	new Setting(containerEl).setName('Weather locations').setHeading();
	containerEl.createEl('p', { text: 'Locations to fetch daily forecasts from open-meteo.com. Type a city name in the label field to look it up and auto-fill coordinates. Latitude and longitude are decimal degrees.' });

	const geocodeCache = s.orchestrationDailyBriefGeocodeCache;
	const loadGeocodeCache = (query: string) => geocodeCache[query];
	const saveGeocodeCache = async (query: string, entry: GeocodeCacheEntry) => {
		geocodeCache[query] = entry;
		await save();
	};

	const wxGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	const locations = s.orchestrationDailyBriefWeatherLocations;
	if (locations.length === 0) {
		wxGroup.createDiv({ text: 'No locations configured.', cls: 'crucible-empty-state' });
	} else {
		locations.forEach((loc, index) => {
			if (index > 0) wxGroup.createEl('hr', { cls: 'crucible-row-divider' });
			const row = new Setting(wxGroup);
			let latText: TextComponent;
			let lonText: TextComponent;
			row.addText(t => {
				t.setPlaceholder('label (Guadalajara, MX)')
					.setValue(loc.label)
					.onChange(async (v) => { loc.label = v; await save(); });
				t.inputEl.addClass('pi-width-normal');
				new LocationSuggest(tab.app, t.inputEl, loadGeocodeCache, saveGeocodeCache, async (g) => {
					loc.label = g.label;
					loc.lat = g.lat;
					loc.lon = g.lon;
					t.setValue(g.label);
					latText.setValue(String(g.lat));
					lonText.setValue(String(g.lon));
					await save();
				});
			});
			row.addText(t => {
				latText = t;
				t.setPlaceholder('lat')
					.setValue(loc.lat.toString())
					.onChange(async (v) => {
						const n = Number(v);
						if (Number.isFinite(n)) { loc.lat = n; await save(); }
					});
				t.inputEl.type = 'number';
				t.inputEl.addClass('pi-width-small');
			});
			row.addText(t => {
				lonText = t;
				t.setPlaceholder('lon')
					.setValue(loc.lon.toString())
					.onChange(async (v) => {
						const n = Number(v);
						if (Number.isFinite(n)) { loc.lon = n; await save(); }
					});
				t.inputEl.type = 'number';
				t.inputEl.addClass('pi-width-small');
			});
			row.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove location').onClick(async () => {
				locations.splice(index, 1);
				await save();
				tab.display();
			}));
		});
	}

	new Setting(containerEl)
		.addButton(bt => bt.setButtonText('Add location').onClick(async () => {
			locations.push({ label: '', lat: 0, lon: 0 });
			await save();
			tab.display();
		}))
		.addButton(bt => bt.setButtonText('Clear cache').setWarning().onClick(async () => {
			s.orchestrationDailyBriefGeocodeCache = {};
			await save();
			new Notice('Location cache cleared');
		}));
}

function renderEditTranscriptRefineWorkflow(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();
	bindText(containerEl, {
		name: 'Default chain',
		desc: 'Chain to run when no agentChainName is specified in the job params.',
		placeholder: 'Refine Transcript',
		get: () => s.orchestrationTranscriptRefineChainName,
		set: (v) => { s.orchestrationTranscriptRefineChainName = v.trim() || 'Refine Transcript'; },
	}, save);
}

function renderEditYoutubeTrackerWorkflow(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	bindSearch(containerEl, {
		name: 'Channels note',
		desc: 'Markdown note containing the channel registry table.',
		placeholder: '_system/youtube/Channels.md',
		get: () => s.orchestrationYoutubeChannelsNote,
		set: (v) => { s.orchestrationYoutubeChannelsNote = v.trim() || '_system/youtube/Channels.md'; },
		suggest: (el) => { new FileSuggest(tab.app, el); },
	}, save);

	bindToggle(containerEl, {
		name: 'Diff against prior runs',
		desc: 'On: each run surfaces only videos not in any prior intake file. Off: each run surfaces every video that has no vault note (independent of prior intakes).',
		get: () => s.orchestrationYoutubeTrackerDiffMode !== false,
		set: (v) => { s.orchestrationYoutubeTrackerDiffMode = v; },
	}, save);

	bindToggle(containerEl, {
		name: 'Write empty intake files',
		desc: 'On: every run writes an intake file even when no new videos and no channel failures (audit trail). Off: skip writing when there is nothing to report.',
		get: () => s.orchestrationYoutubeTrackerWriteEmptyRuns === true,
		set: (v) => { s.orchestrationYoutubeTrackerWriteEmptyRuns = v; },
	}, save);

	bindSearch(containerEl, {
		name: 'Metadata root folder',
		desc: 'Folder where per-video metadata notes are saved (one subfolder per channel).',
		placeholder: '_yt_metadata',
		get: () => s.orchestrationYoutubeMetadataRoot,
		set: (v) => { s.orchestrationYoutubeMetadataRoot = v.trim() || '_yt_metadata'; },
		suggest: (el) => { new FolderSuggest(tab.app, el); },
	}, save);

	bindToggle(containerEl, {
		name: 'Auto-enrich channel metadata',
		desc: 'When on, a scheduled sweep refreshes each known channel\'s about.md note (subject to the interval and max-age below). Requires a configured API key.',
		get: () => s.orchestrationYoutubeChannelEnrichEnabled === true,
		set: (v) => { s.orchestrationYoutubeChannelEnrichEnabled = v; },
	}, save);

	bindNumber(containerEl, {
		name: 'Channel enrichment interval (minutes)',
		desc: 'How often the channel about.md sweep runs (0 = off). Only fetches channels whose about.md is missing or older than the max age below.',
		placeholder: '0',
		get: () => String(s.orchestrationYoutubeChannelEnrichIntervalMinutes),
		set: (v) => { const n = Number(v.trim()); s.orchestrationYoutubeChannelEnrichIntervalMinutes = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0; },
	}, save);

	bindNumber(containerEl, {
		name: 'Channel about.md max age (days)',
		desc: 'Scheduled/sweep runs skip channels whose about.md was fetched within this many days. Per-channel "Re-enrich" always re-fetches.',
		placeholder: '30',
		get: () => String(s.orchestrationYoutubeChannelEnrichMaxAgeDays),
		set: (v) => { const n = Number(v.trim()); s.orchestrationYoutubeChannelEnrichMaxAgeDays = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30; },
	}, save);

	const youtubeKeySetting = new Setting(containerEl)
		.setName('YouTube Data API key')
		.setDesc('Stored securely in Obsidian Secret Storage. Required for the per-video metadata fetch command.');
	mountSecretControl(youtubeKeySetting, {
		load: () => loadYoutubeApiKey(tab.app),
		store: async (v) => {
			await storeYoutubeApiKey(tab.app, v);
			if (v.trim()) await tab.plugin.secretRegistry.record(YOUTUBE_DATA_API_SECRET_KEY);
		},
		clear: async () => {
			await deleteYoutubeApiKey(tab.app);
			await tab.plugin.secretRegistry.forget(YOUTUBE_DATA_API_SECRET_KEY);
		},
		expectedButMissing: () => tab.plugin.secretRegistry.isRegistered(YOUTUBE_DATA_API_SECRET_KEY),
	});
}

function renderEditBlogsTrackerWorkflow(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	bindSearch(containerEl, {
		name: 'Blogs note',
		desc: 'Markdown note containing the blogs registry table (Name | Link | Method | Tags | Priority | Canon | Body). Canon and Body are optional. Canon: auto (default) | substack | strip-params | keep-params. Body: auto (default) | full | snippet — controls whether per-post bodies are ingestable.',
		placeholder: '_system/blogs/Blogs.md',
		get: () => s.orchestrationBlogsNote,
		set: (v) => { s.orchestrationBlogsNote = v.trim() || '_system/blogs/Blogs.md'; },
		suggest: (el) => { new FileSuggest(tab.app, el); },
	}, save);

	bindToggle(containerEl, {
		name: 'Diff against prior runs',
		desc: 'On: each run surfaces only posts not in any prior intake file. Off: each run surfaces every post that has no vault note (independent of prior intakes).',
		get: () => s.orchestrationBlogsTrackerDiffMode !== false,
		set: (v) => { s.orchestrationBlogsTrackerDiffMode = v; },
	}, save);

	bindToggle(containerEl, {
		name: 'Write empty intake files',
		desc: 'On: every run writes an intake file even when no new posts and no blog failures (audit trail). Off: skip writing when there is nothing to report.',
		get: () => s.orchestrationBlogsTrackerWriteEmptyRuns === true,
		set: (v) => { s.orchestrationBlogsTrackerWriteEmptyRuns = v; },
	}, save);

	bindSearch(containerEl, {
		name: 'Metadata root folder',
		desc: 'Folder where per-post blog metadata notes are saved (one subfolder per blog). These notes enrich the dashboard and are not counted as captured posts.',
		placeholder: '_blog_metadata',
		get: () => s.orchestrationBlogsMetadataRoot,
		set: (v) => { s.orchestrationBlogsMetadataRoot = v.trim() || '_blog_metadata'; },
		suggest: (el) => { new FolderSuggest(tab.app, el); },
	}, save);

	bindDropdown(containerEl, {
		name: 'Ingest command',
		desc: 'Queueable Crucible command or chain to run against a body-bearing blog metadata note when the dashboard Ingest button is clicked.',
		options: queueableCommandOptions(tab),
		get: () => s.orchestrationBlogsIngestCommandId,
		set: (v) => { s.orchestrationBlogsIngestCommandId = v; },
		width: 'pi-width-wide',
	}, save);
}

function queueableCommandOptions(tab: CrucibleSettingTab): Record<string, string> {
	const options: Record<string, string> = { '': 'Choose command...' };
	for (const cmd of tab.plugin.commandRegistry) {
		if (!cmd.queueable) continue;
		options[cmd.id] = cmd.name;
	}
	const current = tab.plugin.settings.orchestrationBlogsIngestCommandId;
	if (current && !options[current]) options[current] = `${current} (missing)`;
	return options;
}

function renderEditLinkScanWorkflow(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	bindText(containerEl, {
		name: 'Registry root',
		desc: 'Vault folder where one note per canonical URL is stored.',
		placeholder: '_crucible/link_registry',
		get: () => s.orchestrationLinkRegistryRoot,
		set: (v) => { s.orchestrationLinkRegistryRoot = v.trim() || '_crucible/link_registry'; },
	}, save);

	bindTextArea(containerEl, {
		name: 'Scan exclusions',
		desc: 'Folders to skip during link scan (one path per line). The link registry root is always excluded.',
		placeholder: '_crucible',
		get: () => s.orchestrationLinkScanExclusions.join('\n'),
		set: (v) => { s.orchestrationLinkScanExclusions = v.split('\n').map(x => x.trim()).filter(x => x.length > 0); },
	}, save);

	bindSearch(containerEl, {
		name: 'Tracked sources note',
		desc: 'Markdown note that will hold promoted tracked sources as a table (Base URL | Description | Date Added).',
		placeholder: 'Sources/Tracked Sources.md',
		get: () => s.orchestrationTrackedSourcesNote,
		set: (v) => { s.orchestrationTrackedSourcesNote = v.trim() || 'Sources/Tracked Sources.md'; },
		suggest: (el) => { new FileSuggest(tab.app, el); },
	}, save);
}
