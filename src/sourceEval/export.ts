import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type CruciblePlugin from '../main';
import type { FeedPriority } from '../orchestration/utils/feedSources';
import { computeBlogControlRows } from '../ingestion/data/blogs';
import { computeChannelControlRows } from '../ingestion/data/channels';
import { formatDate } from '../ingestion/render/format';
import { buildBlogCanonHostMap, postIdFromUrl } from '../orchestration/utils/blogs';
import {
	INTAKE_ROOT_BLOGS,
	INTAKE_ROOT_YOUTUBE,
	TRACKER_GENERATED_BY_BLOGS,
	TRACKER_GENERATED_BY_YOUTUBE,
	loadConfiguredBlogs,
	loadConfiguredChannels,
	parseIntakePosts,
	parseIntakeVideos,
} from '../orchestration/utils/feedIntake';
import { loadIgnoredBlogIds, loadIgnoredVideoIds } from '../orchestration/utils/ignoredIds';
import { coerceVideoId } from '../orchestration/utils/youtubeApi';
import { ensureFolder } from '../utils';
import { computeCaptureIndex } from './captureIndex';
import { scanObservationSignals } from './signals';
import type { CaptureRecord, ObservationSignalMap, SourceKey, SourceType } from './types';

export type SourceEvalLabelSource = 'human' | 'weak';

export interface SourceEvalTrainingLabel {
	importance: number;
	urgent: boolean;
	tags: string[];
}

export interface SourceEvalTrainingExample {
	id: string;
	source_type: SourceType;
	source_key: string;
	source_name: string;
	source_tags: string[];
	source_priority: FeedPriority;
	title: string;
	description: string | null;
	author: string | null;
	published: string | null;
	word_count: number | null;
	duration_seconds: number | null;
	label: SourceEvalTrainingLabel;
	label_source: SourceEvalLabelSource;
	rated: string | null;
}

export interface SourceEvalExportOptions {
	includeWeakLabels?: boolean;
	now?: number;
}

export interface SourceEvalExportResult {
	path: string;
	count: number;
	examples: SourceEvalTrainingExample[];
}

export interface SourceEvalSourceInfo {
	name: string;
	tags: string[];
	priority: FeedPriority;
}

export interface SourceEvalCaptureExportInput {
	capture: CaptureRecord;
	frontmatter: Record<string, unknown>;
	ytMetadataFrontmatter?: Record<string, unknown>;
}

export interface SourceEvalIgnoredIntakeItem {
	id: string;
	sourceType: SourceType;
	sourceKey: string;
	sourceName: string;
	sourceTags: string[];
	sourcePriority: FeedPriority;
	title: string;
	description?: string | null;
	author?: string | null;
	published?: string | null;
	wordCount?: number | null;
	durationSeconds?: number | null;
}

export interface BuildTrainingExamplesInput {
	captures: SourceEvalCaptureExportInput[];
	sourceInfo: Map<SourceKey, SourceEvalSourceInfo>;
	observations?: ObservationSignalMap;
	ignoredItems?: SourceEvalIgnoredIntakeItem[];
	includeWeakLabels?: boolean;
	now?: number;
}

const DEFAULT_EXPORT_FOLDER = '_crucible/source_eval';
const LABEL_TAGS = ['gold', 'goldmine', 'revisit', 'reference', 'probably-slop'] as const;

export async function exportSourceEvalTrainingData(
	app: App,
	plugin: Pick<CruciblePlugin, 'settings'>,
	options: SourceEvalExportOptions = {},
): Promise<SourceEvalExportResult> {
	const examples = await collectSourceEvalTrainingExamples(app, plugin, options);
	const folder = normalizePath(plugin.settings.sourceEvalExportFolder || DEFAULT_EXPORT_FOLDER).replace(/\/+$/, '') || DEFAULT_EXPORT_FOLDER;
	await ensureFolder(app, folder);
	const path = `${folder}/training-${formatDate(options.now ?? Date.now())}.jsonl`;
	const body = serializeTrainingExamples(examples);
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, body);
	} else {
		await app.vault.create(path, body);
	}
	return { path, count: examples.length, examples };
}

