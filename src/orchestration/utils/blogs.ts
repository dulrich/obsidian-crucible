import { requestUrl } from 'obsidian';
import { parseTable } from './markdownTable';

export type BlogPriority = 'high' | 'normal' | 'low';
export type BlogMethod = 'rss';
export type BlogParseStatus = 'ok' | 'unsupported_method' | 'invalid';

export interface BlogEntry {
	name: string;
	link: string;
	method: BlogMethod;
	tags: string[];
	priority: BlogPriority;
}

export interface BlogRowError {
	name: string;
	link: string;
	method: string;
	reason: string;
}

export interface ParsedBlogsTable {
	entries: BlogEntry[];
	errors: BlogRowError[];
}

export interface RemotePost {
	postId: string;
	title: string;
	publishedAt: string;
	blogName: string;
	url: string;
}

const TRACKING_PARAM_RE = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$)/i;

export function parseBlogsTable(content: string): ParsedBlogsTable {
	const rows = parseTable(content, ['Name', 'Link', 'Method', 'Tags', 'Priority']);
	const entries: BlogEntry[] = [];
	const errors: BlogRowError[] = [];

	for (const row of rows) {
		const name = (row.Name ?? '').trim();
		const rawLink = (row.Link ?? '').trim();
		const rawMethod = (row.Method ?? '').trim().toLowerCase();
		const rawPriority = (row.Priority ?? '').trim().toLowerCase();

		if (!name || !rawLink) continue;

		if (rawPriority === 'skip' || rawPriority === 'ignore') continue;

		const link = extractLinkUrl(rawLink);
		if (!link || !/^https?:\/\//i.test(link)) {
			errors.push({ name, link: rawLink, method: rawMethod, reason: 'Link is not a valid http(s) URL.' });
			continue;
		}

		if (rawMethod !== 'rss') {
			errors.push({
				name,
				link,
				method: rawMethod || '(empty)',
				reason: `Method "${rawMethod || '(empty)'}" is not supported. Only "RSS" is supported in this version.`,
			});
			continue;
		}

		const tags = (row.Tags ?? '')
			.split(',')
			.map(t => t.trim())
			.filter(t => t.length > 0);

		const priority: BlogPriority =
			rawPriority === 'high' || rawPriority === 'low' ? rawPriority : 'normal';

		entries.push({ name, link, method: 'rss', tags, priority });
	}

	return { entries, errors };
}

export function extractLinkUrl(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return '';

	const md = trimmed.match(/^\[[^\]]*\]\(\s*<?([^)\s<>]+)>?\s*(?:"[^"]*"|'[^']*')?\s*\)$/);
	if (md && md[1]) return md[1].trim();

	const angle = trimmed.match(/^<([^>\s]+)>$/);
	if (angle && angle[1]) return angle[1].trim();

	return trimmed;
}

export const EXAMPLE_BLOGS_TABLE = [
	'| Name | Link | Method | Tags | Priority |',
	'|------|------|--------|------|----------|',
	'| Example Blog | https://example.com/feed.xml | RSS | research | normal |',
	'',
].join('\n');

export async function fetchBlogFeed(entry: BlogEntry): Promise<RemotePost[]> {
	const res = await requestUrl({ url: entry.link, method: 'GET', throw: false });
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`Blog feed ${entry.link}: HTTP ${res.status}`);
	}
	return parseRssOrAtom(res.text, entry.name);
}

export function parseRssOrAtom(xml: string, fallbackBlogName: string): RemotePost[] {
	const parser = new DOMParser();
	const doc = parser.parseFromString(xml, 'text/xml');
	const parserError = doc.getElementsByTagName('parsererror');
	if (parserError.length > 0) {
		throw new Error('Failed to parse feed XML');
	}

	if (doc.getElementsByTagName('item').length > 0) {
		return parseRssItems(doc, fallbackBlogName);
	}
	if (doc.getElementsByTagName('entry').length > 0) {
		return parseAtomEntries(doc, fallbackBlogName);
	}
	return [];
}

