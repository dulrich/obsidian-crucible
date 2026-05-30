/* eslint-disable obsidianmd/ui/sentence-case */
import { App, PluginSettingTab, Setting, setIcon, Command, ExtraButtonComponent, TextComponent, Notice } from "obsidian";
import CruciblePlugin, { CrucibleCommandGroup } from "./main";
import { getCommandHotkeyLabel } from "./utils";
import { FileSuggest, FolderSuggest, CommandSuggest, CurrencySuggest, LocationSuggest, findCommandSuggestItem, getCommandSuggestDisplayName } from "./suggesters";
import { Capture, CaptureTarget, CaptureSource, CaptureTargetSectionMode, CaptureWriteMode, ToCPosition, ToCCollapseBehavior, Agent, AgentBindingMode, AgentExecutionMode, AgentPromptSource, Provider, ProviderKind, ProviderModel, ProviderModelRef, providerModality, Chain, CrucibleSettings, CrucibleCommandPaletteFilterMode, ImageConvertFormat, LocalizeMediaType, OBSIDIAN_NATIVE_EMBED_FORMATS, CurrencyCache, GeocodeCacheEntry } from "./types";
import { agentCommandId } from "./agents";
import { CLI_DEFAULT_TIMEOUT_SECONDS } from "./providers";
import { isValidTimezone } from "./orchestration/utils/dates";
import { PERIOD_IDS, PeriodId, getPeriodConfig, getPeriodConfigByTarget } from "./periods";
import { deleteYoutubeApiKey, loadYoutubeApiKey, storeYoutubeApiKey } from "./orchestration/utils/youtubeApi";

interface SearchWithContainer {
	containerEl: HTMLElement;
}

interface TemplateVariableInfo {
	token: string;
	description: string;
	example: string;
}

const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
	openai: 'OpenAI',
	anthropic: 'Anthropic',
	google: 'Google (Gemini)',
	openrouter: 'OpenRouter',
	ollama: 'Ollama (Local API)',
	'gemini-cli': 'Gemini CLI',
	'claude-cli': 'Claude Code CLI',
	'codex-cli': 'OpenAI Codex CLI',
	'opencode-cli': 'OpenCode CLI',
};

function sortByNameWithEmptyLast<T>(items: T[], getName: (item: T) => string): { item: T; index: number }[] {
	return items
		.map((item, index) => ({ item, index }))
		.sort((a, b) => {
			const an = getName(a.item) || '';
			const bn = getName(b.item) || '';
			if (!an && bn) return 1;
			if (an && !bn) return -1;
			return an.localeCompare(bn);
		});
}

function defaultCliCommand(kind: ProviderKind): string {
	switch (kind) {
		case 'gemini-cli': return 'gemini';
		case 'claude-cli': return 'claude';
		case 'codex-cli': return 'codex';
		case 'opencode-cli': return 'opencode';
		default: return '';
	}
}

function modelIdPlaceholder(kind: ProviderKind): string {
	switch (kind) {
		case 'openai': return 'gpt-4o';
		case 'anthropic': return 'claude-3-5-sonnet-latest';
		case 'google': return 'gemini-1.5-pro';
		case 'openrouter': return 'anthropic/claude-3.5-sonnet';
		case 'ollama': return 'llama3';
		case 'gemini-cli': return 'gemini-2.5-pro';
		case 'claude-cli': return 'claude-sonnet-4-5';
		case 'codex-cli': return 'gpt-5';
		case 'opencode-cli': return 'anthropic/claude-sonnet-4-5';
		default: return '';
	}
}

