import type CruciblePlugin from '../../main';
import {
	ChannelEntry,
	EXAMPLE_CHANNELS_TABLE,
	RemoteVideo,
	extractVideoIdFromUrl,
	fetchChannelFeed,
	parseChannelsTable,
} from './youtube';
import {
	BlogEntry,
	EXAMPLE_BLOGS_TABLE,
	RemotePost,
	fetchBlogFeed,
	parseBlogsTable,
	postIdFromUrl,
} from './blogs';

export type FeedKind = 'youtube' | 'blogs';
export type FeedPriority = 'high' | 'normal' | 'low';

export interface FeedRowError {
	name: string;
	link: string;
	method: string;
	reason: string;
}

export interface ParsedFeedRegistry<Entry> {
	entries: Entry[];
	rowErrors: FeedRowError[];
}

export interface FeedSource<Entry, Item> {
	kind: FeedKind;
	intakeRoot: string;
	queueScanSkipPrefix: string;
	trackerGeneratedBy: string;
	consolidateGeneratedBy: string;
	exampleTable: string;
	registryPath(plugin: CruciblePlugin): string;
	parseRegistry(content: string): ParsedFeedRegistry<Entry>;
	fetchFeed(entry: Entry): Promise<Item[]>;
	entryKey(entry: Entry): string;
	entryName(entry: Entry): string;
	entryPriority(entry: Entry): FeedPriority;
	entryHeading(entry: Entry): string;
	parseHeading(line: string): Entry | null;
	itemId(item: Item): string;
	itemTitle(item: Item): string;
	itemUrl(item: Item): string;
	itemPublishedAt(item: Item): string;
	itemFromBullet(line: string, entryName: string): Item | null;
	isSeen(item: Item, seen: Set<string>): boolean;
	ingestFrontmatterIds(fm: Record<string, unknown>, seen: Set<string>, diffMode: boolean, inIntake: boolean): void;
	detectSourceId(value: unknown): string | null;
	fmIdKey: string;
	fmIdsKey: string;
	totalFmKey: string;
	withNewFmKey: string;
	itemsTotalFmKey: string;
	failedFmKey: string;
	itemIdsFmKey: string;
	emptyConfiguredText: string;
	noNewText: string;
	titlePrefix: string;
	failedHeading: string;
	missingRegistryNoun: string;
	entryPluralTitle: string;
	itemPluralTitle: string;
	itemPluralLower: string;
	noRegularRunsNote: string;
	noMissingFromRunsNote(runsScanned: number): string;
	consolidateNotes(runsScanned: number, itemsSeenInRuns: number, totalNew: number): string;
	allFeedsFailedError(total: number): string;
	noNewSkipNote: string;
	summaryParts(entryCount: number, failedCount: number, totalNew: number, rowErrors: number): string[];
	statFromFrontmatter(file: unknown, fm: Record<string, unknown>, generatedBy: string): Record<string, unknown>;
}

export const YOUTUBE_FEED_SOURCE: FeedSource<ChannelEntry, RemoteVideo> = {
	kind: 'youtube',
	intakeRoot: '_crucible/orchestration/youtube/new-videos',
	queueScanSkipPrefix: '_crucible/orchestration/',
	trackerGeneratedBy: 'orchestrator/youtube_tracker',
	consolidateGeneratedBy: 'orchestrator/youtube_tracker_consolidate',
	exampleTable: EXAMPLE_CHANNELS_TABLE,
	registryPath: plugin => plugin.settings.orchestrationYoutubeChannelsNote,
	parseRegistry: content => ({ entries: parseChannelsTable(content), rowErrors: [] }),
	fetchFeed: entry => fetchChannelFeed(entry.channelId),
	entryKey: entry => entry.channelId,
	entryName: entry => entry.name,
	entryPriority: entry => entry.priority,
	entryHeading: entry => `${entry.name} (${entry.channelId})`,
	parseHeading: parseChannelHeading,
	itemId: item => item.videoId,
	itemTitle: item => item.title,
	itemUrl: item => item.url,
	itemPublishedAt: item => item.publishedAt,
	itemFromBullet: parseVideoBullet,
	isSeen: (item, seen) => seen.has(item.videoId),
	ingestFrontmatterIds: (fm, seen, diffMode, inIntake) => {
		ingestVideoIdProperty(fm['yt-video-id'], seen, false);
		ingestVideoIdProperty(fm['source'], seen, true);
		if (diffMode && inIntake) ingestVideoIdProperty(fm['yt-video-ids'], seen, false);
	},
	detectSourceId: firstYoutubeUrlId,
	fmIdKey: 'yt-video-id',
	fmIdsKey: 'yt-video-ids',
	totalFmKey: 'channels_total',
	withNewFmKey: 'channels_with_new',
	itemsTotalFmKey: 'videos_total',
	failedFmKey: 'channels_failed',
	itemIdsFmKey: 'yt-video-ids',
	emptyConfiguredText: '_No channels configured._',
	noNewText: '_No new videos across all channels._',
	titlePrefix: 'YouTube intake',
	failedHeading: 'Failed channels',
	missingRegistryNoun: 'channels',
	entryPluralTitle: 'Channels',
	itemPluralTitle: 'Videos',
	itemPluralLower: 'videos',
	noRegularRunsNote: 'No regular YouTube tracker intake runs found; consolidated intake file not written.',
	noMissingFromRunsNote: runsScanned => `No videos from ${runsScanned} regular YouTube tracker run(s) are missing from the vault; consolidated intake file not written.`,
	consolidateNotes: (runsScanned, itemsSeenInRuns, totalNew) => `Runs scanned: ${runsScanned}; Videos in runs: ${itemsSeenInRuns}; Still missing: ${totalNew}`,
	allFeedsFailedError: total => `All ${total} channel feeds failed to fetch.`,
	noNewSkipNote: 'No new videos; intake file not written (set "Write empty intake files" to keep an audit trail).',
	summaryParts: (entryCount, failedCount, totalNew) => [
		`Channels: ${entryCount} (${failedCount} failed)`,
		`New videos: ${totalNew}`,
	],
	statFromFrontmatter: (file, fm, generatedBy) => ({
		file,
		runAt: stringOf(fm['run_at']) ?? '',
		channelsTotal: numberOf(fm['channels_total']),
		channelsWithNew: numberOf(fm['channels_with_new']),
		videosTotal: numberOf(fm['videos_total']),
		channelsFailed: numberOf(fm['channels_failed']),
		generatedBy,
	}),
};

