import { extractVideoIdFromUrl } from './youtube';

export interface TrackedSourceHint {
	type: 'youtube-channel';
	canonical: string;
}

export interface CanonicalizedUrl {
	url: string;
	canonical: string;
	domain: string;
	filename: string;
	youtubeVideoId?: string;
	trackedSource?: TrackedSourceHint;
}

const TRACKING_PARAMS = new Set([
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'utm_term',
	'utm_content',
	'fbclid',
	'gclid',
	'ref',
	'ref_src',
	'mc_cid',
	'mc_eid',
]);

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const YOUTU_BE_HOSTS = new Set(['youtu.be', 'www.youtu.be']);
const ARXIV_HOSTS = new Set(['arxiv.org', 'www.arxiv.org']);

export function canonicalizeUrl(raw: string): CanonicalizedUrl | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

	parsed.protocol = parsed.protocol.toLowerCase();
	parsed.hostname = parsed.hostname.toLowerCase();
	parsed.hash = '';

	const host = parsed.hostname;
	let youtubeVideoId: string | undefined;
	let trackedSource: TrackedSourceHint | undefined;

	if (YT_HOSTS.has(host)) {
		const watchId = extractVideoIdFromUrl(parsed.toString());
		if (watchId) {
			parsed.hostname = 'www.youtube.com';
			parsed.pathname = '/watch';
			parsed.search = `?v=${watchId}`;
			youtubeVideoId = watchId;
		} else {
			const channelHint = detectYouTubeChannelHint(parsed);
			if (channelHint) {
				trackedSource = { type: 'youtube-channel', canonical: channelHint };
			}
		}
	} else if (YOUTU_BE_HOSTS.has(host)) {
		const id = extractVideoIdFromUrl(parsed.toString());
		if (id) {
			parsed.hostname = 'www.youtube.com';
			parsed.pathname = '/watch';
			parsed.search = `?v=${id}`;
			youtubeVideoId = id;
		}
	} else if (ARXIV_HOSTS.has(host)) {
		const m = parsed.pathname.match(/^\/(?:abs|pdf)\/([^/]+?)(?:\.pdf)?$/);
		if (m && m[1]) {
			parsed.hostname = 'arxiv.org';
			parsed.pathname = `/abs/${m[1]}`;
			parsed.search = '';
		}
	}

	if (parsed.search && !youtubeVideoId) {
		parsed.search = stripTrackingParams(parsed.search);
	}

	if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
		parsed.pathname = parsed.pathname.replace(/\/+$/, '');
	}

	const canonical = parsed.toString();
	const filename = slugForCanonical(canonical);

	return {
		url: trimmed,
		canonical,
		domain: parsed.hostname,
		filename,
		youtubeVideoId,
		trackedSource,
	};
}

export function slugForCanonical(canonical: string): string {
	let parsed: URL;
	try {
		parsed = new URL(canonical);
	} catch {
		return fallbackSlug(canonical);
	}
	const hostPart = parsed.hostname;
	const pathPart = parsed.pathname.replace(/^\/+/, '');
	const queryPart = parsed.search.replace(/^\?/, '');
	const joined = [hostPart, pathPart, queryPart].filter(s => s.length > 0).join('__');
	let slug = joined
		.replace(/[/?&=]/g, '__')
		.replace(/[^A-Za-z0-9._\-@]/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
	if (!slug) slug = fallbackSlug(canonical);
	if (slug.length > 100) {
		slug = `${slug.slice(0, 96)}-${shortHash(canonical)}`;
	}
	return slug.toLowerCase();
}

export function shortHash(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0').slice(0, 4);
}

function detectYouTubeChannelHint(parsed: URL): string | null {
	const path = parsed.pathname.replace(/\/+$/, '');
	const handle = path.match(/^\/(@[^/]+)$/);
	if (handle) return `https://www.youtube.com/${handle[1]}`;
	const channel = path.match(/^\/channel\/(UC[^/]+)$/);
	if (channel) return `https://www.youtube.com/channel/${channel[1]}`;
	const cName = path.match(/^\/c\/([^/]+)$/);
	if (cName) return `https://www.youtube.com/c/${cName[1]}`;
	const user = path.match(/^\/user\/([^/]+)$/);
	if (user) return `https://www.youtube.com/user/${user[1]}`;
	return null;
}

function stripTrackingParams(search: string): string {
	const params = new URLSearchParams(search);
	const keep = new URLSearchParams();
	for (const [key, value] of params.entries()) {
		if (TRACKING_PARAMS.has(key.toLowerCase())) continue;
		keep.append(key, value);
	}
	const out = keep.toString();
	return out ? `?${out}` : '';
}

function fallbackSlug(input: string): string {
	const cleaned = input.replace(/[^A-Za-z0-9._\-@]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
	return (cleaned || 'link').toLowerCase().slice(0, 100);
}
