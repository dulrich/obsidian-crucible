// WP-R3: parity coverage proving `formatAuditReport` (src/search/audit.ts) and the Ingestion
// dashboard's Search-audit section (src/ingestion/sections/searchAudit.ts) both derive their
// condition order/labels/count projections from the ONE shared descriptor set
// (src/search/auditConditions.ts) rather than two hand-maintained copies. The test never
// hardcodes a label/order twice: every expectation is read off the auditConditions bundle itself
// and cross-checked against what the report/dashboard bundles actually render, so a future edit
// that changes only one side (without updating auditConditions.ts) fails here, not just in
// eyeballing a diff.
//
// Also proves the one deliberate, documented divergence survives: the report reports image
// coverage as ONE combined bullet (described/referenced/failed/pending, no per-path listing)
// while the dashboard expands it into THREE rows (imagePending/imageFailed/imagesDescribed) —
// both projections must report the SAME underlying numbers from the SAME computeSearchAudit
// result.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-audit-conditions-parity-tests');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

/* ---------------------------------------------------- bundle 1: auditConditions.ts (ground truth) */

const conditionsOutfile = path.join(outdir, 'auditConditions.mjs');
await esbuild.build({
	entryPoints: ['src/search/auditConditions.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile: conditionsOutfile,
	logLevel: 'silent',
});
const { AUDIT_CONDITIONS, DEFAULT_VIEW_CONDITIONS, NOTE_CONDITIONS, conditionFor } =
	await import(pathToFileURL(conditionsOutfile).href);

/* ---------------------------------------------------- bundle 2: audit.ts (the report) */

const auditOutfile = path.join(outdir, 'audit.mjs');
await esbuild.build({
	entryPoints: ['src/search/audit.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile: auditOutfile,
	logLevel: 'silent',
});
const { computeSearchAudit, formatAuditReport } = await import(pathToFileURL(auditOutfile).href);

/* ---------------------------------------------------- bundle 3: searchAudit.ts (the dashboard) */

const sectionOutdir = path.join(outdir, 'section');
const sectionOutfile = path.join(sectionOutdir, 'searchAudit.mjs');
const obsidianDir = path.join(sectionOutdir, 'node_modules', 'obsidian');
const obsidianEntry = path.join(obsidianDir, 'index.mjs');
await mkdir(obsidianDir, { recursive: true });
await writeFile(path.join(obsidianDir, 'package.json'), JSON.stringify({ name: 'obsidian', type: 'module', main: 'index.mjs' }));
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
					contents: 'export class ConfirmModal { constructor() {} openAndAwait() { return Promise.resolve(true); } }',
					loader: 'js',
				}));
			},
		},
		{
			name: 'retry-modal-stub',
			setup(build) {
				build.onResolve({ filter: /retryImageDescriptionsModal$/ }, () => ({ path: 'retry-modal-stub', namespace: 'retry-stub' }));
				build.onLoad({ filter: /.*/, namespace: 'retry-stub' }, () => ({
					contents: 'export class RetryFailedImageDescriptionsModal { constructor() {} openAndAwait() { return Promise.resolve(null); } }',
					loader: 'js',
				}));
			},
		},
	],
	outfile: sectionOutfile,
	logLevel: 'silent',
});
const { createSearchAuditSection } = await import(pathToFileURL(sectionOutfile).href);

/* ---------------------------------------------------- fake DOM (searchAuditSection.test.mjs's shape) */

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
	empty() { this.children = []; this.textContent = ''; }
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
		const walk = node => { for (const c of node.children) { if (c.tagName === wanted) out.push(c); walk(c); } };
		walk(this);
		return out;
	}
}

function buttons(el) { return el.querySelectorAll('button'); }
function trs(el) { return el.querySelectorAll('tr').filter(tr => tr.parentElement.tagName === 'TBODY'); }
function rowLabelText(tr) {
	const td = tr.children[0];
	if (td.textContent) return td.textContent;
	const btn = buttons(td)[0];
	return btn ? btn.textContent : '';
}
function summaryTable(body) { return body.children[0].children[0]; }
function summaryRows(body) { return summaryTable(body).children[1].children; }
function pathsTableContainer(body) { return body.children[1]; }

function makeCtx(render, body) {
	const ctx = { sort: null, refresh: () => { render(body, ctx); } };
	return ctx;
}

function flush() { return new Promise(resolve => setTimeout(resolve, 0)); }

