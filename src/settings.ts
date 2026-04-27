/* eslint-disable obsidianmd/ui/sentence-case */
import { App, PluginSettingTab, Setting, setIcon, Platform, Hotkey } from "obsidian";
import CruciblePlugin from "./main";
import { FileSuggest, FolderSuggest, CommandSuggest } from "./suggesters";
import { CaptureTarget, CaptureSource, ToCPosition, ToCCollapseBehavior } from "./types";

interface SearchWithContainer {
	containerEl: HTMLElement;
}

interface AppWithInternals extends App {
	hotkeyManager: {
		getHotkeys(id: string): Hotkey[];
	};
}

export class CrucibleSettingTab extends PluginSettingTab {
	plugin: CruciblePlugin;
	private activeTab: 'settings' | 'lint' | 'shortcuts' | 'captures' | 'commands' | 'chains' = 'settings';
	private editingChainIndex: number = -1;

	constructor(app: App, plugin: CruciblePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const focusTrap = containerEl.createEl('button', { cls: 'crucible-focus-trap' });
		requestAnimationFrame(() => focusTrap.focus());

		const navBar = containerEl.createDiv({ cls: 'crucible-tab-nav' });
		
		if (this.editingChainIndex !== -1) {
			const backBtn = navBar.createDiv({ cls: 'crucible-tab-btn' });
			setIcon(backBtn, 'arrow-left');
			backBtn.createSpan({ text: ' Back' });
			backBtn.onclick = () => {
				this.editingChainIndex = -1;
				this.display();
			};
		} else {
			const createTab = (id: typeof this.activeTab, icon: string, label: string) => {
				const btn = navBar.createDiv({ 
					cls: `crucible-tab-btn ${this.activeTab === id ? 'is-active' : ''}` 
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
			createTab('chains', 'list', 'Chains');
			createTab('commands', 'terminal', 'Commands');
			createTab('lint', 'check-circle', 'Lint');
		}

		containerEl.createEl('hr', { cls: 'crucible-tab-hr' });

		if (this.activeTab === 'settings') {
			this.renderSettings(containerEl);
		} else if (this.activeTab === 'lint') {
			this.renderLintSettings(containerEl);
		} else if (this.activeTab === 'shortcuts') {
			this.renderShortcutSettings(containerEl);
		} else if (this.activeTab === 'captures') {
			this.renderCaptureSettings(containerEl);
		} else if (this.activeTab === 'chains') {
			this.renderChainSettings(containerEl);
		} else if (this.activeTab === 'commands') {
			this.renderCommandSettings(containerEl);
		}
	}

	private renderCommandSettings(containerEl: HTMLElement) {
		new Setting(containerEl).setName('Command visibility').setHeading();
		containerEl.createEl('p', { text: 'Control which commands are visible in the Obsidian Command Palette. Disabling a command here will hide it from the palette but will not delete its configuration.' });

		const renderGroup = (title: string, commands: { id: string, name: string }[]) => {
			if (commands.length === 0) return;
			
			new Setting(containerEl).setName(title).setHeading();
			const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
			
			commands.sort((a, b) => a.name.localeCompare(b.name));

			commands.forEach((cmd, index) => {
				if (index > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
				const s = new Setting(group)
					.setName(cmd.name)
					.addToggle(toggle => toggle
						.setValue(!this.plugin.settings.hiddenCommands.includes(cmd.id))
						.onChange(async (value) => {
							if (value) {
								this.plugin.settings.hiddenCommands = this.plugin.settings.hiddenCommands.filter(id => id !== cmd.id);
							} else {
								if (!this.plugin.settings.hiddenCommands.includes(cmd.id)) {
									this.plugin.settings.hiddenCommands.push(cmd.id);
								}
							}
							await this.plugin.saveSettings();
						}));
				
				this.renderHotkey(s.controlEl, cmd.id);
			});
		};

		const materializeCommands = [
			{ id: 'materialize-day-today', name: 'Materialize day: today' },
			{ id: 'materialize-day-picker', name: 'Materialize day: pick date' },
			{ id: 'materialize-week-today', name: 'Materialize week: current' },
			{ id: 'materialize-week-picker', name: 'Materialize week: pick week' },
			{ id: 'materialize-month-today', name: 'Materialize month: current' },
			{ id: 'materialize-month-picker', name: 'Materialize month: pick month' },
		];

		const lintCommands = [
			{ id: 'word-count', name: 'Lint: word count' },
			{ id: 'lint-note', name: 'Lint: all' },
			{ id: 'lint-vault', name: 'Lint: vault' },
		];

		const shortcutCommands = this.plugin.settings.shortcuts.map((s, i) => ({
			id: `shortcut-${i}`,
			name: `Shortcut: ${s.name || '(unnamed)'}`
		}));

		const captureCommands = this.plugin.settings.captures.map((c, i) => ({
			id: `capture-${i}`,
			name: `Capture: ${c.name || '(unnamed)'}`
		}));

		const chainCommands = this.plugin.settings.chains.map((c, i) => ({
			id: `chain-${i}`,
			name: `Chain: ${c.name || '(unnamed)'}`
		}));

		const otherCommands = [
			{ id: 'mark-as-forwarded', name: 'Mark as forwarded' },
			{ id: 'reload-plugin', name: 'Reload plugin' }
		];

		renderGroup('Materialize', materializeCommands);
		renderGroup('Lint', lintCommands);
		renderGroup('Captures', captureCommands);
		renderGroup('Shortcuts', shortcutCommands);
		renderGroup('Chains', chainCommands);
		renderGroup('Other', otherCommands);
	}

	private renderHotkey(el: HTMLElement, commandId: string) {
		const prefix = this.plugin.manifest.id;
		const fullId = `${prefix}:${commandId}`;
		const hotkeys = (this.app as AppWithInternals).hotkeyManager.getHotkeys(fullId);
		
		if (!hotkeys || hotkeys.length === 0) return;

		const hotkey = hotkeys[0];
		const parts = hotkey.modifiers.map(mod => {
			if (mod === 'Mod') return Platform.isMacOS ? 'Cmd' : 'Ctrl';
			return mod;
		});
		
		let key = hotkey.key;
		if (key.length === 1) key = key.toUpperCase();
		if (key === ' ') key = 'Space';
		parts.push(key);

		const hotkeyEl = document.createElement('div');
		hotkeyEl.classList.add('crucible-hotkey-display');
		hotkeyEl.createEl('kbd', { text: parts.join(' + ') });
		
		el.prepend(hotkeyEl);
	}

	private renderChainSettings(containerEl: HTMLElement) {
		if (this.editingChainIndex !== -1) {
			this.renderEditChain(containerEl);
			return;
		}

		new Setting(containerEl).setName('Chains').setHeading();
		containerEl.createEl('p', { text: 'Define a sequence of commands to run in order. Chains can pass arguments and responses between steps.' });

		const group = containerEl.createDiv({ cls: 'crucible-settings-group' });

		if (this.plugin.settings.chains.length === 0) {
			group.createDiv({ text: 'No chains defined.', cls: 'crucible-empty-state' });
		} else {
			this.plugin.settings.chains.forEach((chain, index) => {
				if (index > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
				new Setting(group)
					.setName(chain.name || '(unnamed)')
					.setDesc(`${chain.steps.length} steps`)
					.addExtraButton(cb => cb.setIcon('pencil').setTooltip('Edit chain').onClick(() => {
						this.editingChainIndex = index;
						this.display();
					}))
					.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete chain').onClick(async () => {
						this.plugin.settings.chains.splice(index, 1);
						await this.plugin.saveSettings();
						this.plugin.registerChains();
						this.display();
					}));
			});
		}

		new Setting(containerEl).addButton(bt => bt.setButtonText('Add Chain').setCta().onClick(async () => {
			this.plugin.settings.chains.push({ name: '', steps: [] });
			await this.plugin.saveSettings();
			this.editingChainIndex = this.plugin.settings.chains.length - 1;
			this.display();
		}));
	}

	private renderEditChain(containerEl: HTMLElement) {
		const chain = this.plugin.settings.chains[this.editingChainIndex];
		if (!chain) return;

		new Setting(containerEl).setName('Edit Chain').setHeading();

		const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
		new Setting(group)
			.setName('Chain name')
			.addText(t => t
				.setPlaceholder('e.g. Refine Transcript')
				.setValue(chain.name)
				.onChange(async (v) => {
					chain.name = v;
					await this.plugin.saveSettings();
					this.plugin.registerChains();
				}).inputEl.addClass('pi-width-normal'));

		new Setting(containerEl).setName('Steps').setHeading();

		chain.steps.forEach((step, index) => {
			const stepGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
			
			new Setting(stepGroup)
				.setName(`Step ${index + 1}`)
				.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove step').onClick(async () => {
					chain.steps.splice(index, 1);
					await this.plugin.saveSettings();
					this.display();
				}));

			stepGroup.createEl('hr', { cls: 'crucible-row-divider' });

			new Setting(stepGroup)
				.setName('Command')
				.addSearch(cb => {
					cb.setPlaceholder('Search for a command...')
						.setValue(step.commandId)
						.onChange(async (v) => {
							step.commandId = v;
							await this.plugin.saveSettings();
						});
					const el = (cb as unknown as SearchWithContainer).containerEl;
					if (el) el.addClass('crucible-search-container', 'pi-width-normal');
					new CommandSuggest(this.app, cb.inputEl);
				});

			stepGroup.createEl('hr', { cls: 'crucible-row-divider' });

			new Setting(stepGroup)
				.setName('Arguments')
				.setDesc('Support variables like {{response}} from the previous step.')
				.addText(t => t
					.setPlaceholder('Args...')
					.setValue(step.args)
					.onChange(async (v) => {
						step.args = v;
						await this.plugin.saveSettings();
					}).inputEl.addClass('pi-width-normal'));

			stepGroup.createEl('hr', { cls: 'crucible-row-divider' });

			new Setting(stepGroup)
				.setName('Keep going on failure')
				.addToggle(t => t
					.setValue(step.keepGoing)
					.onChange(async (v) => {
						step.keepGoing = v;
						await this.plugin.saveSettings();
					}));
		});

