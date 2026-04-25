import { App, PluginSettingTab, Setting, ButtonComponent, setIcon, TextAreaComponent, SearchComponent } from "obsidian";
import PersonalInternetPlugin from "./main";
import { FileSuggest, FolderSuggest } from "./suggesters";
import { CaptureTarget, ToCPosition } from "./types";

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
		containerEl.createEl('h2', { text: 'Table of Contents', cls: 'personal-internet-setting-header' });
		const tocGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });

		new Setting(tocGroup)
			.setName('Show Table of Contents')
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
					dd.addOption('bottom-right', 'Bottom Right')
					  .addOption('bottom-left', 'Bottom Left')
					  .addOption('top-left', 'Top Left')
					  .addOption('top-right', 'Top Right')
					  .setValue(this.plugin.settings.tocPosition)
					  .onChange(async (value: ToCPosition) => {
						  this.plugin.settings.tocPosition = value;
						  await this.plugin.saveSettings();
						  this.plugin.refreshToC();
					  });
				});
		}

		containerEl.createEl('h2', { text: 'Folders', cls: 'personal-internet-setting-header' });
		const foldersGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });

		['daily', 'weekly', 'monthly'].forEach((type, index) => {
			if (index > 0) foldersGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
			new Setting(foldersGroup)
				.setName(`${type.charAt(0).toUpperCase() + type.slice(1)} folder`)
				.addSearch(cb => {
					cb.setPlaceholder(`daily/${type === 'daily' ? 'day' : type}`)
						.setValue((this.plugin.settings as any)[`${type}Folder`])
						.onChange(async (value) => {
							(this.plugin.settings as any)[`${type}Folder`] = value;
							await this.plugin.saveSettings();
						});
					// @ts-ignore - containerEl exists on search component in modern Obsidian
					if (cb.containerEl) cb.containerEl.addClass('personal-internet-search-container');
					new FolderSuggest(this.app, cb.inputEl);
				});
		});

		containerEl.createEl('h2', { text: 'Core Templates', cls: 'personal-internet-setting-header' });
		const templatesGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });

		['daily', 'weekly', 'monthly'].forEach((type, index) => {
			if (index > 0) templatesGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
			new Setting(templatesGroup)
				.setName(`${type.charAt(0).toUpperCase() + type.slice(1)} template`)
				.addSearch(cb => {
					cb.setPlaceholder(`templates/${type}.md`)
						.setValue((this.plugin.settings as any)[`${type}Template`])
						.onChange(async (value) => {
							(this.plugin.settings as any)[`${type}Template`] = value;
							await this.plugin.saveSettings();
						});
					// @ts-ignore
					if (cb.containerEl) cb.containerEl.addClass('personal-internet-search-container');
					new FileSuggest(this.app, cb.inputEl);
				});
		});

		containerEl.createEl('hr');
		containerEl.createEl('h2', { text: 'Folder Templates', cls: 'personal-internet-setting-header' });
		const folderTemplatesGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });

		this.plugin.settings.folderTemplates.forEach((ft, index) => {
			if (index > 0) folderTemplatesGroup.createEl('hr', { cls: 'personal-internet-mini-hr' });
			const row = folderTemplatesGroup.createDiv({ cls: 'personal-internet-folder-template-row' });
			const s = new Setting(row)
				.addSearch(cb => {
					cb.setPlaceholder('Folder').setValue(ft.folder).onChange(async (v) => { ft.folder = v; await this.plugin.saveSettings(); });
					// @ts-ignore
					if (cb.containerEl) cb.containerEl.addClass('personal-internet-search-container');
					new FolderSuggest(this.app, cb.inputEl);
				})
				.addSearch(cb => {
					cb.setPlaceholder('Template').setValue(ft.template).onChange(async (v) => { ft.template = v; await this.plugin.saveSettings(); });
					// @ts-ignore
					if (cb.containerEl) cb.containerEl.addClass('personal-internet-search-container');
					new FileSuggest(this.app, cb.inputEl);
				})
				.addExtraButton(cb => {
					cb.setIcon('trash').onClick(async () => { this.plugin.settings.folderTemplates.splice(index, 1); await this.plugin.saveSettings(); this.display(); });
				});
			s.infoEl.remove();
		});

		new Setting(folderTemplatesGroup).addButton(bt => bt.setButtonText('Add Folder Template').setCta().onClick(async () => { this.plugin.settings.folderTemplates.push({ folder: '', template: '' }); await this.plugin.saveSettings(); this.display(); }));
	}

	private renderLintSettings(containerEl: HTMLElement) {
		containerEl.createEl('h2', { text: 'Automatic Linting', cls: 'personal-internet-setting-header' });
		const autoLintGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });
		new Setting(autoLintGroup).setName('Lint on save').addToggle(t => t.setValue(this.plugin.settings.lintOnSave).onChange(async (v) => { this.plugin.settings.lintOnSave = v; await this.plugin.saveSettings(); }));

		containerEl.createEl('h2', { text: 'Date Tracking', cls: 'personal-internet-setting-header' });
		const dateGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });
		new Setting(dateGroup).setName('Created Date Key').addText(t => t.setValue(this.plugin.settings.lintCreatedKey).onChange(async (v) => { this.plugin.settings.lintCreatedKey = v; await this.plugin.saveSettings(); }));
		dateGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
		new Setting(dateGroup).setName('Modified Date Key').addText(t => t.setValue(this.plugin.settings.lintModifiedKey).onChange(async (v) => { this.plugin.settings.lintModifiedKey = v; await this.plugin.saveSettings(); }));

		containerEl.createEl('h2', { text: 'Formatting', cls: 'personal-internet-setting-header' });
		const formattingGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });
		new Setting(formattingGroup).setName('Blank line after YAML').addToggle(t => t.setValue(this.plugin.settings.lintBlankLineAfterYaml).onChange(async (v) => { this.plugin.settings.lintBlankLineAfterYaml = v; await this.plugin.saveSettings(); }));
		
		const autoSize = (el: HTMLTextAreaElement) => { el.style.height = 'auto'; el.style.height = (el.scrollHeight) + 'px'; };

		formattingGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
		new Setting(formattingGroup).setName('YAML Key Priority').addTextArea(t => {
			t.setValue(this.plugin.settings.lintYamlKeyPriority.join('\n')).onChange(async (v) => { this.plugin.settings.lintYamlKeyPriority = v.split('\n').map(s => s.trim()).filter(s => s); await this.plugin.saveSettings(); autoSize(t.inputEl); });
			t.inputEl.addClass('personal-internet-setting-textarea'); requestAnimationFrame(() => autoSize(t.inputEl));
		});

		formattingGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
		new Setting(formattingGroup).setName('Frontmatter Insert').addTextArea(t => {
			t.setValue(this.plugin.settings.lintFrontmatterInsert).onChange(async (v) => { this.plugin.settings.lintFrontmatterInsert = v; await this.plugin.saveSettings(); autoSize(t.inputEl); });
			t.inputEl.addClass('personal-internet-setting-textarea'); requestAnimationFrame(() => autoSize(t.inputEl));
		});

		containerEl.createEl('hr');
		containerEl.createEl('h2', { text: 'Excluded Folders', cls: 'personal-internet-setting-header' });
		const ignoreGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });
		this.plugin.settings.lintIgnoredFolders.forEach((folder, index) => {
			if (index > 0) ignoreGroup.createEl('hr', { cls: 'personal-internet-mini-hr' });
			const row = ignoreGroup.createDiv({ cls: 'personal-internet-folder-template-row' });
			const s = new Setting(row).addSearch(cb => {
				cb.setValue(folder).onChange(async (v) => { this.plugin.settings.lintIgnoredFolders[index] = v; await this.plugin.saveSettings(); });
				// @ts-ignore
				if (cb.containerEl) cb.containerEl.addClass('personal-internet-search-container');
				cb.inputEl.style.width = '100%'; new FolderSuggest(this.app, cb.inputEl);
			}).addExtraButton(cb => { cb.setIcon('trash').onClick(async () => { this.plugin.settings.lintIgnoredFolders.splice(index, 1); await this.plugin.saveSettings(); this.display(); }); });
			s.infoEl.remove();
		});
		new Setting(ignoreGroup).addButton(bt => bt.setButtonText('Add Ignored Folder').setCta().onClick(async () => { this.plugin.settings.lintIgnoredFolders.push(''); await this.plugin.saveSettings(); this.display(); }));
	}

	private renderShortcutSettings(containerEl: HTMLElement) {
		containerEl.createEl('h2', { text: 'Command Shortcuts', cls: 'personal-internet-setting-header' });
		const group = containerEl.createDiv({ cls: 'personal-internet-settings-group' });
		this.plugin.settings.shortcuts.forEach((shortcut, index) => {
			if (index > 0) group.createEl('hr', { cls: 'personal-internet-mini-hr' });
			const row = group.createDiv({ cls: 'personal-internet-folder-template-row' });
			const s = new Setting(row).addText(t => t.setPlaceholder('Name').setValue(shortcut.name).onChange(async (v) => { shortcut.name = v; await this.plugin.saveSettings(); this.plugin.registerShortcuts(); }))
				.addSearch(cb => {
					cb.setPlaceholder('File').setValue(shortcut.file).onChange(async (v) => { shortcut.file = v; await this.plugin.saveSettings(); this.plugin.registerShortcuts(); });
					// @ts-ignore
					if (cb.containerEl) cb.containerEl.addClass('personal-internet-search-container');
					new FileSuggest(this.app, cb.inputEl);
				})
				.addExtraButton(cb => { cb.setIcon('trash').onClick(async () => { this.plugin.settings.shortcuts.splice(index, 1); await this.plugin.saveSettings(); this.plugin.registerShortcuts(); this.display(); }); });
			s.infoEl.remove();
		});
		new Setting(group).addButton(bt => bt.setButtonText('Add Shortcut').setCta().onClick(async () => { this.plugin.settings.shortcuts.push({ name: '', file: '' }); await this.plugin.saveSettings(); this.display(); }));
	}

	private renderCaptureSettings(containerEl: HTMLElement) {
		containerEl.createEl('h2', { text: 'Capture Workflows', cls: 'personal-internet-setting-header' });
		this.plugin.settings.captures.forEach((capture, index) => {
			const group = containerEl.createDiv({ cls: 'personal-internet-settings-group' });
			new Setting(group).setName('Capture Name').addText(t => t.setValue(capture.name).onChange(async (v) => { capture.name = v; await this.plugin.saveSettings(); this.plugin.registerCaptures(); }));
			group.createEl('hr', { cls: 'personal-internet-row-divider' });
			new Setting(group).setName('Target Note').addDropdown(dd => dd.addOptions({ daily: 'Daily Note', weekly: 'Weekly Note', monthly: 'Monthly Note', selected: 'Selected Note' }).setValue(capture.targetType).onChange(async (v: CaptureTarget) => { capture.targetType = v; await this.plugin.saveSettings(); this.display(); }));
			if (capture.targetType === 'selected') {
				group.createEl('hr', { cls: 'personal-internet-row-divider' });
				new Setting(group).setName('Select Note').addSearch(cb => { 
					cb.setValue(capture.file).onChange(async (v) => { capture.file = v; await this.plugin.saveSettings(); }); 
					// @ts-ignore
					if (cb.containerEl) cb.containerEl.addClass('personal-internet-search-container');
					new FileSuggest(this.app, cb.inputEl); 
				});
			}
			group.createEl('hr', { cls: 'personal-internet-row-divider' });
			new Setting(group).setName('Target Section').addText(t => t.setPlaceholder('# Header').setValue(capture.targetSection).onChange(async (v) => { capture.targetSection = v; await this.plugin.saveSettings(); }));
			group.createEl('hr', { cls: 'personal-internet-row-divider' });
			new Setting(group).setName('Prepend content').addToggle(t => t.setValue(capture.prepend).onChange(async (v) => { capture.prepend = v; await this.plugin.saveSettings(); }));
			group.createEl('hr', { cls: 'personal-internet-row-divider' });
			const autoSize = (el: HTMLTextAreaElement) => { el.style.height = 'auto'; el.style.height = (el.scrollHeight) + 'px'; };
			new Setting(group).setName('Content Template').addTextArea(t => { t.setValue(capture.content).onChange(async (v) => { capture.content = v; await this.plugin.saveSettings(); autoSize(t.inputEl); }); t.inputEl.addClass('personal-internet-setting-textarea'); requestAnimationFrame(() => autoSize(t.inputEl)); });
			group.createEl('hr', { cls: 'personal-internet-row-divider' });
			new Setting(group).addButton(bt => bt.setButtonText('Delete Capture').setWarning().onClick(async () => { this.plugin.settings.captures.splice(index, 1); await this.plugin.saveSettings(); this.plugin.registerCaptures(); this.display(); }));
		});
		new Setting(containerEl).addButton(bt => bt.setButtonText('Add Capture').setCta().onClick(async () => { this.plugin.settings.captures.push({ name: '', targetType: 'daily', file: '', targetSection: '', content: '', prepend: false }); await this.plugin.saveSettings(); this.display(); }));
	}

	private renderVariables(containerEl: HTMLElement) {
		containerEl.createEl('h2', { text: 'Template Variables', cls: 'personal-internet-setting-header' });
		const grid = containerEl.createDiv({ cls: 'personal-internet-variables-grid' });
		const addVar = (t: string, d: string, e: string) => { const row = grid.createDiv({ cls: 'personal-internet-variable-row' }); row.createDiv({ cls: 'personal-internet-variable-token', text: `{{${t}}}` }); row.createDiv({ cls: 'personal-internet-variable-description', text: d }); row.createDiv({ cls: 'personal-internet-variable-example', text: e }); };
		addVar('date', 'Target date (YYYY-MM-DD)', '2026-04-24'); addVar('time', 'Target time (HH:mm)', '14:30'); addVar('today', 'Current date', '2026-04-24'); addVar('now', 'ISO datetime', '2026-04-24T14:30:00'); addVar('title', 'Note title', 'April 2026'); addVar('value', 'User input', 'My thought'); addVar('datetime:FORMAT', 'Custom format', '{{datetime:MMMM YYYY}}');
		containerEl.createEl('hr'); containerEl.createEl('h2', { text: 'Common Date Formats', cls: 'personal-internet-setting-header' });
		const f = containerEl.createEl('ul'); f.createEl('li', { text: 'MMMM YYYY → April 2026' }); f.createEl('li', { text: 'GGGG-[W]WW → 2026-W17' });
	}
}
