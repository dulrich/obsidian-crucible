import type CruciblePlugin from '../main';
import type { JobTypeConfig } from './jobTypeConfig';
import type { OrchestrationEnqueueOptions, OrchestrationJob, WorkflowResult } from './types';
import type { Workflow } from './workflows/Workflow';

export type RunOutcome = 'ran' | 'empty' | 'disabled';

/**
 * One persistence strategy for a registered job type. `FileJobBackend` (durable,
 * markdown-backed) and `MemoryJobBackend` (transient, in-memory) implement this so
 * the Orchestrator and the autorun drain dispatch to a backend instead of branching
 * on `config.persistence` in every method.
 */
export interface JobBackend {
	/** True when the type drains even with the autorun toggle off (memory types). */
	readonly drainsWithoutAutorun: boolean;
	/** Enqueue a job; returns the (real or synthetic) job, or null if rejected. */
	enqueue(params: Record<string, unknown>, options?: OrchestrationEnqueueOptions): Promise<OrchestrationJob | null>;
	/** Claim and run at most one job, reporting the outcome to the drain loop. */
	runNext(): Promise<RunOutcome>;
	/** Whether work is (or might be) waiting. File types answer "maybe" (always true). */
	hasPending(): boolean;
	/** Pull fresh candidates in (memory types only); no-op otherwise. */
	refill(): void;
}

// Resolves the effective per-run timeout: a per-type override if set, else the
// global autorun setting; 0 disables. Shared by both backends.
export function resolveTimeoutMs(plugin: CruciblePlugin, config: JobTypeConfig): number {
	if (typeof config.timeoutMs === 'number') return Math.max(0, config.timeoutMs);
	return Math.max(0, plugin.settings.orchestrationAutorunTimeoutSeconds) * 1000;
}

// Bounds a workflow run by `timeoutMs`. On timeout the race rejects and the caller
// marks the job failed; the abandoned workflow promise keeps running in the
// background (no AbortController), but any note-lock it holds is scoped to a leaf
// operation and releases when that operation settles.
export async function runWorkflowWithTimeout(
	plugin: CruciblePlugin,
	workflow: Workflow,
	job: OrchestrationJob,
	timeoutMs: number,
): Promise<WorkflowResult> {
	if (timeoutMs <= 0) return workflow.run(job, { plugin });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
	});
	try {
		return await Promise.race([workflow.run(job, { plugin }), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
