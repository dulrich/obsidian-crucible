import { TFile } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';

export class TranscriptRefinerWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const params = job.params ?? {};
		const targetPath = typeof params.targetPath === 'string' ? params.targetPath : '';
		if (!targetPath) {
			return { status: 'failed', error: 'Missing params.targetPath' };
		}

		const file = plugin.app.vault.getAbstractFileByPath(targetPath);
		if (!(file instanceof TFile)) {
			return { status: 'failed', error: `Target note not found: ${targetPath}` };
		}

		const chainName = typeof params.agentChainName === 'string' && params.agentChainName
			? params.agentChainName
			: plugin.settings.orchestrationTranscriptRefineChainName;
		const chain = plugin.settings.chains.find(c => c.name === chainName);
		if (!chain) {
			return {
				status: 'failed',
				error: `Chain "${chainName}" is not configured. Add it under Settings → Automate → Chains.`,
			};
		}

		const leaf = plugin.app.workspace.getLeaf(false);
		await leaf.openFile(file);

		// Chain execution is the expensive part and is not itself instrumented (chain
		// steps run through ChainManager, which has no signal today), so this is the
		// last point at which a cancellation can prevent the model call rather than
		// merely be noticed after it. Once the chain starts, an abort surfaces via the
		// `failed` → `cancelled` reconciliation on the catch below.
		ctx.throwIfAborted();

		try {
			await plugin.chainManager.executeChain(chain, undefined, file);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return { status: 'failed', error: `Chain execution failed: ${message}` };
		}

		return {
			status: 'done',
			outputPaths: [file.path],
			notes: `Ran chain "${chainName}" on ${file.path}`,
		};
	}
}
