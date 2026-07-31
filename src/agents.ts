import { App, Notice, TFile, moment } from 'obsidian';
import { Agent, AgentResult, CrucibleSettings, Provider, ProviderCompletionResult, ProviderModelRef, CommandArgSchema, providerModality } from './types';
import { isCompleteModelRef, modelRefEquals, parseModelRef } from './providerModelContract';
import { ChainManager } from './chains';
import { CLI_DEFAULT_TIMEOUT_SECONDS, ProviderManager } from './providers';
import { applyTemplateString } from './utils';
import { ModelPickerModal, buildModelPickerOptions } from './modelPicker';

export const agentCommandId = (id: string) => `crucible:agent:${id}`;

const AGENT_INPUT_SCHEMA: CommandArgSchema[] = [
	{
		id: 'input',
		name: 'Input',
		type: 'textarea',
		description: 'Text passed to the agent. Supports {{response}} from the previous chain step.'
	},
	{
		id: 'model',
		name: 'Model override',
		type: 'text',
		description: 'Optional. Format: providerId:modelId. Supports chain variables (e.g. {{router_model}}). Overrides the agent\'s configured model.'
	},
	{
		id: 'timeout_seconds',
		name: 'Timeout seconds',
		type: 'text',
		description: `Optional. Overrides the CLI provider timeout for this run. Default is ${CLI_DEFAULT_TIMEOUT_SECONDS}. Use 600 for long transcript workflows.`
	}
];

export class AgentManager {
	app: App;
	settings: CrucibleSettings;
	chainManager: ChainManager;
	providerManager: ProviderManager;
	private registeredIds: Set<string> = new Set();

	constructor(app: App, settings: CrucibleSettings, chainManager: ChainManager, providerManager: ProviderManager) {
		this.app = app;
		this.settings = settings;
		this.chainManager = chainManager;
		this.providerManager = providerManager;
	}

	registerAgents() {
		// Clear previous registrations so renames/deletes are reflected.
		for (const id of this.registeredIds) {
			this.chainManager.unregisterInternalCommand(id);
		}
		this.registeredIds.clear();

		this.settings.agents.forEach(agent => {
			if (!agent.id) return;
			const id = agentCommandId(agent.id);
			this.chainManager.registerInternalCommand(id, async (args, _prev, _editor, targetFile) => {
				return await this.executeAgent(agent, args, targetFile);
			}, { schema: AGENT_INPUT_SCHEMA });
			this.registeredIds.add(id);
		});
	}

	getProvider(providerId: string): Provider | undefined {
		return this.settings.providers.find(p => p.id === providerId);
	}

	async executeAgent(agent: Agent, args: Record<string, string>, targetFile?: TFile): Promise<AgentResult> {
		const ref = await this.resolveModel(agent, args);
		const provider = this.getProvider(ref.providerId);
		if (!provider) {
			const msg = `Agent "${agent.name || agent.id}" references unknown provider "${ref.providerId}"`;
			new Notice(msg);
			throw new Error(msg);
		}

		const input = args.input ?? '';
		const now = moment();
		const fileName = (targetFile ?? this.app.workspace.getActiveFile())?.basename || '';

		const systemTemplate = await this.resolvePrompt(agent, 'system');
		// {{value}} and {{input}} both resolve to the runtime input, including modifier
		// suffixes like {{input:oneline}}.
		const userTemplate = (await this.resolvePrompt(agent, 'user') || '{{input}}').replace(/{{input(:[^}]*)?}}/g, '{{value$1}}');

		const system = await applyTemplateString(systemTemplate, now, fileName, input);
		const user = await applyTemplateString(userTemplate, now, fileName, input);
		const timeoutSeconds = parseTimeoutSeconds(args.timeout_seconds);

		const label = agent.name || agent.id;
		const spinner = new Notice(`Agent "${label}" is thinking...`, 0);

