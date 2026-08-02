// WP-H4: the Search-audit Ingestion-dashboard section (src/ingestion/sections/searchAudit.ts) —
// the WP-H3 audit/reconcile seam's dashboard face. `obsidian` is external and backed by a real
// node_modules/obsidian package written into the build's tmp dir (same pattern
// tests/missingAttachments.test.mjs uses) so `TFile` instances the test constructs are the SAME
// class the compiled module's `instanceof TFile` check runs against — an inlined esbuild-plugin
// stub (the cells.ts/queueMonitor.ts convention elsewhere) can't give that identity guarantee.
// `../../search/destructiveActions`'s relative `confirmModal` import stays an inlined stub (the
// tests/searchAuditRunEnqueueRepairs.test.mjs pattern), since it isn't a bare package specifier.
// `plugin.settings.destructiveConfirmGlobal = false` keeps the orphan-repair confirm GATE itself
// out of scope here — WP-H3's own test file already covers that mechanism; this file is about the
// section's wiring on top of it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
	click() { for (const fn of this._listeners.click ?? []) fn({ target: this }); }
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

/* ------------------------------------------------------------------------- fixture plugin */

// Six paths, one per SearchAuditResult class, computed by the REAL computeSearchAudit/
// identifyAuditCandidates (src/search/audit.ts) from this input — not hand-assembled, so the
// fixture stays honest to what runSearchAudit would actually produce:
//   missing.md      -> in vault, not indexed, chunkCount 3 > 0                => missing
//   unindexable.md  -> in vault, not indexed, chunkCount 0                    => unindexable
//   stale.md        -> indexed mtime older, fresh hash differs from indexed   => stale
//   mtimeonly.md    -> indexed mtime older, fresh hash MATCHES indexed        => mtimeOnly
//   clean.md        -> indexed mtime matches exactly, not a candidate at all  => (nothing)
//   embedgap.md     -> indexed, chunkCount 4 > embeddedCount 2, semantic on   => embeddingGaps
//   orphan.md       -> indexed, absent from vaultFiles                       => orphans
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

	const enqueueCalls = [];
	const resolvable = overrides.resolvablePaths ?? new Set();
	const plugin = {
		app: {
			vault: {
				getFiles: () => [],
				getAbstractFileByPath: (p) => (resolvable.has(p) ? new TFile(p) : null),
			},
			metadataCache: { resolvedLinks: {} },
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
			has: () => false,
			get: async () => null,
		},
		orchestrator: {
			enqueue: async (type, params, opts) => {
				enqueueCalls.push({ type, params, opts });
				return { created: new Date(Date.now() + 60_000).toISOString() };
			},
		},
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
	const body = new FakeEl();
	const ctx = makeCtx(section.render, body);
	section.render(body, ctx);
	assert.equal(body.children.length, 1);
	assert.match(body.children[0].textContent, /Search audit unavailable: search indexing is disabled/);
	assert.equal(state.count, 0);
});

test('render: not run yet — empty state, no header count/meta', () => {
	const { plugin } = makeFixturePlugin();
	const { host, state } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	const body = new FakeEl();
	const ctx = makeCtx(section.render, body);
	section.render(body, ctx);
	assert.equal(body.children[0].textContent, 'Not run yet — click Run audit.');
	assert.equal(state.count, 0);
});

test('render: fixture result — six pills with honest counts and hues, default table shows only the three defect classes, honest total count', async () => {
	const { plugin } = makeFixturePlugin();
	const { host, state } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const body = new FakeEl();
	const ctx = makeCtx(section.render, body);
	section.render(body, ctx);

	const pillRow = body.children[0];
	const pills = buttons(pillRow);
	assert.equal(pills.length, 6, 'one pill per SearchAuditResult class');
	const byLabel = new Map(pills.map(p => [p.textContent, p]));
	assert.ok(byLabel.has('missing 1'));
	assert.ok(byLabel.has('orphans 1'));
	assert.ok(byLabel.has('stale 1'));
	assert.ok(byLabel.has('mtime-only 1'));
	assert.ok(byLabel.has('unindexable 1'));
	assert.ok(byLabel.has('embedding gaps 1'));

	// Defect classes (missing/orphans/stale) get a status hue when non-zero; the other three
	// stay neutral even though every count here is 1 — root AGENTS.md's pill-taxonomy law.
	assert.ok(byLabel.get('missing 1').className.includes('is-error'));
	assert.ok(byLabel.get('orphans 1').className.includes('is-error'));
	assert.ok(byLabel.get('stale 1').className.includes('is-warn'));
	assert.ok(byLabel.get('mtime-only 1').className.includes('is-muted'));
	assert.ok(byLabel.get('unindexable 1').className.includes('is-muted'));
	assert.ok(byLabel.get('embedding gaps 1').className.includes('is-muted'), 'embeddingGaps is not reconcile-actionable from here — neutral even when non-zero');

	// Default (no filter) view: the table shows missing+orphans+stale only.
	const tableContainer = body.children[3];
	const rows = tableContainer.querySelectorAll('tr').filter(tr => tr.parentElement.tagName === 'TBODY');
	assert.equal(rows.length, 3);
	const paths = rows.map(tr => tr.children[0].textContent).sort();
	assert.deepEqual(paths, ['missing.md', 'orphan.md', 'stale.md']);

	assert.equal(state.count, 3, 'the header count is the stable defect total, not the filtered row count');
	assert.match(state.meta, /^as of /);
});

