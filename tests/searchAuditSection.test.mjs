// WP-I2: the Search-audit Ingestion-dashboard section (src/ingestion/sections/searchAudit.ts) —
// rebuilt around ONE merged Summary/Repair statistics table (replacing WP-H4's pill filter bar +
// image-coverage pill row + "Repair all" button). `obsidian` is external and backed by a real
// node_modules/obsidian package written into the build's tmp dir (same pattern
// tests/missingAttachments.test.mjs uses) so `TFile` instances the test constructs are the SAME
// class the compiled module's `instanceof TFile` check runs against — an inlined esbuild-plugin
// stub (the cells.ts/queueMonitor.ts convention elsewhere) can't give that identity guarantee.
// Two of the section's imports (`src/confirmModal.ts`, `src/retryImageDescriptionsModal.ts`) are
// intercepted with programmable stubs the same way tests/searchAuditRunEnqueueRepairs.test.mjs
// stubs `confirmModal` — the images-pending/images-failed wrenches drive real Modal-shaped code
// (auditRun.ts's `confirmAndQueueImageDescribeBackfill`/`retryFailedImageDescriptions`) that would
// otherwise hang on the obsidian stub's no-op `Modal.open()`.
// `plugin.settings.destructiveConfirmGlobal = false` keeps the orphan-repair confirm GATE itself
// out of scope here — WP-H3's own test file already covers that mechanism; this file is about the
// section's wiring on top of it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { beforeEach } from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-audit-section-tests');
const outfile = path.join(outdir, 'searchAudit.mjs');
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
		'export class App {}',
		'export class Modal { constructor() {} open() {} close() {} }',
		'export class Notice { constructor() {} hide() {} setMessage() {} }',
		'export class Plugin {}',
		'export class TFile { constructor(path) { this.path = path; } }',
		'export class TFolder {}',
		'export class TAbstractFile {}',
		'export function prepareFuzzySearch() { return () => null; }',
		'export function debounce(fn) { return fn; }',
		// Recording stub: sets an `iconName` property on the element it was called with.
		'export function setIcon(el, name) { if (el) el.iconName = name; }',
		'export function normalizePath(p) { return String(p).replace(/\\\\+/g, "/"); }',
		'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
		'export function htmlToMarkdown() { return ""; }',
		'export function parseYaml() { return {}; }',
		'export function getAllTags() { return []; }',
		'export const Platform = { isDesktopApp: true, isMobileApp: false };',
		'export const moment = Object.assign(() => ({ format: () => "" }), { format: () => "" });',
		'',
	].join('\n'),
);

