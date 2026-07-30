import { TFile } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import {
	YoutubeApiUnavailableError,
	coerceVideoId,
	enrichYoutubeMetadataStandalone,
	ingestYoutubeVideoMetadata,
	youtubeApiDeferredResult,
} from '../utils/youtubeApi';

// One job per note (durable since thq WP-8 — this was the last `memory` type). With
// params.targetPath it links the video's metadata note onto
// that note — fetching via the Data API only when the metadata note doesn't exist
// yet (link-first; see ingestYoutubeVideoMetadata for the lock choreography).
// Without a targetPath it runs standalone (the enrichment path for videos not yet
// captured as a vault note): ensure the metadata note exists, no link write.
export class YoutubeMetadataFetchWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const params = job.params ?? {};
		const targetPath = typeof params.targetPath === 'string' ? params.targetPath : '';
		const paramVideoId = typeof params.videoId === 'string' ? params.videoId.trim() : '';

		try {
			// Standalone: no target note to link, just fetch + save the metadata note.
			if (!targetPath) {
				if (!paramVideoId) {
					return { status: 'failed', error: 'Missing params.videoId' };
				}
				const result = await enrichYoutubeMetadataStandalone(plugin, paramVideoId);
				return this.emitEnriched(plugin, this.toResult(result, paramVideoId), paramVideoId, '');
			}

			const file = plugin.app.vault.getAbstractFileByPath(targetPath);
			if (!(file instanceof TFile)) {
				return { status: 'failed', error: `Target note not found: ${targetPath}` };
			}

			const fmVideoId = coerceVideoId(plugin.app.metadataCache.getFileCache(file)?.frontmatter?.['yt-video-id']);
			const videoId = paramVideoId || fmVideoId;
			if (!videoId) {
				return { status: 'failed', error: `No yt-video-id on note: ${targetPath}` };
			}

			const result = await ingestYoutubeVideoMetadata(plugin, file, videoId);
			return this.emitEnriched(plugin, this.toResult(result, targetPath), videoId, targetPath);
		} catch (e) {
			// The Data API itself is down/throttled — a service-level deferral, not a
			// per-job failure. See the class doc on YoutubeApiUnavailableError.
			if (e instanceof YoutubeApiUnavailableError) return youtubeApiDeferredResult(e);
			throw e;
		}
	}

	/**
	 * Emits `metadata-enriched` for a successful run, and hands the result straight
	 * back so the call sites above stay one-liners.
	 *
	 * This emit used to live in `MemoryJobBackend.runEntry`'s done branch — the one
	 * place in the queue that knew this specific job type by name (`if (this.type !==
	 * 'youtube_metadata_fetch') return`). thq WP-8 deleted that backend, and re-homing
	 * the emit here rather than into `DbJobBackend` is the point: a generic backend
	 * should not carry a per-type event, and the workflow already holds everything the
	 * payload needs. It matches how the standalone command path has always done it
	 * (`internalCommands.ts` emits the same event after its own write).
	 *
	 * Fires only for `done` with a metadata path that resolves to a real `TFile`,
	 * exactly as the backend's version did — the dashboard's `uncapturedVideos` refresh
	 * and the `youtube-metadata-enriched` trigger both hang off it, and neither should
	 * fire for a failure.
	 */
	private emitEnriched(
		plugin: WorkflowContext['plugin'],
		result: WorkflowResult,
		videoId: string,
		targetPath: string,
	): WorkflowResult {
		if (result.status !== 'done') return result;
		const bus = plugin.ingestionEvents;
		if (!bus) return result;
		const metadataPath = result.outputPaths?.[0];
		if (!metadataPath) return result;
		const metadataFile = plugin.app.vault.getAbstractFileByPath(metadataPath);
		if (!(metadataFile instanceof TFile)) return result;
		const sourceFile = targetPath ? plugin.app.vault.getAbstractFileByPath(targetPath) : null;
		bus.emit('metadata-enriched', {
			videoId,
			metadataFile,
			sourceFile: sourceFile instanceof TFile ? sourceFile : undefined,
		});
		return result;
	}

	private toResult(
		result: Awaited<ReturnType<typeof ingestYoutubeVideoMetadata>>,
		label: string,
	): WorkflowResult {
		switch (result.status) {
			case 'created':
				return { status: 'done', outputPaths: [result.metadataPath], notes: `Created metadata for ${label}` };
			case 'exists':
				return { status: 'done', outputPaths: [result.metadataPath], notes: `Linked existing metadata for ${label}` };
			case 'no-video-id':
				return { status: 'failed', error: `No video id for ${label}` };
			case 'no-api-key':
				return { status: 'failed', error: 'YouTube Data API key not configured.', failureReason: 'no-api-key' };
		}
	}
}