test('render: image-coverage row — read-only neutral span pills with honest counts from the scan', async () => {
	// Three localized images, all referenced via resolvedLinks: one described, one with a durable
	// failed record, one pending (no record). Flows through the REAL gatherSearchAuditImages →
	// computeSearchAudit path, not a hand-assembled imageCoverage.
	const describedMd5 = 'a'.repeat(32);
	const failedMd5 = 'b'.repeat(32);
	const pendingMd5 = 'c'.repeat(32);
	const { plugin } = makeFixturePlugin();
	plugin.app.vault.getFiles = () => [
		{ path: `img/${describedMd5}_MD5.png` },
		{ path: `img/${failedMd5}_MD5.png` },
		{ path: `img/${pendingMd5}_MD5.png` },
	];
	plugin.app.metadataCache.resolvedLinks = {
		'note.md': {
			[`img/${describedMd5}_MD5.png`]: 1,
			[`img/${failedMd5}_MD5.png`]: 1,
			[`img/${pendingMd5}_MD5.png`]: 1,
		},
	};
	plugin.imageDescriptions = {
		ensureLoaded: async () => {},
		has: (md5) => md5 !== pendingMd5,
		get: async (md5) => (md5 === failedMd5 ? { kind: 'failed' } : { kind: 'described' }),
	};
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const body = new FakeEl();
	section.render(body, makeCtx(section.render, body));

	const coverageRow = body.children[1];
	assert.equal(buttons(coverageRow).length, 0, 'coverage pills are read-only spans, never buttons — nothing here is actionable');
	const spans = coverageRow.querySelectorAll('span');
	assert.deepEqual(
		spans.map(s => s.textContent),
		['images referenced 3', 'described 1', 'failed 1', 'pending 1'],
	);
	for (const span of spans) {
		assert.ok(span.className.includes('is-muted'), 'image coverage never spends a status hue — neutral per the pill-taxonomy law');
		assert.ok(span.title.length > 0, 'every pill carries an explanatory title');
	}
});

test('render: clicking a pill filters the table to that class alone, click again returns to the combined view', async () => {
	const { plugin } = makeFixturePlugin();
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const body = new FakeEl();
	const ctx = makeCtx(section.render, body);
	section.render(body, ctx);

	const mtimePill = buttons(body.children[0]).find(b => b.textContent === 'mtime-only 1');
	mtimePill.click();

	const filteredRows = body.children[3].querySelectorAll('tr').filter(tr => tr.parentElement.tagName === 'TBODY');
	assert.equal(filteredRows.length, 1);
	assert.equal(filteredRows[0].children[0].textContent, 'mtimeonly.md');
	const activePill = buttons(body.children[0]).find(b => b.textContent === 'mtime-only 1');
	assert.equal(activePill.attrs['aria-pressed'], 'true');
	assert.ok(activePill.className.includes('is-contrast'));

	activePill.click(); // click again — back to the default combined view
	const restoredRows = body.children[3].querySelectorAll('tr').filter(tr => tr.parentElement.tagName === 'TBODY');
	assert.equal(restoredRows.length, 3);
});

test('render: muted-wrench law — mtimeOnly/unindexable/embeddingGaps repair buttons are disabled with the documented titles; missing is active', async () => {
	const { plugin } = makeFixturePlugin();
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	function rowsForClass(label) {
		const body = new FakeEl();
		const ctx = makeCtx(section.render, body);
		section.render(body, ctx);
		const pill = buttons(body.children[0]).find(b => b.textContent === label);
		pill.click();
		return body.children[3].querySelectorAll('tr').filter(tr => tr.parentElement.tagName === 'TBODY');
	}

	const mtimeRow = rowsForClass('mtime-only 1')[0];
	const mtimeWrench = mtimeRow.children[2].querySelectorAll('button')[1];
	assert.equal(mtimeWrench.disabled, true);
	assert.match(mtimeWrench.attrs.title, /Nothing to repair — index is current/);

	const unindexableRow = rowsForClass('unindexable 1')[0];
	const unindexableWrench = unindexableRow.children[2].querySelectorAll('button')[1];
	assert.equal(unindexableWrench.disabled, true);
	assert.match(unindexableWrench.attrs.title, /No indexable content/);

	const gapRow = rowsForClass('embedding gaps 1')[0];
	const gapWrench = gapRow.children[2].querySelectorAll('button')[1];
	assert.equal(gapWrench.disabled, true);
	assert.match(gapWrench.attrs.title, /embed missing vectors/);

	const missingRow = rowsForClass('missing 1')[0];
	const missingWrench = missingRow.children[2].querySelectorAll('button')[1];
	assert.equal(missingWrench.disabled, false);
});

