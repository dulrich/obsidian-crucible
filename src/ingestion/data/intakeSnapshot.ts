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
import { blogMetadataRoot, buildBlogMetadataNoteIndex } from '../../orchestration/utils/blogsApi';
import { findExistingChannelAboutNote, findExistingMetadataNote, parseIso8601Duration } from '../../orchestration/utils/youtubeApi';
import { loadIgnoredBlogIds, loadIgnoredVideoIds } from '../../orchestration/utils/ignoredIds';
import { stringList } from '../../frontmatterValues';
import type { IgnoredPostRow, IgnoredVideoRow, UncapturedPostRow, UncapturedVideoRow } from '../render/types';

// WP-R4: one canonical scan/join skeleton per feed source (blogs, YouTube), shared by the
// Uncaptured and Ignored dashboard sections. `computeBlogIntakeRows`/`computeYoutubeIntakeRows`
// each run the config-load / host-map / metadata-index-or-root / seen-set / tracker-scan /
// metadata-join sequence exactly ONCE, then partition the joined items into the two existing
// public row shapes (src/ingestion/data/uncaptured.ts, src/ingestion/data/ignored.ts — both
// now thin projections of one of these two functions) using one explicit policy: an item's id
// is in the ignored set, or it isn't.
//
// The seen set built here deliberately does NOT fold the ignored ids in — unlike a plain
// "what's new" scan, folding them in would make an ignored-but-still-present item vanish from
// scan.outcomes before the partition ever sees it, which is exactly the data the ignored
// projection needs to join a full row. Filtering ignored ids OUT of the uncaptured projection
// after the fact is equivalent to excluding them at seen-set time (the tracker-scan dedupe is a
// stable first-occurrence-per-id fold that doesn't reorder), so both projections stay
// byte-identical to the pre-WP-R4 two-scan implementation — see
// tests/ingestionIgnoredRows.test.mjs for the pinned parity and
// tests/ingestionIntakeSnapshotSeam.test.mjs for the one-scan-pass proof.
//
// An ignored id that never appears in any scanned run (aged out of tracker retention) degrades
// to a bare-ID row instead of being dropped, so Un-ignore always has something to act on. This
// module owns no dashboard/UI wiring.

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

// Reads the blog-metadata-note fields joined onto both blog row shapes.
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

// Reads the video length from an enrichment metadata note's frontmatter. Prefers the
// pre-parsed `duration_seconds`; falls back to parsing the raw ISO-8601 `duration` (e.g.
// PT20M4S). Returns null when unavailable.
function readDurationSeconds(app: App, enrichmentFile: TFile | null): number | null {
	if (!enrichmentFile) return null;
	const fm: Record<string, unknown> = app.metadataCache.getFileCache(enrichmentFile)?.frontmatter ?? {};
	const secs = fm['duration_seconds'];
	if (typeof secs === 'number' && Number.isFinite(secs)) return secs;
	const raw = fm['duration'];
	return typeof raw === 'string' ? parseIso8601Duration(raw) : null;
}

export interface BlogIntakeRows {
	uncaptured: UncapturedPostRow[];
	ignored: IgnoredPostRow[];
}

export interface YoutubeIntakeRows {
	uncaptured: UncapturedVideoRow[];
	ignored: IgnoredVideoRow[];
}

