import { requestUrl } from 'obsidian';
import { parseTable } from './markdownTable';

export type BlogPriority = 'high' | 'normal' | 'low';
export type BlogMethod = 'rss';
export type BlogParseStatus = 'ok' | 'unsupported_method' | 'invalid';

// How a feed's per-item body is treated for ingest. `auto` (default) keys on whether the
// dedicated content element (content:encoded / atom <content>) is present and non-empty —
// presence, never length, so legitimately short posts still count. `full` trusts any body
// element (incl. <description>/<summary>). `snippet` never ingests a body (read + metadata only).
export type BlogBodyMode = 'full' | 'snippet' | 'auto';

export const BLOG_BODY_MODES: readonly BlogBodyMode[] = ['auto', 'full', 'snippet'];

export function normalizeBodyMode(raw: string | null | undefined): BlogBodyMode {
	const v = (raw ?? '').trim().toLowerCase();
	return (BLOG_BODY_MODES as readonly string[]).includes(v) ? (v as BlogBodyMode) : 'auto';
}

export type BlogPostKind = 'article' | 'podcast';

export interface BlogEntry {
	name: string;
	link: string;
	method: BlogMethod;
	tags: string[];
	priority: BlogPriority;
	canon: CanonMethod;
	body: BlogBodyMode;
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
	// Enrichment (see parseRssItems/parseAtomEntries). authors/categories default to [];
	// wordCount is null when no body; kind is 'podcast' iff an audio enclosure is present.
	authors: string[];
	categories: string[];
	wordCount: number | null;
	kind: BlogPostKind;
	hasBody: boolean;
	// Raw body HTML, populated only on a live feed fetch (never round-tripped through the
	// intake digest). Consumed at stage time; absent when reconstructed from a bullet.
	bodyHtml?: string;
	audioUrl?: string;
}

const TRACKING_PARAM_RE = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$)/i;

// How a post URL is reduced to a stable post-id. `auto` runs platform detection (CANON_RULES)
// and falls back to the conservative TRACKING_PARAM_RE denylist. The other three are explicit
// overrides for the per-blog Canon column when auto-detection picks the wrong shape.
export type CanonMethod = 'auto' | 'substack' | 'strip-params' | 'keep-params';

export const CANON_METHODS: readonly CanonMethod[] = ['auto', 'substack', 'strip-params', 'keep-params'];

export function normalizeCanonMethod(raw: string | null | undefined): CanonMethod {
	const v = (raw ?? '').trim().toLowerCase();
	return (CANON_METHODS as readonly string[]).includes(v) ? (v as CanonMethod) : 'auto';
}

function stripTrailingSlash(s: string): string {
	return s.endsWith('/') ? s.slice(0, -1) : s;
}

// Drop hash + every query param, keeping only origin + path. Used when the path slug already
// identifies the post (Substack /p/<slug>) so the params are pure tracking noise.
function bareSlug(u: URL): string {
	return stripTrailingSlash(`${u.origin}${u.pathname}`);
}

interface CanonRule {
	id: string;
	// Auto-detection by URL shape. Must be conservative: only match when the path slug is
	// known to fully identify the post, so dropping all params is safe.
	detect(u: URL): boolean;
	canonicalize(u: URL): string;
}

const SUBSTACK_SIGNATURE_PARAMS = ['post_id', 'publication_id', 'isFreemail', 'triedRedirect'];

// Substack publishes posts at /p/<slug>; the slug is canonical and email-notification links carry
// disposable params (publication_id, post_id, isFreemail, r, triedRedirect, utm_*). Keyed off URL
// shape, not hostname, so it also matches custom domains (e.g. emilkirkegaard.com).
const SUBSTACK_RULE: CanonRule = {
	id: 'substack',
	detect(u) {
		if (!/^\/p\/[^/]+\/?$/.test(u.pathname)) return false;
		if (SUBSTACK_SIGNATURE_PARAMS.some(p => u.searchParams.has(p))) return true;
		return u.searchParams.get('utm_source') === 'substack';
	},
	canonicalize: bareSlug,
};

const CANON_RULES: readonly CanonRule[] = [SUBSTACK_RULE];

