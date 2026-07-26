import { App, PluginSettingTab, Setting, setIcon, ExtraButtonComponent } from "obsidian";
import CruciblePlugin from "./main";
import { Chain, CrucibleSettings } from "./types";
import { TemplateVariableInfo } from "./settings/shared";
import { renderCommandSettings } from "./settings/sections/commands";
import { renderAutomateSettings } from "./settings/sections/automate";
import { renderAiSettings } from "./settings/sections/ai";
import { renderConfigureSettings } from "./settings/sections/configure";
import { renderOrchestrationSettings } from "./settings/sections/orchestration";
import { renderLintSettings } from "./settings/sections/lint";
import { renderSourceEvalSettings } from "./settings/sections/sourceEval";

// Exported so callers outside settings.ts (main.ts's settings-opening plumbing,
// SearchModal's rerank-configure deep-link) can name a tab without duplicating the union.
export type CrucibleSettingsTab = 'configure' | 'automate' | 'ai' | 'orchestrator' | 'lint' | 'commands';

/**
 * The settings tab is a thin shell: it holds shared editing state and template-variable
 * helpers, and delegates each tab's rendering to a per-feature module in `settings/sections/`.
 * The repetitive `new Setting(...).addX(...).onChange(...)` chains live behind the data-driven
 * helpers in `settings/bind.ts`. The schema (types + DEFAULTS) and migrations are untouched and
 * still live in `types.ts` / `main.ts`.
 */
export class CrucibleSettingTab extends PluginSettingTab {
	plugin: CruciblePlugin;
	private activeTab: CrucibleSettingsTab = 'configure';
	editingCaptureIndex: number = -1;
	editingChainIndex: number = -1;
	editingTriggerIndex: number = -1;
	editingProviderIndex: number = -1;
	editingAgentIndex: number = -1;
	editingWorkflowId: string | null = null;
	private expandedTemplateVariablePanels: Set<string> = new Set();

	constructor(app: App, plugin: CruciblePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private isEditingDetail(): boolean {
		return this.editingCaptureIndex !== -1 ||
			this.editingChainIndex !== -1 ||
			this.editingTriggerIndex !== -1 ||
			this.editingProviderIndex !== -1 ||
			this.editingAgentIndex !== -1 ||
			this.editingWorkflowId !== null;
	}

	private resetEditingState(): void {
		this.editingCaptureIndex = -1;
		this.editingChainIndex = -1;
		this.editingTriggerIndex = -1;
		this.editingProviderIndex = -1;
		this.editingAgentIndex = -1;
		this.editingWorkflowId = null;
	}

	getScrollContainer(): HTMLElement | null {
		// In the settings modal the scroller is .vertical-tab-content; in the
		// workspace-tab view it's the contentEl flagged with .crucible-settings-host.
		return this.containerEl.closest<HTMLElement>('.vertical-tab-content, .crucible-settings-host');
	}

	/**
	 * Deep-link entry point (WP-9: rerank Configure… affordance, and any future caller that
	 * needs to land on a specific tab rather than wherever `activeTab` last was). Switches the
	 * tab and drops any in-progress detail-editor state, same as clicking a tab button does.
	 *
	 * Only re-renders if this instance is currently attached to the DOM — the native settings
	 * modal and the workspace-tab view (`settingsView.ts`) each own a `CrucibleSettingTab`
	 * instance that may not be showing right now, and `display()` reads/writes `containerEl`,
	 * which Obsidian's settings framework re-calls anyway the next time this instance is
	 * actually surfaced. Calling `display()` on a detached instance would be harmless (it just
	 * repopulates an off-screen container) but the connectivity check keeps the effect scoped
	 * to "the surface the user can currently see."
	 */
	openToTab(tab: CrucibleSettingsTab): void {
		this.activeTab = tab;
		this.resetEditingState();
		if (this.containerEl.isConnected) this.display();
	}

	refreshDisplay() {
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
			variables.push({ token: 'value:oneline', description: 'Runtime input collapsed to one line', example: 'Para one. Para two.' });
		}
		variables.push({ token: 'datetime:FORMAT', description: 'Custom format', example: '{{datetime:MMMM YYYY}}' });
		return variables;
	}

	captureTemplateVariables(): TemplateVariableInfo[] {
		return [
			...this.baseTemplateVariables(),
			{ token: 'source_link', description: 'Capture source note link', example: '[[Projects/Ideas|Ideas]]' },
			{ token: 'source_path', description: 'Capture source note path', example: 'Projects/Ideas' },
			{ token: 'source_title', description: 'Capture source note title', example: 'Ideas' },
		];
	}

	chainArgumentVariables(chain: Chain): TemplateVariableInfo[] {
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

	agentPromptVariables(includeInput: boolean): TemplateVariableInfo[] {
		const variables = this.baseTemplateVariables();
		if (includeInput) {
			variables.push({ token: 'input', description: 'Runtime input; same value as {{value}}', example: 'Text to summarize' });
		}
		return variables;
	}

	periodTemplateVariables(): TemplateVariableInfo[] {
		return this.baseTemplateVariables(false);
	}

	renderTemplateVariableGrid(containerEl: HTMLElement, variables: TemplateVariableInfo[]): HTMLElement {
		const grid = containerEl.createDiv({ cls: 'crucible-variables-grid' });
		for (const variable of variables) {
			const row = grid.createDiv({ cls: 'crucible-variable-row' });
			row.createDiv({ cls: 'crucible-variable-token', text: `{{${variable.token}}}` });
			row.createDiv({ cls: 'crucible-variable-description', text: variable.description });
			row.createDiv({ cls: 'crucible-variable-example', text: variable.example });
		}
		return grid;
	}

	addTemplateVariablesToggle(setting: Setting, panelKey: string, variables: TemplateVariableInfo[]): void {
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

	renderTemplateVariablesPanel(containerEl: HTMLElement, panelKey: string, variables: TemplateVariableInfo[]): void {
		if (!this.expandedTemplateVariablePanels.has(panelKey)) return;
		const panel = containerEl.createDiv({ cls: 'crucible-template-variable-panel' });
		this.renderTemplateVariableGrid(panel, variables);
	}

	async setSettingValue<K extends keyof CrucibleSettings>(key: K, value: CrucibleSettings[K]): Promise<void> {
		this.plugin.settings[key] = value;
		await this.plugin.saveSettings();
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
			renderConfigureSettings(this, containerEl);
		} else if (this.activeTab === 'lint') {
			renderLintSettings(this, containerEl);
		} else if (this.activeTab === 'automate') {
			renderAutomateSettings(this, containerEl);
		} else if (this.activeTab === 'ai') {
			renderAiSettings(this, containerEl);
		} else if (this.activeTab === 'orchestrator') {
			renderOrchestrationSettings(this, containerEl);
			if (!this.isEditingDetail()) renderSourceEvalSettings(this, containerEl);
		} else if (this.activeTab === 'commands') {
			renderCommandSettings(this, containerEl);
		}
	}
}
