import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { computeChannelControlRows } from '../../ingestion/data/channels';
import { channelAboutAgeMs } from '../utils/youtubeApi';

const DAY_MS = 86_400_000;
// Spacing for the enqueue burst. Each enqueue writes a job file and emits a
// queue-updated event that kicks the drain, so firing hundreds back-to-back
// stampedes Obsidian's frontmatter processing and the autorun loop. Yield in
// small chunks so the drain (and metadata cache) keep pace and the queue can't
// wedge under a first-run sweep across every known channel.
const ENQUEUE_CHUNK = 10;
const ENQUEUE_CHUNK_PAUSE_MS = 200;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Coordinator job: enumerate every channel known to the vault and enqueue a
// per-channel youtube_channel_enrich job. Channels whose about.md is already
// present and younger than maxAgeMs are skipped up front (unless params.force),
// so steady-state sweeps stay cheap instead of enqueuing one job per channel
// only for each to no-op. Dedupe (by channelId) keeps repeat sweeps from piling
// up.
export class YoutubeChannelEnrichSweepWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const force = job.params?.force === true;
		const maxAgeDays = Math.max(0, plugin.settings.orchestrationYoutubeChannelEnrichMaxAgeDays);
		const maxAgeMs = maxAgeDays > 0 ? maxAgeDays * DAY_MS : 0;

		const rows = await computeChannelControlRows(plugin.app, plugin);
		let enqueued = 0;
		let skipped = 0;
		let pendingInChunk = 0;
		for (const row of rows) {
			if (!row.channelId) continue;
			// Mirror the per-channel job's freshness check here so a fresh about.md
			// doesn't even cost an enqueue + drain cycle.
			if (!force && maxAgeMs > 0 && row.aboutFile && channelAboutAgeMs(plugin.app, row.aboutFile) < maxAgeMs) {
				skipped++;
				continue;
			}
			const enqueuedJob = await plugin.orchestrator.enqueue('youtube_channel_enrich', {
				channelId: row.channelId,
				force,
				maxAgeMs,
			}, { priority: 'normal', lane: 'background' });
			if (enqueuedJob) enqueued++;
			if (++pendingInChunk >= ENQUEUE_CHUNK) {
				pendingInChunk = 0;
				await sleep(ENQUEUE_CHUNK_PAUSE_MS);
			}
		}

		return {
			status: 'done',
			notes: `Enqueued ${enqueued} channel enrichment job(s) from ${rows.length} known channel(s) (${skipped} already fresh).`,
		};
	}
}
