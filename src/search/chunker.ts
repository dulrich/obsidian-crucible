import { SearchChunk, SearchDocumentMetadata } from './types';

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * Default indexable extensions — exactly the pre-WP-4 hardcoded set, kept as the default
 * parameter below so upgrade behavior is unchanged for any caller that doesn't yet pass
 * the settings-driven list, and so the existing `isSearchIndexablePath('x.md')`-style
 * tests keep passing unmodified.
 */
const DEFAULT_SEARCH_EXTENSIONS = ['md', 'qmd', 'txt'];

export interface BuildChunksInput {
	vaultId: string;
	path: string;
	basename: string;
	extension: string;
	mtime: number;
	content: string;
	contentHash?: string;
	maxChars: number;
	overlapChars: number;
}

/**
 * `chunker.ts` is a pure, settings-free module (unit-tested by bundling it standalone —
 * see `tests/searchChunker.test.mjs`), so the indexable-extensions list is threaded in
 * rather than imported from plugin state. Every real caller passes
 * `plugin.settings.searchIndexExtensions`; the default here only covers call sites (and
 * tests) that don't have settings in scope.
 */
export function isSearchIndexablePath(path: string, extensions: string[] = DEFAULT_SEARCH_EXTENSIONS): boolean {
	const filename = path.split('/').pop() ?? '';
	const dot = filename.lastIndexOf('.');
	if (!(dot > 0 && dot < filename.length - 1)) return false;
	const ext = filename.slice(dot + 1).toLowerCase();
	// Unlike the palette's extension filter, an empty list here means "index nothing" —
	// a user can legitimately uncheck every indexable type. Only an *omitted* argument
	// (call sites with no settings in scope, and legacy tests) falls back to the default.
	return extensions.some(candidate => candidate.toLowerCase() === ext);
}

export function buildSearchChunks(input: BuildChunksInput): SearchChunk[] {
	const maxChars = Math.max(400, input.maxChars || 1800);
	const overlapChars = Math.max(0, Math.min(input.overlapChars || 0, Math.floor(maxChars / 3)));
	const { body, metadata } = parseSearchDocument(input.content, input.basename);
	const contentHash = input.contentHash ?? hashSearchContent(input.content);
	const sections = splitSections(body);
	const chunks: SearchChunk[] = [];
	let ordinal = 0;

	for (const section of sections) {
		for (const text of chunkText(section.text, maxChars, overlapChars)) {
			const trimmed = text.trim();
			if (!trimmed) continue;
			chunks.push({
				id: stableChunkId(input.path, ordinal, section.heading),
				vaultId: input.vaultId,
				path: input.path,
				contentHash,
				title: metadata.title,
				heading: section.heading,
				text: trimmed,
				mtime: input.mtime,
				ordinal,
				metadata,
			});
			ordinal++;
		}
	}

	return chunks;
}

export function hashSearchContent(content: string): string {
	return hashString(content);
}

export function parseSearchDocument(content: string, fallbackTitle: string): { body: string; metadata: SearchDocumentMetadata } {
	const fmMatch = content.match(FRONTMATTER_RE);
	const frontmatterText = fmMatch?.[1] ?? '';
	const body = fmMatch ? content.slice(fmMatch[0].length) : content;
	const frontmatter = parseSimpleFrontmatter(frontmatterText);
	const firstHeading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
	const title = stringValue(frontmatter.title) || firstHeading || fallbackTitle;
	const tags = normalizeTags(frontmatter.tags);
	return {
		body,
		metadata: {
			title,
			created: stringValue(frontmatter.created),
			modified: stringValue(frontmatter.modified),
			source: stringValue(frontmatter.source),
			tags,
			frontmatter,
		},
	};
}

function splitSections(body: string): { heading: string; text: string }[] {
	const sections: { heading: string; lines: string[] }[] = [{ heading: '', lines: [] }];
	for (const line of body.split(/\r?\n/)) {
		const heading = line.match(HEADING_RE);
		if (heading) {
			sections.push({ heading: (heading[2] ?? '').trim(), lines: [line] });
		} else {
			const current = sections[sections.length - 1];
			if (current) current.lines.push(line);
		}
	}
	return sections
		.map(section => ({ heading: section.heading, text: section.lines.join('\n').trim() }))
		.filter(section => section.text.length > 0);
}

function chunkText(text: string, maxChars: number, overlapChars: number): string[] {
	if (text.length <= maxChars) return [text];
	const paragraphs = text.split(/\n{2,}/);
	const chunks: string[] = [];
	let current = '';

	for (const paragraph of paragraphs) {
		const next = current ? `${current}\n\n${paragraph}` : paragraph;
		if (next.length <= maxChars) {
			current = next;
			continue;
		}
		if (current) chunks.push(current);
		if (paragraph.length <= maxChars) {
			current = tailOverlap(current, overlapChars);
			current = current ? `${current}\n\n${paragraph}` : paragraph;
		} else {
			for (const slice of sliceLongText(paragraph, maxChars, overlapChars)) chunks.push(slice);
			current = '';
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

function sliceLongText(text: string, maxChars: number, overlapChars: number): string[] {
	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		const end = Math.min(text.length, start + maxChars);
		chunks.push(text.slice(start, end));
		if (end === text.length) break;
		start = Math.max(end - overlapChars, start + 1);
	}
	return chunks;
}

function tailOverlap(text: string, overlapChars: number): string {
	if (!text || overlapChars <= 0) return '';
	return text.slice(Math.max(0, text.length - overlapChars));
}

function stableChunkId(path: string, ordinal: number, heading: string): string {
	return `${path}#${ordinal}:${hashString(`${path}\n${heading}\n${ordinal}`)}`;
}

function hashString(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

function parseSimpleFrontmatter(text: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!text) return out;
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		const key = match[1] ?? '';
		const raw = (match[2] ?? '').trim();
		if (!key) continue;
		if (raw === '') {
			const values: string[] = [];
			while (i + 1 < lines.length) {
				const nextLine = lines[i + 1];
				if (nextLine === undefined) break;
				const item = nextLine.match(/^\s*-\s+(.+)$/);
				if (!item) break;
				values.push(unquote((item[1] ?? '').trim()));
				i++;
			}
			out[key] = values.length > 0 ? values : '';
		} else if (raw.startsWith('[') && raw.endsWith(']')) {
			out[key] = raw.slice(1, -1).split(',').map(v => unquote(v.trim())).filter(Boolean);
		} else {
			out[key] = unquote(raw);
		}
	}
	return out;
}

function normalizeTags(value: unknown): string[] {
	if (Array.isArray(value)) return value.map(v => String(v).replace(/^#/, '').trim()).filter(Boolean);
	if (typeof value === 'string') {
		return value.split(/[,\s]+/).map(v => v.replace(/^#/, '').trim()).filter(Boolean);
	}
	return [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function unquote(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}
