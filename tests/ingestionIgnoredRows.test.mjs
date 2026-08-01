// WP-IC2: computeIgnoredPostRows / computeIgnoredVideoRows (src/ingestion/data/ignored.ts)
// and the Uncaptured-output regression pin (src/ingestion/data/uncaptured.ts, untouched
// except two functions gaining an `export` for reuse — see that file's comments).
//
// Both compute functions pull in the real feedIntake.ts/blogsApi.ts/youtubeApi.ts/blogs.ts/
// youtube.ts dependency graph (same shape as tests/missingAttachments.test.mjs), so this
// drives the real compiled modules against a minimal mock App/TFile/TFolder — written to a
// real node_modules/obsidian (external, not inlined) so `instanceof TFile`/`instanceof
// TFolder` checks inside blogsApi.ts/youtubeApi.ts match the SAME classes the compiled
// modules import.
//
// One shared fixture (one blog, one channel) drives all four scenarios in parallel:
//   - "Captured …" — already has a real vault note; excluded from every scan (seen).
//   - "Ignored But Present …" — in the ignored note AND still in tracker-run data:
//     Uncaptured excludes it (ignored ids fold into its seen set); Ignored surfaces it as a
//     full joined row (partition correctness).
//   - "Plain Uncaptured …" — neither captured nor ignored: only Uncaptured surfaces it.
//   - an ignored id with NO bullet anywhere ("aged out" of tracker retention): Ignored
//     degrades it to a bare-ID row (every other field null) instead of dropping it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-ignored-rows-tests');
const obsidianDir = path.join(outdir, 'node_modules', 'obsidian');
const obsidianEntry = path.join(obsidianDir, 'index.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(obsidianDir, { recursive: true });

await writeFile(
	path.join(obsidianDir, 'package.json'),
	JSON.stringify({ name: 'obsidian', type: 'module', main: 'index.mjs' }),
);
await writeFile(
	obsidianEntry,
	[
		'export class App {}',
		'export class TFile {}',
		'export class TFolder {}',
		'export class Editor {}',
		'export class MarkdownView {}',
		'export class Notice { constructor() {} }',
		'export const Platform = { isMobile: false, isMacOS: false, isDesktopApp: true, isMobileApp: false };',
		'export const moment = Object.assign(() => ({ format: () => "2026-07-31" }), { format: () => "2026-07-31" });',
		'export function normalizePath(p) { return String(p).replace(/\\\\+/g, "/"); }',
		'export function requestUrl() { throw new Error("requestUrl not implemented in test stub"); }',
		'export function htmlToMarkdown(html) { return String(html); }',
		'export function stringifyYaml(v) { return JSON.stringify(v); }',
		'export function parseYaml(s) { return JSON.parse(s); }',
		'',
	].join('\n'),
);

async function bundle(entry, outfile) {
	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'es2020',
		external: ['obsidian'],
		outfile,
		logLevel: 'silent',
	});
	return import(pathToFileURL(outfile).href);
}

const { computeUncapturedPostRows, computeUncapturedVideoRows } =
	await bundle('src/ingestion/data/uncaptured.ts', path.join(outdir, 'uncaptured.mjs'));
const { computeIgnoredPostRows, computeIgnoredVideoRows } =
	await bundle('src/ingestion/data/ignored.ts', path.join(outdir, 'ignored.mjs'));

const { TFile, TFolder } = await import(pathToFileURL(obsidianEntry).href);

/* -------------------------------------------------------------------- fake vault */

function makeFile(p) {
	const f = new TFile();
	f.path = p;
	const slash = p.lastIndexOf('/');
	f.name = slash >= 0 ? p.slice(slash + 1) : p;
	const dot = f.name.lastIndexOf('.');
	f.basename = dot >= 0 ? f.name.slice(0, dot) : f.name;
	f.extension = dot >= 0 ? f.name.slice(dot + 1) : '';
	return f;
}

function makeFolder(p, children) {
	const fo = new TFolder();
	fo.path = p;
	fo.children = children;
	return fo;
}

function makeApp({ markdownFiles, pathIndex, contentByPath, frontmatterByPath }) {
	return {
		vault: {
			getMarkdownFiles: () => markdownFiles,
			getAbstractFileByPath: p => pathIndex.get(p) ?? null,
			read: async file => contentByPath.get(file.path) ?? '',
			cachedRead: async file => contentByPath.get(file.path) ?? '',
		},
		metadataCache: {
			getFileCache: file => {
				const fm = frontmatterByPath.get(file.path);
				return fm === undefined ? null : { frontmatter: fm };
			},
		},
	};
}

/* --------------------------------------------------------------------- fixture */

const CHANNEL_ID = 'UCAAAAAAAAAAAAAAAAAAAAAA';

