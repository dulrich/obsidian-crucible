import { App, TFolder, normalizePath } from 'obsidian';
import type CruciblePlugin from '../../main';
import { buildBlogCanonHostMap, postIdFromUrl } from '../../orchestration/utils/blogs';
import {
	INTAKE_ROOT_BLOGS,
	TRACKER_GENERATED_BY_BLOGS,
	buildBlogsSeenIdSet,
	feedSeenExtraSkipPrefixes,
	loadConfiguredBlogs,
	parseIntakePosts,
} from '../../orchestration/utils/feedIntake';
import { BLOGS_FEED_SOURCE } from '../../orchestration/utils/feedSources';
import { blogMetadataRoot } from '../../orchestration/utils/blogsApi';
import { loadIgnoredBlogIds } from '../../orchestration/utils/ignoredIds';
import { stringProp } from '../../frontmatterValues';
import { walkMarkdown } from '../../vaultWalk';
import type { BlogControlRow } from '../render/types';
import { partitionControlUniverse } from './controlCenter';

interface BlogAgg {
	name?: string;
	link?: string;
	intakeIds: Set<string>;
	metaIds: Set<string>;
	tracked: boolean;
}

export async function computeBlogControlRows(app: App, plugin: CruciblePlugin): Promise<BlogControlRow[]> {
	const registry = await loadConfiguredBlogs(app, plugin);
	const configuredBlogs = Array.from(registry.values(), v => v.blog);
	const hostRules = buildBlogCanonHostMap(configuredBlogs);
	const ignored = await loadIgnoredBlogIds(app);
	const captured = buildBlogsSeenIdSet(app, false, undefined, hostRules, feedSeenExtraSkipPrefixes(plugin, BLOGS_FEED_SOURCE));

	const agg = new Map<string, BlogAgg>();
	const nameToKey = new Map<string, string>();
	const get = (blogKey: string): BlogAgg => {
		let entry = agg.get(blogKey);
		if (!entry) {
			entry = { intakeIds: new Set(), metaIds: new Set(), tracked: registry.has(blogKey) };
			agg.set(blogKey, entry);
		}
		return entry;
	};

	for (const [blogKey, value] of registry) {
		const entry = get(blogKey);
		entry.name = value.blog.name;
		entry.link = value.blog.link;
		entry.tracked = true;
		nameToKey.set(normalizeBlogNameForAttribution(value.blog.name), blogKey);
	}

	const intakePrefix = `${INTAKE_ROOT_BLOGS}/`;
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(intakePrefix)) continue;
		const generatedBy: unknown = app.metadataCache.getFileCache(file)?.frontmatter?.generated_by;
		if (generatedBy !== TRACKER_GENERATED_BY_BLOGS) continue;
		const content = await app.vault.read(file);
		for (const { blog, post } of parseIntakePosts(content)) {
			const blogKey = BLOGS_FEED_SOURCE.entryKey(blog);
			const entry = get(blogKey);
			if (!entry.name) entry.name = blog.name;
			if (!entry.link) entry.link = blog.link;
			entry.intakeIds.add(post.postId);
		}
	}

	const root = normalizePath(blogMetadataRoot(plugin));
	const rootFolder = app.vault.getAbstractFileByPath(root);
	if (rootFolder instanceof TFolder) {
		for (const note of walkMarkdown(rootFolder)) {
			const fm = app.metadataCache.getFileCache(note)?.frontmatter;
			const postId = stringProp(fm?.['post-id']);
			const source = stringProp(fm?.source);
			const blogName = stringProp(fm?.blog);
			const id = postId || (source ? postIdFromUrl(source, { hostRules }) : '');
			if (!id) continue;

			const nameKey = blogName ? nameToKey.get(normalizeBlogNameForAttribution(blogName)) : undefined;
			const blogKey = nameKey ?? metadataBlogKeyForAttribution(blogName, source, note.path);
			const entry = get(blogKey);
			if (!entry.name) entry.name = blogName || sourceHostForAttribution(source) || blogKey;
			if (!entry.link && source) entry.link = source;
			entry.metaIds.add(id);
		}
	}

	const rows: BlogControlRow[] = [];
	for (const [blogKey, entry] of agg) {
		const universe = entry.intakeIds.size > 0 ? entry.intakeIds : entry.metaIds;
		const partition = partitionControlUniverse(universe, ignored, captured);
		rows.push({
			blogKey,
			name: entry.name || entry.link || blogKey,
			link: entry.link ?? null,
			trackedPosts: partition.total,
			ingestedPosts: partition.ingested,
			ignoredPosts: partition.ignored,
			uncapturedPosts: partition.uncaptured,
			tracked: entry.tracked,
		});
	}

	rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
	return rows;
}

export function normalizeBlogNameForAttribution(name: string): string {
	return name.trim().toLowerCase();
}

export function metadataBlogKeyForAttribution(blogName: string, source: string, path: string): string {
	const normalizedName = normalizeBlogNameForAttribution(blogName);
	if (normalizedName) return `metadata:${normalizedName}`;
	const host = sourceHostForAttribution(source);
	if (host) return `metadata:${host}`;
	return `metadata:${path}`;
}

export function sourceHostForAttribution(source: string): string {
	try {
		return source ? new URL(source).hostname : '';
	} catch {
		return '';
	}
}