/* ---------------------------------------------------- fixture: one path per condition */

// Six paths, one per note class, plus a described/failed/pending image each — same shape as
// searchAuditSection.test.mjs's fixture, computed by the REAL computeSearchAudit so the fixture
// stays honest to what runSearchAudit would actually produce.
const DESCRIBED_MD5 = 'a'.repeat(32);
const FAILED_MD5 = 'b'.repeat(32);
const PENDING_MD5 = 'c'.repeat(32);
const DESCRIBED_PATH = `img/${DESCRIBED_MD5}_MD5.png`;
const FAILED_PATH = `img/${FAILED_MD5}_MD5.png`;
const PENDING_PATH = `img/${PENDING_MD5}_MD5.png`;

function buildFixtureResult() {
	return computeSearchAudit({
		vaultFiles: [
			{ path: 'missing.md', mtime: 100 },
			{ path: 'unindexable.md', mtime: 100 },
			{ path: 'stale.md', mtime: 500 },
			{ path: 'mtimeonly.md', mtime: 500 },
			{ path: 'embedgap.md', mtime: 100 },
		],
		indexedPaths: [
			{ path: 'stale.md', mtime: 100, contentHash: 'OLD', chunkCount: 2, embeddedCount: 2 },
			{ path: 'mtimeonly.md', mtime: 100, contentHash: 'SAME', chunkCount: 2, embeddedCount: 2 },
			{ path: 'embedgap.md', mtime: 100, contentHash: 'Y', chunkCount: 4, embeddedCount: 2 },
			{ path: 'orphan.md', mtime: 100, contentHash: 'Z', chunkCount: 1, embeddedCount: 1 },
		],
		images: [
			{ md5: DESCRIBED_MD5, status: 'described', path: DESCRIBED_PATH },
			{ md5: FAILED_MD5, status: 'failed', path: FAILED_PATH },
			{ md5: PENDING_MD5, status: 'pending', path: PENDING_PATH },
		],
		semanticEnabled: true,
		staleContentHashes: new Map([['mtimeonly.md', 'SAME'], ['stale.md', 'NEW']]),
		missingChunkCounts: new Map([['unindexable.md', 0], ['missing.md', 3]]),
	});
}

function makeFixturePlugin() {
	const result = buildFixtureResult();
	const vaultFiles = [
		{ path: 'missing.md', mtime: 100 },
		{ path: 'unindexable.md', mtime: 100 },
		{ path: 'stale.md', mtime: 500 },
		{ path: 'mtimeonly.md', mtime: 500 },
		{ path: 'embedgap.md', mtime: 100 },
	];
	const indexedPaths = [
		{ path: 'stale.md', mtime: 100, contentHash: 'OLD', chunkCount: 2, embeddedCount: 2 },
		{ path: 'mtimeonly.md', mtime: 100, contentHash: 'SAME', chunkCount: 2, embeddedCount: 2 },
		{ path: 'embedgap.md', mtime: 100, contentHash: 'Y', chunkCount: 4, embeddedCount: 2 },
		{ path: 'orphan.md', mtime: 100, contentHash: 'Z', chunkCount: 1, embeddedCount: 1 },
	];
	const prepareMap = new Map([
		['missing.md', { contentHash: 'm', chunkCount: 3 }],
		['unindexable.md', { contentHash: 'u', chunkCount: 0 }],
		['stale.md', { contentHash: 'NEW', chunkCount: 5 }],
		['mtimeonly.md', { contentHash: 'SAME', chunkCount: 2 }],
	]);
	const vaultImageFiles = [{ path: DESCRIBED_PATH }, { path: FAILED_PATH }, { path: PENDING_PATH }];
	const resolvedLinks = { 'note.md': { [DESCRIBED_PATH]: 1, [FAILED_PATH]: 1, [PENDING_PATH]: 1 } };
	const plugin = {
		app: {
			vault: { getFiles: () => vaultImageFiles, getAbstractFileByPath: () => null },
			metadataCache: { resolvedLinks },
			workspace: { openLinkText: () => {} },
		},
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
			auditPrepareFile: async file => prepareMap.get(file.path) ?? null,
		},
		imageDescriptions: {
			ensureLoaded: async () => {},
			has: md5 => md5 !== PENDING_MD5,
			get: async md5 => (md5 === FAILED_MD5 ? { kind: 'failed' } : { kind: 'described' }),
		},
		orchestrator: { enqueue: async () => ({ created: new Date(Date.now() + 60_000).toISOString() }) },
	};
	return { plugin, result };
}

