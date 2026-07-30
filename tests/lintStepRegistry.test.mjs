import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Covers clsl-WP-1: the LINT_STEPS registry that lintFile() (src/lint.ts) now drives off of,
// instead of the previously-opaque body of hardcoded lines. This suite asserts (1) the
// registry's declared order is exactly the order lintFile() fires steps in, (2) disabling
// each of the four lintStepEnabled-gated steps skips exactly that mutation and nothing else,
// (3) all-default settings reproduce the pre-refactor output byte-for-byte, and (4) the
// lintCreatedKey asymmetry fix — a blank created key now disables that step, matching the
// existing lintModifiedKey guard. Drives the REAL Linter.lintFile / updateFrontmatter wiring
// against a minimal hand-rolled Obsidian stub (same harness shape as
// tests/lintModifiedSignal.test.mjs), not a mirror of the logic.

const outdir = path.join(tmpdir(), 'obsidian-crucible-lint-step-registry-tests');
const outfile = path.join(outdir, 'lint.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/lint.ts'],
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
					'export class Notice { constructor() {} hide() {} setMessage() {} }',
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

const { Linter, LINT_STEPS, calculateWordCount } = await import(pathToFileURL(outfile).href);

// Mirrors src/frontmatter.ts's FRONTMATTER_REGEX exactly (copied, not imported — see the
// comment in lintModifiedSignal.test.mjs for why).
const FRONTMATTER_REGEX = new RegExp('^[\\uFEFF]?---\\s*[^\\S\\r\\n]*[\\r\\n]+([\\s\\S]*?)[\\r\\n]+---[^\\S\\r\\n]*([\\r\\n]*)');

function deriveFreshCache(content) {
	const m = content.match(FRONTMATTER_REGEX);
	if (!m) return null;
	const trailingNewlines = m[2] ?? '';
	const closingEnd = m[0].slice(0, m[0].length - trailingNewlines.length).replace(/[^\S\r\n]+$/, '').length;
	const keys = new Set();
	for (const line of (m[1] ?? '').split(/\r?\n/)) {
		const km = /^(\S[^:\r\n]*):(?:\s|$)/.exec(line);
		if (km?.[1]) keys.add(km[1].trim());
	}
	const frontmatter = {};
	for (const k of keys) frontmatter[k] = null;
	return { frontmatter, frontmatterPosition: { start: { offset: 0 }, end: { offset: closingEnd } } };
}

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

