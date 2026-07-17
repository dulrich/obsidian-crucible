import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-frontmatter-barrier-tests');
const outfile = path.join(outdir, 'frontmatter.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/frontmatter.ts'],
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
					'export class Modal {}',
					'export class Notice { constructor() {} hide() {} setMessage() {} }',
					'export class Plugin {}',
					'export class TFile {}',
					'export class TFolder {}',
					'export class TAbstractFile {}',
					'export const Platform = { isDesktopApp: true, isMobileApp: false };',
					'export function normalizePath(path) { return String(path).replace(/\\/+/g, "/"); }',
					'export const moment = Object.assign(() => ({ format: () => "" }), { format: () => "" });',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { updateFrontmatter } = await import(pathToFileURL(outfile));

const file = { path: 'daily/note.md', extension: 'md' };

// Clipper-seeded note: `word-count:` exists with an empty value (the Ingest-as-News shape).
const CONTENT = ['---', 'title: X', 'word-count:', '---', '', 'Body prose.'].join('\n');
// Closing `---` of that block ends at offset 28: "---\n" (4) + "title: X\n" (9) + "word-count:\n" (12) + "---" (3).
const FRESH_CACHE = {
	frontmatter: { title: 'X', 'word-count': null },
	frontmatterPosition: { start: { offset: 0 }, end: { offset: 28 } },
};
// Pre-rename cache: different byte range and key set (the clipper's staged writes not yet indexed).
const STALE_CACHE = {
	frontmatter: { title: 'X' },
	frontmatterPosition: { start: { offset: 0 }, end: { offset: 12 } },
};

// Minimal Obsidian stand-in. processFrontMatter mirrors the real quirk under test: the
// callback's base object comes from the metadata cache's view, so a stale cache means the
// write is computed from (and merged against) outdated state.
function makeApp({ content, cache }) {
	const state = { content, cache, listeners: new Set(), writes: [] };
	const app = {
		vault: { read: async () => state.content },
		metadataCache: {
			getFileCache: () => state.cache,
			on: (_name, cb) => {
				const ref = { cb };
				state.listeners.add(ref);
				return ref;
			},
			offref: ref => state.listeners.delete(ref),
		},
		fileManager: {
			processFrontMatter: async (_file, update) => {
				const fm = { ...(state.cache?.frontmatter ?? {}) };
				update(fm);
				state.writes.push(fm);
			},
		},
	};
	return { app, state };
}

