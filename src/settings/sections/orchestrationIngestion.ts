/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { FolderSuggest } from "../../suggesters";
import { bindToggle, bindSearch, bindNumber } from "../bind";
import { addWarningIcon } from "../shared";
import { isYoutubeApiKeyRegistered, YOUTUBE_API_KEY_MISSING_HINT } from "../../ingestion/render/apiKeyAffordance";

/**
 * WP-rem-R4 (F4) — the "Ingestion dashboard" settings panel, split out of `orchestration.ts`.
 */
export function renderIngestionDashboardSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

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
	const autoEnqueueSetting = bindToggle(ingestionGroup, {
		name: 'Auto-enqueue YouTube metadata',
		desc: 'When on, uncaptured videos (and captures that gain a yt-video-id) are automatically enqueued for metadata enrichment. This only ENQUEUES — whether those jobs execute is governed by the youtube_metadata_fetch auto-run in the dashboard Queue Configuration. Requires a configured API key.',
		get: () => s.ingestionYoutubeAutoEnqueueEnabled === true,
		set: (v) => { s.ingestionYoutubeAutoEnqueueEnabled = v; },
		// setEnrichmentAutoEnqueue owns the source enable (flag + queue auto-source
		// enable). No auto-source pushed here — that stays whatever the dashboard
		// registered, since its items follow the dashboard's sort.
		after: async () => {
			await tab.plugin.setEnrichmentAutoEnqueue(s.ingestionYoutubeAutoEnqueueEnabled === true);
		},
	}, save);
	// WP-VF-3: the toggle stays operable when the key is missing — it's a
	// preference, not the key — this only explains why auto-enqueue isn't
	// actually enqueueing anything yet. Re-evaluated on every settings display(),
	// so it clears the moment the key is configured.
	if (!isYoutubeApiKeyRegistered(tab.plugin)) {
		addWarningIcon(autoEnqueueSetting.nameEl, YOUTUBE_API_KEY_MISSING_HINT);
		autoEnqueueSetting.addButton(btn => btn
			.setButtonText('Configure…')
			.onClick(() => tab.openToTab('orchestrator')));
	}

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

	ingestionGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindSearch(ingestionGroup, {
		name: 'X metadata folder',
		desc: 'Materialized X posts (fetched via oEmbed — author, date, post HTML) land here, one note per status id. See the "X posts" dashboard section.',
		placeholder: '_x_metadata',
		get: () => s.orchestrationXMetadataRoot,
		set: (v) => { s.orchestrationXMetadataRoot = v.trim() || '_x_metadata'; },
		suggest: (el) => { new FolderSuggest(tab.app, el); },
	}, save);

	ingestionGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(ingestionGroup, {
		name: 'Auto-discover X links in clipper inbox',
		desc: 'When on, clipping or editing a note under the clipper inbox enqueues an x_post_discover job for it, which fetches metadata for any X links it finds. This only covers new clips — for notes already in the vault, run "Orchestrator: link scan" first, then use the X posts section\'s "Backfill from registry" button (backfill only covers link-registry records the scan has already found).',
		get: () => s.ingestionXAutoDiscoverEnabled === true,
		set: (v) => { s.ingestionXAutoDiscoverEnabled = v; },
	}, save);
}
