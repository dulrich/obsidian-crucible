import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Covers idh-WP-3 scope 3: Linter.lintFile only fires
// `dataview:dataview-rebuild-current-view` when the pass actually changed the file, derived
// by comparing raw content before/after the locked write section (see the comment above
// `let modified = false;` in src/lint.ts). This drives the REAL Linter.lintFile /
// updateFrontmatter wiring (not a mirror) against a minimal hand-rolled Obsidian stub, so a
// regression that breaks the actual gating (not just an isolated helper) would be caught.
// `noteLocks` is left undefined — withOptionalNoteLock then just runs the action inline
// (src/orchestration/NoteLockManager.ts's own `withOptionalNoteLock` short-circuits on
// undefined), so this doesn't need to stand up a NoteLockManager.

const outdir = path.join(tmpdir(), 'obsidian-crucible-lint-modified-signal-tests');
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
					'export const moment = Object.assign(() => ({ format: () => "2026-07-27" }), { format: () => "2026-07-27" });',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { Linter, calculateWordCount } = await import(pathToFileURL(outfile).href);

// Mirrors src/frontmatter.ts's FRONTMATTER_REGEX exactly (copied, not imported — the
// production regex is the single source of truth; this is only used to derive a
// metadataCache stand-in that reports "fresh" for whatever content the fixture starts
// with, so updateFrontmatter's stale-cache barrier never engages and the test stays
// about the modified-signal, not the barrier).
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

// Flat, no-nesting frontmatter round-trip — enough for the fixtures below (all values are
// bare scalars). Splitting/reassembling this way means an update() that touches nothing
// reproduces the original bytes exactly, which is what makes the "no write" fixture a
// meaningful test of the modified-signal rather than an artifact of re-serialization.
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

// Minimal Obsidian stand-in: vault.read/process are real content-based read/modify,
// fileManager.processFrontMatter is a real (if flat-only) parse/update/reserialize round
// trip against that same content, and metadataCache always reports the cache matching
// whatever the content currently is (see deriveFreshCache) — updateFrontmatter's barrier
// is not what this test is about.
function makeApp({ content }) {
	const state = { content, executedCommands: [] };
	const file = { path: 'note.md', extension: 'md', basename: 'note', stat: { ctime: 0 } };
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
		plugins: { enabledPlugins: new Set(['dataview']) },
		commands: { executeCommandById: (id) => state.executedCommands.push(id) },
	};
	return { app, state, file };
}

function baseSettings(overrides = {}) {
	return {
		excludedFolders: [],
		lintFrontmatterInsert: '',
		lintCreatedKey: 'created',
		lintModifiedKey: '', // falsy: skip the always-writes-today's-date branch entirely
		lintBlankLineAfterYaml: false,
		lintYamlKeyPriority: [], // neutralizes sortFrontmatterProperties' reordering
		...overrides,
	};
}

const BODY = 'Some body text here.';
const WORD_COUNT = calculateWordCount(BODY);

test('a lint pass that changes nothing does not fire the dataview rebuild', async () => {
	// title/created already present (non-empty) so the *IfEmpty upserts are no-ops, and
	// word-count already matches what this pass will compute — nothing for processFrontMatter
	// to actually change, so the reserialized content should be byte-identical.
	const content = `---\ntitle: note\ncreated: 2026-01-01\nword-count: ${WORD_COUNT}\n---\n\n${BODY}`;
	const { app, state, file } = makeApp({ content });
	const linter = new Linter(app, baseSettings(), () => {}, undefined);

	const ok = await linter.lintFile(file, false);

	assert.equal(ok, true);
	assert.deepEqual(state.executedCommands, [], 'no dataview rebuild fired when the pass wrote nothing new');
});

test('a lint pass that actually writes fires the dataview rebuild', async () => {
	// word-count is wrong going in, so upsertFrontmatterProperty(fm, 'word-count', wordCount)
	// changes it — a genuine write.
	const content = `---\ntitle: note\ncreated: 2026-01-01\nword-count: 1\n---\n\n${BODY}`;
	const { app, state, file } = makeApp({ content });
	const linter = new Linter(app, baseSettings(), () => {}, undefined);

	const ok = await linter.lintFile(file, false);

	assert.equal(ok, true);
	assert.deepEqual(
		state.executedCommands,
		['dataview:dataview-rebuild-current-view'],
		'the dataview rebuild fires exactly once when the pass changed the file',
	);
	assert.match(state.content, new RegExp(`word-count: ${WORD_COUNT}`), 'the write actually landed');
});

test('a silent lint pass never fires the dataview rebuild, whether or not it wrote', async () => {
	const content = `---\ntitle: note\ncreated: 2026-01-01\nword-count: 1\n---\n\n${BODY}`;
	const { app, state, file } = makeApp({ content });
	const linter = new Linter(app, baseSettings(), () => {}, undefined);

	const ok = await linter.lintFile(file, true);

	assert.equal(ok, true);
	assert.deepEqual(state.executedCommands, [], 'silent passes (lintFolder/lintVault) never touch dataview, regardless of modified');
});

test('the dataview rebuild does not fire when the dataview plugin is not enabled, even on a real write', async () => {
	const content = `---\ntitle: note\ncreated: 2026-01-01\nword-count: 1\n---\n\n${BODY}`;
	const { app, state, file } = makeApp({ content });
	app.plugins.enabledPlugins = new Set(); // dataview not installed/enabled
	const linter = new Linter(app, baseSettings(), () => {}, undefined);

	await linter.lintFile(file, false);

	assert.deepEqual(state.executedCommands, []);
});

test('Note linted notice-worthy return value stays true regardless of modified (lintFile\'s success contract is unchanged)', async () => {
	const unchanged = `---\ntitle: note\ncreated: 2026-01-01\nword-count: ${WORD_COUNT}\n---\n\n${BODY}`;
	const { app: appA, file: fileA } = makeApp({ content: unchanged });
	const linterA = new Linter(appA, baseSettings(), () => {}, undefined);
	assert.equal(await linterA.lintFile(fileA, false), true);

	const changed = `---\ntitle: note\ncreated: 2026-01-01\nword-count: 1\n---\n\n${BODY}`;
	const { app: appB, file: fileB } = makeApp({ content: changed });
	const linterB = new Linter(appB, baseSettings(), () => {}, undefined);
	assert.equal(await linterB.lintFile(fileB, false), true);
});