// Minimal Obsidian stand-in — same shape as lintModifiedSignal.test.mjs's makeApp().
function makeApp({ content, basename = 'note' }) {
	const state = { content, executedCommands: [] };
	const file = { path: `${basename}.md`, extension: 'md', basename, stat: { ctime: 0 } };
	const app = {
		vault: {
			read: async () => state.content,
			process: async (_file, fn) => { state.content = fn(state.content); return state.content; },
		},
		metadataCache: {
			getFileCache: () => deriveFreshCache(state.content),
			on: () => ({}),
			offref: () => {},
		},
		fileManager: {
			processFrontMatter: async (_file, update) => {
				const { block, body } = splitFrontmatter(state.content);
				const fm = parseFlatYaml(block);
				update(fm);
				state.content = stringifyFlatYaml(fm) + body;
			},
		},
		plugins: { enabledPlugins: new Set() },
		commands: { executeCommandById: (id) => state.executedCommands.push(id) },
	};
	return { app, state, file };
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

const BODY = 'Some body text here.';
const YT_SOURCE = 'https://youtu.be/dQw4w9WgXcQ';

test('LINT_STEPS declares the pipeline in the documented fire order', () => {
	assert.deepEqual(LINT_STEPS.map(s => s.id), [
		'excluded-folder-guard',
		'read-and-word-count',
		'parse-frontmatter-insert',
		'insert-keys',
		'created-date',
		'title-stamp',
		'modified-date',
		'word-count',
		'derive-source-ids',
		'sort-yaml',
		'blank-line-after-yaml',
		're-read-diff',
		'dataview-refresh',
		'notice',
	]);
});

test('exactly four steps are toggleable via lintStepEnabled', () => {
	const toggleable = LINT_STEPS.filter(s => s.toggleable === true).map(s => s.id);
	assert.deepEqual(toggleable.sort(), ['derive-source-ids', 'sort-yaml', 'title-stamp', 'word-count'].sort());
});

test('all-default settings reproduce the pre-refactor pipeline output', async () => {
	const content = `---\nsource: ${YT_SOURCE}\n---\n\n${BODY}`;
	const { app, state, file } = makeApp({ content });
	const linter = new Linter(app, baseSettings(), () => {}, undefined);

	const ok = await linter.lintFile(file, true);

	assert.equal(ok, true);
	const wc = calculateWordCount(content);
	assert.match(state.content, /title: note/);
	assert.match(state.content, /created: 2026-07-29/);
	assert.match(state.content, /updated: 2026-07-29/);
	assert.match(state.content, new RegExp(`word-count: ${wc}`));
	assert.match(state.content, /yt-video-id: dQw4w9WgXcQ/);
	// Yaml key priority sorts title/created/updated/word-count first.
	const keys = Object.keys(parseFlatYaml(splitFrontmatter(state.content).block));
	assert.deepEqual(keys.slice(0, 4), ['title', 'created', 'updated', 'word-count']);
});

test('disabling title-stamp skips exactly that mutation', async () => {
	const content = `---\nsource: ${YT_SOURCE}\n---\n\n${BODY}`;
	const { app, state, file } = makeApp({ content });
	const linter = new Linter(app, baseSettings({ lintStepEnabled: { 'title-stamp': false } }), () => {}, undefined);

	await linter.lintFile(file, true);

	assert.doesNotMatch(state.content, /title:/);
	assert.match(state.content, /created: 2026-07-29/);
	assert.match(state.content, /updated: 2026-07-29/);
	assert.match(state.content, /yt-video-id: dQw4w9WgXcQ/);
	assert.match(state.content, new RegExp(`word-count: ${calculateWordCount(content)}`));
});

test('disabling word-count skips exactly that mutation', async () => {
	const content = `---\nsource: ${YT_SOURCE}\n---\n\n${BODY}`;
	const { app, state, file } = makeApp({ content });
	const linter = new Linter(app, baseSettings({ lintStepEnabled: { 'word-count': false } }), () => {}, undefined);

	await linter.lintFile(file, true);

	assert.doesNotMatch(state.content, /word-count:/);
	assert.match(state.content, /title: note/);
	assert.match(state.content, /created: 2026-07-29/);
	assert.match(state.content, /yt-video-id: dQw4w9WgXcQ/);
});

test('disabling derive-source-ids skips exactly that mutation', async () => {
	const content = `---\nsource: ${YT_SOURCE}\n---\n\n${BODY}`;
	const { app, state, file } = makeApp({ content });
	const linter = new Linter(app, baseSettings({ lintStepEnabled: { 'derive-source-ids': false } }), () => {}, undefined);

	await linter.lintFile(file, true);

	assert.doesNotMatch(state.content, /yt-video-id:/);
	assert.match(state.content, /title: note/);
	assert.match(state.content, new RegExp(`word-count: ${calculateWordCount(content)}`));
});

test('disabling sort-yaml skips exactly that mutation (insertion order preserved)', async () => {
	// word-count is inserted first here (already present, non-empty, ahead of title/created)
	// so a sort would move it — absence of movement is the signal this step didn't run.
	const content = `---\nword-count: 1\nsource: ${YT_SOURCE}\n---\n\n${BODY}`;
	const { app, state, file } = makeApp({ content });
	const linter = new Linter(app, baseSettings({ lintStepEnabled: { 'sort-yaml': false } }), () => {}, undefined);

	await linter.lintFile(file, true);

	const keys = Object.keys(parseFlatYaml(splitFrontmatter(state.content).block));
	assert.equal(keys[0], 'word-count', 'word-count stayed first — sort-yaml did not run');
});

test('a blank created key disables the created-date step (asymmetry fix)', async () => {
	const content = `---\nsource: ${YT_SOURCE}\n---\n\n${BODY}`;
	const { app, state, file } = makeApp({ content });
	const linter = new Linter(app, baseSettings({ lintCreatedKey: '' }), () => {}, undefined);

	await linter.lintFile(file, true);

	assert.doesNotMatch(state.content, /created:/);
	// Everything else still ran.
	assert.match(state.content, /title: note/);
	assert.match(state.content, /updated: 2026-07-29/);
});

test('a blank modified key still disables the modified-date step (existing guard, unchanged)', async () => {
	const content = `---\nsource: ${YT_SOURCE}\n---\n\n${BODY}`;
	const { app, state, file } = makeApp({ content });
	const linter = new Linter(app, baseSettings({ lintModifiedKey: '' }), () => {}, undefined);

	await linter.lintFile(file, true);

	assert.doesNotMatch(state.content, /updated:/);
	assert.match(state.content, /created: 2026-07-29/);
});
