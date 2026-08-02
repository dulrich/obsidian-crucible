import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// WP-J3: LinkNoteEnrichWorkflow is the note-level companion to LinkScanWorkflow
// (vault-wide) and XPostDiscoverWorkflow (X-only, note-level). It transitively pulls in
// linkRegistry.ts (updateFrontmatter), xApi.ts/blogsApi.ts/youtubeApi.ts (requestUrl,
// htmlToMarkdown — never called by this suite, but the module graph needs the stub
// exports to link) and jobTypeConfig.ts's referencedVideoJobParams. Same
// esbuild-bundle + obsidian-stub + live-derived-metadataCache technique as
// tests/youtubeMetadataListContract.test.mjs and tests/xMetadataFetchWorkflow.test.mjs.

const outdir = path.join(tmpdir(), 'obsidian-crucible-link-note-enrich-workflow-tests');
const outfile = path.join(outdir, 'LinkNoteEnrichWorkflow.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { LinkNoteEnrichWorkflow } from './src/orchestration/workflows/LinkNoteEnrichWorkflow';",
			"export { referencedVideoJobParams } from './src/orchestration/jobTypeConfig';",
			"export { TFile, TFolder } from 'obsidian';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'link-note-enrich-workflow-test-entry.ts',
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
					'export async function requestUrl() { throw new Error("requestUrl unavailable in link-enrich tests"); }',
					'export function htmlToMarkdown(html) { return String(html); }',
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

const { LinkNoteEnrichWorkflow, referencedVideoJobParams, TFile, TFolder } = await import(pathToFileURL(outfile).href);

function normalizePath(p) {
	return String(p ?? '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

// ── real, self-consistent frontmatter parse/serialize (same hand-rolled subset as
// tests/xMetadataFetchWorkflow.test.mjs / tests/youtubeMetadataListContract.test.mjs) ──

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

// Real values (not sentinel `true`s): LinkNoteEnrichWorkflow reads fm['yt-video-id'],
// fm['videoId'], fm['yt-metadata'], fm['type'], fm['source_command'] to decide guards.
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
	async cachedRead(file) {
		return this.filesByPath.get(normalizePath(file.path))?.content ?? '';
	}
	async read(file) {
		return this.filesByPath.get(normalizePath(file.path))?.content ?? '';
	}
	seed(p, content) {
		const norm = normalizePath(p);
		const file = new TFile();
		file.path = norm;
		file.extension = 'md';
		this.filesByPath.set(norm, { file, content });
		return file;
	}
	bodyAt(p) {
		return this.filesByPath.get(normalizePath(p))?.content;
	}
}

function makePlugin(settingsOverrides = {}) {
	const vault = new FakeVault();
	const enqueued = [];
	const app = {
		vault,
		metadataCache: {
			getFileCache: file => {
				const content = vault.bodyAt(file.path);
				return content === undefined ? null : computeLiveCache(content);
			},
			getFirstLinkpathDest: (linkpath) => {
				const norm = normalizePath(linkpath.endsWith('.md') ? linkpath : `${linkpath}.md`);
				return vault.filesByPath.get(norm)?.file ?? null;
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
	const plugin = {
		app,
		settings: {
			orchestrationLinkRegistryRoot: '_crucible/link_registry',
			orchestrationYoutubeMetadataRoot: '_yt_metadata',
			orchestrationXMetadataRoot: '_x_metadata',
			orchestrationBlogsMetadataRoot: '_blog_metadata',
			orchestrationTimezone: 'UTC',
			...settingsOverrides,
		},
		orchestrator: {
			enqueue: async (type, params, options) => {
				enqueued.push({ type, params, options });
				return { id: `job-${enqueued.length}`, type, status: 'queued', priority: options?.priority ?? 'normal', lane: options?.lane ?? 'background' };
			},
		},
		_vault: vault,
		_enqueued: enqueued,
	};
	return plugin;
}

function makeCtx(plugin) {
	const signal = new AbortController().signal;
	const progress = [];
	return { plugin, signal, throwIfAborted: () => signal.throwIfAborted(), reportProgress: (m) => progress.push(m), _progress: progress };
}

function fmOf(plugin, p) {
	const content = plugin._vault.bodyAt(p);
	const m = content.match(FRONTMATTER_REGEX);
	return parseFrontmatter(m ? m[1] ?? '' : '');
}

// ── missing/invalid targetPath ──────────────────────────────────────────────────

test('missing targetPath fails', async () => {
	const plugin = makePlugin();
	const result = await new LinkNoteEnrichWorkflow().run({ id: 'j1', params: {} }, makeCtx(plugin));
	assert.equal(result.status, 'failed');
	assert.equal(result.error, 'Missing params.targetPath');
	assert.equal(plugin._enqueued.length, 0);
});

test('a targetPath that does not resolve to a TFile fails', async () => {
	const plugin = makePlugin();
	const result = await new LinkNoteEnrichWorkflow().run(
		{ id: 'j1', params: { targetPath: 'gone.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'failed');
	assert.equal(result.error, 'Target note not found: gone.md');
});

// ── refusal guards ───────────────────────────────────────────────────────────────

test('refuses to scan a note under the yt metadata root', async () => {
	const plugin = makePlugin();
	plugin._vault.seed('_yt_metadata/chan/vid123.md', '---\ntitle: V\n---\n\nhttps://x.com/a/status/1');
	const result = await new LinkNoteEnrichWorkflow().run(
		{ id: 'j1', params: { targetPath: '_yt_metadata/chan/vid123.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.match(result.notes, /Refused:/);
	assert.equal(plugin._enqueued.length, 0);
});

test('refuses to scan a note under the x metadata root', async () => {
	const plugin = makePlugin();
	plugin._vault.seed('_x_metadata/author/123.md', '---\nstatus-id: "123"\n---\n\nhttps://youtube.com/watch?v=abc');
	const result = await new LinkNoteEnrichWorkflow().run(
		{ id: 'j1', params: { targetPath: '_x_metadata/author/123.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.match(result.notes, /Refused:/);
});

test('refuses to scan a note under the blog metadata root', async () => {
	const plugin = makePlugin();
	plugin._vault.seed('_blog_metadata/post.md', '---\nsource: https://example.com\n---\n\nhttps://youtube.com/watch?v=abc');
	const result = await new LinkNoteEnrichWorkflow().run(
		{ id: 'j1', params: { targetPath: '_blog_metadata/post.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.match(result.notes, /Refused:/);
});

test('refuses to scan a note under the link registry root', async () => {
	const plugin = makePlugin();
	plugin._vault.seed('_crucible/link_registry/some-link.md', '---\ntype: link-record\n---\n\nhttps://youtube.com/watch?v=abc');
	const result = await new LinkNoteEnrichWorkflow().run(
		{ id: 'j1', params: { targetPath: '_crucible/link_registry/some-link.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.match(result.notes, /Refused:/);
});

test('refuses to scan a note with frontmatter type: link-record, even outside the registry root', async () => {
	const plugin = makePlugin();
	plugin._vault.seed('elsewhere/moved-link.md', '---\ntype: link-record\n---\n\nhttps://youtube.com/watch?v=abc');
	const result = await new LinkNoteEnrichWorkflow().run(
		{ id: 'j1', params: { targetPath: 'elsewhere/moved-link.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.match(result.notes, /Refused:/);
});

test('refuses to scan a metadata note that was moved out from under its root, via source_command', async () => {
	const plugin = makePlugin();
	plugin._vault.seed('elsewhere/moved-metadata.md', '---\nsource_command: youtube-fetch-video-metadata\n---\n\nhttps://x.com/a/status/1');
	const result = await new LinkNoteEnrichWorkflow().run(
		{ id: 'j1', params: { targetPath: 'elsewhere/moved-metadata.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.match(result.notes, /Refused:/);
});

test('an ordinary note is not refused', async () => {
	const plugin = makePlugin();
	plugin._vault.seed('clips/ordinary.md', '---\ntitle: Ordinary\n---\n\nNo links here.');
	const result = await new LinkNoteEnrichWorkflow().run(
		{ id: 'j1', params: { targetPath: 'clips/ordinary.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.doesNotMatch(result.notes, /Refused:/);
});

// ── extraction, registry parity, fan-out ─────────────────────────────────────────

test('a note with mixed URLs merges every one into the registry and fans out X + YouTube', async () => {
	const plugin = makePlugin();
	const content = [
		'# Clip',
		'',
		'A video:',
		'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
		'',
		'An X post:',
		'https://x.com/PandaAshwinee/status/2078296458122645635?s=20',
		'',
		'Noise that must not match:',
		'https://arxiv.org/abs/2401.12345',
	].join('\n');
	plugin._vault.seed('clips/mixed.md', `---\ntitle: Mixed\n---\n\n${content}`);

	const ctx = makeCtx(plugin);
	const result = await new LinkNoteEnrichWorkflow().run(
		{ id: 'j1', params: { targetPath: 'clips/mixed.md' } },
		ctx,
	);
	assert.equal(result.status, 'done');

	// Registry parity: three distinct canonical URLs (YT, X, arxiv) each get a
	// link-record note via the same applyLinkToRegistry writer LinkScanWorkflow uses.
	assert.equal(result.outputPaths.length, 3);
	const arxivRecord = plugin._vault.getAbstractFileByPath('_crucible/link_registry/arxiv.org_abs_2401.12345.md');
	assert.ok(arxivRecord, 'arxiv link, which has no YT/X id, still lands a link-record note');
	const arxivFm = fmOf(plugin, '_crucible/link_registry/arxiv.org_abs_2401.12345.md');
	assert.equal(arxivFm['type'], 'link-record');
	assert.deepEqual(arxivFm['source_notes'], ['[[clips/mixed]]']);

	// X: one x_post_discover enqueue, no second implementation of status extraction.
	const xJobs = plugin._enqueued.filter(j => j.type === 'x_post_discover');
	assert.equal(xJobs.length, 1);
	assert.deepEqual(xJobs[0].params, { targetPath: 'clips/mixed.md' });
	assert.equal(xJobs[0].options.priority, 'normal');
	assert.equal(xJobs[0].options.lane, 'background');

	// YouTube: one referenced-video enqueue via referencedVideoJobParams — never
	// hand-rolled.
	const ytJobs = plugin._enqueued.filter(j => j.type === 'youtube_metadata_fetch');
	assert.equal(ytJobs.length, 1);
	assert.deepEqual(ytJobs[0].params, referencedVideoJobParams('clips/mixed.md', 'dQw4w9WgXcQ'));
	assert.equal(ytJobs[0].options.priority, 'normal');
	assert.equal(ytJobs[0].options.lane, 'background');

	assert.match(result.notes, /3 distinct link/);
	assert.match(result.notes, /X discover enqueued/);
	assert.match(result.notes, /YouTube: 1 enqueued, 0 skipped \(note's own video\), 0 skipped \(already stamped\)/);
});

test('the registry write is not self-guarded: the note is still recorded even for its own video', async () => {
	const plugin = makePlugin();
	plugin._vault.seed(
		'captures/self.md',
		'---\nyt-video-id: vself000001\n---\n\nhttps://www.youtube.com/watch?v=vself000001',
	);
	const result = await new LinkNoteEnrichWorkflow().run(
		{ id: 'j1', params: { targetPath: 'captures/self.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.equal(result.outputPaths.length, 1, 'the self-referencing URL still gets a registry record');
	const ytJobs = plugin._enqueued.filter(j => j.type === 'youtube_metadata_fetch');
	assert.equal(ytJobs.length, 0, 'but the YouTube fan-out drops the note\'s own video');
	assert.match(result.notes, /YouTube: 0 enqueued, 1 skipped \(note's own video\), 0 skipped \(already stamped\)/);
});

test('self-guard also reads legacy frontmatter key videoId', async () => {
	const plugin = makePlugin();
	plugin._vault.seed(
		'captures/legacy.md',
		'---\nvideoId: vlegacy0001\n---\n\nhttps://www.youtube.com/watch?v=vlegacy0001',
	);
	const result = await new LinkNoteEnrichWorkflow().run(
		{ id: 'j1', params: { targetPath: 'captures/legacy.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.equal(plugin._enqueued.filter(j => j.type === 'youtube_metadata_fetch').length, 0);
});

test('a video already stamped in yt-metadata is skipped, not re-enqueued', async () => {
	const plugin = makePlugin();
	plugin._vault.seed('_yt_metadata/chan/vref0000001.md', '---\ntitle: Ref\n---\n\nDescription.');
	plugin._vault.seed(
		'clips/has-ref.md',
		'---\nyt-metadata:\n  - "[[_yt_metadata/chan/vref0000001]]"\n---\n\nhttps://www.youtube.com/watch?v=vref0000001',
	);
	const result = await new LinkNoteEnrichWorkflow().run(
		{ id: 'j1', params: { targetPath: 'clips/has-ref.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.equal(plugin._enqueued.filter(j => j.type === 'youtube_metadata_fetch').length, 0);
	assert.match(result.notes, /YouTube: 0 enqueued, 0 skipped \(note's own video\), 1 skipped \(already stamped\)/);
});

test('a note with no links enqueues nothing and touches no registry record', async () => {
	const plugin = makePlugin();
	plugin._vault.seed('clips/none.md', '---\ntitle: None\n---\n\nNo links here at all.');
	const result = await new LinkNoteEnrichWorkflow().run(
		{ id: 'j1', params: { targetPath: 'clips/none.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.equal(result.outputPaths.length, 0);
	assert.equal(plugin._enqueued.length, 0);
	assert.match(result.notes, /0 distinct link/);
});

test('several distinct videos each get their own referenced job (not collapsed)', async () => {
	const plugin = makePlugin();
	plugin._vault.seed(
		'clips/many.md',
		[
			'---',
			'title: Many',
			'---',
			'',
			'https://www.youtube.com/watch?v=video000001',
			'https://www.youtube.com/watch?v=video000002',
			'https://youtu.be/video000003',
		].join('\n'),
	);
	const result = await new LinkNoteEnrichWorkflow().run(
		{ id: 'j1', params: { targetPath: 'clips/many.md' } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	const ytJobs = plugin._enqueued.filter(j => j.type === 'youtube_metadata_fetch');
	assert.equal(ytJobs.length, 3);
	const ids = ytJobs.map(j => j.params.videoId).sort();
	assert.deepEqual(ids, ['video000001', 'video000002', 'video000003']);
	for (const job of ytJobs) {
		assert.equal(job.params.referencedVideo, true);
		assert.equal(job.params.targetPath, 'clips/many.md');
	}
});

test('progress is reported during the registry pass', async () => {
	const plugin = makePlugin();
	plugin._vault.seed(
		'clips/progress.md',
		'---\ntitle: P\n---\n\nhttps://arxiv.org/abs/2401.00001',
	);
	const ctx = makeCtx(plugin);
	await new LinkNoteEnrichWorkflow().run({ id: 'j1', params: { targetPath: 'clips/progress.md' } }, ctx);
	assert.ok(ctx._progress.some(m => /^registry 1 \/ 1 links$/.test(m)));
});
