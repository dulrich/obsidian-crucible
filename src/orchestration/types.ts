export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export type JobType =
	| 'daily_brief_lite'
	| 'youtube_tracker'
	| 'youtube_tracker_consolidate'
	| 'blogs_tracker'
	| 'blogs_tracker_consolidate'
	| 'transcript_refine'
	| 'link_scan'
	| 'youtube_metadata_fetch'
	| 'command_run'
	| 'image_metadata_extract'
	| 'search_rebuild'
	| 'search_upsert_file'
	| 'search_upsert_batch'
	| 'search_delete_path'
	| 'search_sweep';

export type JobPriority = 'low' | 'normal' | 'high';
export type JobLane = 'user' | 'background';

export interface OrchestrationEnqueueOptions {
	priority?: JobPriority;
	lane?: JobLane;
	inputPaths?: string[];
}

export interface OrchestrationJob {
	id: string;
	type: JobType;
	status: JobStatus;
	priority: JobPriority;
	lane: JobLane;
	created: string;
	updated?: string;
	inputPaths: string[];
	outputPaths: string[];
	params?: Record<string, unknown>;
	error?: string;
	progress?: string;
	deferUntil?: string;
}

export interface WorkflowResult {
	status: 'done' | 'failed' | 'deferred';
	outputPaths?: string[];
	error?: string;
	notes?: string;
	retryAfterMs?: number;
}

export interface ScanReport {
	inbox: number;
	running: number;
	done: number;
	failed: number;
	recovered: number;
}
