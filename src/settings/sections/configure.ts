/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { ToCPosition, ToCCollapseBehavior, Surround } from "../../types";
import { FileSuggest, FolderSuggest } from "../../suggesters";
import { PERIOD_IDS, PeriodId, getPeriodConfig } from "../../periods";
import { SearchWithContainer, addWarningIcon } from "../shared";
import { bindToggle, bindDropdown, bindSearch } from "../bind";
import { applySurround } from "../../surround";
import { DESTRUCTIVE_ACTIONS, DestructiveTier, resolveConfirmRequired } from "../destructiveActions";

export function renderConfigureSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	new Setting(containerEl).setName('Appearance').setHeading();
	const appearanceGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	bindDropdown(appearanceGroup, {
		name: 'Surround',
		desc: 'Operational surface tone for the N1 Console theme (dark, med, or light). Requires the "Crucible N1 Console" theme — enable it in Appearance → Themes. Also sets Obsidian\'s base theme (Dark for Dark/Med, Light for Light), taking you off the "system" appearance setting.',
		options: { dark: 'Dark', med: 'Med', light: 'Light' },
		get: () => s.surround,
		set: (v) => { s.surround = v as Surround; },
		after: () => applySurround(tab.plugin.app, s.surround),
	}, save);

	new Setting(containerEl).setName('Table of contents').setHeading();
	const tocGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });

	bindToggle(tocGroup, {
		name: 'Show table of contents',
		desc: 'Add a floating, collapsible table of contents to markdown views.',
		get: () => s.showToC,
		set: (v) => { s.showToC = v; },
		after: () => { tab.plugin.refreshToC(); tab.display(); },
	}, save);

	if (s.showToC) {
		tocGroup.createEl('hr', { cls: 'crucible-row-divider' });
		bindDropdown(tocGroup, {
			name: 'Position',
			options: { 'bottom-right': 'Bottom right', 'bottom-left': 'Bottom left', 'top-left': 'Top left', 'top-right': 'Top right' },
			get: () => s.tocPosition,
			set: (v) => { s.tocPosition = v as ToCPosition; },
			after: () => tab.plugin.refreshToC(),
		}, save);

		tocGroup.createEl('hr', { cls: 'crucible-row-divider' });
		bindDropdown(tocGroup, {
			name: 'Collapse behavior',
			desc: 'How the table of contents should automatically collapse.',
			options: { manual: 'Manual', click: 'Collapse on click', blur: 'Collapse on blur' },
			get: () => s.tocCollapseBehavior,
			set: (v) => { s.tocCollapseBehavior = v as ToCCollapseBehavior; },
			after: () => tab.plugin.refreshToC(),
		}, save);
	}

	new Setting(containerEl).setName('Period notes').setHeading();
	containerEl.createEl('p', { text: 'Configure daily, weekly, and monthly notes, asset folders, templates, and move-folder pins.' });
	PERIOD_IDS.forEach(period => renderPeriodSettingsBlock(tab, containerEl, period));
	renderPinnedFoldersSettings(tab, containerEl);

	new Setting(containerEl).setName('Folder templates').setHeading();
	containerEl.createEl('p', { text: 'Map arbitrary folders to templates. These will be applied automatically when a new file is created in the folder.' });

	const folderTemplatesGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });

	s.folderTemplates.forEach((ft, index) => {
		if (index > 0) folderTemplatesGroup.createEl('hr', { cls: 'crucible-mini-hr' });
		const row = folderTemplatesGroup.createDiv({ cls: 'crucible-folder-template-row' });
		const setting = new Setting(row)
			.addSearch(cb => {
				cb.setPlaceholder('Folder').setValue(ft.folder).onChange(async (v) => { ft.folder = v; await save(); });
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FolderSuggest(tab.app, cb.inputEl);
			})
			.addSearch(cb => {
				cb.setPlaceholder('Template').setValue(ft.template).onChange(async (v) => { ft.template = v; await save(); });
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FileSuggest(tab.app, cb.inputEl);
			})
			.addExtraButton(cb => {
				cb.setIcon('trash').onClick(async () => { s.folderTemplates.splice(index, 1); await save(); tab.display(); });
			});
		setting.infoEl.remove();
	});

	new Setting(folderTemplatesGroup).addButton(bt => bt.setButtonText('Add folder template').setCta().onClick(async () => { s.folderTemplates.push({ folder: '', template: '' }); await save(); tab.display(); }));

	new Setting(containerEl).setName('Template variables').setHeading();
	const desc = containerEl.createDiv({ cls: 'crucible-variables-desc' });
	desc.createEl('p', { text: 'Use these tokens in your template files. They will be replaced when a note is "materialized" or created in a mapped folder.' });
	tab.renderTemplateVariableGrid(containerEl, tab.captureTemplateVariables());

	renderDestructiveConfirmationsSettings(tab, containerEl);
}

