import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Covers idh-WP-3 scope (c): ChainManager's private `reconcileOpenEditor` (src/chains.ts)
// forces an open markdown editor's buffer to match disk after a chain finishes, so a stale
// editor autosave can't clobber the chain's writes. A view that is still mid-load reports ''
// from `getViewData()` before its own `onLoadFile` has populated it — writing disk content
// into it at that moment races the load, and (per the AGENTS.md quirk this WP adds) can leave
// the note visibly blank or straddling two buffers. The guard: skip (and logWarn) a leaf whose
// `getViewData()` is empty while disk is non-empty, instead of calling `setViewData`.
//
// `reconcileOpenEditor` is `private` in TypeScript, but privacy is compile-time only — the
// compiled method is an ordinary property, callable directly here. This drives the REAL method
// (not a mirror) against a minimal hand-rolled Obsidian stub.
//
// Like the captures guard test, this needs `view instanceof MarkdownView` to actually pass, so
// the obsidian stub is written to a real `node_modules/obsidian` next to the bundle output and
// left external (not inlined via an esbuild virtual module), so the test can import the exact
// same module instance the bundle resolved and construct a real `MarkdownView`.

const outdir = path.join(tmpdir(), 'obsidian-crucible-chain-reconcile-guard-tests');
const outfile = path.join(outdir, 'chains.mjs');
const obsidianDir = path.join(outdir, 'node_modules', 'obsidian');
const obsidianEntry = path.join(obsidianDir, 'index.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(obsidianDir, { recursive: true });

await writeFile(
	path.join(obsidianDir, 'package.json'),
	JSON.stringify({ name: 'obsidian', type: 'module', main: 'index.mjs' }),
);
await writeFile(
	obsidianEntry,
	[
		// chains.ts pulls in lint.ts (calculateWordCount) and utils.ts, so this needs the
		// same broad export set as tests/lintModifiedSignal.test.mjs's virtual stub, plus
		// Modal/Editor for chains.ts itself.
		'export class App {}',
		'export class Editor {}',
		'export class MarkdownView {}',
		'export class Modal { constructor(app) { this.app = app; } }',
		'export class Notice { constructor() {} hide() {} setMessage() {} }',
		'export class Plugin {}',
		'export class TFile {}',
		'export class TFolder {}',
		'export class TAbstractFile {}',
		'export const Platform = { isDesktopApp: true, isMobileApp: false, isMacOS: false };',
		'export function normalizePath(path) { return String(path).replace(/\\\\+/g, "/"); }',
		'export function parseYaml() { return {}; }',
		'export function debounce(fn) { return fn; }',
		'export function getAllTags() { return []; }',
		'export const moment = Object.assign(() => ({ format: () => "2026-07-27" }), { format: () => "2026-07-27" });',
		'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
		'',
	].join('\n'),
);

await esbuild.build({
	entryPoints: ['src/chains.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	external: ['obsidian'],
	outfile,
	logLevel: 'silent',
});

const { MarkdownView, TFile } = await import(pathToFileURL(obsidianEntry).href);
const { ChainManager } = await import(pathToFileURL(outfile).href);

class FakeFile extends TFile {
	constructor(filePath) {
		super();
		this.path = filePath;
	}
}

class FakeLeaf {
	constructor(view) {
		this.view = view;
	}
}

class FakeMarkdownView extends MarkdownView {
	constructor(file, viewData) {
		super();
		this.file = file;
		this._viewData = viewData;
		this.setViewDataCalls = [];
	}
	getViewData() {
		return this._viewData;
	}
	setViewData(data, clear) {
		this.setViewDataCalls.push({ data, clear });
		this._viewData = data;
	}
}

function makeApp({ diskContent, leaves }) {
	const app = {
		vault: {
			read: async () => diskContent,
		},
		workspace: {
			getLeavesOfType: (type) => (type === 'markdown' ? leaves : []),
		},
	};
	return app;
}

test('a mid-load view (empty getViewData) is skipped, not overwritten, while disk is non-empty', async () => {
	const file = new FakeFile('note.md');
	const diskContent = '---\ntitle: note\n---\n\nBody written by the chain.';
	const midLoadView = new FakeMarkdownView(file, '');
	const leaves = [new FakeLeaf(midLoadView)];
	const app = makeApp({ diskContent, leaves });
	const manager = new ChainManager(app, undefined);

	await manager.reconcileOpenEditor(file);

	assert.deepEqual(midLoadView.setViewDataCalls, [], 'setViewData is never called on a mid-load (empty) view');
	assert.equal(midLoadView.getViewData(), '', 'the view buffer is left alone, still empty');
});

test('a loaded, stale view (non-empty, mismatched getViewData) is still reconciled to disk', async () => {
	const file = new FakeFile('note.md');
	const diskContent = '---\ntitle: note\n---\n\nBody written by the chain.';
	const staleView = new FakeMarkdownView(file, '---\ntitle: note\n---\n\nStale buffer.');
	const leaves = [new FakeLeaf(staleView)];
	const app = makeApp({ diskContent, leaves });
	const manager = new ChainManager(app, undefined);

	await manager.reconcileOpenEditor(file);

	assert.equal(staleView.setViewDataCalls.length, 1, 'a genuinely stale (non-empty) view is still reconciled');
	assert.equal(staleView.getViewData(), diskContent);
});

test('a view already matching disk is left untouched (no-op, existing behavior)', async () => {
	const file = new FakeFile('note.md');
	const diskContent = '---\ntitle: note\n---\n\nAlready in sync.';
	const view = new FakeMarkdownView(file, diskContent);
	const leaves = [new FakeLeaf(view)];
	const app = makeApp({ diskContent, leaves });
	const manager = new ChainManager(app, undefined);

	await manager.reconcileOpenEditor(file);

	assert.deepEqual(view.setViewDataCalls, []);
});

test('a leaf for a different file is not touched', async () => {
	const file = new FakeFile('note.md');
	const otherFile = new FakeFile('other.md');
	const diskContent = '---\ntitle: note\n---\n\nBody.';
	const otherView = new FakeMarkdownView(otherFile, '');
	const leaves = [new FakeLeaf(otherView)];
	const app = makeApp({ diskContent, leaves });
	const manager = new ChainManager(app, undefined);

	await manager.reconcileOpenEditor(file);

	assert.deepEqual(otherView.setViewDataCalls, [], 'a leaf viewing a different note is filtered out before the guard runs');
});