const blogsRegistry = makeFile('registry/blogs.md');
const channelsRegistry = makeFile('registry/channels.md');
const capturedPost = makeFile('Notes/captured-post.md');
const capturedVideo = makeFile('Notes/captured-video.md');
const blogsRun = makeFile('_crucible/orchestration/blogs/new-posts/run1.md');
const videosRun = makeFile('_crucible/orchestration/youtube/new-videos/run1.md');
const aboutFile = makeFile('_yt_metadata/channel-a/about.md');
const enrichmentFile = makeFile('_yt_metadata/channel-a/IGP00000001.md');
const channelFolder = makeFolder('_yt_metadata/channel-a', []);
const ytMetadataRoot = makeFolder('_yt_metadata', [channelFolder]);

const pathIndex = new Map([
	[blogsRegistry.path, blogsRegistry],
	[channelsRegistry.path, channelsRegistry],
	['_yt_metadata', ytMetadataRoot],
	['_yt_metadata/channel-a', channelFolder],
	[aboutFile.path, aboutFile],
	[enrichmentFile.path, enrichmentFile],
]);

const contentByPath = new Map([
	[blogsRegistry.path, [
		'| Name | Link | Method | Tags | Priority |',
		'|------|------|--------|------|----------|',
		'| Blog A | https://bloga.example/feed | rss |  | normal |',
		'',
	].join('\n')],
	[channelsRegistry.path, [
		'| Channel | ID | Tags | Priority |',
		'|---------|----|------|----------|',
		`| Channel A | ${CHANNEL_ID} |  | normal |`,
		'',
	].join('\n')],
	[blogsRun.path, [
		'## Blog A (https://bloga.example/feed)',
		'- **Captured Post** — published 2026-06-01 — https://bloga.example/p/captured',
		'- **Ignored But Present** — published 2026-06-15 — https://bloga.example/p/ignored-present',
		'- **Plain Uncaptured** — published 2026-06-20 — https://bloga.example/p/plain',
		'',
	].join('\n')],
	[videosRun.path, [
		`## Channel A (${CHANNEL_ID})`,
		'- **Captured Video** — published 2026-06-01 — https://youtu.be/CAP00000001',
		'- **Ignored But Present** — published 2026-06-15 — https://youtu.be/IGP00000001',
		'- **Plain Uncaptured** — published 2026-06-20 — https://youtu.be/PLN00000001',
		'',
	].join('\n')],
]);

const frontmatterByPath = new Map([
	[capturedPost.path, { 'post-id': 'https://bloga.example/p/captured' }],
	[capturedVideo.path, { 'yt-video-id': 'CAP00000001' }],
	[blogsRun.path, { generated_by: 'orchestrator/blogs_tracker' }],
	[videosRun.path, { generated_by: 'orchestrator/youtube_tracker' }],
	[aboutFile.path, { channelId: CHANNEL_ID, title: 'Channel A' }],
	[enrichmentFile.path, { duration_seconds: 754 }],
]);

const markdownFiles = [capturedPost, capturedVideo, blogsRun, videosRun];

const app = makeApp({ markdownFiles, pathIndex, contentByPath, frontmatterByPath });

const IGNORED_IDS_NOTE = '_crucible/orchestration/ignored.md';
const ignoredIdsFile = makeFile(IGNORED_IDS_NOTE);
pathIndex.set(IGNORED_IDS_NOTE, ignoredIdsFile);
contentByPath.set(IGNORED_IDS_NOTE, [
	'## Videos',
	'- IGP00000001',
	'- AGE00000001',
	'',
	'## Blogs',
	'- https://bloga.example/p/ignored-present',
	'- https://bloga.example/p/aged-out',
	'',
].join('\n'));

const plugin = {
	settings: {
		orchestrationBlogsNote: blogsRegistry.path,
		orchestrationYoutubeChannelsNote: channelsRegistry.path,
	},
};

/* ------------------------------------------------------------- uncaptured (regression) */

test('computeUncapturedPostRows is unchanged by this WP: only the plain uncaptured post shows', async () => {
	const rows = await computeUncapturedPostRows(app, plugin);
	assert.deepEqual(rows, [{
		postId: 'https://bloga.example/p/plain',
		blogName: 'Blog A',
		blogLink: 'https://bloga.example/feed',
		title: 'Plain Uncaptured',
		publishedAt: '2026-06-20',
		url: 'https://bloga.example/p/plain',
		authors: [],
		categories: [],
		wordCount: null,
		kind: 'article',
		hasBody: false,
		metadataFile: null,
	}]);
});

test('computeUncapturedVideoRows is unchanged by this WP: only the plain uncaptured video shows', async () => {
	const rows = await computeUncapturedVideoRows(app, plugin);
	assert.deepEqual(rows, [{
		videoId: 'PLN00000001',
		channelName: 'Channel A',
		channelId: CHANNEL_ID,
		channelAboutFile: aboutFile,
		title: 'Plain Uncaptured',
		publishedAt: '2026-06-20',
		url: 'https://youtu.be/PLN00000001',
		durationSeconds: null,
		enrichmentFile: null,
	}]);
});

/* --------------------------------------------------------- ignored: partition + degrade */

