/* eslint-disable obsidianmd/ui/sentence-case */
import { Notice, Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { Agent, AgentBindingMode, AgentExecutionMode, AgentPromptSource, Provider, ProviderCatalogModel, ProviderKind, ProviderModel, providerModality } from "../../types";
import { agentCommandId } from "../../agents";
import { CLI_DEFAULT_TIMEOUT_SECONDS, providerSecretKey } from "../../providers";
import { FileSuggest, FolderSuggest, ProviderModelSuggest } from "../../suggesters";
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
import {
	acceptCatalogSuggestion,
	applyFetchedCatalog,
	catalogEntrySummaryTokens,
	catalogSuggestionHasChanges,
	clearAcceptedMarker,
	clearProviderModelCatalog,
	crossEncoderWarningText,
	deriveCatalogSuggestion,
	formatProbeStatusText,
	getOrCreateProbeState,
	getProbeStatus,
	modelHasCapability,
	resetCatalogField,
	setModelCapability,
	setProbeStatus,
} from "../modelCapabilities";

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
		} else if (provider.kind === 'openai-compatible') {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			bindText(containerEl, {
				name: 'Server URL',
				desc: 'OpenAI-compatible base URL, including the API path. For LM Studio use http://localhost:1234/v1',
				placeholder: 'http://localhost:1234/v1',
				get: () => provider.baseUrl || '',
				set: (v) => { provider.baseUrl = v; },
			}, save);

			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			mountProviderApiKeyControl(tab, containerEl, provider, {
				name: 'API Key (optional)',
				desc: 'Only required by servers configured with an API key (e.g. vLLM --api-key). Stored securely in Obsidian Secret Storage.',
			});
		} else {
			containerEl.createEl('hr', { cls: 'crucible-row-divider' });
			mountProviderApiKeyControl(tab, containerEl, provider, {
				name: 'API Key',
				desc: 'Stored securely in Obsidian Secret Storage.',
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

// The provider API-key control is identical for every kind that has one (only the
// name/desc differ between "required" and "optional" kinds) — one mount point instead
// of two verbatim copies.
function mountProviderApiKeyControl(tab: CrucibleSettingTab, containerEl: HTMLElement, provider: Provider, label: { name: string; desc: string }) {
	const apiKeySetting = new Setting(containerEl).setName(label.name).setDesc(label.desc);
	mountSecretControl(apiKeySetting, {
		load: () => tab.plugin.providerManager.loadApiKey(provider.id),
		store: (v) => tab.plugin.providerManager.storeApiKey(provider.id, v),
		clear: () => tab.plugin.providerManager.deleteApiKey(provider.id),
		expectedButMissing: () => tab.plugin.secretRegistry.isRegistered(providerSecretKey(provider.id)),
	});
}

// The "<Provider kind> reports: ..." provenance line under a surfaced suggestion — D2 rule 2
// ("show it inline as a suggestion with its provenance"). Kept here (not in modelCapabilities.ts)
// because it needs PROVIDER_KIND_LABELS, which is UI copy, not probe logic.
function buildProvenanceText(provider: Provider, entry: ProviderCatalogModel): string {
	const label = PROVIDER_KIND_LABELS[provider.kind] ?? provider.kind;
	const tokens = catalogEntrySummaryTokens(entry);
	return tokens.length > 0 ? `${label} reports: ${tokens.join(', ')}` : `${label} reports this model, but no further metadata.`;
}

function renderProviderModelsList(tab: CrucibleSettingTab, containerEl: HTMLElement, provider: Provider) {
	new Setting(containerEl).setName('Models').setHeading();
	containerEl.createEl('p', {
		text: 'Configure one or more models. Agents bind to a (provider, model) pair, and chain steps can override via {{model}}. Use Fetch models to pull the server\'s own model list and suggest capabilities and metadata — nothing is applied to a model until you press Accept.',
		cls: 'mod-muted',
	});

	const list = containerEl.createDiv({ cls: 'crucible-settings-group' });
	const models = provider.models ?? (provider.models = []);
	const catalogModels = provider.modelCatalog?.models ?? [];

	if (models.length === 0) {
		list.createDiv({ text: 'No models configured.', cls: 'crucible-empty-state' });
	} else {
		models.forEach((model, modelIndex) => {
			if (modelIndex > 0) list.createEl('hr', { cls: 'crucible-row-divider' });
			const modelRow = list.createDiv({ cls: 'crucible-provider-model-row' });
			const probeState = getOrCreateProbeState(model);

			new Setting(modelRow)
				.setName('Model')
				.addText(t => {
					t.setPlaceholder(modelIdPlaceholder(provider.kind))
						.setValue(model.id)
						.onChange(async (v) => { model.id = v; await tab.plugin.saveSettings(); })
						.inputEl.addClass('pi-width-normal');
					// Deferred to a macrotask: selectSuggestion() still needs to close its own
					// popup after this callback returns, and a synchronous tab.display() here
					// would tear down the settings pane's DOM (this input included) out from
					// under that close() call.
					new ProviderModelSuggest(tab.app, t.inputEl, () => catalogModels, () => { setTimeout(() => tab.display(), 0); });
				})
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
			if (probeState.accepted.capabilities) {
				capabilities.nameEl.createSpan({ cls: 'crucible-probe-accepted-badge', text: 'probe-accepted' });
				capabilities.addExtraButton(cb => cb.setIcon('undo-2').setTooltip('Reset to your entered value').onClick(async () => {
					resetCatalogField(model, 'capabilities', probeState);
					await tab.plugin.saveSettings();
					tab.display();
				}));
			}
			capabilities.controlEl.createSpan({ cls: 'crucible-inline-control-label', text: 'Chat' });
			capabilities
				.addToggle(t => t
					.setTooltip('Chat model')
					.setValue(modelHasCapability(model, 'chat'))
					.onChange(async (v) => { setModelCapability(model, 'chat', v); clearAcceptedMarker(probeState, 'capabilities'); await tab.plugin.saveSettings(); }));
			capabilities.controlEl.createSpan({ cls: 'crucible-inline-control-label', text: 'Embedding' });
			capabilities
				.addToggle(t => t
					.setTooltip('Embedding model')
					.setValue(modelHasCapability(model, 'embedding'))
					.onChange(async (v) => { setModelCapability(model, 'embedding', v); clearAcceptedMarker(probeState, 'capabilities'); await tab.plugin.saveSettings(); }));
			capabilities.controlEl.createSpan({ cls: 'crucible-inline-control-label', text: 'Image' });
			capabilities
				.addToggle(t => t
					.setTooltip('Image extraction model')
					.setValue(modelHasCapability(model, 'image-extraction'))
					.onChange(async (v) => { setModelCapability(model, 'image-extraction', v); clearAcceptedMarker(probeState, 'capabilities'); await tab.plugin.saveSettings(); }));
			capabilities.controlEl.createSpan({ cls: 'crucible-inline-control-label', text: 'Rerank' });
			capabilities
				.addToggle(t => t
					.setTooltip('Reranker model — a cross-encoder scoring (query, document) pairs, e.g. bge-reranker-v2-m3. Not an embedding model.')
					.setValue(modelHasCapability(model, 'rerank'))
					.onChange(async (v) => { setModelCapability(model, 'rerank', v); clearAcceptedMarker(probeState, 'capabilities'); await tab.plugin.saveSettings(); }));

			const dimsSetting = new Setting(modelRow)
				.setName('Embedding dimensions')
				.setDesc('Optional, but recommended for embedding models: indexing checks every sub-batch against it and stops on a mismatch, so a wrong-width model fails after ≤96 texts instead of after a whole flush has been embedded.');
			if (probeState.accepted.embeddingDimensions) {
				dimsSetting.nameEl.createSpan({ cls: 'crucible-probe-accepted-badge', text: 'probe-accepted' });
				dimsSetting.addExtraButton(cb => cb.setIcon('undo-2').setTooltip('Reset to your entered value').onClick(async () => {
					resetCatalogField(model, 'embeddingDimensions', probeState);
					await tab.plugin.saveSettings();
					tab.display();
				}));
			}
			dimsSetting.addText(t => {
				t.setPlaceholder('Dims')
					.setValue(model.embeddingDimensions ? String(model.embeddingDimensions) : '')
					.onChange(async (v) => {
						const n = Number(v.trim());
						if (Number.isFinite(n) && n > 0) model.embeddingDimensions = Math.floor(n);
						else delete model.embeddingDimensions;
						clearAcceptedMarker(probeState, 'embeddingDimensions');
						await tab.plugin.saveSettings();
					});
				t.inputEl.type = 'number';
				t.inputEl.min = '1';
				t.inputEl.step = '1';
				t.inputEl.addClass('pi-width-half');
			});

			const variantSetting = new Setting(modelRow)
				.setName('Embedding precision (fallback)')
				.setDesc('Only needed when the server cannot report what it loaded — Crucible asks first, and a reported value always wins. The same weights at a different precision are a different vector space, so setting this when it matters (e.g. f16 vs fp32) keeps the two from being mixed. Leave empty unless you know: changing it re-embeds the vault.');
			if (probeState.accepted.embeddingVariant) {
				variantSetting.nameEl.createSpan({ cls: 'crucible-probe-accepted-badge', text: 'probe-accepted' });
				variantSetting.addExtraButton(cb => cb.setIcon('undo-2').setTooltip('Reset to your entered value').onClick(async () => {
					resetCatalogField(model, 'embeddingVariant', probeState);
					await tab.plugin.saveSettings();
					tab.display();
				}));
			}
			variantSetting.addText(t => {
				t.setPlaceholder('e.g. f16, fp32, q4_k_m')
					.setValue(model.embeddingVariant ?? '')
					.onChange(async (v) => {
						const trimmed = v.trim();
						if (trimmed) model.embeddingVariant = trimmed;
						else delete model.embeddingVariant;
						clearAcceptedMarker(probeState, 'embeddingVariant');
						await tab.plugin.saveSettings();
					});
				t.inputEl.addClass('pi-width-half');
			});

			// D2 rule 2 (Surface): only rendered when the current id matches a fetched catalog
			// entry. Nothing here writes to `model` — the Accept button below is the only control
			// in this row that does.
			const catalogEntry = catalogModels.find(m => m.id === model.id);
			if (catalogEntry) {
				const warning = crossEncoderWarningText(catalogEntry);
				if (warning) {
					modelRow.createDiv({ cls: 'crucible-inline-warning', text: warning });
				}

				const suggestion = deriveCatalogSuggestion(catalogEntry);
				if (catalogSuggestionHasChanges(model, suggestion)) {
					new Setting(modelRow)
						.setName('Probe suggestion')
						.setDesc(buildProvenanceText(provider, catalogEntry))
						.addButton(bt => bt.setButtonText('Accept').setCta().onClick(async () => {
							acceptCatalogSuggestion(model, suggestion, probeState);
							await tab.plugin.saveSettings();
							tab.display();
						}));
				}
			}
		});
	}

	const catalogStatus = getProbeStatus(provider);
	new Setting(containerEl)
		.addButton(bt => bt.setButtonText('Add model').onClick(async () => {
			models.push({ id: '', label: '', capabilities: ['chat'] });
			await tab.plugin.saveSettings();
			tab.display();
		}))
		.addButton(bt => bt.setButtonText('Fetch models').setTooltip('Query the provider\'s model-list endpoint. Nothing is applied automatically — review and Accept per model below.').onClick(async () => {
			bt.setDisabled(true);
			try {
				const fetched = await tab.plugin.providerManager.listModels(provider);
				applyFetchedCatalog(provider, fetched);
				await tab.plugin.saveSettings();
				setProbeStatus(provider, { state: 'ok', count: fetched.length });
			} catch (err) {
				setProbeStatus(provider, { state: 'error', reason: err instanceof Error ? err.message : String(err) });
			}
			// D2: await the probe before re-rendering — a single tab.display() after the promise
			// settles, never one at loading start, so the model list never shows stale results
			// while a fetch is still in flight.
			tab.display();
		}))
		.addButton(bt => bt.setButtonText('Clear cache').setWarning().onClick(async () => {
			clearProviderModelCatalog(provider, (id) => tab.plugin.providerManager.clearModelListCache(id));
			setProbeStatus(provider, { state: 'idle' });
			await tab.plugin.saveSettings();
			new Notice('Model list cache cleared');
			tab.display();
		}));

	if (catalogStatus.state !== 'idle') {
		containerEl.createEl('p', { text: formatProbeStatusText(catalogStatus), cls: 'crucible-probe-status mod-muted' });
	}
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
