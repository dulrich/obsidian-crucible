import { requestUrl } from 'obsidian';
import { parseTable } from './markdownTable';

export interface ChannelEntry {
	name: string;
	channelId: string;
	tags: string[];
	priority: 'low' | 'normal' | 'high';
}

export interface RemoteVideo {
	videoId: string;
	title: string;
	publishedAt: string;
	channelName: string;
	url: string;
}

const VIDEO_ID_RE = /([A-Za-z0-9_-]{11})/;
const URL_PATTERNS: RegExp[] = [
	/(?:youtube\.com\/watch\?[^"\s]*\bv=)([A-Za-z0-9_-]{11})/,
	/(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
	/(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
	/(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
];

export function extractVideoIdFromUrl(value: string): string | null {
	for (const re of URL_PATTERNS) {
		const m = value.match(re);
		if (m && m[1]) return m[1];
	}
	return null;
}

// The Channel column is sometimes authored as a markdown link — e.g.
// `[Acerola](https://www.youtube.com/@acerola)` — so the visible label is just
// the link text. Collapse that to the display name; otherwise the raw link leaks
// into the control-center table and (via resolveChannelFolder) into folder slugs.
export function channelDisplayName(raw: string): string {
	const trimmed = raw.trim();
	const match = trimmed.match(/^\[([^\]]+)\]\([^)]*\)$/);
	return (match?.[1] ?? trimmed).trim();
}

export function parseChannelsTable(content: string): ChannelEntry[] {
	const rows = parseTable(content, ['Channel', 'ID', 'Tags', 'Priority']);
	const entries: ChannelEntry[] = [];
	for (const row of rows) {
		const name = channelDisplayName((row.Channel ?? '').trim());
		const channelId = (row.ID ?? '').trim();
		if (!name || !channelId) continue;
		const rawPriority = (row.Priority ?? '').trim().toLowerCase();
		if (rawPriority === 'skip' || rawPriority === 'ignore') continue;
		if (!channelId.startsWith('UC')) continue;
		const tags = (row.Tags ?? '')
			.split(',')
			.map(t => t.trim())
			.filter(t => t.length > 0);
		const priority: ChannelEntry['priority'] =
			rawPriority === 'low' || rawPriority === 'high' ? rawPriority : 'normal';
		entries.push({ name, channelId, tags, priority });
	}
	return entries;
}

export const EXAMPLE_CHANNELS_TABLE = [
	'| Channel | ID | Tags | Priority |',
	'|---------|----|------|----------|',
	'| Example Name | UCxxxxxxxxxxxxxxxxxxxxxx | ai, research | normal |',
	'',
].join('\n');

export async function fetchChannelFeed(channelId: string): Promise<RemoteVideo[]> {
	const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
	const res = await requestUrl({ url, method: 'GET', throw: false });
	if (res.status !== 200) {
		throw new Error(`YouTube RSS ${channelId}: HTTP ${res.status}`);
	}
	return parseRssFeed(res.text);
}

export function parseRssFeed(xml: string): RemoteVideo[] {
	const parser = new DOMParser();
	const doc = parser.parseFromString(xml, 'text/xml');
	const parserError = doc.getElementsByTagName('parsererror');
	if (parserError.length > 0) {
		throw new Error('Failed to parse RSS XML');
	}
	const out: RemoteVideo[] = [];
	const entries = doc.getElementsByTagName('entry');
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		const videoId = textOf(entry, 'yt:videoId') ?? textOf(entry, 'videoId');
		if (!videoId || !VIDEO_ID_RE.test(videoId)) continue;
		const title = textOf(entry, 'title') ?? '(untitled)';
		const publishedAt = textOf(entry, 'published') ?? '';
		const author = entry.getElementsByTagName('author')[0];
		const channelName = author ? (textOf(author, 'name') ?? '') : '';
		out.push({
			videoId,
			title: title.trim(),
			publishedAt,
			channelName: channelName.trim(),
			url: `https://www.youtube.com/watch?v=${videoId}`,
		});
	}
	return out;
}

function textOf(parent: Element, tagName: string): string | null {
	const el = parent.getElementsByTagName(tagName)[0];
	if (!el) return null;
	return el.textContent;
}
