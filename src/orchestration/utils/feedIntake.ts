import { App, TFile, normalizePath } from 'obsidian';
import type CruciblePlugin from '../../main';
import type { BlogEntry, CanonMethod, RemotePost } from './blogs';
import type { ChannelEntry, RemoteVideo } from './youtube';
import {
	BLOGS_FEED_SOURCE,
	FeedSource,
	YOUTUBE_FEED_SOURCE,
	isSeenPost,
	numberOf,
	stringOf,
} from './feedSources';

export const INTAKE_ROOT_YOUTUBE = YOUTUBE_FEED_SOURCE.intakeRoot;
export const QUEUE_SCAN_SKIP_PREFIX_YOUTUBE = YOUTUBE_FEED_SOURCE.queueScanSkipPrefix;
export const TRACKER_GENERATED_BY_YOUTUBE = YOUTUBE_FEED_SOURCE.trackerGeneratedBy;
export const CONSOLIDATE_GENERATED_BY_YOUTUBE = YOUTUBE_FEED_SOURCE.consolidateGeneratedBy;

export const INTAKE_ROOT_BLOGS = BLOGS_FEED_SOURCE.intakeRoot;
export const QUEUE_SCAN_SKIP_PREFIX_BLOGS = BLOGS_FEED_SOURCE.queueScanSkipPrefix;
export const TRACKER_GENERATED_BY_BLOGS = BLOGS_FEED_SOURCE.trackerGeneratedBy;
export const CONSOLIDATE_GENERATED_BY_BLOGS = BLOGS_FEED_SOURCE.consolidateGeneratedBy;

export interface FeedOutcome<Entry, Item> {
	entry: Entry;
	newItems: Item[];
	error?: string;
}

export interface FeedConsolidationScan<Entry, Item> {
	outcomes: FeedOutcome<Entry, Item>[];
	runsScanned: number;
	itemsSeenInRuns: number;
}

export interface FeedIntakeEntry<Entry, Item> {
	entry: Entry;
	item: Item;
}

export type YoutubeChannelOutcome = {
	channel: ChannelEntry;
	newVideos: RemoteVideo[];
	error?: string;
};

export type YoutubeConsolidationScan = {
	outcomes: YoutubeChannelOutcome[];
	runsScanned: number;
	videosSeenInRuns: number;
};

export type YoutubeIntakeVideoEntry = {
	channel: ChannelEntry;
	video: RemoteVideo;
};

export interface YoutubeIntakeRunStat {
	file: TFile;
	runAt: string;
	channelsTotal: number;
	channelsWithNew: number;
	videosTotal: number;
	channelsFailed: number;
	generatedBy: string;
}

export type BlogOutcome = {
	blog: BlogEntry;
	newPosts: RemotePost[];
	error?: string;
};

export type BlogsConsolidationScan = {
	outcomes: BlogOutcome[];
	runsScanned: number;
	postsSeenInRuns: number;
};

export type BlogsIntakePostEntry = {
	blog: BlogEntry;
	post: RemotePost;
};

export interface BlogsIntakeRunStat {
	file: TFile;
	runAt: string;
	blogsTotal: number;
	blogsWithNew: number;
	postsTotal: number;
	blogsFailed: number;
	rowsSkipped: number;
	generatedBy: string;
}

export function buildFeedSeenIdSet<Entry, Item>(
	app: App,
	source: FeedSource<Entry, Item>,
	diffMode: boolean,
	seedIds?: Iterable<string>,
	hostRules?: Map<string, CanonMethod>,
	extraSkipPrefixes: string[] = [],
): Set<string> {
	const seen = new Set<string>(seedIds ?? []);
	const intakePrefix = `${source.intakeRoot}/`;
	const normalizedExtraSkipPrefixes = extraSkipPrefixes
		.map(prefix => normalizePath(prefix).replace(/\/+$/, ''))
		.filter(prefix => prefix.length > 0);
	for (const file of app.vault.getMarkdownFiles()) {
		const inIntake = file.path.startsWith(intakePrefix);
		const inSkip = file.path.startsWith(source.queueScanSkipPrefix);
		const inExtraSkip = normalizedExtraSkipPrefixes.some(prefix => file.path === prefix || file.path.startsWith(`${prefix}/`));
		if ((inSkip || inExtraSkip) && !(diffMode && inIntake)) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		if (fm['type'] === 'link-record') continue;
		source.ingestFrontmatterIds(fm, seen, diffMode, inIntake, hostRules);
	}
	return seen;
}

