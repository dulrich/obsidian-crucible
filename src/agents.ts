import { App, Notice, TFile, moment } from 'obsidian';
import { Agent, CrucibleSettings, Provider, CommandArgSchema } from './types';
import { ChainManager } from './chains';
import { ProviderManager } from './providers';
import { applyTemplateString } from './utils';

export const agentCommandId = (id: string) => `crucible:agent:${id}`;

const AGENT_INPUT_SCHEMA: CommandArgSchema[] = [
	{
		id: 'input',
		name: 'Input',
		type: 'textarea',
		description: 'Text passed to the agent. Supports {{response}} from the previous chain step.'
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
			this.chainManager.registerInternalCommand(id, async (args) => {
				return await this.executeAgent(agent, args);
			}, AGENT_INPUT_SCHEMA);
			this.registeredIds.add(id);
		});
	}

	getProvider(providerId: string): Provider | undefined {
		return this.settings.providers.find(p => p.id === providerId);
	}

	async executeAgent(agent: Agent, args: Record<string, string>): Promise<string> {
		const provider = this.getProvider(agent.providerId);
		if (!provider) {
			const msg = `Agent "${agent.name || agent.id}" has no valid provider`;
			new Notice(msg);
			throw new Error(msg);
		}

		const input = args.input ?? '';
		const now = moment();
		const fileName = this.app.workspace.getActiveFile()?.basename || '';

		const systemTemplate = await this.resolvePrompt(agent, 'system');
		// {{value}} and {{input}} both resolve to the runtime input.
		const userTemplate = (await this.resolvePrompt(agent, 'user') || '{{input}}').replace(/{{input}}/g, '{{value}}');

		const system = await applyTemplateString(systemTemplate, now, fileName, input);
		const user = await applyTemplateString(userTemplate, now, fileName, input);

		new Notice(`Agent "${agent.name || agent.id}" is thinking...`);

		try {
			return await this.providerManager.complete(provider, system, user);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			new Notice("Agent error: " + message);
			throw e instanceof Error ? e : new Error(message);
		}
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