export async function collectSourceEvalTrainingExamples(
	app: App,
	plugin: Pick<CruciblePlugin, 'settings'>,
	options: SourceEvalExportOptions = {},
): Promise<SourceEvalTrainingExample[]> {
	const captures = await computeCaptureIndex(app, plugin);
	const [configuredBlogs, configuredChannels, blogRows, channelRows, observations] = await Promise.all([
		loadConfiguredBlogs(app, plugin as CruciblePlugin),
		loadConfiguredChannels(app, plugin as CruciblePlugin),
		computeBlogControlRows(app, plugin as CruciblePlugin),
		computeChannelControlRows(app, plugin as CruciblePlugin),
		options.includeWeakLabels ? scanObservationSignals(app, plugin.settings.monthlyFolder) : Promise.resolve(new Map()),
	]);
	const sourceInfo = buildSourceInfoMap({
		configuredBlogs,
		configuredChannels,
		blogRows,
		channelRows,
	});
	const ytMetadata = buildYtMetadataFrontmatterMap(app, plugin.settings.orchestrationYoutubeMetadataRoot);
	const exportCaptures = (captures ?? []).map(capture => {
		const frontmatter = app.metadataCache.getFileCache(capture.file)?.frontmatter ?? {};
		const videoId = coerceVideoId(frontmatter['yt-video-id']);
		return {
			capture,
			frontmatter,
			ytMetadataFrontmatter: videoId ? ytMetadata.get(videoId) : undefined,
		};
	});
	const ignoredItems = options.includeWeakLabels
		? await collectIgnoredIntakeItems(app, plugin, sourceInfo, ytMetadata)
		: [];
	return buildTrainingExamples({
		captures: exportCaptures,
		sourceInfo,
		observations,
		ignoredItems,
		includeWeakLabels: options.includeWeakLabels,
		now: options.now,
	});
}

export function buildTrainingExamples(input: BuildTrainingExamplesInput): SourceEvalTrainingExample[] {
	const rows: SourceEvalTrainingExample[] = [];
	const seenHuman = new Set<string>();
	const seenAny = new Set<string>();

	for (const captureInput of input.captures) {
		const row = buildHumanTrainingExample(captureInput, input.sourceInfo);
		if (!row) continue;
		const key = exampleConflictKey(row);
		seenHuman.add(key);
		seenAny.add(key);
		rows.push(row);
	}

	if (!input.includeWeakLabels) return rows;

	for (const captureInput of input.captures) {
		const row = buildWeakCaptureTrainingExample(captureInput, input.sourceInfo, input.observations, input.now);
		if (!row) continue;
		const key = exampleConflictKey(row);
		if (seenHuman.has(key) || seenAny.has(key)) continue;
		seenAny.add(key);
		rows.push(row);
	}

	for (const item of input.ignoredItems ?? []) {
		const row = buildIgnoredTrainingExample(item);
		const key = exampleConflictKey(row);
		if (seenHuman.has(key) || seenAny.has(key)) continue;
		seenAny.add(key);
		rows.push(row);
	}

	return rows;
}

export function buildHumanTrainingExample(
	input: SourceEvalCaptureExportInput,
	sourceInfo: Map<SourceKey, SourceEvalSourceInfo>,
): SourceEvalTrainingExample | null {
	const { capture } = input;
	if (!capture.source || capture.evalSkip || !capture.label || capture.label.importance === null) return null;
	const base = buildCaptureBaseExample(input, sourceInfo);
	if (!base) return null;
	return {
		...base,
		label: {
			importance: capture.label.importance,
			urgent: capture.label.urgent,
			tags: labelTags(capture.tags, capture.label.tags),
		},
		label_source: 'human',
		rated: capture.label.rated,
	};
}

export function buildWeakCaptureTrainingExample(
	input: SourceEvalCaptureExportInput,
	sourceInfo: Map<SourceKey, SourceEvalSourceInfo>,
	observations: ObservationSignalMap = new Map(),
	now: number = Date.now(),
): SourceEvalTrainingExample | null {
	const { capture } = input;
	if (!capture.source || capture.evalSkip || (capture.label && capture.label.importance !== null)) return null;
	const tags = new Set(capture.tags.map(normalizeTag));
	let importance: number | null = null;
	if (tags.has('probably-slop')) importance = 0;
	if (tags.has('gold')) importance = Math.max(importance ?? 0, 4);
	if ((observations.get(capture.file.path)?.months ?? 0) > 0) importance = Math.max(importance ?? 0, 4);
	if (importance === null) return null;
	const base = buildCaptureBaseExample(input, sourceInfo);
	if (!base) return null;
	return {
		...base,
		label: {
			importance,
			urgent: false,
			tags: labelTags(capture.tags, capture.label?.tags ?? []),
		},
		label_source: 'weak',
		rated: formatDate(now),
	};
}

export function serializeTrainingExamples(examples: SourceEvalTrainingExample[]): string {
	if (examples.length === 0) return '';
	return `${examples.map(example => JSON.stringify(example)).join('\n')}\n`;
}