function applyCanonMethod(u: URL, method: CanonMethod): string {
	u.hash = '';
	switch (method) {
		case 'keep-params':
			return stripTrailingSlash(u.toString());
		case 'strip-params':
			return bareSlug(u);
		case 'substack':
			return SUBSTACK_RULE.canonicalize(u);
		case 'auto':
		default: {
			const rule = CANON_RULES.find(r => r.detect(u));
			if (rule) return rule.canonicalize(u);
			for (const k of Array.from(u.searchParams.keys())) {
				if (TRACKING_PARAM_RE.test(k)) u.searchParams.delete(k);
			}
			return stripTrailingSlash(u.toString());
		}
	}
}

export function parseBlogsTable(content: string): ParsedBlogsTable {
	// Canon is an optional trailing column: request only the original five so 5-column tables still
	// match. parseTable keys rows by the actual header, so row.Canon is populated when present.
	// Canon and Body are optional trailing columns: request only the original five so older
	// tables still match. parseTable keys rows by the actual header, so row.Canon / row.Body
	// are populated when present.
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

		const canon = normalizeCanonMethod(row.Canon);
		const body = normalizeBodyMode(row.Body);

		entries.push({ name, link, method: 'rss', tags, priority, canon, body });
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

// Canon (optional): auto | substack | strip-params | keep-params. `auto` (default) detects the
// platform and otherwise strips only known tracking params; override when a feed's post URLs
// normalize differently (e.g. a param like article_id is the real id → keep-params).
// Body (optional): auto | full | snippet. Controls whether per-post bodies are ingestable.
export const EXAMPLE_BLOGS_TABLE = [
	'| Name | Link | Method | Tags | Priority | Canon | Body |',
	'|------|------|--------|------|----------|-------|------|',
	'| Example Blog | https://example.com/feed.xml | RSS | research | normal | auto | auto |',
	'',
].join('\n');

export async function fetchBlogFeed(entry: BlogEntry): Promise<RemotePost[]> {
	const res = await requestUrl({ url: entry.link, method: 'GET', throw: false });
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`Blog feed ${entry.link}: HTTP ${res.status}`);
	}
	return parseRssOrAtom(res.text, entry.name, entry.canon, entry.body);
}

export function parseRssOrAtom(
	xml: string,
	fallbackBlogName: string,
	canon: CanonMethod = 'auto',
	bodyMode: BlogBodyMode = 'auto',
): RemotePost[] {
	const parser = new DOMParser();
	const doc = parser.parseFromString(xml, 'text/xml');
	const parserError = doc.getElementsByTagName('parsererror');
	if (parserError.length > 0) {
		throw new Error('Failed to parse feed XML');
	}

	if (doc.getElementsByTagName('item').length > 0) {
		return parseRssItems(doc, fallbackBlogName, canon, bodyMode);
	}
	if (doc.getElementsByTagName('entry').length > 0) {
		return parseAtomEntries(doc, fallbackBlogName, canon, bodyMode);
	}
	return [];
}

function parseRssItems(doc: Document, fallbackBlogName: string, canon: CanonMethod, bodyMode: BlogBodyMode): RemotePost[] {
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
		const postId = guid || postIdFromUrl(url, { method: canon });
		// dc:creator is the Substack/RSS author element and may repeat; <author> is the rarer
		// RSS variant. Fall back to the configured blog name when neither is present.
		const authors = dedupeNonEmpty([
			...collectTexts(item, 'dc:creator'),
			...collectTexts(item, 'author'),
		]);
		const categories = dedupeNonEmpty(collectTexts(item, 'category'));
		const contentHtml = (textOf(item, 'content:encoded') ?? '').trim();
		const summaryHtml = (textOf(item, 'description') ?? '').trim();
		const audioUrl = rssAudioEnclosure(item);
		out.push(buildRemotePost({
			postId, title, publishedAt, blogName: channelName, url,
			authors, categories, contentHtml, summaryHtml, audioUrl, bodyMode,
		}));
	}
	return out;
}

