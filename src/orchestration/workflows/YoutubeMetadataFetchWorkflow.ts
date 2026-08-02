import { TFile } from 'obsidian';
import { Workflow, WorkflowContext } from './Workflow';
import { OrchestrationJob, WorkflowResult } from '../types';
import { YOUTUBE_REFERENCED_VIDEO_PARAM } from '../jobTypeConfig';
import { logWarn } from '../../log';
import {
	IngestResult,
	YoutubeApiUnavailableError,
	coerceVideoId,
	enrichYoutubeMetadataStandalone,
	findExistingChannelAboutNote,
	ingestYoutubeVideoMetadata,
	youtubeApiDeferredResult,
	youtubeMetadataRoot,
} from '../utils/youtubeApi';

// One job per note (durable since thq WP-8 — this was the last `memory` type). With
// params.targetPath it appends the video's metadata note onto that note's `yt-metadata`
// list — fetching via the Data API only when the metadata note doesn't exist
// yet (link-first; see ingestYoutubeVideoMetadata for the lock choreography).
// Without a targetPath it runs standalone (the enrichment path for videos not yet
// captured as a vault note): ensure the metadata note exists, no link write.
//
// A third shape sits on top of the per-note one (WP-J2): the **referenced-video** mode,
// `{targetPath, videoId, referencedVideo: true}` (mint it with `referencedVideoJobParams`),
// for a video cited in a note's BODY rather than the video the note itself captures. Its
// execution path is deliberately identical to the per-note one — `yt-metadata` is a list
// and `ingestYoutubeVideoMetadata`'s bail is per-target, so "append this video's stamp"
// is already the right primitive. The flag buys two things and nothing else: its own
// dedupe key (`note:<path>:video:<id>`, so N referenced videos on one note don't collapse
// onto each other or onto the note's primary job) and a distinguishable job label.
export class YoutubeMetadataFetchWorkflow implements Workflow {
	async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult> {
		const { plugin } = ctx;
		const params = job.params ?? {};
		const targetPath = typeof params.targetPath === 'string' ? params.targetPath : '';
		const paramVideoId = typeof params.videoId === 'string' ? params.videoId.trim() : '';
		const referenced = targetPath !== '' && paramVideoId !== '' && params[YOUTUBE_REFERENCED_VIDEO_PARAM] === true;

		try {
			// Standalone: no target note to link, just fetch + save the metadata note.
			if (!targetPath) {
				if (!paramVideoId) {
					return { status: 'failed', error: 'Missing params.videoId' };
				}
				const result = await enrichYoutubeMetadataStandalone(plugin, paramVideoId);
				const chained = await this.maybeChainChannelEnrich(plugin, result);
				return this.emitEnriched(plugin, this.toResult(plugin, result, paramVideoId, chained), paramVideoId, '');
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
			const chained = await this.maybeChainChannelEnrich(plugin, result);
			const label = referenced ? `${targetPath} (referenced video ${videoId})` : targetPath;
			return this.emitEnriched(plugin, this.toResult(plugin, result, label, chained), videoId, targetPath);
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

	/**
	 * Video → channel chaining (WP-J2). A freshly *created* metadata note is the one
	 * moment we know a channel exists and hold its id for free (`IngestResult.channelId`
	 * rides the fetch payload), so a channel with no about note yet gets one
	 * `youtube_channel_enrich` job minted here.
	 *
	 * Deliberately `created`-only. An `exists` result never called the API, so chaining
	 * there would mean re-reading the metadata note for its `channelId` and re-probing
	 * the about note on every rerun of every per-note job — noise for a channel that was
	 * already seen when its first video was materialized. `youtube_channel_enrich_sweep`
	 * is the backfill for anything this misses.
	 *
	 * Enqueue-only, and gated on `orchestrationYoutubeChannelEnrichEnabled` — the same
	 * source-enable toggle the scheduled sweep trigger reads. Whether the minted job
	 * ever *runs* stays the separate per-type auto-run axis (source-enable ≠
	 * execution-enable). The job fails typed `no-api-key` rather than deferring when no
	 * key is set; that is the channel workflow's own contract, not worked around here.
	 *
	 * A failure to enqueue never fails this job: the metadata note is already written and
	 * the chain is a bonus.
	 */
	private async maybeChainChannelEnrich(
		plugin: WorkflowContext['plugin'],
		result: IngestResult,
	): Promise<string> {
		if (result.status !== 'created') return '';
		const channelId = result.channelId.trim();
		if (!channelId) return '';
		if (!plugin.settings.orchestrationYoutubeChannelEnrichEnabled) return '';
		if (findExistingChannelAboutNote(plugin.app, youtubeMetadataRoot(plugin), channelId)) return '';

		try {
			const job = await plugin.orchestrator?.enqueue(
				'youtube_channel_enrich',
				{ channelId },
				{ priority: 'normal', lane: 'background' },
			);
			return job ? channelId : '';
		} catch (e) {
			logWarn(`failed to chain youtube_channel_enrich for channel ${channelId}`, e);
			return '';
		}
	}

	/**
	 * Maps `IngestResult` → `WorkflowResult`. `tombstoned` settles `done` — a taken-down
	 * video is a durable, successful materialization, not a failure (WP-K1, X-pipeline
	 * port) — with wording modeled on `XMetadataFetchWorkflow.outcomeNotes`. `exists`
	 * also gets the "already tombstoned" wording when the probe's find lands in the
	 * `_unavailable` folder, since a repeat job on a tombstoned video reports `exists`
	 * (the probe treats a tombstone as found, same as any other metadata note — see
	 * `ensureMetadataNote`'s doc comment).
	 */
	private toResult(
		plugin: WorkflowContext['plugin'],
		result: IngestResult,
		label: string,
		chainedChannelId: string,
	): WorkflowResult {
		const chainNote = chainedChannelId ? ` Enqueued channel enrichment for ${chainedChannelId}.` : '';
		switch (result.status) {
			case 'created':
				return { status: 'done', outputPaths: [result.metadataPath], notes: `Created metadata for ${label}${chainNote}` };
			case 'exists': {
				const unavailablePrefix = `${youtubeMetadataRoot(plugin)}/_unavailable/`;
				const notes = result.metadataPath.startsWith(unavailablePrefix)
					? `Video unavailable — already tombstoned ${label}`
					: `Linked existing metadata for ${label}`;
				return { status: 'done', outputPaths: [result.metadataPath], notes };
			}
			case 'tombstoned':
				return { status: 'done', outputPaths: [result.metadataPath], notes: `Video unavailable — tombstoned ${label}` };
			case 'no-video-id':
				return { status: 'failed', error: `No video id for ${label}` };
			case 'no-api-key':
				return { status: 'failed', error: 'YouTube Data API key not configured.', failureReason: 'no-api-key' };
		}
	}
}
