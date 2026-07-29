import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Covers two of WP-4's five fixes:
//
// (#1) renderTableSection's default row cap (~200) + "showing N of M" caption.
// section.ts and sortableTable.ts import nothing from 'obsidian' — they only call
// the Obsidian DOM-extension methods (createDiv/createEl/addClass/...) that
// Obsidian installs onto real HTMLElement.prototype at runtime — so this bundles
// them straight for Node (same treatment as refresh.ts in
// ingestionRefreshGates.test.mjs) against a small hand-rolled element stub that
// implements just that subset, rather than a full DOM.
//
// (#2 / #5) The dashboard's event-listener wiring (own minIntervalGate for the
// youtubeWithoutMetadata scan; SectionContext.refresh becoming the scroll-
// preserving wrapped function so refresh(id) is a plain dispatch) lives in
// ingestionDashboard.ts, which pulls in the real 'obsidian' App/TFile/debounce
// surface and the full CruciblePlugin type. Standing up enough of a stub to
// bundle and execute it is disproportionate to these two wiring changes (the
// same call tests/searchRerankAffordance.test.mjs makes for SearchModal.ts), so
// those are covered as STRUCTURAL (source-text) assertions instead — the cadence
// semantics of minIntervalGate itself are already fully exercised, behaviorally,
// in ingestionRefreshGates.test.mjs.

