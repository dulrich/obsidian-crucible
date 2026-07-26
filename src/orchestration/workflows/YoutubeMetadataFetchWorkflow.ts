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

// One job per note. With params.targetPath it links the video's metadata note onto
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
				return this.toResult(result, paramVideoId);
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
			return this.toResult(result, targetPath);
		} catch (e) {
			// The Data API itself is down/throttled — a service-level deferral, not a
			// per-job failure. See the class doc on YoutubeApiUnavailableError.
			if (e instanceof YoutubeApiUnavailableError) return youtubeApiDeferredResult(e);
			throw e;
		}
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
