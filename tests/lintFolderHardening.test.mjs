import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Covers WP-H1(c): `Linter.lintFolder` (src/lint.ts) gets try/finally so the persistent
// progress Notice is always hidden, and the per-note `lintFile` await is caught so one
// broken note can't orphan the Notice or abort the rest of the run — failures are counted
// and named in the completion summary instead. Drives the REAL Linter.lintFolder against a
// minimal hand-rolled Obsidian stub (same harness shape as tests/lintStepRegistry.test.mjs),
// bundled together with `TFile`/`TFolder` from the stub so `instanceof` checks inside
// `lintFolder`'s recursive file walk resolve against the same class identity.

const outdir = path.join(tmpdir(), 'obsidian-crucible-lint-folder-hardening-tests');
const outfile = path.join(outdir, 'lint.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export * from './src/lint.ts';",
			"export { TFile, TFolder, Notice } from 'obsidian';",
		].join('\n'),
		resolveDir: process.cwd(),
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
					'export class Editor {}',
					'export class MarkdownView {}',
					'export class Modal {}',
					'export class Notice {',
					'  constructor(message, timeout) {',
					'    this.message = message;',
					'    this.timeout = timeout;',
					'    this.hidden = false;',
					'    this.messages = [message];',
					'    globalThis.__testNotices = globalThis.__testNotices || [];',
					'    globalThis.__testNotices.push(this);',
					'  }',
					'  hide() { this.hidden = true; }',
					'  setMessage(m) { this.message = m; this.messages.push(m); }',
					'}',
					'export class Plugin {}',
					'export class TFile {}',
					'export class TFolder {}',
					'export class TAbstractFile {}',
					'export const Platform = { isDesktopApp: true, isMobileApp: false };',
					'export function normalizePath(path) { return String(path).replace(/\\/+/g, "/"); }',
					'export function parseYaml() { return {}; }',
					'export function debounce(fn) { return fn; }',
					'export function getAllTags() { return []; }',
					'export const moment = Object.assign(() => ({ format: () => "2026-07-29" }), { format: () => "2026-07-29" });',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { Linter, TFile, TFolder } = await import(pathToFileURL(outfile).href);

function splitFrontmatter(content) {
	const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) return { block: '', body: content };
	return { block: m[1], body: content.slice(m[0].length) };
}

function parseFlatYaml(block) {
	const fm = {};
	if (!block) return fm;
	for (const line of block.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const idx = line.indexOf(':');
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const raw = line.slice(idx + 1).trim();
		fm[key] = raw === '' ? '' : (/^-?\d+$/.test(raw) ? Number(raw) : raw);
	}
	return fm;
}

function stringifyFlatYaml(fm) {
	const lines = Object.keys(fm).map((k) => {
		const v = fm[k];
		return v === '' || v === null || v === undefined ? `${k}:` : `${k}: ${v}`;
	});
	return `---\n${lines.join('\n')}\n---\n`;
}

function deriveFreshCache(content) {
	const { block } = splitFrontmatter(content);
	if (!content.startsWith('---')) return null;
	const closingEnd = `---\n${block}\n---`.length;
	const fm = parseFlatYaml(block);
	return { frontmatter: fm, frontmatterPosition: { start: { offset: 0 }, end: { offset: closingEnd } } };
}

function makeFile(filePath, content) {
	const basename = filePath.split('/').pop().replace(/\.md$/, '');
	const file = new TFile();
	file.path = filePath;
	file.extension = 'md';
	file.basename = basename;
	file.stat = { ctime: 0 };
	file.__content = content;
	return file;
}

function makeFolder(folderPath, children) {
	const folder = new TFolder();
	folder.path = folderPath;
	folder.children = children;
	return folder;
}