export const BLOGS_FEED_SOURCE: FeedSource<BlogEntry, RemotePost> = {
	kind: 'blogs',
	intakeRoot: '_crucible/orchestration/blogs/new-posts',
	queueScanSkipPrefix: '_crucible/orchestration/',
	trackerGeneratedBy: 'orchestrator/blogs_tracker',
	consolidateGeneratedBy: 'orchestrator/blogs_tracker_consolidate',
	exampleTable: EXAMPLE_BLOGS_TABLE,
	registryPath: plugin => plugin.settings.orchestrationBlogsNote,
	parseRegistry: content => {
		const parsed = parseBlogsTable(content);
		return { entries: parsed.entries, rowErrors: parsed.errors };
	},
	fetchFeed: fetchBlogFeed,
	entryKey: entry => entry.link,
	entryName: entry => entry.name,
	entryPriority: entry => entry.priority,
	entryHeading: entry => `${entry.name} (${entry.link})`,
	parseHeading: parseBlogHeading,
	itemId: item => item.postId,
	itemTitle: item => item.title,
	itemUrl: item => item.url,
	itemPublishedAt: item => item.publishedAt,
	itemFromBullet: parsePostBullet,
	isSeen: isSeenPost,
	ingestFrontmatterIds: (fm, seen, diffMode, inIntake) => {
		ingestStringProperty(fm['post-id'], seen);
		ingestSourceProperty(fm['source'], seen);
		if (diffMode && inIntake) ingestStringProperty(fm['post-ids'], seen);
	},
	detectSourceId: firstBlogUrlId,
	fmIdKey: 'post-id',
	fmIdsKey: 'post-ids',
	totalFmKey: 'blogs_total',
	withNewFmKey: 'blogs_with_new',
	itemsTotalFmKey: 'posts_total',
	failedFmKey: 'blogs_failed',
	itemIdsFmKey: 'post-ids',
	emptyConfiguredText: '_No blogs configured._',
	noNewText: '_No new posts across all blogs._',
	titlePrefix: 'Blogs intake',
	failedHeading: 'Failed blogs',
	missingRegistryNoun: 'blogs',
	entryPluralTitle: 'Blogs',
	itemPluralTitle: 'Posts',
	itemPluralLower: 'posts',
	noRegularRunsNote: 'No regular Blogs tracker intake runs found; consolidated intake file not written.',
	noMissingFromRunsNote: runsScanned => `No posts from ${runsScanned} regular Blogs tracker run(s) are missing from the vault; consolidated intake file not written.`,
	consolidateNotes: (runsScanned, itemsSeenInRuns, totalNew) => `Runs scanned: ${runsScanned}; Posts in runs: ${itemsSeenInRuns}; Still missing: ${totalNew}`,
	allFeedsFailedError: total => `All ${total} blog feeds failed to fetch.`,
	noNewSkipNote: 'No new posts; intake file not written (set "Write empty intake files" to keep an audit trail).',
	summaryParts: (entryCount, failedCount, totalNew, rowErrors) => {
		const parts = [
			`Blogs: ${entryCount} (${failedCount} failed)`,
			`New posts: ${totalNew}`,
		];
		if (rowErrors > 0) parts.push(`Skipped rows: ${rowErrors}`);
		return parts;
	},
	statFromFrontmatter: (file, fm, generatedBy) => ({
		file,
		runAt: stringOf(fm['run_at']) ?? '',
		blogsTotal: numberOf(fm['blogs_total']),
		blogsWithNew: numberOf(fm['blogs_with_new']),
		postsTotal: numberOf(fm['posts_total']),
		blogsFailed: numberOf(fm['blogs_failed']),
		rowsSkipped: numberOf(fm['rows_skipped']),
		generatedBy,
	}),
};

