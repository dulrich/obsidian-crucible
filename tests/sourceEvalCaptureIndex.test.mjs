import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), `crucible-source-eval-${process.pid}`);
const outfile = path.join(outdir, 'sourceEval.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const obsidianStub = {
	name: 'obsidian-test-stub',
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
			contents: [
				'export class TFile { constructor(path, content = "", fm = {}, cache = {}) { this.path = path; this.content = content; this.fm = fm; this.cache = cache; this.extension = path.split(".").pop() || ""; this.basename = path.split("/").pop().replace(/\\.[^.]+$/, ""); this.stat = { ctime: cache.ctime ?? 0, mtime: cache.mtime ?? 0 }; } }',
				'export class TFolder { constructor(path, children = []) { this.path = path; this.children = children; } }',
				'globalThis.__CrucibleTestTFile = TFile;',
				'globalThis.__CrucibleTestTFolder = TFolder;',
				'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
				'export function htmlToMarkdown(s) { return String(s ?? ""); }',
				'export function parseYaml() { return {}; }',
				'export function normalizePath(p) { return String(p ?? "").replace(/\\\\/g, "/").replace(/\\/+/g, "/"); }',
				'export function getAllTags(cache) { return cache?.tags ?? []; }',
				'export const Platform = { isMobile: false, isDesktop: true };',
			].join('\n'),
			loader: 'js',
		}));
	},
};