function parseRssItems(doc: Document, fallbackBlogName: string): RemotePost[] {
	const out: RemotePost[] = [];
	const channelName = textOfFirst(doc, 'channel', 'title')?.trim() || fallbackBlogName;
	const items = doc.getElementsByTagName('item');
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (!item) continue;
		const title = (textOf(item, 'title') ?? '(untitled)').trim();
		const link = (textOf(item, 'link') ?? '').trim();
		const guidRaw = textOf(item, 'guid');
		const guid = guidRaw ? guidRaw.trim() : '';
		const publishedAt = normalizePublishedAt(textOf(item, 'pubDate') ?? textOf(item, 'dc:date') ?? '');
		const url = link || guid;
		if (!url) continue;
		const postId = guid || postIdFromUrl(url);
		out.push({ postId, title, publishedAt, blogName: channelName, url });
	}
	return out;
}

function parseAtomEntries(doc: Document, fallbackBlogName: string): RemotePost[] {
	const out: RemotePost[] = [];
	const feedTitle = topLevelText(doc, 'feed', 'title')?.trim() || fallbackBlogName;
	const entries = doc.getElementsByTagName('entry');
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		const title = (textOf(entry, 'title') ?? '(untitled)').trim();
		const id = (textOf(entry, 'id') ?? '').trim();
		const linkHref = atomLinkHref(entry);
		const publishedAt = normalizePublishedAt(textOf(entry, 'published') ?? textOf(entry, 'updated') ?? '');
		const url = linkHref || id;
		if (!url) continue;
		const postId = id || postIdFromUrl(url);
		out.push({ postId, title, publishedAt, blogName: feedTitle, url });
	}
	return out;
}

export function normalizePublishedAt(raw: string | null | undefined): string {
	const trimmed = (raw ?? '').trim();
	if (!trimmed) return '';
	// Already ISO-like (YYYY-MM-DD…): keep as-is.
	if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed;
	const parsed = Date.parse(trimmed);
	if (!Number.isFinite(parsed)) return trimmed;
	const d = new Date(parsed);
	const y = d.getUTCFullYear();
	const m = String(d.getUTCMonth() + 1).padStart(2, '0');
	const day = String(d.getUTCDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

function atomLinkHref(entry: Element): string {
	const links = entry.getElementsByTagName('link');
	let alternate = '';
	let firstHref = '';
	for (let i = 0; i < links.length; i++) {
		const link = links[i];
		if (!link) continue;
		const href = link.getAttribute('href');
		if (!href) continue;
		if (!firstHref) firstHref = href;
		const rel = link.getAttribute('rel');
		if (!rel || rel === 'alternate') {
			alternate = href;
			break;
		}
	}
	return (alternate || firstHref).trim();
}

export function postIdFromUrl(url: string): string {
	try {
		const u = new URL(url);
		u.hash = '';
		const params = Array.from(u.searchParams.keys());
		for (const k of params) {
			if (TRACKING_PARAM_RE.test(k)) u.searchParams.delete(k);
		}
		let s = u.toString();
		if (s.endsWith('/')) s = s.slice(0, -1);
		return s;
	} catch {
		return url.trim();
	}
}

function textOf(parent: Element, tagName: string): string | null {
	const el = parent.getElementsByTagName(tagName)[0];
	if (!el) return null;
	return el.textContent;
}

function textOfFirst(doc: Document, parentTag: string, childTag: string): string | null {
	const parent = doc.getElementsByTagName(parentTag)[0];
	if (!parent) return null;
	return textOf(parent, childTag);
}

function topLevelText(doc: Document, parentTag: string, childTag: string): string | null {
	const parent = doc.getElementsByTagName(parentTag)[0];
	if (!parent) return null;
	for (let i = 0; i < parent.children.length; i++) {
		const child = parent.children[i];
		if (child && child.tagName === childTag) return child.textContent;
	}
	return null;
}
