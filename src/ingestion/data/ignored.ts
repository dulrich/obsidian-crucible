import { App } from 'obsidian';
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
import { findExistingChannelAboutNote, findExistingMetadataNote } from '../../orchestration/utils/youtubeApi';
import { loadIgnoredBlogIds, loadIgnoredVideoIds } from '../../orchestration/utils/ignoredIds';
import { readBlogMetadata, readDurationSeconds } from './uncaptured';
import type { IgnoredPostRow, IgnoredVideoRow } from '../render/types';

// Ignored blog posts row-compute (WP-IC2). Mirrors computeUncapturedPostRows'
// scan+metadata-join shape (../data/uncaptured.ts — see its comments for the
// underlying mechanism), with one deliberate difference: the seen set here is
// built WITHOUT folding the ignored ids in (`buildBlogsSeenIdSet(app, false,
// undefined, ...)`), because the whole point is to surface ignored items that
// are still present in tracker run data — folding the ignored ids into the seen
// set (what computeUncapturedPostRows does) is exactly what makes those items
// vanish from scan.outcomes over there. computeUncapturedPostRows itself is not
// touched by this file. An ignored id absent from every outcome (aged out of
// tracker retention) degrades to a bare-ID row rather than being dropped, so
// Un-ignore always has something to act on.
export async function computeIgnoredPostRows(app: App, plugin: CruciblePlugin): Promise<IgnoredPostRow[]> {
	const ignored = await loadIgnoredBlogIds(app);
	const configured = await loadConfiguredBlogs(app, plugin);
	const hostRules = buildBlogCanonHostMap(Array.from(configured.values(), v => v.blog));
	const metadataRoot = blogMetadataRoot(plugin);
	const metadataIndex = await buildBlogMetadataNoteIndex(app, metadataRoot);
	const seen = buildBlogsSeenIdSet(app, false, undefined, hostRules, feedSeenExtraSkipPrefixes(plugin, BLOGS_FEED_SOURCE));
	const scan = await scanBlogsTrackerRuns(app, seen, configured);

	const found = new Map<string, IgnoredPostRow>();
	for (const outcome of scan.outcomes) {
		for (const post of outcome.newPosts) {
			if (!ignored.has(post.postId)) continue;
			const metadataFile = metadataIndex.get(post.postId) ?? null;
			const metadata = readBlogMetadata(app, metadataFile);
			found.set(post.postId, {
				id: post.postId,
				title: metadata.title ?? post.title,
				blogName: outcome.blog.name,
				publishedAt: metadata.publishedAt ?? post.publishedAt,
				url: metadata.url ?? post.url,
				kind: metadata.kind ?? post.kind,
				wordCount: metadata.wordCount ?? post.wordCount,
				metadataFile,
			});
		}
	}

	return Array.from(ignored, id => found.get(id) ?? degradeIgnoredPostRow(id));
}

function degradeIgnoredPostRow(id: string): IgnoredPostRow {
	return { id, title: null, blogName: null, publishedAt: null, url: null, kind: null, wordCount: null, metadataFile: null };
}

// Ignored YouTube videos row-compute (WP-IC2) — same recipe as
// computeIgnoredPostRows above, mirroring computeUncapturedVideoRows'
// scan+metadata-join shape. computeUncapturedVideoRows itself is not touched.
export async function computeIgnoredVideoRows(app: App, plugin: CruciblePlugin): Promise<IgnoredVideoRow[]> {
	const ignored = await loadIgnoredVideoIds(app);
	const configured = await loadConfiguredChannels(app, plugin);
	const seen = buildYoutubeSeenIdSet(app, false, undefined, feedSeenExtraSkipPrefixes(plugin, YOUTUBE_FEED_SOURCE));
	const scan = await scanYoutubeTrackerRuns(app, seen, configured);
	const root = plugin.settings.orchestrationYoutubeMetadataRoot || '_yt_metadata';

	const found = new Map<string, IgnoredVideoRow>();
	for (const outcome of scan.outcomes) {
		const channelAboutFile = findExistingChannelAboutNote(app, root, outcome.channel.channelId);
		for (const video of outcome.newVideos) {
			if (!ignored.has(video.videoId)) continue;
			const enrichmentFile = await findExistingMetadataNote(app, root, video.videoId);
			found.set(video.videoId, {
				id: video.videoId,
				title: video.title,
				channelName: outcome.channel.name,
				publishedAt: video.publishedAt,
				url: video.url,
				durationSeconds: readDurationSeconds(app, enrichmentFile),
				channelAboutFile,
				enrichmentFile,
			});
		}
	}

	return Array.from(ignored, id => found.get(id) ?? degradeIgnoredVideoRow(id));
}

function degradeIgnoredVideoRow(id: string): IgnoredVideoRow {
	return { id, title: null, channelName: null, publishedAt: null, url: null, durationSeconds: null, channelAboutFile: null, enrichmentFile: null };
}
