/* eslint-disable obsidianmd/ui/sentence-case */
import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import PersonalInternetPlugin from "./main";
import { FileSuggest, FolderSuggest } from "./suggesters";
import { CaptureTarget, ToCPosition, ToCCollapseBehavior } from "./types";

interface SearchWithContainer {
	containerEl: HTMLElement;
}

export class PersonalInternetSettingTab extends PluginSettingTab {
	plugin: PersonalInternetPlugin;
	private activeTab: 'settings' | 'variables' | 'lint' | 'shortcuts' | 'captures' = 'settings';

	constructor(app: App, plugin: PersonalInternetPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const focusTrap = containerEl.createEl('button', { cls: 'personal-internet-focus-trap' });
		requestAnimationFrame(() => focusTrap.focus());

		const navBar = containerEl.createDiv({ cls: 'personal-internet-tab-nav' });
		
		const createTab = (id: typeof this.activeTab, icon: string, label: string) => {
			const btn = navBar.createDiv({ 
				cls: `personal-internet-tab-btn ${this.activeTab === id ? 'is-active' : ''}` 
			});
			setIcon(btn, icon);
			btn.createSpan({ text: ` ${label}` });
			btn.onclick = () => {
				this.activeTab = id;
				this.display();
			};
		};

		createTab('settings', 'settings', 'Settings');
		createTab('shortcuts', 'link', 'Shortcuts');
		createTab('captures', 'edit-3', 'Captures');
		createTab('lint', 'check-circle', 'Lint');
		createTab('variables', 'info', 'Variables');

		containerEl.createEl('hr', { cls: 'personal-internet-tab-hr' });

		if (this.activeTab === 'settings') {
			this.renderSettings(containerEl);
		} else if (this.activeTab === 'lint') {
			this.renderLintSettings(containerEl);
		} else if (this.activeTab === 'shortcuts') {
			this.renderShortcutSettings(containerEl);
		} else if (this.activeTab === 'captures') {
			this.renderCaptureSettings(containerEl);
		} else {
			this.renderVariables(containerEl);
		}
	}