		try {
			const completion = await this.providerManager.complete(provider, ref.modelId, system, user, {
				timeoutSeconds,
				executionMode: agent.executionMode || 'read-only',
				agentLabel: label,
			});
			this.enforceNormalFinishReason(agent, provider, ref.modelId, completion);
			spinner.hide();
			return {
				response: completion.text,
				model: ref.modelId,
				provider: provider.id,
				finishReason: completion.finishReason,
				rawFinishReason: completion.rawFinishReason,
			};
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			spinner.hide();
			new Notice("Agent error: " + message);
			throw e instanceof Error ? e : new Error(message);
		}
	}

	private enforceNormalFinishReason(agent: Agent, provider: Provider, modelId: string, completion: ProviderCompletionResult): void {
		if (providerModality(provider.kind) !== 'api') return;
		if ((agent.requireNormalFinishReason ?? true) === false) return;
		if (completion.finishReason === 'stop') return;

		const label = agent.name || agent.id;
		const providerLabel = provider.name || provider.id;
		const rawReason = completion.rawFinishReason ?? 'missing';
		throw new Error(
			`Agent "${label}" using provider "${providerLabel}" model "${modelId}" finished with non-normal reason "${rawReason}" ` +
			`(normalized: ${completion.finishReason}; partial response length: ${completion.text.length}).`
		);
	}

	private async resolveModel(agent: Agent, args: Record<string, string>): Promise<ProviderModelRef> {
		const binding = agent.modelBinding;
		const override = parseModelRef(args.model);

		if (override) {
			if (!this.isAllowed(binding, override)) {
				throw new Error(
					`Model override "${args.model}" is not allowed by agent "${agent.name || agent.id}" (mode: ${binding.mode}).`
				);
			}
			if (!this.refExists(override)) {
				throw new Error(`Model override "${args.model}" does not match any configured provider/model.`);
			}
			return override;
		}

		if (binding.mode === 'pinned') {
			// The union guarantees the payload exists; what it deliberately does not guarantee is
			// that the user finished filling it in (see providerModelContract.ts's header).
			if (!isCompleteModelRef(binding.pinned)) {
				throw new Error(`Agent "${agent.name || agent.id}" has no pinned model configured.`);
			}
			if (!this.refExists(binding.pinned)) {
				throw new Error(`Agent "${agent.name || agent.id}" pinned model is no longer configured.`);
			}
			return binding.pinned;
		}

		// constrained or runtime → open the picker
		const options = buildModelPickerOptions(
			this.settings.providers,
			binding.mode === 'constrained' ? binding.allow : undefined,
		);

		if (options.length === 0) {
			throw new Error(
				binding.mode === 'constrained'
					? `Agent "${agent.name || agent.id}" has no allowed models configured.`
					: `No provider/model pairs are configured.`
			);
		}

		return await new Promise<ProviderModelRef>((resolve, reject) => {
			new ModelPickerModal(
				this.app,
				options,
				(ref) => resolve(ref),
				() => reject(new Error('Model selection cancelled')),
			).open();
		});
	}

	private isAllowed(binding: Agent['modelBinding'], ref: ProviderModelRef): boolean {
		if (binding.mode !== 'constrained') return true;
		return binding.allow.some(a => modelRefEquals(a, ref));
	}

	private refExists(ref: ProviderModelRef): boolean {
		const provider = this.settings.providers.find(p => p.id === ref.providerId);
		if (!provider) return false;
		return (provider.models ?? []).some(m => m.id === ref.modelId);
	}

	private async resolvePrompt(agent: Agent, kind: 'system' | 'user'): Promise<string> {
		const rawSource = kind === 'system' ? agent.systemPromptSource : agent.userPromptSource;
		const source = rawSource || 'text';
		if (source === 'file') {
			const path = kind === 'system' ? agent.systemPromptFile : agent.userPromptFile;
			if (!path) return '';
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				throw new Error(`Agent "${agent.name || agent.id}" ${kind} prompt file not found: ${path}`);
			}
			return await this.app.vault.read(file);
		}
		return (kind === 'system' ? agent.systemPromptText : agent.userPromptText) || '';
	}
}

function parseTimeoutSeconds(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;

	const seconds = Number(trimmed);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new Error(`Timeout seconds must be a positive number, got "${raw}".`);
	}
	return Math.ceil(seconds);
}