export function feedSeenExtraSkipPrefixes<Entry, Item>(plugin: CruciblePlugin, source: FeedSource<Entry, Item>): string[] {
	const linkRegistryRoot = plugin.settings.orchestrationLinkRegistryRoot || '_crucible/link_registry';
	const metadataRoot = source.kind === 'youtube'
		? plugin.settings.orchestrationYoutubeMetadataRoot || '_yt_metadata'
		: plugin.settings.orchestrationBlogsMetadataRoot || '_blog_metadata';
	// X metadata notes are staging artifacts, not captures (the `_blog_metadata`
	// treatment, orchestration AGENTS.md), and that's true for both feed kinds —
	// a blog/YT seen-set scan must skip them the same as its own metadata root.
	const xMetadataRoot = plugin.settings.orchestrationXMetadataRoot || '_x_metadata';
	return [linkRegistryRoot, metadataRoot, xMetadataRoot];
}

export async function loadConfiguredFeedEntries<Entry, Item>(
	app: App,
	plugin: CruciblePlugin,
	source: FeedSource<Entry, Item>,
): Promise<Map<string, { entry: Entry; index: number }>> {
	const out = new Map<string, { entry: Entry; index: number }>();
	const registryPath = normalizePath(source.registryPath(plugin));
	const registryFile = app.vault.getAbstractFileByPath(registryPath);
	if (!(registryFile instanceof TFile)) return out;
	const content = await app.vault.read(registryFile);
	const parsed = source.parseRegistry(content);
	parsed.entries.forEach((entry, index) => out.set(source.entryKey(entry), { entry, index }));
	return out;
}

export async function scanFeedTrackerRuns<Entry, Item>(
	app: App,
	source: FeedSource<Entry, Item>,
	seenInVault: Set<string>,
	configuredEntries: Map<string, { entry: Entry; index: number }>,
): Promise<FeedConsolidationScan<Entry, Item>> {
	const intakePrefix = `${source.intakeRoot}/`;
	const intakeFiles = app.vault.getMarkdownFiles()
		.filter(file => file.path.startsWith(intakePrefix))
		.sort((a, b) => a.path.localeCompare(b.path));

	const byId = new Map<string, FeedIntakeEntry<Entry, Item>>();
	let runsScanned = 0;
	let itemsSeenInRuns = 0;

	for (const file of intakeFiles) {
		const content = await app.vault.read(file);
		const generatedBy: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.generated_by;
		const isTrackerRun = generatedBy === source.trackerGeneratedBy
			|| frontmatterHasGeneratedBy(content, source.trackerGeneratedBy);
		if (!isTrackerRun) continue;
		runsScanned++;

		for (const entry of parseFeedIntake(content, source)) {
			itemsSeenInRuns++;
			const configured = configuredEntries.get(source.entryKey(entry.entry));
			if (!configured) continue;
			if (source.isSeen(entry.item, seenInVault)) continue;
			const id = source.itemId(entry.item);
			if (byId.has(id)) continue;
			byId.set(id, { entry: configured.entry, item: entry.item });
		}
	}

	const byEntry = new Map<string, FeedOutcome<Entry, Item>>();
	for (const entry of byId.values()) {
		const key = source.entryKey(entry.entry);
		const existing = byEntry.get(key);
		if (existing) {
			existing.newItems.push(entry.item);
		} else {
			byEntry.set(key, {
				entry: entry.entry,
				newItems: [entry.item],
			});
		}
	}

	const outcomes = Array.from(byEntry.values()).sort((a, b) => {
		const ai = configuredEntries.get(source.entryKey(a.entry))?.index ?? Number.MAX_SAFE_INTEGER;
		const bi = configuredEntries.get(source.entryKey(b.entry))?.index ?? Number.MAX_SAFE_INTEGER;
		return ai - bi;
	});

	return { outcomes, runsScanned, itemsSeenInRuns };
}

export function listFeedIntakeRuns<Entry, Item>(
	app: App,
	source: FeedSource<Entry, Item>,
): Record<string, unknown>[] {
	const intakePrefix = `${source.intakeRoot}/`;
	const out: Record<string, unknown>[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(intakePrefix)) continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) continue;
		const generatedBy = stringOf(fm['generated_by']);
		if (!generatedBy) continue;
		if (generatedBy !== source.trackerGeneratedBy && generatedBy !== source.consolidateGeneratedBy) continue;
		out.push(source.statFromFrontmatter(file, fm, generatedBy));
	}
	out.sort((a, b) => stringOf(b.runAt)?.localeCompare(stringOf(a.runAt) ?? '') ?? 0);
	return out;
}

export function parseFeedIntake<Entry, Item>(
	content: string,
	source: FeedSource<Entry, Item>,
): FeedIntakeEntry<Entry, Item>[] {
	const entries: FeedIntakeEntry<Entry, Item>[] = [];
	let currentEntry: Entry | null = null;

	for (const line of content.split(/\r?\n/)) {
		const entry = source.parseHeading(line);
		if (entry) {
			currentEntry = entry;
			continue;
		}

		if (line.startsWith('## ')) {
			currentEntry = null;
			continue;
		}

		if (!currentEntry) continue;
		const item = source.itemFromBullet(line, source.entryName(currentEntry));
		if (item) entries.push({ entry: currentEntry, item });
	}

	return entries;
}

