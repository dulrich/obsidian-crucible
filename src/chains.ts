import { App, Modal, Notice, Editor, TFile } from 'obsidian';
import { AgentResult, Chain, ChainStep, CommandArgSchema } from './types';
import { appendDebugLog } from './utils';
import { NoteLockManager, withOptionalNoteLock } from './orchestration/NoteLockManager';

export type ChainCommandFn = (args: Record<string, string>, previousResponse: unknown, editor?: Editor, targetFile?: TFile) => Promise<unknown>;

export class ChainManager {
	app: App;
	private registry: Map<string, ChainCommandFn> = new Map();
	private schemas: Map<string, CommandArgSchema[]> = new Map();
	// Chains currently on the execution stack, keyed by chain → set of target note
	// paths. A nested chain step that re-enters a chain already running *on the same
	// note* (self-reference, or an indirect cycle A→B→A) is detected here and skipped,
	// so an awaited nested invocation can't recurse without bound. Keying by note (not
	// the chain alone) lets the same chain run concurrently on different notes — e.g. a
	// queued transcript_refine on note A and a manual run on note B.
	private executing = new Map<Chain, Set<string>>();

	constructor(app: App, private noteLocks?: NoteLockManager) {
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

	async executeInternalCommand(id: string, args: Record<string, string> = {}, prev: unknown = null, editor?: Editor, targetFile?: TFile): Promise<unknown> {
		const fn = this.registry.get(id);
		if (fn) return await fn(args, prev, editor, targetFile);
		return null;
	}

	async executeChain(chain: Chain, editor?: Editor, spawnFile?: TFile) {
		const chainVars: Record<string, string> = { ...(chain.variables ?? {}) };
		// Use the file captured at invocation time; fall back to current only if not provided.
		const targetFile = spawnFile ?? this.app.workspace.getActiveFile() ?? undefined;
		if (targetFile) chainVars.target_path = targetFile.path;

		// Cycle guard keyed by chain + target note: re-entering the same chain on the
		// same note (a true cycle) is skipped, but the same chain on a different note runs.
		const noteKey = targetFile?.path ?? '';
		const activePaths = this.executing.get(chain);
		if (activePaths?.has(noteKey)) {
			new Notice(`Chain "${chain.name}" is already running; skipping nested call to avoid a cycle.`);
			return;
		}

		new Notice(`Starting chain: ${chain.name}`);

		const paths = activePaths ?? new Set<string>();
		paths.add(noteKey);
		this.executing.set(chain, paths);
		try {
			const run = () => this.runChainSteps(chain, chainVars, editor, targetFile);
			// Read-only chains (mutating === false) just run; mutating chains serialize
			// against other Crucible commands on the same note via the note lock.
			if (targetFile && chain.mutating !== false) {
				await withOptionalNoteLock(this.noteLocks, targetFile.path, `chain:${chain.name}`, run);
			} else {
				await run();
			}
		} finally {
			paths.delete(noteKey);
			if (paths.size === 0) this.executing.delete(chain);
		}
	}

	private async runChainSteps(
		chain: Chain,
		chainVars: Record<string, string>,
		editor?: Editor,
		targetFile?: TFile,
	): Promise<void> {
		let previousResponse: unknown = null;
		for (const step of chain.steps) {
			const stepLabel = step.stepType === 'guard' ? 'guard' : step.commandId;
			try {
				const result = await this.executeStep(step, previousResponse, chainVars, editor, targetFile);

				// Unwrap AgentResult: expose {{response}}, {{agent_model}}, {{agent_provider}} as chain vars
				if (result !== null && typeof result === 'object' && 'response' in result && 'model' in result) {
					const agentResult = result as AgentResult;
					chainVars.agent_model = agentResult.model;
					if (agentResult.provider) chainVars.agent_provider = agentResult.provider;
					previousResponse = agentResult.response;
				} else {
					previousResponse = result;
				}

				if (chain.debugMode) {
					const inputSummary = JSON.stringify(step.args).slice(0, 200);
					const outputSummary = typeof previousResponse === 'string'
						? previousResponse.slice(0, 500)
						: JSON.stringify(previousResponse);
					await this.appendDebugLog(chain, `[${stepLabel}]\nInput: ${inputSummary}\nOutput: ${outputSummary}\n`);
				}

				if (step.captureIntermediate && typeof previousResponse === 'string') {
					const name = stepLabel.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
					await this.writeIntermediateCapture(name, previousResponse);
				}

				if (previousResponse === false && !step.keepGoing) {
					new Notice(`Chain "${chain.name}" stopped at step "${stepLabel}"`);
					return;
				}
			} catch (e) {
				if (chain.debugMode) {
					await this.appendDebugLog(chain, `[${stepLabel}] ERROR: ${(e as Error).message}\n`);
				}
				new Notice(`Chain "${chain.name}" failed at step "${stepLabel}": ${(e as Error).message}`);
				if (!step.keepGoing) return;
			}
		}

		new Notice(`Chain "${chain.name}" completed`);
	}

	private async appendDebugLog(chain: Chain, entry: string) {
		await appendDebugLog(this.app, chain.name, entry, chain.debugLogPath || '_crucible/debug.md');
	}

	private async writeIntermediateCapture(stepName: string, content: string) {
		const path = `_crucible/step-${stepName}-output.md`;
		const existing = this.app.vault.getFileByPath(path);
		if (existing) {
			await this.app.vault.modify(existing, content);
		} else {
			if (!this.app.vault.getFolderByPath('_crucible')) {
				await this.app.vault.createFolder('_crucible');
			}
			await this.app.vault.create(path, content);
		}
	}

	private async executeStep(step: ChainStep, previousResponse: unknown, chainVars: Record<string, string>, editor?: Editor, targetFile?: TFile): Promise<unknown> {
		// Guard step: evaluate condition against target file
		if (step.stepType === 'guard') {
			return this.evaluateGuard(step, chainVars, targetFile);
		}

		const internalFn = this.registry.get(step.commandId);

		// Handle legacy string args or missing args
		const rawArgs = typeof step.args === 'string' ? { _default: step.args } : (step.args || {});
		const processedArgs: Record<string, string> = {};

		const respStr = previousResponse !== null && previousResponse !== undefined
			? (typeof previousResponse === 'string' ? previousResponse : JSON.stringify(previousResponse))
			: '';

		for (const [key, value] of Object.entries(rawArgs)) {
			let v = value;
			// Apply {{response}} substitution
			if (respStr) v = v.replace(/{{response}}/g, respStr);
			// Apply chain variables
			for (const [varName, varValue] of Object.entries(chainVars)) {
				v = v.replace(new RegExp(`{{${varName}}}`, 'g'), varValue);
			}
			processedArgs[key] = v;
		}

		if (internalFn) {
			return await internalFn(processedArgs, previousResponse, editor, targetFile);
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

	private evaluateGuard(step: ChainStep, _chainVars: Record<string, string>, targetFile?: TFile): boolean {
		const condition = step.guardCondition;
		if (!condition) return true;

		const file = targetFile ?? this.app.workspace.getActiveFile();
		if (!file) return false;

		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter ?? {};
		const tags: string[] = [];
		const rawTags: unknown = fm.tags;
		if (Array.isArray(rawTags)) {
			tags.push(...rawTags.map((t: string) => t.replace(/^#/, '')));
		} else if (typeof rawTags === 'string') {
			tags.push(rawTags.replace(/^#/, ''));
		}
		// Also include inline tags from cache
		if (cache?.tags) {
			cache.tags.forEach(t => tags.push(t.tag.replace(/^#/, '')));
		}

		switch (condition.type) {
			case 'has-tag':
				return condition.tag ? tags.includes(condition.tag.replace(/^#/, '')) : false;
			case 'not-has-tag':
				return condition.tag ? !tags.includes(condition.tag.replace(/^#/, '')) : true;
			case 'has-property':
				return condition.property ? condition.property in fm : false;
			case 'not-has-property':
				return condition.property ? !(condition.property in fm) : true;
			case 'property-equals':
				return condition.property
					? String(fm[condition.property] ?? '') === (condition.value ?? '')
					: false;
			default:
				return true;
		}
	}

	previewChain(chain: Chain) {
		const chainVars: Record<string, string> = { ...(chain.variables ?? {}) };
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile) chainVars.target_path = activeFile.path;

		const lines: string[] = [];
		chain.steps.forEach((step, i) => {
			lines.push(`### Step ${i + 1} — ${step.stepType === 'guard' ? 'Guard' : step.commandId}`);
			if (step.stepType === 'guard' && step.guardCondition) {
				const gc = step.guardCondition;
				lines.push(`Condition: ${gc.type} ${gc.tag ?? gc.property ?? ''} ${gc.value ?? ''}`);
			} else {
				const rawArgs = typeof step.args === 'string' ? { _default: step.args } : (step.args || {});
				for (const [key, value] of Object.entries(rawArgs)) {
					let v = value;
					for (const [varName, varValue] of Object.entries(chainVars)) {
						v = v.replace(new RegExp(`{{${varName}}}`, 'g'), varValue);
					}
					lines.push(`**${key}:** \`${v}\``);
				}
				const schema = this.getCommandSchema(step.commandId);
				if (!schema && Object.keys(rawArgs).length === 0) lines.push('*(no args)*');
			}
			lines.push('');
		});

		new ChainInspectorModal(this.app, chain.name, lines.join('\n')).open();
	}
}

class ChainInspectorModal extends Modal {
	private title: string;
	private content: string;

	constructor(app: App, title: string, content: string) {
		super(app);
		this.title = title;
		this.content = content;
	}

	onOpen() {
		this.titleEl.setText(`Preview: ${this.title}`);
		this.contentEl.createEl('p', { text: 'Showing resolved arguments. No API calls will be made.', cls: 'mod-muted' });
		this.contentEl.createEl('pre', { text: this.content, cls: 'crucible-inspector-pre' });
	}

	onClose() { this.contentEl.empty(); }
}
