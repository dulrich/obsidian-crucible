import { App, TFile } from 'obsidian';
import type CruciblePlugin from '../../main';
import {
	buildBlogsSeenIdSet,
	loadConfiguredBlogs,
	scanBlogsTrackerRuns,
} from '../../orchestration/utils/blogsIntake';
import {
	buildYoutubeSeenIdSet,
	loadConfiguredChannels,
	scanYoutubeTrackerRuns,
} from '../../orchestration/utils/youtubeIntake';
import { coerceVideoId, findExistingMetadataNote, parseIso8601Duration } from '../../orchestration/utils/youtubeApi';
import { loadIgnoredBlogIds, loadIgnoredVideoIds } from '../../orchestration/utils/ignoredIds';
import type { UncapturedPostRow, UncapturedVideoRow, YoutubeNoMetadataRow } from '../render/types';

// Blog posts seen in tracker runs but not yet captured as a vault note.
export async function computeUncapturedPostRows(app: App, plugin: CruciblePlugin): Promise<UncapturedPostRow[]> {
	const seen = buildBlogsSeenIdSet(app, false, await loadIgnoredBlogIds(app));
	const configured = await loadConfiguredBlogs(app, plugin);
	const scan = await scanBlogsTrackerRuns(app, seen, configured);

	const rows: UncapturedPostRow[] = [];
	for (const outcome of scan.outcomes) {
		for (const post of outcome.newPosts) {
			rows.push({
				postId: post.postId,
				blogName: outcome.blog.name,
				blogLink: outcome.blog.link,
				title: post.title,
				publishedAt: post.publishedAt,
				url: post.url,
			});
		}
	}
	return rows;
}

// YouTube videos seen in tracker runs but not yet captured as a vault note,
// each annotated with its enrichment metadata note (if any) and duration.
export async function computeUncapturedVideoRows(app: App, plugin: CruciblePlugin): Promise<UncapturedVideoRow[]> {
	const seen = buildYoutubeSeenIdSet(app, false, await loadIgnoredVideoIds(app));
	const configured = await loadConfiguredChannels(app, plugin);
	const scan = await scanYoutubeTrackerRuns(app, seen, configured);
	const root = plugin.settings.orchestrationYoutubeMetadataRoot || '_yt_metadata';

	const out: UncapturedVideoRow[] = [];
	for (const outcome of scan.outcomes) {
		for (const video of outcome.newVideos) {
			const enrichmentFile = await findExistingMetadataNote(app, root, video.videoId);
			out.push({
				videoId: video.videoId,
				channelName: outcome.channel.name,
				channelId: outcome.channel.channelId,
				title: video.title,
				publishedAt: video.publishedAt,
				url: video.url,
				durationSeconds: readDurationSeconds(app, enrichmentFile),
				enrichmentFile,
			});
		}
	}
	return out;
}

// Reads the video length from an enrichment metadata note's frontmatter.
// Prefers the pre-parsed `duration_seconds`; falls back to parsing the raw
// ISO-8601 `duration` (e.g. PT20M4S). Returns null when unavailable.
function readDurationSeconds(app: App, enrichmentFile: TFile | null): number | null {
	if (!enrichmentFile) return null;
	const fm: Record<string, unknown> = app.metadataCache.getFileCache(enrichmentFile)?.frontmatter ?? {};
	const secs = fm['duration_seconds'];
	if (typeof secs === 'number' && Number.isFinite(secs)) return secs;
	const raw = fm['duration'];
	return typeof raw === 'string' ? parseIso8601Duration(raw) : null;
}

// Scans every markdown note for the backlog: a usable `yt-video-id` in
// frontmatter with no `yt-metadata` link yet. Keying on `yt-video-id` matches
// the "fetch video metadata for active note" command.
export function computeYoutubeNoMetadataRows(app: App): YoutubeNoMetadataRow[] {
	const out: YoutubeNoMetadataRow[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		const videoId = coerceVideoId(fm['yt-video-id']);
		if (!videoId) continue;
		if (isYtMetadataLinked(fm['yt-metadata'])) continue;
		const createdRaw: unknown = fm['created'];
		const created = typeof createdRaw === 'string' ? Date.parse(createdRaw) || file.stat.ctime : file.stat.ctime;
		out.push({ file, title: file.basename, created, videoId });
	}
	return out;
}

// True when `yt-metadata` already carries a link (a non-empty string, or an
// array with at least one non-empty entry). Such notes are excluded from the
// backlog.
function isYtMetadataLinked(value: unknown): boolean {
	if (typeof value === 'string') return value.trim().length > 0;
	if (Array.isArray(value)) return value.some(v => typeof v === 'string' && v.trim().length > 0);
	return false;
}
