import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { ensureChannelAboutNote } from '../utils/youtubeApi';

// One job per channel: find-or-fetch-write the channel's about.md. With
// params.force the note is re-fetched and overwritten even when present; with
// params.maxAgeMs a present-and-fresh note is left untouched (no API call).
export class YoutubeChannelEnrichWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const params = job.params ?? {};
		const channelId = typeof params.channelId === 'string' ? params.channelId.trim() : '';
		if (!channelId) {
			return { status: 'failed', error: 'Missing params.channelId' };
		}
		const force = params.force === true;
		const maxAgeMs = typeof params.maxAgeMs === 'number' ? params.maxAgeMs : undefined;

		const result = await ensureChannelAboutNote(plugin, channelId, { force, maxAgeMs });
		switch (result.status) {
			case 'created':
				return { status: 'done', outputPaths: [result.aboutPath], notes: `Created about.md for ${channelId}` };
			case 'updated':
				return { status: 'done', outputPaths: [result.aboutPath], notes: `Updated about.md for ${channelId}` };
			case 'skipped':
				return { status: 'done', outputPaths: [result.aboutPath], notes: `about.md still fresh for ${channelId}` };
			case 'no-channel-id':
				return { status: 'failed', error: `No channel id for ${channelId}` };
			case 'no-api-key':
				return { status: 'failed', error: 'YouTube Data API key not configured.' };
		}
	}
}
