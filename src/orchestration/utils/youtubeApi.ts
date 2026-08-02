import { App, RequestUrlResponse, TFile, TFolder, normalizePath, requestUrl } from 'obsidian';
import type CruciblePlugin from '../../main';
import { ensureFolder, slugify } from '../../utils';
import { insertFrontmatterPropertyAfter, updateFrontmatter } from '../../frontmatter';
import { yamlString } from '../../frontmatterValues';
import type { ServiceFailureKind } from '../serviceHealth';
import type { WorkflowDeferredResult, WorkflowFailureReason } from '../types';
import { RemoteVideo, VIDEO_ID_RE, parseChannelsTable } from './youtube';

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

/**
 * The YouTube Data API key is missing or empty — a per-run **configuration gap**, not
 * service unhealth, and deliberately NOT a `YoutubeApiUnavailableError`: retrying
 * cannot help until the user sets the key, and opening the shared `youtube-api`
 * breaker for it would stall metadata enrichment too.
 *
 * It is a distinct class rather than a plain `Error` because the consumer has to tell
 * this case apart from every other rejection in order to fail *plainly* (no
 * `serviceUnhealthy`) and to stamp `failureReason: 'no-api-key'`, which is what latches
 * the type's auto-source off. That classification used to be a regex over the message
 * text kept in sync across two files by hand — the typed carrier below is the fix.
 */
export class YoutubeApiKeyMissingError extends Error {
	/** The typed cause a consumer copies onto its `failed` result. */
	readonly failureReason: WorkflowFailureReason = 'no-api-key';

	constructor(message = 'YouTube Data API key not configured — set it in Settings → Orchestrator.') {
		super(message);
		this.name = 'YoutubeApiKeyMissingError';
	}
}

