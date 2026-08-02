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
					// Minimal flat-scalar YAML round-trip — only what the content-splice repair
					// path under test needs (string/number/boolean/null values, no nesting, no
					// quoted scalars in these fixtures).
					'export function parseYaml(text) {',
					'  const obj = {};',
					'  if (!text) return obj;',
					'  const lines = String(text).split(/\\r?\\n/);',
					'  for (const line of lines) {',
					'    const m = /^(\\S[^:\\r\\n]*):[ \\t]?(.*)$/.exec(line);',
					'    if (!m) continue;',
					'    const key = m[1].trim();',
					'    const raw = m[2].trim();',
					'    if (raw === "") { obj[key] = null; continue; }',
					'    if (raw === "true") { obj[key] = true; continue; }',
					'    if (raw === "false") { obj[key] = false; continue; }',
					'    if (/^-?\\d+(\\.\\d+)?$/.test(raw)) { obj[key] = Number(raw); continue; }',
					'    obj[key] = raw;',
					'  }',
					'  return obj;',
					'}',
					'export function stringifyYaml(obj) {',
					'  if (obj === null || obj === undefined) return "\\n";',
					'  const lines = [];',
					'  for (const key of Object.keys(obj)) {',
					'    const v = obj[key];',
					'    if (v === null || v === undefined) lines.push(key + ":");',
					'    else lines.push(key + ": " + v);',
					'  }',
					'  return lines.join("\\n") + "\\n";',
					'}',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { updateFrontmatter, withWriteWatchdog } = await import(pathToFileURL(outfile));

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
// write is computed from (and merged against) outdated state — and, matching the real
// silent-drop bug, does not persist to `state.content` at all when the cache is stale.
// `vault.process` is a real, content-based read-modify-write: it's what the content-splice
// repair path uses to actually land the mutation.
function makeApp({ content, cache }) {
	const state = { content, cache, listeners: new Set(), writes: [] };
	const app = {
		vault: {
			read: async () => state.content,
			process: async (_file, fn) => {
				state.content = fn(state.content);
				return state.content;
			},
		},
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

test('never-indexed cache (inverted asymmetry): no dead wait, splice-updates the existing block instead (WP-H1)', async () => {
	// The cache has never indexed a frontmatterPosition for this file at all — a first
	// lint right after creation, or a second lint immediately after a formerly-empty note
	// gained its first block — while the raw content already has a real `---` block. This
	// used to burn the full cacheBarrierTimeoutMs waiting for a `changed` event nothing
	// guarantees will fire for this specific transition (the old assertion below proved
	// it: writes only landed after a manually-fired `fireChanged`). It must now resolve
	// immediately via the same index-based splice machinery as the block-deleted case,
	// never through processFrontMatter (which this file's own header comment establishes
	// merges against the cache's view — unsafe to hand a file with no cached position).
	const { app, state } = makeApp({ content: CONTENT, cache: null });
	const start = Date.now();
	await updateFrontmatter(app, file, fm => { fm['word-count'] = 9; }, 5000);
	const elapsed = Date.now() - start;
	assert.ok(elapsed < 200, `expected no dead wait against a 5000ms barrier, took ${elapsed}ms`);
	assert.equal(state.writes.length, 0, 'processFrontMatter must never see a file the cache has no position for at all');
	assert.equal(state.listeners.size, 0, 'no metadataCache listener should be left behind');
	const block = state.content.match(/---\n([\s\S]*?)\n---/)?.[1];
	assert.ok(block, `expected the existing frontmatter block to survive, got:\n${state.content}`);
	assert.ok(/word-count: 9/.test(block), `expected word-count to land, got:\n${block}`);
	assert.ok(/title: X/.test(block), 'other keys must survive the splice-update');
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

test('timeout: warns, writes anyway, then repairs via content splice when the value is lost (WP-R5)', async () => {
	globalThis.__CRUCIBLE_DEBUG__ = true;
	const warns = [];
	const errors = [];
	const origWarn = console.warn;
	const origError = console.error;
	console.warn = (...args) => warns.push(args.join(' '));
	console.error = (...args) => errors.push(args.join(' '));
	try {
		const { app, state } = makeApp({ content: CONTENT, cache: STALE_CACHE });
		// The fake processFrontMatter never persists to content, so `word-count` stays
		// empty on the first re-read — the drop the real bulk-churn bug produces. The
		// content-splice repair must then land it via vault.process instead of merely
		// logging the loss.
		await updateFrontmatter(app, file, fm => { fm['word-count'] = 42; }, 50);
		assert.equal(state.writes.length, 1, 'the first (dropped) processFrontMatter attempt still happens');
		assert.ok(warns.some(w => w.includes('stale')), `expected stale warning, got: ${warns.join(' | ')}`);
		assert.ok(
			warns.some(w => w.includes('repairing via content-based splice')),
			`expected repair warning, got: ${warns.join(' | ')}`,
		);
		assert.equal(errors.length, 0, `repair should land the value with no escalation, got: ${errors.join(' | ')}`);
		const block = state.content.match(/---\n([\s\S]*?)\n---/)[1];
		assert.ok(/word-count: 42/.test(block), `expected the repaired content to carry word-count: 42, got:\n${block}`);
		assert.ok(/title: X/.test(block), 'other keys must survive the splice');
		assert.equal(state.listeners.size, 0);
	} finally {
		console.warn = origWarn;
		console.error = origError;
		delete globalThis.__CRUCIBLE_DEBUG__;
	}
});

test('sustained churn: cache stays stale past the deadline, but a job-claim mutation still lands (zero stranded — WP-R5)', async () => {
	const content = ['---', 'id: job-1', 'status: queued', 'updated: 2026-07-26T18:04:00Z', '---', '', 'Job body.'].join('\n');
	// Models the metadataCache's view of a job file mid-churn: a several-thousand-file
	// bulk rename (`requeueServiceFailures`) keeps the cache's indexing behind for the
	// whole barrier window and beyond, so it never reflects the real, current key set.
	const churnStaleCache = {
		frontmatter: { id: 'job-1' },
		frontmatterPosition: { start: { offset: 0 }, end: { offset: 10 } },
	};
	const { app, state } = makeApp({ content, cache: churnStaleCache });
	// The cache never settles (no fireChanged call) — mirrors the churn burst outliving
	// JobStore.move's barrier window, which is exactly the observed strand.
	await updateFrontmatter(app, file, fm => {
		fm.status = 'running';
		fm.updated = '2026-07-26T18:05:00Z';
	}, 30);
	const block = state.content.match(/---\n([\s\S]*?)\n---/)[1];
	assert.ok(/status: running/.test(block), `expected the claim status to land, got:\n${block}`);
	assert.ok(/updated: 2026-07-26T18:05:00Z/.test(block), `expected the claim timestamp to land, got:\n${block}`);
	assert.ok(/id: job-1/.test(block), 'unrelated keys must survive the repair');
	assert.equal(state.listeners.size, 0);
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

test('block deleted: cache claims a frontmatter block but raw content has none — no dead wait, splice-creates instead (WP-G4)', async () => {
	const { app, state } = makeApp({ content: 'Just a body, block already gone.', cache: FRESH_CACHE });
	const start = Date.now();
	await updateFrontmatter(app, file, fm => { fm.title = 'Recovered'; }, 5000);
	const elapsed = Date.now() - start;
	assert.ok(elapsed < 200, `expected no dead wait against a 5000ms barrier, took ${elapsed}ms`);
	assert.equal(state.writes.length, 0, 'processFrontMatter must never see the stale, now-nonexistent position');
	assert.equal(state.listeners.size, 0, 'no metadataCache listener should be left behind');
	const block = state.content.match(/---\n([\s\S]*?)\n---/)?.[1];
	assert.ok(block, `expected a valid created frontmatter block, got:\n${state.content}`);
	assert.ok(/title: Recovered/.test(block), `expected title to land, got:\n${block}`);
	assert.ok(state.content.includes('Just a body, block already gone.'), 'body content must survive');
});

test('block deleted with a stale (not fresh) cache also short-circuits to splice-create', async () => {
	const { app, state } = makeApp({ content: 'No block here either.', cache: STALE_CACHE });
	const start = Date.now();
	await updateFrontmatter(app, file, fm => { fm['word-count'] = 11; }, 5000);
	const elapsed = Date.now() - start;
	assert.ok(elapsed < 200, `expected no dead wait, took ${elapsed}ms`);
	assert.equal(state.writes.length, 0);
	const block = state.content.match(/---\n([\s\S]*?)\n---/)?.[1];
	assert.ok(/word-count: 11/.test(block), `expected word-count to land, got:\n${block}`);
});

test('non-markdown files skip the barrier', async () => {
	const { app, state } = makeApp({ content: 'binary-ish', cache: null });
	await updateFrontmatter(app, { path: 'img/pic.png', extension: 'png' }, fm => { fm.x = 1; }, 5000);
	assert.equal(state.writes.length, 1);
});

test('write watchdog: logError fires once the op outlives the threshold, naming op/file/elapsed (WP-H1b)', async () => {
	globalThis.__CRUCIBLE_DEBUG__ = true;
	const errors = [];
	const origError = console.error;
	console.error = (...args) => errors.push(args.join(' '));
	try {
		let resolveOp;
		const op = new Promise(resolve => { resolveOp = resolve; });
		const watched = withWriteWatchdog(file, 'vault.process (test)', op, 20);
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.ok(
			errors.some(e => e.includes('vault.process (test)') && e.includes(file.path)),
			`expected a watchdog logError naming the op and file, got: ${errors.join(' | ')}`,
		);
		resolveOp('done');
		assert.equal(await watched, 'done', 'the watchdog must not race/reject — the op still resolves normally');
	} finally {
		console.error = origError;
		delete globalThis.__CRUCIBLE_DEBUG__;
	}
});

test('write watchdog: does not fire when the op settles before the threshold', async () => {
	globalThis.__CRUCIBLE_DEBUG__ = true;
	const errors = [];
	const origError = console.error;
	console.error = (...args) => errors.push(args.join(' '));
	try {
		const op = new Promise(resolve => setTimeout(() => resolve('quick'), 5));
		const result = await withWriteWatchdog(file, 'vault.process (test)', op, 100);
		assert.equal(result, 'quick');
		// Give the (should-be-cleared) timer a chance to fire if it wasn't actually cleared.
		await new Promise(resolve => setTimeout(resolve, 150));
		assert.equal(errors.length, 0, `expected no watchdog log for a fast-settling op, got: ${errors.join(' | ')}`);
	} finally {
		console.error = origError;
		delete globalThis.__CRUCIBLE_DEBUG__;
	}
});

test('write watchdog: a rejecting op still rejects, and does not fire the watchdog once settled', async () => {
	globalThis.__CRUCIBLE_DEBUG__ = true;
	const errors = [];
	const origError = console.error;
	console.error = (...args) => errors.push(args.join(' '));
	try {
		const op = Promise.reject(new Error('write failed'));
		await assert.rejects(() => withWriteWatchdog(file, 'vault.process (test)', op, 50), /write failed/);
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.equal(errors.length, 0, `expected no watchdog log once the op already settled (rejected), got: ${errors.join(' | ')}`);
	} finally {
		console.error = origError;
		delete globalThis.__CRUCIBLE_DEBUG__;
	}
});
