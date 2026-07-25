import { TFile } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';

// Runs a Crucible command as a queue job: params.commandId must resolve to a
// chain-INTERNAL command (the awaited, target-file-aware registry — see the
// chain-step quirk in AGENTS.md), so the command runs on params.targetPath under
// its own note-lock choreography instead of fire-and-forget on the active note.
// This is the contract for commands invoked by triggers/orchestration workflows:
// they get queue semantics (dedupe, timeout, pacing) for free.
export class CommandRunWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const params = job.params ?? {};

		const commandId = typeof params.commandId === 'string' ? params.commandId.trim() : '';
		if (!commandId) return { status: 'failed', error: 'Missing params.commandId' };
		if (!plugin.chainManager.hasInternalCommand(commandId)) {
			return {
				status: 'failed',
				error: `Unknown internal command: ${commandId}. Queueable commands must be registered as chain-internal commands.`,
			};
		}

		const targetPath = typeof params.targetPath === 'string' ? params.targetPath : '';
		let targetFile: TFile | undefined;
		if (targetPath) {
			const file = plugin.app.vault.getAbstractFileByPath(targetPath);
			if (!(file instanceof TFile)) return { status: 'failed', error: `Target note not found: ${targetPath}` };
			targetFile = file;
		}

		// Last point before dispatching into the internal-command registry, which has no
		// signal of its own.
		ctx.throwIfAborted();

		const args = isStringRecord(params.args) ? params.args : {};
		const result = await plugin.chainManager.executeInternalCommand(commandId, args, null, undefined, targetFile);
		if (result === false) {
			return { status: 'failed', error: `Command ${commandId} reported failure${targetPath ? ` on ${targetPath}` : ''}` };
		}
		return {
			status: 'done',
			outputPaths: targetFile ? [targetFile.path] : [],
			notes: `Ran ${commandId}${targetPath ? ` on ${targetPath}` : ''}`,
		};
	}
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	return Object.values(value).every(v => typeof v === 'string');
}
