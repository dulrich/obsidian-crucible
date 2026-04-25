import { App, PluginSettingTab, Setting, ButtonComponent, setIcon, TextAreaComponent } from "obsidian";
import PersonalInternetPlugin from "./main";
import { FileSuggest, FolderSuggest } from "./suggesters";

export interface FolderTemplate {
	folder: string;
	template: string;
}

export interface Shortcut {
	name: string;
	file: string;
}

export type CaptureTarget = 'daily' | 'weekly' | 'monthly' | 'selected';

export interface Capture {
	name: string;
	targetType: CaptureTarget;
	file: string;
	targetSection: string;
	content: string;
	prepend: boolean;
}

export interface PersonalInternetSettings {
	dailyFolder: string;
	weeklyFolder: string;
	monthlyFolder: string;
	dailyTemplate: string;
	weeklyTemplate: string;
	monthlyTemplate: string;
	folderTemplates: FolderTemplate[];
	// Lint Settings
	lintFrontmatterInsert: string;
	lintYamlKeyPriority: string[];
	lintIgnoredFolders: string[];
	lintCreatedKey: string;
	lintModifiedKey: string;
	lintBlankLineAfterYaml: boolean;
	lintOnSave: boolean;
	// Shortcuts
	shortcuts: Shortcut[];
	// Captures
	captures: Capture[];
}

