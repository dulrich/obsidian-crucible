/* eslint-disable obsidianmd/ui/sentence-case */
import { Setting } from "obsidian";
import type { CrucibleSettingTab } from "../../settings";
import { Provider, ProviderKind, providerModality } from "../../types";
import { CLI_DEFAULT_TIMEOUT_SECONDS, providerSecretKey, resolveProviderConcurrencyLimit } from "../../providers";
import { FolderSuggest } from "../../suggesters";
import { confirmDestructive } from "../destructiveActions";
import { PROVIDER_KIND_LABELS, defaultCliCommand, mountSecretControl, sortByNameWithEmptyLast } from "../shared";
import { bindText, bindToggle, bindDropdown, bindSearch } from "../bind";
import { providerRefsPointingAt } from "../providerRefs";
import { renderProviderModelsList } from "./aiProviderModels";

/**
 * WP-rem-R4 (F4) — the provider list + provider editor half of `sections/ai.ts`'s original split.
 * Model catalog rendering (`renderProviderModelsList`) lives in the sibling `aiProviderModels.ts`;
 * this file owns provider CRUD, kind-specific connection fields, and the Delete-Provider confirm.
 */

export function renderProviderListSection(tab: CrucibleSettingTab, containerEl: HTMLElement) {
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

// idh-WP-2: deleting a provider destroys its stored API key unconditionally and can orphan up to
// five other settings surfaces (search embedding/rerank, image description, agent bindings, chain
// step overrides) — this always confirms, with an in-use summary built from
// `providerRefsPointingAt` when the provider is referenced anywhere, or a simpler API-key-only
// warning when it is not (deleting the key alone still warrants a confirm).
export async function deleteProvider(tab: CrucibleSettingTab, index: number) {
	const provider = tab.plugin.settings.providers[index];
	if (!provider) return;

	const providerLabel = provider.name || '(unnamed)';
	const refs = providerRefsPointingAt(tab.plugin.settings, provider);
	const message = refs.length > 0
		? `Its stored API key is deleted with it. This cannot be undone.`
		: `This provider is not currently used by search, agents, or chain steps. Its stored API key is deleted with it. This cannot be undone.`;
	const impact = refs.length > 0 ? [`Used by: ${refs.join(', ')}.`] : undefined;
	if (!(await confirmDestructive(tab.app, tab.plugin.settings, 'provider-delete', {
		title: `Delete provider "${providerLabel}"?`,
		message,
		impact,
	}))) return;

	tab.plugin.settings.providers.splice(index, 1);
	tab.editingProviderIndex = -1;
	await tab.plugin.saveSettings();
	await tab.plugin.providerManager.deleteApiKey(provider.id);
	// Belt-and-suspenders alongside deleteApiKey's own clear->forget: deleteApiKey no-ops the
	// forget half when app.secretStorage is unavailable (see SecretRegistry.clear), which would
	// otherwise leave this provider's key registered forever with nothing left to warn about.
	await tab.plugin.secretRegistry.forget(providerSecretKey(provider.id));
	tab.plugin.registerAgents();
	tab.display();
}

export function renderEditProvider(tab: CrucibleSettingTab, containerEl: HTMLElement, provider: Provider, index: number) {
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
		renderApiProviderConnectionFields(tab, containerEl, provider, save);
	} else {
		renderCliProviderConnectionFields(tab, containerEl, provider, save);
	}

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });
	renderMaxConcurrentRequestsSetting(containerEl, provider, save);

	containerEl.createEl('hr', { cls: 'crucible-row-divider' });
	renderProviderModelsList(tab, containerEl, provider);
}

function renderApiProviderConnectionFields(tab: CrucibleSettingTab, containerEl: HTMLElement, provider: Provider, save: () => Promise<void>) {
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
}

function renderCliProviderConnectionFields(tab: CrucibleSettingTab, containerEl: HTMLElement, provider: Provider, save: () => Promise<void>) {
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

// rsp-wp1: caps in-flight completion-class requests (chat, image description — not embed/rerank)
// for this provider, gated in ProviderManager (src/providers.ts). Blank keeps the default:
// resolveProviderConcurrencyLimit(provider) with maxConcurrentRequests cleared shows what that
// default actually resolves to for this provider's kind, rather than a hardcoded "1 or
// unlimited" guess drifting from the real resolution logic.
function renderMaxConcurrentRequestsSetting(containerEl: HTMLElement, provider: Provider, save: () => Promise<void>) {
	const defaultLimit = resolveProviderConcurrencyLimit({ ...provider, maxConcurrentRequests: undefined });
	const defaultLabel = Number.isFinite(defaultLimit) ? String(defaultLimit) : 'Unlimited';
	new Setting(containerEl)
		.setName('Max concurrent requests')
		.setDesc(
			`Blank uses the default (currently ${defaultLabel} for this provider): local providers `
			+ '(openai-compatible) default to 1 — a single-GPU local model gains no throughput from '
			+ 'concurrency, and extra in-flight requests just push each other\'s wall-clock time past '
			+ 'the timeout — while cloud providers default to unlimited. Applies to completion-class '
			+ 'requests only (chat, image description); embeddings and reranking are never limited.',
		)
		.addText(t => {
			t.setPlaceholder(defaultLabel)
				.setValue(provider.maxConcurrentRequests ? String(provider.maxConcurrentRequests) : '')
				.onChange(async (v) => {
					const trimmed = v.trim();
					if (!trimmed) {
						delete provider.maxConcurrentRequests;
						await save();
						return;
					}
					const n = Number(trimmed);
					if (Number.isFinite(n) && n > 0) {
						provider.maxConcurrentRequests = Math.floor(n);
						await save();
					}
				});
			t.inputEl.type = 'number';
			t.inputEl.min = '1';
			t.inputEl.step = '1';
			t.inputEl.addClass('pi-width-half');
		});
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
		confirm: {
			app: tab.app,
			settings: tab.plugin.settings,
			message: `Clear the stored API key for provider "${provider.name || '(unnamed)'}"? Anything using this provider will fail until a new key is set.`,
		},
	});
}