function collectAllRefs(providers: Provider[]): ProviderModelRef[] {
	const refs: ProviderModelRef[] = [];
	for (const provider of providers) {
		for (const model of provider.models ?? []) {
			refs.push({ providerId: provider.id, modelId: model.id });
		}
	}
	return refs;
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
	private expandedTemplateVariablePanels: Set<string> = new Set();

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

	private baseTemplateVariables(includeValue: boolean = true): TemplateVariableInfo[] {
		const variables: TemplateVariableInfo[] = [
			{ token: 'date', description: 'Target date (YYYY-MM-DD)', example: '2026-04-24' },
			{ token: 'time', description: 'Target time (HH:mm)', example: '14:30' },
			{ token: 'today', description: 'Current date', example: '2026-04-24' },
			{ token: 'now', description: 'ISO datetime', example: '2026-04-24T14:30:00' },
			{ token: 'title', description: 'Note title', example: 'April 2026' },
		];
		if (includeValue) {
			variables.push({ token: 'value', description: 'Runtime input', example: 'My thought' });
		}
		variables.push({ token: 'datetime:FORMAT', description: 'Custom format', example: '{{datetime:MMMM YYYY}}' });
		return variables;
	}

	private captureTemplateVariables(): TemplateVariableInfo[] {
		return [
			...this.baseTemplateVariables(),
			{ token: 'source_link', description: 'Capture source note link', example: '[[Projects/Ideas|Ideas]]' },
			{ token: 'source_path', description: 'Capture source note path', example: 'Projects/Ideas' },
			{ token: 'source_title', description: 'Capture source note title', example: 'Ideas' },
		];
	}

	private chainArgumentVariables(chain: Chain): TemplateVariableInfo[] {
		const variables: TemplateVariableInfo[] = [
			{ token: 'response', description: 'Previous step output', example: 'Refined transcript...' },
			{ token: 'target_path', description: 'Path of the note active when the chain started', example: 'Projects/Ideas.md' },
			{ token: 'agent_model', description: 'Model returned by the previous agent step', example: 'gpt-5' },
			{ token: 'agent_provider', description: 'Provider returned by the previous agent step', example: 'openai' },
		];
		for (const key of Object.keys(chain.variables ?? {}).filter(Boolean)) {
			variables.push({ token: key, description: 'Chain variable', example: chain.variables?.[key] ?? '' });
		}
		return variables;
	}

	private agentPromptVariables(includeInput: boolean): TemplateVariableInfo[] {
		const variables = this.baseTemplateVariables();
		if (includeInput) {
			variables.push({ token: 'input', description: 'Runtime input; same value as {{value}}', example: 'Text to summarize' });
		}
		return variables;
	}

	private periodTemplateVariables(): TemplateVariableInfo[] {
		return this.baseTemplateVariables(false);
	}

	private renderTemplateVariableGrid(containerEl: HTMLElement, variables: TemplateVariableInfo[]): HTMLElement {
		const grid = containerEl.createDiv({ cls: 'crucible-variables-grid' });
		for (const variable of variables) {
			const row = grid.createDiv({ cls: 'crucible-variable-row' });
			row.createDiv({ cls: 'crucible-variable-token', text: `{{${variable.token}}}` });
			row.createDiv({ cls: 'crucible-variable-description', text: variable.description });
			row.createDiv({ cls: 'crucible-variable-example', text: variable.example });
		}
		return grid;
	}

	private addTemplateVariablesToggle(setting: Setting, panelKey: string, variables: TemplateVariableInfo[]): void {
		const expanded = this.expandedTemplateVariablePanels.has(panelKey);
		setting.addExtraButton((button: ExtraButtonComponent) => {
			button
				.setIcon('braces')
				.setTooltip(expanded ? 'Hide template variables' : 'Show template variables')
				.onClick(() => {
					if (expanded) {
						this.expandedTemplateVariablePanels.delete(panelKey);
					} else {
						this.expandedTemplateVariablePanels.add(panelKey);
					}
					this.refreshDisplay();
				});
			button.extraSettingsEl.addClass('crucible-template-vars-toggle');
			setting.controlEl.appendChild(button.extraSettingsEl);
		});
		setting.settingEl.toggleClass('has-crucible-template-vars', variables.length > 0);
	}

	private renderTemplateVariablesPanel(containerEl: HTMLElement, panelKey: string, variables: TemplateVariableInfo[]): void {
		if (!this.expandedTemplateVariablePanels.has(panelKey)) return;
		const panel = containerEl.createDiv({ cls: 'crucible-template-variable-panel' });
		this.renderTemplateVariableGrid(panel, variables);
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
			createTab('orchestrator', 'list-todo', 'Orchestrate');
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

		const GROUP_ORDER: CrucibleCommandGroup[] = [
			'Materialize',
			'Lint',
			'Captures',
			'Shortcuts',
			'Chains',
			'Agents',
			'Files',
			'Orchestrations',
			'Other',
		];

		for (const group of GROUP_ORDER) {
			const commands = this.plugin.commandRegistry
				.filter(c => c.group === group)
				.map(c => ({ id: c.id, name: c.name }));
			renderGroup(group, commands);
		}
		renderChainOnlyGroup('Chain Commands', this.getChainOnlyCommandList());

		this.renderCrucibleCommandPaletteSettings(containerEl);
	}

	private renderCrucibleCommandPaletteSettings(containerEl: HTMLElement) {
		new Setting(containerEl).setName('Command palette').setHeading();
		containerEl.createEl('p', { text: 'A replacement command palette with pinned commands and whitelist/blacklist filtering of non-Crucible commands. Crucible commands always honor the visibility toggles above.' });

		const group = containerEl.createDiv({ cls: 'crucible-settings-group' });

		new Setting(group)
			.setName('Enable Crucible command palette')
			.setDesc('Registers the "Open Crucible command palette" command. Bind a hotkey in Obsidian\'s Hotkeys settings to invoke it.')
			.addToggle(t => t
				.setValue(this.plugin.settings.crucibleCommandPaletteEnabled)
				.onChange(async (v) => {
					this.plugin.settings.crucibleCommandPaletteEnabled = v;
					await this.plugin.saveSettings();
					this.refreshDisplay();
				}));

		if (!this.plugin.settings.crucibleCommandPaletteEnabled) return;

		group.createEl('hr', { cls: 'crucible-row-divider' });

		new Setting(group)
			.setName('Show configured hotkeys')
			.setDesc('Display each command\'s bound hotkey as a pill in the palette.')
			.addToggle(t => t
				.setValue(this.plugin.settings.crucibleCommandPaletteShowHotkeys)
				.onChange(async (v) => {
					this.plugin.settings.crucibleCommandPaletteShowHotkeys = v;
					await this.plugin.saveSettings();
				}));

		new Setting(group)
			.setName('Show shortest unique fuzzy string')
			.setDesc('Display the shortest text you could type to surface each command on its own, as a pill.')
			.addToggle(t => t
				.setValue(this.plugin.settings.crucibleCommandPaletteShowUniqueString)
				.onChange(async (v) => {
					this.plugin.settings.crucibleCommandPaletteShowUniqueString = v;
					await this.plugin.saveSettings();
				}));

		group.createEl('hr', { cls: 'crucible-row-divider' });
		this.renderPinnedCommandList(group);

		group.createEl('hr', { cls: 'crucible-row-divider' });
		this.renderPaletteFilterSection(group);
	}

	private renderPinnedCommandList(containerEl: HTMLElement) {
		const pinned = this.plugin.settings.crucibleCommandPalettePinned;

		new Setting(containerEl)
			.setName('Pinned commands')
			.setDesc('Pinned commands appear at the top of the palette in this order.')
			.addSearch(cb => {
				cb.setPlaceholder('Search for a command to pin...');
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new CommandSuggest(this.app, cb.inputEl, [], (command) => {
					if (pinned.includes(command.id)) return;
					pinned.push(command.id);
					cb.setValue('');
					void this.plugin.saveSettings();
					this.refreshDisplay();
				}, pinned);
			});

		if (pinned.length === 0) {
			containerEl.createDiv({ text: 'No pinned commands.', cls: 'crucible-empty-state' });
			return;
		}

		const list = containerEl.createDiv({ cls: 'crucible-settings-group' });
		pinned.forEach((id, index) => {
			if (index > 0) list.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(list)
				.setName(getCommandSuggestDisplayName(this.app, id))
				.setDesc(id)
				.addExtraButton(cb => cb
					.setIcon('arrow-up')
					.setTooltip('Move up')
					.setDisabled(index === 0)
					.onClick(async () => {
						if (index === 0) return;
						const tmp = pinned[index - 1]!;
						pinned[index - 1] = pinned[index]!;
						pinned[index] = tmp;
						await this.plugin.saveSettings();
						this.refreshDisplay();
					}))
				.addExtraButton(cb => cb
					.setIcon('arrow-down')
					.setTooltip('Move down')
					.setDisabled(index === pinned.length - 1)
					.onClick(async () => {
						if (index === pinned.length - 1) return;
						const tmp = pinned[index + 1]!;
						pinned[index + 1] = pinned[index]!;
						pinned[index] = tmp;
						await this.plugin.saveSettings();
						this.refreshDisplay();
					}))
				.addExtraButton(cb => cb
					.setIcon('trash')
					.setTooltip('Remove from pinned')
					.onClick(async () => {
						pinned.splice(index, 1);
						await this.plugin.saveSettings();
						this.refreshDisplay();
					}));
		});
	}

	private renderPaletteFilterSection(containerEl: HTMLElement) {
		const settings = this.plugin.settings;

		new Setting(containerEl)
			.setName('Filter non-Crucible commands')
			.setDesc('Whitelist: only the listed non-Crucible commands appear. Blacklist: all non-Crucible commands appear except the listed ones.')
			.addDropdown(d => d
				.addOption('blacklist', 'Blacklist')
				.addOption('whitelist', 'Whitelist')
				.setValue(settings.crucibleCommandPaletteFilterMode)
				.onChange(async (v) => {
					settings.crucibleCommandPaletteFilterMode = v as CrucibleCommandPaletteFilterMode;
					await this.plugin.saveSettings();
					this.refreshDisplay();
				}));

		const mode = settings.crucibleCommandPaletteFilterMode;
		const list = mode === 'whitelist' ? settings.crucibleCommandPaletteWhitelist : settings.crucibleCommandPaletteBlacklist;
		const label = mode === 'whitelist' ? 'Whitelisted commands' : 'Blacklisted commands';
		const placeholder = mode === 'whitelist' ? 'Search for a command to whitelist...' : 'Search for a command to blacklist...';

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });

		new Setting(containerEl)
			.setName(label)
			.addSearch(cb => {
				cb.setPlaceholder(placeholder);
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new CommandSuggest(this.app, cb.inputEl, [], (command) => {
					if (list.includes(command.id)) return;
					list.push(command.id);
					cb.setValue('');
					void this.plugin.saveSettings();
					this.refreshDisplay();
				}, list);
			});

		if (list.length === 0) {
			containerEl.createDiv({ text: mode === 'whitelist' ? 'No commands whitelisted.' : 'No commands blacklisted.', cls: 'crucible-empty-state' });
			return;
		}

		const entries = containerEl.createDiv({ cls: 'crucible-settings-group' });
		list.slice().sort((a, b) => getCommandSuggestDisplayName(this.app, a).localeCompare(getCommandSuggestDisplayName(this.app, b))).forEach((id, displayIdx) => {
			if (displayIdx > 0) entries.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(entries)
				.setName(getCommandSuggestDisplayName(this.app, id))
				.setDesc(id)
				.addExtraButton(cb => cb
					.setIcon('trash')
					.setTooltip('Remove')
					.onClick(async () => {
						const idx = list.indexOf(id);
						if (idx !== -1) list.splice(idx, 1);
						await this.plugin.saveSettings();
						this.refreshDisplay();
					}));
		});
	}

	private renderHotkey(el: HTMLElement, commandId: string) {
		const fullId = `${this.plugin.manifest.id}:${commandId}`;
		const label = getCommandHotkeyLabel(this.app, fullId);
		if (!label) return;

		const hotkeyEl = document.createElement('div');
		hotkeyEl.classList.add('crucible-hotkey-display');
		hotkeyEl.createEl('kbd', { text: label });

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
			sortByNameWithEmptyLast(this.plugin.settings.captures, c => c.name).forEach(({ item: capture, index }, displayIdx) => {
				if (displayIdx > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
				const setting = new Setting(group)
					.setName(capture.name || '(unnamed)')
					.setDesc(this.describeCapture(capture))
					.addExtraButton(cb => cb.setIcon('copy').setTooltip('Duplicate capture').onClick(async () => {
						const copy = JSON.parse(JSON.stringify(capture)) as Capture;
						copy.name = copy.name ? `${copy.name} (copy)` : '(copy)';
						this.plugin.settings.captures.push(copy);
						await this.plugin.saveSettings();
						this.plugin.registerCaptures();
						this.display();
					}))
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
				const warning = this.getCaptureWarning(capture);
				if (warning) this.addWarningIcon(setting.nameEl, warning);
			});
		}

		new Setting(containerEl).addButton(bt => bt.setButtonText('Add capture').setCta().onClick(async () => {
			this.plugin.settings.captures.push({ name: '', targetType: 'daily', source: 'dialog', file: '', targetSectionMode: 'fixed', targetSection: '', content: '', writeMode: 'append' });
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
		const sectionMode = (capture.targetSectionMode || 'fixed') === 'source' ? 'same section' : 'fixed section';
		return `${target} - ${source} - ${sectionMode} - ${writeMode}`;
	}

	private getCaptureWarning(capture: Capture): string | null {
		const config = getPeriodConfigByTarget(capture.targetType, this.plugin.settings);
		if (!config || config.enabled) return null;
		return `${config.label} is disabled; this capture will show a warning and not run.`;
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
			sortByNameWithEmptyLast(this.plugin.settings.chains, c => c.name).forEach(({ item: chain, index }, displayIdx) => {
				if (displayIdx > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
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
						const supportsTemplateVariables = arg.type === 'text' ||
							arg.type === 'textarea' ||
							arg.type === 'file' ||
							arg.type === 'folder';
						const panelKey = `chain-${this.editingChainIndex}-step-${index}-arg-${arg.id}`;
						const variables = this.chainArgumentVariables(chain);
						if (supportsTemplateVariables) {
							this.addTemplateVariablesToggle(s, panelKey, variables);
						}

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
						if (supportsTemplateVariables) {
							this.renderTemplateVariablesPanel(stepGroup, panelKey, variables);
						}
					});
				} else {
					// Fallback for commands without schema (standard Obsidian commands)
					stepGroup.createEl('hr', { cls: 'crucible-row-divider' });
					const argsSetting = new Setting(stepGroup)
						.setName('Arguments')
						.setDesc('Support variables like {{response}} from the previous step.')
						.addText(t => t
							.setPlaceholder('Args...')
							.setValue(step.args._default || '')
							.onChange(async (v) => {
								step.args._default = v;
								await this.plugin.saveSettings();
							}).inputEl.addClass('pi-width-normal'));
					const panelKey = `chain-${this.editingChainIndex}-step-${index}-args`;
					const variables = this.chainArgumentVariables(chain);
					this.addTemplateVariablesToggle(argsSetting, panelKey, variables);
					this.renderTemplateVariablesPanel(stepGroup, panelKey, variables);
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
			sortByNameWithEmptyLast(this.plugin.settings.providers, p => p.name).forEach(({ item: provider, index }, displayIdx) => {
				if (displayIdx > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
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
			this.plugin.settings.providers.push({ id, name: '', kind: 'openai', models: [] });
			await this.plugin.saveSettings();
			this.editingProviderIndex = this.plugin.settings.providers.length - 1;
			this.display();
		}));
	}

	private describeProvider(provider: Provider): string {
		const kindLabel = PROVIDER_KIND_LABELS[provider.kind] ?? provider.kind;
		const count = provider.models?.length ?? 0;
		const summary = count === 0 ? 'no models' : count === 1 ? '1 model' : `${count} models`;
		return `${kindLabel} · ${summary}`;
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

	private mountSecretControl(setting: Setting, opts: {
		placeholder?: string;
		indicatorText?: string;
		load: () => Promise<string>;
		store: (value: string) => Promise<void>;
		clear: () => Promise<void>;
	}): void {
		const placeholder = opts.placeholder ?? 'Enter API key...';
		const indicatorText = opts.indicatorText ?? 'API Key in Obsidian Secrets';
		const wrapper = setting.controlEl.createDiv({ cls: 'crucible-secret-control' });

		const renderIndicator = () => {
			wrapper.empty();
			wrapper.createSpan({ text: indicatorText, cls: 'crucible-secret-indicator-text' });
			new ExtraButtonComponent(wrapper)
				.setIcon('trash')
				.setTooltip('Clear API key')
				.onClick(async () => {
					await opts.clear();
					renderInput(true);
				});
		};

		const renderInput = (focus = false) => {
			wrapper.empty();
			const text = new TextComponent(wrapper);
			text.inputEl.type = 'password';
			text.setPlaceholder(placeholder);
			text.inputEl.addClass('pi-width-normal');
			text.onChange(async (v) => { await opts.store(v); });
			text.inputEl.addEventListener('blur', () => {
				if (text.inputEl.value) renderIndicator();
			});
			if (focus) text.inputEl.focus();
		};

		renderInput();
		void opts.load().then(value => {
			if (value) renderIndicator();
		});
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
				.setPlaceholder('e.g. OpenRouter')
				.setValue(provider.name)
				.onChange(async (v) => { provider.name = v; await this.plugin.saveSettings(); })
				.inputEl.addClass('pi-width-normal'));

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });

		new Setting(containerEl)
			.setName('Kind')
			.setDesc('Determines how this provider is invoked. API kinds use HTTP; CLI kinds spawn a local command.')
			.addDropdown(d => {
				for (const [kind, label] of Object.entries(PROVIDER_KIND_LABELS)) {
					d.addOption(kind, label);
				}
				d.setValue(provider.kind)
				 .onChange(async (v: ProviderKind) => { provider.kind = v; await this.plugin.saveSettings(); this.display(); });
				d.selectEl.addClass('pi-width-half');
			});

		const modality = providerModality(provider.kind);

		if (modality === 'api') {
			if (provider.kind === 'ollama') {
				containerEl.createEl('hr', { cls: 'crucible-row-divider' });
				new Setting(containerEl)
					.setName('Ollama URL')
					.setDesc('Default is http://localhost:11434')
					.addText(t => t
						.setPlaceholder('http://localhost:11434')
						.setValue(provider.baseUrl || '')
						.onChange(async (v) => { provider.baseUrl = v; await this.plugin.saveSettings(); })
						.inputEl.addClass('pi-width-normal'));
			} else {
				containerEl.createEl('hr', { cls: 'crucible-row-divider' });
				const apiKeySetting = new Setting(containerEl)
					.setName('API Key')
					.setDesc('Stored securely in Obsidian Secret Storage.');
				this.mountSecretControl(apiKeySetting, {
					load: () => this.plugin.providerManager.loadApiKey(provider.id),
					store: (v) => this.plugin.providerManager.storeApiKey(provider.id, v),
					clear: () => this.plugin.providerManager.deleteApiKey(provider.id),
				});
			}
		} else {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(containerEl)
				.setName('Command')
				.setDesc(`Path or name of the executable. Leave blank to use the default for this kind.`)
				.addText(t => t
					.setPlaceholder(defaultCliCommand(provider.kind))
					.setValue(provider.command || '')
					.onChange(async (v) => { provider.command = v; await this.plugin.saveSettings(); })
					.inputEl.addClass('pi-width-normal'));

			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(containerEl)
				.setName('Extra arguments')
				.setDesc('Optional. Whitespace-separated arguments to pass before the prompt. Quotes are respected.')
				.addText(t => t
					.setPlaceholder('--no-color')
					.setValue(provider.extraArgs || '')
					.onChange(async (v) => { provider.extraArgs = v; await this.plugin.saveSettings(); })
					.inputEl.addClass('pi-width-wide'));

			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(containerEl)
				.setName('Working directory')
				.setDesc('Optional. Vault-relative or absolute path. Leave blank for the process default.')
				.addText(t => t
					.setPlaceholder('/absolute/path')
					.setValue(provider.cwd || '')
					.onChange(async (v) => { provider.cwd = v; await this.plugin.saveSettings(); })
					.inputEl.addClass('pi-width-wide'));

			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(containerEl)
				.setName('Timeout seconds')
				.setDesc(`Blank uses the default ${CLI_DEFAULT_TIMEOUT_SECONDS}s. Use 600 for long transcript workflows.`)
				.addText(t => {
					t.setPlaceholder(String(CLI_DEFAULT_TIMEOUT_SECONDS))
						.setValue(provider.timeoutSeconds ? String(provider.timeoutSeconds) : '')
						.onChange(async (v) => {
							const trimmed = v.trim();
							if (!trimmed) {
								delete provider.timeoutSeconds;
								await this.plugin.saveSettings();
								return;
							}

							const seconds = Number(trimmed);
							if (Number.isFinite(seconds) && seconds > 0) {
								provider.timeoutSeconds = Math.ceil(seconds);
								await this.plugin.saveSettings();
							}
						});
					t.inputEl.type = 'number';
					t.inputEl.min = '1';
					t.inputEl.step = '1';
					t.inputEl.addClass('pi-width-half');
				});

			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(containerEl)
				.setName('Capture run artifacts')
				.setDesc('Per run, write task.md, system.md, invocation.json, response.md, progress.log to the run directory.')
				.addToggle(t => t
					.setValue(provider.cliRunArtifactsEnabled !== false)
					.onChange(async (v) => {
						provider.cliRunArtifactsEnabled = v;
						await this.plugin.saveSettings();
						this.display();
					}));

			if (provider.cliRunArtifactsEnabled !== false) {
				containerEl.createEl('hr', { cls: 'crucible-row-divider' });
				new Setting(containerEl)
					.setName('Run directory')
					.setDesc('Vault-relative folder. Each run lands in <dir>/<timestamp>-<agent>/. latest.log is updated for tailing.')
					.addSearch(cb => {
						cb.setPlaceholder('_crucible/cli-runs')
							.setValue(provider.cliRunDirectory || '')
							.onChange(async (v) => { provider.cliRunDirectory = v.trim(); await this.plugin.saveSettings(); });
						const el = (cb as unknown as SearchWithContainer).containerEl;
						if (el) el.addClass('crucible-search-container', 'pi-width-wide');
						new FolderSuggest(this.app, cb.inputEl);
					});
			}
		}

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		this.renderProviderModelsList(containerEl, provider);
	}

	private renderProviderModelsList(containerEl: HTMLElement, provider: Provider) {
		new Setting(containerEl).setName('Models').setHeading();
		containerEl.createEl('p', {
			text: 'Configure one or more models. Agents bind to a (provider, model) pair, and chain steps can override via {{model}}.',
			cls: 'mod-muted',
		});

		const list = containerEl.createDiv({ cls: 'crucible-settings-group' });
		const models = provider.models ?? (provider.models = []);

		if (models.length === 0) {
			list.createDiv({ text: 'No models configured.', cls: 'crucible-empty-state' });
		} else {
			models.forEach((model, modelIndex) => {
				if (modelIndex > 0) list.createEl('hr', { cls: 'crucible-row-divider' });
				new Setting(list)
					.addText(t => t
						.setPlaceholder(modelIdPlaceholder(provider.kind))
						.setValue(model.id)
						.onChange(async (v) => { model.id = v; await this.plugin.saveSettings(); })
						.inputEl.addClass('pi-width-normal'))
					.addText(t => t
						.setPlaceholder('Display label (optional)')
						.setValue(model.label)
						.onChange(async (v) => { model.label = v; await this.plugin.saveSettings(); })
						.inputEl.addClass('pi-width-normal'))
					.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove model').onClick(async () => {
						models.splice(modelIndex, 1);
						await this.plugin.saveSettings();
						this.display();
					}));
			});
		}

		new Setting(containerEl).addButton(bt => bt.setButtonText('Add model').onClick(async () => {
			models.push({ id: '', label: '' });
			await this.plugin.saveSettings();
			this.display();
		}));
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
			sortByNameWithEmptyLast(this.plugin.settings.agents, a => a.name).forEach(({ item: agent, index }, displayIdx) => {
				if (displayIdx > 0) listGroup.createEl('hr', { cls: 'crucible-row-divider' });
				new Setting(listGroup)
					.setName(agent.name || '(unnamed)')
					.setDesc(this.describeAgent(agent))
					.addExtraButton(cb => cb.setIcon('copy').setTooltip('Duplicate agent').onClick(async () => {
						const copy = JSON.parse(JSON.stringify(agent)) as Agent;
						copy.id = Math.random().toString(36).substring(2, 9);
						copy.name = copy.name ? `${copy.name} (copy)` : '(copy)';
						this.plugin.settings.agents.push(copy);
						await this.plugin.saveSettings();
						this.plugin.registerAgents();
						this.display();
					}))
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
				const firstModel = firstProvider?.models?.[0];
				this.plugin.settings.agents.push({
					id,
					name: '',
					modelBinding: firstProvider && firstModel
						? { mode: 'pinned', pinned: { providerId: firstProvider.id, modelId: firstModel.id } }
						: { mode: 'runtime' },
					systemPromptSource: 'text',
					systemPromptText: '',
					systemPromptFile: '',
					userPromptSource: 'text',
					userPromptText: '{{input}}',
					userPromptFile: '',
					executionMode: 'read-only',
					requireNormalFinishReason: true
				});
				await this.plugin.saveSettings();
				this.plugin.registerAgents();
				this.editingAgentIndex = this.plugin.settings.agents.length - 1;
				this.display();
			}));
	}

	private describeAgent(agent: Agent): string {
		const binding = agent.modelBinding;
		if (binding?.mode === 'pinned' && binding.pinned) {
			const provider = this.plugin.settings.providers.find(p => p.id === binding.pinned!.providerId);
			const model = provider?.models?.find(m => m.id === binding.pinned!.modelId);
			const providerName = provider ? provider.name || `(unnamed ${provider.kind})` : 'unknown provider';
			const modelName = model ? model.label || model.id : binding.pinned.modelId || '(no model)';
			return `${providerName} · ${modelName} — ${agentCommandId(agent.id)}`;
		}
		if (binding?.mode === 'constrained') {
			const count = binding.allow?.length ?? 0;
			return `Constrained (${count} allowed) — ${agentCommandId(agent.id)}`;
		}
		if (binding?.mode === 'runtime') {
			return `Runtime pick — ${agentCommandId(agent.id)}`;
		}
		return `Unconfigured — ${agentCommandId(agent.id)}`;
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

		this.renderAgentBindingEditor(containerEl, agent);

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });

		new Setting(containerEl)
			.setName('Execution mode')
			.setDesc('Read-only: CLI agents run with sandbox/tool restrictions where supported (Claude --tools Read, Codex --sandbox read-only). Edit: agent may write within its working directory. Unrestricted: no sandbox flags applied.')
			.addDropdown(d => {
				d.addOption('read-only', 'Read-only (default)')
				 .addOption('edit', 'Edit')
				 .addOption('unrestricted', 'Unrestricted')
				 .setValue(agent.executionMode || 'read-only')
				 .onChange(async (v: AgentExecutionMode) => {
					 agent.executionMode = v;
					 await this.plugin.saveSettings();
				 });
				d.selectEl.addClass('pi-width-wide');
			});

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });

		new Setting(containerEl)
			.setName('Require normal API finish')
			.setDesc('API agents fail when generation stops for truncation, filtering, tool calls, errors, or an unknown reason. CLI agents ignore this setting.')
			.addToggle(t => t
				.setValue(agent.requireNormalFinishReason ?? true)
				.onChange(async (v) => {
					agent.requireNormalFinishReason = v;
					await this.plugin.saveSettings();
				}));

		const autoSize = (el: HTMLTextAreaElement) => {
			el.setCssProps({ height: 'auto' });
			el.setCssProps({ height: `${el.scrollHeight}px` });
		};

		const renderPromptEditor = (
			panelKey: string,
			label: string,
			description: string,
			placeholder: string,
			variables: TemplateVariableInfo[],
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
				const promptSetting = new Setting(containerEl)
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
				this.addTemplateVariablesToggle(promptSetting, panelKey, variables);
				this.renderTemplateVariablesPanel(containerEl, panelKey, variables);
			}
		};

		renderPromptEditor(
			`agent-${index}-system-prompt`,
			'System prompt',
			'Persistent instructions for the agent. Supports template tokens like {{today}}, {{datetime:FORMAT}}.',
			'You are a helpful assistant...',
			this.agentPromptVariables(false),
			() => agent.systemPromptSource || 'text',
			async (v) => { agent.systemPromptSource = v; await this.plugin.saveSettings(); },
			() => agent.systemPromptText || '',
			async (v) => { agent.systemPromptText = v; await this.plugin.saveSettings(); },
			() => agent.systemPromptFile || '',
			async (v) => { agent.systemPromptFile = v; await this.plugin.saveSettings(); },
		);

		renderPromptEditor(
			`agent-${index}-user-prompt`,
			'User prompt template',
			'Template for the user message. {{input}} (or {{value}}) is replaced by the runtime input passed to the agent.',
			'Summarize the following:\n\n{{input}}',
			this.agentPromptVariables(true),
			() => agent.userPromptSource || 'text',
			async (v) => { agent.userPromptSource = v; await this.plugin.saveSettings(); },
			() => agent.userPromptText || '',
			async (v) => { agent.userPromptText = v; await this.plugin.saveSettings(); },
			() => agent.userPromptFile || '',
			async (v) => { agent.userPromptFile = v; await this.plugin.saveSettings(); },
		);
	}

	private renderAgentBindingEditor(containerEl: HTMLElement, agent: Agent) {
		containerEl.createEl('hr', { cls: 'crucible-row-divider' });

		const binding = agent.modelBinding ?? (agent.modelBinding = { mode: 'runtime' });

		new Setting(containerEl)
			.setName('Model selection')
			.setDesc('How this agent picks a (provider, model) when invoked.')
			.addDropdown(d => {
				d.addOption('pinned', 'Pinned: always use one model')
				 .addOption('constrained', 'Constrained: pick from an allowlist at run time')
				 .addOption('runtime', 'Runtime: pick from all configured models at run time')
				 .setValue(binding.mode)
				 .onChange(async (v: AgentBindingMode) => {
					 binding.mode = v;
					 await this.plugin.saveSettings();
					 this.display();
				 });
				d.selectEl.addClass('pi-width-wide');
			});

		const allProviders = this.plugin.settings.providers;
		const hasAnyModels = allProviders.some(p => (p.models ?? []).length > 0);

		if (binding.mode === 'pinned') {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });

			if (!hasAnyModels) {
				containerEl.createDiv({ text: 'Add at least one model to a provider to pin.', cls: 'crucible-empty-state' });
				return;
			}

			const pinned = binding.pinned ?? (binding.pinned = { providerId: '', modelId: '' });

			new Setting(containerEl)
				.setName('Provider')
				.addDropdown(d => {
					if (!pinned.providerId || !allProviders.find(p => p.id === pinned.providerId)) {
						d.addOption('', 'Select a provider...');
					}
					allProviders.forEach(p => {
						d.addOption(p.id, p.name || `(unnamed ${p.kind})`);
					});
					d.setValue(pinned.providerId)
					 .onChange(async (v) => {
						 pinned.providerId = v;
						 // Reset modelId if it doesn't belong to the new provider.
						 const newProvider = allProviders.find(p => p.id === v);
						 if (!newProvider?.models?.some(m => m.id === pinned.modelId)) {
							 pinned.modelId = '';
						 }
						 await this.plugin.saveSettings();
						 this.display();
					 });
					d.selectEl.addClass('pi-width-normal');
				});

			containerEl.createEl('hr', { cls: 'crucible-row-divider' });

			const provider = allProviders.find(p => p.id === pinned.providerId);
			const models = provider?.models ?? [];

			new Setting(containerEl)
				.setName('Model')
				.addDropdown(d => {
					if (models.length === 0) {
						d.addOption('', 'No models on this provider');
					} else {
						if (!pinned.modelId || !models.find(m => m.id === pinned.modelId)) {
							d.addOption('', 'Select a model...');
						}
						models.forEach(m => {
							d.addOption(m.id, m.label || m.id);
						});
					}
					d.setValue(pinned.modelId)
					 .onChange(async (v) => {
						 pinned.modelId = v;
						 await this.plugin.saveSettings();
					 });
					d.selectEl.addClass('pi-width-normal');
				});
		} else if (binding.mode === 'constrained') {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });

			if (!hasAnyModels) {
				containerEl.createDiv({ text: 'Add at least one model to a provider to populate the allowlist.', cls: 'crucible-empty-state' });
				return;
			}

			const allow = binding.allow ?? (binding.allow = []);

			new Setting(containerEl)
				.setName('Allowed models')
				.setDesc('When this agent runs, the user picks one of these. Chain steps may also override via the model arg.');

			const list = containerEl.createDiv({ cls: 'crucible-settings-group' });

			if (allow.length === 0) {
				list.createDiv({ text: 'No models allowed. Add at least one.', cls: 'crucible-empty-state' });
			} else {
				allow.forEach((ref, allowIndex) => {
					if (allowIndex > 0) list.createEl('hr', { cls: 'crucible-row-divider' });
					const provider = allProviders.find(p => p.id === ref.providerId);
					const model = provider?.models?.find((m: ProviderModel) => m.id === ref.modelId);
					const label = provider && model
						? `${provider.name || provider.kind} · ${model.label || model.id}`
						: `${ref.providerId}:${ref.modelId} (missing)`;
					new Setting(list)
						.setName(label)
						.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove').onClick(async () => {
							allow.splice(allowIndex, 1);
							await this.plugin.saveSettings();
							this.display();
						}));
				});
			}

			const addable = collectAllRefs(allProviders).filter(
				ref => !allow.some(a => a.providerId === ref.providerId && a.modelId === ref.modelId)
			);

			if (addable.length > 0) {
				let pendingProvider = '';
				let pendingModel = '';
				new Setting(containerEl)
					.setName('Add to allowlist')
					.addDropdown(d => {
						d.addOption('', 'Pick a model...');
						addable.forEach(ref => {
							const provider = allProviders.find(p => p.id === ref.providerId);
							const model = provider?.models?.find(m => m.id === ref.modelId);
							const label = provider && model
								? `${provider.name || provider.kind} · ${model.label || model.id}`
								: `${ref.providerId}:${ref.modelId}`;
							d.addOption(`${ref.providerId}:${ref.modelId}`, label);
						});
						d.onChange((v) => {
							const sep = v.indexOf(':');
							if (sep === -1) { pendingProvider = ''; pendingModel = ''; return; }
							pendingProvider = v.slice(0, sep);
							pendingModel = v.slice(sep + 1);
						});
						d.selectEl.addClass('pi-width-wide');
					})
					.addButton(bt => bt.setButtonText('Add').onClick(async () => {
						if (!pendingProvider || !pendingModel) return;
						allow.push({ providerId: pendingProvider, modelId: pendingModel });
						await this.plugin.saveSettings();
						this.display();
					}));
			}
		} else {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			containerEl.createEl('p', {
				text: 'When invoked, this agent will open a picker showing every configured (provider, model) pair. Chain steps may bypass the picker via the model arg.',
				cls: 'mod-muted',
			});
		}
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

		new Setting(containerEl).setName('Period notes').setHeading();
		containerEl.createEl('p', { text: 'Configure daily, weekly, and monthly notes, asset folders, templates, and move-folder pins.' });
		PERIOD_IDS.forEach(period => this.renderPeriodSettingsBlock(containerEl, period));
		this.renderPinnedFoldersSettings(containerEl);

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
		this.renderTemplateVariableGrid(containerEl, this.captureTemplateVariables());
	}

	private renderPeriodSettingsBlock(containerEl: HTMLElement, period: PeriodId): void {
		const config = getPeriodConfig(this.plugin.settings, period);
		const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
		if (!config.enabled) group.addClass('is-disabled');

		const header = new Setting(group)
			.setName(`${config.label} notes`)
			.setDesc(`${config.label} note files are created under ${config.folder || config.exampleFolder}.`)
			.addToggle(toggle => toggle
				.setTooltip('Enabled')
				.setValue(config.enabled)
				.onChange(async (value) => {
					await this.setSettingValue(config.enabledKey, value);
					this.display();
				}));
		if (!config.enabled) {
			this.addWarningIcon(header.nameEl, `${config.label} commands, captures, and automation will show a warning and not run.`);
			header.descEl.createEl('div', {
				cls: 'crucible-setting-warning',
				text: `${config.label} is disabled. Related commands and automation will not run.`,
			});
		}

		group.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(group)
			.setName(`${config.label} folder`)
			.setDesc(`${config.label} note root. Notes use ${config.folder || config.exampleFolder}/<period>.md.`)
			.addSearch(cb => {
				cb.setPlaceholder(config.exampleFolder)
					.setValue(config.folder)
					.onChange(async (value) => {
						await this.setSettingValue(config.folderKey, value);
					});
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FolderSuggest(this.app, cb.inputEl);
			});

		group.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(group)
			.setName('Create asset folder')
			.setDesc(`Also create ${config.folder || config.exampleFolder}/<period>/ beside the note.`)
			.addToggle(toggle => toggle
				.setValue(config.createAssetFolder)
				.onChange(async (value) => {
					await this.setSettingValue(config.assetFolderKey, value);
				}));

		group.createEl('hr', { cls: 'crucible-row-divider' });
		const templateSetting = new Setting(group)
			.setName(`${config.label} template`)
			.setDesc(`Template applied when a ${config.lowerLabel} note is created or materialized.`)
			.addSearch(cb => {
				cb.setPlaceholder(config.exampleTemplate)
					.setValue(config.template)
					.onChange(async (value) => {
						await this.setSettingValue(config.templateKey, value);
					});
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FileSuggest(this.app, cb.inputEl);
			});
		this.addTemplateVariablesToggle(templateSetting, `period-${period}-template`, this.periodTemplateVariables());
		this.renderTemplateVariablesPanel(group, `period-${period}-template`, this.periodTemplateVariables());

		group.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(group)
			.setName('Pin in move picker')
			.setDesc(`Show the current ${config.lowerLabel} asset folder above normal results in "Move current file to folder...".`)
			.addToggle(toggle => toggle
				.setValue(config.pinInMovePicker)
				.onChange(async (value) => {
					await this.setSettingValue(config.movePinKey, value);
				}));
	}

	private renderPinnedFoldersSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Pinned folders').setHeading();
		containerEl.createEl('p', { text: 'Additional folders shown after enabled Daily/Weekly/Monthly pins in the move-folder picker.' });

		const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
		const pinnedFolders = this.plugin.settings.moveFilePinnedFolders;
		if (pinnedFolders.length === 0) {
			group.createDiv({ text: 'No pinned folders configured.', cls: 'crucible-empty-state' });
		} else {
			pinnedFolders.forEach((folder, index) => {
				if (index > 0) group.createEl('hr', { cls: 'crucible-mini-hr' });
				const row = group.createDiv({ cls: 'crucible-folder-template-row' });
				const setting = new Setting(row)
					.addSearch(cb => {
						cb.setPlaceholder('Folder')
							.setValue(folder)
							.onChange(async (value) => {
								this.plugin.settings.moveFilePinnedFolders[index] = value;
								await this.plugin.saveSettings();
							});
						const el = (cb as unknown as SearchWithContainer).containerEl;
						if (el) el.addClass('crucible-search-container', 'pi-width-normal');
						new FolderSuggest(this.app, cb.inputEl);
					})
					.addExtraButton(cb => {
						cb.setIcon('trash')
							.setTooltip('Remove pinned folder')
							.onClick(async () => {
								this.plugin.settings.moveFilePinnedFolders.splice(index, 1);
								await this.plugin.saveSettings();
								this.display();
							});
					});
				setting.infoEl.remove();
			});
		}
		new Setting(group).addButton(bt => bt.setButtonText('Add pinned folder').setCta().onClick(async () => {
			this.plugin.settings.moveFilePinnedFolders.push('');
			await this.plugin.saveSettings();
			this.display();
		}));
	}

	private async setSettingValue<K extends keyof CrucibleSettings>(key: K, value: CrucibleSettings[K]): Promise<void> {
		this.plugin.settings[key] = value;
		await this.plugin.saveSettings();
	}

	private addWarningIcon(el: HTMLElement, tooltip: string): void {
		const icon = el.createSpan({ cls: 'crucible-warning-icon' });
		icon.setAttr('aria-label', tooltip);
		icon.setAttr('title', tooltip);
		setIcon(icon, 'triangle-alert');
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
				id: 'blogs_tracker',
				name: 'Blogs Tracker',
				description: 'Poll configured blog RSS feeds for new posts and create intake notes.',
				enabledKey: 'orchestrationBlogsTrackerEnabled',
				render: (el) => this.renderEditBlogsTrackerWorkflow(el),
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

	private getWorkflowWarning(workflowId: string): string | null {
		if (workflowId === 'daily_brief_lite' && !this.plugin.settings.dailyEnabled) {
			return 'Daily is disabled; this workflow will fail with a warning until Daily is enabled.';
		}
		return null;
	}

	private renderOrchestrationSettings(containerEl: HTMLElement) {
		const workflows = this.getWorkflowMeta();

		if (this.editingWorkflowId !== null) {
			const meta = workflows.find(w => w.id === this.editingWorkflowId);
			if (meta) {
				const heading = new Setting(containerEl).setName(`Edit Workflow: ${meta.name}`).setHeading();
				const warning = this.getWorkflowWarning(meta.id);
				if (warning) this.addWarningIcon(heading.nameEl, warning);
				const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
				if (warning) {
					group.createDiv({ cls: 'crucible-setting-warning', text: warning });
				}
				meta.render(group);
				return;
			}
			this.editingWorkflowId = null;
		}

		new Setting(containerEl).setName('Orchestrate').setHeading();
		containerEl.createEl('p', { text: 'Vault-native deterministic job runner. Jobs are markdown files in queue folders that move through inbox → running → done | failed. Manual execution only — use the "Orchestrate: Scan" and "Orchestrate: Run next" commands.' });

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
			const setting = new Setting(workflowsGroup)
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
			const warning = this.getWorkflowWarning(meta.id);
			if (warning) this.addWarningIcon(setting.nameEl, warning);
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

		// --- Ingestion Dashboard ---
		new Setting(containerEl).setName('Ingestion dashboard').setHeading();
		containerEl.createEl('p', { text: 'Live view of clippings, transcripts, tracker runs, and uncaptured posts/videos. Open via the "Crucible: Open ingestion dashboard" command.' });

		const ingestionGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });

		new Setting(ingestionGroup)
			.setName('Clipper inbox folder')
			.setDesc('Markdown files directly under this folder are shown in the "Unprocessed Clippings" section.')
			.addSearch(cb => {
				cb.setPlaceholder('_clippings/inbox')
					.setValue(this.plugin.settings.ingestionClipperInboxFolder)
					.onChange(async (v) => {
						this.plugin.settings.ingestionClipperInboxFolder = v.trim() || '_clippings/inbox';
						await this.plugin.saveSettings();
					});
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FolderSuggest(this.app, cb.inputEl);
			});

		ingestionGroup.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(ingestionGroup)
			.setName('Reading speed (words per minute)')
			.setDesc('Used to estimate read time for unrefined transcripts.')
			.addText(t => {
				t.setPlaceholder('250')
					.setValue(String(this.plugin.settings.ingestionReadingWpm))
					.onChange(async (v) => {
						const n = Number(v.trim());
						this.plugin.settings.ingestionReadingWpm = Number.isFinite(n) && n > 0 ? n : 250;
						await this.plugin.saveSettings();
					});
				t.inputEl.type = 'number';
				t.inputEl.addClass('pi-width-small');
			});

		ingestionGroup.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(ingestionGroup)
			.setName('Auto-enrich YouTube metadata')
			.setDesc('When on, the dashboard drains the Uncaptured Videos list (in current sort order) through the YouTube Data API. Requires a configured API key.')
			.addToggle(t => t
				.setValue(this.plugin.settings.ingestionYoutubeAutoEnrichEnabled === true)
				.onChange(async (v) => {
					this.plugin.settings.ingestionYoutubeAutoEnrichEnabled = v;
					await this.plugin.saveSettings();
				}));

		ingestionGroup.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(ingestionGroup)
			.setName('Enrichment rate limit (seconds)')
			.setDesc('Minimum seconds between YouTube Data API requests when draining the enrichment queue.')
			.addText(t => {
				t.setPlaceholder('2')
					.setValue(String(this.plugin.settings.ingestionYoutubeEnrichRateLimitSeconds))
					.onChange(async (v) => {
						const n = Number(v.trim());
						this.plugin.settings.ingestionYoutubeEnrichRateLimitSeconds = Number.isFinite(n) && n >= 0 ? n : 2;
						await this.plugin.saveSettings();
					});
				t.inputEl.type = 'number';
				t.inputEl.addClass('pi-width-small');
			});
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
		containerEl.createEl('p', { text: 'FX rates to fetch from api.frankfurter.app. Base and quote are ISO codes (e.g. USD, MXN); start typing to pick from the supported list. Label is shown in the brief.' });

		const loadCurrencyCache = () => this.plugin.settings.orchestrationDailyBriefCurrencyCache;
		const saveCurrencyCache = async (cache: CurrencyCache) => {
			this.plugin.settings.orchestrationDailyBriefCurrencyCache = cache;
			await this.plugin.saveSettings();
		};

		const fxGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
		const fxPairs = this.plugin.settings.orchestrationDailyBriefFxPairs;
		if (fxPairs.length === 0) {
			fxGroup.createDiv({ text: 'No currency pairs configured.', cls: 'crucible-empty-state' });
		} else {
			fxPairs.forEach((pair, index) => {
				if (index > 0) fxGroup.createEl('hr', { cls: 'crucible-row-divider' });
				const row = new Setting(fxGroup);
				let labelText: TextComponent;
				const maybeAutoTitle = () => {
					if (!pair.label && pair.base && pair.quote) {
						pair.label = `${pair.base} → ${pair.quote}`;
						labelText.setValue(pair.label);
					}
				};
				let baseText: TextComponent;
				row.addText(t => {
					baseText = t;
					t.setPlaceholder('base (USD)')
						.setValue(pair.base)
						.onChange(async (v) => { pair.base = v.trim().toUpperCase(); maybeAutoTitle(); await this.plugin.saveSettings(); });
					t.inputEl.addClass('pi-width-small');
					new CurrencySuggest(this.app, t.inputEl, loadCurrencyCache, saveCurrencyCache, async (c) => {
						pair.base = c.code;
						baseText.setValue(c.code);
						maybeAutoTitle();
						await this.plugin.saveSettings();
					});
				});
				let quoteText: TextComponent;
				row.addText(t => {
					quoteText = t;
					t.setPlaceholder('quote (MXN)')
						.setValue(pair.quote)
						.onChange(async (v) => { pair.quote = v.trim().toUpperCase(); maybeAutoTitle(); await this.plugin.saveSettings(); });
					t.inputEl.addClass('pi-width-small');
					new CurrencySuggest(this.app, t.inputEl, loadCurrencyCache, saveCurrencyCache, async (c) => {
						pair.quote = c.code;
						quoteText.setValue(c.code);
						maybeAutoTitle();
						await this.plugin.saveSettings();
					});
				});
				row.addText(t => {
					labelText = t;
					t.setPlaceholder('label (USD → MXN)')
						.setValue(pair.label)
						.onChange(async (v) => { pair.label = v; await this.plugin.saveSettings(); });
					t.inputEl.addClass('pi-width-normal');
				});
				row.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove pair').onClick(async () => {
					fxPairs.splice(index, 1);
					await this.plugin.saveSettings();
					this.display();
				}));
			});
		}

		new Setting(containerEl)
			.addButton(bt => bt.setButtonText('Add currency pair').onClick(async () => {
				fxPairs.push({ base: '', quote: '', label: '' });
				await this.plugin.saveSettings();
				this.display();
			}))
			.addButton(bt => bt.setButtonText('Clear cache').setWarning().onClick(async () => {
				this.plugin.settings.orchestrationDailyBriefCurrencyCache = undefined;
				await this.plugin.saveSettings();
				new Notice('Currency list cache cleared');
			}));

		// Weather locations
		new Setting(containerEl).setName('Weather locations').setHeading();
		containerEl.createEl('p', { text: 'Locations to fetch daily forecasts from open-meteo.com. Type a city name in the label field to look it up and auto-fill coordinates. Latitude and longitude are decimal degrees.' });

		const geocodeCache = this.plugin.settings.orchestrationDailyBriefGeocodeCache;
		const loadGeocodeCache = (query: string) => geocodeCache[query];
		const saveGeocodeCache = async (query: string, entry: GeocodeCacheEntry) => {
			geocodeCache[query] = entry;
			await this.plugin.saveSettings();
		};

		const wxGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
		const locations = this.plugin.settings.orchestrationDailyBriefWeatherLocations;
		if (locations.length === 0) {
			wxGroup.createDiv({ text: 'No locations configured.', cls: 'crucible-empty-state' });
		} else {
			locations.forEach((loc, index) => {
				if (index > 0) wxGroup.createEl('hr', { cls: 'crucible-row-divider' });
				const row = new Setting(wxGroup);
				let latText: TextComponent;
				let lonText: TextComponent;
				row.addText(t => {
					t.setPlaceholder('label (Guadalajara, MX)')
						.setValue(loc.label)
						.onChange(async (v) => { loc.label = v; await this.plugin.saveSettings(); });
					t.inputEl.addClass('pi-width-normal');
					new LocationSuggest(this.app, t.inputEl, loadGeocodeCache, saveGeocodeCache, async (g) => {
						loc.label = g.label;
						loc.lat = g.lat;
						loc.lon = g.lon;
						t.setValue(g.label);
						latText.setValue(String(g.lat));
						lonText.setValue(String(g.lon));
						await this.plugin.saveSettings();
					});
				});
				row.addText(t => {
					latText = t;
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
					lonText = t;
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

		new Setting(containerEl)
			.addButton(bt => bt.setButtonText('Add location').onClick(async () => {
				locations.push({ label: '', lat: 0, lon: 0 });
				await this.plugin.saveSettings();
				this.display();
			}))
			.addButton(bt => bt.setButtonText('Clear cache').setWarning().onClick(async () => {
				this.plugin.settings.orchestrationDailyBriefGeocodeCache = {};
				await this.plugin.saveSettings();
				new Notice('Location cache cleared');
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

		new Setting(containerEl)
			.setName('Diff against prior runs')
			.setDesc('On: each run surfaces only videos not in any prior intake file. Off: each run surfaces every video that has no vault note (independent of prior intakes).')
			.addToggle(t => t
				.setValue(this.plugin.settings.orchestrationYoutubeTrackerDiffMode !== false)
				.onChange(async (v) => {
					this.plugin.settings.orchestrationYoutubeTrackerDiffMode = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Write empty intake files')
			.setDesc('On: every run writes an intake file even when no new videos and no channel failures (audit trail). Off: skip writing when there is nothing to report.')
			.addToggle(t => t
				.setValue(this.plugin.settings.orchestrationYoutubeTrackerWriteEmptyRuns === true)
				.onChange(async (v) => {
					this.plugin.settings.orchestrationYoutubeTrackerWriteEmptyRuns = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Metadata root folder')
			.setDesc('Folder where per-video metadata notes are saved (one subfolder per channel).')
			.addSearch(cb => {
				cb.setPlaceholder('_yt_metadata')
					.setValue(this.plugin.settings.orchestrationYoutubeMetadataRoot)
					.onChange(async (v) => {
						this.plugin.settings.orchestrationYoutubeMetadataRoot = v.trim() || '_yt_metadata';
						await this.plugin.saveSettings();
					});
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FolderSuggest(this.app, cb.inputEl);
			});

		const youtubeKeySetting = new Setting(containerEl)
			.setName('YouTube Data API key')
			.setDesc('Stored securely in Obsidian Secret Storage. Required for the per-video metadata fetch command.');
		this.mountSecretControl(youtubeKeySetting, {
			load: () => loadYoutubeApiKey(this.app),
			store: (v) => storeYoutubeApiKey(this.app, v),
			clear: () => deleteYoutubeApiKey(this.app),
		});
	}

	private renderEditBlogsTrackerWorkflow(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName('Blogs note')
			.setDesc('Markdown note containing the blogs registry table (Name | Link | Method | Tags | Priority).')
			.addSearch(cb => {
				cb.setPlaceholder('_system/blogs/Blogs.md')
					.setValue(this.plugin.settings.orchestrationBlogsNote)
					.onChange(async (v) => {
						this.plugin.settings.orchestrationBlogsNote = v.trim() || '_system/blogs/Blogs.md';
						await this.plugin.saveSettings();
					});
				const el = (cb as unknown as SearchWithContainer).containerEl;
				if (el) el.addClass('crucible-search-container', 'pi-width-normal');
				new FileSuggest(this.app, cb.inputEl);
			});

		new Setting(containerEl)
			.setName('Diff against prior runs')
			.setDesc('On: each run surfaces only posts not in any prior intake file. Off: each run surfaces every post that has no vault note (independent of prior intakes).')
			.addToggle(t => t
				.setValue(this.plugin.settings.orchestrationBlogsTrackerDiffMode !== false)
				.onChange(async (v) => {
					this.plugin.settings.orchestrationBlogsTrackerDiffMode = v;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Write empty intake files')
			.setDesc('On: every run writes an intake file even when no new posts and no blog failures (audit trail). Off: skip writing when there is nothing to report.')
			.addToggle(t => t
				.setValue(this.plugin.settings.orchestrationBlogsTrackerWriteEmptyRuns === true)
				.onChange(async (v) => {
					this.plugin.settings.orchestrationBlogsTrackerWriteEmptyRuns = v;
					await this.plugin.saveSettings();
				}));
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

		this.renderLocalizeAttachmentsSettings(containerEl);
	}

	private renderLocalizeAttachmentsSettings(containerEl: HTMLElement) {
		const s = this.plugin.settings;
		containerEl.createEl('hr');
		new Setting(containerEl).setName('Localize attachments').setHeading();
		containerEl.createEl('p', { text: 'Standalone Lint command (not part of Lint: all). Downloads remote media, moves local attachments into a per-note folder, and optionally converts images.' });

		new Setting(containerEl).setName('Automatic triggers').setHeading();
		const triggerGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });
		new Setting(triggerGroup).setName('On note create').setDesc('Run localize when a Markdown note is created with content.').addToggle(t => t.setValue(s.localizeAttachmentsTriggerOnCreate).onChange(async (v) => { s.localizeAttachmentsTriggerOnCreate = v; await this.plugin.saveSettings(); }));
		triggerGroup.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(triggerGroup).setName('On note edit').setDesc('Debounced run on modify (3s).').addToggle(t => t.setValue(s.localizeAttachmentsTriggerOnEdit).onChange(async (v) => { s.localizeAttachmentsTriggerOnEdit = v; await this.plugin.saveSettings(); }));
		triggerGroup.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(triggerGroup).setName('On paste').setDesc('Intercept pasted media and route into the attachment folder.').addToggle(t => t.setValue(s.localizeAttachmentsTriggerOnPaste).onChange(async (v) => { s.localizeAttachmentsTriggerOnPaste = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl).setName('Media types').setHeading();
		const renderTypeGroup = (type: LocalizeMediaType, label: string) => {
			new Setting(containerEl).setName(label).setHeading();
			const g = containerEl.createDiv({ cls: 'crucible-settings-group' });
			const getProcessAttached = () => this.getLocalizeFlag(type, 'attached');
			const getProcessPasted = () => this.getLocalizeFlag(type, 'pasted');
			const getWhitelist = () => this.getLocalizeWhitelist(type);

			new Setting(g).setName('Handle when attached or remote').addToggle(t => t.setValue(getProcessAttached()).onChange(async (v) => { this.setLocalizeFlag(type, 'attached', v); await this.plugin.saveSettings(); }));
			g.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(g).setName('Handle when pasted').addToggle(t => t.setValue(getProcessPasted()).onChange(async (v) => { this.setLocalizeFlag(type, 'pasted', v); await this.plugin.saveSettings(); }));
			g.createEl('hr', { cls: 'crucible-row-divider' });
			const wlSetting = new Setting(g).setName('Allowed extensions').setDesc('Only extensions checked here are eligible.');
			const grid = wlSetting.controlEl.createDiv({ cls: 'crucible-checkbox-grid' });
			for (const ext of OBSIDIAN_NATIVE_EMBED_FORMATS[type]) {
				const label = grid.createEl('label', { cls: 'crucible-checkbox-grid-item' });
				const cb = label.createEl('input', { type: 'checkbox' });
				cb.checked = getWhitelist().includes(ext);
				label.createSpan({ text: ext });
				cb.addEventListener('change', () => {
					void (async () => {
						const list = getWhitelist();
						const has = list.includes(ext);
						if (cb.checked && !has) list.push(ext);
						else if (!cb.checked && has) list.splice(list.indexOf(ext), 1);
						list.sort();
						await this.plugin.saveSettings();
					})();
				});
			}
		};
		renderTypeGroup('images', 'Images');
		renderTypeGroup('audio', 'Audio');
		renderTypeGroup('video', 'Video');
		renderTypeGroup('pdf', 'PDF');

		new Setting(containerEl).setName('Image conversion').setHeading();
		const conv = containerEl.createDiv({ cls: 'crucible-settings-group' });
		new Setting(conv).setName('Convert attached images').addToggle(t => t.setValue(s.localizeAttachmentsConvertAttachedImages).onChange(async (v) => { s.localizeAttachmentsConvertAttachedImages = v; await this.plugin.saveSettings(); this.display(); }));
		if (s.localizeAttachmentsConvertAttachedImages) {
			conv.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(conv).setName('Attached: target format').addDropdown(d => { d.addOption('webp', 'WebP').addOption('jpeg', 'JPEG').setValue(s.localizeAttachmentsAttachedImageFormat).onChange(async (v: ImageConvertFormat) => { s.localizeAttachmentsAttachedImageFormat = v; await this.plugin.saveSettings(); }); d.selectEl.addClass('pi-width-half'); });
			conv.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(conv).setName('Attached: quality (30–100)').addText(t => { t.inputEl.type = 'number'; t.inputEl.min = '30'; t.inputEl.max = '100'; t.inputEl.step = '1'; t.setValue(String(s.localizeAttachmentsAttachedImageQuality)).onChange(async (v) => { s.localizeAttachmentsAttachedImageQuality = Math.min(100, Math.max(30, parseInt(v) || 85)); await this.plugin.saveSettings(); }); t.inputEl.addClass('pi-width-half'); });
		}
		conv.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(conv).setName('Convert pasted images').addToggle(t => t.setValue(s.localizeAttachmentsConvertPastedImages).onChange(async (v) => { s.localizeAttachmentsConvertPastedImages = v; await this.plugin.saveSettings(); this.display(); }));
		if (s.localizeAttachmentsConvertPastedImages) {
			conv.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(conv).setName('Pasted: target format').addDropdown(d => { d.addOption('webp', 'WebP').addOption('jpeg', 'JPEG').setValue(s.localizeAttachmentsPastedImageFormat).onChange(async (v: ImageConvertFormat) => { s.localizeAttachmentsPastedImageFormat = v; await this.plugin.saveSettings(); }); d.selectEl.addClass('pi-width-half'); });
			conv.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(conv).setName('Pasted: quality (30–100)').addText(t => { t.inputEl.type = 'number'; t.inputEl.min = '30'; t.inputEl.max = '100'; t.inputEl.step = '1'; t.setValue(String(s.localizeAttachmentsPastedImageQuality)).onChange(async (v) => { s.localizeAttachmentsPastedImageQuality = Math.min(100, Math.max(30, parseInt(v) || 80)); await this.plugin.saveSettings(); }); t.inputEl.addClass('pi-width-half'); });
		}

		new Setting(containerEl).setName('Storage').setHeading();
		const store = containerEl.createDiv({ cls: 'crucible-settings-group' });
		new Setting(store).setName('Attachment folder template').setDesc('Tokens: {{folder}}, {{slug}}, {{name}}, {{date}}, {{datetime:FMT}}.').addText(t => t.setPlaceholder('{{folder}}/_attachments/{{slug}}').setValue(s.localizeAttachmentsFolderTemplate).onChange(async (v) => { s.localizeAttachmentsFolderTemplate = v; await this.plugin.saveSettings(); }).inputEl.addClass('pi-width-wide'));
		store.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(store).setName('Attachment name template').setDesc('Tokens: {{md5}}, {{ext}}, {{original}}, {{name}}, {{slug}}.').addText(t => t.setPlaceholder('{{md5}}_MD5.{{ext}}').setValue(s.localizeAttachmentsNameTemplate).onChange(async (v) => { s.localizeAttachmentsNameTemplate = v; await this.plugin.saveSettings(); }).inputEl.addClass('pi-width-wide'));
		store.createEl('hr', { cls: 'crucible-row-divider' });
		new Setting(store).setName('Follow note lifecycle').setDesc('Rename, move, or delete the attachment folder when the note is renamed, moved, or deleted.').addToggle(t => t.setValue(s.localizeAttachmentsFollowNoteLifecycle).onChange(async (v) => { s.localizeAttachmentsFollowNoteLifecycle = v; await this.plugin.saveSettings(); }));

		const actions = containerEl.createDiv({ cls: 'crucible-settings-group' });
		new Setting(actions).setName('Run now').addButton(bt => bt.setButtonText('Localize this note').onClick(async () => { const f = this.app.workspace.getActiveFile(); if (f && f.extension === 'md') await this.plugin.attachmentLocalizer.localizeNote(f); else new (await import('obsidian')).Notice('Open a Markdown note first'); })).addButton(bt => bt.setButtonText('Localize vault').setWarning().onClick(async () => { await this.plugin.attachmentLocalizer.localizeVault(); }));
	}

	private getLocalizeFlag(type: LocalizeMediaType, kind: 'attached' | 'pasted'): boolean {
		const s = this.plugin.settings;
		if (type === 'images') return kind === 'attached' ? s.localizeAttachmentsImagesProcessAttached : s.localizeAttachmentsImagesProcessPasted;
		if (type === 'audio') return kind === 'attached' ? s.localizeAttachmentsAudioProcessAttached : s.localizeAttachmentsAudioProcessPasted;
		if (type === 'video') return kind === 'attached' ? s.localizeAttachmentsVideoProcessAttached : s.localizeAttachmentsVideoProcessPasted;
		return kind === 'attached' ? s.localizeAttachmentsPdfProcessAttached : s.localizeAttachmentsPdfProcessPasted;
	}

	private setLocalizeFlag(type: LocalizeMediaType, kind: 'attached' | 'pasted', value: boolean): void {
		const s = this.plugin.settings;
		if (type === 'images') { if (kind === 'attached') s.localizeAttachmentsImagesProcessAttached = value; else s.localizeAttachmentsImagesProcessPasted = value; return; }
		if (type === 'audio') { if (kind === 'attached') s.localizeAttachmentsAudioProcessAttached = value; else s.localizeAttachmentsAudioProcessPasted = value; return; }
		if (type === 'video') { if (kind === 'attached') s.localizeAttachmentsVideoProcessAttached = value; else s.localizeAttachmentsVideoProcessPasted = value; return; }
		if (kind === 'attached') s.localizeAttachmentsPdfProcessAttached = value; else s.localizeAttachmentsPdfProcessPasted = value;
	}

	private getLocalizeWhitelist(type: LocalizeMediaType): string[] {
		const s = this.plugin.settings;
		if (type === 'images') return s.localizeAttachmentsImagesWhitelist;
		if (type === 'audio') return s.localizeAttachmentsAudioWhitelist;
		if (type === 'video') return s.localizeAttachmentsVideoWhitelist;
		return s.localizeAttachmentsPdfWhitelist;
	}

	private renderShortcutSettings(containerEl: HTMLElement) {
		new Setting(containerEl).setName('Shortcuts').setHeading();
		containerEl.createEl('p', { text: 'Create custom commands to open specific files directly from the Command Palette.' });
		const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
		sortByNameWithEmptyLast(this.plugin.settings.shortcuts, s => s.name).forEach(({ item: shortcut, index }, displayIdx) => {
			if (displayIdx > 0) group.createEl('hr', { cls: 'crucible-mini-hr' });
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

		const heading = new Setting(containerEl).setName('Edit Capture').setHeading();
		const captureWarning = this.getCaptureWarning(capture);
		if (captureWarning) this.addWarningIcon(heading.nameEl, captureWarning);

		const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
		if (captureWarning) {
			group.createDiv({ cls: 'crucible-setting-warning', text: captureWarning });
		}
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
			.setName('Target section mode')
			.setDesc('Choose whether captures use a fixed section or the matching source-note section.')
			.addDropdown(dd => {
				dd.addOption('fixed', 'Fixed section')
				  .addOption('source', 'Same source section')
				  .setValue(capture.targetSectionMode || 'fixed')
				  .onChange(async (value: CaptureTargetSectionMode) => {
					  capture.targetSectionMode = value;
					  await this.plugin.saveSettings();
					  this.display();
				  });
				dd.selectEl.addClass('pi-width-half');
			});

		group.createEl('hr', { cls: 'crucible-row-divider' });
		const targetSectionMode = capture.targetSectionMode || 'fixed';
		new Setting(group)
			.setName(targetSectionMode === 'source' ? 'Fallback section' : 'Target section')
			.setDesc(targetSectionMode === 'source'
				? 'Header used when the matching source section is not present in the target note.'
				: 'Header to target (e.g. # Captures). If empty, targets top/bottom of file.')
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
		const contentSetting = new Setting(group)
			.setName('Content template')
			.setDesc('Text to capture (supports variables like {{now}}, {{value}}, {{source_link}}).')
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
		this.addTemplateVariablesToggle(contentSetting, 'capture-content', this.captureTemplateVariables());
		this.renderTemplateVariablesPanel(group, 'capture-content', this.captureTemplateVariables());

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