/** Builds the deferred WorkflowResult a consumer returns for a caught `YoutubeApiUnavailableError`. */
export function youtubeApiDeferredResult(e: YoutubeApiUnavailableError): WorkflowDeferredResult {
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

/**
 * `channelId` rides ONLY on `created`, and that asymmetry is the point: it is the
 * in-memory fetch payload (`fetchYoutubeVideo`'s `meta.channelId`), available for free
 * exactly when we just called the API. An `exists` result never fetched, so producing a
 * channel id there would mean re-reading the metadata note — which is why the channel
 * chain in `YoutubeMetadataFetchWorkflow` fires on `created` only. Required (not
 * optional) on that variant so the compiler walks any future `created` construction site
 * to supply it.
 */
export type IngestResult =
	| { status: 'created';     metadataPath: string; channelId: string }
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

// --- Channel tracker: uploads playlist (playlistItems.list) ----------------
//
// The RSS-era tracker polled `feeds/videos.xml?channel_id=…`, which now 404s for
// every channel (dead since ~May 2026 — see the orchestration AGENTS.md tracker
// entry). This is its Data API replacement: every channel's uploads live in a
// synthetic playlist whose id is the channel id with its `UC` prefix swapped for
// `UU` — no `channels.list` resolution call needed, so the tracker still costs 1
// quota unit per channel per poll, same as before.

/** Every registry channel id is guaranteed `UC…` (`parseChannelsTable` drops anything
 * else), so this is a pure string swap — never call `channels.list` to resolve it. */
export function uploadsPlaylistIdFor(channelId: string): string {
	return 'UU' + channelId.slice(2);
}

interface PlaylistItemsResponseItem {
	snippet?: {
		title?: string;
		publishedAt?: string;
		channelTitle?: string;
		resourceId?: {
			videoId?: string;
		};
	};
	contentDetails?: {
		videoId?: string;
		videoPublishedAt?: string;
	};
}

/**
 * Pure mapper from a raw `playlistItems.list` JSON body to the plugin's existing
 * `RemoteVideo` contract — kept separate from `fetchChannelUploads` so it's testable
 * without a network stub. Items with no id, or an id that fails the shared 11-char
 * shape check, are silently skipped (matches the old RSS parser's behavior on a
 * malformed entry).
 */
export function playlistItemsToRemoteVideos(json: unknown): RemoteVideo[] {
	const items = (json as { items?: unknown } | null | undefined)?.items;
	const list: unknown[] = Array.isArray(items) ? items : [];
	const out: RemoteVideo[] = [];
	for (const raw of list) {
		const item = raw as PlaylistItemsResponseItem;
		const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
		if (!videoId || !VIDEO_ID_RE.test(videoId)) continue;
		const rawTitle = item.snippet?.title?.trim();
		const publishedAt = item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt ?? '';
		const channelName = (item.snippet?.channelTitle ?? '').trim();
		out.push({
			videoId,
			title: rawTitle ? rawTitle : '(untitled)',
			publishedAt,
			channelName,
			url: `https://www.youtube.com/watch?v=${videoId}`,
		});
	}
	return out;
}

/**
 * Fetches a channel's recent uploads via the Data API. `maxResults=15` matches the
 * old RSS feed's page depth — no pagination, the seen-set absorbs any gap on the
 * next poll. A missing/empty API key is a per-run config problem, not service
 * unhealth, so it throws `YoutubeApiKeyMissingError` rather than
 * `YoutubeApiUnavailableError` (the caller must not open the shared youtube-api
 * breaker for a key that was never configured). The caller classifies it by its
 * **type**, never by its message text.
 */
export async function fetchChannelUploads(plugin: CruciblePlugin, channelId: string): Promise<RemoteVideo[]> {
	const apiKey = await loadYoutubeApiKey(plugin);
	if (!apiKey) {
		throw new YoutubeApiKeyMissingError();
	}

	const playlistId = uploadsPlaylistIdFor(channelId);
	const params = new URLSearchParams({
		part: 'snippet,contentDetails',
		playlistId,
		maxResults: '15',
		key: apiKey,
	});
	const url = `https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`;
	const res = await requestYoutubeApi(url, `YouTube Data API: channel ${channelId} uploads not found`);

	let payload: unknown;
	try {
		payload = JSON.parse(res.text || '{}');
	} catch {
		throw new Error(`YouTube Data API: malformed JSON response`);
	}

	return playlistItemsToRemoteVideos(payload);
}

export const DEFAULT_YOUTUBE_METADATA_ROOT = '_yt_metadata';

/** The configured YT metadata root, normalized — mirror of `xMetadataRoot` (xApi.ts). */
export function youtubeMetadataRoot(plugin: CruciblePlugin): string {
	return normalizePath(plugin.settings.orchestrationYoutubeMetadataRoot || DEFAULT_YOUTUBE_METADATA_ROOT);
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

	const root = youtubeMetadataRoot(plugin);

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
		// The channel id comes off the fetch payload we already hold — no note re-read.
		// It is what lets the caller chain channel enrichment for a first-seen channel.
		return { status: 'created', metadataPath: path, channelId: meta.channelId };
	});
}

export async function enrichYoutubeMetadataStandalone(
	plugin: CruciblePlugin,
	videoId: string,
): Promise<IngestResult> {
	return await ensureMetadataNote(plugin, videoId);
}

// One note, one job: under the note's lock, bail if `yt-metadata` already carries a
// link to THIS video's metadata note, otherwise ensure the metadata note exists (API
// call only on a miss) and append it onto this note ONLY. Duplicate captures sharing
// the video id each run their own job; every job after the first finds the note
// instead of fetching.
//
// The bail is per-target (WP-J2), not "any link present": `yt-metadata` is a list, and
// a note that already carries its own captured video's stamp must still be able to gain
// a stamp for a *referenced* video found in its body.
export async function ingestYoutubeVideoMetadata(
	plugin: CruciblePlugin,
	sourceFile: TFile,
	videoId: string,
): Promise<IngestResult> {
	const app = plugin.app;
	const trimmedId = videoId.trim();
	if (!trimmedId) return { status: 'no-video-id', metadataPath: null };

	return await plugin.noteLocks.withLock(sourceFile.path, 'yt-metadata', async (): Promise<IngestResult> => {
		// Already linked for this video → done without touching the API or the note.
		const fm = app.metadataCache.getFileCache(sourceFile)?.frontmatter;
		const linked = fm ? findLinkedYtMetadataFile(app, sourceFile, fm['yt-metadata'], trimmedId) : null;
		if (linked) return { status: 'exists', metadataPath: linked.path };

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
// with at least one non-empty entry). The single source of truth for that predicate —
// the Ingestion dashboard's backlog scan and the `yt-metadata-on-capture` trigger both
// import it rather than re-inlining the shape check.
export function isYtMetadataLinked(value: unknown): boolean {
	return ytMetadataLinks(value).length > 0;
}

/**
 * Every non-empty `yt-metadata` entry, wikilink brackets and `|alias` stripped so each
 * can feed `getFirstLinkpathDest`. Tolerates both shapes on purpose: the key is a LIST
 * since WP-J2, but legacy notes still hold a bare scalar and reads must never care.
 */
export function ytMetadataLinks(value: unknown): string[] {
	const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== 'string') continue;
		const link = item.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0]?.trim() ?? '';
		if (link) out.push(link);
	}
	return out;
}

