import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// WP-J2: `yt-metadata` is a LIST (mirroring `x-metadata`), the per-note bail is
// per-TARGET rather than any-link, a referenced-video mode stamps a second video onto a
// note, and a freshly created metadata note chains channel enrichment.
//
// The suite drives the real YoutubeMetadataFetchWorkflow end to end against an in-memory
// vault, exactly like tests/xMetadataFetchWorkflow.test.mjs: a FakeVault holding real
// note text, a metadataCache whose getFileCache is *live-derived* from that same text on
// every call (so `updateFrontmatter`'s stale-cache write barrier never has anything to
// wait on and every write lands through the real chokepoint), and a `requestUrl` stub
// standing in for the YouTube Data API's videos.list.

const outdir = path.join(tmpdir(), 'obsidian-crucible-yt-metadata-list-contract-tests');
const outfile = path.join(outdir, 'youtubeMetadataListContract.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { YoutubeMetadataFetchWorkflow } from './src/orchestration/workflows/YoutubeMetadataFetchWorkflow';",
			"export { referencedVideoJobParams } from './src/orchestration/jobTypeConfig';",
			"export { appendYtMetadataLink, isYtMetadataLinked, ytMetadataLinks } from './src/orchestration/utils/youtubeApi';",
			"export { TFile, TFolder } from 'obsidian';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'yt-metadata-list-contract-test-entry.ts',
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: [
					'export class App {}',
					'export class TFile { constructor() { this.path = ""; this.extension = "md"; } }',
					'export class TFolder { constructor() { this.path = ""; this.children = []; } }',
					'export function normalizePath(p) { return String(p ?? "").replace(/\\\\/g, "/").replace(/\\/+/g, "/"); }',
					'export async function requestUrl(options) { return await globalThis.__youtubeApiRespond(options); }',
					'export const Platform = {};',
					'export const moment = () => {};',
					'export function parseYaml() { return {}; }',
					'export function stringifyYaml() { return "\\n"; }',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	YoutubeMetadataFetchWorkflow,
	referencedVideoJobParams,
	appendYtMetadataLink,
	isYtMetadataLinked,
	ytMetadataLinks,
	TFile,
	TFolder,
} = await import(pathToFileURL(outfile).href);

const ROOT = '_yt_metadata';
const CHANNEL_ID = 'UCchannel00000000000001';
const CHANNEL_FOLDER = 'test-channel';
const OWN_VIDEO = 'ownvideo001';
const REF_VIDEO = 'refvideo001';
const REF_VIDEO_2 = 'refvideo002';

const metaPathFor = id => `${ROOT}/${CHANNEL_FOLDER}/${id}.md`;
const linkFor = id => `[[${ROOT}/${CHANNEL_FOLDER}/${id}]]`;

function normalizePath(p) {
	return String(p ?? '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

// videos.list responder: echoes back whatever `id=` the caller asked for, under one
// fixed channel. `fetchCount` is what proves the "found, not fetched" path.
let fetchCount = 0;
function serveVideosList({ channelId = CHANNEL_ID, channelTitle = 'Test Channel' } = {}) {
	fetchCount = 0;
	globalThis.__youtubeApiRespond = async options => {
		fetchCount++;
		const id = new URL(options.url).searchParams.get('id') ?? '';
		return {
			status: 200,
			headers: {},
			text: JSON.stringify({
				items: [{
					id,
					snippet: {
						title: `Video ${id}`,
						description: 'A description.',
						channelId,
						channelTitle,
						publishedAt: '2026-01-01T00:00:00Z',
						categoryId: '22',
						liveBroadcastContent: 'none',
					},
					contentDetails: { duration: 'PT5M' },
					statistics: { viewCount: '10', likeCount: '1', commentCount: '0' },
				}],
			}),
		};
	};
}

// ── real, self-consistent frontmatter parse/serialize (scalars + `- item` block lists
// only — the same hand-rolled subset tests/xMetadataFetchWorkflow.test.mjs uses) ──────

const FRONTMATTER_REGEX = new RegExp('^[' + String.fromCharCode(0xfeff) + ']?---\\s*[^\\S\\r\\n]*[\\r\\n]+([\\s\\S]*?)[\\r\\n]+---[^\\S\\r\\n]*([\\r\\n]*)');

function unquote(raw) {
	const m = /^(['"])(.*)\1$/.exec(raw);
	return m ? m[2] : raw;
}

function frontmatterLineKey(line) {
	const m = /^(\S[^:\r\n]*):(?:\s|$)/.exec(line);
	return m ? unquote(m[1].trim()) : null;
}

function blockKeys(block) {
	const keys = new Set();
	for (const line of block.split(/\r?\n/)) {
		const key = frontmatterLineKey(line);
		if (key) keys.add(key);
	}
	return keys;
}

function parseFrontmatter(block) {
	const fm = {};
	const lines = block.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line.trim() === '') { i++; continue; }
		const m = /^(\S[^:\r\n]*):[ \t]?(.*)$/.exec(line);
		if (!m) { i++; continue; }
		const key = unquote(m[1].trim());
		const rest = m[2].trim();
		if (rest === '') {
			const items = [];
			let j = i + 1;
			while (j < lines.length && /^\s*-\s?/.test(lines[j])) {
				items.push(unquote(lines[j].replace(/^\s*-\s?/, '').trim()));
				j++;
			}
			if (items.length > 0) {
				fm[key] = items;
				i = j;
				continue;
			}
			fm[key] = null;
			i++;
			continue;
		}
		fm[key] = unquote(rest);
		i++;
	}
	return fm;
}

function stringifyFrontmatter(fm) {
	const lines = [];
	for (const key of Object.keys(fm)) {
		const v = fm[key];
		if (Array.isArray(v)) {
			lines.push(`${key}:`);
			for (const item of v) lines.push(`  - ${item}`);
		} else if (v === null || v === undefined) {
			lines.push(`${key}:`);
		} else {
			lines.push(`${key}: ${v}`);
		}
	}
	return lines.join('\n');
}

// Unlike the X suite's cache, this one carries real VALUES, not key sentinels:
// ingestYoutubeVideoMetadata reads `fm['yt-metadata']` off the cache to decide whether
// this video is already stamped, so a `true` placeholder would defeat the test.
function computeLiveCache(content) {
	const m = content.match(FRONTMATTER_REGEX);
	if (!m) return null;
	const trailingNewlines = m[2] ?? '';
	const closingEnd = m[0].slice(0, m[0].length - trailingNewlines.length).replace(/[^\S\r\n]+$/, '').length;
	const frontmatter = parseFrontmatter(m[1] ?? '');
	for (const key of blockKeys(m[1] ?? '')) {
		if (!(key in frontmatter)) frontmatter[key] = true;
	}
	return { frontmatter, frontmatterPosition: { start: { offset: m.index ?? 0 }, end: { offset: closingEnd } } };
}

class FakeVault {
	constructor() {
		this.filesByPath = new Map();
		this.foldersByPath = new Map();
	}
	getAbstractFileByPath(p) {
		const norm = normalizePath(p);
		if (this.filesByPath.has(norm)) return this.filesByPath.get(norm).file;
		if (this.foldersByPath.has(norm)) return this.foldersByPath.get(norm);
		return null;
	}
	async createFolder(p) {
		const norm = normalizePath(p);
		if (this.foldersByPath.has(norm)) throw new Error('Folder already exists.');
		const folder = new TFolder();
		folder.path = norm;
		folder.children = [];
		this.foldersByPath.set(norm, folder);
		const parentPath = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
		if (parentPath && this.foldersByPath.has(parentPath)) {
			this.foldersByPath.get(parentPath).children.push(folder);
		}
		return folder;
	}
	async create(p, content) {
		const norm = normalizePath(p);
		if (this.filesByPath.has(norm)) throw new Error('File already exists.');
		const file = this.seed(norm, content);
		const parentPath = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
		if (parentPath && this.foldersByPath.has(parentPath)) {
			this.foldersByPath.get(parentPath).children.push(file);
		}
		return file;
	}
	async read(file) {
		return this.filesByPath.get(normalizePath(file.path))?.content ?? '';
	}
	async modify(file, content) {
		this.filesByPath.get(normalizePath(file.path)).content = content;
	}
	// Register a file directly (bypassing create's collision guard / parent wiring).
	seed(p, content) {
		const norm = normalizePath(p);
		const file = new TFile();
		file.path = norm;
		file.extension = 'md';
		file.basename = (norm.split('/').pop() ?? '').replace(/\.md$/, '');
		this.filesByPath.set(norm, { file, content });
		return file;
	}
	// Register a pre-existing metadata/about note under the root, wired into its parent
	// folder's children so findExistingMetadataNote / findExistingChannelAboutNote see it.
	seedUnderRoot(p, content) {
		const norm = normalizePath(p);
		const parent = norm.slice(0, norm.lastIndexOf('/'));
		const parts = parent.split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!this.foldersByPath.has(current)) {
				const folder = new TFolder();
				folder.path = current;
				folder.children = [];
				this.foldersByPath.set(current, folder);
				const grandparent = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
				if (grandparent && this.foldersByPath.has(grandparent)) {
					this.foldersByPath.get(grandparent).children.push(folder);
				}
			}
		}
		const file = this.seed(norm, content);
		this.foldersByPath.get(parent).children.push(file);
		return file;
	}
	bodyAt(p) {
		return this.filesByPath.get(normalizePath(p))?.content;
	}
}

function makePlugin({ channelEnrichEnabled = true, apiKey = 'test-api-key' } = {}) {
	const vault = new FakeVault();
	const emitted = [];
	const enqueued = [];
	const app = {
		vault,
		metadataCache: {
			getFileCache: file => {
				const content = vault.bodyAt(file.path);
				return content === undefined ? null : computeLiveCache(content);
			},
			// Linkpath resolution: `<link>` or `<link>.md`, vault-absolute (which is the
			// only form linkMetadataToNote ever writes).
			getFirstLinkpathDest: link => {
				const norm = normalizePath(link);
				return vault.getAbstractFileByPath(`${norm}.md`) ?? vault.getAbstractFileByPath(norm);
			},
			on: () => ({}),
			offref: () => {},
		},
		fileManager: {
			processFrontMatter: async (file, update) => {
				const entry = vault.filesByPath.get(normalizePath(file.path));
				const content = entry.content;
				const m = content.match(FRONTMATTER_REGEX);
				const fm = parseFrontmatter(m ? m[1] ?? '' : '');
				update(fm);
				const serialized = stringifyFrontmatter(fm);
				if (m) {
					const trailingNewlines = m[2] ?? '';
					const closeEnd = m[0].slice(0, m[0].length - trailingNewlines.length).replace(/[^\S\r\n]+$/, '').length;
					const start = m.index ?? 0;
					const before = content.slice(0, start);
					const rest = content.slice(start + closeEnd);
					entry.content = `${before}---\n${serialized}\n---${rest}`;
				} else {
					entry.content = `---\n${serialized}\n---\n\n${content}`;
				}
			},
		},
	};
	return {
		app,
		settings: {
			orchestrationYoutubeMetadataRoot: ROOT,
			orchestrationYoutubeChannelsNote: '',
			orchestrationYoutubeChannelEnrichEnabled: channelEnrichEnabled,
		},
		secretRegistry: { get: async () => apiKey },
		noteLocks: {
			withResourceLock: (_kind, _id, _label, fn) => fn(),
			withLock: (_path, _label, fn) => fn(),
		},
		orchestrator: {
			enqueue: async (type, params, options) => {
				enqueued.push({ type, params, options });
				return { id: `job-${enqueued.length}` };
			},
		},
		ingestionEvents: { emit: (event, payload) => emitted.push({ event, payload }) },
		_vault: vault,
		_emitted: emitted,
		_enqueued: enqueued,
	};
}

function makeCtx(plugin) {
	const signal = new AbortController().signal;
	return { plugin, signal, throwIfAborted: () => signal.throwIfAborted() };
}

function fmOf(plugin, p) {
	const content = plugin._vault.bodyAt(p);
	const m = content.match(FRONTMATTER_REGEX);
	return parseFrontmatter(m ? m[1] ?? '' : '');
}

function run(plugin, params, id = 'job-x') {
	return new YoutubeMetadataFetchWorkflow().run({ id, params }, makeCtx(plugin));
}

const CAPTURE_NOTE = 'clips/capture.md';
const captureBody = extraFm => `---\ntitle: Capture\nyt-video-id: ${OWN_VIDEO}\n${extraFm ?? ''}created: 2026-01-01\n---\n\nBody.`;

// ── appendYtMetadataLink (pure) ───────────────────────────────────────────────────

test('appendYtMetadataLink: absent key becomes a one-entry list', () => {
	const fm = { 'yt-video-id': OWN_VIDEO };
	appendYtMetadataLink(fm, linkFor(OWN_VIDEO));
	assert.deepEqual(fm['yt-metadata'], [linkFor(OWN_VIDEO)]);
});

test('appendYtMetadataLink: a legacy scalar coerces to [old, new], old first', () => {
	const fm = { 'yt-metadata': linkFor(OWN_VIDEO) };
	appendYtMetadataLink(fm, linkFor(REF_VIDEO));
	assert.deepEqual(fm['yt-metadata'], [linkFor(OWN_VIDEO), linkFor(REF_VIDEO)]);
});

test('appendYtMetadataLink: a legacy scalar equal to the link collapses, never doubles', () => {
	const fm = { 'yt-metadata': linkFor(OWN_VIDEO) };
	appendYtMetadataLink(fm, linkFor(OWN_VIDEO));
	assert.deepEqual(fm['yt-metadata'], [linkFor(OWN_VIDEO)]);
});

test('appendYtMetadataLink: membership check makes a repeat append a no-op', () => {
	const fm = { 'yt-metadata': [linkFor(OWN_VIDEO), linkFor(REF_VIDEO)] };
	appendYtMetadataLink(fm, linkFor(OWN_VIDEO));
	assert.deepEqual(fm['yt-metadata'], [linkFor(OWN_VIDEO), linkFor(REF_VIDEO)], 'no duplicate, no reorder');
});

test('appendYtMetadataLink: the new key lands immediately after yt-video-id', () => {
	const fm = { title: 'T', 'yt-video-id': OWN_VIDEO, created: '2026-01-01' };
	appendYtMetadataLink(fm, linkFor(OWN_VIDEO));
	assert.deepEqual(Object.keys(fm), ['title', 'yt-video-id', 'yt-metadata', 'created']);
});

test('ytMetadataLinks / isYtMetadataLinked tolerate both the list and the legacy scalar', () => {
	assert.deepEqual(ytMetadataLinks(linkFor(OWN_VIDEO)), [`${ROOT}/${CHANNEL_FOLDER}/${OWN_VIDEO}`]);
	assert.deepEqual(ytMetadataLinks([linkFor(OWN_VIDEO), '', linkFor(REF_VIDEO)]), [
		`${ROOT}/${CHANNEL_FOLDER}/${OWN_VIDEO}`,
		`${ROOT}/${CHANNEL_FOLDER}/${REF_VIDEO}`,
	]);
	assert.deepEqual(ytMetadataLinks(`[[${ROOT}/${CHANNEL_FOLDER}/${OWN_VIDEO}|Alias]]`), [`${ROOT}/${CHANNEL_FOLDER}/${OWN_VIDEO}`]);
	assert.equal(isYtMetadataLinked([]), false);
	assert.equal(isYtMetadataLinked(['   ']), false);
	assert.equal(isYtMetadataLinked(linkFor(OWN_VIDEO)), true);
	assert.equal(isYtMetadataLinked([linkFor(OWN_VIDEO)]), true);
});

// ── per-note mode: the key is written as a list ───────────────────────────────────

test('per-note mode stamps yt-metadata as a LIST and keeps its placement after yt-video-id', async () => {
	serveVideosList();
	const plugin = makePlugin({ channelEnrichEnabled: false });
	plugin._vault.seed(CAPTURE_NOTE, captureBody());

	const result = await run(plugin, { targetPath: CAPTURE_NOTE, videoId: OWN_VIDEO });
	assert.equal(result.status, 'done');
	assert.equal(result.outputPaths[0], metaPathFor(OWN_VIDEO));
	assert.deepEqual(fmOf(plugin, CAPTURE_NOTE)['yt-metadata'], [linkFor(OWN_VIDEO)]);
	assert.match(plugin._vault.bodyAt(CAPTURE_NOTE), /yt-video-id: .*\nyt-metadata:\n/);
});

test('a rerun is idempotent: no second fetch, no duplicate entry', async () => {
	serveVideosList();
	const plugin = makePlugin({ channelEnrichEnabled: false });
	plugin._vault.seed(CAPTURE_NOTE, captureBody());

	await run(plugin, { targetPath: CAPTURE_NOTE, videoId: OWN_VIDEO }, 'job-1');
	assert.equal(fetchCount, 1);
	const second = await run(plugin, { targetPath: CAPTURE_NOTE, videoId: OWN_VIDEO }, 'job-2');

	assert.equal(second.status, 'done');
	assert.match(second.notes, /Linked existing metadata/);
	assert.equal(fetchCount, 1, 'the per-target membership check short-circuits before the API');
	assert.deepEqual(fmOf(plugin, CAPTURE_NOTE)['yt-metadata'], [linkFor(OWN_VIDEO)]);
});

test('a legacy SCALAR yt-metadata value coerces to a list, preserving the old value at [0]', async () => {
	serveVideosList();
	const plugin = makePlugin({ channelEnrichEnabled: false });
	plugin._vault.seed(CAPTURE_NOTE, captureBody(`yt-metadata: ${linkFor(OWN_VIDEO)}\n`));
	// The scalar's target must resolve, or the membership check treats it as a dead entry.
	plugin._vault.seedUnderRoot(metaPathFor(OWN_VIDEO), '---\nvideoId: own\n---\n');

	const result = await run(plugin, referencedVideoJobParams(CAPTURE_NOTE, REF_VIDEO));
	assert.equal(result.status, 'done');
	assert.deepEqual(fmOf(plugin, CAPTURE_NOTE)['yt-metadata'], [linkFor(OWN_VIDEO), linkFor(REF_VIDEO)]);
});

// ── referenced-video mode + the per-target bail ───────────────────────────────────

test("referenced mode appends a SECOND video's stamp — the any-link bail is gone", async () => {
	serveVideosList();
	const plugin = makePlugin({ channelEnrichEnabled: false });
	plugin._vault.seed(CAPTURE_NOTE, captureBody());

	await run(plugin, { targetPath: CAPTURE_NOTE, videoId: OWN_VIDEO }, 'job-1');
	const referenced = await run(plugin, referencedVideoJobParams(CAPTURE_NOTE, REF_VIDEO, 'Ref'), 'job-2');

	assert.equal(referenced.status, 'done');
	assert.match(referenced.notes, /Created metadata for/, 'a note that already had a link still fetches the referenced video');
	assert.match(referenced.notes, /referenced video refvideo001/);
	assert.equal(referenced.outputPaths[0], metaPathFor(REF_VIDEO));
	assert.equal(fetchCount, 2);
	assert.deepEqual(fmOf(plugin, CAPTURE_NOTE)['yt-metadata'], [linkFor(OWN_VIDEO), linkFor(REF_VIDEO)]);
});

test("the capture flow's own link stays entry [0] across several referenced appends", async () => {
	serveVideosList();
	const plugin = makePlugin({ channelEnrichEnabled: false });
	plugin._vault.seed(CAPTURE_NOTE, captureBody());

	await run(plugin, { targetPath: CAPTURE_NOTE, videoId: OWN_VIDEO }, 'job-1');
	await run(plugin, referencedVideoJobParams(CAPTURE_NOTE, REF_VIDEO), 'job-2');
	await run(plugin, referencedVideoJobParams(CAPTURE_NOTE, REF_VIDEO_2), 'job-3');
	// A rerun of the middle one must not reorder anything either.
	await run(plugin, referencedVideoJobParams(CAPTURE_NOTE, REF_VIDEO), 'job-4');

	assert.deepEqual(fmOf(plugin, CAPTURE_NOTE)['yt-metadata'], [
		linkFor(OWN_VIDEO),
		linkFor(REF_VIDEO),
		linkFor(REF_VIDEO_2),
	]);
});

test('a referenced rerun re-links nothing and makes no API call', async () => {
	serveVideosList();
	const plugin = makePlugin({ channelEnrichEnabled: false });
	plugin._vault.seed(CAPTURE_NOTE, captureBody());

	await run(plugin, referencedVideoJobParams(CAPTURE_NOTE, REF_VIDEO), 'job-1');
	const before = plugin._vault.bodyAt(CAPTURE_NOTE);
	const second = await run(plugin, referencedVideoJobParams(CAPTURE_NOTE, REF_VIDEO), 'job-2');

	assert.equal(second.status, 'done');
	assert.equal(fetchCount, 1);
	assert.equal(plugin._vault.bodyAt(CAPTURE_NOTE), before);
});

test('a second note referencing an already-materialized video links it without a fetch', async () => {
	serveVideosList();
	const plugin = makePlugin({ channelEnrichEnabled: false });
	plugin._vault.seed(CAPTURE_NOTE, captureBody());
	plugin._vault.seed('clips/other.md', '---\ntitle: Other\n---\n\nBody.');

	await run(plugin, referencedVideoJobParams(CAPTURE_NOTE, REF_VIDEO), 'job-1');
	const second = await run(plugin, referencedVideoJobParams('clips/other.md', REF_VIDEO), 'job-2');

	assert.equal(second.status, 'done');
	assert.equal(fetchCount, 1, 'the metadata note is found, not re-fetched');
	assert.deepEqual(fmOf(plugin, 'clips/other.md')['yt-metadata'], [linkFor(REF_VIDEO)]);
});

// ── channel chaining ──────────────────────────────────────────────────────────────

test('a created metadata note for a first-seen channel enqueues youtube_channel_enrich', async () => {
	serveVideosList();
	const plugin = makePlugin();
	plugin._vault.seed(CAPTURE_NOTE, captureBody());

	const result = await run(plugin, { targetPath: CAPTURE_NOTE, videoId: OWN_VIDEO });
	assert.equal(result.status, 'done');
	assert.match(result.notes, new RegExp(`Enqueued channel enrichment for ${CHANNEL_ID}`));
	assert.equal(plugin._enqueued.length, 1);
	assert.equal(plugin._enqueued[0].type, 'youtube_channel_enrich');
	assert.deepEqual(plugin._enqueued[0].params, { channelId: CHANNEL_ID });
	assert.equal(plugin._enqueued[0].options.lane, 'background', 'enqueue-only — never the user lane, never run inline');
});

test('no chaining when the channel already has an about note', async () => {
	serveVideosList();
	const plugin = makePlugin();
	plugin._vault.seed(CAPTURE_NOTE, captureBody());
	plugin._vault.seedUnderRoot(`${ROOT}/${CHANNEL_FOLDER}/about.md`, `---\nchannelId: ${CHANNEL_ID}\n---\n`);

	const result = await run(plugin, { targetPath: CAPTURE_NOTE, videoId: OWN_VIDEO });
	assert.equal(result.status, 'done');
	assert.equal(plugin._enqueued.length, 0);
	assert.doesNotMatch(result.notes, /Enqueued channel enrichment/);
});

test('no chaining when the channel-enrich setting is off (source-enable gate)', async () => {
	serveVideosList();
	const plugin = makePlugin({ channelEnrichEnabled: false });
	plugin._vault.seed(CAPTURE_NOTE, captureBody());

	const result = await run(plugin, { targetPath: CAPTURE_NOTE, videoId: OWN_VIDEO });
	assert.equal(result.status, 'done');
	assert.equal(plugin._enqueued.length, 0);
});

test('no chaining on an exists result — created only, so reruns stay quiet', async () => {
	serveVideosList();
	const plugin = makePlugin();
	plugin._vault.seed(CAPTURE_NOTE, captureBody());
	plugin._vault.seed('clips/other.md', '---\ntitle: Other\n---\n\nBody.');

	await run(plugin, { targetPath: CAPTURE_NOTE, videoId: OWN_VIDEO }, 'job-1');
	assert.equal(plugin._enqueued.length, 1);

	// Second note, same video: the metadata note now exists → no second channel job.
	await run(plugin, referencedVideoJobParams('clips/other.md', OWN_VIDEO), 'job-2');
	assert.equal(plugin._enqueued.length, 1, 'exists never chains');
});

test('standalone mode chains too — a first-seen channel is first-seen either way', async () => {
	serveVideosList();
	const plugin = makePlugin();

	const result = await run(plugin, { videoId: REF_VIDEO });
	assert.equal(result.status, 'done');
	assert.equal(plugin._enqueued.length, 1);
	assert.deepEqual(plugin._enqueued[0].params, { channelId: CHANNEL_ID });
});

test('a throwing enqueue never fails the job — the metadata note is already written', async () => {
	serveVideosList();
	const plugin = makePlugin();
	plugin.orchestrator.enqueue = async () => { throw new Error('queue is closed'); };
	plugin._vault.seed(CAPTURE_NOTE, captureBody());

	const result = await run(plugin, { targetPath: CAPTURE_NOTE, videoId: OWN_VIDEO });
	assert.equal(result.status, 'done');
	assert.doesNotMatch(result.notes, /Enqueued channel enrichment/);
	assert.deepEqual(fmOf(plugin, CAPTURE_NOTE)['yt-metadata'], [linkFor(OWN_VIDEO)]);
});