test('render: open-note button — orphan rows are always muted, a resolvable path opens the note, an unresolvable one is muted', async () => {
	const { plugin } = makeFixturePlugin({ resolvablePaths: new Set(['missing.md']) });
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const body = new FakeEl();
	const ctx = makeCtx(section.render, body);
	section.render(body, ctx);
	const rows = body.children[3].querySelectorAll('tr').filter(tr => tr.parentElement.tagName === 'TBODY');
	const byPath = new Map(rows.map(tr => [tr.children[0].textContent, tr]));

	const orphanOpen = byPath.get('orphan.md').children[2].querySelectorAll('button')[0];
	assert.equal(orphanOpen.disabled, true);
	assert.match(orphanOpen.attrs.title, /no longer exists in the vault/);

	const missingOpen = byPath.get('missing.md').children[2].querySelectorAll('button')[0];
	assert.equal(missingOpen.disabled, false);
	missingOpen._listeners.click[0]();
	assert.deepEqual(plugin.__openCalls, [['missing.md', '', false]]);

	const staleOpen = byPath.get('stale.md').children[2].querySelectorAll('button')[0];
	assert.equal(staleOpen.disabled, true, 'stale.md was not in resolvablePaths, so getAbstractFileByPath returns null');
});

test('render: single-row repair enqueues the documented job for that path alone and marks the result stale', async () => {
	const { plugin, enqueueCalls } = makeFixturePlugin();
	const { host, state } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const body = new FakeEl();
	const ctx = makeCtx(section.render, body);
	section.render(body, ctx);
	const rows = body.children[3].querySelectorAll('tr').filter(tr => tr.parentElement.tagName === 'TBODY');
	const missingRow = rows.find(tr => tr.children[0].textContent === 'missing.md');
	const wrench = missingRow.children[2].querySelectorAll('button')[1];
	wrench._listeners.click[0]();
	await flush();

	assert.equal(enqueueCalls.length, 1);
	assert.equal(enqueueCalls[0].type, 'search_upsert_file');
	assert.deepEqual(enqueueCalls[0].params, { path: 'missing.md' });

	section.render(body, ctx);
	assert.match(state.meta, /stale — re-run audit to refresh/);
});

test('render: bulk "Repair all" reads the cached FULL result, not the currently-filtered/rendered table', async () => {
	const { plugin, enqueueCalls } = makeFixturePlugin();
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	const body = new FakeEl();
	const ctx = makeCtx(section.render, body);
	section.render(body, ctx);

	// Filter down to just one class (1 visible row) before clicking bulk repair.
	const stalePill = buttons(body.children[0]).find(b => b.textContent === 'stale 1');
	stalePill.click();
	const visibleRows = body.children[3].querySelectorAll('tr').filter(tr => tr.parentElement.tagName === 'TBODY');
	assert.equal(visibleRows.length, 1, 'the table is now filtered down to one row');

	const bulkBtn = buttons(body.children[2])[0];
	bulkBtn.click();
	await flush();

	const upsertPaths = enqueueCalls.filter(c => c.type === 'search_upsert_file').map(c => c.params.path).sort();
	const deletePaths = enqueueCalls.filter(c => c.type === 'search_delete_path').map(c => c.params.path).sort();
	assert.deepEqual(upsertPaths, ['missing.md', 'stale.md'], 'both missing AND stale are enqueued — not just the one visible/filtered row');
	assert.deepEqual(deletePaths, ['orphan.md']);
});

test('error branch: a failed re-run keeps the last-known result (ranAt survives), never a blank "not run yet" state', async () => {
	const { plugin } = makeFixturePlugin();
	const { host } = makeHost(plugin);
	const section = createSearchAuditSection(host);
	await runSuccessfulAudit(section);

	// Break the companion for the next run.
	plugin.searchManager.listIndexableFiles = () => { throw new Error('companion not reachable'); };
	await runSuccessfulAudit(section);

	const body = new FakeEl();
	const ctx = makeCtx(section.render, body);
	section.render(body, ctx);
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
