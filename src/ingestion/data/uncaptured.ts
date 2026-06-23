import { App, TFile } from 'obsidian';
import type CruciblePlugin from '../../main';
import {
	buildBlogsSeenIdSet,
	buildYoutubeSeenIdSet,
	feedSeenExtraSkipPrefixes,
	loadConfiguredBlogs,
	loadConfiguredChannels,
	scanBlogsTrackerRuns,
	scanYoutubeTrackerRuns,
} from '../../orchestration/utils/feedIntake';
import { BLOGS_FEED_SOURCE, YOUTUBE_FEED_SOURCE } from '../../orchestration/utils/feedSources';
import { buildBlogCanonHostMap } from '../../orchestration/utils/blogs';
import { blogMetadataRoot, findExistingBlogMetadataNote } from '../../orchestration/utils/blogsApi';
import { coerceVideoId, findExistingMetadataNote, parseIso8601Duration } from '../../orchestration/utils/youtubeApi';
import { loadIgnoredBlogIds, loadIgnoredVideoIds } from '../../orchestration/utils/ignoredIds';
import type { UncapturedPostRow, UncapturedVideoRow, YoutubeNoMetadataRow } from '../render/types';

// Blog posts seen in tracker runs but not yet captured as a vault note.
export async function computeUncapturedPostRows(app: App, plugin: CruciblePlugin): Promise<UncapturedPostRow[]> {
	const configured = await loadConfiguredBlogs(app, plugin);
	const hostRules = buildBlogCanonHostMap(Array.from(configured.values(), v => v.blog));
	const metadataRoot = blogMetadataRoot(plugin);
	const seen = buildBlogsSeenIdSet(app, false, await loadIgnoredBlogIds(app), hostRules, feedSeenExtraSkipPrefixes(plugin, BLOGS_FEED_SOURCE));
	const scan = await scanBlogsTrackerRuns(app, seen, configured);

	const rows: UncapturedPostRow[] = [];
	for (const outcome of scan.outcomes) {
		for (const post of outcome.newPosts) {
			const metadataFile = await findExistingBlogMetadataNote(app, metadataRoot, post.postId);
			const metadata = readBlogMetadata(app, metadataFile);
			rows.push({
				postId: post.postId,
				blogName: outcome.blog.name,
				blogLink: outcome.blog.link,
				title: metadata.title ?? post.title,
				publishedAt: metadata.publishedAt ?? post.publishedAt,
				url: metadata.url ?? post.url,
				authors: metadata.authors ?? post.authors,
				categories: metadata.categories ?? post.categories,
				wordCount: metadata.wordCount ?? post.wordCount,
				kind: metadata.kind ?? post.kind,
				hasBody: metadata.hasBody ?? post.hasBody,
				metadataFile,
				...(metadata.audioUrl || post.audioUrl ? { audioUrl: metadata.audioUrl ?? post.audioUrl } : {}),
			});
		}
	}
	return rows;
}

interface BlogMetadataFields {
	title?: string;
	url?: string;
	authors?: string[];
	categories?: string[];
	publishedAt?: string;
	wordCount?: number | null;
	kind?: 'article' | 'podcast';
	hasBody?: boolean;
	audioUrl?: string;
}

function readBlogMetadata(app: App, file: TFile | null): BlogMetadataFields {
	if (!file) return {};
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	if (!fm) return {};
	const kind = fm.kind === 'podcast' ? 'podcast' : fm.kind === 'article' ? 'article' : undefined;
	const hasBody = typeof fm['has-body'] === 'boolean' ? fm['has-body'] : undefined;
	return {
		title: typeof fm.title === 'string' ? fm.title : undefined,
		url: typeof fm.source === 'string' ? fm.source : undefined,
		authors: stringList(fm.authors),
		categories: stringList(fm.categories),
		publishedAt: typeof fm.published === 'string' ? fm.published : undefined,
		wordCount: typeof fm['word-count'] === 'number' ? fm['word-count'] : null,
		kind,
		hasBody,
		audioUrl: typeof fm.audio_url === 'string' ? fm.audio_url : undefined,
	};
}

function stringList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const out = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
		return out.length > 0 ? out : undefined;
	}
	if (typeof value === 'string' && value.trim()) return [value.trim()];
	return undefined;
}

// YouTube videos seen in tracker runs but not yet captured as a vault note,
// each annotated with its enrichment metadata note (if any) and duration.
export async function computeUncapturedVideoRows(app: App, plugin: CruciblePlugin): Promise<UncapturedVideoRow[]> {
	const seen = buildYoutubeSeenIdSet(app, false, await loadIgnoredVideoIds(app), feedSeenExtraSkipPrefixes(plugin, YOUTUBE_FEED_SOURCE));
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
// the "fetch video metadata for active note" command. Captures whose video id
// has been ignored (e.g. the video was deleted/unavailable) are dropped from the
// backlog — the note stays in the vault, but it no longer nags for enrichment.
export async function computeYoutubeNoMetadataRows(app: App): Promise<YoutubeNoMetadataRow[]> {
	const ignored = await loadIgnoredVideoIds(app);
	const out: YoutubeNoMetadataRow[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		const videoId = coerceVideoId(fm['yt-video-id']);
		if (!videoId) continue;
		if (ignored.has(videoId)) continue;
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
