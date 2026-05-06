/* eslint-disable obsidianmd/ui/sentence-case */
import { App, PluginSettingTab, Setting, setIcon, Platform, Command } from "obsidian";
import CruciblePlugin from "./main";
import { FileSuggest, FolderSuggest, CommandSuggest, findCommandSuggestItem, getCommandSuggestDisplayName } from "./suggesters";
import { Capture, CaptureTarget, CaptureSource, CaptureWriteMode, ToCPosition, ToCCollapseBehavior, Agent, AgentPromptSource, Provider, LlmProviderType, Chain, CrucibleSettings } from "./types";
import { agentCommandId } from "./agents";
import { isValidTimezone } from "./orchestration/utils/dates";

interface SearchWithContainer {
	containerEl: HTMLElement;
}

type CrucibleSettingsTab = 'configure' | 'automate' | 'ai' | 'orchestrator' | 'lint' | 'commands';

export class CrucibleSettingTab extends PluginSettingTab {
	plugin: CruciblePlugin;
	private activeTab: CrucibleSettingsTab = 'configure';
	private editingCaptureIndex: number = -1;
	private editingChainIndex: number = -1;
	private editingProviderIndex: number = -1;
	private editingAgentIndex: number = -1;
	private editingWorkflowId: string | null = null;

	constructor(app: App, plugin: CruciblePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private isEditingDetail(): boolean {
		return this.editingCaptureIndex !== -1 ||
			this.editingChainIndex !== -1 ||
			this.editingProviderIndex !== -1 ||
			this.editingAgentIndex !== -1 ||
			this.editingWorkflowId !== null;
	}

	private resetEditingState(): void {
		this.editingCaptureIndex = -1;
		this.editingChainIndex = -1;
		this.editingProviderIndex = -1;
		this.editingAgentIndex = -1;
		this.editingWorkflowId = null;
	}

	private getChainCommandExtras(): Command[] {
		const chainOnlyCommands: Command[] = [
			{ id: 'crucible:source:active-file', name: 'Crucible Source: Active file contents' },
			{ id: 'crucible:source:selection', name: 'Crucible Source: Editor selection' },
			{ id: 'crucible:source:input', name: 'Crucible Source: User input' },
			{ id: 'crucible:copy-active-file', name: 'Crucible: Copy note to clipboard' },
			{ id: 'crucible:copy-note-to-folder', name: 'Crucible: Copy note to folder' },
			{ id: 'crucible:replace-note-body', name: 'Crucible: Replace note body' },
			{ id: 'crucible:capture', name: 'Crucible: Quick Capture' },
			{ id: 'crucible:upsert-property', name: 'Crucible: Add/update property' },
			{ id: 'crucible:upsert-tags', name: 'Crucible: Upsert tags' },
		];
		const agentExtras: Command[] = this.plugin.settings.agents.map(a => ({
			id: agentCommandId(a.id),
			name: `Crucible Agent: ${a.name || '(unnamed)'}`
		}));

		return [...chainOnlyCommands, ...agentExtras];
	}

	private getChainOnlyCommandList(): { id: string, name: string }[] {
		return [
			{ id: 'crucible:source:active-file', name: 'Source: Active file contents' },
			{ id: 'crucible:source:selection', name: 'Source: Editor selection' },
			{ id: 'crucible:source:input', name: 'Source: User input' },
			{ id: 'crucible:copy-active-file', name: 'Copy note to clipboard' },
			{ id: 'crucible:copy-note-to-folder', name: 'Copy note to folder' },
			{ id: 'crucible:replace-note-body', name: 'Replace note body' },
			{ id: 'crucible:capture', name: 'Quick Capture' },
			{ id: 'crucible:upsert-property', name: 'Add/update property' },
			{ id: 'crucible:upsert-tags', name: 'Upsert tags' },
		];
	}

	private getScrollContainer(): HTMLElement | null {
		// In the settings modal the scroller is .vertical-tab-content; in the
		// workspace-tab view it's the contentEl flagged with .crucible-settings-host.
		return this.containerEl.closest<HTMLElement>('.vertical-tab-content, .crucible-settings-host');
	}

	private refreshDisplay() {
		const scrollEl = this.getScrollContainer();
		const scrollTop = scrollEl?.scrollTop ?? 0;
		this.display();
		requestAnimationFrame(() => { if (scrollEl) scrollEl.scrollTop = scrollTop; });
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const focusTrap = containerEl.createEl('button', { cls: 'crucible-focus-trap' });
		requestAnimationFrame(() => focusTrap.focus());

		const navBar = containerEl.createDiv({ cls: 'crucible-tab-nav' });
		
		if (this.isEditingDetail()) {
			const backBtn = navBar.createDiv({ cls: 'crucible-tab-btn' });
			setIcon(backBtn, 'arrow-left');
			backBtn.createSpan({ text: ' Back' });
			backBtn.onclick = () => {
				this.resetEditingState();
				this.display();
			};
		} else {
			const createTab = (id: CrucibleSettingsTab, icon: string, label: string) => {
				const btn = navBar.createDiv({ 
					cls: `crucible-tab-btn ${this.activeTab === id ? 'is-active' : ''}` 
				});
				setIcon(btn, icon);
				btn.createSpan({ text: ` ${label}` });
				btn.onclick = () => {
					this.activeTab = id;
					this.resetEditingState();
					this.display();
				};
			};

			createTab('configure', 'settings', 'Configure');
			createTab('automate', 'workflow', 'Automate');
			createTab('ai', 'bot', 'AI');
			createTab('orchestrator', 'list-todo', 'Orchestrator');
			createTab('lint', 'check-circle', 'Lint');
			createTab('commands', 'terminal', 'Commands');
		}

		containerEl.createEl('hr', { cls: 'crucible-tab-hr' });

		if (this.activeTab === 'configure') {
			this.renderSettings(containerEl);
		} else if (this.activeTab === 'lint') {
			this.renderLintSettings(containerEl);
		} else if (this.activeTab === 'automate') {
			this.renderAutomateSettings(containerEl);
		} else if (this.activeTab === 'ai') {
			this.renderAiSettings(containerEl);
		} else if (this.activeTab === 'orchestrator') {
			this.renderOrchestrationSettings(containerEl);
		} else if (this.activeTab === 'commands') {
			this.renderCommandSettings(containerEl);
		}
	}

	private renderCommandSettings(containerEl: HTMLElement) {
		new Setting(containerEl).setName('Command visibility').setHeading();
		containerEl.createEl('p', { text: 'Control where commands appear. "Palette" shows the command in the Obsidian Command Palette. "Chains" shows it in the chain step search.' });

		const toggleList = (list: string[], id: string, enabled: boolean): string[] => {
			if (enabled) return list.filter(x => x !== id);
			return list.includes(id) ? list : [...list, id];
		};

		// Palette + Chain Search toggles — for commands registered with this.addCommand()
		const renderGroup = (title: string, commands: { id: string, name: string }[]) => {
			if (commands.length === 0) return;

			new Setting(containerEl).setName(title).setHeading();
			const group = containerEl.createDiv({ cls: 'crucible-settings-group' });

			const header = new Setting(group).setName('').setDesc('');
			header.controlEl.createSpan({ text: 'Palette', cls: 'crucible-toggle-header' });
			header.controlEl.createSpan({ text: 'Chains', cls: 'crucible-toggle-header' });

			commands.sort((a, b) => a.name.localeCompare(b.name));

			commands.forEach((cmd, index) => {
				if (index > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
				const s = new Setting(group)
					.setName(cmd.name)
					.addToggle(toggle => toggle
						.setTooltip('Show in Command Palette')
						.setValue(!this.plugin.settings.hiddenCommands.includes(cmd.id))
						.onChange(async (value) => {
							this.plugin.settings.hiddenCommands = toggleList(this.plugin.settings.hiddenCommands, cmd.id, value);
							await this.plugin.saveSettings();
						}))
					.addToggle(toggle => toggle
						.setTooltip('Show in Chain Search')
						.setValue(!this.plugin.settings.hiddenFromChainSearch.includes(cmd.id))
						.onChange(async (value) => {
							this.plugin.settings.hiddenFromChainSearch = toggleList(this.plugin.settings.hiddenFromChainSearch, cmd.id, value);
							await this.plugin.saveSettings();
						}));

				this.renderHotkey(s.controlEl, cmd.id);
			});
		};

		// Chain Search toggle only — for chain-only internal commands (never in the palette)
		const renderChainOnlyGroup = (title: string, commands: { id: string, name: string }[]) => {
			if (commands.length === 0) return;

			new Setting(containerEl).setName(title).setHeading();
			const group = containerEl.createDiv({ cls: 'crucible-settings-group' });

			const header = new Setting(group).setName('').setDesc('');
			header.controlEl.createSpan({ text: 'Chains', cls: 'crucible-toggle-header' });

			commands.sort((a, b) => a.name.localeCompare(b.name));

			commands.forEach((cmd, index) => {
				if (index > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
				new Setting(group)
					.setName(cmd.name)
					.addToggle(toggle => toggle
						.setTooltip('Show in Chain Search')
						.setValue(!this.plugin.settings.hiddenFromChainSearch.includes(cmd.id))
						.onChange(async (value) => {
							this.plugin.settings.hiddenFromChainSearch = toggleList(this.plugin.settings.hiddenFromChainSearch, cmd.id, value);
							await this.plugin.saveSettings();
						}));
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

		const agentCommands = this.plugin.settings.agents.map(a => ({
			id: agentCommandId(a.id),
			name: `Agent: ${a.name || '(unnamed)'}`
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
		renderGroup('Agents', agentCommands);
		renderGroup('Other', otherCommands);
		renderChainOnlyGroup('Chain Commands', this.getChainOnlyCommandList());
	}

	private renderHotkey(el: HTMLElement, commandId: string) {
		const prefix = this.plugin.manifest.id;
		const fullId = `${prefix}:${commandId}`;
		const hotkeys = this.app.hotkeyManager.getHotkeys(fullId);
		
		if (!hotkeys || hotkeys.length === 0) return;

		const hotkey = hotkeys[0];
		if (!hotkey) return;
		const parts: string[] = hotkey.modifiers.map(mod => {
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

	private renderAutomateSettings(containerEl: HTMLElement) {
		if (this.editingCaptureIndex !== -1) {
			this.renderEditCapture(containerEl);
			return;
		}
		if (this.editingChainIndex !== -1) {
			this.renderEditChain(containerEl);
			return;
		}

		this.renderCaptureListSection(containerEl);
		this.renderChainListSection(containerEl);
		this.renderShortcutSettings(containerEl);
	}

	private renderCaptureListSection(containerEl: HTMLElement) {
		new Setting(containerEl).setName('Captures').setHeading();
		containerEl.createEl('p', { text: 'Define workflows to quickly append, prepend, or replace text in notes.' });

		const group = containerEl.createDiv({ cls: 'crucible-settings-group' });

		if (this.plugin.settings.captures.length === 0) {
			group.createDiv({ text: 'No captures configured.', cls: 'crucible-empty-state' });
		} else {
			this.plugin.settings.captures.forEach((capture, index) => {
				if (index > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
				new Setting(group)
					.setName(capture.name || '(unnamed)')
					.setDesc(this.describeCapture(capture))
					.addExtraButton(cb => cb.setIcon('pencil').setTooltip('Edit capture').onClick(() => {
						this.editingCaptureIndex = index;
						this.display();
					}))
					.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete capture').onClick(async () => {
						this.plugin.settings.captures.splice(index, 1);
						await this.plugin.saveSettings();
						this.plugin.registerCaptures();
						this.display();
					}));
			});
		}

		new Setting(containerEl).addButton(bt => bt.setButtonText('Add capture').setCta().onClick(async () => {
			this.plugin.settings.captures.push({ name: '', targetType: 'daily', source: 'dialog', file: '', targetSection: '', content: '', writeMode: 'append' });
			await this.plugin.saveSettings();
			this.plugin.registerCaptures();
			this.editingCaptureIndex = this.plugin.settings.captures.length - 1;
			this.display();
		}));
	}

	private describeCapture(capture: Capture): string {
		const target = this.captureTargetLabel(capture);
		const source = this.captureSourceLabel(capture.source || 'dialog');
		const writeMode = this.captureWriteModeLabel(capture.writeMode || 'append');
		return `${target} - ${source} - ${writeMode}`;
	}

	private captureTargetLabel(capture: Capture): string {
		if (capture.targetType === 'daily') return 'Daily note';
		if (capture.targetType === 'weekly') return 'Weekly note';
		if (capture.targetType === 'monthly') return 'Monthly note';
		if (capture.targetType === 'active') return 'Active note';
		return capture.file || 'Specified note';
	}

	private captureSourceLabel(source: CaptureSource): string {
		if (source === 'line') return 'Current line';
		if (source === 'line-fallback') return 'Current line or dialog';
		if (source === 'selection') return 'Selection';
		if (source === 'selection-fallback') return 'Selection or dialog';
		return 'Dialog';
	}

	private captureWriteModeLabel(writeMode: CaptureWriteMode): string {
		if (writeMode === 'prepend') return 'Prepend';
		if (writeMode === 'replace') return 'Replace';
		return 'Append';
	}

	private renderChainListSection(containerEl: HTMLElement) {
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
					.addExtraButton(cb => cb.setIcon('copy').setTooltip('Duplicate chain').onClick(async () => {
						const copy = JSON.parse(JSON.stringify(chain)) as Chain;
						copy.name = copy.name ? `${copy.name} (copy)` : '(copy)';
						this.plugin.settings.chains.push(copy);
						await this.plugin.saveSettings();
						this.plugin.registerChains();
						this.display();
					}))
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

		new Setting(containerEl).addButton(bt => bt.setButtonText('Add chain').setCta().onClick(async () => {
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

		group.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(group)
			.setName('Debug mode')
			.setDesc('Log each step\'s input and output to a debug note in _crucible/debug.md.')
			.addToggle(t => t
				.setValue(chain.debugMode ?? false)
				.onChange(async (v) => { chain.debugMode = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl).setName('Variables').setHeading();
		containerEl.createEl('p', { text: 'Define values accessible as {{varName}} in step arguments. The variable {{agent_model}} is set automatically after an agent step.' });

		const varGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
		const variables = chain.variables ?? {};

		Object.entries(variables).forEach(([key, val], index) => {
			if (index > 0) varGroup.createEl('hr', { cls: 'crucible-row-divider' });
			const row = new Setting(varGroup);
			row.addText(t => t
				.setPlaceholder('name')
				.setValue(key)
				.onChange(async (newKey) => {
					delete variables[key];
					variables[newKey] = val;
					chain.variables = variables;
					await this.plugin.saveSettings();
				}).inputEl.addClass('pi-width-small'));
			row.addText(t => t
				.setPlaceholder('value')
				.setValue(val)
				.onChange(async (newVal) => {
					variables[key] = newVal;
					chain.variables = variables;
					await this.plugin.saveSettings();
				}).inputEl.addClass('pi-width-normal'));
			row.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove variable').onClick(async () => {
				delete variables[key];
				chain.variables = variables;
				await this.plugin.saveSettings();
				this.display();
			}));
		});

		new Setting(containerEl).addButton(bt => bt.setButtonText('Add variable').onClick(async () => {
			chain.variables = { ...variables, '': '' };
			await this.plugin.saveSettings();
			this.display();
		}));

		new Setting(containerEl).setName('Steps').setHeading();

		chain.steps.forEach((step, index) => {
			const stepGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
			stepGroup.dataset.stepIndex = String(index);

			new Setting(stepGroup)
				.setName(`Step ${index + 1}`)
				.addExtraButton(cb => cb
					.setIcon('arrow-up')
					.setTooltip('Move step up')
					.setDisabled(index === 0)
					.onClick(async () => {
						if (index === 0) return;
						const [moved] = chain.steps.splice(index, 1);
						if (moved) chain.steps.splice(index - 1, 0, moved);
						await this.plugin.saveSettings();
						this.refreshDisplay();
					}))
				.addExtraButton(cb => cb
					.setIcon('arrow-down')
					.setTooltip('Move step down')
					.setDisabled(index === chain.steps.length - 1)
					.onClick(async () => {
						if (index === chain.steps.length - 1) return;
						const [moved] = chain.steps.splice(index, 1);
						if (moved) chain.steps.splice(index + 1, 0, moved);
						await this.plugin.saveSettings();
						this.refreshDisplay();
					}))
				.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove step').onClick(async () => {
					chain.steps.splice(index, 1);
					await this.plugin.saveSettings();
					this.refreshDisplay();
				}));

			stepGroup.createEl('hr', { cls: 'crucible-row-divider' });

			new Setting(stepGroup)
				.setName('Step type')
				.addDropdown(d => d
					.addOption('command', 'Command')
					.addOption('guard', 'Guard')
					.setValue(step.stepType ?? 'command')
					.onChange(async (v) => {
						step.stepType = v as 'command' | 'guard';
						await this.plugin.saveSettings();
						this.refreshDisplay();
					}));

			stepGroup.createEl('hr', { cls: 'crucible-row-divider' });

			if ((step.stepType ?? 'command') === 'guard') {
				const gc = step.guardCondition ?? { type: 'has-tag' as const };
				if (!step.guardCondition) { step.guardCondition = gc; }

				new Setting(stepGroup)
					.setName('Condition type')
					.addDropdown(d => d
						.addOption('has-tag', 'Note has tag')
						.addOption('not-has-tag', 'Note does not have tag')
						.addOption('has-property', 'Note has property')
						.addOption('not-has-property', 'Note does not have property')
						.addOption('property-equals', 'Property equals value')
						.setValue(gc.type)
						.onChange(async (v) => {
							gc.type = v as typeof gc.type;
							step.guardCondition = gc;
							await this.plugin.saveSettings();
							this.refreshDisplay();
						}));

				stepGroup.createEl('hr', { cls: 'crucible-row-divider' });

				if (gc.type === 'has-tag' || gc.type === 'not-has-tag') {
					const positive = gc.type === 'has-tag';
					new Setting(stepGroup)
						.setName('Tag')
						.setDesc(positive ? 'Guard passes if the active note has this tag.' : 'Guard passes if the active note does not have this tag.')
						.addText(t => t
							.setPlaceholder('#refined')
							.setValue(gc.tag ?? '')
							.onChange(async (v) => { gc.tag = v; step.guardCondition = gc; await this.plugin.saveSettings(); })
							.inputEl.addClass('pi-width-normal'));
				} else if (gc.type === 'has-property' || gc.type === 'not-has-property') {
					const positive = gc.type === 'has-property';
					new Setting(stepGroup)
						.setName('Property')
						.setDesc(positive ? 'Guard passes if the active note has this frontmatter property.' : 'Guard passes if the active note does not have this frontmatter property.')
						.addText(t => t
							.setPlaceholder('model')
							.setValue(gc.property ?? '')
							.onChange(async (v) => { gc.property = v; step.guardCondition = gc; await this.plugin.saveSettings(); })
							.inputEl.addClass('pi-width-normal'));
				} else if (gc.type === 'property-equals') {
					new Setting(stepGroup)
						.setName('Property')
						.addText(t => t
							.setPlaceholder('status')
							.setValue(gc.property ?? '')
							.onChange(async (v) => { gc.property = v; step.guardCondition = gc; await this.plugin.saveSettings(); })
							.inputEl.addClass('pi-width-normal'));
					stepGroup.createEl('hr', { cls: 'crucible-row-divider' });
					new Setting(stepGroup)
						.setName('Value')
						.setDesc('Guard passes if the property equals this value.')
						.addText(t => t
							.setPlaceholder('done')
							.setValue(gc.value ?? '')
							.onChange(async (v) => { gc.value = v; step.guardCondition = gc; await this.plugin.saveSettings(); })
							.inputEl.addClass('pi-width-normal'));
				}
			} else {
				new Setting(stepGroup)
					.setName('Command')
					.addSearch(cb => {
						const commandExtras = this.getChainCommandExtras();
						let prevSchema = this.plugin.chainManager.getCommandSchema(step.commandId);
						const updateCommandId = async (commandId: string) => {
							step.commandId = commandId;
							const newSchema = this.plugin.chainManager.getCommandSchema(commandId);
							if (newSchema !== prevSchema) {
								// Schema changed - clear args and rebuild to show new schema inputs
								step.args = {};
								prevSchema = newSchema;
								await this.plugin.saveSettings();
								this.refreshDisplay();
							} else {
								await this.plugin.saveSettings();
							}
						};
						cb.setPlaceholder('Search for a command...')
							.setValue(getCommandSuggestDisplayName(this.app, step.commandId, commandExtras))
							.onChange(async (v) => {
								const selectedCommand = findCommandSuggestItem(this.app, v, commandExtras);
								await updateCommandId(selectedCommand?.id || v);
							});
						const el = (cb as unknown as SearchWithContainer).containerEl;
						if (el) el.addClass('crucible-search-container', 'pi-width-normal');
						new CommandSuggest(this.app, cb.inputEl, commandExtras, command => {
							void updateCommandId(command.id);
						}, this.plugin.settings.hiddenFromChainSearch);
					});

				const schema = this.plugin.chainManager.getCommandSchema(step.commandId);

				if (schema) {
					schema.forEach(arg => {
						stepGroup.createEl('hr', { cls: 'crucible-row-divider' });
						const s = new Setting(stepGroup)
							.setName(arg.name)
							.setDesc(arg.description || '');

						switch (arg.type) {
							case 'text':
								s.addText(t => t
									.setValue(step.args[arg.id] || '')
									.onChange(async (v) => { step.args[arg.id] = v; await this.plugin.saveSettings(); })
									.inputEl.addClass('pi-width-normal'));
								break;
							case 'textarea':
								s.addTextArea(t => t
									.setValue(step.args[arg.id] || '')
									.onChange(async (v) => { step.args[arg.id] = v; await this.plugin.saveSettings(); })
									.inputEl.addClass('crucible-setting-textarea', 'pi-width-normal'));
								break;
							case 'dropdown':
								s.addDropdown(d => {
									if (arg.options) d.addOptions(arg.options);
									d.setValue(step.args[arg.id] || '')
									 .onChange(async (v) => { step.args[arg.id] = v; await this.plugin.saveSettings(); });
									d.selectEl.addClass('pi-width-normal');
								});
								break;
							case 'file':
								s.addSearch(cb => {
									cb.setPlaceholder('Select file...')
										.setValue(step.args[arg.id] || '')
										.onChange(async (v) => { step.args[arg.id] = v; await this.plugin.saveSettings(); });
									const el = (cb as unknown as SearchWithContainer).containerEl;
									if (el) el.addClass('crucible-search-container', 'pi-width-normal');
									new FileSuggest(this.app, cb.inputEl);
								});
								break;
							case 'folder':
								s.addSearch(cb => {
									cb.setPlaceholder('Select folder...')
										.setValue(step.args[arg.id] || '')
										.onChange(async (v) => { step.args[arg.id] = v; await this.plugin.saveSettings(); });
									const el = (cb as unknown as SearchWithContainer).containerEl;
									if (el) el.addClass('crucible-search-container', 'pi-width-normal');
									new FolderSuggest(this.app, cb.inputEl);
								});
								break;
						}
					});
				} else {
					// Fallback for commands without schema (standard Obsidian commands)
					stepGroup.createEl('hr', { cls: 'crucible-row-divider' });
					new Setting(stepGroup)
						.setName('Arguments')
						.setDesc('Support variables like {{response}} from the previous step.')
						.addText(t => t
							.setPlaceholder('Args...')
							.setValue(step.args._default || '')
							.onChange(async (v) => {
								step.args._default = v;
								await this.plugin.saveSettings();
							}).inputEl.addClass('pi-width-normal'));
				}
			}

			stepGroup.createEl('hr', { cls: 'crucible-row-divider' });

			new Setting(stepGroup)
				.setName('Keep going on failure')
				.addToggle(t => t
					.setValue(step.keepGoing)
					.onChange(async (v) => {
						step.keepGoing = v;
						await this.plugin.saveSettings();
					}));

			stepGroup.createEl('hr', { cls: 'crucible-row-divider' });

			new Setting(stepGroup)
				.setName('Capture intermediate output')
				.setDesc('Write this step\'s output to _crucible/step-<name>-output.md for debugging.')
				.addToggle(t => t
					.setValue(step.captureIntermediate ?? false)
					.onChange(async (v) => {
						step.captureIntermediate = v;
						await this.plugin.saveSettings();
					}));
		});

		let insertAt = chain.steps.length; // default: end of chain

		const actionRow = new Setting(containerEl);
		actionRow.addDropdown(d => {
			d.addOption(String(chain.steps.length), 'At end');
			chain.steps.forEach((_, i) => { d.addOption(String(i), `Before step ${i + 1}`); });
			d.setValue(String(insertAt));
			d.onChange(v => { insertAt = Number(v); });
			d.selectEl.addClass('pi-width-small');
		});
		actionRow.addButton(bt => bt.setButtonText('Add step').setCta().onClick(() => {
			void (async () => {
				chain.steps.splice(insertAt, 0, { commandId: '', keepGoing: false, args: {} });
				await this.plugin.saveSettings();
				const targetIndex = insertAt;
				this.display();
				requestAnimationFrame(() => {
					const scrollEl = this.getScrollContainer();
					const newStep = this.containerEl.querySelector<HTMLElement>(`[data-step-index="${targetIndex}"]`);
					if (newStep && scrollEl) {
						const stepTop = newStep.offsetTop;
						const stepCenter = stepTop + newStep.offsetHeight / 2;
						scrollEl.scrollTop = stepCenter - scrollEl.clientHeight / 2;
					}
				});
			})();
		}));
		actionRow.addButton(bt => bt.setButtonText('Preview chain').onClick(() => {
			this.plugin.chainManager.previewChain(chain);
		}));
	}

	private renderAiSettings(containerEl: HTMLElement) {
		if (this.editingProviderIndex !== -1) {
			const provider = this.plugin.settings.providers[this.editingProviderIndex];
			if (provider) {
				new Setting(containerEl).setName('Edit Provider').setHeading();
				const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
				this.renderEditProvider(group, provider, this.editingProviderIndex);
				return;
			}
			this.editingProviderIndex = -1;
		}

		if (this.editingAgentIndex !== -1) {
			const agent = this.plugin.settings.agents[this.editingAgentIndex];
			if (agent) {
				new Setting(containerEl).setName('Edit Agent').setHeading();
				const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
				this.renderEditAgent(group, agent, this.editingAgentIndex);
				return;
			}
			this.editingAgentIndex = -1;
		}

		this.renderProviderListSection(containerEl);
		this.renderAgentListSection(containerEl);
	}

	private renderProviderListSection(containerEl: HTMLElement) {
		new Setting(containerEl).setName('Providers').setHeading();
		containerEl.createEl('p', { text: 'Configure LLM connections and models. Agents reference providers when they run.' });

		const group = containerEl.createDiv({ cls: 'crucible-settings-group' });

		if (this.plugin.settings.providers.length === 0) {
			group.createDiv({ text: 'No providers configured.', cls: 'crucible-empty-state' });
		} else {
			this.plugin.settings.providers.forEach((provider, index) => {
				if (index > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
				new Setting(group)
					.setName(provider.name || '(unnamed)')
					.setDesc(this.describeProvider(provider))
					.addExtraButton(cb => cb.setIcon('pencil').setTooltip('Edit provider').onClick(() => {
						this.editingProviderIndex = index;
						this.display();
					}))
					.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete provider').onClick(async () => {
						await this.deleteProvider(index);
					}));
			});
		}

		new Setting(containerEl).addButton(bt => bt.setButtonText('Add provider').setCta().onClick(async () => {
			const id = Math.random().toString(36).substring(2, 9);
			this.plugin.settings.providers.push({ id, name: '', type: 'openai', model: 'gpt-4o' });
			await this.plugin.saveSettings();
			this.editingProviderIndex = this.plugin.settings.providers.length - 1;
			this.display();
		}));
	}

	private describeProvider(provider: Provider): string {
		const typeLabels: Record<LlmProviderType, string> = {
			openai: 'OpenAI',
			anthropic: 'Anthropic',
			google: 'Google',
			openrouter: 'OpenRouter',
			ollama: 'Ollama'
		};
		return `${typeLabels[provider.type]} - ${provider.model || '(no model)'}`;
	}

	private async deleteProvider(index: number) {
		const provider = this.plugin.settings.providers[index];
		if (!provider) return;

		this.plugin.settings.providers.splice(index, 1);
		this.editingProviderIndex = -1;
		await this.plugin.saveSettings();
		await this.plugin.providerManager.deleteApiKey(provider.id);
		this.plugin.registerAgents();
		this.display();
	}

	private renderEditProvider(containerEl: HTMLElement, provider: Provider, index: number) {
		new Setting(containerEl)
			.setName(`Provider: ${provider.name || '(unnamed)'}`)
			.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete provider').onClick(async () => {
				await this.deleteProvider(index);
			}));

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });

		new Setting(containerEl)
			.setName('Name')
			.addText(t => t
				.setPlaceholder('e.g. GPT-4o')
				.setValue(provider.name)
				.onChange(async (v) => { provider.name = v; await this.plugin.saveSettings(); })
				.inputEl.addClass('pi-width-normal'));

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });

		new Setting(containerEl)
			.setName('Type')
			.addDropdown(d => {
				d.addOption('openai', 'OpenAI')
					.addOption('anthropic', 'Anthropic')
					.addOption('google', 'Google (Gemini)')
					.addOption('openrouter', 'OpenRouter')
					.addOption('ollama', 'Ollama (Local)')
					.setValue(provider.type)
					.onChange(async (v: LlmProviderType) => { provider.type = v; await this.plugin.saveSettings(); this.display(); });
				d.selectEl.addClass('pi-width-half');
			});

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });

		new Setting(containerEl)
			.setName('Model')
			.addText(t => {
				let placeholder = 'e.g. gpt-4o';
				if (provider.type === 'ollama') placeholder = 'e.g. llama3';
				if (provider.type === 'google') placeholder = 'e.g. gemini-1.5-pro';
				if (provider.type === 'openrouter') placeholder = 'e.g. anthropic/claude-3.5-sonnet';

				t.setPlaceholder(placeholder)
				 .setValue(provider.model)
				 .onChange(async (v) => { provider.model = v; await this.plugin.saveSettings(); });
				t.inputEl.addClass('pi-width-normal');
			});

		if (provider.type !== 'ollama') {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(containerEl)
				.setName('API Key')
				.setDesc('Stored securely in Obsidian Secret Storage.')
				.addText(t => {
					t.inputEl.type = 'password';
					t.setPlaceholder('Enter API key...')
					 .onChange(async (v) => {
						await this.plugin.providerManager.storeApiKey(provider.id, v);
					 });
					t.inputEl.addClass('pi-width-normal');
					// We don't load the key back into the UI for security
				});
		} else {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(containerEl)
				.setName('Ollama URL')
				.setDesc('Default is http://localhost:11434')
				.addText(t => t
					.setPlaceholder('http://localhost:11434')
					.setValue(provider.baseUrl || '')
					.onChange(async (v) => { provider.baseUrl = v; await this.plugin.saveSettings(); })
					.inputEl.addClass('pi-width-normal'));
		}
	}

	private renderAgentListSection(containerEl: HTMLElement) {
		new Setting(containerEl).setName('Agents').setHeading();
		containerEl.createEl('p', { text: 'An Agent binds a Provider to a system prompt and a user-prompt template. Each Agent is registered as an internal command so it can be used as a step in a Chain.' });

		if (this.plugin.settings.providers.length === 0) {
			const empty = containerEl.createDiv({ cls: 'crucible-settings-group' });
			empty.createDiv({ text: 'Configure at least one Provider before adding agents.', cls: 'crucible-empty-state' });
		}

		const listGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });

		if (this.plugin.settings.agents.length === 0) {
			listGroup.createDiv({ text: 'No agents configured.', cls: 'crucible-empty-state' });
		} else {
			this.plugin.settings.agents.forEach((agent, index) => {
				if (index > 0) listGroup.createEl('hr', { cls: 'crucible-row-divider' });
				new Setting(listGroup)
					.setName(agent.name || '(unnamed)')
					.setDesc(this.describeAgent(agent))
					.addExtraButton(cb => cb.setIcon('pencil').setTooltip('Edit agent').onClick(() => {
						this.editingAgentIndex = index;
						this.display();
					}))
					.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete agent').onClick(async () => {
						await this.deleteAgent(index);
					}));
			});
		}

		new Setting(containerEl).addButton(bt => bt
			.setButtonText('Add agent')
			.setCta()
			.setDisabled(this.plugin.settings.providers.length === 0)
			.onClick(async () => {
				const id = Math.random().toString(36).substring(2, 9);
				const firstProvider = this.plugin.settings.providers[0];
				this.plugin.settings.agents.push({
					id,
					name: '',
					providerId: firstProvider ? firstProvider.id : '',
					systemPromptSource: 'text',
					systemPromptText: '',
					systemPromptFile: '',
					userPromptSource: 'text',
					userPromptText: '{{input}}',
					userPromptFile: ''
				});
				await this.plugin.saveSettings();
				this.plugin.registerAgents();
				this.editingAgentIndex = this.plugin.settings.agents.length - 1;
				this.display();
			}));
	}

	private describeAgent(agent: Agent): string {
		const provider = this.plugin.settings.providers.find(p => p.id === agent.providerId);
		const providerName = provider ? provider.name || `(unnamed ${provider.type})` : 'No provider selected';
		return `${providerName} - ${agentCommandId(agent.id)}`;
	}

	private async deleteAgent(index: number) {
		if (!this.plugin.settings.agents[index]) return;

		this.plugin.settings.agents.splice(index, 1);
		this.editingAgentIndex = -1;
		await this.plugin.saveSettings();
		this.plugin.registerAgents();
		this.display();
	}

	private renderEditAgent(containerEl: HTMLElement, agent: Agent, index: number) {
		const commandId = agentCommandId(agent.id);

		new Setting(containerEl)
			.setName(`Agent: ${agent.name || '(unnamed)'}`)
			.setDesc(`Chain command: ${commandId}`)
			.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete agent').onClick(async () => {
				await this.deleteAgent(index);
			}));

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });

		new Setting(containerEl)
			.setName('Name')
			.addText(t => t
				.setPlaceholder('e.g. Summarize')
				.setValue(agent.name)
				.onChange(async (v) => {
					agent.name = v;
					await this.plugin.saveSettings();
				})
				.inputEl.addClass('pi-width-normal'));

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });

		new Setting(containerEl)
			.setName('Provider')
			.setDesc('LLM connection used to run this agent.')
			.addDropdown(d => {
				if (this.plugin.settings.providers.length === 0) {
					d.addOption('', 'No providers configured');
				} else {
					if (!agent.providerId || !this.plugin.settings.providers.find(p => p.id === agent.providerId)) {
						d.addOption('', 'Select a provider...');
					}
					this.plugin.settings.providers.forEach(p => {
						d.addOption(p.id, p.name || `(unnamed ${p.type})`);
					});
				}
				d.setValue(agent.providerId)
				 .onChange(async (v) => {
					agent.providerId = v;
					await this.plugin.saveSettings();
				 });
				d.selectEl.addClass('pi-width-normal');
			});

		const autoSize = (el: HTMLTextAreaElement) => {
			el.setCssProps({ height: 'auto' });
			el.setCssProps({ height: `${el.scrollHeight}px` });
		};

		const renderPromptEditor = (
			label: string,
			description: string,
			placeholder: string,
			getSource: () => AgentPromptSource,
			setSource: (v: AgentPromptSource) => Promise<void>,
			getText: () => string,
			setText: (v: string) => Promise<void>,
			getFile: () => string,
			setFile: (v: string) => Promise<void>,
		) => {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });

			new Setting(containerEl)
				.setName(label)
				.setDesc(description)
				.addDropdown(d => {
					d.addOption('text', 'Text')
					 .addOption('file', 'Vault file')
					 .setValue(getSource())
					 .onChange(async (v: AgentPromptSource) => {
						 await setSource(v);
						 this.display();
					 });
					d.selectEl.addClass('pi-width-half');
				});

			containerEl.createEl('hr', { cls: 'crucible-row-divider' });

			if (getSource() === 'file') {
				new Setting(containerEl)
					.setName(`${label} file`)
					.setDesc('Markdown file in your vault. Its contents are loaded each time the agent runs.')
					.addSearch(cb => {
						cb.setPlaceholder('prompts/summarize.md')
						  .setValue(getFile())
						  .onChange(async (v) => { await setFile(v); });
						const el = (cb as unknown as SearchWithContainer).containerEl;
						if (el) el.addClass('crucible-search-container', 'pi-width-wide');
						new FileSuggest(this.app, cb.inputEl);
					});
			} else {
				new Setting(containerEl)
					.setName(`${label} text`)
					.setDesc('Inline prompt template.')
					.addTextArea(t => {
						t.setPlaceholder(placeholder)
						 .setValue(getText())
						 .onChange(async (v) => {
							await setText(v);
							autoSize(t.inputEl);
						 });
						t.inputEl.addClass('crucible-setting-textarea', 'pi-width-wide');
						requestAnimationFrame(() => autoSize(t.inputEl));
					});
			}
		};

		renderPromptEditor(
			'System prompt',
			'Persistent instructions for the agent. Supports template tokens like {{today}}, {{datetime:FORMAT}}.',
			'You are a helpful assistant...',
			() => agent.systemPromptSource || 'text',
			async (v) => { agent.systemPromptSource = v; await this.plugin.saveSettings(); },
			() => agent.systemPromptText || '',
			async (v) => { agent.systemPromptText = v; await this.plugin.saveSettings(); },
			() => agent.systemPromptFile || '',
			async (v) => { agent.systemPromptFile = v; await this.plugin.saveSettings(); },
		);

		renderPromptEditor(
			'User prompt template',
			'Template for the user message. {{input}} (or {{value}}) is replaced by the runtime input passed to the agent.',
			'Summarize the following:\n\n{{input}}',
			() => agent.userPromptSource || 'text',
			async (v) => { agent.userPromptSource = v; await this.plugin.saveSettings(); },
			() => agent.userPromptText || '',
			async (v) => { agent.userPromptText = v; await this.plugin.saveSettings(); },
			() => agent.userPromptFile || '',
			async (v) => { agent.userPromptFile = v; await this.plugin.saveSettings(); },
		);
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

	private getWorkflowMeta(): { id: string; name: string; description: string; enabledKey: keyof CrucibleSettings; render: (containerEl: HTMLElement) => void }[] {
		return [
			{
				id: 'daily_brief_lite',
				name: 'Daily Brief Lite',
				description: 'Fetch FX rates and weather, then inject them into today\'s daily note.',
				enabledKey: 'orchestrationDailyBriefEnabled',
				render: (el) => this.renderEditDailyBriefWorkflow(el),
			},
			{
				id: 'transcript_refine',
				name: 'Transcript Refine',
				description: 'Run an AI chain against a target transcript note.',
				enabledKey: 'orchestrationTranscriptRefineEnabled',
				render: (el) => this.renderEditTranscriptRefineWorkflow(el),
			},
			{
				id: 'youtube_tracker',
				name: 'YouTube Tracker',
				description: 'Poll configured YouTube channels for new videos and create intake notes.',
				enabledKey: 'orchestrationYoutubeTrackerEnabled',
				render: (el) => this.renderEditYoutubeTrackerWorkflow(el),
			},
			{
				id: 'link_scan',
				name: 'Link Scan',
				description: 'Scan the vault for URLs and build a canonical link registry.',
				enabledKey: 'orchestrationLinkScanEnabled',
				render: (el) => this.renderEditLinkScanWorkflow(el),
			},
		];
	}

	private renderOrchestrationSettings(containerEl: HTMLElement) {
		const workflows = this.getWorkflowMeta();

		if (this.editingWorkflowId !== null) {
			const meta = workflows.find(w => w.id === this.editingWorkflowId);
			if (meta) {
				new Setting(containerEl).setName(`Edit Workflow: ${meta.name}`).setHeading();
				const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
				meta.render(group);
				return;
			}
			this.editingWorkflowId = null;
		}

		new Setting(containerEl).setName('Orchestrator').setHeading();
		containerEl.createEl('p', { text: 'Vault-native deterministic job runner. Jobs are markdown files in queue folders that move through inbox → running → done | failed. Manual execution only — use the "Orchestrator: Scan" and "Orchestrator: Run next" commands.' });

		const globalGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });

		new Setting(globalGroup)
			.setName('Enabled')
			.setDesc('When off, scan and run-next show a notice and do nothing.')
			.addToggle(t => t.setValue(this.plugin.settings.orchestrationEnabled).onChange(async (v) => {
				this.plugin.settings.orchestrationEnabled = v;
				await this.plugin.saveSettings();
			}));

		globalGroup.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(globalGroup)
			.setName('Queue folder root')
			.setDesc('Vault folder containing inbox/, running/, done/, failed/ subfolders.')
			.addText(t => t
				.setPlaceholder('_crucible/orchestration/queue')
				.setValue(this.plugin.settings.orchestrationQueueRoot)
				.onChange(async (v) => {
					this.plugin.settings.orchestrationQueueRoot = v.trim() || '_crucible/orchestration/queue';
					await this.plugin.saveSettings();
				})
				.inputEl.addClass('pi-width-normal'));

		globalGroup.createEl('hr', { cls: 'crucible-row-divider' });
		let tzWarning: HTMLElement | null = null;
		const setTzWarningVisibility = (valid: boolean) => {
			if (!tzWarning) return;
			if (valid) tzWarning.addClass('is-hidden');
			else tzWarning.removeClass('is-hidden');
		};
		const tzSetting = new Setting(globalGroup)
			.setName('Timezone')
			.setDesc('IANA timezone name used to determine "today" for date-bound workflows.')
			.addText(t => t
				.setPlaceholder('America/Mexico_City')
				.setValue(this.plugin.settings.orchestrationTimezone)
				.onChange(async (v) => {
					const next = v.trim() || 'America/Mexico_City';
					this.plugin.settings.orchestrationTimezone = next;
					await this.plugin.saveSettings();
					setTzWarningVisibility(isValidTimezone(next));
				})
				.inputEl.addClass('pi-width-normal'));
		tzWarning = tzSetting.descEl.createEl('div', {
			cls: 'crucible-tz-warning',
			text: 'Warning: this timezone is not recognized by Intl.DateTimeFormat.',
		});
		setTzWarningVisibility(isValidTimezone(this.plugin.settings.orchestrationTimezone));

		// --- Workflows list ---
		new Setting(containerEl).setName('Workflows').setHeading();
		containerEl.createEl('p', { text: 'Toggle workflows on or off here. Click the pencil to edit a workflow\'s settings.' });

		const workflowsGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
		workflows.forEach((meta, index) => {
			if (index > 0) workflowsGroup.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(workflowsGroup)
				.setName(meta.name)
				.setDesc(meta.description)
				.addToggle(t => t
					.setTooltip('Enabled')
					.setValue(this.plugin.settings[meta.enabledKey] as boolean)
					.onChange(async (v) => {
						(this.plugin.settings[meta.enabledKey] as boolean) = v;
						await this.plugin.saveSettings();
					}))
				.addExtraButton(cb => cb.setIcon('pencil').setTooltip('Edit workflow').onClick(() => {
					this.editingWorkflowId = meta.id;
					this.display();
				}));
		});

		// --- Actions ---
		new Setting(containerEl).setName('Actions').setHeading();
		const actions = containerEl.createDiv({ cls: 'crucible-settings-group' });
		new Setting(actions)
			.setName('Scan now')
			.setDesc('Ensure queue folders exist, count jobs, and recover any job stuck in running for more than an hour.')
			.addButton(bt => bt.setButtonText('Scan').onClick(async () => {
				await this.plugin.orchestrator.scan();
			}));
		actions.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(actions)
			.setName('Run next')
			.setDesc('Pick the oldest job in inbox and execute it.')
			.addButton(bt => bt.setButtonText('Run next').onClick(async () => {
				await this.plugin.orchestrator.runNext();
			}));
	}

	private renderEditDailyBriefWorkflow(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName('Target section')
			.setDesc('Header to inject the brief under (e.g. # Daily Brief). If empty, defaults to "Daily Brief: External Context".')
			.addText(t => t
				.setPlaceholder('# Daily Brief: External Context')
				.setValue(this.plugin.settings.orchestrationDailyBriefTargetSection)
				.onChange(async (v) => {
					this.plugin.settings.orchestrationDailyBriefTargetSection = v;
					await this.plugin.saveSettings();
				})
				.inputEl.addClass('pi-width-normal'));

		// Currency pairs
		new Setting(containerEl).setName('Currency pairs').setHeading();
		containerEl.createEl('p', { text: 'FX rates to fetch from open.er-api.com. Base and quote are ISO codes (e.g. USD, MXN). Label is shown in the brief.' });

		const fxGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
		const fxPairs = this.plugin.settings.orchestrationDailyBriefFxPairs;
		if (fxPairs.length === 0) {
			fxGroup.createDiv({ text: 'No currency pairs configured.', cls: 'crucible-empty-state' });
		} else {
			fxPairs.forEach((pair, index) => {
				if (index > 0) fxGroup.createEl('hr', { cls: 'crucible-row-divider' });
				const row = new Setting(fxGroup);
				row.addText(t => t
					.setPlaceholder('base (USD)')
					.setValue(pair.base)
					.onChange(async (v) => { pair.base = v.trim().toUpperCase(); await this.plugin.saveSettings(); })
					.inputEl.addClass('pi-width-small'));
				row.addText(t => t
					.setPlaceholder('quote (MXN)')
					.setValue(pair.quote)
					.onChange(async (v) => { pair.quote = v.trim().toUpperCase(); await this.plugin.saveSettings(); })
					.inputEl.addClass('pi-width-small'));
				row.addText(t => t
					.setPlaceholder('label (USD → MXN)')
					.setValue(pair.label)
					.onChange(async (v) => { pair.label = v; await this.plugin.saveSettings(); })
					.inputEl.addClass('pi-width-normal'));
				row.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove pair').onClick(async () => {
					fxPairs.splice(index, 1);
					await this.plugin.saveSettings();
					this.display();
				}));
			});
		}

		new Setting(containerEl).addButton(bt => bt.setButtonText('Add currency pair').onClick(async () => {
			fxPairs.push({ base: '', quote: '', label: '' });
			await this.plugin.saveSettings();
			this.display();
		}));

		// Weather locations
		new Setting(containerEl).setName('Weather locations').setHeading();
		containerEl.createEl('p', { text: 'Locations to fetch daily forecasts from open-meteo.com. Latitude and longitude are decimal degrees.' });

		const wxGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
		const locations = this.plugin.settings.orchestrationDailyBriefWeatherLocations;
		if (locations.length === 0) {
			wxGroup.createDiv({ text: 'No locations configured.', cls: 'crucible-empty-state' });
		} else {
			locations.forEach((loc, index) => {
				if (index > 0) wxGroup.createEl('hr', { cls: 'crucible-row-divider' });
				const row = new Setting(wxGroup);
				row.addText(t => t
					.setPlaceholder('label (Guadalajara, MX)')
					.setValue(loc.label)
					.onChange(async (v) => { loc.label = v; await this.plugin.saveSettings(); })
					.inputEl.addClass('pi-width-normal'));
				row.addText(t => {
					t.setPlaceholder('lat')
						.setValue(loc.lat.toString())
						.onChange(async (v) => {
							const n = Number(v);
							if (Number.isFinite(n)) { loc.lat = n; await this.plugin.saveSettings(); }
						});
					t.inputEl.type = 'number';
					t.inputEl.addClass('pi-width-small');
				});
				row.addText(t => {
					t.setPlaceholder('lon')
						.setValue(loc.lon.toString())
						.onChange(async (v) => {
							const n = Number(v);
							if (Number.isFinite(n)) { loc.lon = n; await this.plugin.saveSettings(); }
						});
					t.inputEl.type = 'number';
					t.inputEl.addClass('pi-width-small');
				});
				row.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove location').onClick(async () => {
					locations.splice(index, 1);
					await this.plugin.saveSettings();
					this.display();
				}));
			});
		}

		new Setting(containerEl).addButton(bt => bt.setButtonText('Add location').onClick(async () => {
			locations.push({ label: '', lat: 0, lon: 0 });
			await this.plugin.saveSettings();
			this.display();
		}));
	}

	private renderEditTranscriptRefineWorkflow(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName('Default chain')
			.setDesc('Chain to run when no agentChainName is specified in the job params.')
			.addText(t => t
				.setPlaceholder('Refine Transcript')
				.setValue(this.plugin.settings.orchestrationTranscriptRefineChainName)
				.onChange(async (v) => {
					this.plugin.settings.orchestrationTranscriptRefineChainName = v.trim() || 'Refine Transcript';
					await this.plugin.saveSettings();
				})
				.inputEl.addClass('pi-width-normal'));
	}

	private renderEditYoutubeTrackerWorkflow(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName('Channels note')
			.setDesc('Markdown note containing the channel registry table.')
			.addSearch(cb => {
				cb.setPlaceholder('_system/youtube/Channels.md')
					.setValue(this.plugin.settings.orchestrationYoutubeChannelsNote)
					.onChange(async (v) => {
						this.plugin.settings.orchestrationYoutubeChannelsNote = v.trim() || '_system/youtube/Channels.md';
						await this.plugin.saveSettings();
					});
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FileSuggest(this.app, cb.inputEl);
			});
	}

	private renderEditLinkScanWorkflow(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName('Registry root')
			.setDesc('Vault folder where one note per canonical URL is stored.')
			.addText(t => t
				.setPlaceholder('_crucible/link_registry')
				.setValue(this.plugin.settings.orchestrationLinkRegistryRoot)
				.onChange(async (v) => {
					this.plugin.settings.orchestrationLinkRegistryRoot = v.trim() || '_crucible/link_registry';
					await this.plugin.saveSettings();
				})
				.inputEl.addClass('pi-width-normal'));

		const autoSize = (el: HTMLTextAreaElement) => {
			el.setCssProps({ height: 'auto' });
			el.setCssProps({ height: `${el.scrollHeight}px` });
		};

		new Setting(containerEl)
			.setName('Scan exclusions')
			.setDesc('Folders to skip during link scan (one path per line). The link registry root is always excluded.')
			.addTextArea(t => {
				t.setPlaceholder('_crucible')
					.setValue(this.plugin.settings.orchestrationLinkScanExclusions.join('\n'))
					.onChange(async (v) => {
						this.plugin.settings.orchestrationLinkScanExclusions = v
							.split('\n')
							.map(s => s.trim())
							.filter(s => s.length > 0);
						await this.plugin.saveSettings();
						autoSize(t.inputEl);
					});
				t.inputEl.addClass('crucible-setting-textarea', 'pi-width-normal');
				requestAnimationFrame(() => autoSize(t.inputEl));
			});

		new Setting(containerEl)
			.setName('Tracked sources note')
			.setDesc('Markdown note that will hold promoted tracked sources as a table (Base URL | Description | Date Added).')
			.addSearch(cb => {
				cb.setPlaceholder('Sources/Tracked Sources.md')
					.setValue(this.plugin.settings.orchestrationTrackedSourcesNote)
					.onChange(async (v) => {
						this.plugin.settings.orchestrationTrackedSourcesNote = v.trim() || 'Sources/Tracked Sources.md';
						await this.plugin.saveSettings();
					});
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FileSuggest(this.app, cb.inputEl);
			});
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
		new Setting(containerEl).setName('Shortcuts').setHeading();
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

	private renderEditCapture(containerEl: HTMLElement) {
		const capture = this.plugin.settings.captures[this.editingCaptureIndex];
		if (!capture) {
			this.editingCaptureIndex = -1;
			this.renderAutomateSettings(containerEl);
			return;
		}

		new Setting(containerEl).setName('Edit Capture').setHeading();

		const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
		new Setting(group)
			.setName('Capture name')
			.addText(t => t
				.setPlaceholder('e.g. quick note')
				.setValue(capture.name)
				.onChange(async (v) => {
					capture.name = v;
					await this.plugin.saveSettings();
					this.plugin.registerCaptures();
				})
				.inputEl.addClass('pi-width-normal'));

		group.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(group)
			.setName('Target note')
			.addDropdown(dd => {
				dd.addOptions({
					daily: 'Daily note',
					weekly: 'Weekly note',
					monthly: 'Monthly note',
					active: 'Active note',
					selected: 'Specify note'
				})
					.setValue(capture.targetType)
					.onChange(async (v: CaptureTarget) => {
						capture.targetType = v;
						await this.plugin.saveSettings();
						this.display();
					});
				dd.selectEl.addClass('pi-width-half');
			});

		if (capture.targetType === 'selected') {
			group.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(group)
				.setName('Select note')
				.addSearch(cb => { 
					cb.setPlaceholder('e.g. inbox.md')
						.setValue(capture.file)
						.onChange(async (v) => { capture.file = v; await this.plugin.saveSettings(); }); 
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
		new Setting(group)
			.setName('Target section')
			.setDesc('Header to target (e.g. # Captures). If empty, targets top/bottom of file.')
			.addText(t => t
				.setPlaceholder('# header')
				.setValue(capture.targetSection)
				.onChange(async (v) => { capture.targetSection = v; await this.plugin.saveSettings(); })
				.inputEl.addClass('pi-width-normal'));

		group.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(group)
			.setName('Write mode')
			.setDesc('How captured content is added to the target section or file.')
			.addDropdown(dd => {
				dd.addOption('append', 'Append')
				  .addOption('prepend', 'Prepend')
				  .addOption('replace', 'Replace')
				  .setValue(capture.writeMode || 'append')
				  .onChange(async (v: CaptureWriteMode) => {
					  capture.writeMode = v;
					  await this.plugin.saveSettings();
				  });
				dd.selectEl.addClass('pi-width-half');
			});

		group.createEl('hr', { cls: 'crucible-row-divider' });
		const autoSize = (el: HTMLTextAreaElement) => { 
			el.setCssProps({ height: 'auto' });
			el.setCssProps({ height: `${el.scrollHeight}px` });
		};
		new Setting(group)
			.setName('Content template')
			.setDesc('Text to capture (supports variables like {{now}}, {{value}}).')
			.addTextArea(t => {
				t.setPlaceholder('- {{now}}: {{value}}')
					.setValue(capture.content)
					.onChange(async (v) => {
						capture.content = v;
						await this.plugin.saveSettings();
						autoSize(t.inputEl);
					});
				t.inputEl.addClass('crucible-setting-textarea', 'pi-width-wide');
				requestAnimationFrame(() => autoSize(t.inputEl));
			});

		group.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(group).addButton(bt => bt.setButtonText('Delete capture').setWarning().onClick(async () => {
			this.plugin.settings.captures.splice(this.editingCaptureIndex, 1);
			this.editingCaptureIndex = -1;
			await this.plugin.saveSettings();
			this.plugin.registerCaptures();
			this.display();
		}));
	}
}
