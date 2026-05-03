export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export type JobType =
	| 'daily_brief_lite'
	| 'youtube_tracker'
	| 'transcript_refine'
	| 'link_scan';

export type JobPriority = 'low' | 'normal' | 'high';

export interface OrchestrationJob {
	id: string;
	type: JobType;
	status: JobStatus;
	priority: JobPriority;
	created: string;
	updated?: string;
	inputPaths: string[];
	outputPaths: string[];
	params?: Record<string, unknown>;
	error?: string;
}

export interface WorkflowResult {
	status: 'done' | 'failed';
	outputPaths?: string[];
	error?: string;
	notes?: string;
}

export interface ScanReport {
	inbox: number;
	running: number;
	done: number;
	failed: number;
	recovered: number;
}