		new Setting(containerEl).addButton(bt => bt.setButtonText('Add step').setCta().onClick(async () => {
			chain.steps.push({ commandId: '', keepGoing: false, args: '' });
			await this.plugin.saveSettings();
			this.display();
		}));
	}

	private renderSettings(containerEl: HTMLElement) {
		new Setting(containerEl).setName('Table of contents').setHeading();
		const tocGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });

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
			tocGroup.createEl('hr', { cls: 'crucible-row-divider' });
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
					dd.selectEl.addClass('pi-width-half');
				});

			tocGroup.createEl('hr', { cls: 'crucible-row-divider' });
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
					dd.selectEl.addClass('pi-width-half');
				});
		}

		new Setting(containerEl).setName('Folders').setHeading();
		const foldersGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });

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
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FolderSuggest(this.app, cb.inputEl);
			});

		foldersGroup.createEl('hr', { cls: 'crucible-row-divider' });

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
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FolderSuggest(this.app, cb.inputEl);
			});

		foldersGroup.createEl('hr', { cls: 'crucible-row-divider' });

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
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FolderSuggest(this.app, cb.inputEl);
			});

		new Setting(containerEl).setName('Core templates').setHeading();
		const templatesGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });

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
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FileSuggest(this.app, cb.inputEl);
			});

		templatesGroup.createEl('hr', { cls: 'crucible-row-divider' });

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
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FileSuggest(this.app, cb.inputEl);
			});

		templatesGroup.createEl('hr', { cls: 'crucible-row-divider' });

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
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FileSuggest(this.app, cb.inputEl);
			});

		new Setting(containerEl).setName('Folder templates').setHeading();
		containerEl.createEl('p', { text: 'Map arbitrary folders to templates. These will be applied automatically when a new file is created in the folder.' });

		const folderTemplatesGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });

		this.plugin.settings.folderTemplates.forEach((ft, index) => {
			if (index > 0) folderTemplatesGroup.createEl('hr', { cls: 'crucible-mini-hr' });
			const row = folderTemplatesGroup.createDiv({ cls: 'crucible-folder-template-row' });
			const s = new Setting(row)
				.addSearch(cb => {
					cb.setPlaceholder('Folder').setValue(ft.folder).onChange(async (v) => { ft.folder = v; await this.plugin.saveSettings(); });
					const el = (cb as unknown as SearchWithContainer).containerEl;
					if (el) el.addClass('crucible-search-container', 'pi-width-normal');
					new FolderSuggest(this.app, cb.inputEl);
				})
				.addSearch(cb => {
					cb.setPlaceholder('Template').setValue(ft.template).onChange(async (v) => { ft.template = v; await this.plugin.saveSettings(); });
					const el = (cb as unknown as SearchWithContainer).containerEl;
					if (el) el.addClass('crucible-search-container', 'pi-width-normal');
					new FileSuggest(this.app, cb.inputEl);
				})
				.addExtraButton(cb => {
					cb.setIcon('trash').onClick(async () => { this.plugin.settings.folderTemplates.splice(index, 1); await this.plugin.saveSettings(); this.display(); });
				});
			s.infoEl.remove();
		});

		new Setting(folderTemplatesGroup).addButton(bt => bt.setButtonText('Add folder template').setCta().onClick(async () => { this.plugin.settings.folderTemplates.push({ folder: '', template: '' }); await this.plugin.saveSettings(); this.display(); }));

		new Setting(containerEl).setName('Template variables').setHeading();
		const desc = containerEl.createDiv({ cls: 'crucible-variables-desc' });
		desc.createEl('p', { text: 'Use these tokens in your template files. They will be replaced when a note is "materialized" or created in a mapped folder.' });
		const grid = containerEl.createDiv({ cls: 'crucible-variables-grid' });
		const addVar = (t: string, d: string, e: string) => { 
			const row = grid.createDiv({ cls: 'crucible-variable-row' }); 
			row.createDiv({ cls: 'crucible-variable-token', text: `{{${t}}}` }); 
			row.createDiv({ cls: 'crucible-variable-description', text: d }); 
			row.createDiv({ cls: 'crucible-variable-example', text: e }); 
		};
		addVar('date', 'Target date (YYYY-MM-DD)', '2026-04-24'); 
		addVar('time', 'Target time (HH:mm)', '14:30'); 
		addVar('today', 'Current date', '2026-04-24'); 
		addVar('now', 'ISO datetime', '2026-04-24T14:30:00'); 
		addVar('title', 'Note title', 'April 2026'); 
		addVar('value', 'User input', 'My thought'); 
		addVar('datetime:FORMAT', 'Custom format', '{{datetime:MMMM YYYY}}');
	}

	private renderLintSettings(containerEl: HTMLElement) {
		new Setting(containerEl).setName('Automatic linting').setHeading();
		const autoLintGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
		new Setting(autoLintGroup).setName('Lint on save').setDesc('Automatically run the lint command when a file is modified.').addToggle(t => t.setValue(this.plugin.settings.lintOnSave).onChange(async (v) => { this.plugin.settings.lintOnSave = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl).setName('Manual linting').setHeading();
		const manualLintGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
		new Setting(manualLintGroup)
			.setName('Lint vault')
			.setDesc('Run the lint command on every Markdown file in your vault. Warning: This can be slow for large vaults.')
			.addButton(bt => bt
				.setButtonText('Lint Vault')
				.setWarning()
				.onClick(async () => {
					await this.plugin.linter.lintVault();
				})
			);

		new Setting(containerEl).setName('Date keys').setHeading();

		const dateGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
		new Setting(dateGroup).setName('Created date key').setDesc('Property key for the creation date.').addText(t => t.setPlaceholder('created').setValue(this.plugin.settings.lintCreatedKey).onChange(async (v) => { this.plugin.settings.lintCreatedKey = v; await this.plugin.saveSettings(); }).inputEl.addClass('pi-width-normal'));
		dateGroup.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(dateGroup).setName('Modified date key').setDesc('Property key for the last modified date.').addText(t => t.setPlaceholder('updated').setValue(this.plugin.settings.lintModifiedKey).onChange(async (v) => { this.plugin.settings.lintModifiedKey = v; await this.plugin.saveSettings(); }).inputEl.addClass('pi-width-normal'));

		new Setting(containerEl).setName('Formatting').setHeading();
		const formattingGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
		new Setting(formattingGroup).setName('Blank line after yaml').setDesc('Ensure there is at least one blank line after the frontmatter.').addToggle(t => t.setValue(this.plugin.settings.lintBlankLineAfterYaml).onChange(async (v) => { this.plugin.settings.lintBlankLineAfterYaml = v; await this.plugin.saveSettings(); }));
		
		const autoSize = (el: HTMLTextAreaElement) => { 
			el.setCssProps({ height: 'auto' });
			el.setCssProps({ height: `${el.scrollHeight}px` });
		};

		formattingGroup.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(formattingGroup).setName('Yaml key priority').setDesc('Keys to move to the top of frontmatter (one per line).').addTextArea(t => {
			t.setPlaceholder('title\ncreated\nupdated').setValue(this.plugin.settings.lintYamlKeyPriority.join('\n')).onChange(async (v) => { this.plugin.settings.lintYamlKeyPriority = v.split('\n').map(s => s.trim()).filter(s => s); await this.plugin.saveSettings(); autoSize(t.inputEl); });
			t.inputEl.addClass('crucible-setting-textarea', 'pi-width-normal'); requestAnimationFrame(() => autoSize(t.inputEl));
		});

		formattingGroup.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(formattingGroup).setName('Frontmatter insert').setDesc('Text to ensure exists in the frontmatter (supports template variables).').addTextArea(t => {
			t.setPlaceholder('tags: \nstatus: ').setValue(this.plugin.settings.lintFrontmatterInsert).onChange(async (v) => { this.plugin.settings.lintFrontmatterInsert = v; await this.plugin.saveSettings(); autoSize(t.inputEl); });
			t.inputEl.addClass('crucible-setting-textarea', 'pi-width-normal'); requestAnimationFrame(() => autoSize(t.inputEl));
		});

		containerEl.createEl('hr');
		new Setting(containerEl).setName('Excluded folders').setHeading();
		containerEl.createEl('p', { text: 'Notes in these folders will be ignored by all lint commands.' });

		const ignoreGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
		this.plugin.settings.lintIgnoredFolders.forEach((folder, index) => {
			if (index > 0) ignoreGroup.createEl('hr', { cls: 'crucible-mini-hr' });
			const row = ignoreGroup.createDiv({ cls: 'crucible-folder-template-row' });
			const s = new Setting(row).addSearch(cb => {
				cb.setPlaceholder('Folder to ignore').setValue(folder).onChange(async (v) => { this.plugin.settings.lintIgnoredFolders[index] = v; await this.plugin.saveSettings(); });
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				cb.inputEl.classList.add('crucible-full-width-search');
				new FolderSuggest(this.app, cb.inputEl);
			}).addExtraButton(cb => { cb.setIcon('trash').onClick(async () => { this.plugin.settings.lintIgnoredFolders.splice(index, 1); await this.plugin.saveSettings(); this.display(); }); });
			s.infoEl.remove();
		});
		new Setting(ignoreGroup).addButton(bt => bt.setButtonText('Add ignored folder').setCta().onClick(async () => { this.plugin.settings.lintIgnoredFolders.push(''); await this.plugin.saveSettings(); this.display(); }));
	}

	private renderShortcutSettings(containerEl: HTMLElement) {
		new Setting(containerEl).setName('Command shortcuts').setHeading();
		containerEl.createEl('p', { text: 'Create custom commands to open specific files directly from the Command Palette.' });
		const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
		this.plugin.settings.shortcuts.forEach((shortcut, index) => {
			if (index > 0) group.createEl('hr', { cls: 'crucible-mini-hr' });
			const row = group.createDiv({ cls: 'crucible-folder-template-row' });
			const s = new Setting(row).addText(t => t.setPlaceholder('Shortcut name').setValue(shortcut.name).onChange(async (v) => { shortcut.name = v; await this.plugin.saveSettings(); this.plugin.registerShortcuts(); }).inputEl.addClass('pi-width-normal'))
				.addSearch(cb => {
					cb.setPlaceholder('File to open').setValue(shortcut.file).onChange(async (v) => { shortcut.file = v; await this.plugin.saveSettings(); this.plugin.registerShortcuts(); });
					const el = (cb as unknown as SearchWithContainer).containerEl;
					if (el) el.addClass('crucible-search-container', 'pi-width-normal');
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
			const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
			new Setting(group).setName('Capture name').addText(t => t.setPlaceholder('e.g. quick note').setValue(capture.name).onChange(async (v) => { capture.name = v; await this.plugin.saveSettings(); this.plugin.registerCaptures(); }).inputEl.addClass('pi-width-normal'));
			group.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(group).setName('Target note').addDropdown(dd => { dd.addOptions({ daily: 'Daily note', weekly: 'Weekly note', monthly: 'Monthly note', selected: 'Selected note' }).setValue(capture.targetType).onChange(async (v: CaptureTarget) => { capture.targetType = v; await this.plugin.saveSettings(); this.display(); }); dd.selectEl.addClass('pi-width-half'); });
			if (capture.targetType === 'selected') {
				group.createEl('hr', { cls: 'crucible-row-divider' });
				new Setting(group).setName('Select note').addSearch(cb => { 
					cb.setPlaceholder('e.g. inbox.md').setValue(capture.file).onChange(async (v) => { capture.file = v; await this.plugin.saveSettings(); }); 
					const el = (cb as unknown as SearchWithContainer).containerEl;
					if (el) el.addClass('crucible-search-container', 'pi-width-normal');
					new FileSuggest(this.app, cb.inputEl); 
				});
			}
			group.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(group)
				.setName('Capture source')
				.addDropdown(dd => {
					dd.addOption('dialog', 'Dialog')
					  .addOption('line', 'Current line')
					  .addOption('line-fallback', 'Current line -> Dialog')
					  .addOption('selection', 'Selection')
					  .addOption('selection-fallback', 'Selection -> Dialog')
					  .setValue(capture.source || 'dialog')
					  .onChange(async (value: CaptureSource) => {
						  capture.source = value;
						  await this.plugin.saveSettings();
					  });
					dd.selectEl.addClass('pi-width-half');
				});
			group.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(group).setName('Target section').setDesc('Header to target (e.g. # Captures). If empty, targets top/bottom of file.').addText(t => t.setPlaceholder('# header').setValue(capture.targetSection).onChange(async (v) => { capture.targetSection = v; await this.plugin.saveSettings(); }).inputEl.addClass('pi-width-normal'));
			group.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(group).setName('Prepend content').setDesc('Add to the top of the section/file instead of the bottom.').addToggle(t => t.setValue(capture.prepend).onChange(async (v) => { capture.prepend = v; await this.plugin.saveSettings(); }));
			group.createEl('hr', { cls: 'crucible-row-divider' });
			const autoSize = (el: HTMLTextAreaElement) => { 
				el.setCssProps({ height: 'auto' });
				el.setCssProps({ height: `${el.scrollHeight}px` });
			};
			new Setting(group).setName('Content template').setDesc('Text to capture (supports variables like {{now}}, {{value}}).').addTextArea(t => { t.setPlaceholder('- {{now}}: {{value}}').setValue(capture.content).onChange(async (v) => { capture.content = v; await this.plugin.saveSettings(); autoSize(t.inputEl); }); t.inputEl.addClass('crucible-setting-textarea', 'pi-width-wide'); requestAnimationFrame(() => autoSize(t.inputEl)); });
			group.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(group).addButton(bt => bt.setButtonText('Delete capture').setWarning().onClick(async () => { this.plugin.settings.captures.splice(index, 1); await this.plugin.saveSettings(); this.plugin.registerCaptures(); this.display(); }));
		});
		new Setting(containerEl).addButton(bt => bt.setButtonText('Add capture').setCta().onClick(async () => { this.plugin.settings.captures.push({ name: '', targetType: 'daily', source: 'dialog', file: '', targetSection: '', content: '', prepend: false }); await this.plugin.saveSettings(); this.display(); }));
	}
}