function makeApp(files) {
	const contents = new Map(files.map(f => [f.path, f.__content]));
	const app = {
		vault: {
			read: async (file) => contents.get(file.path),
			process: async (file, fn) => {
				const next = fn(contents.get(file.path));
				contents.set(file.path, next);
				return next;
			},
		},
		metadataCache: {
			getFileCache: (file) => deriveFreshCache(contents.get(file.path) ?? ''),
			on: () => ({}),
			offref: () => {},
		},
		fileManager: {
			processFrontMatter: async (file, update) => {
				const { block, body } = splitFrontmatter(contents.get(file.path));
				const fm = parseFlatYaml(block);
				update(fm);
				contents.set(file.path, stringifyFlatYaml(fm) + body);
			},
		},
		plugins: { enabledPlugins: new Set() },
		commands: { executeCommandById: () => {} },
	};
	return { app, contents };
}

function baseSettings(overrides = {}) {
	return {
		excludedFolders: [],
		lintFrontmatterInsert: '',
		lintCreatedKey: 'created',
		lintModifiedKey: 'updated',
		lintBlankLineAfterYaml: false,
		lintYamlKeyPriority: ['title', 'created', 'updated', 'word-count'],
		lintStepEnabled: {},
		...overrides,
	};
}

test.beforeEach(() => {
	globalThis.__testNotices = [];
});

test('lintFolder: all notes succeed — progress Notice hidden, no failures reported', async () => {
	const good1 = makeFile('a.md', '---\nsource: x\n---\n\nBody one.');
	const good2 = makeFile('b.md', '---\nsource: y\n---\n\nBody two.');
	const folder = makeFolder('/', [good1, good2]);
	const { app } = makeApp([good1, good2]);
	const linter = new Linter(app, baseSettings(), () => {}, undefined);

	const ok = await linter.lintFolder(folder);

	assert.equal(ok, true);
	const progress = globalThis.__testNotices.find(n => n.messages[0].startsWith('Linting'));
	assert.ok(progress, 'expected a progress Notice');
	assert.equal(progress.hidden, true, 'progress Notice must be hidden when the loop finishes cleanly');
	const summary = globalThis.__testNotices[globalThis.__testNotices.length - 1];
	assert.equal(summary.message, 'Finished linting 2 notes');
});

test('lintFolder: a note whose lintFile throws does not orphan the progress Notice, and the summary reports the failure (WP-H1c)', async () => {
	const good = makeFile('good.md', '---\nsource: x\n---\n\nBody.');
	const bad = makeFile('bad.md', '---\nsource: y\n---\n\nBad body.');
	const folder = makeFolder('/', [good, bad]);
	const { app } = makeApp([good, bad]);
	const linter = new Linter(app, baseSettings(), () => {}, undefined);

	const originalLintFile = linter.lintFile.bind(linter);
	linter.lintFile = async (file, silent) => {
		if (file.path === 'bad.md') throw new Error('boom');
		return originalLintFile(file, silent);
	};

	const ok = await linter.lintFolder(folder);

	assert.equal(ok, false, 'a thrown per-note lint must not be swallowed into success');
	const progress = globalThis.__testNotices.find(n => n.messages[0].startsWith('Linting'));
	assert.ok(progress, 'expected a progress Notice');
	assert.equal(progress.hidden, true, 'progress Notice must still be hidden even though one note threw');
	const summary = globalThis.__testNotices[globalThis.__testNotices.length - 1];
	assert.match(summary.message, /Finished linting 2 notes/);
	assert.match(summary.message, /1 failed/);
	assert.match(summary.message, /bad\.md/);
});

test('lintFolder: a note whose lintFile returns false (internal step failure) is also counted, without throwing', async () => {
	const good = makeFile('good.md', '---\nsource: x\n---\n\nBody.');
	const bad = makeFile('bad.md', '---\nsource: y\n---\n\nBad body.');
	const folder = makeFolder('/', [good, bad]);
	const { app } = makeApp([good, bad]);
	const linter = new Linter(app, baseSettings(), () => {}, undefined);

	const originalLintFile = linter.lintFile.bind(linter);
	linter.lintFile = async (file, silent) => {
		if (file.path === 'bad.md') return false;
		return originalLintFile(file, silent);
	};

	const ok = await linter.lintFolder(folder);

	assert.equal(ok, false);
	const summary = globalThis.__testNotices[globalThis.__testNotices.length - 1];
	assert.match(summary.message, /1 failed/);
	assert.match(summary.message, /bad\.md/);
});