function buildCaptureBaseExample(
	input: SourceEvalCaptureExportInput,
	sourceInfo: Map<SourceKey, SourceEvalSourceInfo>,
): Omit<SourceEvalTrainingExample, 'label' | 'label_source' | 'rated'> | null {
	const { capture, frontmatter, ytMetadataFrontmatter } = input;
	if (!capture.source) return null;
	const sourceType = sourceTypeOf(capture.source);
	const id = captureId(sourceType, frontmatter);
	if (!id) return null;
	const info = sourceInfo.get(capture.source) ?? defaultSourceInfo(capture.source);
	return {
		id,
		source_type: sourceType,
		source_key: bareSourceKey(capture.source),
		source_name: info.name,
		source_tags: normalizeSourceTags(info.tags),
		source_priority: info.priority,
		title: stringProp(frontmatter.title) || capture.file.basename,
		description: firstString(frontmatter.description, frontmatter.summary, ytMetadataFrontmatter?.description),
		author: sourceType === 'youtube'
			? firstString(ytMetadataFrontmatter?.channelTitle, frontmatter.channel, info.name)
			: firstString(frontmatter.author, frontmatter.authors, frontmatter.blog, info.name),
		published: firstString(frontmatter.published, ytMetadataFrontmatter?.publishedAt) ?? (capture.published ? formatDate(capture.published) : null),
		word_count: numberProp(frontmatter['word-count']) ?? capture.wordCount,
		duration_seconds: numberProp(frontmatter.duration_seconds) ?? numberProp(ytMetadataFrontmatter?.duration_seconds),
	};
}

function buildIgnoredTrainingExample(item: SourceEvalIgnoredIntakeItem): SourceEvalTrainingExample {
	return {
		id: item.id,
		source_type: item.sourceType,
		source_key: item.sourceKey,
		source_name: item.sourceName,
		source_tags: normalizeSourceTags(item.sourceTags),
		source_priority: item.sourcePriority,
		title: item.title,
		description: item.description ?? null,
		author: item.author ?? null,
		published: item.published ?? null,
		word_count: item.wordCount ?? null,
		duration_seconds: item.durationSeconds ?? null,
		label: { importance: 0, urgent: false, tags: [] },
		label_source: 'weak',
		rated: null,
	};
}

async function collectIgnoredIntakeItems(
	app: App,
	plugin: Pick<CruciblePlugin, 'settings'>,
	sourceInfo: Map<SourceKey, SourceEvalSourceInfo>,
	ytMetadata: Map<string, Record<string, unknown>>,
): Promise<SourceEvalIgnoredIntakeItem[]> {
	const [ignoredBlogs, ignoredVideos] = await Promise.all([
		loadIgnoredBlogIds(app),
		loadIgnoredVideoIds(app),
	]);
	const configuredBlogs = await loadConfiguredBlogs(app, plugin as CruciblePlugin);
	const hostRules = buildBlogCanonHostMap(Array.from(configuredBlogs.values(), v => v.blog));
	const items: SourceEvalIgnoredIntakeItem[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		if (file.path.startsWith(`${INTAKE_ROOT_BLOGS}/`) && fm.generated_by === TRACKER_GENERATED_BY_BLOGS) {
			const content = await app.vault.read(file);
			for (const { blog, post } of parseIntakePosts(content)) {
				const id = postIdFromUrl(post.postId || post.url, { hostRules });
				if (!ignoredBlogs.has(id)) continue;
				const source: SourceKey = `blog:${blog.link}`;
				const info = sourceInfo.get(source) ?? { name: blog.name, tags: blog.tags, priority: blog.priority };
				items.push({
					id,
					sourceType: 'blog',
					sourceKey: bareSourceKey(source),
					sourceName: info.name,
					sourceTags: info.tags,
					sourcePriority: info.priority,
					title: post.title,
					author: post.authors.length > 0 ? post.authors.join(', ') : blog.name,
					published: post.publishedAt || null,
					wordCount: post.wordCount,
				});
			}
		}
		if (file.path.startsWith(`${INTAKE_ROOT_YOUTUBE}/`) && fm.generated_by === TRACKER_GENERATED_BY_YOUTUBE) {
			const content = await app.vault.read(file);
			for (const { channel, video } of parseIntakeVideos(content)) {
				if (!ignoredVideos.has(video.videoId)) continue;
				const source: SourceKey = `youtube:${channel.channelId}`;
				const info = sourceInfo.get(source) ?? { name: channel.name, tags: channel.tags, priority: channel.priority };
				const meta = ytMetadata.get(video.videoId);
				items.push({
					id: video.videoId,
					sourceType: 'youtube',
					sourceKey: bareSourceKey(source),
					sourceName: info.name,
					sourceTags: info.tags,
					sourcePriority: info.priority,
					title: video.title,
					author: firstString(meta?.channelTitle, video.channelName, info.name),
					published: firstString(meta?.publishedAt, video.publishedAt),
					durationSeconds: numberProp(meta?.duration_seconds),
				});
			}
		}
	}
	return items;
}