function fireChanged(state, changedFile) {
	for (const ref of [...state.listeners]) ref.cb(changedFile);
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('fresh cache: writes immediately, no listener left behind', async () => {
	const { app, state } = makeApp({ content: CONTENT, cache: FRESH_CACHE });
	await updateFrontmatter(app, file, fm => { fm['word-count'] = 42; }, 100);
	assert.equal(state.writes.length, 1);
	assert.equal(state.writes[0]['word-count'], 42);
	assert.equal(state.listeners.size, 0);
});

test('no frontmatter block and no cache entry counts as fresh', async () => {
	const { app, state } = makeApp({ content: 'Just a body.', cache: null });
	await updateFrontmatter(app, file, fm => { fm.title = 'New'; }, 100);
	assert.equal(state.writes.length, 1);
});

test('stale offsets: the write waits for the cache to settle, then survives (regression: Ingest-as-News drop)', async () => {
	const { app, state } = makeApp({ content: CONTENT, cache: STALE_CACHE });
	const pending = updateFrontmatter(app, file, fm => { fm['word-count'] = 380; }, 5000);
	await tick();
	// Barrier holds: had this written now, the stale-cache merge would have dropped the value.
	assert.equal(state.writes.length, 0);
	state.cache = FRESH_CACHE;
	fireChanged(state, file);
	await pending;
	assert.equal(state.writes.length, 1);
	assert.equal(state.writes[0]['word-count'], 380);
	assert.equal(state.writes[0].title, 'X');
	assert.equal(state.listeners.size, 0);
});

test('changed events for other files do not release the barrier', async () => {
	const { app, state } = makeApp({ content: CONTENT, cache: STALE_CACHE });
	const pending = updateFrontmatter(app, file, fm => { fm['word-count'] = 7; }, 5000);
	await tick();
	fireChanged(state, { path: 'other/note.md', extension: 'md' });
	await tick();
	assert.equal(state.writes.length, 0);
	state.cache = FRESH_CACHE;
	fireChanged(state, file);
	await pending;
	assert.equal(state.writes.length, 1);
});

test('missing cache entry for a note with frontmatter is stale', async () => {
	const { app, state } = makeApp({ content: CONTENT, cache: null });
	const pending = updateFrontmatter(app, file, fm => { fm['word-count'] = 9; }, 5000);
	await tick();
	assert.equal(state.writes.length, 0);
	state.cache = FRESH_CACHE;
	fireChanged(state, file);
	await pending;
	assert.equal(state.writes.length, 1);
});

test('matching offsets but diverged key set is stale', async () => {
	// Same length as `word-count:` so the closing offset matches CONTENT's; only the key differs.
	const content = ['---', 'title: X', 'worm-count:', '---', '', 'Body prose.'].join('\n');
	const { app, state } = makeApp({ content, cache: FRESH_CACHE });
	const pending = updateFrontmatter(app, file, fm => { fm.extra = 1; }, 5000);
	await tick();
	assert.equal(state.writes.length, 0);
	state.cache = {
		frontmatter: { title: 'X', 'worm-count': null },
		frontmatterPosition: { start: { offset: 0 }, end: { offset: 28 } },
	};
	fireChanged(state, file);
	await pending;
	assert.equal(state.writes.length, 1);
});

test('timeout: warns, writes anyway, and escalates when the raw re-read shows the value lost', async () => {
	globalThis.__CRUCIBLE_DEBUG__ = true;
	const warns = [];
	const errors = [];
	const origWarn = console.warn;
	const origError = console.error;
	console.warn = (...args) => warns.push(args.join(' '));
	console.error = (...args) => errors.push(args.join(' '));
	try {
		const { app, state } = makeApp({ content: CONTENT, cache: STALE_CACHE });
		// The fake never persists to content, so `word-count` stays empty on re-read — the drop.
		await updateFrontmatter(app, file, fm => { fm['word-count'] = 42; }, 50);
		assert.equal(state.writes.length, 1);
		assert.ok(warns.some(w => w.includes('stale')), `expected stale warning, got: ${warns.join(' | ')}`);
		assert.ok(errors.some(e => e.includes('word-count')), `expected lost-key escalation, got: ${errors.join(' | ')}`);
		assert.equal(state.listeners.size, 0);
	} finally {
		console.warn = origWarn;
		console.error = origError;
		delete globalThis.__CRUCIBLE_DEBUG__;
	}
});

test('timeout verify passes when the value did land', async () => {
	globalThis.__CRUCIBLE_DEBUG__ = true;
	const errors = [];
	const origError = console.error;
	console.error = (...args) => errors.push(args.join(' '));
	try {
		const landed = ['---', 'title: X', 'word-count: 42', '---', '', 'Body prose.'].join('\n');
		const { app } = makeApp({ content: landed, cache: STALE_CACHE });
		await updateFrontmatter(app, file, fm => { fm['word-count'] = 42; }, 50);
		assert.equal(errors.length, 0, `unexpected escalation: ${errors.join(' | ')}`);
	} finally {
		console.error = origError;
		delete globalThis.__CRUCIBLE_DEBUG__;
	}
});

test('non-markdown files skip the barrier', async () => {
	const { app, state } = makeApp({ content: 'binary-ish', cache: null });
	await updateFrontmatter(app, { path: 'img/pic.png', extension: 'png' }, fm => { fm.x = 1; }, 5000);
	assert.equal(state.writes.length, 1);
});
