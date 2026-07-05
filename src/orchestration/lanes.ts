import type { JobLane, JobPriority } from './types';

export const LANE_RANK: Record<JobLane, number> = {
	user: 0,
	background: 1,
};

export function laneRank(lane: JobLane): number {
	return LANE_RANK[lane];
}

export function defaultLaneForPriority(priority: JobPriority | undefined): JobLane {
	return priority === 'high' ? 'user' : 'background';
}

export function parseLane(value: unknown, priority: JobPriority): JobLane {
	return value === 'user' || value === 'background' ? value : defaultLaneForPriority(priority);
}
