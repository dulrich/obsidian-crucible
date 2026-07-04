import { Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { FolderSuggest } from "../../suggesters";
import type { SourceEvalBudgetPeriod } from "../../types";
import { bindDropdown, bindNumber, bindSearch, bindToggle } from "../bind";

function parsePositiveInt(raw: string, fallback: number): number {
	const n = Number(raw.trim());
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function renderSourceEvalSettings(tab: CrucibleSettingTab, containerEl: HTMLElement): void {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	new Setting(containerEl).setName('Source eval dashboard').setHeading();
	containerEl.createEl('p', {
		text: 'Configure source scoring and future training-data export defaults.',
	});

	const group = containerEl.createDiv({ cls: 'crucible-settings-group' });

	bindToggle(group, {
		name: 'Enabled',
		desc: 'Enable Source Eval dashboard behavior as later dashboard features are added.',
		get: () => s.sourceEvalEnabled,
		set: (v) => { s.sourceEvalEnabled = v; },
	}, save);

	group.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(group, {
		name: 'Reading budget',
		desc: 'Target number of source words for the selected budget period.',
		placeholder: '50000',
		min: 1,
		step: 1000,
		get: () => String(s.sourceEvalReadingBudgetWords),
		set: (v) => { s.sourceEvalReadingBudgetWords = parsePositiveInt(v, 50000); },
	}, save);

	group.createEl('hr', { cls: 'crucible-row-divider' });
	bindDropdown(group, {
		name: 'Budget period',
		desc: 'Period used when comparing source output against the reading budget.',
		options: { week: 'Week', month: 'Month' },
		get: () => s.sourceEvalBudgetPeriod,
		set: (v) => { s.sourceEvalBudgetPeriod = v as SourceEvalBudgetPeriod; },
	}, save);

	group.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(group, {
		name: 'Recency half-life days',
		desc: 'Age, in days, at which a capture contributes half as much to recency-weighted scoring.',
		placeholder: '90',
		min: 1,
		get: () => String(s.sourceEvalRecencyHalfLifeDays),
		set: (v) => { s.sourceEvalRecencyHalfLifeDays = parsePositiveInt(v, 90); },
	}, save);

	group.createEl('hr', { cls: 'crucible-row-divider' });
	bindNumber(group, {
		name: 'Lookback days',
		desc: 'Window used for words-per-period and source score calculations.',
		placeholder: '180',
		min: 1,
		get: () => String(s.sourceEvalLookbackDays),
		set: (v) => { s.sourceEvalLookbackDays = parsePositiveInt(v, 180); },
	}, save);

	group.createEl('hr', { cls: 'crucible-row-divider' });
	bindSearch(group, {
		name: 'Export folder',
		desc: 'Vault folder for future Source Eval JSONL exports.',
		placeholder: '_crucible/source_eval',
		width: 'pi-width-normal',
		get: () => s.sourceEvalExportFolder,
		set: (v) => { s.sourceEvalExportFolder = v.trim() || '_crucible/source_eval'; },
		suggest: (el) => { new FolderSuggest(tab.app, el); },
	}, save);
}
