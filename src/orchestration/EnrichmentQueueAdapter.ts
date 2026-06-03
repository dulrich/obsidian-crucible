import { TFile } from 'obsidian';
import type CruciblePlugin from '../main';
import type { MemoryJobEntry, MemoryJobQueue, MemoryJobSeed } from './MemoryJobQueue';
import type { JobType } from './types';

// The YouTube-metadata job type runs in the unified queue's in-memory path. This
// adapter is the thin, video-shaped surface the ingestion dashboard talks to; it
// translates between EnrichmentQueueItem/Entry and the generic MemoryJobQueue that
// the Orchestrator owns. (Replaces the old standalone EnrichmentQueueService.)
const ENRICHMENT_JOB_TYPE: JobType = 'youtube_metadata_fetch';

export type EnrichmentItemStatus = 'pending' | 'running' | 'done' | 'failed';

export interface EnrichmentQueueItem {
	videoId: string;
	title: string;
	channelName: string;
	sourceFile?: TFile;
}

export interface EnrichmentQueueEntry extends EnrichmentQueueItem {
	status: EnrichmentItemStatus;
	error?: string;
	addedAt: number;
}

export type AutoSourceFn = () => EnrichmentQueueItem[];

export class EnrichmentQueueAdapter {
	constructor(private readonly plugin: CruciblePlugin) {}

	private get queue(): MemoryJobQueue | null {
		return this.plugin.orchestrator.getMemoryQueue(ENRICHMENT_JOB_TYPE);
	}

	dispose(): void {
		this.queue?.setAutoSource(null);
	}

	setAutoSource(fn: AutoSourceFn | null): void {
		this.queue?.setAutoSource(fn ? () => fn().map(itemToSeed) : null);
	}

	setAutoEnabled(enabled: boolean): void {
		this.queue?.setAutoEnabled(enabled);
	}

	isAutoEnabled(): boolean {
		return this.queue?.isAutoEnabled() ?? false;
	}

	enqueue(item: EnrichmentQueueItem): boolean {
		const queue = this.queue;
		if (!queue || !item.videoId) return false;
		return queue.enqueue(item.videoId, itemToParams(item), { title: item.title, channelName: item.channelName });
	}

	dequeueIfPending(videoId: string): boolean {
		return this.queue?.dequeueIfPending(videoId) ?? false;
	}

	getEntry(videoId: string): EnrichmentQueueEntry | null {
		const entry = this.queue?.getEntry(videoId);
		return entry ? toEnrichmentEntry(entry) : null;
	}

	getSnapshot(): EnrichmentQueueEntry[] {
		return (this.queue?.snapshot() ?? []).map(toEnrichmentEntry);
	}

	getPendingCount(): number {
		return this.queue?.getPendingCount() ?? 0;
	}

	// Maps each in-flight metadata job's target note path to its display status, so
	// the "captures without metadata" section can show queued/running badges.
	metadataInFlightByPath(): Map<string, 'queued' | 'running'> {
		const map = new Map<string, 'queued' | 'running'>();
		const queue = this.queue;
		if (!queue) return map;
		for (const entry of queue.snapshot()) {
			if (entry.status !== 'pending' && entry.status !== 'running') continue;
			const path = typeof entry.params.targetPath === 'string' ? entry.params.targetPath : '';
			if (path && !map.has(path)) map.set(path, entry.status === 'running' ? 'running' : 'queued');
		}
		return map;
	}
}

function itemToParams(item: EnrichmentQueueItem): Record<string, unknown> {
	const params: Record<string, unknown> = {
		videoId: item.videoId,
		title: item.title,
		channelName: item.channelName,
	};
	// A sourceFile means "link the metadata back onto this note"; without one the
	// workflow falls back to standalone enrichment (no link write).
	if (item.sourceFile) params.targetPath = item.sourceFile.path;
	return params;
}

function itemToSeed(item: EnrichmentQueueItem): MemoryJobSeed {
	return {
		key: item.videoId,
		params: itemToParams(item),
		display: { title: item.title, channelName: item.channelName },
	};
}

function toEnrichmentEntry(entry: MemoryJobEntry): EnrichmentQueueEntry {
	return {
		videoId: entry.key,
		title: typeof entry.display.title === 'string' ? entry.display.title : '',
		channelName: typeof entry.display.channelName === 'string' ? entry.display.channelName : '',
		status: entry.status,
		error: entry.error,
		addedAt: entry.addedAt,
	};
}
