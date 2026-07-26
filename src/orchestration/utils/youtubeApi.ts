import { App, RequestUrlResponse, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import type CruciblePlugin from '../../main';
import { ensureFolder, slugify } from '../../utils';
import { insertFrontmatterPropertyAfter, updateFrontmatter } from '../../frontmatter';
import { yamlString } from '../../frontmatterValues';
import type { ServiceFailureKind } from '../serviceHealth';
import type { WorkflowResult } from '../types';
import { parseChannelsTable } from './youtube';

export const YOUTUBE_DATA_API_SECRET_KEY = 'crucible-youtube-data-api-key';

/**
 * The YouTube Data API is unreachable, throttled, or erroring server-side — as
 * opposed to a job-level problem (missing/bad credential, a video that genuinely
 * doesn't exist, a malformed response body) that no retry will fix. Consumers catch
 * this and defer the job with `serviceUnhealthy: { service: 'youtube-api', ... }`
 * rather than fail it, so the breaker (not per-job retry policy) governs recovery.
 *
 * `retryAfterMs` carries the server's own instruction when it gave one (a 429
 * `Retry-After` header) or a conservative fixed backoff for a 403-quota rejection,
 * which has no header at all — see `YOUTUBE_QUOTA_RETRY_AFTER_MS`.
 */
export class YoutubeApiUnavailableError extends Error {
	constructor(message: string, public readonly kind: ServiceFailureKind, public readonly retryAfterMs?: number) {
		super(message);
		this.name = 'YoutubeApiUnavailableError';
	}
}

/**
 * The YouTube Data API gives no `Retry-After` for a quota rejection (unlike its 429
 * rate-limit response, which sometimes does) — quota resets at midnight Pacific, so
 * the "correct" wait is anywhere from seconds to ~24h depending on when it was hit.
 * A conservative fixed hour is a deliberate middle ground: short enough that a quota
 * bump mid-day recovers within the session, long enough that the breaker isn't
 * probing (and getting refused again) every 30s-doubling cycle for a condition that
 * will not clear until a clock event. The registry's own backoff doubling still
 * applies on top of this if the probe fails again.
 */
export const YOUTUBE_QUOTA_RETRY_AFTER_MS = 60 * 60_000;

/** Builds the deferred WorkflowResult a consumer returns for a caught `YoutubeApiUnavailableError`. */
export function youtubeApiDeferredResult(e: YoutubeApiUnavailableError): WorkflowResult {
	return {
		status: 'deferred',
		error: e.message,
		notes: `${e.message}. Retrying shortly.`,
		retryAfterMs: e.retryAfterMs,
		serviceUnhealthy: { service: 'youtube-api', kind: e.kind, reason: e.message },
	};
}

function retryAfterMsFromHeaders(headers: Record<string, string> | undefined): number | undefined {
	if (!headers) return undefined;
	const key = Object.keys(headers).find(k => k.toLowerCase() === 'retry-after');
	if (!key) return undefined;
	const seconds = Number(headers[key]);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/**
 * Issues one YouTube Data API GET and classifies the response before any caller sees
 * it. A network-level failure, a 5xx, a 429, or a 403 quota rejection are all "the
 * service is down/throttled", not a bug in what we asked for, so they throw
 * `YoutubeApiUnavailableError` and the caller's workflow can defer the whole job
 * instead of misreporting a service outage as a permanent per-job failure. Everything
 * else (404, bad-key 403, a non-2xx status this function doesn't otherwise recognize)
 * is left as a plain Error — a job-level problem the caller keeps handling as it
 * always has.
 *
 * `requestUrl` is passed `throw: false`: without it, Obsidian throws on any HTTP 400+
 * status itself and the status branches below never see it, only the network-error
 * catch would fire (audit finding B6's "dead status branches" does not apply here —
 * this call site already opts out of that behavior).
 */
async function requestYoutubeApi(url: string, notFoundMessage: string): Promise<RequestUrlResponse> {
	let res: RequestUrlResponse;
	try {
		res = await requestUrl({ url, method: 'GET', throw: false });
	} catch (e) {
		throw new YoutubeApiUnavailableError(
			`YouTube Data API: request failed — ${e instanceof Error ? e.message : String(e)}`,
			'refused',
		);
	}

	if (res.status === 429) {
		throw new YoutubeApiUnavailableError(
			'YouTube Data API: rate limited (HTTP 429)',
			'rate-limited',
			retryAfterMsFromHeaders(res.headers),
		);
	}
	if (res.status === 403) {
		const detail = extractApiErrorReason(res.text);
		if (detail.includes('quota')) {
			throw new YoutubeApiUnavailableError(`YouTube Data API: quota exceeded`, 'rate-limited', YOUTUBE_QUOTA_RETRY_AFTER_MS);
		}
		throw new Error(`YouTube Data API: forbidden (HTTP 403). Check the API key and Data API enablement.`);
	}
	if (res.status === 404) {
		throw new Error(notFoundMessage);
	}
	if (res.status >= 500) {
		throw new YoutubeApiUnavailableError(`YouTube Data API: HTTP ${res.status}`, 'server-error');
	}
	if (res.status !== 200) {
		const snippet = (res.text || '').slice(0, 200).replace(/\s+/g, ' ');
		throw new Error(`YouTube Data API: HTTP ${res.status} — ${snippet}`);
	}
	return res;
}

export async function loadYoutubeApiKey(plugin: CruciblePlugin): Promise<string> {
	return plugin.secretRegistry.get(YOUTUBE_DATA_API_SECRET_KEY);
}

export async function storeYoutubeApiKey(plugin: CruciblePlugin, key: string): Promise<void> {
	await plugin.secretRegistry.store(YOUTUBE_DATA_API_SECRET_KEY, key);
}

export async function deleteYoutubeApiKey(plugin: CruciblePlugin): Promise<void> {
	await plugin.secretRegistry.clear(YOUTUBE_DATA_API_SECRET_KEY);
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
	| { status: 'created';     metadataPath: string }
	| { status: 'exists';      metadataPath: string }
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
	const res = await requestYoutubeApi(url, `YouTube Data API: video ${videoId} not found`);

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

// Find-or-fetch-create the metadata note for `videoId`, serialized under the
// `yt-video::<id>` resource lock: per-note jobs sharing a video id would otherwise
// both miss findExistingMetadataNote and double-fetch/double-create. Per the lock
// ordering rule (AGENTS.md), call this with the note lock already held (or with no
// note lock at all) — never acquire a note lock from inside it.
export async function ensureMetadataNote(plugin: CruciblePlugin, videoId: string): Promise<IngestResult> {
	const app = plugin.app;
	const trimmedId = videoId.trim();
	if (!trimmedId) return { status: 'no-video-id', metadataPath: null };

	const root = normalizePath(plugin.settings.orchestrationYoutubeMetadataRoot || '_yt_metadata');

	return await plugin.noteLocks.withResourceLock('yt-video', trimmedId, 'yt-metadata-ensure', async (): Promise<IngestResult> => {
		const existing = await findExistingMetadataNote(app, root, trimmedId);
		if (existing) {
			return { status: 'exists', metadataPath: existing.path };
		}

		const apiKey = await loadYoutubeApiKey(plugin);
		if (!apiKey) return { status: 'no-api-key', metadataPath: null };

		const meta = await fetchYoutubeVideo(apiKey, trimmedId);
		const channelFolder = await resolveChannelFolder(app, plugin, meta.channelId, meta.channelTitle);
		const path = youtubeMetadataNotePath(root, channelFolder, trimmedId);

		const collision = app.vault.getAbstractFileByPath(path);
		if (collision instanceof TFile) {
			return { status: 'exists', metadataPath: path };
		}

		await writeYoutubeMetadataNote(app, path, meta);
		return { status: 'created', metadataPath: path };
	});
}

export async function enrichYoutubeMetadataStandalone(
	plugin: CruciblePlugin,
	videoId: string,
): Promise<IngestResult> {
	return await ensureMetadataNote(plugin, videoId);
}

// One note, one job: under the note's lock, bail if `yt-metadata` already links
// somewhere, otherwise ensure the metadata note exists (API call only on a miss)
// and link it onto this note ONLY. Duplicate captures sharing the video id each
// run their own job; every job after the first finds the note instead of fetching.
export async function ingestYoutubeVideoMetadata(
	plugin: CruciblePlugin,
	sourceFile: TFile,
	videoId: string,
): Promise<IngestResult> {
	const app = plugin.app;
	const trimmedId = videoId.trim();
	if (!trimmedId) return { status: 'no-video-id', metadataPath: null };

	return await plugin.noteLocks.withLock(sourceFile.path, 'yt-metadata', async (): Promise<IngestResult> => {
		// Already linked → done without touching the API or the note. Resolve the
		// existing link target for the result's metadataPath when possible.
		const fm = app.metadataCache.getFileCache(sourceFile)?.frontmatter;
		const existingLink = fm ? firstYtMetadataLink(fm['yt-metadata']) : '';
		if (existingLink) {
			const dest = app.metadataCache.getFirstLinkpathDest(existingLink, sourceFile.path);
			if (dest) return { status: 'exists', metadataPath: dest.path };
		}

		const result = await ensureMetadataNote(plugin, trimmedId);
		if (result.metadataPath) {
			await linkMetadataToNote(plugin, sourceFile, result.metadataPath);
		}
		return result;
	});
}

// Coerces a frontmatter `yt-video-id` value into a trimmed string. Accepts a
// string, number, or array (taking the first non-empty string). Returns '' when
// no usable id is present.
export function coerceVideoId(value: unknown): string {
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number') return String(value).trim();
	if (Array.isArray(value)) {
		for (const item of value) {
			if (typeof item === 'string' && item.trim()) return item.trim();
		}
	}
	return '';
}

// True when `yt-metadata` already carries a link (a non-empty string, or an array
// with at least one non-empty entry).
export function isYtMetadataLinked(value: unknown): boolean {
	return firstYtMetadataLink(value) !== '';
}

// First non-empty `yt-metadata` value, with wikilink brackets stripped so it can
// feed getFirstLinkpathDest. '' when no usable link is present.
function firstYtMetadataLink(value: unknown): string {
	const raw = typeof value === 'string'
		? value
		: Array.isArray(value)
			? value.find(v => typeof v === 'string' && v.trim().length > 0) as string | undefined ?? ''
			: '';
	return raw.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0]?.trim() ?? '';
}

export async function linkMetadataToNote(plugin: CruciblePlugin, sourceFile: TFile, metadataPath: string): Promise<void> {
	const link = `[[${stripMdExt(metadataPath)}]]`;
	// Hold the source note's lock so the frontmatter write can't interleave with a
	// chain step or localize touching the same note (the YT-in-chains race).
	// Reentrant under ingestYoutubeVideoMetadata's outer lock.
	await plugin.noteLocks.withLock(sourceFile.path, 'yt-metadata', () =>
		updateFrontmatter(plugin.app, sourceFile, fm => {
			insertFrontmatterPropertyAfter(fm, 'yt-video-id', 'yt-metadata', link);
		}),
	);
}

function stripMdExt(path: string): string {
	return path.endsWith('.md') ? path.slice(0, -3) : path;
}

// --- Channel metadata (about.md) -------------------------------------------

export interface YoutubeChannelMetadata {
	channelId: string;
	title: string;
	description: string;
	customUrl: string;
	publishedAt: string;
	country: string | null;
	thumbnailUrl: string | null;
	subscriberCount: number | null;
	videoCount: number | null;
	viewCount: number | null;
	url: string;
}

export type ChannelIngestResult =
	| { status: 'created';        aboutPath: string }
	| { status: 'updated';        aboutPath: string }
	| { status: 'skipped';        aboutPath: string }
	| { status: 'no-channel-id';  aboutPath: null }
	| { status: 'no-api-key';     aboutPath: null };

interface YoutubeChannelApiItem {
	id?: string;
	snippet?: {
		title?: string;
		description?: string;
		customUrl?: string;
		publishedAt?: string;
		country?: string;
		thumbnails?: { high?: { url?: string }; medium?: { url?: string }; default?: { url?: string } };
	};
	statistics?: {
		subscriberCount?: string;
		videoCount?: string;
		viewCount?: string;
	};
}

export async function fetchYoutubeChannel(apiKey: string, channelId: string): Promise<YoutubeChannelMetadata> {
	const params = new URLSearchParams({
		part: 'snippet,statistics',
		id: channelId,
		key: apiKey,
	});
	const url = `https://www.googleapis.com/youtube/v3/channels?${params.toString()}`;
	const res = await requestYoutubeApi(url, `YouTube Data API: channel ${channelId} not found`);

	let payload: { items?: YoutubeChannelApiItem[] };
	try {
		payload = JSON.parse(res.text || '{}') as { items?: YoutubeChannelApiItem[] };
	} catch {
		throw new Error(`YouTube Data API: malformed JSON response`);
	}

	const item = payload.items?.[0];
	if (!item) {
		throw new Error(`YouTube Data API: channel ${channelId} not found`);
	}

	const id = item.id || channelId;
	const thumbs = item.snippet?.thumbnails;
	return {
		channelId: id,
		title: item.snippet?.title ?? '',
		description: item.snippet?.description ?? '',
		customUrl: item.snippet?.customUrl ?? '',
		publishedAt: item.snippet?.publishedAt ?? '',
		country: item.snippet?.country ?? null,
		thumbnailUrl: thumbs?.high?.url ?? thumbs?.medium?.url ?? thumbs?.default?.url ?? null,
		subscriberCount: toNumberOrNull(item.statistics?.subscriberCount),
		videoCount: toNumberOrNull(item.statistics?.videoCount),
		viewCount: toNumberOrNull(item.statistics?.viewCount),
		url: `https://www.youtube.com/channel/${id}`,
	};
}

export function youtubeChannelAboutNotePath(root: string, channelFolder: string): string {
	return normalizePath(`${root}/${channelFolder}/about.md`);
}

// Scans each `<root>/<slug>/about.md` and returns the one whose frontmatter
// `channelId` matches, so a channel's about note is found regardless of which
// folder slug it landed under (parallels findExistingMetadataNote).
export function findExistingChannelAboutNote(app: App, root: string, channelId: string): TFile | null {
	const rootFolder = app.vault.getAbstractFileByPath(normalizePath(root));
	if (!(rootFolder instanceof TFolder)) return null;
	for (const child of rootFolder.children) {
		if (!(child instanceof TFolder)) continue;
		const candidate = app.vault.getAbstractFileByPath(`${child.path}/about.md`);
		if (!(candidate instanceof TFile)) continue;
		const fm = app.metadataCache.getFileCache(candidate)?.frontmatter;
		if (fm && typeof fm['channelId'] === 'string' && fm['channelId'] === channelId) return candidate;
	}
	return null;
}

export function buildChannelAboutNoteBody(meta: YoutubeChannelMetadata): string {
	const fm: string[] = ['---'];
	fm.push(`channelId: ${meta.channelId}`);
	fm.push(`title: ${yamlString(meta.title)}`);
	fm.push(`url: ${meta.url}`);
	if (meta.customUrl) fm.push(`customUrl: ${yamlString(meta.customUrl)}`);
	fm.push(`publishedAt: ${meta.publishedAt}`);
	fm.push(`country: ${meta.country === null ? 'null' : yamlString(meta.country)}`);
	if (meta.thumbnailUrl) fm.push(`thumbnail: ${meta.thumbnailUrl}`);
	fm.push(`subscriberCount: ${meta.subscriberCount ?? 'null'}`);
	fm.push(`videoCount: ${meta.videoCount ?? 'null'}`);
	fm.push(`viewCount: ${meta.viewCount ?? 'null'}`);
	fm.push(`fetched_at: ${new Date().toISOString()}`);
	fm.push(`source_command: youtube-fetch-channel-metadata`);
	fm.push('---', '');

	const title = meta.title || meta.channelId;
	const description = meta.description ?? '';
	return `${fm.join('\n')}# ${title}\n\n## Description\n\n${description}\n`;
}

// Reads the about note's fetched_at age in ms (Infinity when unknown).
export function channelAboutAgeMs(app: App, file: TFile): number {
	const fm: Record<string, unknown> = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
	const raw = fm['fetched_at'];
	const ts = typeof raw === 'string' ? Date.parse(raw) : NaN;
	return Number.isFinite(ts) ? Date.now() - ts : Number.POSITIVE_INFINITY;
}

// Find-or-fetch-write the channel about.md, serialized under the
// `yt-channel::<channelId>` resource lock. When an about note already exists and
// is younger than maxAgeMs (and force is not set), it is left untouched and no
// API call is made; otherwise the note is fetched and (over)written.
export async function ensureChannelAboutNote(
	plugin: CruciblePlugin,
	channelId: string,
	opts: { force?: boolean; maxAgeMs?: number } = {},
): Promise<ChannelIngestResult> {
	const app = plugin.app;
	const trimmedId = channelId.trim();
	if (!trimmedId) return { status: 'no-channel-id', aboutPath: null };

	const root = normalizePath(plugin.settings.orchestrationYoutubeMetadataRoot || '_yt_metadata');
	const maxAgeMs = opts.maxAgeMs ?? Number.POSITIVE_INFINITY;

	return await plugin.noteLocks.withResourceLock('yt-channel', trimmedId, 'yt-channel-about-ensure', async (): Promise<ChannelIngestResult> => {
		const existing = findExistingChannelAboutNote(app, root, trimmedId);
		if (existing && !opts.force && channelAboutAgeMs(app, existing) < maxAgeMs) {
			return { status: 'skipped', aboutPath: existing.path };
		}

		const apiKey = await loadYoutubeApiKey(plugin);
		if (!apiKey) return { status: 'no-api-key', aboutPath: null };

		const meta = await fetchYoutubeChannel(apiKey, trimmedId);
		const channelFolder = await resolveChannelFolder(app, plugin, meta.channelId, meta.title);
		const path = youtubeChannelAboutNotePath(root, channelFolder);
		const body = buildChannelAboutNoteBody(meta);

		const target = existing ?? app.vault.getAbstractFileByPath(path);
		if (target instanceof TFile) {
			await app.vault.modify(target, body);
			return { status: 'updated', aboutPath: target.path };
		}

		const slashIdx = path.lastIndexOf('/');
		if (slashIdx > 0) await ensureFolder(app, path.slice(0, slashIdx));
		const created = await app.vault.create(path, body);
		return { status: 'created', aboutPath: created.path };
	});
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
