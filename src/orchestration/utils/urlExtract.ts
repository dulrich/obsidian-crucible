export interface ExtractedUrl {
	raw: string;
}

const FENCED_CODE_RE = /(?:^|\n)(?:```|~~~)[\s\S]*?(?:\n(?:```|~~~)|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const WIKILINK_RE = /\[\[[^\]]*\]\]/g;
const MARKDOWN_LINK_RE = /\[(?:[^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL_RE = /\b(https?:\/\/[^\s<>"'`)\]]+)/g;
const TRAILING_PUNCT_RE = /[.,;:)\]'"\s]+$/;

export function extractUrls(content: string): ExtractedUrl[] {
	const stripped = content
		.replace(FENCED_CODE_RE, '\n')
		.replace(INLINE_CODE_RE, ' ')
		.replace(WIKILINK_RE, ' ');

	const found = new Set<string>();
	const out: ExtractedUrl[] = [];

	const masks: Array<[number, number]> = [];
	for (const match of stripped.matchAll(MARKDOWN_LINK_RE)) {
		const url = trimUrl(match[1] ?? '');
		if (!url) continue;
		const start = match.index ?? 0;
		masks.push([start, start + match[0].length]);
		if (!found.has(url)) {
			found.add(url);
			out.push({ raw: url });
		}
	}

	for (const match of stripped.matchAll(BARE_URL_RE)) {
		const start = match.index ?? 0;
		if (isInsideMask(start, masks)) continue;
		const url = trimUrl(match[1] ?? '');
		if (!url) continue;
		if (!found.has(url)) {
			found.add(url);
			out.push({ raw: url });
		}
	}

	return out;
}

function trimUrl(value: string): string {
	let out = value.trim();
	while (out.length > 0 && TRAILING_PUNCT_RE.test(out)) {
		out = out.replace(TRAILING_PUNCT_RE, '');
	}
	return out;
}

function isInsideMask(pos: number, masks: Array<[number, number]>): boolean {
	for (const [start, end] of masks) {
		if (pos >= start && pos < end) return true;
	}
	return false;
}