export function isSeenPost(post: RemotePost, seen: Set<string>): boolean {
	if (seen.has(post.postId)) return true;
	if (post.url && seen.has(post.url)) return true;
	if (post.url && seen.has(postIdFromUrl(post.url))) return true;
	return false;
}

export function yamlScalar(value: string): string {
	if (/^[A-Za-z0-9_./:?=&%+#~@!$()-]+$/.test(value) && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) {
		return value;
	}
	const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	return `"${escaped}"`;
}

export function stringOf(value: unknown): string | null {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed ? trimmed : null;
	}
	return null;
}

export function numberOf(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return 0;
}

function parseChannelHeading(line: string): ChannelEntry | null {
	const match = line.match(/^##\s+(.+)\s+\((UC[A-Za-z0-9_-]+)\)\s*$/);
	const name = match?.[1]?.trim();
	const channelId = match?.[2]?.trim();
	if (!name || !channelId) return null;
	return { name, channelId, tags: [], priority: 'normal' };
}

function parseVideoBullet(line: string, channelName: string): RemoteVideo | null {
	const match = line.match(/^- \*\*(.*)\*\* — published ([^—]+) — (https?:\/\/\S+)/);
	const rawTitle = match?.[1]?.trim();
	const publishedAt = match?.[2]?.trim();
	const url = match?.[3]?.trim();
	if (!rawTitle || !publishedAt || !url) return null;
	const videoId = extractVideoIdFromUrl(url);
	if (!videoId) return null;
	return {
		videoId,
		title: unescapeBrackets(rawTitle),
		publishedAt,
		channelName,
		url,
	};
}

function parseBlogHeading(line: string): BlogEntry | null {
	const match = line.match(/^##\s+(.+)\s+\((https?:\/\/[^)]+)\)\s*$/);
	const name = match?.[1]?.trim();
	const link = match?.[2]?.trim();
	if (!name || !link) return null;
	return { name, link, method: 'rss', tags: [], priority: 'normal' };
}

function parsePostBullet(line: string, blogName: string): RemotePost | null {
	const match = line.match(/^- \*\*(.*)\*\* — published ([^—]+) — (https?:\/\/\S+)/);
	const rawTitle = match?.[1]?.trim();
	const publishedAt = match?.[2]?.trim();
	const url = match?.[3]?.trim();
	if (!rawTitle || !publishedAt || !url) return null;
	return {
		postId: postIdFromUrl(url),
		title: unescapeBrackets(rawTitle),
		publishedAt,
		blogName,
		url,
	};
}

function unescapeBrackets(text: string): string {
	return text.replace(/\\\[/g, '[').replace(/\\\]/g, ']');
}

function ingestVideoIdProperty(value: unknown, seen: Set<string>, urlMode: boolean): void {
	if (typeof value === 'string') {
		addVideoId(value, seen, urlMode);
	} else if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === 'string') addVideoId(item, seen, urlMode);
		}
	}
}

function addVideoId(value: string, seen: Set<string>, urlMode: boolean): void {
	const trimmed = value.trim();
	if (!trimmed) return;
	if (urlMode) {
		const id = extractVideoIdFromUrl(trimmed);
		if (id) seen.add(id);
	} else if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
		seen.add(trimmed);
	}
}

function ingestStringProperty(value: unknown, seen: Set<string>): void {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed) seen.add(trimmed);
	} else if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item !== 'string') continue;
			const trimmed = item.trim();
			if (trimmed) seen.add(trimmed);
		}
	}
}

function ingestSourceProperty(value: unknown, seen: Set<string>): void {
	if (typeof value === 'string') {
		addSourceUrl(value, seen);
	} else if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === 'string') addSourceUrl(item, seen);
		}
	}
}

function addSourceUrl(value: string, seen: Set<string>): void {
	const trimmed = value.trim();
	if (!trimmed || !/^https?:\/\//i.test(trimmed)) return;
	seen.add(trimmed);
	seen.add(postIdFromUrl(trimmed));
}

function firstYoutubeUrlId(value: unknown): string | null {
	return firstHttpUrlId(value, extractVideoIdFromUrl);
}

function firstBlogUrlId(value: unknown): string | null {
	return firstHttpUrlId(value, postIdFromUrl);
}

function firstHttpUrlId(value: unknown, toId: (url: string) => string | null): string | null {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed || !/^https?:\/\//i.test(trimmed)) return null;
		return toId(trimmed);
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item !== 'string') continue;
			const trimmed = item.trim();
			if (!trimmed || !/^https?:\/\//i.test(trimmed)) continue;
			const id = toId(trimmed);
			if (id) return id;
		}
	}
	return null;
}
