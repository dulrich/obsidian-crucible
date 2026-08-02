/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { Agent, AgentExecutionMode, AgentPromptSource } from "../../types";
import { agentCommandId } from "../../agents";
import { FileSuggest } from "../../suggesters";
import { confirmDestructive } from "../destructiveActions";
import { SearchWithContainer, TemplateVariableInfo, sortByNameWithEmptyLast } from "../shared";
import { bindText, bindToggle, bindDropdown } from "../bind";
import { renderAgentBindingEditor } from "./aiAgentBinding";

/**
 * WP-rem-R4 (F4) — the agent list + agent editor half of the original `sections/ai.ts`. The
 * model-binding dropdown/editor lives in the sibling `aiAgentBinding.ts`, which builds on the
 * WP-R2 `providerModelContract` module rather than re-deriving binding logic here.
 */

export function renderAgentListSection(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	new Setting(containerEl).setName('Agents').setHeading();
	containerEl.createEl('p', { text: 'An Agent binds a Provider to a system prompt and a user-prompt template. Each Agent is registered as an internal command so it can be used as a step in a Chain.' });

	if (tab.plugin.settings.providers.length === 0) {
		const empty = containerEl.createDiv({ cls: 'crucible-settings-group' });
		empty.createDiv({ text: 'Configure at least one Provider before adding agents.', cls: 'crucible-empty-state' });
	}

	const listGroup = containerEl.createDiv({ cls: 'crucible-settings-group' });

	if (tab.plugin.settings.agents.length === 0) {
		listGroup.createDiv({ text: 'No agents configured.', cls: 'crucible-empty-state' });
	} else {
		sortByNameWithEmptyLast(tab.plugin.settings.agents, a => a.name).forEach(({ item: agent, index }, displayIdx) => {
			if (displayIdx > 0) listGroup.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(listGroup)
				.setName(agent.name || '(unnamed)')
				.setDesc(describeAgent(tab, agent))
				.addExtraButton(cb => cb.setIcon('copy-plus').setTooltip('Duplicate agent').onClick(async () => {
					const copy = JSON.parse(JSON.stringify(agent)) as Agent;
					copy.id = Math.random().toString(36).substring(2, 9);
					copy.name = copy.name ? `${copy.name} (copy)` : '(copy)';
					tab.plugin.settings.agents.push(copy);
					await tab.plugin.saveSettings();
					tab.plugin.registerAgents();
					tab.display();
				}))
				.addExtraButton(cb => cb.setIcon('pencil').setTooltip('Edit agent').onClick(() => {
					tab.editingAgentIndex = index;
					tab.display();
				}))
				.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete agent').onClick(async () => {
					await deleteAgent(tab, index);
				}));
		});
	}

	new Setting(containerEl).addButton(bt => bt
		.setButtonText('Add agent')
		.setCta()
		.setDisabled(tab.plugin.settings.providers.length === 0)
		.onClick(async () => {
			const id = Math.random().toString(36).substring(2, 9);
			const firstProvider = tab.plugin.settings.providers[0];
			const firstModel = firstProvider?.models?.[0];
			tab.plugin.settings.agents.push({
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
			await tab.plugin.saveSettings();
			tab.plugin.registerAgents();
			tab.editingAgentIndex = tab.plugin.settings.agents.length - 1;
			tab.display();
		}));
}

function describeAgent(tab: CrucibleSettingTab, agent: Agent): string {
	const binding = agent.modelBinding;
	switch (binding.mode) {
		case 'pinned': {
			const provider = tab.plugin.settings.providers.find(p => p.id === binding.pinned.providerId);
			const model = provider?.models?.find(m => m.id === binding.pinned.modelId);
			const providerName = provider ? provider.name || `(unnamed ${provider.kind})` : 'unknown provider';
			const modelName = model ? model.label || model.id : binding.pinned.modelId || '(no model)';
			return `${providerName} · ${modelName} — ${agentCommandId(agent.id)}`;
		}
		case 'constrained':
			return `Constrained (${binding.allow.length} allowed) — ${agentCommandId(agent.id)}`;
		case 'runtime':
			return `Runtime pick — ${agentCommandId(agent.id)}`;
	}
}

async function deleteAgent(tab: CrucibleSettingTab, index: number) {
	const agent = tab.plugin.settings.agents[index];
	if (!agent) return;

	if (!(await confirmDestructive(tab.app, tab.plugin.settings, 'agent-delete', {
		message: `Delete agent "${agent.name || '(unnamed)'}"? This cannot be undone.`,
	}))) return;

	tab.plugin.settings.agents.splice(index, 1);
	tab.editingAgentIndex = -1;
	await tab.plugin.saveSettings();
	tab.plugin.registerAgents();
	tab.display();
}

export function renderEditAgent(tab: CrucibleSettingTab, containerEl: HTMLElement, agent: Agent, index: number) {
	const save = () => tab.plugin.saveSettings();
	const commandId = agentCommandId(agent.id);

	new Setting(containerEl)
		.setName(`Agent: ${agent.name || '(unnamed)'}`)
		.setDesc(`Chain command: ${commandId}`)
		.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete agent').onClick(async () => {
			await deleteAgent(tab, index);
		}));

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	bindText(containerEl, {
		name: 'Name',
		placeholder: 'e.g. Summarize',
		get: () => agent.name,
		set: (v) => { agent.name = v; },
	}, save);

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	renderAgentBindingEditor(tab, containerEl, agent);

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	bindDropdown(containerEl, {
		name: 'Execution mode',
		desc: 'Read-only: CLI agents run with sandbox/tool restrictions where supported (Claude --tools Read, Codex --sandbox read-only). Edit: agent may write within its working directory. Unrestricted: no sandbox flags applied.',
		options: { 'read-only': 'Read-only (default)', edit: 'Edit', unrestricted: 'Unrestricted' },
		width: 'pi-width-wide',
		get: () => agent.executionMode || 'read-only',
		set: (v) => { agent.executionMode = v as AgentExecutionMode; },
	}, save);

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	bindToggle(containerEl, {
		name: 'Require normal API finish',
		desc: 'API agents fail when generation stops for truncation, filtering, tool calls, errors, or an unknown reason. CLI agents ignore this setting.',
		get: () => agent.requireNormalFinishReason ?? true,
		set: (v) => { agent.requireNormalFinishReason = v; },
	}, save);

	const autoSizeEl = (el: HTMLTextAreaElement) => {
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
					 tab.display();
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
					new FileSuggest(tab.app, cb.inputEl);
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
						autoSizeEl(t.inputEl);
					 });
					t.inputEl.addClass('crucible-setting-textarea', 'pi-width-wide');
					requestAnimationFrame(() => autoSizeEl(t.inputEl));
				});
			tab.addTemplateVariablesToggle(promptSetting, panelKey, variables);
			tab.renderTemplateVariablesPanel(containerEl, panelKey, variables);
		}
	};

	renderPromptEditor(
		`agent-${index}-system-prompt`,
		'System prompt',
		'Persistent instructions for the agent. Supports template tokens like {{today}}, {{datetime:FORMAT}}.',
		'You are a helpful assistant...',
		tab.agentPromptVariables(false),
		() => agent.systemPromptSource || 'text',
		async (v) => { agent.systemPromptSource = v; await save(); },
		() => agent.systemPromptText || '',
		async (v) => { agent.systemPromptText = v; await save(); },
		() => agent.systemPromptFile || '',
		async (v) => { agent.systemPromptFile = v; await save(); },
	);

	renderPromptEditor(
		`agent-${index}-user-prompt`,
		'User prompt template',
		'Template for the user message. {{input}} (or {{value}}) is replaced by the runtime input passed to the agent.',
		'Summarize the following:\n\n{{input}}',
		tab.agentPromptVariables(true),
		() => agent.userPromptSource || 'text',
		async (v) => { agent.userPromptSource = v; await save(); },
		() => agent.userPromptText || '',
		async (v) => { agent.userPromptText = v; await save(); },
		() => agent.userPromptFile || '',
		async (v) => { agent.userPromptFile = v; await save(); },
	);
}