function makeHost(plugin) {
	return { plugin, app: plugin.app, refresh: async () => {}, setSectionCount: () => {}, setSectionMeta: () => {} };
}

async function runSuccessfulAudit(section) {
	const heading = new FakeEl();
	section.renderRunAuditButton(heading);
	const btn = buttons(heading)[0];
	btn.click();
	await flush();
}

function renderBody(section) {
	const body = new FakeEl();
	const ctx = makeCtx(section.render, body);
	section.render(body, ctx);
	return { body, ctx };
}

/* ---------------------------------------------------- tests: the descriptor set itself */

test('AUDIT_CONDITIONS declares exactly the eight real conditions, in the canonical order', () => {
	assert.deepEqual(AUDIT_CONDITIONS.map(d => d.key), [
		'missing', 'orphans', 'stale', 'mtimeOnly', 'unindexable', 'embeddingGaps', 'imagePending', 'imageFailed',
	]);
});

test('DEFAULT_VIEW_CONDITIONS is exactly missing/orphans/stale, in that order', () => {
	assert.deepEqual(DEFAULT_VIEW_CONDITIONS.map(d => d.key), ['missing', 'orphans', 'stale']);
});

test('NOTE_CONDITIONS is exactly the six path classes (both image conditions excluded)', () => {
	assert.deepEqual(NOTE_CONDITIONS.map(d => d.key), ['missing', 'orphans', 'stale', 'mtimeOnly', 'unindexable', 'embeddingGaps']);
});

test('repairPolicy is assigned per the documented family, with no key sharing a policy it should not', () => {
	const policyByKey = Object.fromEntries(AUDIT_CONDITIONS.map(d => [d.key, d.repairPolicy]));
	assert.deepEqual(policyByKey, {
		missing: 'reconcile-upsert',
		orphans: 'reconcile-orphan',
		stale: 'reconcile-upsert',
		mtimeOnly: 'informational',
		unindexable: 'informational',
		embeddingGaps: 'embed-missing',
		imagePending: 'image-backfill',
		imageFailed: 'image-retry',
	});
});

test('conditionFor throws on an unrecognized key rather than returning undefined', () => {
	assert.throws(() => conditionFor('not-a-real-key'), /Unknown audit condition key/);
});

/* ---------------------------------------------------- tests: report parity */

test('formatAuditReport\'s Summary section reads NOTE_CONDITIONS\' reportSummaryLabel/paths, in declared order', () => {
	const result = buildFixtureResult();
	const report = formatAuditReport(result, '2026-08-02T00:00:00.000Z');
	const summarySection = report.split('## Summary')[1].split('\n\n')[0];

	let cursor = -1;
	for (const d of NOTE_CONDITIONS) {
		const line = `- ${d.reportSummaryLabel}: ${d.paths(result).length}`;
		const idx = summarySection.indexOf(line);
		assert.ok(idx >= 0, `expected Summary line for "${d.key}" (derived from its own descriptor): ${JSON.stringify(line)}`);
		assert.ok(idx > cursor, `Summary line for "${d.key}" must appear after the previous condition's line — order must follow NOTE_CONDITIONS`);
		cursor = idx;
	}
});

test('formatAuditReport\'s per-class body sections read reportSectionTitle/paths, in declared order, for every NOTE_CONDITIONS entry', () => {
	const result = buildFixtureResult();
	const report = formatAuditReport(result, '2026-08-02T00:00:00.000Z');

	let cursor = -1;
	for (const d of NOTE_CONDITIONS) {
		const paths = d.paths(result);
		const body = paths.length > 0 ? paths.map(p => `- ${p}`).join('\n') : '(none)';
		const heading = `## ${d.reportSectionTitle}\n${body}`;
		const idx = report.indexOf(heading);
		assert.ok(idx >= 0, `expected body section for "${d.key}": ${JSON.stringify(heading)}`);
		assert.ok(idx > cursor, `body section for "${d.key}" must appear after the previous condition's section`);
		cursor = idx;
	}
});