export const DEFAULT_SETTINGS: PersonalInternetSettings = {
	dailyFolder: 'daily/day',
	weeklyFolder: 'daily/week',
	monthlyFolder: 'daily/month',
	dailyTemplate: '',
	weeklyTemplate: '',
	monthlyTemplate: '',
	folderTemplates: [],
	lintFrontmatterInsert: '',
	lintYamlKeyPriority: ['title', 'created', 'updated', 'word-count'],
	lintIgnoredFolders: [],
	lintCreatedKey: 'created',
	lintModifiedKey: 'updated',
	lintBlankLineAfterYaml: true,
	lintOnSave: false,
	shortcuts: [],
	captures: [],
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

		// Prevent auto-focus on the first setting
		const focusTrap = containerEl.createEl('button', { cls: 'personal-internet-focus-trap' });
		requestAnimationFrame(() => {
			focusTrap.focus();
		});

		// Tab Navigation
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
		containerEl.createEl('h2', { text: 'Folders', cls: 'personal-internet-setting-header' });
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
				cb.containerEl.addClass('personal-internet-search-container');
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
				cb.containerEl.addClass('personal-internet-search-container');
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
				cb.containerEl.addClass('personal-internet-search-container');
				new FolderSuggest(this.app, cb.inputEl);
			});

		containerEl.createEl('h2', { text: 'Core Templates', cls: 'personal-internet-setting-header' });
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
				cb.containerEl.addClass('personal-internet-search-container');
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
				cb.containerEl.addClass('personal-internet-search-container');
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
				cb.containerEl.addClass('personal-internet-search-container');
				new FileSuggest(this.app, cb.inputEl);
			});

		containerEl.createEl('hr');
		containerEl.createEl('h2', { text: 'Folder Templates', cls: 'personal-internet-setting-header' });
		containerEl.createEl('p', { text: 'Map arbitrary folders to templates. These will be applied automatically when a new file is created in the folder.' });

		const folderTemplatesGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });

		this.plugin.settings.folderTemplates.forEach((ft, index) => {
			if (index > 0) {
				folderTemplatesGroup.createEl('hr', { cls: 'personal-internet-mini-hr' });
			}
			const row = folderTemplatesGroup.createDiv({ cls: 'personal-internet-folder-template-row' });
			
			const s = new Setting(row)
				.addSearch(cb => {
					cb.setPlaceholder('Folder')
						.setValue(ft.folder)
						.onChange(async (value) => {
							this.plugin.settings.folderTemplates[index].folder = value;
							await this.plugin.saveSettings();
						});
					cb.containerEl.addClass('personal-internet-search-container');
					new FolderSuggest(this.app, cb.inputEl);
				})
				.addSearch(cb => {
					cb.setPlaceholder('Template')
						.setValue(ft.template)
						.onChange(async (value) => {
							this.plugin.settings.folderTemplates[index].template = value;
							await this.plugin.saveSettings();
						});
					cb.containerEl.addClass('personal-internet-search-container');
					new FileSuggest(this.app, cb.inputEl);
				})
				.addExtraButton(cb => {
					cb.setIcon('trash')
						.setTooltip('Delete')
						.onClick(async () => {
							this.plugin.settings.folderTemplates.splice(index, 1);
							await this.plugin.saveSettings();
							this.display();
						});
				});
			s.infoEl.remove();
		});

		if (this.plugin.settings.folderTemplates.length > 0) {
			folderTemplatesGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
		}
		new Setting(folderTemplatesGroup)
			.addButton(bt => {
				bt.setButtonText('Add Folder Template')
					.setCta()
					.onClick(async () => {
						this.plugin.settings.folderTemplates.push({ folder: '', template: '' });
						await this.plugin.saveSettings();
						this.display();
					});
			});
	}

	private renderLintSettings(containerEl: HTMLElement) {
		containerEl.createEl('h2', { text: 'Automatic Linting', cls: 'personal-internet-setting-header' });
		const autoLintGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });

		new Setting(autoLintGroup)
			.setName('Lint on save')
			.setDesc('Automatically run the lint command when a file is modified.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.lintOnSave)
				.onChange(async (value) => {
					this.plugin.settings.lintOnSave = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h2', { text: 'Date Tracking', cls: 'personal-internet-setting-header' });
		const dateGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });

		new Setting(dateGroup)
			.setName('Created Date Key')
			.setDesc('Property key for the creation date.')
			.addText(text => text
				.setPlaceholder('created')
				.setValue(this.plugin.settings.lintCreatedKey)
				.onChange(async (value) => {
					this.plugin.settings.lintCreatedKey = value;
					await this.plugin.saveSettings();
				}));

		dateGroup.createEl('hr', { cls: 'personal-internet-row-divider' });

		new Setting(dateGroup)
			.setName('Modified Date Key')
			.setDesc('Property key for the last modified date.')
			.addText(text => text
				.setPlaceholder('updated')
				.setValue(this.plugin.settings.lintModifiedKey)
				.onChange(async (value) => {
					this.plugin.settings.lintModifiedKey = value;
					await this.plugin.saveSettings();
				}));

		containerEl.createEl('h2', { text: 'Formatting', cls: 'personal-internet-setting-header' });
		const formattingGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });

		new Setting(formattingGroup)
			.setName('Blank line after YAML')
			.setDesc('Ensure there is at least one blank line after the frontmatter.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.lintBlankLineAfterYaml)
				.onChange(async (value) => {
					this.plugin.settings.lintBlankLineAfterYaml = value;
					await this.plugin.saveSettings();
				}));

		formattingGroup.createEl('hr', { cls: 'personal-internet-row-divider' });

		const autoSize = (el: HTMLTextAreaElement) => {
			el.style.height = 'auto';
			el.style.height = (el.scrollHeight) + 'px';
		};

		new Setting(formattingGroup)
			.setName('YAML Key Priority')
			.setDesc('Keys to move to the top of frontmatter (one per line).')
			.addTextArea(text => {
				text.setPlaceholder('title\ncreated\nupdated')
					.setValue(this.plugin.settings.lintYamlKeyPriority.join('\n'))
					.onChange(async (value) => {
						this.plugin.settings.lintYamlKeyPriority = value.split('\n').map(s => s.trim()).filter(s => s);
						await this.plugin.saveSettings();
						autoSize(text.inputEl);
					});
				text.inputEl.addClass('personal-internet-setting-textarea');
				requestAnimationFrame(() => autoSize(text.inputEl));
			});

		formattingGroup.createEl('hr', { cls: 'personal-internet-row-divider' });

		new Setting(formattingGroup)
			.setName('Frontmatter Insert')
			.setDesc('Text to ensure exists in the frontmatter. (Supports template variables)')
			.addTextArea(text => {
				text.setPlaceholder('tags: \nstatus: ')
					.setValue(this.plugin.settings.lintFrontmatterInsert)
					.onChange(async (value) => {
						this.plugin.settings.lintFrontmatterInsert = value;
						await this.plugin.saveSettings();
						autoSize(text.inputEl);
					});
				text.inputEl.addClass('personal-internet-setting-textarea');
				requestAnimationFrame(() => autoSize(text.inputEl));
			});

		containerEl.createEl('hr');
		containerEl.createEl('h2', { text: 'Excluded Folders', cls: 'personal-internet-setting-header' });
		containerEl.createEl('p', { text: 'Notes in these folders will be ignored by all Lint commands.' });

		const ignoredFoldersGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });

		this.plugin.settings.lintIgnoredFolders.forEach((folder, index) => {
			if (index > 0) {
				ignoredFoldersGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
			}
			const row = ignoredFoldersGroup.createDiv({ cls: 'personal-internet-folder-template-row' });
			
			const s = new Setting(row)
				.addSearch(cb => {
					cb.setPlaceholder('Folder to ignore')
						.setValue(folder)
						.onChange(async (value) => {
							this.plugin.settings.lintIgnoredFolders[index] = value;
							await this.plugin.saveSettings();
						});
					cb.containerEl.addClass('personal-internet-search-container');
					cb.inputEl.style.width = '100%';
					new FolderSuggest(this.app, cb.inputEl);
				})
				.addExtraButton(cb => {
					cb.setIcon('trash')
						.setTooltip('Delete')
						.onClick(async () => {
							this.plugin.settings.lintIgnoredFolders.splice(index, 1);
							await this.plugin.saveSettings();
							this.display();
						});
				});
			s.infoEl.remove();
		});

		if (this.plugin.settings.lintIgnoredFolders.length > 0) {
			ignoredFoldersGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
		}
		new Setting(ignoredFoldersGroup)
			.addButton(bt => {
				bt.setButtonText('Add Ignored Folder')
					.setCta()
					.onClick(async () => {
						this.plugin.settings.lintIgnoredFolders.push('');
						await this.plugin.saveSettings();
						this.display();
					});
			});
	}

	private renderShortcutSettings(containerEl: HTMLElement) {
		containerEl.createEl('h2', { text: 'Command Shortcuts', cls: 'personal-internet-setting-header' });
		containerEl.createEl('p', { text: 'Create custom commands to open specific files directly from the Command Palette.' });

		const shortcutsGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });

		this.plugin.settings.shortcuts.forEach((shortcut, index) => {
			if (index > 0) {
				shortcutsGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
			}
			const s = new Setting(shortcutsGroup)
				.addText(cb => {
					cb.setPlaceholder('Shortcut Name')
						.setValue(shortcut.name)
						.onChange(async (value) => {
							this.plugin.settings.shortcuts[index].name = value;
							await this.plugin.saveSettings();
							this.plugin.registerShortcuts();
						});
				})
				.addSearch(cb => {
					cb.setPlaceholder('File to open')
						.setValue(shortcut.file)
						.onChange(async (value) => {
							this.plugin.settings.shortcuts[index].file = value;
							await this.plugin.saveSettings();
							this.plugin.registerShortcuts();
						});
					cb.containerEl.addClass('personal-internet-search-container');
					new FileSuggest(this.app, cb.inputEl);
				})
				.addExtraButton(cb => {
					cb.setIcon('trash')
						.setTooltip('Delete')
						.onClick(async () => {
							this.plugin.settings.shortcuts.splice(index, 1);
							await this.plugin.saveSettings();
							this.plugin.registerShortcuts();
							this.display();
						});
				});
			s.infoEl.remove();
		});

		if (this.plugin.settings.shortcuts.length > 0) {
			shortcutsGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
		}
		new Setting(shortcutsGroup)
			.addButton(bt => {
				bt.setButtonText('Add Shortcut')
					.setCta()
					.onClick(async () => {
						this.plugin.settings.shortcuts.push({ name: '', file: '' });
						await this.plugin.saveSettings();
						this.display();
					});
			});
	}

	private renderCaptureSettings(containerEl: HTMLElement) {
		containerEl.createEl('h2', { text: 'Capture Workflows', cls: 'personal-internet-setting-header' });
		containerEl.createEl('p', { text: 'Define workflows to quickly append or prepend text to specific notes.' });

		this.plugin.settings.captures.forEach((capture, index) => {
			const captureGroup = containerEl.createDiv({ cls: 'personal-internet-settings-group' });

			new Setting(captureGroup)
				.setName('Capture Name')
				.addText(text => text
					.setPlaceholder('e.g. Quick Note')
					.setValue(capture.name)
					.onChange(async (value) => {
						this.plugin.settings.captures[index].name = value;
						await this.plugin.saveSettings();
						this.plugin.registerCaptures();
					}));

			captureGroup.createEl('hr', { cls: 'personal-internet-row-divider' });

			new Setting(captureGroup)
				.setName('Target Note')
				.addDropdown(dd => {
					dd.addOption('daily', 'Daily Note')
					  .addOption('weekly', 'Weekly Note')
					  .addOption('monthly', 'Monthly Note')
					  .addOption('selected', 'Selected Note')
					  .setValue(capture.targetType)
					  .onChange(async (value: CaptureTarget) => {
						  this.plugin.settings.captures[index].targetType = value;
						  await this.plugin.saveSettings();
						  this.display();
					  });
				});

			if (capture.targetType === 'selected') {
				captureGroup.createEl('hr', { cls: 'personal-internet-row-divider' });
				new Setting(captureGroup)
					.setName('Select Note')
					.addSearch(cb => {
						cb.setPlaceholder('e.g. Inbox.md')
							.setValue(capture.file)
							.onChange(async (value) => {
								this.plugin.settings.captures[index].file = value;
								await this.plugin.saveSettings();
							});
						cb.containerEl.addClass('personal-internet-search-container');
						new FileSuggest(this.app, cb.inputEl);
					});
			}

			captureGroup.createEl('hr', { cls: 'personal-internet-row-divider' });

			new Setting(captureGroup)
				.setName('Target Section')
				.setDesc('Header to target (e.g. # Captures). If empty, targets top/bottom of file.')
				.addText(text => text
					.setPlaceholder('# Header')
					.setValue(capture.targetSection)
					.onChange(async (value) => {
						this.plugin.settings.captures[index].targetSection = value;
						await this.plugin.saveSettings();
					}));

			captureGroup.createEl('hr', { cls: 'personal-internet-row-divider' });

			new Setting(captureGroup)
				.setName('Prepend content')
				.setDesc('Add to the top of the section/file instead of the bottom.')
				.addToggle(toggle => toggle
					.setValue(capture.prepend)
					.onChange(async (value) => {
						this.plugin.settings.captures[index].prepend = value;
						await this.plugin.saveSettings();
					}));

			captureGroup.createEl('hr', { cls: 'personal-internet-row-divider' });

			const autoSize = (el: HTMLTextAreaElement) => {
				el.style.height = 'auto';
				el.style.height = (el.scrollHeight) + 'px';
			};

			new Setting(captureGroup)
				.setName('Content Template')
				.setDesc('Text to capture. (Supports variables like {{now}}, {{value}})')
				.addTextArea(text => {
					text.setPlaceholder('- {{now}}: {{value}}')
						.setValue(capture.content)
						.onChange(async (value) => {
							this.plugin.settings.captures[index].content = value;
							await this.plugin.saveSettings();
							autoSize(text.inputEl);
						});
					text.inputEl.addClass('personal-internet-setting-textarea');
					requestAnimationFrame(() => autoSize(text.inputEl));
				});

			captureGroup.createEl('hr', { cls: 'personal-internet-row-divider' });

			new Setting(captureGroup)
				.addButton(bt => bt
					.setButtonText('Delete Capture')
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.captures.splice(index, 1);
						await this.plugin.saveSettings();
						this.plugin.registerCaptures();
						this.display();
					}));
		});

		new Setting(containerEl)
			.addButton(bt => bt
				.setButtonText('Add Capture')
				.setCta()
				.onClick(async () => {
					this.plugin.settings.captures.push({ name: '', targetType: 'daily', file: '', targetSection: '', content: '', prepend: false });
					await this.plugin.saveSettings();
					this.display();
				}));
	}

	private renderVariables(containerEl: HTMLElement) {
		containerEl.createEl('h2', { text: 'Template Variables', cls: 'personal-internet-setting-header' });
		
		const desc = containerEl.createDiv({ cls: 'personal-internet-variables-desc' });
		desc.createEl('p', { text: 'Use these tokens in your template files. They will be replaced when a note is "materialized" or created in a mapped folder.' });

		const grid = containerEl.createDiv({ cls: 'personal-internet-variables-grid' });

		const addVariable = (token: string, description: string, example: string) => {
			const row = grid.createDiv({ cls: 'personal-internet-variable-row' });
			row.createDiv({ cls: 'personal-internet-variable-token', text: `{{${token}}}` });
			row.createDiv({ cls: 'personal-internet-variable-description', text: description });
			row.createDiv({ cls: 'personal-internet-variable-example', text: example });
		};

		addVariable('date', 'The target date of the note (YYYY-MM-DD)', '2026-04-24');
		addVariable('time', 'The target time of the note (HH:mm)', '14:30');
		addVariable('today', 'The current date at invocation', '2026-04-24');
		addVariable('now', 'The current ISO datetime', '2026-04-24T14:30:00');
		addVariable('title', 'The note title (from YAML or filename)', 'April 2026');
		addVariable('value', 'Input entered by user during Capture', 'My quick thought');
		addVariable('datetime:FORMAT', 'Custom format (Moment.js tokens)', '{{datetime:MMMM YYYY}}');

		containerEl.createEl('hr');
		containerEl.createEl('h2', { text: 'Common Date Formats', cls: 'personal-internet-setting-header' });
		const formats = containerEl.createEl('ul');
		formats.createEl('li', { text: 'MMMM YYYY → April 2026' });
		formats.createEl('li', { text: 'GGGG-[W]WW → 2026-W17' });
		formats.createEl('li', { text: 'dddd, MMMM Do → Friday, April 24th' });
	}
}
