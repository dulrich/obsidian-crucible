// Single home for X (formerly Twitter) status-URL parsing and canonical identity —
// the "single X status-ID home" analog of `utils/youtube.ts`'s video-ID extraction.
// Dependency-light leaf: no obsidian import, pure functions only, so
// `urlCanonicalize.ts` and the oEmbed client (`xApi.ts`) can both depend on it
// without dragging in the vault/app surface.
//
// `statusId` is always the numeric id as a string. X status ids are 64-bit
// snowflake-style numbers that exceed JS's safe-integer range (2^53-1) — never
// `parseInt`/`Number()` one, or the tail digits silently corrupt.

export interface XStatusRef {
	/** `[A-Za-z0-9_]{1,15}` handle, or null for the handle-less `/i/web/status/` form. */
	handle: string | null;
	/** The numeric status id, kept as a string — see the module comment. */
	statusId: string;
}

const X_HOSTS = new Set([
	'x.com',
	'www.x.com',
	'mobile.x.com',
	'twitter.com',
	'www.twitter.com',
	'mobile.twitter.com',
]);

// Trailing segments after the id (e.g. `/photo/1`) are tolerated — `(?:\/|$)`
// requires the digit run to end cleanly rather than accepting a partial match
// glued to trailing letters.
const HANDLE_STATUS_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\/|$)/;
const I_WEB_STATUS_RE = /^\/i\/web\/status\/(\d+)(?:\/|$)/;

/**
 * Parses an X/Twitter status URL into its handle + numeric status id. Returns
 * null for anything that isn't an http(s) URL on a recognized X/Twitter host
 * with a recognized status path. Query params never affect the result — they
 * live outside `pathname` and are dropped wholesale by `canonicalXStatusUrl`.
 */
export function extractXStatusFromUrl(raw: string): XStatusRef | null {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
	if (!X_HOSTS.has(parsed.hostname.toLowerCase())) return null;

	const handleMatch = HANDLE_STATUS_RE.exec(parsed.pathname);
	if (handleMatch) {
		return { handle: handleMatch[1] ?? '', statusId: handleMatch[2] ?? '' };
	}
	const iWebMatch = I_WEB_STATUS_RE.exec(parsed.pathname);
	if (iWebMatch) {
		return { handle: null, statusId: iWebMatch[1] ?? '' };
	}
	return null;
}

/**
 * The canonical form of an X status: `https://x.com/<handle>/status/<id>`, or
 * `https://x.com/i/web/status/<id>` when there is no handle. Always `x.com`
 * (never `twitter.com`/`mobile.*`) and always query-param-free — every tracking
 * variant (`?s=20`, `?t=...`) of one status collapses onto this one string.
 */
export function canonicalXStatusUrl(handle: string | null, statusId: string): string {
	return handle ? `https://x.com/${handle}/status/${statusId}` : `https://x.com/i/web/status/${statusId}`;
}
