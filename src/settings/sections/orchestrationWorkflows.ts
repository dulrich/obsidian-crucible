/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting, Notice, TextComponent } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { CurrencyCache, GeocodeCacheEntry } from "../../types";
import { FileSuggest, FolderSuggest, CurrencySuggest, LocationSuggest } from "../../suggesters";
import { YOUTUBE_DATA_API_SECRET_KEY, deleteYoutubeApiKey, loadYoutubeApiKey, storeYoutubeApiKey } from "../../orchestration/utils/youtubeApi";
import { mountSecretControl } from "../shared";
import { confirmDestructive } from "../destructiveActions";
import { bindToggle, bindText, bindNumber, bindSearch, bindTextArea, bindDropdown } from "../bind";

/**
 * WP-rem-R4 (F4) — the five per-workflow editors (`WorkflowMeta.render` in
 * `sections/orchestration.ts`), split out of the original `orchestration.ts` monolith. Each
 * function renders into the `containerEl` the entry file's edit-workflow routing already created;
 * none of them manage the `editingWorkflowId` state themselves.
 */

export function renderEditDailyBriefWorkflow(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	bindText(containerEl, {
		name: 'Target section',
		desc: 'Header to inject the brief under (e.g. # Daily Brief). If empty, defaults to "Daily Brief: External Context".',
		placeholder: '# Daily Brief: External Context',
		get: () => s.orchestrationDailyBriefTargetSection,
		set: (v) => { s.orchestrationDailyBriefTargetSection = v; },
	}, save);

	renderCurrencyPairsEditor(tab, containerEl);
	renderWeatherLocationsEditor(tab, containerEl);
}

function renderCurrencyPairsEditor(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

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
				if (!(await confirmDestructive(tab.app, s, 'fx-pair-delete', {
					message: `Delete FX pair "${pair.label || `${pair.base} -> ${pair.quote}` || '(unnamed)'}"?`,
				}))) return;
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
}

function renderWeatherLocationsEditor(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

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
				if (!(await confirmDestructive(tab.app, s, 'weather-location-delete', {
					message: `Delete weather location "${loc.label || '(unnamed)'}"?`,
				}))) return;
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

export function renderEditTranscriptRefineWorkflow(tab: CrucibleSettingTab, containerEl: HTMLElement) {
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

export function renderEditYoutubeTrackerWorkflow(tab: CrucibleSettingTab, containerEl: HTMLElement) {
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
		load: () => loadYoutubeApiKey(tab.plugin),
		store: (v) => storeYoutubeApiKey(tab.plugin, v),
		clear: () => deleteYoutubeApiKey(tab.plugin),
		expectedButMissing: () => tab.plugin.secretRegistry.isRegistered(YOUTUBE_DATA_API_SECRET_KEY),
		confirm: {
			app: tab.app,
			settings: tab.plugin.settings,
			message: 'Clear the stored YouTube Data API key? The per-video metadata fetch command will fail until a new key is set.',
		},
	});
}

export function renderEditBlogsTrackerWorkflow(tab: CrucibleSettingTab, containerEl: HTMLElement) {
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

export function renderEditLinkScanWorkflow(tab: CrucibleSettingTab, containerEl: HTMLElement) {
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
