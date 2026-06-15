/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { Agent, AgentBindingMode, AgentExecutionMode, AgentPromptSource, Provider, ProviderKind, ProviderModel, ProviderModelCapability, providerModality } from "../../types";
import { agentCommandId } from "../../agents";
import { CLI_DEFAULT_TIMEOUT_SECONDS } from "../../providers";
import { FileSuggest, FolderSuggest } from "../../suggesters";
import {
	PROVIDER_KIND_LABELS,
	SearchWithContainer,
	TemplateVariableInfo,
	collectAllRefs,
	defaultCliCommand,
	modelIdPlaceholder,
	mountSecretControl,
	sortByNameWithEmptyLast,
} from "../shared";
import { bindText, bindToggle, bindDropdown, bindSearch } from "../bind";

export function renderAiSettings(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	if (tab.editingProviderIndex !== -1) {
		const provider = tab.plugin.settings.providers[tab.editingProviderIndex];
		if (provider) {
			new Setting(containerEl).setName('Edit Provider').setHeading();
			const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
			renderEditProvider(tab, group, provider, tab.editingProviderIndex);
			return;
		}
		tab.editingProviderIndex = -1;
	}

	if (tab.editingAgentIndex !== -1) {
		const agent = tab.plugin.settings.agents[tab.editingAgentIndex];
		if (agent) {
			new Setting(containerEl).setName('Edit Agent').setHeading();
			const group = containerEl.createDiv({ cls: 'crucible-settings-group' });
			renderEditAgent(tab, group, agent, tab.editingAgentIndex);
			return;
		}
		tab.editingAgentIndex = -1;
	}

	renderProviderListSection(tab, containerEl);
	renderAgentListSection(tab, containerEl);
}

function renderProviderListSection(tab: CrucibleSettingTab, containerEl: HTMLElement) {
	new Setting(containerEl).setName('Providers').setHeading();
	containerEl.createEl('p', { text: 'Configure LLM connections and models. Agents reference providers when they run.' });

	const group = containerEl.createDiv({ cls: 'crucible-settings-group' });

	if (tab.plugin.settings.providers.length === 0) {
		group.createDiv({ text: 'No providers configured.', cls: 'crucible-empty-state' });
	} else {
		sortByNameWithEmptyLast(tab.plugin.settings.providers, p => p.name).forEach(({ item: provider, index }, displayIdx) => {
			if (displayIdx > 0) group.createEl('hr', { cls: 'crucible-row-divider' });
			new Setting(group)
				.setName(provider.name || '(unnamed)')
				.setDesc(describeProvider(provider))
				.addExtraButton(cb => cb.setIcon('pencil').setTooltip('Edit provider').onClick(() => {
					tab.editingProviderIndex = index;
					tab.display();
				}))
				.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete provider').onClick(async () => {
					await deleteProvider(tab, index);
				}));
		});
	}

	new Setting(containerEl).addButton(bt => bt.setButtonText('Add provider').setCta().onClick(async () => {
		const id = Math.random().toString(36).substring(2, 9);
		tab.plugin.settings.providers.push({ id, name: '', kind: 'openai', models: [] });
		await tab.plugin.saveSettings();
		tab.editingProviderIndex = tab.plugin.settings.providers.length - 1;
		tab.display();
	}));
}

function describeProvider(provider: Provider): string {
	const kindLabel = PROVIDER_KIND_LABELS[provider.kind] ?? provider.kind;
	const count = provider.models?.length ?? 0;
	const summary = count === 0 ? 'no models' : count === 1 ? '1 model' : `${count} models`;
	return `${kindLabel} · ${summary}`;
}

async function deleteProvider(tab: CrucibleSettingTab, index: number) {
	const provider = tab.plugin.settings.providers[index];
	if (!provider) return;

	tab.plugin.settings.providers.splice(index, 1);
	tab.editingProviderIndex = -1;
	await tab.plugin.saveSettings();
	await tab.plugin.providerManager.deleteApiKey(provider.id);
	tab.plugin.registerAgents();
	tab.display();
}