const DESTRUCTIVE_TIERS: DestructiveTier[] = ['critical', 'high', 'medium', 'low'];
const DESTRUCTIVE_TIER_LABELS: Record<DestructiveTier, string> = {
	critical: 'Critical',
	high: 'High',
	medium: 'Medium',
	low: 'Low',
};

// clsl-WP-3: framework only — see src/settings/destructiveActions.ts. This renders the
// registry's settings surface; wiring individual delete handlers through
// `confirmDestructive` is WP-4.
function renderDestructiveConfirmationsSettings(tab: CrucibleSettingTab, containerEl: HTMLElement): void {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	new Setting(containerEl).setName('Destructive action confirmations').setHeading();
	containerEl.createEl('p', { text: 'Destructive actions ask for confirmation by default. Turn confirmations off globally, per tier, or per action.' });

	const overviewGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	bindToggle(overviewGroup, {
		name: 'Confirm destructive actions',
		desc: 'Global default for every destructive action below. Per-tier and per-action toggles override this.',
		get: () => s.destructiveConfirmGlobal,
		set: (v) => { s.destructiveConfirmGlobal = v; },
	}, save);

	DESTRUCTIVE_TIERS.forEach(tier => {
		overviewGroup.createEl('hr', { cls: 'crucible-row-divider' });
		bindToggle(overviewGroup, {
			name: `${DESTRUCTIVE_TIER_LABELS[tier]} actions`,
			desc: `Overrides the global default for every ${DESTRUCTIVE_TIER_LABELS[tier].toLowerCase()}-tier action, unless a specific action below overrides it further.`,
			// Tri-state is NOT modeled in the UI: this shows the tier's EFFECTIVE value (the
			// explicit tier override if one is stored, else the global default) — flipping the
			// toggle always writes an explicit per-tier override to destructiveConfirmTier,
			// even when the new value happens to match the global default it was inheriting.
			get: () => s.destructiveConfirmTier[tier] ?? s.destructiveConfirmGlobal,
			set: (v) => { s.destructiveConfirmTier = { ...s.destructiveConfirmTier, [tier]: v }; },
		}, save);
	});

	DESTRUCTIVE_TIERS.forEach(tier => {
		const actions = DESTRUCTIVE_ACTIONS.filter(a => a.tier === tier);
		if (actions.length === 0) return;

		new Setting(containerEl).setName(`${DESTRUCTIVE_TIER_LABELS[tier]} actions`).setHeading();
		const tierGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
		actions.forEach((action, index) => {
			if (index > 0) tierGroup.createEl('hr', { cls: 'crucible-row-divider' });
			bindToggle(tierGroup, {
				name: action.label,
				desc: `${action.group} · resolves from the ${DESTRUCTIVE_TIER_LABELS[tier]} tier / global default unless overridden here.`,
				// Same effective-value display as the tier toggles above: shows
				// resolveConfirmRequired's current answer, writes an explicit per-action override.
				get: () => resolveConfirmRequired(s, action.id),
				set: (v) => { s.destructiveConfirmAction = { ...s.destructiveConfirmAction, [action.id]: v }; },
			}, save);
		});
	});
}

