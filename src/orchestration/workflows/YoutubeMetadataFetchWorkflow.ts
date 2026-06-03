import { TFile } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { coerceVideoId, enrichYoutubeMetadataStandalone, ingestYoutubeVideoMetadata } from '../utils/youtubeApi';

// Fetches a YouTube video's metadata via the Data API and saves the metadata note.
// With params.targetPath it links `yt-metadata` back onto that note (the per-note
// command path); without one it runs standalone (the enrichment path for videos
// not yet captured as a vault note). Both share this single executor so the type
// can live entirely in the unified queue's memory path.
export class YoutubeMetadataFetchWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const params = job.params ?? {};
		const targetPath = typeof params.targetPath === 'string' ? params.targetPath : '';
		const paramVideoId = typeof params.videoId === 'string' ? params.videoId.trim() : '';

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
	}

	private toResult(
		result: Awaited<ReturnType<typeof ingestYoutubeVideoMetadata>>,
		label: string,
	): WorkflowResult {
		switch (result.status) {
			case 'created':
				return { status: 'done', outputPaths: [result.metadataPath], notes: `Created metadata for ${label}${this.fanout(result.linkedNotes)}` };
			case 'exists':
				return { status: 'done', outputPaths: [result.metadataPath], notes: `Linked existing metadata for ${label}${this.fanout(result.linkedNotes)}` };
			case 'no-video-id':
				return { status: 'failed', error: `No video id for ${label}` };
			case 'no-api-key':
				return { status: 'failed', error: 'YouTube Data API key not configured.' };
		}
	}

	// Notes when the single fetch linked more than just the triggering note (other
	// captures sharing the same yt-video-id were linked in the same pass).
	private fanout(linkedNotes: number): string {
		return linkedNotes > 1 ? ` (+${linkedNotes - 1} duplicate note${linkedNotes - 1 === 1 ? '' : 's'})` : '';
	}
}
