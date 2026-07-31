import { TFile } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { canonicalizeUrl } from '../utils/urlCanonicalize';
import { extractUrls } from '../utils/urlExtract';
import { findExistingXMetadataNote, xMetadataRoot } from '../utils/xApi';

// Spacing for the enqueue burst — same shape as
// YoutubeChannelEnrichSweepWorkflow: each enqueue writes a row and kicks the
// drain, so a note citing dozens of statuses shouldn't stampede it. Trivial at
// the sizes one note realistically carries, kept for the shape.
const ENQUEUE_CHUNK = 10;
const ENQUEUE_CHUNK_PAUSE_MS = 200;

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

interface DiscoveredStatus {
	statusId: string;
	url: string;
}

// One job per note: scans the note's links for X status URLs and enqueues one
// x_metadata_fetch per not-yet-materialized status, each carrying this note as
// a sourcePath so XMetadataFetchWorkflow can stamp it back. Never fetches
// oEmbed itself — that split (discover vs fetch) is what lets several notes
// citing the same status collapse onto one x_metadata_fetch job via its own
// dedupe key.
export class XPostDiscoverWorkflow implements Workflow {
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

		const content = await plugin.app.vault.cachedRead(file);
		const statuses = collectXStatuses(content);
		const root = xMetadataRoot(plugin);

		let alreadyMaterialized = 0;
		let enqueued = 0;
		let pendingInChunk = 0;
		for (const { statusId, url } of statuses) {
			// Per-status: a note can cite many statuses, and stopping here is the
			// checkpoint that matters — statuses already enqueued stay queued.
			ctx.throwIfAborted();
			const existing = await findExistingXMetadataNote(plugin.app, root, statusId);
			if (existing) {
				alreadyMaterialized++;
				continue;
			}
			// Awaited (not `.catch`'d): a real enqueue failure fails this job, so
			// the backend/user sees it rather than it being swallowed.
			await plugin.orchestrator.enqueue(
				'x_metadata_fetch',
				{ statusId, url, sourcePaths: [targetPath] },
				{ lane: 'background', inputPaths: [targetPath] },
			);
			enqueued++;
			if (++pendingInChunk >= ENQUEUE_CHUNK) {
				pendingInChunk = 0;
				await sleep(ENQUEUE_CHUNK_PAUSE_MS);
			}
		}

		return {
			status: 'done',
			notes: `Found ${statuses.length} X status(es) in ${targetPath}: `
				+ `${alreadyMaterialized} already materialized, ${enqueued} enqueued.`,
		};
	}
}

/** Unique X statuses referenced by the note's links, first-seen canonical URL wins. */
function collectXStatuses(content: string): DiscoveredStatus[] {
	const seen = new Set<string>();
	const out: DiscoveredStatus[] = [];
	for (const { raw } of extractUrls(content)) {
		const canon = canonicalizeUrl(raw);
		if (!canon?.xStatusId) continue;
		if (seen.has(canon.xStatusId)) continue;
		seen.add(canon.xStatusId);
		out.push({ statusId: canon.xStatusId, url: canon.canonical });
	}
	return out;
}