function renderPeriodSettingsBlock(tab: CrucibleSettingTab, containerEl: HTMLElement, period: PeriodId): void {
	const config = getPeriodConfig(tab.plugin.settings, period);
	const save = () => tab.plugin.saveSettings();
	const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
	if (!config.enabled) group.addClass('is-disabled');

	const header = bindToggle(group, {
		name: `${config.label} notes`,
		desc: `${config.label} note files are created under ${config.folder || config.exampleFolder}.`,
		tooltip: 'Enabled',
		get: () => config.enabled,
		set: (v) => { tab.plugin.settings[config.enabledKey] = v as never; },
		after: () => tab.display(),
	}, save);
	if (!config.enabled) {
		addWarningIcon(header.nameEl, `${config.label} commands, captures, and automation will show a warning and not run.`);
		header.descEl.createEl('div', {
			cls: 'crucible-setting-warning',
			text: `${config.label} is disabled. Related commands and automation will not run.`,
		});
	}

	group.createEl('hr', { cls: 'crucible-row-divider' });
	bindSearch(group, {
		name: `${config.label} folder`,
		desc: `${config.label} note root. Notes use ${config.folder || config.exampleFolder}/<period>.md.`,
		placeholder: config.exampleFolder,
		get: () => config.folder,
		set: (v) => { tab.plugin.settings[config.folderKey] = v as never; },
		suggest: (el) => { new FolderSuggest(tab.app, el); },
	}, save);

	group.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(group, {
		name: 'Create asset folder',
		desc: `Also create ${config.folder || config.exampleFolder}/<period>/ beside the note.`,
		get: () => config.createAssetFolder,
		set: (v) => { tab.plugin.settings[config.assetFolderKey] = v as never; },
	}, save);

	group.createEl('hr', { cls: 'crucible-row-divider' });
	const templateSetting = bindSearch(group, {
		name: `${config.label} template`,
		desc: `Template applied when a ${config.lowerLabel} note is created or materialized.`,
		placeholder: config.exampleTemplate,
		get: () => config.template,
		set: (v) => { tab.plugin.settings[config.templateKey] = v as never; },
		suggest: (el) => { new FileSuggest(tab.app, el); },
	}, save);
	tab.addTemplateVariablesToggle(templateSetting, `period-${period}-template`, tab.periodTemplateVariables());
	tab.renderTemplateVariablesPanel(group, `period-${period}-template`, tab.periodTemplateVariables());

	group.createEl('hr', { cls: 'crucible-row-divider' });
	bindToggle(group, {
		name: 'Pin in move picker',
		desc: `Show the current ${config.lowerLabel} asset folder above normal results in "Move current file to folder...".`,
		get: () => config.pinInMovePicker,
		set: (v) => { tab.plugin.settings[config.movePinKey] = v as never; },
	}, save);
}

function renderPinnedFoldersSettings(tab: CrucibleSettingTab, containerEl: HTMLElement): void {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();
	new Setting(containerEl).setName('Pinned folders').setHeading();
	containerEl.createEl('p', { text: 'Additional folders shown after enabled Daily/Weekly/Monthly pins in the move-folder picker.' });

	const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
	const pinnedFolders = s.moveFilePinnedFolders;
	if (pinnedFolders.length === 0) {
		group.createDiv({ text: 'No pinned folders configured.', cls: 'crucible-empty-state' });
	} else {
		pinnedFolders.forEach((folder, index) => {
			if (index > 0) group.createEl('hr', { cls: 'crucible-mini-hr' });
			const row = group.createDiv({ cls: 'crucible-folder-template-row' });
			const setting = bindSearch(row, {
				placeholder: 'Folder',
				get: () => folder,
				set: (v) => { s.moveFilePinnedFolders[index] = v; },
				suggest: (el) => { new FolderSuggest(tab.app, el); },
			}, save);
			setting.addExtraButton(cb => {
				cb.setIcon('trash')
					.setTooltip('Remove pinned folder')
					.onClick(async () => {
						s.moveFilePinnedFolders.splice(index, 1);
						await save();
						tab.display();
					});
			});
			setting.infoEl.remove();
		});
	}
	new Setting(group).addButton(bt => bt.setButtonText('Add pinned folder').setCta().onClick(async () => {
		s.moveFilePinnedFolders.push('');
		await save();
		tab.display();
	}));
}
