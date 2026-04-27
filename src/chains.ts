import { App, Notice, Editor } from 'obsidian';
import { Chain, ChainStep } from './types';

export type ChainCommandFn = (args: string, previousResponse: unknown, editor?: Editor) => Promise<unknown>;

interface AppWithCommands extends App {
	commands: {
		listCommands(): { id: string, name: string }[];
		executeCommandById(id: string): void;
	};
}

export class ChainManager {
	app: App;
	private registry: Map<string, ChainCommandFn> = new Map();

	constructor(app: App) {
		this.app = app;
	}

	registerInternalCommand(id: string, fn: ChainCommandFn) {
		this.registry.set(id, fn);
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
		
		// Process args template
		let processedArgs = step.args || '';
		if (previousResponse !== null && previousResponse !== undefined) {
			const respStr = typeof previousResponse === 'string' ? previousResponse : JSON.stringify(previousResponse);
			processedArgs = processedArgs.replace(/{{response}}/g, respStr);
		}

		if (internalFn) {
			return await internalFn(processedArgs, previousResponse, editor);
		} else {
			// External Obsidian command
			const appWithCommands = this.app as AppWithCommands;
			if (appWithCommands.commands && appWithCommands.commands.listCommands().find(c => c.id === step.commandId)) {
				appWithCommands.commands.executeCommandById(step.commandId);
				return true; // We assume success for external commands as we can't track them
			} else {
				throw new Error(`Command not found: ${step.commandId}`);
			}
		}
	}
}
