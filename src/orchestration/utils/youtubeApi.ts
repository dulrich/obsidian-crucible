import { App, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import type CruciblePlugin from '../../main';
import { ensureFolder, slugify } from '../../utils';
import { insertFrontmatterPropertyAfter, updateFrontmatter } from '../../frontmatter';
import { parseChannelsTable } from './youtube';

export const YOUTUBE_DATA_API_SECRET_KEY = 'crucible-youtube-data-api-key';

export async function loadYoutubeApiKey(app: App): Promise<string> {
	if (!app.secretStorage) return '';
	return app.secretStorage.getSecret(YOUTUBE_DATA_API_SECRET_KEY) || '';
}

export async function storeYoutubeApiKey(app: App, key: string): Promise<void> {
	if (!app.secretStorage) return;
	app.secretStorage.setSecret(YOUTUBE_DATA_API_SECRET_KEY, key);
}

export async function deleteYoutubeApiKey(app: App): Promise<void> {
	if (!app.secretStorage) return;
	// SecretStorage doesn't expose an explicit delete, so we clear by setting empty.
	app.secretStorage.setSecret(YOUTUBE_DATA_API_SECRET_KEY, '');
}

export interface YoutubeVideoMetadata {
	videoId: string;
	title: string;
	description: string;
	duration: string;
	durationSeconds: number | null;
	channelId: string;
	channelTitle: string;
	publishedAt: string;
	tags: string[];
	categoryId: string;
	defaultLanguage: string | null;
	liveBroadcastContent: string;
	viewCount: number | null;
	likeCount: number | null;
	commentCount: number | null;
	url: string;
}

export type IngestResult =
	| { status: 'created';     metadataPath: string; createdNew: true;  linkUpdated: boolean }
	| { status: 'exists';      metadataPath: string; createdNew: false; linkUpdated: boolean }
	| { status: 'no-video-id'; metadataPath: null }
	| { status: 'no-api-key';  metadataPath: null };

interface YoutubeApiResponseItem {
	id?: string;
	snippet?: {
		title?: string;
		description?: string;
		channelId?: string;
		channelTitle?: string;
		publishedAt?: string;
		tags?: string[];
		categoryId?: string;
		defaultLanguage?: string;
		liveBroadcastContent?: string;
	};
	contentDetails?: {
		duration?: string;
	};
	statistics?: {
		viewCount?: string;
		likeCount?: string;
		commentCount?: string;
	};
}

export async function fetchYoutubeVideo(apiKey: string, videoId: string): Promise<YoutubeVideoMetadata> {
	const params = new URLSearchParams({
		part: 'snippet,contentDetails,statistics,status',
		id: videoId,
		key: apiKey,
	});
	const url = `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`;
	const res = await requestUrl({ url, method: 'GET', throw: false });

	if (res.status === 403) {
		const detail = extractApiErrorReason(res.text);
		if (detail.includes('quota')) {
			throw new Error(`YouTube Data API: quota exceeded`);
		}
		throw new Error(`YouTube Data API: forbidden (HTTP 403). Check the API key and Data API enablement.`);
	}
	if (res.status === 404) {
		throw new Error(`YouTube Data API: video ${videoId} not found`);
	}
	if (res.status !== 200) {
		const snippet = (res.text || '').slice(0, 200).replace(/\s+/g, ' ');
		throw new Error(`YouTube Data API: HTTP ${res.status} — ${snippet}`);
	}

	let payload: { items?: YoutubeApiResponseItem[] };
	try {
		payload = JSON.parse(res.text || '{}') as { items?: YoutubeApiResponseItem[] };
	} catch {
		throw new Error(`YouTube Data API: malformed JSON response`);
	}

	const item = payload.items?.[0];
	if (!item) {
		throw new Error(`YouTube Data API: video ${videoId} not found`);
	}

	const duration = item.contentDetails?.duration ?? '';
	return {
		videoId: item.id || videoId,
		title: item.snippet?.title ?? '',
		description: item.snippet?.description ?? '',
		duration,
		durationSeconds: parseIso8601Duration(duration),
		channelId: item.snippet?.channelId ?? '',
		channelTitle: item.snippet?.channelTitle ?? '',
		publishedAt: item.snippet?.publishedAt ?? '',
		tags: Array.isArray(item.snippet?.tags) ? item.snippet?.tags ?? [] : [],
		categoryId: item.snippet?.categoryId ?? '',
		defaultLanguage: item.snippet?.defaultLanguage ?? null,
		liveBroadcastContent: item.snippet?.liveBroadcastContent ?? 'none',
		viewCount: toNumberOrNull(item.statistics?.viewCount),
		likeCount: toNumberOrNull(item.statistics?.likeCount),
		commentCount: toNumberOrNull(item.statistics?.commentCount),
		url: `https://www.youtube.com/watch?v=${item.id || videoId}`,
	};
}

export function youtubeMetadataNotePath(root: string, channelFolder: string, videoId: string): string {
	return normalizePath(`${root}/${channelFolder}/${videoId}.md`);
}

export async function findExistingMetadataNote(app: App, root: string, videoId: string): Promise<TFile | null> {
	const rootFolder = app.vault.getAbstractFileByPath(normalizePath(root));
	if (!(rootFolder instanceof TFolder)) return null;
	for (const child of rootFolder.children) {
		if (!(child instanceof TFolder)) continue;
		const candidate = app.vault.getAbstractFileByPath(`${child.path}/${videoId}.md`);
		if (candidate instanceof TFile) return candidate;
	}
	return null;
}

export async function resolveChannelFolder(
	app: App,
	plugin: CruciblePlugin,
	channelId: string,
	channelTitle: string,
): Promise<string> {
	const registryPath = normalizePath(plugin.settings.orchestrationYoutubeChannelsNote);
	const registryFile = app.vault.getAbstractFileByPath(registryPath);
	if (registryFile instanceof TFile) {
		const content = await app.vault.read(registryFile);
		const entries = parseChannelsTable(content);
		const match = entries.find(e => e.channelId === channelId);
		if (match) {
			const slug = slugify(match.name);
			if (slug) return slug;
		}
	}
	return slugify(channelTitle) || channelId || 'unknown-channel';
}

export function buildMetadataNoteBody(meta: YoutubeVideoMetadata): string {
	const fm: string[] = ['---'];
	fm.push(`videoId: ${meta.videoId}`);
	fm.push(`title: ${yamlString(meta.title)}`);
	fm.push(`url: ${meta.url}`);
	fm.push(`channelId: ${meta.channelId}`);
	fm.push(`channelTitle: ${yamlString(meta.channelTitle)}`);
	fm.push(`publishedAt: ${meta.publishedAt}`);
	fm.push(`duration: ${meta.duration}`);
	fm.push(`duration_seconds: ${meta.durationSeconds ?? 'null'}`);
	fm.push(`categoryId: ${yamlString(meta.categoryId)}`);
	fm.push(`defaultLanguage: ${meta.defaultLanguage === null ? 'null' : yamlString(meta.defaultLanguage)}`);
	fm.push(`liveBroadcastContent: ${meta.liveBroadcastContent || 'none'}`);
	if (meta.tags.length > 0) {
		fm.push('tags:');
		for (const tag of meta.tags) fm.push(`  - ${yamlString(tag)}`);
	}
	fm.push(`viewCount: ${meta.viewCount ?? 'null'}`);
	fm.push(`likeCount: ${meta.likeCount ?? 'null'}`);
	fm.push(`commentCount: ${meta.commentCount ?? 'null'}`);
	fm.push(`fetched_at: ${new Date().toISOString()}`);
	fm.push(`source_command: youtube-fetch-video-metadata`);
	fm.push('---', '');

	const title = meta.title || meta.videoId;
	const description = meta.description ?? '';
	return `${fm.join('\n')}# ${title}\n\n## Description\n\n${description}\n`;
}

export async function writeYoutubeMetadataNote(app: App, path: string, meta: YoutubeVideoMetadata): Promise<TFile> {
	const slashIdx = path.lastIndexOf('/');
	if (slashIdx > 0) await ensureFolder(app, path.slice(0, slashIdx));
	const body = buildMetadataNoteBody(meta);
	return await app.vault.create(path, body);
}

export async function enrichYoutubeMetadataStandalone(
	plugin: CruciblePlugin,
	videoId: string,
): Promise<IngestResult> {
	const app = plugin.app;
	const trimmedId = videoId.trim();
	if (!trimmedId) return { status: 'no-video-id', metadataPath: null };

	const root = normalizePath(plugin.settings.orchestrationYoutubeMetadataRoot || '_yt_metadata');

	const existing = await findExistingMetadataNote(app, root, trimmedId);
	if (existing) {
		return { status: 'exists', metadataPath: existing.path, createdNew: false, linkUpdated: false };
	}

	const apiKey = await loadYoutubeApiKey(app);
	if (!apiKey) return { status: 'no-api-key', metadataPath: null };

	const meta = await fetchYoutubeVideo(apiKey, trimmedId);
	const channelFolder = await resolveChannelFolder(app, plugin, meta.channelId, meta.channelTitle);
	const path = youtubeMetadataNotePath(root, channelFolder, trimmedId);

	const collision = app.vault.getAbstractFileByPath(path);
	if (collision instanceof TFile) {
		return { status: 'exists', metadataPath: path, createdNew: false, linkUpdated: false };
	}

	await writeYoutubeMetadataNote(app, path, meta);
	return { status: 'created', metadataPath: path, createdNew: true, linkUpdated: false };
}

export async function ingestYoutubeVideoMetadata(
	plugin: CruciblePlugin,
	sourceFile: TFile,
	videoId: string,
): Promise<IngestResult> {
	const app = plugin.app;
	const trimmedId = videoId.trim();
	if (!trimmedId) return { status: 'no-video-id', metadataPath: null };

	const root = normalizePath(plugin.settings.orchestrationYoutubeMetadataRoot || '_yt_metadata');

	const existing = await findExistingMetadataNote(app, root, trimmedId);
	if (existing) {
		await setYtMetadataLink(plugin, sourceFile, existing.path);
		return { status: 'exists', metadataPath: existing.path, createdNew: false, linkUpdated: true };
	}

	const apiKey = await loadYoutubeApiKey(app);
	if (!apiKey) return { status: 'no-api-key', metadataPath: null };

	const meta = await fetchYoutubeVideo(apiKey, trimmedId);
	const channelFolder = await resolveChannelFolder(app, plugin, meta.channelId, meta.channelTitle);
	const path = youtubeMetadataNotePath(root, channelFolder, trimmedId);

	const collision = app.vault.getAbstractFileByPath(path);
	if (collision instanceof TFile) {
		await setYtMetadataLink(plugin, sourceFile, path);
		return { status: 'exists', metadataPath: path, createdNew: false, linkUpdated: true };
	}

	await writeYoutubeMetadataNote(app, path, meta);
	await setYtMetadataLink(plugin, sourceFile, path);
	return { status: 'created', metadataPath: path, createdNew: true, linkUpdated: true };
}

async function setYtMetadataLink(plugin: CruciblePlugin, sourceFile: TFile, metadataPath: string): Promise<void> {
	const link = `[[${stripMdExt(metadataPath)}]]`;
	await updateFrontmatter(plugin.app, sourceFile, fm => {
		insertFrontmatterPropertyAfter(fm, 'yt-video-id', 'yt-metadata', link);
	});
}

function stripMdExt(path: string): string {
	return path.endsWith('.md') ? path.slice(0, -3) : path;
}

export function parseIso8601Duration(value: string): number | null {
	if (!value) return null;
	const m = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
	if (!m) return null;
	const h = m[1] ? parseInt(m[1], 10) : 0;
	const min = m[2] ? parseInt(m[2], 10) : 0;
	const s = m[3] ? parseInt(m[3], 10) : 0;
	const total = h * 3600 + min * 60 + s;
	return total > 0 || /PT0?S/.test(value) ? total : null;
}

function toNumberOrNull(value: string | undefined): number | null {
	if (value === undefined || value === null || value === '') return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function yamlString(value: string): string {
	const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	return `"${escaped}"`;
}

interface YoutubeApiErrorBody {
	error?: {
		message?: string;
		errors?: Array<{ reason?: string }>;
	};
}

function extractApiErrorReason(body: string | undefined): string {
	if (!body) return '';
	try {
		const parsed = JSON.parse(body) as YoutubeApiErrorBody;
		const errors = parsed.error?.errors;
		if (Array.isArray(errors) && errors[0]?.reason) return errors[0].reason;
		if (parsed.error?.message) return parsed.error.message;
	} catch {
		// fall through
	}
	return body.slice(0, 200);
}
