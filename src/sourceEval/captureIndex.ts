import { App, TFile, TFolder, getAllTags, normalizePath } from 'obsidian';
import type CruciblePlugin from '../main';
import type { CrucibleSettings } from '../types';
import {
	metadataBlogKeyForAttribution,
	normalizeBlogNameForAttribution,
	sourceHostForAttribution,
} from '../ingestion/data/blogs';
import { buildBlogCanonHostMap, postIdFromUrl, type CanonMethod } from '../orchestration/utils/blogs';
import { loadConfiguredBlogs } from '../orchestration/utils/feedIntake';
import { coerceVideoId } from '../orchestration/utils/youtubeApi';
import { parseEvalLabel } from './signals';
import type { CaptureRecord, SourceKey } from './types';

type CaptureIndexSettings = Pick<
	CrucibleSettings,
	'dailyFolder' | 'weeklyFolder' | 'monthlyFolder' | 'orchestrationYoutubeMetadataRoot' | 'orchestrationBlogsNote'
>;

export interface CaptureIndexPluginLike {
	settings: CaptureIndexSettings;
}

export async function computeCaptureIndex(
	app: App,
	plugin: CaptureIndexPluginLike,
): Promise<CaptureRecord[] | null> {
	const root = app.vault.getAbstractFileByPath(plugin.settings.dailyFolder);
	if (!(root instanceof TFolder)) return null;

	const youtubeChannels = buildYoutubeVideoChannelMap(app, plugin.settings.orchestrationYoutubeMetadataRoot);
	const configuredBlogs = await loadConfiguredBlogs(app, plugin as CruciblePlugin);
	const blogResolver = buildBlogSourceResolver(configuredBlogs);
	const hostRules = buildBlogCanonHostMap(Array.from(configuredBlogs.values(), v => v.blog));

	const records: CaptureRecord[] = [];
	for (const file of walkMarkdown(root)) {
		if (isGeneratedPeriodNote(file.path, plugin.settings)) continue;
		const cache = app.metadataCache.getFileCache(file);
		const fm: Record<string, unknown> = cache?.frontmatter ?? {};
		const tags = uniqueTags(((cache ? getAllTags(cache) : null) ?? []).map(t => t.replace(/^#/, '')));
		records.push({
			file,
			source: resolveCaptureSource(fm, file.path, youtubeChannels, plugin.settings.orchestrationYoutubeMetadataRoot, blogResolver, hostRules),
			wordCount: numberProp(fm['word-count']),
			read: fm.read === true,
			tags,
			created: dateProp(fm.created) ?? file.stat.ctime,
			published: dateProp(fm.published),
				isTranscript: tags.includes('transcript'),
				isRefined: tags.includes('refined'),
				label: parseEvalLabel(fm),
				evalSkip: fm['eval-skip'] === true,
			});
	}
	return records;
}

export function isGeneratedPeriodNote(path: string, settings: Pick<CrucibleSettings, 'dailyFolder' | 'weeklyFolder' | 'monthlyFolder'>): boolean {
	return matchesPeriodPath(path, settings.dailyFolder, /^\d{4}-\d{2}-\d{2}\.md$/) ||
		matchesPeriodPath(path, settings.weeklyFolder, /^\d{4}-W\d{2}\.md$/) ||
		matchesPeriodPath(path, settings.monthlyFolder, /^\d{4}-\d{2}\.md$/);
}

export function buildYoutubeVideoChannelMap(app: App, metadataRoot: string): Map<string, string> {
	const root = normalizePath(metadataRoot || '_yt_metadata');
	const folder = app.vault.getAbstractFileByPath(root);
	const out = new Map<string, string>();
	if (!(folder instanceof TFolder)) return out;

	for (const file of walkMarkdown(folder)) {
		if (file.basename === 'about') continue;
		const fm = app.metadataCache.getFileCache(file)?.frontmatter;
		const videoId = coerceVideoId(fm?.videoId);
		const channelId = stringProp(fm?.channelId);
		if (videoId && channelId) out.set(videoId, channelId);
	}
	return out;
}

export function parseYtMetadataChannelFromLink(value: unknown, metadataRoot: string): string {
	const link = firstFrontmatterLink(value);
	if (!link) return '';
	const root = normalizePath(metadataRoot || '_yt_metadata');
	const path = normalizePath(link.replace(/\.md$/, ''));
	const rootPrefix = `${root}/`;
	if (!path.startsWith(rootPrefix)) return '';
	const rest = path.slice(rootPrefix.length);
	const channel = rest.split('/')[0]?.trim() ?? '';
	return channel;
}

function resolveCaptureSource(
	fm: Record<string, unknown>,
	filePath: string,
	youtubeChannels: Map<string, string>,
	youtubeMetadataRoot: string,
	blogResolver: BlogSourceResolver,
	hostRules: Map<string, CanonMethod>,
): SourceKey | null {
	const videoId = coerceVideoId(fm['yt-video-id']);
	if (videoId) {
		const channelId = youtubeChannels.get(videoId) || parseYtMetadataChannelFromLink(fm['yt-metadata'], youtubeMetadataRoot);
		return channelId ? `youtube:${channelId}` : null;
	}

	const source = stringProp(fm.source);
	const rawPostId = stringProp(fm['post-id']);
	if (!source && !rawPostId) return null;
	const postId = source ? postIdFromUrl(source, { hostRules }) : rawPostId;
	const blogKey = blogResolver({
		blogName: stringProp(fm.blog),
		source,
		postId,
		path: filePath,
	});
	return blogKey ? `blog:${blogKey}` : null;
}

interface BlogResolveInput {
	blogName: string;
	source: string;
	postId: string;
	path: string;
}

type ConfiguredBlogs = Awaited<ReturnType<typeof loadConfiguredBlogs>>;
type BlogSourceResolver = (input: BlogResolveInput) => string;

function buildBlogSourceResolver(configuredBlogs: ConfiguredBlogs): BlogSourceResolver {
	const nameToKey = new Map<string, string>();
	const hostToKey = new Map<string, string>();
	for (const [blogKey, value] of configuredBlogs) {
		nameToKey.set(normalizeBlogNameForAttribution(value.blog.name), blogKey);
		const host = sourceHostForAttribution(value.blog.link);
		if (host && !hostToKey.has(host)) hostToKey.set(host, blogKey);
	}

	return ({ blogName, source, postId, path }) => {
		const nameKey = blogName ? nameToKey.get(normalizeBlogNameForAttribution(blogName)) : undefined;
		if (nameKey) return nameKey;
		const sourceHost = sourceHostForAttribution(source);
		if (sourceHost && hostToKey.has(sourceHost)) return hostToKey.get(sourceHost)!;
		const postHost = sourceHostForAttribution(postId);
		if (postHost && hostToKey.has(postHost)) return hostToKey.get(postHost)!;
		return metadataBlogKeyForAttribution(blogName, source || postId, path);
	};
}

function firstFrontmatterLink(value: unknown): string {
	const raw = typeof value === 'string'
		? value
		: Array.isArray(value)
			? value.find(v => typeof v === 'string' && v.trim().length > 0) as string | undefined ?? ''
			: '';
	return raw.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0]?.split('#')[0]?.trim() ?? '';
}

function stringProp(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function numberProp(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

function dateProp(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function uniqueTags(tags: string[]): string[] {
	return Array.from(new Set(tags.map(t => t.trim()).filter(Boolean)));
}

function matchesPeriodPath(path: string, folder: string | undefined, basenamePattern: RegExp): boolean {
	const root = normalizePath(folder ?? '').replace(/\/$/, '');
	if (!root) return false;
	const normalized = normalizePath(path);
	const prefix = `${root}/`;
	if (!normalized.startsWith(prefix)) return false;
	const rest = normalized.slice(prefix.length);
	return !rest.includes('/') && basenamePattern.test(rest);
}

function* walkMarkdown(folder: TFolder): Generator<TFile> {
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === 'md') yield child;
		if (child instanceof TFolder) yield* walkMarkdown(child);
	}
}
