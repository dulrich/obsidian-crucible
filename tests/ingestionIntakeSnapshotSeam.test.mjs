// WP-R4: proves src/ingestion/data/intakeSnapshot.ts's computeBlogIntakeRows /
// computeYoutubeIntakeRows are a genuine single-scan snapshot — the source of both the
// Uncaptured and Ignored public row shapes come from ONE call into the tracker-scan
// dependency (scanBlogsTrackerRuns / scanYoutubeTrackerRuns, ../src/orchestration/utils/
// feedIntake.ts), not two independent scan/join pipelines re-derived per projection.
//
// Same fixture and stub-App shape as tests/ingestionIgnoredRows.test.mjs (one blog, one
// channel, one "ignored but present" + one "aged out" id per source), bundled the same way
// (real compiled modules against a minimal obsidian stub written to a real node_modules/
// obsidian so `instanceof TFile`/`instanceof TFolder` checks match). The seam itself: the
// `feedIntake` import inside intakeSnapshot.ts is redirected (esbuild onResolve) to a thin
// counting wrapper that delegates to the REAL feedIntake.ts (bundled separately, unstubbed)
// and increments a call counter around scanBlogsTrackerRuns/scanYoutubeTrackerRuns only —
// every other feedIntake export passes straight through unchanged.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-intake-snapshot-seam-tests');
const obsidianDir = path.join(outdir, 'node_modules', 'obsidian');
const obsidianEntry = path.join(obsidianDir, 'index.mjs');
const outfile = path.join(outdir, 'intakeSnapshot.mjs');

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

const feedIntakeAbsPath = path.resolve('src/orchestration/utils/feedIntake.ts');

await esbuild.build({
	entryPoints: ['src/ingestion/data/intakeSnapshot.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	external: ['obsidian'],
	plugins: [{
		name: 'feed-intake-scan-counter',
		setup(build) {
			// Redirect ONLY intakeSnapshot.ts's own `feedIntake` import into a counting
			// wrapper namespace; every other resolution (obsidian, blogsApi.ts,
			// youtubeApi.ts, blogs.ts, ignoredIds.ts, feedSources.ts, ...) is untouched.
			build.onResolve({ filter: /\/orchestration\/utils\/feedIntake$/ }, args => {
				if (!args.importer.includes(`${path.sep}data${path.sep}intakeSnapshot.ts`)) return null;
				return { path: 'feed-intake-scan-counter-stub', namespace: 'feed-intake-scan-counter-ns' };
			});
			build.onLoad({ filter: /.*/, namespace: 'feed-intake-scan-counter-ns' }, () => ({
				contents: [
					`import * as real from ${JSON.stringify(feedIntakeAbsPath)};`,
					'globalThis.__scanSeamCallCounts = globalThis.__scanSeamCallCounts ?? { blogs: 0, youtube: 0 };',
					'export const buildBlogsSeenIdSet = real.buildBlogsSeenIdSet;',
					'export const buildYoutubeSeenIdSet = real.buildYoutubeSeenIdSet;',
					'export const feedSeenExtraSkipPrefixes = real.feedSeenExtraSkipPrefixes;',
					'export const loadConfiguredBlogs = real.loadConfiguredBlogs;',
					'export const loadConfiguredChannels = real.loadConfiguredChannels;',
					'export async function scanBlogsTrackerRuns(...args) {',
					'  globalThis.__scanSeamCallCounts.blogs++;',
					'  return real.scanBlogsTrackerRuns(...args);',
					'}',
					'export async function scanYoutubeTrackerRuns(...args) {',
					'  globalThis.__scanSeamCallCounts.youtube++;',
					'  return real.scanYoutubeTrackerRuns(...args);',
					'}',
					'',
				].join('\n'),
				loader: 'js',
				resolveDir: path.dirname(feedIntakeAbsPath),
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { computeBlogIntakeRows, computeYoutubeIntakeRows } = await import(pathToFileURL(outfile).href);
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
// Same fixture shape as tests/ingestionIgnoredRows.test.mjs: one blog + one channel, each
// with a captured / ignored-but-present / plain-uncaptured item, plus one ignored id per
// source with no bullet anywhere ("aged out").

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

/* ------------------------------------------------------------------------ tests */

test('computeBlogIntakeRows calls scanBlogsTrackerRuns exactly once and its single scan supplies both projections', async () => {
	globalThis.__scanSeamCallCounts = { blogs: 0, youtube: 0 };

	const { uncaptured, ignored } = await computeBlogIntakeRows(app, plugin);

	assert.equal(globalThis.__scanSeamCallCounts.blogs, 1, 'one canonical scan pass, not one per projection');

	assert.equal(uncaptured.length, 1);
	assert.equal(uncaptured[0].postId, 'https://bloga.example/p/plain');

	assert.equal(ignored.length, 2);
	assert.equal(ignored[0].id, 'https://bloga.example/p/ignored-present');
	assert.equal(ignored[0].title, 'Ignored But Present');
	assert.equal(ignored[1].id, 'https://bloga.example/p/aged-out');
	assert.equal(ignored[1].title, null, 'aged-out id still degrades to a bare-ID row');
});

test('computeYoutubeIntakeRows calls scanYoutubeTrackerRuns exactly once and its single scan supplies both projections', async () => {
	globalThis.__scanSeamCallCounts = { blogs: 0, youtube: 0 };

	const { uncaptured, ignored } = await computeYoutubeIntakeRows(app, plugin);

	assert.equal(globalThis.__scanSeamCallCounts.youtube, 1, 'one canonical scan pass, not one per projection');

	assert.equal(uncaptured.length, 1);
	assert.equal(uncaptured[0].videoId, 'PLN00000001');

	assert.equal(ignored.length, 2);
	assert.equal(ignored[0].id, 'IGP00000001');
	assert.equal(ignored[0].durationSeconds, 754);
	assert.equal(ignored[1].id, 'AGE00000001');
	assert.equal(ignored[1].title, null, 'aged-out id still degrades to a bare-ID row');
});

test('two calls into the same source snapshot each still scan exactly once per call (no cross-call leakage in the counter)', async () => {
	globalThis.__scanSeamCallCounts = { blogs: 0, youtube: 0 };

	await computeBlogIntakeRows(app, plugin);
	await computeBlogIntakeRows(app, plugin);

	assert.equal(globalThis.__scanSeamCallCounts.blogs, 2, 'two independent calls, one scan apiece — never more than one scan per call');
});
