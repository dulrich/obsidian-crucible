import { App, RequestUrlResponse, TFile, TFolder, htmlToMarkdown, normalizePath, requestUrl } from 'obsidian';
import type CruciblePlugin from '../../main';
import { ensureFolder, slugify } from '../../utils';
import { yamlString } from '../../frontmatterValues';
import type { ServiceFailureKind } from '../serviceHealth';
import { SERVICE_X_OEMBED } from '../serviceHealth';
import type { WorkflowResult } from '../types';
import { extractXStatusFromUrl } from './xPost';

const DEFAULT_X_METADATA_ROOT = '_x_metadata';

/**
 * The X oEmbed endpoint is unreachable, throttled, or erroring server-side — a
 * dependency-level problem, not a bad status id. Consumers catch this and defer
 * the job with `serviceUnhealthy: { service: 'x-oembed', ... }` (see
 * `xOembedDeferredResult`) rather than fail it, so the `x-oembed` breaker — not
 * per-job retry policy — governs recovery. Mirrors `YoutubeApiUnavailableError`
 * (`youtubeApi.ts`).
 */
export class XApiUnavailableError extends Error {
	constructor(message: string, public readonly kind: ServiceFailureKind, public readonly retryAfterMs?: number) {
		super(message);
		this.name = 'XApiUnavailableError';
	}
}

/** Why a specific post is permanently unavailable. A union (of one member today)
 * so a future reason (e.g. a suspended account) doesn't force a shape change. */
export type XPostUnavailableReason = 'deleted-or-private';

/**
 * A specific X post is gone (deleted, private, or the account is suspended) —
 * a per-post, permanent outcome, deliberately NOT an `XApiUnavailableError`: it
 * must never open the `x-oembed` breaker (a dead post is not an outage), and
 * `ensureXMetadataNote` converts it into a durable tombstone note rather than
 * retrying.
 */
export class XPostUnavailableError extends Error {
	constructor(message: string, public readonly reason: XPostUnavailableReason) {
		super(message);
		this.name = 'XPostUnavailableError';
	}
}

/** Builds the deferred `WorkflowResult` a consumer returns for a caught `XApiUnavailableError`. */
export function xOembedDeferredResult(e: XApiUnavailableError): WorkflowResult {
	return {
		status: 'deferred',
		error: e.message,
		notes: `${e.message}. Retrying shortly.`,
		retryAfterMs: e.retryAfterMs,
		serviceUnhealthy: { service: SERVICE_X_OEMBED, kind: e.kind, reason: e.message },
	};
}

function retryAfterMsFromHeaders(headers: Record<string, string> | undefined): number | undefined {
	if (!headers) return undefined;
	const key = Object.keys(headers).find(k => k.toLowerCase() === 'retry-after');
	if (!key) return undefined;
	const seconds = Number(headers[key]);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export interface XOembedResponse {
	url: string;
	author_name: string;
	author_url: string;
	html: string;
	type: string;
	version: string;
}

/**
 * Parses and minimally validates a 200 oEmbed body. Extra/unknown JSON keys are
 * tolerated (simply ignored); a body that fails to parse, or is missing the
 * fields the note materializer depends on (`url`, `html`), is treated as
 * malformed — the caller surfaces that as a (retryable) `server-error`, not a
 * crash.
 */
function parseXOembedPayload(raw: string): XOembedResponse | null {
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!payload || typeof payload !== 'object') return null;
	const obj = payload as Record<string, unknown>;
	if (typeof obj.url !== 'string' || typeof obj.html !== 'string') return null;
	return {
		url: obj.url,
		author_name: typeof obj.author_name === 'string' ? obj.author_name : '',
		author_url: typeof obj.author_url === 'string' ? obj.author_url : '',
		html: obj.html,
		type: typeof obj.type === 'string' ? obj.type : '',
		version: typeof obj.version === 'string' ? obj.version : '',
	};
}

/**
 * Issues one GET against the unauthenticated X oEmbed endpoint and classifies
 * the response before any caller sees it — the same chokepoint shape as
 * `requestYoutubeApi` (`youtubeApi.ts`). `requestUrl` is passed `throw: false`:
 * without it, Obsidian throws on any HTTP 400+ status itself and the status
 * branches below never run.
 *
 * Classification is by status only: 404/403 → `XPostUnavailableError` (the
 * post itself is gone — permanent, per-post, never opens the breaker); 429 →
 * `XApiUnavailableError('rate-limited', ...)`; any other non-2xx (5xx and
 * anything unrecognized) → `XApiUnavailableError('server-error')`; a network-
 * level throw → `XApiUnavailableError('refused')`. A malformed 200 body is
 * also `'server-error'` — the endpoint answered, just not usably.
 */