const outdir = path.join(tmpdir(), 'obsidian-crucible-ingestion-table-cap-tests');
const outfile = path.join(outdir, 'section.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/ingestion/render/section.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const { renderTableSection, DEFAULT_TABLE_ROW_LIMIT } = await import(pathToFileURL(outfile).href);

/* ------------------------------------------------------------------- element stub */

// The Obsidian DOM-extension subset renderTableSection/renderSortableTable
// actually call. Not a DOM: no styles, no events beyond click, no attributes
// beyond cls/text — just enough surface to drive and inspect the rendered tree.
class FakeEl {
	constructor(tag = 'div') {
		this.tagName = tag.toUpperCase();
		this.className = '';
		this.textContent = '';
		this.children = [];
		this.parentElement = null;
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
	addEventListener(evt, fn) {
		(this._listeners[evt] ??= []).push(fn);
	}
	click() {
		for (const fn of this._listeners.click ?? []) fn({ target: this });
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

function idColumn() {
	return { key: 'id', label: 'ID', render: (r, td) => td.setText(String(r.id)) };
}

function fakeCtx() {
	return { sort: null, refresh: () => {} };
}

/* --------------------------------------------------------------- (#1) row cap */

test('renderTableSection caps at DEFAULT_TABLE_ROW_LIMIT (200) and shows a "showing N of M" caption', () => {
	assert.equal(DEFAULT_TABLE_ROW_LIMIT, 200, 'pinned default — queueMonitor keeps its own tighter 100 independently');

	const body = new FakeEl();
	const rows = Array.from({ length: 250 }, (_, i) => ({ id: i }));
	let reportedCount = null;

	renderTableSection({
		body,
		ctx: fakeCtx(),
		rows,
		columns: [idColumn()],
		emptyText: 'none',
		setCount: n => { reportedCount = n; },
	});

	assert.equal(reportedCount, 250, 'the header count reflects the full row count, not the capped view');
	const trs = body.querySelectorAll('tr').filter(tr => tr.parentElement.tagName === 'TBODY');
	assert.equal(trs.length, 200, 'only DEFAULT_TABLE_ROW_LIMIT rows render');
	const caption = body.children.find(c => c.className === 'crucible-ingestion-table-caption');
	assert.ok(caption, 'a caption renders when the row set is capped');
	assert.equal(caption.textContent, 'showing 200 of 250');
});

test('renderTableSection respects an overriding limit', () => {
	const body = new FakeEl();
	const rows = Array.from({ length: 10 }, (_, i) => ({ id: i }));

	renderTableSection({
		body,
		ctx: fakeCtx(),
		rows,
		columns: [idColumn()],
		emptyText: 'none',
		setCount: () => {},
		limit: 5,
	});

	const trs = body.querySelectorAll('tr').filter(tr => tr.parentElement.tagName === 'TBODY');
	assert.equal(trs.length, 5, 'the override, not the default, bounds the rendered rows');
	const caption = body.children.find(c => c.className === 'crucible-ingestion-table-caption');
	assert.equal(caption.textContent, 'showing 5 of 10');
});

test('renderTableSection renders no caption when every row fits within the limit', () => {
	const body = new FakeEl();
	const rows = Array.from({ length: 3 }, (_, i) => ({ id: i }));

	renderTableSection({
		body,
		ctx: fakeCtx(),
		rows,
		columns: [idColumn()],
		emptyText: 'none',
		setCount: () => {},
	});

	const trs = body.querySelectorAll('tr').filter(tr => tr.parentElement.tagName === 'TBODY');
	assert.equal(trs.length, 3, 'all rows render, uncapped');
	const caption = body.children.find(c => c.className === 'crucible-ingestion-table-caption');
	assert.equal(caption, undefined, 'no "showing N of M" line when nothing was cut');
});

test('renderTableSection still short-circuits to the empty state with zero rows, cap or no cap', () => {
	const body = new FakeEl();
	renderTableSection({
		body,
		ctx: fakeCtx(),
		rows: [],
		columns: [idColumn()],
		emptyText: 'Nothing here.',
		setCount: () => {},
	});
	assert.equal(body.children.length, 1);
	assert.equal(body.children[0].className, 'crucible-empty-state');
	assert.equal(body.children[0].textContent, 'Nothing here.');
});

/* ---------------------------------------------------- (#2 / #5) STRUCTURAL wiring */

const dashboardSrc = readFileSync('src/ingestionDashboard.ts', 'utf8');

test('STRUCTURAL: debouncedYoutubeNoMetadata runs through its own minIntervalGate, not a raw debounce', () => {
	assert.match(
		dashboardSrc,
		/const gatedYoutubeNoMetadataRefresh = minIntervalGate\(\s*\(\) => this\.refresh\('youtubeWithoutMetadata'\),\s*YOUTUBE_NO_METADATA_MIN_INTERVAL_MS,?\s*\);/,
		'youtubeWithoutMetadata must be wrapped in its own minIntervalGate instance',
	);
	assert.match(
		dashboardSrc,
		/const debouncedYoutubeNoMetadata = debounce\(\(\) => gatedYoutubeNoMetadataRefresh\(\), SCAN_DEBOUNCE_MS, true\);/,
		'the outer Obsidian debounce must call the gate, not refresh(...) directly',
	);
	assert.notEqual(
		'YOUTUBE_NO_METADATA_MIN_INTERVAL_MS',
		'QUEUE_MONITOR_MIN_INTERVAL_MS',
		'sanity: the two scans must use independently-named gate constants',
	);
});

test('STRUCTURAL: the two intake-button folder scans run inside the gated queue-monitor path, not on every debounce tick', () => {
	const gateStart = dashboardSrc.indexOf('const gatedQueueMonitorRefresh = minIntervalGate(');
	assert.ok(gateStart >= 0, 'gatedQueueMonitorRefresh not found');
	const gateEnd = dashboardSrc.indexOf('QUEUE_MONITOR_MIN_INTERVAL_MS);', gateStart);
	const gateBody = dashboardSrc.slice(gateStart, gateEnd);
	assert.ok(gateBody.includes("this.refresh('queueMonitor')"), 'queueMonitor refresh must be inside the gate');
	assert.ok(gateBody.includes("this.intake.refreshIntakeButton('blog')"), 'blog intake-button scan must be inside the gate');
	assert.ok(gateBody.includes("this.intake.refreshIntakeButton('youtube')"), 'youtube intake-button scan must be inside the gate');

	const debouncedStart = dashboardSrc.indexOf('const debouncedQueueMonitor = debounce(');
	const debouncedEnd = dashboardSrc.indexOf(';', debouncedStart);
	const debouncedBody = dashboardSrc.slice(debouncedStart, debouncedEnd);
	assert.ok(
		!debouncedBody.includes('refreshIntakeButton'),
		'the outer debounce must no longer call refreshIntakeButton directly — that ran ungated on every 150ms tick',
	);
});

test('STRUCTURAL: SectionContext.refresh is built as the scroll-preserving wrapped function at every construction site', () => {
	// ingestionDashboard.ts's generic buildSection().
	assert.match(
		dashboardSrc,
		/refresh: \(\) => refreshWithScrollPreserved\(body, \(\) => this\.renderSection\(id, body, ctx\)\),/,
		'buildSection must wrap ctx.refresh in refreshWithScrollPreserved',
	);

	// The private refresh(id) dispatcher becomes a plain dispatch — it must no
	// longer call refreshWithScrollPreserved itself, since ctx.refresh now is that.
	const dispatchStart = dashboardSrc.indexOf('private async refresh(id: SectionId): Promise<void> {');
	assert.ok(dispatchStart >= 0, 'refresh(id) dispatcher not found');
	const dispatchEnd = dashboardSrc.indexOf('\n\t}', dispatchStart);
	const dispatchBody = dashboardSrc.slice(dispatchStart, dispatchEnd);
	assert.ok(!dispatchBody.includes('refreshWithScrollPreserved'), 'refresh(id) must be a plain dispatch, not a second wrap');
	assert.ok(dispatchBody.includes('await ctx.refresh();'), 'refresh(id) must just call the already-wrapped ctx.refresh()');

	// The other two SectionContext construction sites (queueMonitor.ts,
	// queueControls.ts) get the same treatment — each imports and applies
	// refreshWithScrollPreserved around its own render function.
	const queueMonitorSrc = readFileSync('src/ingestion/sections/queueMonitor.ts', 'utf8');
	assert.match(
		queueMonitorSrc,
		/refresh: \(\) => refreshWithScrollPreserved\(body, \(\) => renderQueueMonitor\(host, body, ctx\)\),/,
		'queueMonitor.ts must wrap its ctx.refresh the same way',
	);
	const queueControlsSrc = readFileSync('src/ingestion/sections/queueControls.ts', 'utf8');
	assert.match(
		queueControlsSrc,
		/refresh: \(\) => refreshWithScrollPreserved\(body, \(\) => renderQueueControls\(host, body\)\),/,
		'queueControls.ts must wrap its ctx.refresh the same way',
	);
});

/* ---------------------------------------------------- (#4) STRUCTURAL: no blank window */

test('STRUCTURAL: renderQueueMonitor no longer empties the body before the listFolder awaits', () => {
	const queueMonitorSrc = readFileSync('src/ingestion/sections/queueMonitor.ts', 'utf8');
	const fnStart = queueMonitorSrc.indexOf('export async function renderQueueMonitor(');
	assert.ok(fnStart >= 0, 'renderQueueMonitor not found');
	const awaitIdx = queueMonitorSrc.indexOf('await Promise.all([store.listFolder', fnStart);
	assert.ok(awaitIdx > fnStart, 'the listFolder await not found inside renderQueueMonitor');
	const beforeAwait = queueMonitorSrc.slice(fnStart, awaitIdx);
	assert.ok(!beforeAwait.includes('body.empty()'), 'body must not be emptied before the folder-scan awaits — that is the blank-window bug');
});