await esbuild.build({
	entryPoints: ['src/ingestion/sections/searchAudit.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	external: ['obsidian'],
	plugins: [
		{
			name: 'confirm-modal-stub',
			setup(build) {
				build.onResolve({ filter: /confirmModal$/ }, () => ({ path: 'confirm-modal-stub', namespace: 'confirm-stub' }));
				build.onLoad({ filter: /.*/, namespace: 'confirm-stub' }, () => ({
					contents: [
						'globalThis.__confirmModalCalls = globalThis.__confirmModalCalls ?? [];',
						'export class ConfirmModal {',
						'  constructor(app, options) { this.app = app; this.options = options; }',
						'  openAndAwait() {',
						'    globalThis.__confirmModalCalls.push(this.options);',
						'    return Promise.resolve(globalThis.__confirmModalResult);',
						'  }',
						'}',
					].join('\n'),
					loader: 'js',
				}));
			},
		},
		{
			// The images-failed wrench drives `retryFailedImageDescriptions` (auditRun.ts), which
			// opens a `RetryFailedImageDescriptionsModal` and awaits its 3-way choice. The real class
			// extends obsidian's `Modal` whose stub `open()` is a no-op (never calls `onOpen`), so
			// without this stub the promise would never resolve. Same programmable-global shape as
			// confirm-modal-stub above, with its own call/result globals so the two never collide.
			name: 'retry-modal-stub',
			setup(build) {
				build.onResolve({ filter: /retryImageDescriptionsModal$/ }, () => ({ path: 'retry-modal-stub', namespace: 'retry-stub' }));
				build.onLoad({ filter: /.*/, namespace: 'retry-stub' }, () => ({
					contents: [
						'globalThis.__retryModalCalls = globalThis.__retryModalCalls ?? [];',
						'export class RetryFailedImageDescriptionsModal {',
						'  constructor(app) { this.app = app; }',
						'  openAndAwait() {',
						'    globalThis.__retryModalCalls.push(true);',
						'    return Promise.resolve(globalThis.__retryModalResult);',
						'  }',
						'}',
					].join('\n'),
					loader: 'js',
				}));
			},
		},
	],
	outfile,
	logLevel: 'silent',
});

const { TFile } = await import(pathToFileURL(obsidianEntry).href);
const { createSearchAuditSection } = await import(pathToFileURL(outfile).href);

/* ------------------------------------------------------------------------- fake DOM */

// Merges the table-capable FakeEl (ingestionTableCapAndGating.test.mjs — createEl/empty/
// querySelectorAll, needed by renderTableSection/renderSortableTable's unkeyed rebuild path) with
// the attrs-capable makeFakeEl (ingestionIntakeActionCell.test.mjs — setAttr, needed by
// renderIconButton's aria-label/title). No shared test-util module exists for this in the repo
// (each section-adjacent test file defines its own stub), so this follows the same convention.
// WP-I2 additions: `closest()` (a single-class-selector walk, enough for the section's own
// `.closest('.crucible-intake-action-cell')` guard) and real click BUBBLING (the summary table's
// filter click listener lives on the <tr>, not the nested condition <button> — exactly how a real
// browser's event model works, so the fake must reproduce it for the click-delegation tests to be
// meaningful rather than accidentally-passing).
class FakeEl {
	constructor(tag = 'div') {
		this.tagName = tag.toUpperCase();
		this.className = '';
		this.textContent = '';
		this.children = [];
		this.parentElement = null;
		this.attrs = {};
		this.disabled = false;
		this.iconName = null;
		this._listeners = {};
	}
	createDiv(opts) { return this.createEl('div', opts); }
	createSpan(opts) { return this.createEl('span', opts); }
	createEl(tag, opts = {}) {
		const el = new FakeEl(tag);
		if (opts.cls) el.className = opts.cls;
		if (opts.text != null) el.textContent = opts.text;
		el.parentElement = this;
		this.children.push(el);
		return el;
	}
	empty() {
		this.children = [];
		this.textContent = '';
	}
	addClass(c) { this.className = this.className ? `${this.className} ${c}` : c; }
	appendText(t) { this.textContent += t; }
	setText(t) { this.textContent = t; this.children = []; }
	setAttr(k, v) { this.attrs[k] = v; }
	addEventListener(evt, fn) { (this._listeners[evt] ??= []).push(fn); }
	closest(selector) {
		const cls = selector.replace('.', '');
		let el = this;
		while (el) {
			if (el.className && el.className.split(' ').includes(cls)) return el;
			el = el.parentElement;
		}
		return null;
	}
	click() {
		const evt = { target: this, _stopped: false, stopPropagation() { this._stopped = true; } };
		let el = this;
		while (el && !evt._stopped) {
			for (const fn of el._listeners.click ?? []) fn(evt);
			el = el.parentElement;
		}
	}
	querySelectorAll(tag) {
		const wanted = tag.toUpperCase();
		const out = [];
		const walk = (node) => {
			for (const c of node.children) {
				if (c.tagName === wanted) out.push(c);
				walk(c);
			}
		};
		walk(this);
		return out;
	}
}

function buttons(el) { return el.querySelectorAll('button'); }
function trs(el) { return el.querySelectorAll('tr').filter(tr => tr.parentElement.tagName === 'TBODY'); }
// A row's own visible text, independent of whether the label cell holds a <button> (clickable) or
// plain text (not) — reads td[0]'s own text plus any child's, since setText()/createEl({text})
// both land on different nodes depending on the branch.
function rowLabelText(tr) {
	const td = tr.children[0];
	if (td.textContent) return td.textContent;
	const btn = buttons(td)[0];
	return btn ? btn.textContent : '';
}

/* ------------------------------------------------------------------------- fixture plugin */

// Six paths, one per SearchAuditResult path class, computed by the REAL computeSearchAudit/
// identifyAuditCandidates (src/search/audit.ts) from this input — not hand-assembled, so the
// fixture stays honest to what runSearchAudit would actually produce:
//   missing.md      -> in vault, not indexed, chunkCount 3 > 0                => missing
//   unindexable.md  -> in vault, not indexed, chunkCount 0                    => unindexable
//   stale.md        -> indexed mtime older, fresh hash differs from indexed   => stale
//   mtimeonly.md    -> indexed mtime older, fresh hash MATCHES indexed        => mtimeOnly
//   clean.md        -> indexed mtime matches exactly, not a candidate at all  => (nothing)
//   embedgap.md     -> indexed, chunkCount 4 > embeddedCount 2, semantic on   => embeddingGaps
//   orphan.md       -> indexed, absent from vaultFiles                       => orphans
// Three referenced images (opt-in via `withImages`), same shape as the old "image-coverage row"
// test: one described, one durably failed, one pending — giving every one of the summary table's
// nine rows a non-zero count at once, which the "renders all 9 rows" test needs.
const DESCRIBED_MD5 = 'a'.repeat(32);
const FAILED_MD5 = 'b'.repeat(32);
const PENDING_MD5 = 'c'.repeat(32);
const DESCRIBED_PATH = `img/${DESCRIBED_MD5}_MD5.png`;
const FAILED_PATH = `img/${FAILED_MD5}_MD5.png`;
const PENDING_PATH = `img/${PENDING_MD5}_MD5.png`;

function makeFixturePlugin(overrides = {}) {
	const vaultFiles = [
		{ path: 'missing.md', mtime: 100 },
		{ path: 'unindexable.md', mtime: 100 },
		{ path: 'stale.md', mtime: 500 },
		{ path: 'mtimeonly.md', mtime: 500 },
		{ path: 'clean.md', mtime: 100 },
		{ path: 'embedgap.md', mtime: 100 },
	];
	const indexedPaths = [
		{ path: 'stale.md', mtime: 100, contentHash: 'OLD', chunkCount: 2, embeddedCount: 2 },
		{ path: 'mtimeonly.md', mtime: 100, contentHash: 'SAME', chunkCount: 2, embeddedCount: 2 },
		{ path: 'clean.md', mtime: 100, contentHash: 'X', chunkCount: 1, embeddedCount: 1 },
		{ path: 'embedgap.md', mtime: 100, contentHash: 'Y', chunkCount: 4, embeddedCount: 2 },
		{ path: 'orphan.md', mtime: 100, contentHash: 'Z', chunkCount: 1, embeddedCount: 1 },
	];
	const prepareMap = new Map([
		['missing.md', { contentHash: 'm', chunkCount: 3 }],
		['unindexable.md', { contentHash: 'u', chunkCount: 0 }],
		['stale.md', { contentHash: 'NEW', chunkCount: 5 }],
		['mtimeonly.md', { contentHash: 'SAME', chunkCount: 2 }],
	]);

	const withImages = overrides.withImages ?? false;
	const vaultImageFiles = withImages ? [{ path: DESCRIBED_PATH }, { path: FAILED_PATH }, { path: PENDING_PATH }] : [];
	const resolvedLinks = withImages
		? { 'note.md': { [DESCRIBED_PATH]: 1, [FAILED_PATH]: 1, [PENDING_PATH]: 1 } }
		: {};

	const enqueueCalls = [];
	const resolvable = overrides.resolvablePaths ?? new Set();
	const plugin = {
		app: {
			vault: {
				getFiles: () => vaultImageFiles,
				getAbstractFileByPath: (p) => (resolvable.has(p) ? new TFile(p) : null),
			},
			metadataCache: { resolvedLinks },
			workspace: { openLinkText: (...args) => { plugin.__openCalls.push(args); } },
		},
		__openCalls: [],
		settings: {
			searchEnabled: true,
			searchSemanticEnabled: true,
			destructiveConfirmGlobal: false,
			destructiveConfirmAction: {},
			destructiveConfirmTier: {},
		},
		searchManager: {
			listIndexableFiles: () => vaultFiles.map(f => ({ path: f.path, stat: { mtime: f.mtime } })),
			client: () => ({ listPaths: async () => ({ paths: indexedPaths }) }),
			auditPrepareFile: async (file) => prepareMap.get(file.path) ?? null,
		},
		imageDescriptions: {
			ensureLoaded: async () => {},
			has: (md5) => withImages && md5 !== PENDING_MD5,
			get: async (md5) => (withImages && md5 === FAILED_MD5 ? { kind: 'failed' } : { kind: 'described' }),
		},
		imageDescriptionsPruneCalls: [],
		orchestrator: {
			enqueue: async (type, params, opts) => {
				enqueueCalls.push({ type, params, opts });
				return { created: new Date(Date.now() + 60_000).toISOString() };
			},
		},
	};
	// pruneFailed is only reachable via the real retryFailedImageDescriptions helper, which needs
	// it on `plugin.imageDescriptions` directly (see auditRun.ts).
	plugin.imageDescriptions.pruneFailed = async (choice) => {
		plugin.imageDescriptionsPruneCalls.push(choice);
		return [FAILED_MD5];
	};
	return { plugin, enqueueCalls };
}

function makeHost(plugin) {
	const state = { count: null, meta: null };
	const host = {
		plugin,
		app: plugin.app,
		refresh: async () => {},
		setSectionCount: (_id, n) => { state.count = n; },
		setSectionMeta: (_id, text) => { state.meta = text; },
	};
	return { host, state };
}

function makeCtx(render, body) {
	const ctx = { sort: null, refresh: () => { render(body, ctx); } };
	return ctx;
}

// The click handlers under test chain several sequential `await`s (runSearchAudit's own
// listPaths/ensureLoaded/auditPrepareFile-per-candidate hops, enqueueSearchRepairs' per-path
// enqueue calls). A fixed count of `await Promise.resolve()` under-drains a chain that deep;
// a macrotask boundary (setTimeout) is guaranteed to run only after every already-queued
// microtask (however many links long) has settled.
function flush() {
	return new Promise(resolve => setTimeout(resolve, 0));
}

async function runSuccessfulAudit(section) {
	const heading = new FakeEl();
	section.renderRunAuditButton(heading);
	const btn = buttons(heading)[0];
	btn.click();
	await flush();
	return btn;
}

function renderBody(section) {
	const body = new FakeEl();
	const ctx = makeCtx(section.render, body);
	section.render(body, ctx);
	return { body, ctx };
}

function summaryTable(body) { return body.children[0].children[0]; }
function summaryRows(body) { return summaryTable(body).children[1].children; }
function pathsTableContainer(body) { return body.children[1]; }

// Both confirm-shaped stubs are process-global — reset their call log and programmable result
// before EVERY test (individual tests also set __confirmModalResult/__retryModalResult
// explicitly before triggering the action under test, but without a per-test reset, a call-log
// assertion in a later test would see calls accumulated from earlier tests in the same file).
beforeEach(() => {
	globalThis.__confirmModalCalls = [];
	globalThis.__confirmModalResult = true;
	globalThis.__retryModalCalls = [];
	globalThis.__retryModalResult = null;
});

/* ------------------------------------------------------------------------- tests */

test('renderRunAuditButton: searchEnabled false — error empty-state, searchManager never touched', async () => {
	const { plugin } = makeFixturePlugin();
	plugin.settings.searchEnabled = false;
	let touched = false;
	plugin.searchManager.listIndexableFiles = () => { touched = true; return []; };
	const { host, state } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	assert.equal(touched, false, 'the searchManager must never be touched when searchEnabled is off');
	const { body } = renderBody(section);
	assert.equal(body.children.length, 1);
	assert.match(body.children[0].textContent, /Search audit unavailable: search indexing is disabled/);
	assert.equal(state.count, 0);
});

test('render: not run yet — empty state, no header count/meta', () => {
	const { plugin } = makeFixturePlugin();
	const { host, state } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	const { body } = renderBody(section);
	assert.equal(body.children[0].textContent, 'Not run yet — click Run audit.');
	assert.equal(state.count, 0);
});

test('renderRunAuditButton: icon-label chrome — play icon + "Run audit"/"Running…" text', async () => {
	const { plugin } = makeFixturePlugin();
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	const heading = new FakeEl();
	section.renderRunAuditButton(heading);
	const btn = buttons(heading)[0];
	assert.ok(btn.className.includes('crucible-icon-label-btn'), 'must carry the same chrome as the header Refresh button');
	assert.equal(btn.iconName, 'play');
	assert.equal(btn.children.find(c => c.tagName === 'SPAN')?.textContent, 'Run audit');

	btn.click();
	// Immediately after the synchronous click dispatch (before the awaited runSearchAudit chain
	// settles), the button must be disabled and reading "Running…".
	assert.equal(btn.disabled, true);
	assert.equal(btn.children.find(c => c.tagName === 'SPAN')?.textContent, 'Running…');
	await flush();
	assert.equal(btn.disabled, false);
	assert.equal(btn.children.find(c => c.tagName === 'SPAN')?.textContent, 'Run audit');
});

test('render: summary table — all 9 rows in fixed order with honest counts', async () => {
	const { plugin } = makeFixturePlugin({ withImages: true });
	const { host, state } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const { body } = renderBody(section);
	const rows = summaryRows(body);
	assert.equal(rows.length, 9, 'one row per SUMMARY_ORDER entry');

	const expected = [
		['Missing (in vault, not indexed)', '1'],
		['Orphans (indexed, not in vault)', '1'],
		['Stale (vault newer, content changed)', '1'],
		['Mtime-only (unchanged content — index is current)', '1'],
		['Unindexable (no indexable content)', '1'],
		['Embedding gaps (embedded < chunks)', '1'],
		['Images pending', '1'],
		['Images failed', '1'],
		['Images described (informational)', '1 / 3'],
	];
	for (const [i, [label, count]] of expected.entries()) {
		assert.equal(rowLabelText(rows[i]), label, `row ${i} label`);
		assert.equal(rows[i].children[1].textContent, count, `row ${i} count`);
	}

	assert.equal(state.count, 3, 'the header count is the stable missing+orphans+stale total');
	assert.match(state.meta, /^as of /);
});

test('render: hidden-at-zero — a zero-count class renders its row with NO wrench button; non-zero rows carry exactly one wrench with a documented aria-label/title', async () => {
	const { plugin } = makeFixturePlugin({ withImages: true });
	// Empty out `missing` by making the vault have no un-indexed indexable file.
	plugin.searchManager.listIndexableFiles = () => [
		{ path: 'unindexable.md', stat: { mtime: 100 } },
		{ path: 'stale.md', stat: { mtime: 500 } },
		{ path: 'mtimeonly.md', stat: { mtime: 500 } },
		{ path: 'clean.md', stat: { mtime: 100 } },
		{ path: 'embedgap.md', stat: { mtime: 100 } },
	];
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const { body } = renderBody(section);
	const rows = summaryRows(body);
	const missingRow = rows[0];
	assert.equal(missingRow.children[1].textContent, '0');
	assert.equal(buttons(missingRow.children[2]).length, 0, 'zero-count row: the action cell renders NO button at all');
	assert.equal(missingRow.className.includes('crucible-audit-row-clickable'), false, 'a zero-count row is not clickable');

	const orphansRow = rows[1];
	const wrench = buttons(orphansRow.children[2])[0];
	assert.ok(wrench, 'a non-zero row keeps its wrench');
	assert.equal(wrench.attrs['aria-label'], 'Repair');
	assert.match(wrench.attrs.title, /Delete 1 orphaned path/);
});

test('render: "no action needed" cells for mtime-only/unindexable regardless of count; images-described reads "—"', async () => {
	const { plugin } = makeFixturePlugin({ withImages: true });
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const { body } = renderBody(section);
	const rows = summaryRows(body);
	assert.equal(rows[3].children[2].textContent, 'No action needed', 'mtime-only');
	assert.equal(rows[4].children[2].textContent, 'No action needed', 'unindexable');
	assert.equal(buttons(rows[3].children[2]).length, 0);
	assert.equal(buttons(rows[4].children[2]).length, 0);
	assert.equal(rows[8].children[2].textContent, '—', 'images described is informational, never a repair action');
});

test('render: row-click filtering — a note-class row filters the paths table, click again restores the default view; action-button click does NOT change the filter', async () => {
	const { plugin } = makeFixturePlugin({ withImages: true });
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const { body } = renderBody(section);
	// Default view: missing + orphans + stale.
	assert.deepEqual(trs(pathsTableContainer(body)).map(tr => tr.children[0].textContent).sort(), ['missing.md', 'orphan.md', 'stale.md']);

	buttons(summaryRows(body)[3].children[0])[0].click(); // bubbles to the row's own click listener
	// render() rebuilds the whole subtree on every refresh (root AGENTS.md's compute-then-repaint
	// law) — every element captured before a click is now detached, so post-click assertions must
	// re-query `body` for the live nodes rather than reuse pre-click references.

	const filtered = trs(pathsTableContainer(body));
	assert.equal(filtered.length, 1);
	assert.equal(filtered[0].children[0].textContent, 'mtimeonly.md');
	const activeMtimeBtn = buttons(summaryRows(body)[3].children[0])[0];
	assert.equal(activeMtimeBtn.attrs['aria-pressed'], 'true');
	assert.ok(summaryRows(body)[3].className.includes('crucible-audit-row-active'));

	// Clicking a DIFFERENT row's own wrench must not change the active filter — proves the click
	// landed on the action cell rather than toggling that row's (or any row's) selection.
	const missingWrench = buttons(summaryRows(body)[0].children[2])[0];
	missingWrench.click();
	await flush();
	// Selection is still mtimeOnly (unaffected by the wrench click on a different row).
	assert.equal(trs(pathsTableContainer(body)).length, 1);
	assert.equal(trs(pathsTableContainer(body))[0].children[0].textContent, 'mtimeonly.md');

	// Click the active row's own label again — restores the default view.
	buttons(summaryRows(body)[3].children[0])[0].click();
	assert.deepEqual(trs(pathsTableContainer(body)).map(tr => tr.children[0].textContent).sort(), ['missing.md', 'orphan.md', 'stale.md']);
});

test('render: row-click filtering — an image-class row filters the paths table to imageCoverage paths, with "images pending"/"images failed" Class text', async () => {
	const { plugin } = makeFixturePlugin({ withImages: true });
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const { body } = renderBody(section);
	const pendingLabelBtn = buttons(summaryRows(body)[6].children[0])[0];
	pendingLabelBtn.click();

	const rows = trs(pathsTableContainer(body));
	assert.equal(rows.length, 1);
	assert.equal(rows[0].children[0].textContent, PENDING_PATH);
	assert.equal(rows[0].children[1].textContent, 'images pending');

	// Click again restores the default (missing/orphans/stale) view.
	pendingLabelBtn.click();
	assert.deepEqual(trs(pathsTableContainer(body)).map(tr => tr.children[0].textContent).sort(), ['missing.md', 'orphan.md', 'stale.md']);

	// Now the failed-images row.
	const failedLabelBtn = buttons(summaryRows(body)[7].children[0])[0];
	failedLabelBtn.click();
	const failedRows = trs(pathsTableContainer(body));
	assert.equal(failedRows.length, 1);
	assert.equal(failedRows[0].children[0].textContent, FAILED_PATH);
	assert.equal(failedRows[0].children[1].textContent, 'images failed');
});

test('render: paths table — image rows get a muted wrench pointing at the summary row action, and an arrow-right open button', async () => {
	const { plugin } = makeFixturePlugin({ withImages: true, resolvablePaths: new Set([PENDING_PATH]) });
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const { body } = renderBody(section);
	buttons(summaryRows(body)[6].children[0])[0].click(); // filter to images pending
	const row = trs(pathsTableContainer(body))[0];
	const [openBtn, wrenchBtn] = buttons(row.children[2]);

	assert.equal(openBtn.disabled, false, 'the image path resolves via getAbstractFileByPath, same as a note path');
	openBtn._listeners.click[0]();
	assert.deepEqual(plugin.__openCalls, [[PENDING_PATH, '', false]]);

	assert.equal(wrenchBtn.disabled, true);
	assert.match(wrenchBtn.attrs.title, /Images pending row's repair action/);
});

test('action wiring: missing wrench reads the CACHED FULL result — filtering the table first does not shrink the target list', async () => {
	const { plugin, enqueueCalls } = makeFixturePlugin({ withImages: true });
	const { host, state } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const { body } = renderBody(section);
	// Filter down to a single-row view (mtime-only) before firing the missing wrench — the action
	// must still read `result.missing` from the closure, not whatever DEFAULT_TABLE_ROW_LIMIT rows
	// happen to be on screen.
	buttons(summaryRows(body)[3].children[0])[0].click();
	assert.equal(trs(pathsTableContainer(body)).length, 1);

	const missingWrench = buttons(summaryRows(body)[0].children[2])[0];
	missingWrench.click();
	await flush();

	assert.equal(enqueueCalls.length, 1);
	assert.equal(enqueueCalls[0].type, 'search_upsert_file');
	assert.deepEqual(enqueueCalls[0].params, { path: 'missing.md' });

	section.render(body, makeCtx(section.render, body));
	assert.match(state.meta, /stale — re-run audit to refresh/);
});

test('action wiring: orphans wrench enqueues search_delete_path for the orphan half via enqueueSearchRepairs (confirm gate inside)', async () => {
	const { plugin, enqueueCalls } = makeFixturePlugin();
	globalThis.__confirmModalResult = true;
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const { body } = renderBody(section);
	buttons(summaryRows(body)[1].children[2])[0].click(); // orphans row's wrench
	await flush();

	assert.equal(enqueueCalls.length, 1);
	assert.equal(enqueueCalls[0].type, 'search_delete_path');
	assert.deepEqual(enqueueCalls[0].params, { path: 'orphan.md' });
});

test('action wiring: embedding-gaps wrench enqueues a plain search_embed_missing job and marks the result stale', async () => {
	const { plugin, enqueueCalls } = makeFixturePlugin();
	const { host, state } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const { body } = renderBody(section);
	buttons(summaryRows(body)[5].children[2])[0].click(); // embeddingGaps row's wrench
	await flush();

	assert.equal(enqueueCalls.length, 1);
	assert.equal(enqueueCalls[0].type, 'search_embed_missing');
	assert.deepEqual(enqueueCalls[0].params, {});

	section.render(body, makeCtx(section.render, body));
	assert.match(state.meta, /stale — re-run audit to refresh/);
});

test('action wiring: images-pending wrench consults the confirm-backfill stub — DECLINED enqueues nothing and does NOT mark the result stale', async () => {
	const { plugin, enqueueCalls } = makeFixturePlugin({ withImages: true });
	globalThis.__confirmModalResult = false;
	const { host, state } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const { body } = renderBody(section);
	buttons(summaryRows(body)[6].children[2])[0].click(); // imagePending row's wrench
	await flush();

	assert.equal(globalThis.__confirmModalCalls.length, 1, 'the scale-warning confirm modal was consulted');
	assert.equal(enqueueCalls.filter(c => c.type === 'image_describe_backfill').length, 0, 'declined — nothing enqueued');

	section.render(body, makeCtx(section.render, body));
	assert.doesNotMatch(state.meta ?? '', /stale/, 'a decline must not mark the cached result stale');
});

test('action wiring: images-pending wrench CONFIRMED enqueues image_describe_backfill and marks the result stale', async () => {
	const { plugin, enqueueCalls } = makeFixturePlugin({ withImages: true });
	globalThis.__confirmModalResult = true;
	const { host, state } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const { body } = renderBody(section);
	buttons(summaryRows(body)[6].children[2])[0].click();
	await flush();

	assert.equal(enqueueCalls.filter(c => c.type === 'image_describe_backfill').length, 1);
	section.render(body, makeCtx(section.render, body));
	assert.match(state.meta, /stale — re-run audit to refresh/);
});

test('action wiring: images-failed wrench consults the retry-choice stub, prunes and enqueues the backfill, and marks the result stale', async () => {
	const { plugin, enqueueCalls } = makeFixturePlugin({ withImages: true });
	globalThis.__retryModalResult = 'transient';
	const { host, state } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const { body } = renderBody(section);
	buttons(summaryRows(body)[7].children[2])[0].click(); // imageFailed row's wrench
	await flush();

	assert.equal(globalThis.__retryModalCalls.length, 1, 'the retry-choice modal was consulted');
	assert.deepEqual(plugin.imageDescriptionsPruneCalls, ['transient']);
	assert.equal(enqueueCalls.filter(c => c.type === 'image_describe_backfill').length, 1);

	section.render(body, makeCtx(section.render, body));
	assert.match(state.meta, /stale — re-run audit to refresh/);
});

test('action wiring: images-failed wrench CANCELLED (modal closed without a choice) enqueues nothing and does not mark stale', async () => {
	const { plugin, enqueueCalls } = makeFixturePlugin({ withImages: true });
	globalThis.__retryModalResult = null;
	const { host, state } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const { body } = renderBody(section);
	buttons(summaryRows(body)[7].children[2])[0].click();
	await flush();

	assert.equal(enqueueCalls.filter(c => c.type === 'image_describe_backfill').length, 0);
	assert.deepEqual(plugin.imageDescriptionsPruneCalls, []);
	section.render(body, makeCtx(section.render, body));
	assert.doesNotMatch(state.meta ?? '', /stale/);
});

test('render: open-note button — orphan rows are always muted, a resolvable path opens the note, an unresolvable one is muted', async () => {
	const { plugin } = makeFixturePlugin({ resolvablePaths: new Set(['missing.md']) });
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const { body } = renderBody(section);
	const rows = trs(pathsTableContainer(body));
	const byPath = new Map(rows.map(tr => [tr.children[0].textContent, tr]));

	const orphanOpen = buttons(byPath.get('orphan.md').children[2])[0];
	assert.equal(orphanOpen.disabled, true);
	assert.match(orphanOpen.attrs.title, /no longer exists in the vault/);

	const missingOpen = buttons(byPath.get('missing.md').children[2])[0];
	assert.equal(missingOpen.disabled, false);
	missingOpen._listeners.click[0]();
	assert.deepEqual(plugin.__openCalls, [['missing.md', '', false]]);

	const staleOpen = buttons(byPath.get('stale.md').children[2])[0];
	assert.equal(staleOpen.disabled, true, 'stale.md was not in resolvablePaths, so getAbstractFileByPath returns null');
});

test('render: muted-wrench law in the paths table — mtimeOnly/unindexable/embeddingGaps repair buttons stay disabled with documented titles', async () => {
	const { plugin } = makeFixturePlugin();
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	function rowFor(rowIndex) {
		const { body } = renderBody(section);
		buttons(summaryRows(body)[rowIndex].children[0])[0].click();
		return trs(pathsTableContainer(body))[0];
	}

	const mtimeWrench = buttons(rowFor(3).children[2])[1];
	assert.equal(mtimeWrench.disabled, true);
	assert.match(mtimeWrench.attrs.title, /Nothing to repair — index is current/);

	const unindexableWrench = buttons(rowFor(4).children[2])[1];
	assert.equal(unindexableWrench.disabled, true);
	assert.match(unindexableWrench.attrs.title, /No indexable content/);

	const gapWrench = buttons(rowFor(5).children[2])[1];
	assert.equal(gapWrench.disabled, true);
	assert.match(gapWrench.attrs.title, /Embedding gaps row's repair action/);
});

test('error branch: a failed re-run keeps the last-known result (ranAt survives), never a blank "not run yet" state', async () => {
	const { plugin } = makeFixturePlugin();
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	// Break the companion for the next run.
	plugin.searchManager.listIndexableFiles = () => { throw new Error('companion not reachable'); };
	await runSuccessfulAudit(section);

	const { body } = renderBody(section);
	assert.equal(body.children.length, 1, 'the error branch fully replaces the body, same shape as queueMonitor.ts:565-570');
	assert.match(body.children[0].textContent, /Search audit unavailable: companion not reachable/);
	assert.match(body.children[0].textContent, /last successful run:/, 'the prior successful ranAt\\/result were not cleared by the failed run');
});

/* ---------------------------------------------------- STRUCTURAL: registration + forced-only */

const dashboardSrc = readFileSync('src/ingestionDashboard.ts', 'utf8');
const typesSrc = readFileSync('src/ingestion/render/types.ts', 'utf8');

test('STRUCTURAL: SectionId union includes searchAudit', () => {
	assert.match(typesSrc, /export type SectionId =[\s\S]*?\|\s*'searchAudit'/, "SectionId must union in 'searchAudit'");
});

test('STRUCTURAL: renderSection has a searchAudit case, and refreshAll includes it', () => {
	assert.match(dashboardSrc, /case 'searchAudit': return this\.searchAudit\.render\(body, ctx\);/);
	const refreshAllMatch = dashboardSrc.match(/private async refreshAll\(\): Promise<void> \{([\s\S]*?)\n\t\}/);
	assert.ok(refreshAllMatch, 'refreshAll not found');
	assert.match(refreshAllMatch[1], /'searchAudit'/);
});

test('STRUCTURAL: searchAudit is forced-trigger only — absent from both FAST_SECTIONS and SCAN_SECTIONS', () => {
	const fastMatch = dashboardSrc.match(/FAST_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>\(\[([\s\S]*?)\]\);/);
	const scanMatch = dashboardSrc.match(/SCAN_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>\(\[([\s\S]*?)\]\);/);
	assert.ok(fastMatch && scanMatch);
	assert.ok(!fastMatch[1].includes("'searchAudit'"), 'the scan is expensive/unbounded on a cold index — it must never fire from an auto-refresh pass');
	assert.ok(!scanMatch[1].includes("'searchAudit'"));
});

test('STRUCTURAL: root AGENTS.md documents the wrench icon row', () => {
	const agentsSrc = readFileSync('AGENTS.md', 'utf8');
	assert.match(agentsSrc, /\| `wrench` \| Repair/);
});
