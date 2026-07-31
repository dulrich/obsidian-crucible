import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// XMetadataFetchWorkflow transitively pulls in xApi.ts (requestUrl/htmlToMarkdown),
// xPost.ts (pure), and src/frontmatter.ts's updateFrontmatter (which needs
// app.fileManager.processFrontMatter + a metadata cache it considers "fresh"). Same
// esbuild-bundle + obsidian-stub technique as tests/xApi.test.mjs and
// tests/frontmatterBarrier.test.mjs, combined: a FakeVault that stores real frontmatter
// content and a metadataCache whose getFileCache is *live-derived* from that same
// content on every call (same FRONTMATTER_REGEX-driven algorithm updateFrontmatter's
// own freshness check uses) — so the stale-cache barrier never has anything to wait on
// and every write in this suite lands synchronously with the real chokepoint code path.

const outdir = path.join(tmpdir(), 'obsidian-crucible-x-metadata-fetch-workflow-tests');
const outfile = path.join(outdir, 'xMetadataFetchWorkflow.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { XMetadataFetchWorkflow } from './src/orchestration/workflows/XMetadataFetchWorkflow';",
			"export { TFile, TFolder } from 'obsidian';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'x-metadata-fetch-workflow-test-entry.ts',
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
					'export function normalizePath(p) { return p.replace(/\\\\/g, "/").replace(/\\/+/g, "/"); }',
					'export async function requestUrl(options) { return await globalThis.__xOembedRespond(options); }',
					'export function htmlToMarkdown(html) { return globalThis.__htmlToMarkdown(html); }',
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

const { XMetadataFetchWorkflow, TFile, TFolder } = await import(pathToFileURL(outfile).href);

const fixtureRaw = await readFile(new URL('./fixtures/x-oembed-panda.json', import.meta.url), 'utf8');
const STATUS_ID = '2078296458122645635';
const CANONICAL_URL = `https://x.com/PandaAshwinee/status/${STATUS_ID}`;

globalThis.__htmlToMarkdown = html => String(html)
	.replace(/<[^>]+>/g, ' ')
	.replace(/&mdash;/g, '—')
	.replace(/&amp;/g, '&')
	.replace(/&lt;/g, '<')
	.replace(/&gt;/g, '>')
	.replace(/\s+/g, ' ')
	.trim();

function respondWith(status, { text = '', headers = {} } = {}) {
	globalThis.__xOembedRespond = async () => ({ status, text, headers });
}

function normalizePath(p) {
	return p.replace(/\\/g, '/').replace(/\/+/g, '/');
}

// ── real, self-consistent frontmatter parse/serialize (own hand-rolled subset — not
// a general YAML parser: scalars and `- item` block lists only, which is all these
// fixtures need) ──────────────────────────────────────────────────────────────────

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

function computeLiveCache(content) {
	const m = content.match(FRONTMATTER_REGEX);
	if (!m) return null;
	const trailingNewlines = m[2] ?? '';
	const closingEnd = m[0].slice(0, m[0].length - trailingNewlines.length).replace(/[^\S\r\n]+$/, '').length;
	const keys = blockKeys(m[1] ?? '');
	const frontmatter = {};
	for (const key of keys) frontmatter[key] = true;
	return { frontmatter, frontmatterPosition: { start: { offset: m.index ?? 0 }, end: { offset: closingEnd } } };
}

// Minimal in-memory vault: findExistingXMetadataNote's child-folder probe,
// ensureXMetadataNote's ensureFolder + create path, and a real
// fileManager.processFrontMatter (content-splice, mirroring the real repair path's
// splice shape) for the stamping side.
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
	}
	async create(p, content) {
		const norm = normalizePath(p);
		if (this.filesByPath.has(norm)) throw new Error('File already exists.');
		const file = new TFile();
		file.path = norm;
		file.extension = 'md';
		this.filesByPath.set(norm, { file, content });
		const parentPath = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) : '';
		if (parentPath && this.foldersByPath.has(parentPath)) {
			this.foldersByPath.get(parentPath).children.push(file);
		}
		return file;
	}
	async read(file) {
		return this.filesByPath.get(normalizePath(file.path))?.content ?? '';
	}
	// Register a pre-existing source note directly (bypassing create's collision guard).
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

