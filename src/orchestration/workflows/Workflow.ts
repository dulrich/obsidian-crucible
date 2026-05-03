import type CruciblePlugin from '../../main';
import { OrchestrationJob, WorkflowResult } from '../types';

export interface WorkflowContext {
	plugin: CruciblePlugin;
}

export interface Workflow {
	run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult>;
}