	private renderSettings(containerEl: HTMLElement) {
		new Setting(containerEl).setName('Table of contents').setHeading();
		const tocGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });

		new Setting(tocGroup)
			.setName('Show table of contents')
			.setDesc('Add a floating, collapsible table of contents to markdown views.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showToC)
				.onChange(async (value) => {
					this.plugin.settings.showToC = value;
					await this.plugin.saveSettings();
					this.plugin.refreshToC();
					this.display();
				}));

		if (this.plugin.settings.showToC) {
			tocGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
			new Setting(tocGroup)
				.setName('Position')
				.addDropdown(dd => {
					dd.addOption('bottom-right', 'Bottom right')
					  .addOption('bottom-left', 'Bottom left')
					  .addOption('top-left', 'Top left')
					  .addOption('top-right', 'Top right')
					  .setValue(this.plugin.settings.tocPosition)
					  .onChange(async (value: ToCPosition) => {
						  this.plugin.settings.tocPosition = value;
						  await this.plugin.saveSettings();
						  this.plugin.refreshToC();
					  });
				});

			tocGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
			new Setting(tocGroup)
				.setName('Collapse behavior')
				.setDesc('How the table of contents should automatically collapse.')
				.addDropdown(dd => {
					dd.addOption('manual', 'Manual')
					  .addOption('click', 'Collapse on click')
					  .addOption('blur', 'Collapse on blur')
					  .setValue(this.plugin.settings.tocCollapseBehavior)
					  .onChange(async (value: ToCCollapseBehavior) => {
						  this.plugin.settings.tocCollapseBehavior = value;
						  await this.plugin.saveSettings();
						  this.plugin.refreshToC();
					  });
				});
		}

		new Setting(containerEl).setName('Folders').setHeading();
		const foldersGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });

		new Setting(foldersGroup)
			.setName('Daily folder')
			.setDesc('Folder for daily notes and day-specific assets.')
			.addSearch(cb => {
				cb.setPlaceholder('daily/day')
					.setValue(this.plugin.settings.dailyFolder)
					.onChange(async (value) => {
						this.plugin.settings.dailyFolder = value;
						await this.plugin.saveSettings();
					});
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('personal-internet-search-container');
				new FolderSuggest(this.app, cb.inputEl);
			});

		foldersGroup.createEl('hr', { cls: 'personal-internet-row-divider' });

		new Setting(foldersGroup)
			.setName('Weekly folder')
			.setDesc('Folder for weekly notes.')
			.addSearch(cb => {
				cb.setPlaceholder('daily/week')
					.setValue(this.plugin.settings.weeklyFolder)
					.onChange(async (value) => {
						this.plugin.settings.weeklyFolder = value;
						await this.plugin.saveSettings();
					});
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('personal-internet-search-container');
				new FolderSuggest(this.app, cb.inputEl);
			});

		foldersGroup.createEl('hr', { cls: 'personal-internet-row-divider' });

		new Setting(foldersGroup)
			.setName('Monthly folder')
			.setDesc('Folder for monthly notes.')
			.addSearch(cb => {
				cb.setPlaceholder('daily/month')
					.setValue(this.plugin.settings.monthlyFolder)
					.onChange(async (value) => {
						this.plugin.settings.monthlyFolder = value;
						await this.plugin.saveSettings();
					});
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('personal-internet-search-container');
				new FolderSuggest(this.app, cb.inputEl);
			});

		new Setting(containerEl).setName('Core templates').setHeading();
		const templatesGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });

		new Setting(templatesGroup)
			.setName('Daily template')
			.setDesc('Path to the daily note template file.')
			.addSearch(cb => {
				cb.setPlaceholder('templates/daily.md')
					.setValue(this.plugin.settings.dailyTemplate)
					.onChange(async (value) => {
						this.plugin.settings.dailyTemplate = value;
						await this.plugin.saveSettings();
					});
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('personal-internet-search-container');
				new FileSuggest(this.app, cb.inputEl);
			});

		templatesGroup.createEl('hr', { cls: 'personal-internet-row-divider' });

		new Setting(templatesGroup)
			.setName('Weekly template')
			.setDesc('Path to the weekly note template file.')
			.addSearch(cb => {
				cb.setPlaceholder('templates/weekly.md')
					.setValue(this.plugin.settings.weeklyTemplate)
					.onChange(async (value) => {
						this.plugin.settings.weeklyTemplate = value;
						await this.plugin.saveSettings();
					});
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('personal-internet-search-container');
				new FileSuggest(this.app, cb.inputEl);
			});

		templatesGroup.createEl('hr', { cls: 'personal-internet-row-divider' });

		new Setting(templatesGroup)
			.setName('Monthly template')
			.setDesc('Path to the monthly note template file.')
			.addSearch(cb => {
				cb.setPlaceholder('templates/monthly.md')
					.setValue(this.plugin.settings.monthlyTemplate)
					.onChange(async (value) => {
						this.plugin.settings.monthlyTemplate = value;
						await this.plugin.saveSettings();
					});
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('personal-internet-search-container');
				new FileSuggest(this.app, cb.inputEl);
			});

		containerEl.createEl('hr');
		new Setting(containerEl).setName('Folder templates').setHeading();
		containerEl.createEl('p', { text: 'Map arbitrary folders to templates. These will be applied automatically when a new file is created in the folder.' });

		const folderTemplatesGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });

		this.plugin.settings.folderTemplates.forEach((ft, index) => {
			if (index > 0) folderTemplatesGroup.createEl('hr', { cls: 'personal-internet-mini-hr' });
			const row = folderTemplatesGroup.createDiv({ cls: 'personal-internet-folder-template-row' });
			const s = new Setting(row)
				.addSearch(cb => {
					cb.setPlaceholder('Folder').setValue(ft.folder).onChange(async (v) => { ft.folder = v; await this.plugin.saveSettings(); });
					const el = (cb as unknown as SearchWithContainer).containerEl;
					if (el) el.addClass('personal-internet-search-container');
					new FolderSuggest(this.app, cb.inputEl);
				})
				.addSearch(cb => {
					cb.setPlaceholder('Template').setValue(ft.template).onChange(async (v) => { ft.template = v; await this.plugin.saveSettings(); });
					const el = (cb as unknown as SearchWithContainer).containerEl;
					if (el) el.addClass('personal-internet-search-container');
					new FileSuggest(this.app, cb.inputEl);
				})
				.addExtraButton(cb => {
					cb.setIcon('trash').onClick(async () => { this.plugin.settings.folderTemplates.splice(index, 1); await this.plugin.saveSettings(); this.display(); });
				});
			s.infoEl.remove();
		});

		new Setting(folderTemplatesGroup).addButton(bt => bt.setButtonText('Add folder template').setCta().onClick(async () => { this.plugin.settings.folderTemplates.push({ folder: '', template: '' }); await this.plugin.saveSettings(); this.display(); }));
	}

	private renderLintSettings(containerEl: HTMLElement) {
		new Setting(containerEl).setName('Automatic linting').setHeading();
		const autoLintGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });
		new Setting(autoLintGroup).setName('Lint on save').setDesc('Automatically run the lint command when a file is modified.').addToggle(t => t.setValue(this.plugin.settings.lintOnSave).onChange(async (v) => { this.plugin.settings.lintOnSave = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl).setName('Date tracking').setHeading();
		const dateGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });
		new Setting(dateGroup).setName('Created date key').setDesc('Property key for the creation date.').addText(t => t.setPlaceholder('created').setValue(this.plugin.settings.lintCreatedKey).onChange(async (v) => { this.plugin.settings.lintCreatedKey = v; await this.plugin.saveSettings(); }));
		dateGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
		new Setting(dateGroup).setName('Modified date key').setDesc('Property key for the last modified date.').addText(t => t.setPlaceholder('updated').setValue(this.plugin.settings.lintModifiedKey).onChange(async (v) => { this.plugin.settings.lintModifiedKey = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl).setName('Formatting').setHeading();
		const formattingGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });
		new Setting(formattingGroup).setName('Blank line after yaml').setDesc('Ensure there is at least one blank line after the frontmatter.').addToggle(t => t.setValue(this.plugin.settings.lintBlankLineAfterYaml).onChange(async (v) => { this.plugin.settings.lintBlankLineAfterYaml = v; await this.plugin.saveSettings(); }));
		
		const autoSize = (el: HTMLTextAreaElement) => { 
			el.setCssProps({ height: 'auto' });
			el.setCssProps({ height: `${el.scrollHeight}px` });
		};

		formattingGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
		new Setting(formattingGroup).setName('Yaml key priority').setDesc('Keys to move to the top of frontmatter (one per line).').addTextArea(t => {
			t.setPlaceholder('title\ncreated\nupdated').setValue(this.plugin.settings.lintYamlKeyPriority.join('\n')).onChange(async (v) => { this.plugin.settings.lintYamlKeyPriority = v.split('\n').map(s => s.trim()).filter(s => s); await this.plugin.saveSettings(); autoSize(t.inputEl); });
			t.inputEl.addClass('personal-internet-setting-textarea'); requestAnimationFrame(() => autoSize(t.inputEl));
		});

		formattingGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
		new Setting(formattingGroup).setName('Frontmatter insert').setDesc('Text to ensure exists in the frontmatter (supports template variables).').addTextArea(t => {
			t.setPlaceholder('tags: \nstatus: ').setValue(this.plugin.settings.lintFrontmatterInsert).onChange(async (v) => { this.plugin.settings.lintFrontmatterInsert = v; await this.plugin.saveSettings(); autoSize(t.inputEl); });
			t.inputEl.addClass('personal-internet-setting-textarea'); requestAnimationFrame(() => autoSize(t.inputEl));
		});

		containerEl.createEl('hr');
		new Setting(containerEl).setName('Excluded folders').setHeading();
		containerEl.createEl('p', { text: 'Notes in these folders will be ignored by all lint commands.' });

		const ignoreGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });
		this.plugin.settings.lintIgnoredFolders.forEach((folder, index) => {
			if (index > 0) ignoreGroup.createEl('hr', { cls: 'personal-internet-mini-hr' });
			const row = ignoreGroup.createDiv({ cls: 'personal-internet-folder-template-row' });
			const s = new Setting(row).addSearch(cb => {
				cb.setPlaceholder('Folder to ignore').setValue(folder).onChange(async (v) => { this.plugin.settings.lintIgnoredFolders[index] = v; await this.plugin.saveSettings(); });
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('personal-internet-search-container');
				cb.inputEl.classList.add('personal-internet-full-width-search');
				new FolderSuggest(this.app, cb.inputEl);
			}).addExtraButton(cb => { cb.setIcon('trash').onClick(async () => { this.plugin.settings.lintIgnoredFolders.splice(index, 1); await this.plugin.saveSettings(); this.display(); }); });
			s.infoEl.remove();
		});
		new Setting(ignoreGroup).addButton(bt => bt.setButtonText('Add ignored folder').setCta().onClick(async () => { this.plugin.settings.lintIgnoredFolders.push(''); await this.plugin.saveSettings(); this.display(); }));
	}

	private renderShortcutSettings(containerEl: HTMLElement) {
		new Setting(containerEl).setName('Command shortcuts').setHeading();
		containerEl.createEl('p', { text: 'Create custom commands to open specific files directly from the Command Palette.' });
		const group = containerEl.createDiv({ cls: 'personal-internet-settings-group' });
		this.plugin.settings.shortcuts.forEach((shortcut, index) => {
			if (index > 0) group.createEl('hr', { cls: 'personal-internet-mini-hr' });
			const row = group.createDiv({ cls: 'personal-internet-folder-template-row' });
			const s = new Setting(row).addText(t => t.setPlaceholder('Shortcut name').setValue(shortcut.name).onChange(async (v) => { shortcut.name = v; await this.plugin.saveSettings(); this.plugin.registerShortcuts(); }))
				.addSearch(cb => {
					cb.setPlaceholder('File to open').setValue(shortcut.file).onChange(async (v) => { shortcut.file = v; await this.plugin.saveSettings(); this.plugin.registerShortcuts(); });
					const el = (cb as unknown as SearchWithContainer).containerEl;
					if (el) el.addClass('personal-internet-search-container');
					new FileSuggest(this.app, cb.inputEl);
				})
				.addExtraButton(cb => { cb.setIcon('trash').onClick(async () => { this.plugin.settings.shortcuts.splice(index, 1); await this.plugin.saveSettings(); this.plugin.registerShortcuts(); this.display(); }); });
			s.infoEl.remove();
		});
		new Setting(group).addButton(bt => bt.setButtonText('Add shortcut').setCta().onClick(async () => { this.plugin.settings.shortcuts.push({ name: '', file: '' }); await this.plugin.saveSettings(); this.display(); }));
	}

	private renderCaptureSettings(containerEl: HTMLElement) {
		new Setting(containerEl).setName('Capture workflows').setHeading();
		containerEl.createEl('p', { text: 'Define workflows to quickly append or prepend text to specific notes.' });
		this.plugin.settings.captures.forEach((capture, index) => {
			const group = containerEl.createDiv({ cls: 'personal-internet-settings-group' });
			new Setting(group).setName('Capture name').addText(t => t.setPlaceholder('e.g. quick note').setValue(capture.name).onChange(async (v) => { capture.name = v; await this.plugin.saveSettings(); this.plugin.registerCaptures(); }));
			group.createEl('hr', { cls: 'personal-internet-row-divider' });
			new Setting(group).setName('Target note').addDropdown(dd => dd.addOptions({ daily: 'Daily note', weekly: 'Weekly note', monthly: 'Monthly note', selected: 'Selected note' }).setValue(capture.targetType).onChange(async (v: CaptureTarget) => { capture.targetType = v; await this.plugin.saveSettings(); this.display(); }));
			if (capture.targetType === 'selected') {
				group.createEl('hr', { cls: 'personal-internet-row-divider' });
				new Setting(group).setName('Select note').addSearch(cb => { 
					cb.setPlaceholder('e.g. inbox.md').setValue(capture.file).onChange(async (v) => { capture.file = v; await this.plugin.saveSettings(); }); 
					const el = (cb as unknown as SearchWithContainer).containerEl;
					if (el) el.addClass('personal-internet-search-container');
					new FileSuggest(this.app, cb.inputEl); 
				});
			}
			group.createEl('hr', { cls: 'personal-internet-row-divider' });
			new Setting(group).setName('Target section').setDesc('Header to target (e.g. # Captures). If empty, targets top/bottom of file.').addText(t => t.setPlaceholder('# header').setValue(capture.targetSection).onChange(async (v) => { capture.targetSection = v; await this.plugin.saveSettings(); }));
			group.createEl('hr', { cls: 'personal-internet-row-divider' });
			new Setting(group).setName('Prepend content').setDesc('Add to the top of the section/file instead of the bottom.').addToggle(t => t.setValue(capture.prepend).onChange(async (v) => { capture.prepend = v; await this.plugin.saveSettings(); }));
			group.createEl('hr', { cls: 'personal-internet-row-divider' });
			const autoSize = (el: HTMLTextAreaElement) => { 
				el.setCssProps({ height: 'auto' });
				el.setCssProps({ height: `${el.scrollHeight}px` });
			};
			new Setting(group).setName('Content template').setDesc('Text to capture (supports variables like {{now}}, {{value}}).').addTextArea(t => { t.setPlaceholder('- {{now}}: {{value}}').setValue(capture.content).onChange(async (v) => { capture.content = v; await this.plugin.saveSettings(); autoSize(t.inputEl); }); t.inputEl.addClass('personal-internet-setting-textarea'); requestAnimationFrame(() => autoSize(t.inputEl)); });
			group.createEl('hr', { cls: 'personal-internet-row-divider' });
			new Setting(group).addButton(bt => bt.setButtonText('Delete capture').setWarning().onClick(async () => { this.plugin.settings.captures.splice(index, 1); await this.plugin.saveSettings(); this.plugin.registerCaptures(); this.display(); }));
		});
		new Setting(containerEl).addButton(bt => bt.setButtonText('Add capture').setCta().onClick(async () => { this.plugin.settings.captures.push({ name: '', targetType: 'daily', file: '', targetSection: '', content: '', prepend: false }); await this.plugin.saveSettings(); this.display(); }));
	}

	private renderVariables(containerEl: HTMLElement) {
		new Setting(containerEl).setName('Template variables').setHeading();
		const desc = containerEl.createDiv({ cls: 'personal-internet-variables-desc' });
		desc.createEl('p', { text: 'Use these tokens in your template files. They will be replaced when a note is "materialized" or created in a mapped folder.' });
		const grid = containerEl.createDiv({ cls: 'personal-internet-variables-grid' });
		const addVar = (t: string, d: string, e: string) => { const row = grid.createDiv({ cls: 'personal-internet-variable-row' }); row.createDiv({ cls: 'personal-internet-variable-token', text: `{{${t}}}` }); row.createDiv({ cls: 'personal-internet-variable-description', text: d }); row.createDiv({ cls: 'personal-internet-variable-example', text: e }); };
		addVar('date', 'Target date (YYYY-MM-DD)', '2026-04-24'); addVar('time', 'Target time (HH:mm)', '14:30'); addVar('today', 'Current date', '2026-04-24'); addVar('now', 'ISO datetime', '2026-04-24T14:30:00'); addVar('title', 'Note title', 'April 2026'); addVar('value', 'User input', 'My thought'); addVar('datetime:FORMAT', 'Custom format', '{{datetime:MMMM YYYY}}');
		containerEl.createEl('hr'); 
		new Setting(containerEl).setName('Common date formats').setHeading();
		const f = containerEl.createEl('ul'); f.createEl('li', { text: 'MMMM YYYY → April 2026' }); f.createEl('li', { text: 'GGGG-[W]WW → 2026-W17' });
	}
}