function buildSourceInfoMap(args: {
	configuredBlogs: Awaited<ReturnType<typeof loadConfiguredBlogs>>;
	configuredChannels: Awaited<ReturnType<typeof loadConfiguredChannels>>;
	blogRows: Awaited<ReturnType<typeof computeBlogControlRows>>;
	channelRows: Awaited<ReturnType<typeof computeChannelControlRows>>;
}): Map<SourceKey, SourceEvalSourceInfo> {
	const out = new Map<SourceKey, SourceEvalSourceInfo>();
	for (const [blogKey, value] of args.configuredBlogs) {
		out.set(`blog:${blogKey}`, {
			name: value.blog.name,
			tags: value.blog.tags,
			priority: value.blog.priority,
		});
	}
	for (const [channelId, value] of args.configuredChannels) {
		out.set(`youtube:${channelId}`, {
			name: value.channel.name,
			tags: value.channel.tags,
			priority: value.channel.priority,
		});
	}
	for (const row of args.blogRows) {
		const key: SourceKey = `blog:${row.blogKey}`;
		if (!out.has(key)) out.set(key, { name: row.name, tags: [], priority: 'normal' });
	}
	for (const row of args.channelRows) {
		const key: SourceKey = `youtube:${row.channelId}`;
		if (!out.has(key)) out.set(key, { name: row.name, tags: [], priority: 'normal' });
	}
	return out;
}

function buildYtMetadataFrontmatterMap(app: App, metadataRoot: string): Map<string, Record<string, unknown>> {
	const root = normalizePath(metadataRoot || '_yt_metadata');
	const folder = app.vault.getAbstractFileByPath(root);
	const out = new Map<string, Record<string, unknown>>();
	if (!(folder instanceof TFolder)) return out;
	for (const file of walkMarkdown(folder)) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const videoId = coerceVideoId(fm.videoId);
		if (videoId) out.set(videoId, fm);
	}
	return out;
}

function captureId(sourceType: SourceType, fm: Record<string, unknown>): string {
	if (sourceType === 'youtube') return coerceVideoId(fm['yt-video-id']);
	const postId = stringProp(fm['post-id']);
	if (postId) return postId;
	const source = stringProp(fm.source);
	return source ? postIdFromUrl(source) : '';
}

function sourceTypeOf(source: SourceKey): SourceType {
	return source.startsWith('youtube:') ? 'youtube' : 'blog';
}

function bareSourceKey(source: SourceKey): string {
	const idx = source.indexOf(':');
	return idx === -1 ? source : source.slice(idx + 1);
}

function defaultSourceInfo(source: SourceKey): SourceEvalSourceInfo {
	return { name: bareSourceKey(source), tags: [], priority: 'normal' };
}

function exampleConflictKey(example: Pick<SourceEvalTrainingExample, 'source_type' | 'id'>): string {
	return `${example.source_type}:${example.id}`;
}

function labelTags(noteTags: string[], evalTags: string[]): string[] {
	const out = new Set<string>();
	const allowed = new Set<string>(LABEL_TAGS);
	for (const tag of [...noteTags, ...evalTags]) {
		const normalized = normalizeTag(tag);
		if (allowed.has(normalized)) out.add(normalized);
	}
	return Array.from(out);
}

function normalizeSourceTags(tags: string[]): string[] {
	const out = new Set<string>();
	for (const tag of tags) {
		const normalized = normalizeTag(tag);
		if (normalized) out.add(`#${normalized}`);
	}
	return Array.from(out);
}

function normalizeTag(tag: string): string {
	return tag.trim().replace(/^#+/, '').toLowerCase();
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		const raw: unknown = Array.isArray(value)
			? value.find((v: unknown): v is string => typeof v === 'string' && v.trim().length > 0)
			: value;
		const str = stringProp(raw);
		if (str) return stripWikiLink(str);
	}
	return null;
}

function stripWikiLink(value: string): string {
	return value.replace(/^\[\[/, '').replace(/\]\]$/, '').split('|').pop()?.trim() ?? value;
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

function* walkMarkdown(folder: TFolder): Generator<TFile> {
	for (const child of folder.children) {
		if (child instanceof TFile && child.extension === 'md') yield child;
		if (child instanceof TFolder) yield* walkMarkdown(child);
	}
}