test('computeIgnoredPostRows: partition — ignored id present in tracker data joins a full row', async () => {
	const rows = await computeIgnoredPostRows(app, plugin);
	assert.equal(rows.length, 2);
	assert.deepEqual(rows[0], {
		id: 'https://bloga.example/p/ignored-present',
		title: 'Ignored But Present',
		blogName: 'Blog A',
		publishedAt: '2026-06-15',
		url: 'https://bloga.example/p/ignored-present',
		kind: 'article',
		wordCount: null,
		metadataFile: null,
	});
});

test('computeIgnoredPostRows: degrade — an ignored id absent from tracker data is a bare-ID row', async () => {
	const rows = await computeIgnoredPostRows(app, plugin);
	assert.deepEqual(rows[1], {
		id: 'https://bloga.example/p/aged-out',
		title: null,
		blogName: null,
		publishedAt: null,
		url: null,
		kind: null,
		wordCount: null,
		metadataFile: null,
	});
});

test('computeIgnoredPostRows: the plain uncaptured post (never ignored) does not appear', async () => {
	const rows = await computeIgnoredPostRows(app, plugin);
	assert.ok(!rows.some(r => r.id === 'https://bloga.example/p/plain'));
});

test('computeIgnoredVideoRows: partition — ignored id present in tracker data joins a full row, including metadata (channel about + enrichment duration)', async () => {
	const rows = await computeIgnoredVideoRows(app, plugin);
	assert.equal(rows.length, 2);
	assert.deepEqual(rows[0], {
		id: 'IGP00000001',
		title: 'Ignored But Present',
		channelName: 'Channel A',
		publishedAt: '2026-06-15',
		url: 'https://youtu.be/IGP00000001',
		durationSeconds: 754,
		channelAboutFile: aboutFile,
		enrichmentFile,
	});
});

test('computeIgnoredVideoRows: degrade — an ignored id absent from tracker data is a bare-ID row', async () => {
	const rows = await computeIgnoredVideoRows(app, plugin);
	assert.deepEqual(rows[1], {
		id: 'AGE00000001',
		title: null,
		channelName: null,
		publishedAt: null,
		url: null,
		durationSeconds: null,
		channelAboutFile: null,
		enrichmentFile: null,
	});
});

test('computeIgnoredVideoRows: the plain uncaptured video (never ignored) does not appear', async () => {
	const rows = await computeIgnoredVideoRows(app, plugin);
	assert.ok(!rows.some(r => r.id === 'PLN00000001'));
});

/* ------------------------------------------------------------------ structural pins */
// No pure seam covers the section's column set / action-cell composition (renderTableSection
// takes DOM `td` elements) — pinned as source text instead, same shape as
// tests/ingestionIntakeActionCell.test.mjs's structural block.

const sectionSrc = readFileSync('src/ingestion/sections/ignored.ts', 'utf8');

test('renderIgnoredPosts: reuses IC1 helpers (renderExternalLink + renderUnignoreButton), not a parallel action renderer', () => {
	assert.match(sectionSrc, /renderExternalLink\(td, url, 'read'\)/);
	assert.match(sectionSrc, /renderUnignoreButton\(td, host, 'blog', row\.id, 'ignoredPosts', 'uncapturedPosts', ctx\)/);
});

test('renderIgnoredVideos: reuses IC1 helpers (renderExternalLink + renderUnignoreButton), not a parallel action renderer', () => {
	assert.match(sectionSrc, /renderExternalLink\(td, url, 'watch'\)/);
	assert.match(sectionSrc, /renderUnignoreButton\(td, host, 'youtube', row\.id, 'ignoredVideos', 'uncapturedVideos', ctx\)/);
});

test('both action cells use the shared .crucible-intake-action-cell class', () => {
	const matches = sectionSrc.match(/td\.addClass\('crucible-intake-action-cell'\)/g) ?? [];
	assert.equal(matches.length, 2);
});

test('Ignored Posts columns read Author/Title/Type/Words/Publish Date (minus Ingest/Enrich)', () => {
	for (const label of ["label: 'Author'", "label: 'Title'", "label: 'Type'", "label: 'Words'", "label: 'Publish Date'"]) {
		assert.ok(sectionSrc.includes(label), `missing column label: ${label}`);
	}
	assert.ok(!sectionSrc.includes("'Ingest'"));
});

test('Ignored Videos columns read Creator/Title/Publish Date/Duration (minus Enrich)', () => {
	for (const label of ["label: 'Creator'", "label: 'Title'", "label: 'Publish Date'", "label: 'Duration'"]) {
		assert.ok(sectionSrc.includes(label), `missing column label: ${label}`);
	}
	assert.ok(!sectionSrc.includes("'Enrich'"));
});

test('default sort is publishedAt desc for both sections (degrade rows carry a null publishedAt, which sorts last)', () => {
	const matches = sectionSrc.match(/defaultSort: \{ column: 'publishedAt', direction: 'desc' \}/g) ?? [];
	assert.equal(matches.length, 2);
});
