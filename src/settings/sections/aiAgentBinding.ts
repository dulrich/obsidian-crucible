import { Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { Agent, AgentBindingMode, AgentModelBinding, ProviderModel } from "../../types";
import { bindingForMode, formatModelRef, parseModelRef } from "../../providerModelContract";
import { confirmDestructive } from "../destructiveActions";
import { collectAllRefs } from "../shared";
import { modelHasCapability, providerHasChatCapableModel } from "../modelCapabilities";

/**
 * WP-rem-R4 (F4) — the agent model-binding editor, split out of `sections/ai.ts`. Builds entirely
 * on the WP-R2 `providerModelContract` module's public surface (`bindingForMode` is the only thing
 * a mode-change handler may assign; the discriminated union's payload is read directly, no local
 * re-derivation or re-switching where the contract module already answers the question).
 */

export function renderAgentBindingEditor(tab: CrucibleSettingTab, containerEl: HTMLElement, agent: Agent) {
	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	const binding = agent.modelBinding;

	new Setting(containerEl)
		.setName('Model selection')
		.setDesc('How this agent picks a (provider, model) when invoked.')
		.addDropdown(d => {
			d.addOption('pinned', 'Pinned: always use one model')
			 .addOption('constrained', 'Constrained: pick from an allowlist at run time')
			 .addOption('runtime', 'Runtime: pick from all configured models at run time')
			 .setValue(binding.mode)
			 .onChange(async (v: AgentBindingMode) => {
				 // Whole-variant replacement, not a mode-tag mutation: switching away from Pinned
				 // must not leave the old pinned ref persisted under a mode that never reads it.
				 agent.modelBinding = bindingForMode(v);
				 await tab.plugin.saveSettings();
				 tab.display();
			 });
			d.selectEl.addClass('pi-width-wide');
		});

	const allProviders = tab.plugin.settings.providers;
	const hasAnyModels = allProviders.some(p => (p.models ?? []).length > 0);

	if (binding.mode === 'pinned') {
		renderPinnedBindingEditor(tab, containerEl, binding, hasAnyModels);
	} else if (binding.mode === 'constrained') {
		renderConstrainedBindingEditor(tab, containerEl, binding, hasAnyModels);
	} else {
		renderRuntimeBindingEditor(containerEl);
	}
}

function renderPinnedBindingEditor(
	tab: CrucibleSettingTab,
	containerEl: HTMLElement,
	binding: Extract<AgentModelBinding, { mode: 'pinned' }>,
	hasAnyModels: boolean,
): void {
	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	if (!hasAnyModels) {
		containerEl.createDiv({ text: 'Add at least one model to a provider to pin.', cls: 'crucible-empty-state' });
		return;
	}

	const allProviders = tab.plugin.settings.providers;
	const pinned = binding.pinned;

	// idh-WP-2: an agent binds to a model it will chat-complete against, so both dropdowns below
	// are filtered to chat-capable providers/models (modelHasCapability, never a raw
	// capabilities?.includes('chat') — see that function's doc comment for the undefined-means-
	// chat-only legacy trap). A saved selection that no longer qualifies (its model was toggled
	// off Chat, or was the provider's only chat-capable model and lost it) is never silently
	// dropped from the dropdown or cleared from settings — it stays offered, marked
	// "(not chat-capable)", exactly mirroring describeRerankModel's still-in-use-but-unmarked
	// precedent (orchestration.ts).
	const selectedProvider = allProviders.find(p => p.id === pinned.providerId);
	const chatCapableProviders = allProviders.filter(p => providerHasChatCapableModel(p));
	const providerOptions = selectedProvider && !providerHasChatCapableModel(selectedProvider)
		? [...chatCapableProviders, selectedProvider]
		: chatCapableProviders;

	new Setting(containerEl)
		.setName('Provider')
		.addDropdown(d => {
			if (!pinned.providerId || !selectedProvider) {
				d.addOption('', 'Select a provider...');
			}
			providerOptions.forEach(p => {
				const label = p.name || `(unnamed ${p.kind})`;
				d.addOption(p.id, providerHasChatCapableModel(p) ? label : `${label} (not chat-capable)`);
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
	const selectedModel = models.find(m => m.id === pinned.modelId);
	const chatCapableModels = models.filter(m => modelHasCapability(m, 'chat'));
	const modelOptions = selectedModel && !modelHasCapability(selectedModel, 'chat')
		? [...chatCapableModels, selectedModel]
		: chatCapableModels;

	new Setting(containerEl)
		.setName('Model')
		.addDropdown(d => {
			if (models.length === 0) {
				d.addOption('', 'No models on this provider');
			} else if (modelOptions.length === 0) {
				d.addOption('', 'No chat-capable models on this provider');
			} else {
				if (!pinned.modelId || !selectedModel) {
					d.addOption('', 'Select a model...');
				}
				modelOptions.forEach(m => {
					const label = m.label || m.id;
					d.addOption(m.id, modelHasCapability(m, 'chat') ? label : `${label} (not chat-capable)`);
				});
			}
			d.setValue(pinned.modelId)
			 .onChange(async (v) => {
				 pinned.modelId = v;
				 await tab.plugin.saveSettings();
			 });
			d.selectEl.addClass('pi-width-normal');
		});
}

function renderConstrainedBindingEditor(
	tab: CrucibleSettingTab,
	containerEl: HTMLElement,
	binding: Extract<AgentModelBinding, { mode: 'constrained' }>,
	hasAnyModels: boolean,
): void {
	containerEl.createEl('hr', { cls: 'crucible-row-divider' });

	if (!hasAnyModels) {
		containerEl.createDiv({ text: 'Add at least one model to a provider to populate the allowlist.', cls: 'crucible-empty-state' });
		return;
	}

	const allProviders = tab.plugin.settings.providers;
	const allow = binding.allow;

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
				? `${provider.name || provider.kind} · ${model.label || model.id}${modelHasCapability(model, 'chat') ? '' : ' (not chat-capable)'}`
				: `${ref.providerId}:${ref.modelId} (missing)`;
			new Setting(list)
				.setName(label)
				.addExtraButton(cb => cb.setIcon('trash').setTooltip('Remove').onClick(async () => {
					if (!(await confirmDestructive(tab.app, tab.plugin.settings, 'constrained-binding-model-delete', {
						message: `Remove "${label}" from the allowed models list?`,
					}))) return;
					allow.splice(allowIndex, 1);
					await tab.plugin.saveSettings();
					tab.display();
				}));
		});
	}

	// idh-WP-2: only chat-capable models are offered to add — a non-chat model (or a provider
	// with none) simply never appears here, same filter as the pinned dropdowns above.
	const addable = collectAllRefs(allProviders).filter(ref => {
		if (allow.some(a => a.providerId === ref.providerId && a.modelId === ref.modelId)) return false;
		const refProvider = allProviders.find(p => p.id === ref.providerId);
		const refModel = refProvider?.models?.find(m => m.id === ref.modelId);
		return !!refModel && modelHasCapability(refModel, 'chat');
	});

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
					d.addOption(formatModelRef(ref), label);
				});
				d.onChange((v) => {
					const picked = parseModelRef(v);
					pendingProvider = picked?.providerId ?? '';
					pendingModel = picked?.modelId ?? '';
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
}

function renderRuntimeBindingEditor(containerEl: HTMLElement): void {
	containerEl.createEl('hr', { cls: 'crucible-row-divider' });
	containerEl.createEl('p', {
		text: 'When invoked, this agent will open a picker showing every configured (provider, model) pair. Chain steps may bypass the picker via the model arg.',
		cls: 'mod-muted',
	});
}