export async function requestXOembed(canonicalUrl: string): Promise<XOembedResponse> {
	let res: RequestUrlResponse;
	try {
		res = await requestUrl({
			url: `https://publish.x.com/oembed?url=${encodeURIComponent(canonicalUrl)}&omit_script=true&dnt=true`,
			method: 'GET',
			throw: false,
		});
	} catch (e) {
		throw new XApiUnavailableError(
			`X oEmbed: request failed — ${e instanceof Error ? e.message : String(e)}`,
			'refused',
		);
	}

	if (res.status === 404 || res.status === 403) {
		throw new XPostUnavailableError(`X oEmbed: post unavailable (HTTP ${res.status})`, 'deleted-or-private');
	}
	if (res.status === 429) {
		throw new XApiUnavailableError(
			'X oEmbed: rate limited (HTTP 429)',
			'rate-limited',
			retryAfterMsFromHeaders(res.headers),
		);
	}
	if (res.status !== 200) {
		throw new XApiUnavailableError(`X oEmbed: HTTP ${res.status}`, 'server-error');
	}

	const oembed = parseXOembedPayload(res.text || '');
	if (!oembed) {
		throw new XApiUnavailableError('X oEmbed: malformed JSON response', 'server-error');
	}
	return oembed;
}

export function xMetadataRoot(plugin: CruciblePlugin): string {
	return normalizePath(plugin.settings.orchestrationXMetadataRoot || DEFAULT_X_METADATA_ROOT);
}

/** One-level child-folder probe for `<child>/<statusId>.md` — copy of
 * `findExistingMetadataNote` (`youtubeApi.ts`). The `_unavailable` tombstone
 * folder is a child like any other, so tombstones are found by this same probe. */
export async function findExistingXMetadataNote(app: App, root: string, statusId: string): Promise<TFile | null> {
	const rootFolder = app.vault.getAbstractFileByPath(normalizePath(root));
	if (!(rootFolder instanceof TFolder)) return null;
	for (const child of rootFolder.children) {
		if (!(child instanceof TFolder)) continue;
		const candidate = app.vault.getAbstractFileByPath(`${child.path}/${statusId}.md`);
		if (candidate instanceof TFile) return candidate;
	}
	return null;
}

const SCRIPT_TAG_RE = /<script[^>]*>[\s\S]*?<\/script>/gi;

/** Belt-and-braces over the request's own `omit_script=true` — never persist
 * script (or, by the same reasoning, iframe) machinery into a note body. */
function stripScriptTags(html: string): string {
	return html.replace(SCRIPT_TAG_RE, '');
}

/** Last non-empty path segment of an author profile URL (`https://x.com/<handle>`),
 * or '' when the URL is absent/unparseable. */
function authorHandleFromUrl(authorUrl: string): string {
	if (!authorUrl) return '';
	try {
		const parsed = new URL(authorUrl);
		return parsed.pathname.replace(/^\/+|\/+$/g, '');
	} catch {
		return '';
	}
}

/** Folder slug for a live note: slugified handle from the oEmbed `author_url`,
 * falling back to the handle parsed out of the canonical URL, then a fixed
 * `unknown-author` bucket — never the empty string. */
function resolveFolderSlug(oembed: XOembedResponse, canonicalUrl: string): string {
	const fromAuthor = slugify(authorHandleFromUrl(oembed.author_url));
	if (fromAuthor) return fromAuthor;
	const canonRef = extractXStatusFromUrl(canonicalUrl);
	const fromCanon = canonRef?.handle ? slugify(canonRef.handle) : '';
	if (fromCanon) return fromCanon;
	return 'unknown-author';
}

/** Hand-built YAML + body for a live post note, `buildMetadataNoteBody` style
 * (`youtubeApi.ts`). oEmbed carries no reliable publish-date field, so
 * `published` is simply never emitted — omitted, not invented. */