function renderEditProvider(tab: CrucibleSettingTab, containerEl: HTMLElement, provider: Provider, index: number) {
	const save = () => tab.plugin.saveSettings();

	new Setting(containerEl)
		.setName(`Provider: ${provider.name || '(unnamed)'}`)
		.addExtraButton(cb => cb.setIcon('trash').setTooltip('Delete provider').onClick(async () => {
			await deleteProvider(tab, index);
		}));

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	bindText(containerEl, {
		name: 'Name',
		placeholder: 'e.g. OpenRouter',
		get: () => provider.name,
		set: (v) => { provider.name = v; },
	}, save);

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	bindDropdown(containerEl, {
		name: 'Kind',
		desc: 'Determines how this provider is invoked. API kinds use HTTP; CLI kinds spawn a local command.',
		options: PROVIDER_KIND_LABELS,
		get: () => provider.kind,
		set: (v) => { provider.kind = v as ProviderKind; },
		after: () => tab.display(),
	}, save);

	const modality = providerModality(provider.kind);

	if (modality === 'api') {
		if (provider.kind === 'ollama') {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			bindText(containerEl, {
				name: 'Ollama URL',
				desc: 'Default is http://localhost:11434',
				placeholder: 'http://localhost:11434',
				get: () => provider.baseUrl || '',
				set: (v) => { provider.baseUrl = v; },
			}, save);
		} else {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			const apiKeySetting = new Setting(containerEl)
				.setName('API Key')
				.setDesc('Stored securely in Obsidian Secret Storage.');
			mountSecretControl(apiKeySetting, {
				load: () => tab.plugin.providerManager.loadApiKey(provider.id),
				store: (v) => tab.plugin.providerManager.storeApiKey(provider.id, v),
				clear: () => tab.plugin.providerManager.deleteApiKey(provider.id),
			});
		}
	} else {
		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		bindText(containerEl, {
			name: 'Command',
			desc: `Path or name of the executable. Leave blank to use the default for this kind.`,
			placeholder: defaultCliCommand(provider.kind),
			get: () => provider.command || '',
			set: (v) => { provider.command = v; },
		}, save);

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		bindText(containerEl, {
			name: 'Extra arguments',
			desc: 'Optional. Whitespace-separated arguments to pass before the prompt. Quotes are respected.',
			placeholder: '--no-color',
			width: 'pi-width-wide',
			get: () => provider.extraArgs || '',
			set: (v) => { provider.extraArgs = v; },
		}, save);

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		bindText(containerEl, {
			name: 'Working directory',
			desc: 'Optional. Vault-relative or absolute path. Leave blank for the process default.',
			placeholder: '/absolute/path',
			width: 'pi-width-wide',
			get: () => provider.cwd || '',
			set: (v) => { provider.cwd = v; },
		}, save);

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
							await save();
							return;
						}

						const seconds = Number(trimmed);
						if (Number.isFinite(seconds) && seconds > 0) {
							provider.timeoutSeconds = Math.ceil(seconds);
							await save();
						}
					});
				t.inputEl.type = 'number';
				t.inputEl.min = '1';
				t.inputEl.step = '1';
				t.inputEl.addClass('pi-width-half');
			});

		containerEl.createEl('hr', { cls: 'crucible-row-divider' });
		bindToggle(containerEl, {
			name: 'Capture run artifacts',
			desc: 'Per run, write task.md, system.md, invocation.json, response.md, progress.log to the run directory.',
			get: () => provider.cliRunArtifactsEnabled !== false,
			set: (v) => { provider.cliRunArtifactsEnabled = v; },
			after: () => tab.display(),
		}, save);

		if (provider.cliRunArtifactsEnabled !== false) {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			bindSearch(containerEl, {
				name: 'Run directory',
				desc: 'Vault-relative folder. Each run lands in <dir>/<timestamp>-<agent>/. latest.log is updated for tailing.',
				placeholder: '_crucible/cli-runs',
				width: 'pi-width-wide',
				get: () => provider.cliRunDirectory || '',
				set: (v) => { provider.cliRunDirectory = v.trim(); },
				suggest: (el) => { new FolderSuggest(tab.app, el); },
			}, save);
		}
	}

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });
	renderProviderModelsList(tab, containerEl, provider);
}