test('the report never lists per-image-condition paths — image coverage stays ONE combined bullet', () => {
	const result = buildFixtureResult();
	const report = formatAuditReport(result, '2026-08-02T00:00:00.000Z');

	const coverageBulletCount = (report.match(/^- Image coverage: /gm) ?? []).length;
	assert.equal(coverageBulletCount, 1, 'exactly one combined Image coverage bullet');
	assert.match(report, new RegExp(`Image coverage: ${result.imageCoverage.described}/${result.imageCoverage.referenced} described, `
		+ `${result.imageCoverage.failed} failed, ${result.imageCoverage.pending} pending`));
	// No image descriptor's dashboardLabel/classLabel ever leaks into the report.
	const imageConditions = AUDIT_CONDITIONS.filter(d => d.category === 'image');
	for (const d of imageConditions) {
		assert.doesNotMatch(report, new RegExp(d.dashboardLabel));
		assert.doesNotMatch(report, new RegExp(`^## ${d.classLabel}`, 'm'));
	}
});

/* ---------------------------------------------------- tests: dashboard parity */

test('the dashboard summary table\'s row labels/order are exactly AUDIT_CONDITIONS\' dashboardLabel, in order, plus the trailing imagesDescribed row', async () => {
	const { plugin } = makeFixturePlugin();
	const section = createSearchAuditSection(makeHost(plugin));
	await runSuccessfulAudit(section);
	const { body } = renderBody(section);
	const rows = summaryRows(body);

	assert.equal(rows.length, AUDIT_CONDITIONS.length + 1, 'eight real conditions plus the one virtual imagesDescribed row');
	for (const [i, d] of AUDIT_CONDITIONS.entries()) {
		assert.equal(rowLabelText(rows[i]), d.dashboardLabel, `row ${i} ("${d.key}") label must equal its own descriptor's dashboardLabel`);
	}
	assert.equal(rowLabelText(rows[AUDIT_CONDITIONS.length]), 'Images described (informational)');
});

test('the paths table\'s Class column reads exactly AUDIT_CONDITIONS\' classLabel for every filterable condition', async () => {
	const { plugin } = makeFixturePlugin();
	const section = createSearchAuditSection(makeHost(plugin));
	await runSuccessfulAudit(section);

	for (const [i, d] of AUDIT_CONDITIONS.entries()) {
		const { body } = renderBody(section);
		const rows = summaryRows(body);
		const btn = buttons(rows[i].children[0])[0];
		assert.ok(btn, `row ${i} ("${d.key}") must be clickable in this fixture (every condition has a non-zero count)`);
		btn.click();
		const pathRows = trs(pathsTableContainer(body));
		assert.ok(pathRows.length > 0, `filtering to "${d.key}" must produce at least one row`);
		for (const row of pathRows) {
			assert.equal(row.children[1].textContent, d.classLabel, `paths-table Class cell for "${d.key}" must equal its own descriptor's classLabel`);
		}
	}
});

test('image coverage: the SAME computeSearchAudit numbers back the report\'s one bullet and the dashboard\'s three rows', async () => {
	const { plugin, result } = makeFixturePlugin();
	const section = createSearchAuditSection(makeHost(plugin));
	await runSuccessfulAudit(section);
	const { body } = renderBody(section);
	const rows = summaryRows(body);

	// Dashboard: three independent rows (imagePending, imageFailed, imagesDescribed).
	const pendingIdx = AUDIT_CONDITIONS.findIndex(d => d.key === 'imagePending');
	const failedIdx = AUDIT_CONDITIONS.findIndex(d => d.key === 'imageFailed');
	assert.equal(rows[pendingIdx].children[1].textContent, String(result.imageCoverage.pending));
	assert.equal(rows[failedIdx].children[1].textContent, String(result.imageCoverage.failed));
	assert.equal(rows[AUDIT_CONDITIONS.length].children[1].textContent, `${result.imageCoverage.described} / ${result.imageCoverage.referenced}`);

	// Report: one combined bullet carrying the identical four numbers.
	const report = formatAuditReport(result, '2026-08-02T00:00:00.000Z');
	assert.match(report, new RegExp(`Image coverage: ${result.imageCoverage.described}/${result.imageCoverage.referenced} described, `
		+ `${result.imageCoverage.failed} failed, ${result.imageCoverage.pending} pending`));

	// Sanity: the fixture actually exercises all three (a parity test with all-zero counts would
	// pass vacuously).
	assert.ok(result.imageCoverage.pending > 0 && result.imageCoverage.failed > 0 && result.imageCoverage.described > 0);
});
