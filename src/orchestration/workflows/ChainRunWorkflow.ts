import { TFile } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';

// Runs a named Chain on a target note via the unified queue. This is how a user
// Trigger whose action is a chain executes: the trigger seeds a `chain_run` job with
// { chainName, targetPath }, and chain execution itself takes the note lock / honors
// `mutating`, so no extra locking is needed here.
export class ChainRunWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const params = job.params ?? {};
		const chainName = typeof params.chainName === 'string' ? params.chainName : '';
		if (!chainName) {
			return { status: 'failed', error: 'Missing params.chainName' };
		}

		const chain = plugin.settings.chains.find(c => c.name === chainName);
		if (!chain) {
			return {
				status: 'failed',
				error: `Chain "${chainName}" is not configured. Add it under Settings → Automate → Chains.`,
			};
		}

		const targetPath = typeof params.targetPath === 'string' ? params.targetPath : '';
		let file: TFile | undefined;
		if (targetPath) {
			const found = plugin.app.vault.getAbstractFileByPath(targetPath);
			if (!(found instanceof TFile)) {
				return { status: 'failed', error: `Target note not found: ${targetPath}` };
			}
			file = found;
		}

		// Same shape as TranscriptRefinerWorkflow: ChainManager has no signal, so the
		// only place a cancellation can still prevent work is before the chain starts.
		// Note the catch below turns everything into `failed` — including an abort that
		// unwinds out of a chain step — which is exactly why `applyCancellation`
		// rewrites `failed` to `cancelled` when the signal has fired.
		ctx.throwIfAborted();

		try {
			await plugin.chainManager.executeChain(chain, undefined, file);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return { status: 'failed', error: `Chain execution failed: ${message}` };
		}

		return {
			status: 'done',
			outputPaths: file ? [file.path] : [],
			notes: `Ran chain "${chainName}"${file ? ` on ${file.path}` : ''}`,
		};
	}
}
