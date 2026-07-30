import type CruciblePlugin from '../../main';
import { ENRICHMENT_JOB_TYPE } from '../../orchestration/jobTypeConfig';

/**
 * Live in-flight state for `youtube_metadata_fetch`, in the two shapes the dashboard
 * asks for: by target note (the "captures without metadata" badges) and by video id
 * (the Uncaptured Videos "Enriched?" cell).
 *
 * This replaces `EnrichmentQueueAdapter.metadataInFlightByPath()` /
 * `.getEntry(videoId)` (thq WP-8). The adapter existed to translate the in-memory
 * `MemoryJobQueue`'s entries into a video-shaped view; with metadata fetches durable in
 * the jobs DB they are ordinary jobs, so the whole translation layer collapses to one
 * query plus this pair of indexes. Two consequences worth knowing:
 *
 *  * **One query for both maps.** The old adapter walked the queue snapshot separately
 *    per caller; both callers here take the same `listTypeJobs` result, so a render pass
 *    that needs both pays for one.
 *  * **Standalone vs per-note is a params distinction, not a key-prefix one.** The
 *    memory queue encoded it in the entry key (`video:<id>` vs `note:<path>`) and the
 *    adapter's `getEntry` looked up the `video:` form directly. The equivalent fact on a
 *    job is simply "no `targetPath`", which is what `youtubeMetadataDedupeKey` derives
 *    that key from in the first place — so this reads the cause rather than the effect.
 */
export interface MetadataFetchStatus {
	/** Target note path → display status, for jobs that carry a `targetPath`. */
	byPath: Map<string, 'queued' | 'running'>;
	/** Video id → display status, for STANDALONE jobs only (no `targetPath`). A video
	 * already captured as a note is tracked by path, not by id. */
	byStandaloneVideoId: Map<string, 'queued' | 'running'>;
}

export function emptyMetadataFetchStatus(): MetadataFetchStatus {
	return { byPath: new Map(), byStandaloneVideoId: new Map() };
}

export async function computeMetadataFetchStatus(plugin: CruciblePlugin): Promise<MetadataFetchStatus> {
	const status = emptyMetadataFetchStatus();
	const orchestrator = plugin.orchestrator;
	if (!orchestrator) return status;
	// Running first so a job that is running wins over a queued job for the same key —
	// `listTypeJobs` returns the statuses in the order asked for, and the `has` guards
	// below keep the first writer.
	const jobs = await orchestrator.listTypeJobs(ENRICHMENT_JOB_TYPE, ['running', 'queued']);
	for (const job of jobs) {
		const display = job.status === 'running' ? 'running' : 'queued';
		const targetPath = typeof job.params?.targetPath === 'string' ? job.params.targetPath : '';
		if (targetPath) {
			if (!status.byPath.has(targetPath)) status.byPath.set(targetPath, display);
			continue;
		}
		const videoId = typeof job.params?.videoId === 'string' ? job.params.videoId : '';
		if (videoId && !status.byStandaloneVideoId.has(videoId)) status.byStandaloneVideoId.set(videoId, display);
	}
	return status;
}
