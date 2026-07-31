/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { renderProviderListSection, renderEditProvider } from "./aiProviders";
import { renderAgentListSection, renderEditAgent } from "./aiAgents";

/**
 * WP-rem-R4 (F4 remediation): the AI settings tab's entry point. Owns only the list/edit routing
 * (`editingProviderIndex`/`editingAgentIndex` on `CrucibleSettingTab` — the same pattern every
 * other collection-style tab uses); the actual renderers live in sibling modules split by owned
 * panel — see `aiProviders.ts` (provider CRUD + connection fields), `aiProviderModels.ts` (model
 * catalog, probing, per-model row editor), `aiAgents.ts` (agent CRUD + prompt editors), and
 * `aiAgentBinding.ts` (the model-binding editor, built on `providerModelContract`).
 */
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
