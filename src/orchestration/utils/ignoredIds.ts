import { App, TFile, normalizePath } from 'obsidian';
import { ensureFolder } from '../../utils';
import { extractVideoIdFromUrl } from './youtube';
import { postIdFromUrl } from './blogs';

// Bare ignored IDs live in a managed note under the orchestration scan-skip
// prefix, so the seen-set builders never pick it up during their vault scan —
// it is read explicitly via loadIgnored*Ids and folded into the seen set there.
export const IGNORED_IDS_NOTE = '_crucible/orchestration/ignored.md';

const VIDEOS_HEADER = '## Videos';
const BLOGS_HEADER = '## Blogs';

interface IgnoredSets {
	videos: Set<string>;
	blogs: Set<string>;
}

export async function loadIgnoredVideoIds(app: App): Promise<Set<string>> {
	return (await readIgnored(app)).videos;
}

export async function loadIgnoredBlogIds(app: App): Promise<Set<string>> {
	return (await readIgnored(app)).blogs;
}

export async function addIgnoredVideoId(app: App, id: string): Promise<void> {
	const canonical = canonicalizeVideoId(id);
	if (!canonical) return;
	await mutate(app, sets => { sets.videos.add(canonical); });
}

export async function removeIgnoredVideoId(app: App, id: string): Promise<void> {
	const canonical = canonicalizeVideoId(id);
	await mutate(app, sets => {
		sets.videos.delete(id.trim());
		if (canonical) sets.videos.delete(canonical);
	});
}

export async function addIgnoredBlogId(app: App, id: string): Promise<void> {
	const canonical = canonicalizeBlogId(id);
	if (!canonical) return;
	await mutate(app, sets => { sets.blogs.add(canonical); });
}

export async function removeIgnoredBlogId(app: App, id: string): Promise<void> {
	const canonical = canonicalizeBlogId(id);
	await mutate(app, sets => {
		sets.blogs.delete(id.trim());
		if (canonical) sets.blogs.delete(canonical);
	});
}

// Reads and parses the ignored note into canonicalized id sets. Returns empty
// sets when the note does not exist yet.
async function readIgnored(app: App): Promise<IgnoredSets> {
	const videos = new Set<string>();
	const blogs = new Set<string>();
	const file = app.vault.getAbstractFileByPath(normalizePath(IGNORED_IDS_NOTE));
	if (!(file instanceof TFile)) return { videos, blogs };

	const content = await app.vault.cachedRead(file);
	let section: 'videos' | 'blogs' | null = null;
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === VIDEOS_HEADER) { section = 'videos'; continue; }
		if (trimmed === BLOGS_HEADER) { section = 'blogs'; continue; }
		if (trimmed.startsWith('## ')) { section = null; continue; }
		if (!section) continue;
		const match = trimmed.match(/^-\s+(.*)$/);
		const value = match?.[1]?.trim();
		if (!value) continue;
		if (section === 'videos') {
			const v = canonicalizeVideoId(value);
			if (v) videos.add(v);
		} else {
			const b = canonicalizeBlogId(value);
			if (b) blogs.add(b);
		}
	}
	return { videos, blogs };
}

// Read-modify-write the whole note. Click-driven write volume is low, so a full
// deterministic re-serialize is simpler and safer than in-place section edits.
async function mutate(app: App, apply: (sets: IgnoredSets) => void): Promise<void> {
	const sets = await readIgnored(app);
	apply(sets);
	const body = serialize(sets);
	const path = normalizePath(IGNORED_IDS_NOTE);
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, body);
		return;
	}
	const lastSlash = path.lastIndexOf('/');
	if (lastSlash > 0) await ensureFolder(app, path.slice(0, lastSlash));
	await app.vault.create(path, body);
}

function serialize(sets: IgnoredSets): string {
	const lines: string[] = [
		'# Ignored ingestion IDs',
		'',
		'Bare IDs skipped by the trackers, the Ingestion Dashboard, and auto-enrich. Managed by',
		'Crucible — edit or remove an entry to un-ignore it.',
		'',
		VIDEOS_HEADER,
		'',
	];
	for (const id of sortIds(sets.videos)) lines.push(`- ${id}`);
	lines.push('', BLOGS_HEADER, '');
	for (const id of sortIds(sets.blogs)) lines.push(`- ${id}`);
	lines.push('');
	return lines.join('\n');
}

function sortIds(set: Set<string>): string[] {
	return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// A bare 11-char id is kept as-is; a full URL is reduced to its video id.
function canonicalizeVideoId(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (/^https?:\/\//i.test(trimmed)) return extractVideoIdFromUrl(trimmed);
	return trimmed;
}

// postIdFromUrl canonicalizes URLs (stripping tracking params/trailing slash)
// and returns the trimmed input unchanged for non-URL values.
function canonicalizeBlogId(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return '';
	return postIdFromUrl(trimmed);
}