function parseAtomEntries(doc: Document, fallbackBlogName: string, canon: CanonMethod, bodyMode: BlogBodyMode): RemotePost[] {
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
		const postId = id || postIdFromUrl(url, { method: canon });
		const authors = dedupeNonEmpty(atomAuthorNames(entry));
		const categories = dedupeNonEmpty(atomCategoryTerms(entry));
		const contentHtml = (textOf(entry, 'content') ?? '').trim();
		const summaryHtml = (textOf(entry, 'summary') ?? '').trim();
		const audioUrl = atomAudioEnclosure(entry);
		out.push(buildRemotePost({
			postId, title, publishedAt, blogName: feedTitle, url,
			authors, categories, contentHtml, summaryHtml, audioUrl, bodyMode,
		}));
	}
	return out;
}

interface RemotePostParts {
	postId: string;
	title: string;
	publishedAt: string;
	blogName: string;
	url: string;
	authors: string[];
	categories: string[];
	contentHtml: string;
	summaryHtml: string;
	audioUrl: string;
	bodyMode: BlogBodyMode;
}

// Resolve body availability from the per-blog Body mode (presence-based, never length-based)
// and assemble the enriched RemotePost.
function buildRemotePost(p: RemotePostParts): RemotePost {
	let hasBody: boolean;
	let bodyHtml: string | undefined;
	if (p.bodyMode === 'snippet') {
		hasBody = false;
		bodyHtml = undefined;
	} else if (p.bodyMode === 'full') {
		bodyHtml = p.contentHtml || p.summaryHtml || undefined;
		hasBody = !!bodyHtml;
	} else {
		// auto: only the dedicated content element counts (a bare description/summary does not).
		bodyHtml = p.contentHtml || undefined;
		hasBody = !!bodyHtml;
	}
	const kind: BlogPostKind = p.audioUrl ? 'podcast' : 'article';
	const post: RemotePost = {
		postId: p.postId,
		title: p.title,
		publishedAt: p.publishedAt,
		blogName: p.blogName,
		url: p.url,
		authors: p.authors,
		categories: p.categories,
		wordCount: hasBody && bodyHtml ? countWords(bodyHtml) : null,
		kind,
		hasBody,
	};
	if (bodyHtml) post.bodyHtml = bodyHtml;
	if (p.audioUrl) post.audioUrl = p.audioUrl;
	return post;
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

export interface PostIdOptions {
	// Force a specific canonicalization (per-blog Canon override). Wins over hostRules.
	method?: CanonMethod;
	// hostname -> override, built from the blogs registry so a captured note's source URL can be
	// canonicalized the same way as its feed even though the note carries no blog context.
	hostRules?: Map<string, CanonMethod>;
}

export function postIdFromUrl(url: string, opts?: PostIdOptions): string {
	try {
		const u = new URL(url);
		let method: CanonMethod | undefined = opts?.method && opts.method !== 'auto' ? opts.method : undefined;
		if (!method) method = opts?.hostRules?.get(u.hostname);
		return applyCanonMethod(u, method ?? 'auto');
	} catch {
		return url.trim();
	}
}

// Build hostname -> CanonMethod from configured blogs (only non-auto overrides). Lets the seen-set
// ingestion path canonicalize captured-note source URLs with the same override as their feed.
export function buildBlogCanonHostMap(entries: readonly BlogEntry[]): Map<string, CanonMethod> {
	const map = new Map<string, CanonMethod>();
	for (const entry of entries) {
		if (entry.canon === 'auto') continue;
		try {
			map.set(new URL(entry.link).hostname, entry.canon);
		} catch {
			// ignore unparseable feed links
		}
	}
	return map;
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

// All text values for a (possibly repeated, possibly namespaced) child tag, trimmed.
function collectTexts(parent: Element, tagName: string): string[] {
	const els = parent.getElementsByTagName(tagName);
	const out: string[] = [];
	for (let i = 0; i < els.length; i++) {
		const t = els[i]?.textContent?.trim();
		if (t) out.push(t);
	}
	return out;
}

function dedupeNonEmpty(values: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of values) {
		const t = v.trim();
		if (!t || seen.has(t)) continue;
		seen.add(t);
		out.push(t);
	}
	return out;
}

// Atom authors: each <author> carries a <name> child.
function atomAuthorNames(entry: Element): string[] {
	const authors = entry.getElementsByTagName('author');
	const out: string[] = [];
	for (let i = 0; i < authors.length; i++) {
		const author = authors[i];
		if (!author) continue;
		const name = textOf(author, 'name')?.trim();
		if (name) out.push(name);
	}
	return out;
}

// Atom categories carry the label on the `term` attribute (text content is usually empty).
function atomCategoryTerms(entry: Element): string[] {
	const cats = entry.getElementsByTagName('category');
	const out: string[] = [];
	for (let i = 0; i < cats.length; i++) {
		const term = cats[i]?.getAttribute('term')?.trim() || cats[i]?.textContent?.trim();
		if (term) out.push(term);
	}
	return out;
}

// RSS podcasts attach the audio file via <enclosure type="audio/..." url="...">. The itunes:*
// channel tags are unreliable (Substack emits them on non-podcasts), so we key on the enclosure.
function rssAudioEnclosure(item: Element): string {
	const encs = item.getElementsByTagName('enclosure');
	for (let i = 0; i < encs.length; i++) {
		const enc = encs[i];
		if (!enc) continue;
		const type = (enc.getAttribute('type') || '').toLowerCase();
		const url = enc.getAttribute('url') || '';
		if (type.startsWith('audio/') && url) return url.trim();
	}
	return '';
}

// Atom podcasts use <link rel="enclosure" type="audio/..." href="...">.
function atomAudioEnclosure(entry: Element): string {
	const links = entry.getElementsByTagName('link');
	for (let i = 0; i < links.length; i++) {
		const link = links[i];
		if (!link) continue;
		if (link.getAttribute('rel') !== 'enclosure') continue;
		const type = (link.getAttribute('type') || '').toLowerCase();
		const href = link.getAttribute('href') || '';
		if (type.startsWith('audio/') && href) return href.trim();
	}
	return '';
}

// Word count from body HTML: strip tags, collapse whitespace, count tokens. A rough display
// metric only — never used to decide whether a post has a body.
export function countWords(html: string): number {
	const text = html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&[a-z]+;|&#\d+;/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) return 0;
	return text.split(' ').length;
}

// Enrichment fields are encoded as a trailing HTML comment on the intake bullet so they survive
// the digest round-trip without breaking the existing `- **Title** — published <date> — <url>`
// parse (which captures the URL as \S+ and stops at the space before the comment). Values are
// URL-encoded, so commas/spaces/pipes in authors or categories never collide with delimiters.
export function buildBlogBulletSuffix(post: RemotePost): string {
	const a = post.authors.map(encodeURIComponent).join(',');
	const c = post.categories.map(encodeURIComponent).join(',');
	const w = post.wordCount == null ? '' : String(post.wordCount);
	const b = post.hasBody ? '1' : '0';
	return ` <!--crucible v=1 a=${a} c=${c} w=${w} t=${post.kind} b=${b}-->`;
}

export interface BlogBulletMeta {
	authors: string[];
	categories: string[];
	wordCount: number | null;
	kind: BlogPostKind;
	hasBody: boolean;
}

export function parseBlogBulletMeta(line: string): BlogBulletMeta | null {
	const m = line.match(/<!--crucible (.*?)-->/);
	if (!m || !m[1]) return null;
	const fields: Record<string, string> = {};
	for (const tok of m[1].trim().split(/\s+/)) {
		const eq = tok.indexOf('=');
		if (eq < 0) continue;
		fields[tok.slice(0, eq)] = tok.slice(eq + 1);
	}
	const decodeList = (raw: string | undefined): string[] =>
		raw ? raw.split(',').filter(Boolean).map(decodeURIComponent) : [];
	const w = fields.w ? Number(fields.w) : NaN;
	return {
		authors: decodeList(fields.a),
		categories: decodeList(fields.c),
		wordCount: Number.isFinite(w) ? w : null,
		kind: fields.t === 'podcast' ? 'podcast' : 'article',
		hasBody: fields.b === '1',
	};
}
