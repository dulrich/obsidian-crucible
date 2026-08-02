/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { isValidTimezone } from "../../orchestration/utils/dates";
import { bindToggle, bindText, bindNumber } from "../bind";
import type { JobType } from "../../orchestration/types";

/**
 * WP-rem-R4 (F4) — the "queue" half of the Orchestrate tab: the global queue settings group,
 * routine-notice toggles, trigger toggles, and the Scan/Run-next action buttons.
 * `sections/orchestration.ts` calls these in the same relative positions the inline blocks used to
 * occupy (notices and global settings are adjacent; triggers and actions are rendered later, after
 * the Search panel and the Workflows list, matching the pre-split DOM order exactly).
 */

const ROUTINE_NOTICE_JOB_TYPES: JobType[] = [
	'daily_brief_lite',
	'youtube_tracker',
	'youtube_tracker_consolidate',
	'blogs_tracker',
	'blogs_tracker_consolidate',
	'transcript_refine',
	'link_scan',
	'note_link_enrich',
	'youtube_metadata_fetch',
	'x_metadata_fetch',
	'x_post_discover',
	'command_run',
	'image_describe_note',
	'image_describe_backfill',
	'image_describe_batch',
	'search_rebuild',
	'search_embed_missing',
	'search_upsert_file',
	'search_upsert_batch',
	'search_delete_path',
	'search_sweep',
];

export function renderOrchestrationQueueGlobalSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

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
	bindNumber(globalGroup, {
		name: 'Job retention (days)',
		desc: 'How long done/failed/cancelled history is kept in the jobs database before it is pruned. Blank or 0 keeps it forever.',
		placeholder: '30',
		width: 'pi-width-half',
		get: () => String(s.orchestrationJobRetentionDays),
		set: (v) => { const n = Number(v.trim()); s.orchestrationJobRetentionDays = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30; },
		min: 0,
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
}

export function renderRoutineNoticesSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

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
}

export function renderTriggersSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

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
}

export function renderQueueActionsSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
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
}