export function buildXMetadataNoteBody(statusId: string, canonicalUrl: string, oembed: XOembedResponse): string {
	const authorHandle = authorHandleFromUrl(oembed.author_url);
	const fm: string[] = ['---'];
	fm.push(`status-id: ${yamlString(statusId)}`);
	fm.push(`url: ${canonicalUrl}`);
	if (oembed.author_name) fm.push(`author: ${yamlString(oembed.author_name)}`);
	if (authorHandle) fm.push(`author-handle: ${yamlString(authorHandle)}`);
	if (oembed.author_url) fm.push(`author-url: ${oembed.author_url}`);
	if (oembed.type) fm.push(`oembed-type: ${yamlString(oembed.type)}`);
	if (oembed.version) fm.push(`oembed-version: ${yamlString(oembed.version)}`);
	fm.push(`state: ok`);
	fm.push(`fetched_at: ${new Date().toISOString()}`);
	fm.push(`source_command: x-fetch-post-metadata`);
	fm.push('---', '');

	const authorLabel = oembed.author_name || authorHandle || statusId;
	const bodyMarkdown = htmlToMarkdown(stripScriptTags(oembed.html || '')).trim();
	return `${fm.join('\n')}# Post by ${authorLabel}\n\n${bodyMarkdown}\n`;
}

/** Frontmatter-only tombstone body — no post body to carry, and none invented. */
export function buildXTombstoneNoteBody(statusId: string, canonicalUrl: string, reason: XPostUnavailableReason): string {
	const fm: string[] = ['---'];
	fm.push(`status-id: ${yamlString(statusId)}`);
	fm.push(`url: ${canonicalUrl}`);
	fm.push(`state: unavailable`);
	fm.push(`unavailable-reason: ${yamlString(reason)}`);
	fm.push(`fetched_at: ${new Date().toISOString()}`);
	fm.push(`source_command: x-fetch-post-metadata`);
	fm.push('---', '');
	return fm.join('\n');
}

export type XEnsureResult =
	| { status: 'created'; metadataPath: string }
	| { status: 'exists'; metadataPath: string }
	| { status: 'tombstoned'; metadataPath: string }
	| { status: 'invalid'; metadataPath: null };

/**
 * Find-or-fetch-create the metadata note for `statusId`, serialized under the
 * `x-post::<statusId>` resource lock — mirrors `ensureMetadataNote`
 * (`youtubeApi.ts`). Per the lock-ordering rule (root `AGENTS.md`: note lock
 * BEFORE resource lock), this function acquires no note lock at all, and must
 * be called with none held that it would need to re-enter.
 *
 * An existing tombstone probes as `exists` too (snapshot semantics — no
 * refetch of a durable outcome, dead or alive). A caught `XPostUnavailableError`
 * is converted into a durable tombstone here; a caught `XApiUnavailableError`
 * is rethrown untouched — this layer stays transport-honest and leaves the
 * deferred-job conversion to the workflow (`xOembedDeferredResult`).
 */
export async function ensureXMetadataNote(
	plugin: CruciblePlugin,
	statusId: string,
	canonicalUrl: string,
): Promise<XEnsureResult> {
	const app = plugin.app;
	const trimmedId = statusId.trim();
	if (!trimmedId || !/^\d+$/.test(trimmedId)) return { status: 'invalid', metadataPath: null };

	const root = xMetadataRoot(plugin);

	return await plugin.noteLocks.withResourceLock('x-post', trimmedId, 'x-metadata-ensure', async (): Promise<XEnsureResult> => {
		const existing = await findExistingXMetadataNote(app, root, trimmedId);
		if (existing) {
			return { status: 'exists', metadataPath: existing.path };
		}

		let oembed: XOembedResponse;
		try {
			oembed = await requestXOembed(canonicalUrl);
		} catch (e) {
			if (e instanceof XPostUnavailableError) {
				const path = normalizePath(`${root}/_unavailable/${trimmedId}.md`);
				const collision = app.vault.getAbstractFileByPath(path);
				if (collision instanceof TFile) {
					return { status: 'tombstoned', metadataPath: path };
				}
				await ensureFolder(app, `${root}/_unavailable`);
				await app.vault.create(path, buildXTombstoneNoteBody(trimmedId, canonicalUrl, e.reason));
				return { status: 'tombstoned', metadataPath: path };
			}
			throw e;
		}

		const folderSlug = resolveFolderSlug(oembed, canonicalUrl);
		const path = normalizePath(`${root}/${folderSlug}/${trimmedId}.md`);
		const collision = app.vault.getAbstractFileByPath(path);
		if (collision instanceof TFile) {
			// Already on disk despite the probe miss (e.g. the root folder wasn't a
			// TFolder yet when probed) — we created nothing; report `exists`, like
			// `ensureMetadataNote`'s second collision check (`youtubeApi.ts`).
			return { status: 'exists', metadataPath: path };
		}
		await ensureFolder(app, `${root}/${folderSlug}`);
		await app.vault.create(path, buildXMetadataNoteBody(trimmedId, canonicalUrl, oembed));
		return { status: 'created', metadataPath: path };
	});
}