// Blog posts seen in tracker runs, partitioned into "not yet captured" and "ignored" rows
// from ONE scan/metadata-join pass. computeUncapturedPostRows/computeIgnoredPostRows
// (../uncaptured.ts / ../ignored.ts) each project one half of this result.
export async function computeBlogIntakeRows(app: App, plugin: CruciblePlugin): Promise<BlogIntakeRows> {
	const ignored = await loadIgnoredBlogIds(app);
	const configured = await loadConfiguredBlogs(app, plugin);
	const hostRules = buildBlogCanonHostMap(Array.from(configured.values(), v => v.blog));
	const metadataRoot = blogMetadataRoot(plugin);
	const metadataIndex = await buildBlogMetadataNoteIndex(app, metadataRoot);
	const seen = buildBlogsSeenIdSet(app, false, undefined, hostRules, feedSeenExtraSkipPrefixes(plugin, BLOGS_FEED_SOURCE));
	const scan = await scanBlogsTrackerRuns(app, seen, configured);

	const uncaptured: UncapturedPostRow[] = [];
	const ignoredFound = new Map<string, IgnoredPostRow>();
	for (const outcome of scan.outcomes) {
		for (const post of outcome.newPosts) {
			const metadataFile = metadataIndex.get(post.postId) ?? null;
			const metadata = readBlogMetadata(app, metadataFile);
			const title = metadata.title ?? post.title;
			const publishedAt = metadata.publishedAt ?? post.publishedAt;
			const url = metadata.url ?? post.url;
			const kind = metadata.kind ?? post.kind;
			const wordCount = metadata.wordCount ?? post.wordCount;
			const hasBody = metadata.hasBody ?? post.hasBody;

			if (ignored.has(post.postId)) {
				ignoredFound.set(post.postId, {
					id: post.postId,
					title,
					blogName: outcome.blog.name,
					publishedAt,
					url,
					kind,
					wordCount,
					hasBody,
					metadataFile,
				});
				continue;
			}

			uncaptured.push({
				postId: post.postId,
				blogName: outcome.blog.name,
				blogLink: outcome.blog.link,
				title,
				publishedAt,
				url,
				authors: metadata.authors ?? post.authors,
				categories: metadata.categories ?? post.categories,
				wordCount,
				kind,
				hasBody,
				metadataFile,
				...(metadata.audioUrl || post.audioUrl ? { audioUrl: metadata.audioUrl ?? post.audioUrl } : {}),
			});
		}
	}

	return {
		uncaptured,
		ignored: Array.from(ignored, id => ignoredFound.get(id) ?? degradeIgnoredPostRow(id)),
	};
}

function degradeIgnoredPostRow(id: string): IgnoredPostRow {
	return { id, title: null, blogName: null, publishedAt: null, url: null, kind: null, wordCount: null, hasBody: false, metadataFile: null };
}

// YouTube videos seen in tracker runs, partitioned into "not yet captured" and "ignored"
// rows from ONE scan/metadata-join pass — same shape as computeBlogIntakeRows above.
export async function computeYoutubeIntakeRows(app: App, plugin: CruciblePlugin): Promise<YoutubeIntakeRows> {
	const ignored = await loadIgnoredVideoIds(app);
	const configured = await loadConfiguredChannels(app, plugin);
	const seen = buildYoutubeSeenIdSet(app, false, undefined, feedSeenExtraSkipPrefixes(plugin, YOUTUBE_FEED_SOURCE));
	const scan = await scanYoutubeTrackerRuns(app, seen, configured);
	const root = plugin.settings.orchestrationYoutubeMetadataRoot || '_yt_metadata';

	const uncaptured: UncapturedVideoRow[] = [];
	const ignoredFound = new Map<string, IgnoredVideoRow>();
	for (const outcome of scan.outcomes) {
		const channelAboutFile = findExistingChannelAboutNote(app, root, outcome.channel.channelId);
		for (const video of outcome.newVideos) {
			const enrichmentFile = await findExistingMetadataNote(app, root, video.videoId);
			const durationSeconds = readDurationSeconds(app, enrichmentFile);

			if (ignored.has(video.videoId)) {
				ignoredFound.set(video.videoId, {
					id: video.videoId,
					title: video.title,
					channelName: outcome.channel.name,
					publishedAt: video.publishedAt,
					url: video.url,
					durationSeconds,
					channelAboutFile,
					enrichmentFile,
				});
				continue;
			}

			uncaptured.push({
				videoId: video.videoId,
				channelName: outcome.channel.name,
				channelId: outcome.channel.channelId,
				channelAboutFile,
				title: video.title,
				publishedAt: video.publishedAt,
				url: video.url,
				durationSeconds,
				enrichmentFile,
			});
		}
	}

	return {
		uncaptured,
		ignored: Array.from(ignored, id => ignoredFound.get(id) ?? degradeIgnoredVideoRow(id)),
	};
}

function degradeIgnoredVideoRow(id: string): IgnoredVideoRow {
	return { id, title: null, channelName: null, publishedAt: null, url: null, durationSeconds: null, channelAboutFile: null, enrichmentFile: null };
}
