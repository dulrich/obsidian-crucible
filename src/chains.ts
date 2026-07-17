import { App, MarkdownView, Modal, Notice, Editor, TFile } from 'obsidian';
import { AgentResult, Chain, ChainStep, CommandArgSchema } from './types';
import { appendDebugLog } from './utils';
import { calculateWordCount } from './lint';
import { evaluateSyncGuard, guardContext } from './triggers/guardEval';
import { NoteLockManager, withOptionalNoteLock } from './orchestration/NoteLockManager';
import { logWarn } from './log';

export type ChainCommandFn = (args: Record<string, string>, previousResponse: unknown, editor?: Editor, targetFile?: TFile) => Promise<unknown>;
export type ChainCommandLockTarget = 'target-file' | 'none';

export interface ChainCommandOptions {
	schema?: CommandArgSchema[];
	mutating?: boolean;
	lockTarget?: ChainCommandLockTarget;
	label?: string;
}

interface ChainCommandRegistration {
	fn: ChainCommandFn;
	schema?: CommandArgSchema[];
	mutating: boolean;
	lockTarget: ChainCommandLockTarget;
	label?: string;
}

export interface ChainStepResult {
	__crucibleChainStepResult: true;
	value: unknown;
	targetFile?: TFile;
}

export function chainStepResult(value: unknown, targetFile?: TFile): ChainStepResult {
	return {
		__crucibleChainStepResult: true,
		value,
		targetFile,
	};
}

function isChainStepResult(value: unknown): value is ChainStepResult {
	return typeof value === 'object'
		&& value !== null
		&& (value as Partial<ChainStepResult>).__crucibleChainStepResult === true;
}

function commandLockLabel(id: string): string {
	return `command:${id.split(':').pop() ?? id}`;
}

export class ChainManager {
	app: App;
	private registry: Map<string, ChainCommandRegistration> = new Map();
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

	registerInternalCommand(id: string, fn: ChainCommandFn, options: ChainCommandOptions = {}) {
		this.registry.set(id, {
			fn,
			schema: options.schema,
			mutating: options.mutating ?? true,
			lockTarget: options.lockTarget ?? 'target-file',
			label: options.label,
		});
		if (options.schema) this.schemas.set(id, options.schema);
	}

	unregisterInternalCommand(id: string) {
		this.registry.delete(id);
		this.schemas.delete(id);
	}

	listInternalCommandIds(): string[] {
		return Array.from(this.registry.keys());
	}

	// True when `id` resolves to an awaited, target-file-aware internal command —
	// the requirement for a command to be queueable (see CommandRunWorkflow).
	hasInternalCommand(id: string): boolean {
		return this.registry.has(id);
	}

	getCommandSchema(id: string): CommandArgSchema[] | undefined {
		return this.schemas.get(id);
	}

	async executeInternalCommand(id: string, args: Record<string, string> = {}, prev: unknown = null, editor?: Editor, targetFile?: TFile): Promise<unknown> {
		const entry = this.registry.get(id);
		if (entry) {
			const file = targetFile ?? this.app.workspace.getActiveFile() ?? undefined;
			const run = (tf?: TFile) => entry.fn(args, prev, editor, tf ?? targetFile);
			if (entry.mutating && entry.lockTarget === 'target-file' && file) {
				return await withOptionalNoteLock(this.noteLocks, file.path, entry.label ?? commandLockLabel(id), () => run(file));
			}
			return await run(targetFile);
		}
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
		let currentTargetFile = targetFile;
		for (const step of chain.steps) {
			const stepLabel = step.stepType === 'guard' ? 'guard' : step.commandId;
			try {
				let result = await this.executeStep(step, previousResponse, chainVars, editor, currentTargetFile);
				if (isChainStepResult(result)) {
					if (result.targetFile) {
						currentTargetFile = result.targetFile;
						chainVars.target_path = result.targetFile.path;
					}
					result = result.value;
				}

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

		await this.reconcileOpenEditor(currentTargetFile);
		new Notice(`Chain "${chain.name}" completed`);
	}

	// A chain that moves (renames) its target note and then mutates it on disk — e.g.
	// Ingest-as-News (move-to-daily → lint) — leaves the open editor holding a buffer
	// that never adopted the post-rename disk writes. The editor is authoritative for
	// its own autosave, so on its next save it clobbers disk with that stale buffer,
	// silently dropping the mutation (the moved note ends up without the lint's
	// word-count). Run this while the chain still holds the note lock, after the last
	// step, to force the buffer to match disk so a later autosave preserves the writes.
	private async reconcileOpenEditor(file: TFile | undefined): Promise<void> {
		if (!file) return;
		// Scan every open markdown leaf, not just the active one: the note may be open
		// in a background/unfocused leaf (e.g. the web clipper created it without focus),
		// and its stale buffer will still clobber disk on autosave.
		const leaves = this.app.workspace.getLeavesOfType('markdown');
		const views = leaves
			.map(leaf => leaf.view)
			.filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === file.path);
		if (views.length === 0) {
			logWarn('chain', 'reconcile: no open markdown view for', file.path);
			return;
		}
		const disk = await this.app.vault.read(file);
		for (const view of views) {
			if (view.getViewData() === disk) {
				logWarn('chain', 'reconcile: editor buffer already matches disk', file.path);
				continue;
			}
			logWarn('chain', 'reconciling open editor buffer to disk', file.path);
			view.setViewData(disk, false);
		}
	}

	private async appendDebugLog(chain: Chain, entry: string) {
		try {
			await appendDebugLog(this.app, chain.name, entry, chain.debugLogPath || '_crucible/debug.md');
		} catch (e) {
			logWarn('chain debug log failed', chain.name, e);
		}
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
			return await this.evaluateGuard(step, chainVars, targetFile);
		}

		const hasInternal = this.registry.has(step.commandId);

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

		if (hasInternal) {
			return await this.executeInternalCommand(step.commandId, processedArgs, previousResponse, editor, targetFile);
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

	private async evaluateGuard(step: ChainStep, _chainVars: Record<string, string>, targetFile?: TFile): Promise<boolean> {
		const condition = step.guardCondition;
		if (!condition) return true;

		const file = targetFile ?? this.app.workspace.getActiveFile();
		if (!file) return false;

		// Content-sourced (async): read the note body and count prose words.
		if (condition.type === 'word-count-lt' || condition.type === 'word-count-gt') {
			const threshold = Number(condition.value);
			if (!Number.isFinite(threshold)) return false;
			const content = await this.app.vault.cachedRead(file);
			const count = calculateWordCount(content);
			return condition.type === 'word-count-lt' ? count < threshold : count > threshold;
		}

		const cache = this.app.metadataCache.getFileCache(file);
		return evaluateSyncGuard(condition, guardContext(cache));
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