function renderProviderModelsList(tab: CrucibleSettingTab, containerEl: HTMLElement, provider: Provider) {
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
			const modelRow = list.createDiv({ cls: 'crucible-provider-model-row' });
			new Setting(modelRow)
				.setName('Model')
				.addText(t => t
					.setPlaceholder(modelIdPlaceholder(provider.kind))
					.setValue(model.id)
					.onChange(async (v) => { model.id = v; await tab.plugin.saveSettings(); })
					.inputEl.addClass('pi-width-normal'))
				.addText(t => t
					.setPlaceholder('Display label (optional)')
					.setValue(model.label)
					.onChange(async (v) => { model.label = v; await tab.plugin.saveSettings(); })
					.inputEl.addClass('pi-width-normal'))
				.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove model').onClick(async () => {
					models.splice(modelIndex, 1);
					await tab.plugin.saveSettings();
					tab.display();
				}));

			const capabilities = new Setting(modelRow)
				.setName('Capabilities');
			capabilities.controlEl.createSpan({ cls: 'crucible-inline-control-label', text: 'Chat' });
			capabilities
				.addToggle(t => t
					.setTooltip('Chat model')
					.setValue(modelHasCapability(model, 'chat'))
					.onChange(async (v) => { setModelCapability(model, 'chat', v); await tab.plugin.saveSettings(); }));
			capabilities.controlEl.createSpan({ cls: 'crucible-inline-control-label', text: 'Embedding' });
			capabilities
				.addToggle(t => t
					.setTooltip('Embedding model')
					.setValue(modelHasCapability(model, 'embedding'))
					.onChange(async (v) => { setModelCapability(model, 'embedding', v); await tab.plugin.saveSettings(); }));

			new Setting(modelRow)
				.setName('Embedding dimensions')
				.setDesc('Optional. Used as documentation for the selected embedding model.')
				.addText(t => {
					t.setPlaceholder('Dims')
						.setValue(model.embeddingDimensions ? String(model.embeddingDimensions) : '')
						.onChange(async (v) => {
							const n = Number(v.trim());
							if (Number.isFinite(n) && n > 0) model.embeddingDimensions = Math.floor(n);
							else delete model.embeddingDimensions;
							await tab.plugin.saveSettings();
						});
					t.inputEl.type = 'number';
					t.inputEl.min = '1';
					t.inputEl.step = '1';
					t.inputEl.addClass('pi-width-half');
				});
		});
	}

	new Setting(containerEl).addButton(bt => bt.setButtonText('Add model').onClick(async () => {
		models.push({ id: '', label: '', capabilities: ['chat'] });
		await tab.plugin.saveSettings();
		tab.display();
	}));
}

function modelHasCapability(model: ProviderModel, capability: ProviderModelCapability): boolean {
	if (!model.capabilities || model.capabilities.length === 0) return capability === 'chat';
	return model.capabilities.includes(capability);
}

function setModelCapability(model: ProviderModel, capability: ProviderModelCapability, enabled: boolean): void {
	const defaults: ProviderModelCapability[] = ['chat'];
	const next = new Set<ProviderModelCapability>(model.capabilities && model.capabilities.length > 0 ? model.capabilities : defaults);
	if (enabled) next.add(capability);
	else next.delete(capability);
	model.capabilities = Array.from(next);
}

function renderAgentListSection(tab: CrucibleSettingTab, containerEl: HTMLElement) {
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
				.addExtraButton(cb => cb.setIcon('copy').setTooltip('Duplicate agent').onClick(async () => {
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
	if (binding?.mode === 'pinned' && binding.pinned) {
		const provider = tab.plugin.settings.providers.find(p => p.id === binding.pinned!.providerId);
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

async function deleteAgent(tab: CrucibleSettingTab, index: number) {
	if (!tab.plugin.settings.agents[index]) return;

	tab.plugin.settings.agents.splice(index, 1);
	tab.editingAgentIndex = -1;
	await tab.plugin.saveSettings();
	tab.plugin.registerAgents();
	tab.display();
}

function renderEditAgent(tab: CrucibleSettingTab, containerEl: HTMLElement, agent: Agent, index: number) {
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

function renderAgentBindingEditor(tab: CrucibleSettingTab, containerEl: HTMLElement, agent: Agent) {
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
				 await tab.plugin.saveSettings();
				 tab.display();
			 });
			d.selectEl.addClass('pi-width-wide');
		});

	const allProviders = tab.plugin.settings.providers;
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
					 await tab.plugin.saveSettings();
					 tab.display();
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
					 await tab.plugin.saveSettings();
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
						await tab.plugin.saveSettings();
						tab.display();
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
					await tab.plugin.saveSettings();
					tab.display();
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