/**
 * The `yt-metadata` entry that stamps THIS video, resolved to its file — or null.
 *
 * A video's metadata note is always `<root>/<channelFolder>/<videoId>.md`
 * (`youtubeMetadataNotePath`), so the entry's final path segment IS the video id; that
 * makes the membership test pure string work, answerable before any API call. An entry
 * that names the video but no longer resolves returns null on purpose: the caller then
 * re-ensures and appends the canonical link, repairing the dead entry instead of
 * reporting a link that goes nowhere (this is the pre-WP-J2 behavior of the old
 * any-link bail, kept).
 */
export function findLinkedYtMetadataFile(
	app: App,
	sourceFile: TFile,
	value: unknown,
	videoId: string,
): TFile | null {
	for (const link of ytMetadataLinks(value)) {
		const segment = (link.split('/').pop() ?? '').replace(/\.md$/, '');
		if (segment !== videoId) continue;
		const dest = app.metadataCache.getFirstLinkpathDest(link, sourceFile.path);
		if (dest) return dest;
	}
	return null;
}

/**
 * Idempotent list-append onto `yt-metadata` — the mirror of `appendXMetadataLink`
 * (`XMetadataFetchWorkflow.ts`), and the ONLY sanctioned way to write the key.
 *
 * An array appends `link` only when not already present (string compare). A non-empty
 * legacy scalar coerces to `[old, link]`, preserving the old value — except when it
 * already equals `link`, where it collapses to `[link]` rather than doubling up. An
 * absent/empty key is created through `insertFrontmatterPropertyAfter` so the list
 * keeps its historical placement immediately after `yt-video-id`.
 *
 * Append-only, never reordering: the capture flow's own video is entry [0] and capture
 * channel attribution (`firstFrontmatterLink`, `src/sourceEval/captureIndex.ts`) reads
 * entry [0]. A referenced-video stamp must never displace it.
 */
export function appendYtMetadataLink(fm: Record<string, unknown>, link: string): void {
	const existing = fm['yt-metadata'];
	if (Array.isArray(existing)) {
		if (!existing.some(v => v === link)) existing.push(link);
		fm['yt-metadata'] = existing;
		return;
	}
	if (typeof existing === 'string' && existing.trim()) {
		fm['yt-metadata'] = existing === link ? [link] : [existing, link];
		return;
	}
	// Absent (or present-but-empty): create the list. `insertFrontmatterPropertyAfter`
	// assigns in place when the key already exists, so the empty case can't clobber
	// anything — and only this branch may use it, since its existing-key assignment
	// would otherwise overwrite a populated list.
	insertFrontmatterPropertyAfter(fm, 'yt-video-id', 'yt-metadata', [link]);
}

export async function linkMetadataToNote(plugin: CruciblePlugin, sourceFile: TFile, metadataPath: string): Promise<void> {
	const link = `[[${stripMdExt(metadataPath)}]]`;
	// Hold the source note's lock so the frontmatter write can't interleave with a
	// chain step or localize touching the same note (the YT-in-chains race).
	// Reentrant under ingestYoutubeVideoMetadata's outer lock.
	await plugin.noteLocks.withLock(sourceFile.path, 'yt-metadata', () =>
		updateFrontmatter(plugin.app, sourceFile, fm => {
			appendYtMetadataLink(fm, link);
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

	const root = youtubeMetadataRoot(plugin);
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