await esbuild.build({
	stdin: {
		contents: [
			"export * from './src/sourceEval/captureIndex';",
			"export * from './src/sourceEval/signals';",
		].join('\n'),
		resolveDir: process.cwd(),
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [obsidianStub],
	outfile,
	logLevel: 'silent',
});

const {
	computeCaptureIndex,
	isGeneratedPeriodNote,
	parseYtMetadataChannelFromLink,
	scanObservationSignals,
	parseEvalLabel,
} = await import(pathToFileURL(outfile).href);
const TFile = globalThis.__CrucibleTestTFile;
const TFolder = globalThis.__CrucibleTestTFolder;

test('computeCaptureIndex attributes capture notes from frontmatter and parses capture fields', async () => {
	const registry = file('core/Tracked Blogs.md', [
		'| Name | Link | Method | Tags | Priority |',
		'|------|------|--------|------|----------|',
		'| Acme | https://acme.example/feed.xml | RSS | tech | normal |',
	].join('\n'));
	const ytMetadata = file('_yt_metadata/UC_META/videoabc1234.md', '', {
		videoId: 'videoabc1234',
		channelId: 'UC_META',
	});
	const youtubeCapture = file('daily/day/2026-01-01/Youtube.md', '', {
		'yt-video-id': 'videoabc1234',
		'word-count': '1200',
		read: true,
		created: '2026-01-02',
		published: '2025-12-31',
		'eval-importance': 4,
		'eval-urgent': true,
		'eval-rated': '2026-07-03',
		'eval-tags': ['gold', '#reference'],
		'eval-skip': true,
	}, { tags: ['#clippings', '#transcript', '#refined'] });
	const youtubeFallback = file('daily/day/2026-01-01/Youtube fallback.md', '', {
		'yt-video-id': 'fallback123',
		'yt-metadata': '[[_yt_metadata/UC_LINK/fallback123]]',
	});
	const blogCapture = file('daily/day/2026-01-01/Blog.md', '', {
		source: 'https://acme.example/p/one?utm_source=newsletter',
		'word-count': 900,
		read: false,
		created: '2026-01-03',
	}, { tags: ['#blog', '#goldmine'] });
	const unattributed = file('daily/day/2026-01-01/Loose.md', '', {
		created: 'not a date',
	}, { tags: ['#clippings'] });
	const app = mockApp([registry, ytMetadata, youtubeCapture, youtubeFallback, blogCapture, unattributed]);
	const plugin = {
		settings: {
			dailyFolder: 'daily/day',
			orchestrationYoutubeMetadataRoot: '_yt_metadata',
			orchestrationBlogsNote: 'core/Tracked Blogs.md',
		},
	};

	const records = await computeCaptureIndex(app, plugin);
	assert.equal(records.length, 4);

	const yt = records.find(r => r.file.path === youtubeCapture.path);
	assert.equal(yt.source, 'youtube:UC_META');
	assert.equal(yt.wordCount, 1200);
	assert.equal(yt.read, true);
	assert.deepEqual(yt.tags, ['clippings', 'transcript', 'refined']);
	assert.equal(yt.isTranscript, true);
	assert.equal(yt.isRefined, true);
	assert.deepEqual(yt.label, {
		importance: 4,
		urgent: true,
		rated: '2026-07-03',
		tags: ['gold', 'reference'],
	});
	assert.equal(yt.evalSkip, true);

	const fallback = records.find(r => r.file.path === youtubeFallback.path);
	assert.equal(fallback.source, 'youtube:UC_LINK');

	const blog = records.find(r => r.file.path === blogCapture.path);
	assert.equal(blog.source, 'blog:https://acme.example/feed.xml');
	assert.equal(blog.wordCount, 900);
	assert.equal(blog.isTranscript, false);
	assert.equal(blog.label, null);
	assert.equal(blog.evalSkip, false);

	const loose = records.find(r => r.file.path === unattributed.path);
	assert.equal(loose.source, null);
	assert.equal(loose.created, 0);
});

test('computeCaptureIndex excludes generated daily notes but keeps nested capture notes', async () => {
	const registry = file('core/Tracked Blogs.md', [
		'| Name | Link | Method | Tags | Priority |',
		'|------|------|--------|------|----------|',
		'| Acme | https://acme.example/feed.xml | RSS | tech | normal |',
	].join('\n'));
	const dailyPeriod = file('daily/day/2026-01-01.md', '', {
		source: 'https://acme.example/p/daily',
	});
	const nestedCapture = file('daily/day/2026-01-01/Capture.md', '', {
		source: 'https://acme.example/p/capture',
	});
	const app = mockApp([registry, dailyPeriod, nestedCapture]);
	const plugin = {
		settings: {
			dailyFolder: 'daily/day',
			weeklyFolder: 'daily/week',
			monthlyFolder: 'daily/month',
			orchestrationYoutubeMetadataRoot: '_yt_metadata',
			orchestrationBlogsNote: 'core/Tracked Blogs.md',
		},
	};

	const records = await computeCaptureIndex(app, plugin);
	assert.deepEqual(records.map(r => r.file.path), [nestedCapture.path]);
});

test('isGeneratedPeriodNote matches exact daily weekly and monthly note paths only', () => {
	const settings = {
		dailyFolder: 'daily/day',
		weeklyFolder: 'daily/week',
		monthlyFolder: 'daily/month',
	};

	assert.equal(isGeneratedPeriodNote('daily/day/2026-01-01.md', settings), true);
	assert.equal(isGeneratedPeriodNote('daily/week/2026-W01.md', settings), true);
	assert.equal(isGeneratedPeriodNote('daily/month/2026-01.md', settings), true);
	assert.equal(isGeneratedPeriodNote('daily/day/2026-01-01/Capture.md', settings), false);
	assert.equal(isGeneratedPeriodNote('daily/week/2026-W01/Capture.md', settings), false);
	assert.equal(isGeneratedPeriodNote('daily/month/2026-01/Capture.md', settings), false);
});

test('parseEvalLabel accepts only useful eval frontmatter', () => {
	assert.equal(parseEvalLabel({}), null);
	assert.deepEqual(parseEvalLabel({
		'eval-importance': '5',
		'eval-urgent': false,
		'eval-rated': '2026-07-03',
		'eval-tags': 'gold,#revisit',
	}), {
		importance: 5,
		urgent: false,
		rated: '2026-07-03',
		tags: ['gold', 'revisit'],
	});
	assert.equal(parseEvalLabel({ 'eval-importance': 6 }), null);
});

test('parseYtMetadataChannelFromLink extracts the channel folder under the metadata root', () => {
	assert.equal(parseYtMetadataChannelFromLink('[[_yt_metadata/UC123/videoabc1234|Video]]', '_yt_metadata'), 'UC123');
	assert.equal(parseYtMetadataChannelFromLink('[[Other Root/UC123/videoabc1234]]', '_yt_metadata'), '');
});

test('scanObservationSignals counts monthly observation links and indented quote bullets', async () => {
	const target = file('daily/day/2026-01-01/Target.md');
	const other = file('daily/day/2026-01-01/Other.md');
	const monthlyContent = [
		'# Summary',
		'',
		'# Observations',
		'- [[daily/day/2026-01-01/Target|Target]]',
		'  - quote one',
		'  - quote two',
		'- [[daily/day/2026-01-01/Other]]',
		'  - other quote',
		'- no note link here',
		'  - ignored quote',
		'# Next',
		'- not part of observations',
	].join('\n');
	const monthly = file('daily/month/2026-06.md', monthlyContent, {}, {
		headings: headingsFor(monthlyContent),
	});
	const app = mockApp([target, other, monthly]);

	const observations = await scanObservationSignals(app, 'daily/month');
	assert.deepEqual(observations.get(target.path), { months: 1, quotes: 2 });
	assert.deepEqual(observations.get(other.path), { months: 1, quotes: 1 });
});

function file(path, content = '', fm = {}, cache = {}) {
	return new TFile(path, content, fm, cache);
}

function mockApp(files) {
	const byPath = new Map(files.map(f => [f.path, f]));
	return {
		vault: {
			getMarkdownFiles: () => files.filter(f => f.extension === 'md'),
			read: async f => f.content,
			cachedRead: async f => f.content,
			getAbstractFileByPath: p => byPath.get(p) ?? folderForPath(p, files),
		},
		metadataCache: {
			getFileCache: f => ({ frontmatter: f.fm ?? {}, tags: f.cache.tags ?? [], headings: f.cache.headings ?? [] }),
			getFirstLinkpathDest: (linkpath) => {
				const normalized = linkpath.endsWith('.md') ? linkpath : `${linkpath}.md`;
				return byPath.get(normalized) ?? byPath.get(linkpath) ?? null;
			},
		},
	};
}

function folderForPath(path, files) {
	const prefix = path.endsWith('/') ? path : `${path}/`;
	const children = [];
	for (const file of files) {
		if (!file.path.startsWith(prefix)) continue;
		const rest = file.path.slice(prefix.length);
		const slash = rest.indexOf('/');
		if (slash === -1) {
			children.push(file);
		} else {
			const childPath = `${prefix}${rest.slice(0, slash)}`;
			if (!children.some(child => child.path === childPath)) {
				children.push(folderForPath(childPath, files));
			}
		}
	}
	return children.length > 0 ? new TFolder(path, children) : null;
}

function headingsFor(content) {
	const headings = [];
	let offset = 0;
	for (const line of content.split('\n')) {
		const match = line.match(/^(#+)\s+(.+)$/);
		if (match) {
			headings.push({
				heading: match[2],
				level: match[1].length,
				position: {
					start: { offset },
					end: { offset: offset + line.length },
				},
			});
		}
		offset += line.length + 1;
	}
	return headings;
}
