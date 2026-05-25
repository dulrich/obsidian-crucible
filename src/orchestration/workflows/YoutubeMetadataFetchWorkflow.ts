import { TFile } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { coerceVideoId, ingestYoutubeVideoMetadata } from '../utils/youtubeApi';

// Per-note job equivalent to the "YouTube: fetch video metadata for active note"
// command. Resolves params.targetPath to a note, fetches the video metadata via
// the YouTube Data API, and writes the `yt-metadata` link back onto the note.
export class YoutubeMetadataFetchWorkflow implements Workflow {
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

		const paramVideoId = typeof params.videoId === 'string' ? params.videoId.trim() : '';
		const fmVideoId = coerceVideoId(plugin.app.metadataCache.getFileCache(file)?.frontmatter?.['yt-video-id']);
		const videoId = paramVideoId || fmVideoId;
		if (!videoId) {
			return { status: 'failed', error: `No yt-video-id on note: ${targetPath}` };
		}

		const result = await ingestYoutubeVideoMetadata(plugin, file, videoId);
		switch (result.status) {
			case 'created':
				return { status: 'done', outputPaths: [result.metadataPath], notes: `Created metadata for ${targetPath}` };
			case 'exists':
				return { status: 'done', outputPaths: [result.metadataPath], notes: `Linked existing metadata for ${targetPath}` };
			case 'no-video-id':
				return { status: 'failed', error: `No yt-video-id on note: ${targetPath}` };
			case 'no-api-key':
				return { status: 'failed', error: 'YouTube Data API key not configured.' };
		}
	}
}
