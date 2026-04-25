import { App, PluginSettingTab, Setting, ButtonComponent, setIcon } from "obsidian";
import PersonalInternetPlugin from "./main";
import { FileSuggest, FolderSuggest } from "./suggesters";

export interface FolderTemplate {
	folder: string;
	template: string;
}

export interface PersonalInternetSettings {
	dailyFolder: string;
	weeklyFolder: string;
	monthlyFolder: string;
	dailyTemplate: string;
	weeklyTemplate: string;
	monthlyTemplate: string;
	folderTemplates: FolderTemplate[];
}

export const DEFAULT_SETTINGS: PersonalInternetSettings = {
	dailyFolder: 'daily/day',
	weeklyFolder: 'daily/week',
	monthlyFolder: 'daily/month',
	dailyTemplate: '',
	weeklyTemplate: '',
	monthlyTemplate: '',
	folderTemplates: [],
}

export class PersonalInternetSettingTab extends PluginSettingTab {
	plugin: PersonalInternetPlugin;
	private activeTab: 'settings' | 'variables' = 'settings';

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
		
		const settingsTabBtn = navBar.createDiv({ 
			cls: `personal-internet-tab-btn ${this.activeTab === 'settings' ? 'is-active' : ''}` 
		});
		setIcon(settingsTabBtn, 'settings');
		settingsTabBtn.createSpan({ text: ' Settings' });
		settingsTabBtn.onclick = () => {
			this.activeTab = 'settings';
			this.display();
		};

		const variablesTabBtn = navBar.createDiv({ 
			cls: `personal-internet-tab-btn ${this.activeTab === 'variables' ? 'is-active' : ''}` 
		});
		setIcon(variablesTabBtn, 'info');
		variablesTabBtn.createSpan({ text: ' Variables' });
		variablesTabBtn.onclick = () => {
			this.activeTab = 'variables';
			this.display();
		};

		containerEl.createEl('hr', { cls: 'personal-internet-tab-hr' });

		if (this.activeTab === 'settings') {
			this.renderSettings(containerEl);
		} else {
			this.renderVariables(containerEl);
		}
	}

	private renderSettings(containerEl: HTMLElement) {
		containerEl.createEl('h2', { text: 'Folders', cls: 'personal-internet-setting-header' });

		new Setting(containerEl)
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

		new Setting(containerEl)
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

		new Setting(containerEl)
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

		new Setting(containerEl)
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

		new Setting(containerEl)
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

		new Setting(containerEl)
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

		const folderTemplatesContainer = containerEl.createDiv({ cls: 'personal-internet-folder-templates-container' });

		this.plugin.settings.folderTemplates.forEach((ft, index) => {
			if (index > 0) {
				folderTemplatesContainer.createEl('hr', { cls: 'personal-internet-mini-hr' });
			}
			const row = folderTemplatesContainer.createDiv({ cls: 'personal-internet-folder-template-row' });
			
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

		const buttonRow = folderTemplatesContainer.createDiv({ cls: 'personal-internet-folder-template-button-row' });
		if (this.plugin.settings.folderTemplates.length > 0) {
			folderTemplatesContainer.createEl('hr', { cls: 'personal-internet-mini-hr' });
		}
		new Setting(buttonRow)
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
		addVariable('datetime:FORMAT', 'Custom format (Moment.js tokens)', '{{datetime:MMMM YYYY}}');

		containerEl.createEl('hr');
		containerEl.createEl('h2', { text: 'Common Date Formats', cls: 'personal-internet-setting-header' });
		const formats = containerEl.createEl('ul');
		formats.createEl('li', { text: 'MMMM YYYY → April 2026' });
		formats.createEl('li', { text: 'GGGG-[W]WW → 2026-W17' });
		formats.createEl('li', { text: 'dddd, MMMM Do → Friday, April 24th' });
	}
}
