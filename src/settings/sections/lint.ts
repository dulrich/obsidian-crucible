/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { FolderSuggest } from "../../suggesters";
import { bindToggle, bindText, bindTextArea, bindSearch } from "../bind";
import { renderLocalizeAttachmentsSettings } from "./localize";
import { LINT_STEPS } from "../../lint";
import { confirmDestructive } from "../destructiveActions";

// Prose shown for each LINT_STEPS entry in the "Lint: all pipeline" panel below. Kept
// separate from the registry itself (src/lint.ts) since the registry is also bundled into
// the node:test suite via esbuild against a minimal Obsidian stub — settings-panel copy has
// no reason to travel with it.
const LINT_STEP_DESCRIPTIONS: Record<string, string> = {
	'excluded-folder-guard': 'Skips this pipeline entirely for notes under an excluded folder (Excluded folders, below).',
	'read-and-word-count': "Reads the note and calculates its prose word count.",
	'parse-frontmatter-insert': 'Parses the Frontmatter insert template (below) into key/value pairs to insert.',
	'insert-keys': 'Inserts the parsed Frontmatter insert keys where blank. Configured by Frontmatter insert, below.',
	'created-date': 'Stamps the created date once, if blank. Configured by Created date key, below — leave that key blank to disable this step.',
	'title-stamp': 'Stamps the note title once, if blank.',
	'modified-date': "Stamps today's date on every pass. Configured by Modified date key, below — leave that key blank to disable this step.",
	'word-count': 'Writes the calculated word count to frontmatter.',
	'derive-source-ids': 'Derives yt-video-id / post-id from the source property.',
	'sort-yaml': 'Reorders frontmatter keys per Yaml key priority, below.',
	'blank-line-after-yaml': 'Ensures a blank line follows the frontmatter block. Configured by Blank line after yaml, below.',
	're-read-diff': 'Re-reads the note to determine whether this pass changed anything.',
	'dataview-refresh': 'Refreshes Dataview views when the note contains a dataview/dataviewjs fence.',
	'notice': "Shows the 'Note linted' notice (suppressed during Lint vault / Lint folder passes).",
};

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
				const noteCount = tab.app.vault.getMarkdownFiles().length;
				if (!(await confirmDestructive(tab.app, s, 'lint-vault-run', {
					message: `Run "Lint: all" on all ${noteCount} Markdown note${noteCount === 1 ? '' : 's'} in the vault? This rewrites frontmatter across the vault.`,
				}))) return;
				await tab.plugin.linter.lintVault();
			})
		);

	new Setting(containerEl).setName('Lint: all pipeline').setHeading();
	containerEl.createEl('p', { text: 'Every "Lint: all" pass (Lint note, Lint vault, and the Lint on save trigger above) runs these steps in this order. The four with a toggle can be turned off individually; the rest are pipeline mechanics or already governed by an existing setting, named below. Lint: localize attachments is a separate command and deliberately not part of this pipeline — it touches binary files and, for remote URLs, the network.' });
	const pipelineGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	LINT_STEPS.forEach((step, index) => {
		if (index > 0) pipelineGroup.createEl('hr', { cls: 'crucible-row-divider' });
		const desc = LINT_STEP_DESCRIPTIONS[step.id] ?? '';
		if (step.toggleable) {
			bindToggle(pipelineGroup, {
				name: step.label,
				desc,
				get: () => s.lintStepEnabled[step.id] !== false,
				set: (v) => { s.lintStepEnabled = { ...s.lintStepEnabled, [step.id]: v }; },
			}, save);
		} else {
			new Setting(pipelineGroup).setName(step.label).setDesc(desc);
		}
	});

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
	containerEl.createEl('p', { text: 'Exclude notes in these folders from linting, search indexing, and/or attachment localization — each independently. Excluding Localize (only) lets a folder of external images still be linted for frontmatter without pulling its images local.' });

	const ignoreGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
	if (s.excludedFolders.length > 0) {
		const header = ignoreGroup.createDiv({ cls: 'crucible-exclusion-header' });
		header.createSpan({ cls: 'crucible-exclusion-header-folder', text: 'Folder' });
		const headerScopes = header.createDiv({ cls: 'crucible-exclusion-scopes' });
		for (const label of ['Lint', 'Search', 'Localize']) {
			headerScopes.createSpan({ cls: 'crucible-exclusion-scope-col', text: label });
		}
	}
	s.excludedFolders.forEach((entry, index) => {
		if (index > 0) ignoreGroup.createEl('hr', { cls: 'crucible-mini-hr' });
		const row = ignoreGroup.createDiv({ cls: 'crucible-folder-template-row' });
		const setting = bindSearch(row, {
			placeholder: 'Folder to exclude',
			get: () => entry.folder,
			set: (v) => { entry.folder = v; },
			suggest: (el) => { el.classList.add('crucible-full-width-search'); new FolderSuggest(tab.app, el); },
		}, save);
		setting.addExtraButton(cb => { cb.setIcon('x').setTooltip('Remove').onClick(async () => {
			if (!(await confirmDestructive(tab.app, s, 'lint-excluded-folder-delete', {
				message: `Delete excluded folder "${entry.folder || '(unnamed)'}"?`,
			}))) return;
			s.excludedFolders.splice(index, 1); await save(); tab.display();
		}); });
		setting.infoEl.remove();

		const scopes = row.createDiv({ cls: 'crucible-exclusion-scopes' });
		const addScope = (label: string, tooltip: string, get: () => boolean, set: (v: boolean) => void) => {
			const scopeSetting = bindToggle(scopes, { name: label, tooltip, get, set }, save);
			scopeSetting.infoEl.remove();
			scopeSetting.settingEl.addClass('crucible-exclusion-scope-col');
		};
		addScope('Lint', 'Exclude from lint commands', () => entry.lint, (v) => { entry.lint = v; });
		addScope('Search', 'Exclude from search indexing', () => entry.search, (v) => { entry.search = v; });
		addScope('Localize', 'Exclude from attachment localization', () => entry.localize, (v) => { entry.localize = v; });
	});
	new Setting(ignoreGroup).addButton(bt => bt.setButtonText('Add excluded folder').setCta().onClick(async () => { s.excludedFolders.push({ folder: '', lint: true, search: false, localize: false }); await save(); tab.display(); }));

	renderLocalizeAttachmentsSettings(tab, containerEl);
}