export function buildYoutubeSeenIdSet(
	app: App,
	diffMode: boolean,
	seedIds?: Iterable<string>,
	extraSkipPrefixes: string[] = [],
): Set<string> {
	return buildFeedSeenIdSet(app, YOUTUBE_FEED_SOURCE, diffMode, seedIds, undefined, extraSkipPrefixes);
}

export async function loadConfiguredChannels(
	app: App,
	plugin: CruciblePlugin,
): Promise<Map<string, { channel: ChannelEntry; index: number }>> {
	const configured = await loadConfiguredFeedEntries(app, plugin, YOUTUBE_FEED_SOURCE);
	const out = new Map<string, { channel: ChannelEntry; index: number }>();
	for (const [id, value] of configured) {
		out.set(id, { channel: value.entry, index: value.index });
	}
	return out;
}

export async function scanYoutubeTrackerRuns(
	app: App,
	seenInVault: Set<string>,
	configuredChannels: Map<string, { channel: ChannelEntry; index: number }>,
): Promise<YoutubeConsolidationScan> {
	const configured = new Map<string, { entry: ChannelEntry; index: number }>();
	for (const [id, value] of configuredChannels) {
		configured.set(id, { entry: value.channel, index: value.index });
	}
	const scan = await scanFeedTrackerRuns(app, YOUTUBE_FEED_SOURCE, seenInVault, configured);
	return {
		outcomes: scan.outcomes.map(o => ({
			channel: o.entry,
			newVideos: o.newItems,
			error: o.error,
		})),
		runsScanned: scan.runsScanned,
		videosSeenInRuns: scan.itemsSeenInRuns,
	};
}

export function listYoutubeIntakeRuns(app: App): YoutubeIntakeRunStat[] {
	return listFeedIntakeRuns(app, YOUTUBE_FEED_SOURCE) as unknown as YoutubeIntakeRunStat[];
}

export function parseIntakeVideos(content: string): YoutubeIntakeVideoEntry[] {
	return parseFeedIntake(content, YOUTUBE_FEED_SOURCE).map(entry => ({
		channel: entry.entry,
		video: entry.item,
	}));
}

export function buildBlogsSeenIdSet(
	app: App,
	diffMode: boolean,
	seedIds?: Iterable<string>,
	hostRules?: Map<string, CanonMethod>,
	extraSkipPrefixes: string[] = [],
): Set<string> {
	return buildFeedSeenIdSet(app, BLOGS_FEED_SOURCE, diffMode, seedIds, hostRules, extraSkipPrefixes);
}

export async function loadConfiguredBlogs(
	app: App,
	plugin: CruciblePlugin,
): Promise<Map<string, { blog: BlogEntry; index: number }>> {
	const configured = await loadConfiguredFeedEntries(app, plugin, BLOGS_FEED_SOURCE);
	const out = new Map<string, { blog: BlogEntry; index: number }>();
	for (const [id, value] of configured) {
		out.set(id, { blog: value.entry, index: value.index });
	}
	return out;
}

export async function scanBlogsTrackerRuns(
	app: App,
	seenInVault: Set<string>,
	configuredBlogs: Map<string, { blog: BlogEntry; index: number }>,
): Promise<BlogsConsolidationScan> {
	const configured = new Map<string, { entry: BlogEntry; index: number }>();
	for (const [id, value] of configuredBlogs) {
		configured.set(id, { entry: value.blog, index: value.index });
	}
	const scan = await scanFeedTrackerRuns(app, BLOGS_FEED_SOURCE, seenInVault, configured);
	return {
		outcomes: scan.outcomes.map(o => ({
			blog: o.entry,
			newPosts: o.newItems,
			error: o.error,
		})),
		runsScanned: scan.runsScanned,
		postsSeenInRuns: scan.itemsSeenInRuns,
	};
}

export function listBlogsIntakeRuns(app: App): BlogsIntakeRunStat[] {
	return listFeedIntakeRuns(app, BLOGS_FEED_SOURCE) as unknown as BlogsIntakeRunStat[];
}

export function parseIntakePosts(content: string): BlogsIntakePostEntry[] {
	return parseFeedIntake(content, BLOGS_FEED_SOURCE).map(entry => ({
		blog: entry.entry,
		post: entry.item,
	}));
}

function frontmatterHasGeneratedBy(content: string, expected: string): boolean {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	const frontmatter = match?.[1];
	if (!frontmatter) return false;
	return frontmatter
		.split(/\r?\n/)
		.some(line => line.trim() === `generated_by: ${expected}`);
}

export { isSeenPost, numberOf, stringOf };
