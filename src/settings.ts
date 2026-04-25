import { App, PluginSettingTab, Setting, ButtonComponent } from "obsidian";
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

	constructor(app: App, plugin: PersonalInternetPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// Prevent auto-focus on the first setting
		const focusTrap = containerEl.createDiv();
		focusTrap.tabIndex = -1;
		focusTrap.focus();

		containerEl.createEl('h2', { text: 'Core Folders' });

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

		containerEl.createEl('h2', { text: 'Core Templates' });

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

		containerEl.createEl('h2', { text: 'Folder Templates' });
		containerEl.createEl('p', { text: 'Map arbitrary folders to templates. These will be applied automatically when a new file is created in the folder.' });

		this.plugin.settings.folderTemplates.forEach((ft, index) => {
			const s = new Setting(containerEl)
				.addSearch(cb => {
					cb.setPlaceholder('Folder')
						.setValue(ft.folder)
						.onChange(async (value) => {
							this.plugin.settings.folderTemplates[index].folder = value;
							await this.plugin.saveSettings();
						});
					new FolderSuggest(this.app, cb.inputEl);
				})
				.addSearch(cb => {
					cb.setPlaceholder('Template')
						.setValue(ft.template)
						.onChange(async (value) => {
							this.plugin.settings.folderTemplates[index].template = value;
							await this.plugin.saveSettings();
						});
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
			s.infoEl.remove(); // Remove name/desc area for compact look
		});

		new Setting(containerEl)
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
}
