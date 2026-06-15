/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { FolderSuggest } from "../../suggesters";
import { bindToggle, bindText, bindTextArea, bindSearch } from "../bind";
import { renderLocalizeAttachmentsSettings } from "./localize";

export function renderLintSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	const s = tab.plugin.settings;
	const save = () => tab.plugin.saveSettings();

	new Setting(containerEl).setName('Automatic linting').setHeading();
	const autoLintGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	bindToggle(autoLintGroup, { name: 'Lint on save', desc: 'Automatically run the lint command when a file is modified.', get: () => s.lintOnSave, set: (v) => { s.lintOnSave = v; } }, save);

	new Setting(containerEl).setName('Manual linting').setHeading();
	const manualLintGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	new Setting(manualLintGroup)
		.setName('Lint vault')
		.setDesc('Run the lint command on every Markdown file in your vault. Warning: This can be slow for large vaults.')
		.addButton(bt => bt
			.setButtonText('Lint Vault')
			.setWarning()
			.onClick(async () => {
				await tab.plugin.linter.lintVault();
			})
		);

	new Setting(containerEl).setName('Date keys').setHeading();
	const dateGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	bindText(dateGroup, { name: 'Created date key', desc: 'Property key for the creation date.', placeholder: 'created', get: () => s.lintCreatedKey, set: (v) => { s.lintCreatedKey = v; } }, save);
	dateGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindText(dateGroup, { name: 'Modified date key', desc: 'Property key for the last modified date.', placeholder: 'updated', get: () => s.lintModifiedKey, set: (v) => { s.lintModifiedKey = v; } }, save);

	new Setting(containerEl).setName('Formatting').setHeading();
	const formattingGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	bindToggle(formattingGroup, { name: 'Blank line after yaml', desc: 'Ensure there is at least one blank line after the frontmatter.', get: () => s.lintBlankLineAfterYaml, set: (v) => { s.lintBlankLineAfterYaml = v; } }, save);

	formattingGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindTextArea(formattingGroup, { name: 'Yaml key priority', desc: 'Keys to move to the top of frontmatter (one per line).', placeholder: 'title\ncreated\nupdated', get: () => s.lintYamlKeyPriority.join('\n'), set: (v) => { s.lintYamlKeyPriority = v.split('\n').map(x => x.trim()).filter(x => x); } }, save);

	formattingGroup.createEl('hr', { cls: 'crucible-row-divider' });
	bindTextArea(formattingGroup, { name: 'Frontmatter insert', desc: 'Text to ensure exists in the frontmatter (supports template variables).', placeholder: 'tags: \nstatus: ', get: () => s.lintFrontmatterInsert, set: (v) => { s.lintFrontmatterInsert = v; } }, save);

	containerEl.createEl('hr');
	new Setting(containerEl).setName('Excluded folders').setHeading();
	containerEl.createEl('p', { text: 'Notes in these folders can be excluded from linting, search indexing, or both.' });

	const ignoreGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	s.excludedFolders.forEach((entry, index) => {
		if (index > 0) ignoreGroup.createEl('hr', { cls: 'crucible-mini-hr' });
		const row = ignoreGroup.createDiv({ cls: 'crucible-folder-template-row' });
		const setting = bindSearch(row, {
			placeholder: 'Folder to exclude',
			get: () => entry.folder,
			set: (v) => { entry.folder = v; },
			suggest: (el) => { el.classList.add('crucible-full-width-search'); new FolderSuggest(tab.app, el); },
		}, save);
		setting.addExtraButton(cb => { cb.setIcon('trash').onClick(async () => { s.excludedFolders.splice(index, 1); await save(); tab.display(); }); });
		setting.infoEl.remove();

		const scopes = row.createDiv({ cls: 'crucible-exclusion-scopes' });
		const lintSetting = bindToggle(scopes, {
			name: 'Lint',
			tooltip: 'Exclude from lint commands',
			get: () => entry.lint,
			set: (v) => { entry.lint = v; },
		}, save);
		lintSetting.infoEl.remove();
		const searchSetting = bindToggle(scopes, {
			name: 'Search',
			tooltip: 'Exclude from search indexing',
			get: () => entry.search,
			set: (v) => { entry.search = v; },
		}, save);
		searchSetting.infoEl.remove();
	});
	new Setting(ignoreGroup).addButton(bt => bt.setButtonText('Add excluded folder').setCta().onClick(async () => { s.excludedFolders.push({ folder: '', lint: true, search: false }); await save(); tab.display(); }));

	renderLocalizeAttachmentsSettings(tab, containerEl);
}
