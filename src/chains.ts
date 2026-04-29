import { App, Notice, Editor } from 'obsidian';
import { Chain, ChainStep, CommandArgSchema } from './types';

export type ChainCommandFn = (args: Record<string, string>, previousResponse: unknown, editor?: Editor) => Promise<unknown>;

export class ChainManager {
	app: App;
	private registry: Map<string, ChainCommandFn> = new Map();
	private schemas: Map<string, CommandArgSchema[]> = new Map();

	constructor(app: App) {
		this.app = app;
	}

	registerInternalCommand(id: string, fn: ChainCommandFn, schema?: CommandArgSchema[]) {
		this.registry.set(id, fn);
		if (schema) this.schemas.set(id, schema);
	}

	unregisterInternalCommand(id: string) {
		this.registry.delete(id);
		this.schemas.delete(id);
	}

	listInternalCommandIds(): string[] {
		return Array.from(this.registry.keys());
	}

	getCommandSchema(id: string): CommandArgSchema[] | undefined {
		return this.schemas.get(id);
	}

	async executeInternalCommand(id: string, args: Record<string, string> = {}, prev: unknown = null, editor?: Editor): Promise<unknown> {
		const fn = this.registry.get(id);
		if (fn) return await fn(args, prev, editor);
		return null;
	}

	async executeChain(chain: Chain, editor?: Editor) {
		let previousResponse: unknown = null;
		new Notice(`Starting chain: ${chain.name}`);

		for (const step of chain.steps) {
			try {
				const result = await this.executeStep(step, previousResponse, editor);
				previousResponse = result;
				
				if (result === false && !step.keepGoing) {
					new Notice(`Chain "${chain.name}" stopped at step "${step.commandId}"`);
					return;
				}
			} catch (e) {
				new Notice(`Chain "${chain.name}" failed at step "${step.commandId}": ${(e as Error).message}`);
				if (!step.keepGoing) return;
			}
		}

		new Notice(`Chain "${chain.name}" completed`);
	}

	private async executeStep(step: ChainStep, previousResponse: unknown, editor?: Editor): Promise<unknown> {
		const internalFn = this.registry.get(step.commandId);
		
		// Handle legacy string args or missing args
		const rawArgs = typeof step.args === 'string' ? { _default: step.args } : (step.args || {});
		const processedArgs: Record<string, string> = {};

		// Process args template for all values in the record
		if (previousResponse !== null && previousResponse !== undefined) {
			const respStr = typeof previousResponse === 'string' ? previousResponse : JSON.stringify(previousResponse);
			for (const [key, value] of Object.entries(rawArgs)) {
				processedArgs[key] = value.replace(/{{response}}/g, respStr);
			}
		} else {
			Object.assign(processedArgs, rawArgs);
		}

		if (internalFn) {
			return await internalFn(processedArgs, previousResponse, editor);
		} else {
			// External Obsidian command
			if (this.app.commands && this.app.commands.listCommands().find(c => c.id === step.commandId)) {
				this.app.commands.executeCommandById(step.commandId);
				return true;
			} else {
				throw new Error(`Command not found: ${step.commandId}`);
			}
		}
	}
}
