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

// Shared 11-char id shape check — used both for URL extraction below and to validate
// ids read straight off a Data API response (playlistItems, frontmatter) where there's
// no URL to parse. Deliberately unanchored: callers pass an already-isolated id string.
export const VIDEO_ID_RE = /([A-Za-z0-9_-]{11})/;
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