function makePlugin({ ingestionEvents } = {}) {
	const vault = new FakeVault();
	const emitted = [];
	const app = {
		vault,
		metadataCache: {
			getFileCache: file => {
				const content = vault.bodyAt(file.path);
				return content === undefined ? null : computeLiveCache(content);
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
	const bus = ingestionEvents === null ? undefined : (ingestionEvents ?? {
		emit: (event, payload) => emitted.push({ event, payload }),
	});
	return {
		app,
		settings: { orchestrationXMetadataRoot: '_x_metadata' },
		noteLocks: {
			withResourceLock: (_kind, _id, _label, fn) => fn(),
			withLock: (_path, _label, fn) => fn(),
		},
		ingestionEvents: bus,
		_vault: vault,
		_emitted: emitted,
	};
}

function makeCtx(plugin) {
	const signal = new AbortController().signal;
	return { plugin, signal, throwIfAborted: () => signal.throwIfAborted() };
}

function fmOf(plugin, path) {
	const content = plugin._vault.bodyAt(path);
	const m = content.match(FRONTMATTER_REGEX);
	return parseFrontmatter(m ? m[1] ?? '' : '');
}

// ── missing statusId ─────────────────────────────────────────────────────────────

test('missing statusId fails without touching the network', async () => {
	let called = false;
	globalThis.__xOembedRespond = async () => { called = true; return { status: 200, text: fixtureRaw, headers: {} }; };
	const plugin = makePlugin();
	const result = await new XMetadataFetchWorkflow().run({ id: 'j1', params: {} }, makeCtx(plugin));
	assert.equal(result.status, 'failed');
	assert.equal(result.error, 'Missing params.statusId');
	assert.equal(called, false);
});

// ── created + stamping ───────────────────────────────────────────────────────────

test('done+created with one sourcePath stamps the note with an x-metadata list, and a rerun is idempotent', async () => {
	let fetchCount = 0;
	globalThis.__xOembedRespond = async () => { fetchCount++; return { status: 200, text: fixtureRaw, headers: {} }; };
	const plugin = makePlugin();
	plugin._vault.seed('clips/a.md', '---\ntitle: A\n---\n\nBody.');

	const first = await new XMetadataFetchWorkflow().run(
		{ id: 'j1', params: { statusId: STATUS_ID, url: CANONICAL_URL, sourcePaths: ['clips/a.md'] } },
		makeCtx(plugin),
	);
	assert.equal(first.status, 'done');
	assert.equal(first.outputPaths[0], `_x_metadata/pandaashwinee/${STATUS_ID}.md`);
	assert.match(first.notes, /Created metadata for/);
	assert.match(first.notes, /Stamped 1 source note\(s\)/);
	assert.equal(fetchCount, 1);

	const link = `[[_x_metadata/pandaashwinee/${STATUS_ID}]]`;
	assert.deepEqual(fmOf(plugin, 'clips/a.md')['x-metadata'], [link]);

	// Rerun: ensure now finds the note (exists), and re-stamping must not duplicate.
	const second = await new XMetadataFetchWorkflow().run(
		{ id: 'j2', params: { statusId: STATUS_ID, url: CANONICAL_URL, sourcePaths: ['clips/a.md'] } },
		makeCtx(plugin),
	);
	assert.equal(second.status, 'done');
	assert.match(second.notes, /Linked existing metadata for/);
	assert.equal(fetchCount, 1, 'no second network call on the probe hit');
	assert.deepEqual(fmOf(plugin, 'clips/a.md')['x-metadata'], [link], 'no duplicate entry on rerun');
});

test('done+created with two sourcePaths stamps both notes', async () => {
	globalThis.__xOembedRespond = async () => ({ status: 200, text: fixtureRaw, headers: {} });
	const plugin = makePlugin();
	plugin._vault.seed('clips/a.md', '---\ntitle: A\n---\n\nBody.');
	plugin._vault.seed('clips/b.md', '---\ntitle: B\n---\n\nBody.');

	const result = await new XMetadataFetchWorkflow().run(
		{ id: 'j1', params: { statusId: STATUS_ID, url: CANONICAL_URL, sourcePaths: ['clips/a.md', 'clips/b.md', 'clips/a.md'] } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.match(result.notes, /Stamped 2 source note\(s\)/, 'the duplicate path in sourcePaths is deduped before stamping');

	const link = `[[_x_metadata/pandaashwinee/${STATUS_ID}]]`;
	assert.deepEqual(fmOf(plugin, 'clips/a.md')['x-metadata'], [link]);
	assert.deepEqual(fmOf(plugin, 'clips/b.md')['x-metadata'], [link]);
});

test('a non-TFile sourcePath is skipped silently and counted, not thrown on', async () => {
	globalThis.__xOembedRespond = async () => ({ status: 200, text: fixtureRaw, headers: {} });
	const plugin = makePlugin();
	plugin._vault.seed('clips/a.md', '---\ntitle: A\n---\n\nBody.');

	const result = await new XMetadataFetchWorkflow().run(
		{ id: 'j1', params: { statusId: STATUS_ID, url: CANONICAL_URL, sourcePaths: ['clips/a.md', 'clips/gone.md'] } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.match(result.notes, /Stamped 1 source note\(s\), skipped 1 non-file path\(s\)/);
});

test('string coercion: an existing scalar x-metadata value becomes [old, link], preserving the old value', async () => {
	globalThis.__xOembedRespond = async () => ({ status: 200, text: fixtureRaw, headers: {} });
	const plugin = makePlugin();
	plugin._vault.seed('clips/a.md', '---\ntitle: A\nx-metadata: [[_x_metadata/manual/1]]\n---\n\nBody.');

	const result = await new XMetadataFetchWorkflow().run(
		{ id: 'j1', params: { statusId: STATUS_ID, url: CANONICAL_URL, sourcePaths: ['clips/a.md'] } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	const link = `[[_x_metadata/pandaashwinee/${STATUS_ID}]]`;
	assert.deepEqual(fmOf(plugin, 'clips/a.md')['x-metadata'], ['[[_x_metadata/manual/1]]', link]);

	// Idempotent rerun on the now-array value.
	await new XMetadataFetchWorkflow().run(
		{ id: 'j2', params: { statusId: STATUS_ID, url: CANONICAL_URL, sourcePaths: ['clips/a.md'] } },
		makeCtx(plugin),
	);
	assert.deepEqual(fmOf(plugin, 'clips/a.md')['x-metadata'], ['[[_x_metadata/manual/1]]', link]);
});

// ── exists (no sourcePaths) ──────────────────────────────────────────────────────

test('done+exists makes no second oEmbed call when there is nothing to stamp', async () => {
	let fetchCount = 0;
	globalThis.__xOembedRespond = async () => { fetchCount++; return { status: 200, text: fixtureRaw, headers: {} }; };
	const plugin = makePlugin();

	const first = await new XMetadataFetchWorkflow().run(
		{ id: 'j1', params: { statusId: STATUS_ID, url: CANONICAL_URL } },
		makeCtx(plugin),
	);
	assert.equal(first.status, 'done');
	assert.equal(fetchCount, 1);

	const second = await new XMetadataFetchWorkflow().run(
		{ id: 'j2', params: { statusId: STATUS_ID, url: CANONICAL_URL } },
		makeCtx(plugin),
	);
	assert.equal(second.status, 'done');
	assert.match(second.notes, /Linked existing metadata for/);
	assert.equal(fetchCount, 1, 'no second network call on the probe hit');
});

// ── tombstone (404) ──────────────────────────────────────────────────────────────

test('a 404 produces done+tombstoned, notes mention unavailable, and the event still fires', async () => {
	respondWith(404, {});
	const deadId = '999999999999999101';
	const plugin = makePlugin();

	const result = await new XMetadataFetchWorkflow().run(
		{ id: 'j1', params: { statusId: deadId } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.equal(result.outputPaths[0], `_x_metadata/_unavailable/${deadId}.md`);
	assert.match(result.notes, /unavailable/i);
	assert.match(result.notes, /tombstoned/);

	assert.equal(plugin._emitted.length, 1);
	assert.equal(plugin._emitted[0].event, 'x-metadata-enriched');
	assert.equal(plugin._emitted[0].payload.statusId, deadId);
	assert.equal(plugin._emitted[0].payload.metadataFile.path, result.outputPaths[0]);
	assert.equal(plugin._emitted[0].payload.sourceFiles, undefined);
});

// ── deferred (429) ───────────────────────────────────────────────────────────────

test('a 429 defers with serviceUnhealthy naming x-oembed and retryAfterMs, no stamping happens', async () => {
	respondWith(429, { headers: { 'Retry-After': '90' } });
	const plugin = makePlugin();
	plugin._vault.seed('clips/a.md', '---\ntitle: A\n---\n\nBody.');
	const beforeContent = plugin._vault.bodyAt('clips/a.md');

	const result = await new XMetadataFetchWorkflow().run(
		{ id: 'j1', params: { statusId: '999999999999999102', sourcePaths: ['clips/a.md'] } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'deferred');
	assert.equal(result.serviceUnhealthy.service, 'x-oembed');
	assert.equal(result.serviceUnhealthy.kind, 'rate-limited');
	assert.equal(result.retryAfterMs, 90_000);
	assert.equal(plugin._vault.bodyAt('clips/a.md'), beforeContent, 'no stamping happened before the deferral');
	assert.equal(plugin._emitted.length, 0);
});

// ── event guard ──────────────────────────────────────────────────────────────────

test('no event fires when the metadata file does not resolve to a real TFile', async () => {
	globalThis.__xOembedRespond = async () => ({ status: 200, text: fixtureRaw, headers: {} });
	const plugin = makePlugin();
	// Break resolution specifically at the emit guard: getAbstractFileByPath always
	// misses, while create/read (used internally by ensureXMetadataNote) are untouched.
	plugin.app.vault.getAbstractFileByPath = () => null;

	const result = await new XMetadataFetchWorkflow().run(
		{ id: 'j1', params: { statusId: STATUS_ID, url: CANONICAL_URL } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.equal(plugin._emitted.length, 0);
});

test('no event fires when the plugin has no ingestionEvents bus', async () => {
	globalThis.__xOembedRespond = async () => ({ status: 200, text: fixtureRaw, headers: {} });
	const plugin = makePlugin({ ingestionEvents: null });

	const result = await new XMetadataFetchWorkflow().run(
		{ id: 'j1', params: { statusId: STATUS_ID, url: CANONICAL_URL } },
		makeCtx(plugin),
	);
	assert.equal(result.status, 'done');
	assert.equal(plugin._emitted.length, 0);
});
