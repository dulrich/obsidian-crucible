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

const { renderTableSection, DEFAULT_TABLE_ROW_LIMIT, computeRowSignature, shouldRepaint } = await import(pathToFileURL(outfile).href);

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

/* ----------------------------------------------------- rsp-wp5 P5: row signature */
//
// computeRowSignature/shouldRepaint (render/section.ts) — the primitive every
// section call site uses to skip a repaint when an event-driven pass's
// computed row model is byte-identical to what's already painted. Both are
// pure and DOM-free, so these drive them directly rather than through
// renderTableSection.

test('computeRowSignature is deterministic and reacts to row content changes', () => {
	const rowsA = [{ id: 1, title: 'a' }, { id: 2, title: 'b' }];
	const rowsB = [{ id: 1, title: 'a' }, { id: 2, title: 'b' }];
	const rowsChanged = [{ id: 1, title: 'a' }, { id: 2, title: 'CHANGED' }];
	assert.equal(computeRowSignature(rowsA), computeRowSignature(rowsB), 'two structurally-identical row arrays produce the same signature');
	assert.notEqual(computeRowSignature(rowsA), computeRowSignature(rowsChanged), 'a changed field produces a different signature');
});

test('computeRowSignature folds `extra` into the signature — e.g. a live badge map not carried on the row itself', () => {
	const rows = [{ videoId: 'v1' }];
	const sigIdle = computeRowSignature(rows, ['idle']);
	const sigRunning = computeRowSignature(rows, ['running']);
	assert.notEqual(sigIdle, sigRunning, 'identical rows with different extra state must not collide');
});

test('computeRowSignature collapses a vault-entry-shaped object (duck-typed TFile) to its path instead of throwing on the vault back-reference cycle', () => {
	// Mirrors the real TFile shape closely enough to exercise the duck-typed
	// branch: a `.path` string plus a `.vault` back-reference that would form a
	// cycle (vault -> files -> vault -> ...) under a plain JSON.stringify.
	const vault = {};
	const file = { path: 'a/b.md', vault, basename: 'b', stat: { mtime: 1 } };
	vault.files = [file]; // the cycle
	assert.doesNotThrow(() => computeRowSignature([{ file }]));
	const sigSamePath = computeRowSignature([{ file: { path: 'a/b.md', vault, basename: 'DIFFERENT-BUT-IRRELEVANT' } }]);
	assert.equal(computeRowSignature([{ file }]), sigSamePath, 'only the path identifies the row; unrelated TFile fields do not affect the signature');
	const otherFile = { path: 'a/other.md', vault };
	assert.notEqual(computeRowSignature([{ file }]), computeRowSignature([{ file: otherFile }]), 'a different path still produces a different signature');
});

test('shouldRepaint: a forced pass (no eventDriven flag) always repaints, even with an identical signature', () => {
	const ctx = { sort: null, refresh: () => {} };
	const sig = computeRowSignature([{ id: 1 }]);
	assert.equal(shouldRepaint(ctx, sig), true, 'first call always repaints (no baseline yet)');
	assert.equal(shouldRepaint(ctx, sig), true, 'forced (ctx.eventDriven unset) repaints again even though the signature has not changed');
});

test('shouldRepaint: an event-driven pass skips when the signature is unchanged, and repaints when it changes', () => {
	const ctx = { sort: null, refresh: () => {}, eventDriven: true };
	const sigA = computeRowSignature([{ id: 1 }]);
	const sigB = computeRowSignature([{ id: 2 }]);
	assert.equal(shouldRepaint(ctx, sigA), true, 'first event-driven pass has no baseline yet, so it repaints');
	assert.equal(shouldRepaint(ctx, sigA), false, 'identical signature on a later event-driven pass skips the repaint');
	assert.equal(shouldRepaint(ctx, sigB), true, 'a changed signature still repaints');
	assert.equal(shouldRepaint(ctx, sigB), false, 'settles back to skipping once the new signature is the baseline');
});

test('shouldRepaint: a forced repaint updates the baseline, so a LATER event-driven pass compares against what is now on screen', () => {
	const ctx = { sort: null, refresh: () => {} };
	const sig = computeRowSignature([{ id: 1 }]);
	assert.equal(shouldRepaint(ctx, sig), true, 'forced pass repaints');
	ctx.eventDriven = true;
	assert.equal(shouldRepaint(ctx, sig), false, 'an event-driven pass right after sees the forced pass\'s baseline, not a stale one, and skips');
});

/* ---------------------------------------------------- (#2 / #5) STRUCTURAL wiring */

const dashboardSrc = readFileSync('src/ingestionDashboard.ts', 'utf8');

test('STRUCTURAL (rsp-wp5 P6): FAST_SECTIONS / SCAN_SECTIONS partition every auto-refreshed SectionId into exactly one of the two cadence classes', () => {
	const fastMatch = dashboardSrc.match(/FAST_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>\(\[([\s\S]*?)\]\);/);
	const scanMatch = dashboardSrc.match(/SCAN_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>\(\[([\s\S]*?)\]\);/);
	assert.ok(fastMatch, 'FAST_SECTIONS set not found');
	assert.ok(scanMatch, 'SCAN_SECTIONS set not found');
	const parseIds = (body) => Array.from(body.matchAll(/'([a-zA-Z]+)'/g)).map(m => m[1]);
	const fast = parseIds(fastMatch[1]);
	const scan = parseIds(scanMatch[1]);
	for (const id of ['unprocessedClippings', 'unrefinedTranscripts', 'blogIntake', 'youtubeIntake', 'ignoredPosts', 'ignoredVideos']) {
		assert.ok(fast.includes(id), `${id} must be in the fast (~150ms) cadence class`);
	}
	for (const id of ['uncapturedPosts', 'uncapturedVideos', 'blogControl', 'orphanedAttachments', 'missingAttachments', 'youtubeWithoutMetadata', 'queueMonitor']) {
		assert.ok(scan.includes(id), `${id} must be in the scan (~1000ms) cadence class — youtubeWithoutMetadata and queueMonitor kept their pre-P6 1000ms floor by living here`);
	}
	const overlap = fast.filter(id => scan.includes(id));
	assert.deepEqual(overlap, [], 'no SectionId may belong to both cadence classes');
});

test('STRUCTURAL (rsp-wp5 P6): markDirty routes to the fast gate for FAST_SECTIONS ids and the scan gate for SCAN_SECTIONS ids, nothing else', () => {
	const fnStart = dashboardSrc.indexOf('private markDirty(id: SectionId): void {');
	assert.ok(fnStart >= 0, 'markDirty not found');
	const fnEnd = dashboardSrc.indexOf('\n\t}', fnStart);
	const body = dashboardSrc.slice(fnStart, fnEnd);
	assert.ok(body.includes('this.dirty.add(id);'), 'markDirty must add the id to the dirty set');
	assert.match(body, /if \(IngestionDashboardUI\.FAST_SECTIONS\.has\(id\)\) this\.flushFast\(\);/, 'FAST_SECTIONS ids must kick the fast gate');
	assert.match(body, /else if \(IngestionDashboardUI\.SCAN_SECTIONS\.has\(id\)\) this\.flushScan\(\);/, 'SCAN_SECTIONS ids must kick the scan gate');
});

test('STRUCTURAL (rsp-wp5 P6): flushDirty renders every currently-dirty section of its class in one batch, marked eventDriven, and clears them before rendering', () => {
	const fnStart = dashboardSrc.indexOf('private flushDirty(classIds: ReadonlySet<SectionId>): void {');
	assert.ok(fnStart >= 0, 'flushDirty not found');
	const fnEnd = dashboardSrc.indexOf('\n\t}', fnStart);
	const body = dashboardSrc.slice(fnStart, fnEnd);
	const deleteIdx = body.indexOf('this.dirty.delete(id)');
	const renderIdx = body.indexOf("refresh({ eventDriven: true })");
	assert.ok(deleteIdx >= 0, 'flushDirty must clear each rendered id from the dirty set');
	assert.ok(renderIdx >= 0, 'flushDirty must call refresh with eventDriven: true — the flag render/section.ts\'s shouldRepaint() gates the skip on');
	assert.ok(deleteIdx < renderIdx, 'dirty ids must be cleared before rendering (so a mark arriving mid-render is not silently dropped)');
	assert.ok(body.includes("due.map(id => this.sections.get(id)?.refresh"), 'every due id must be rendered together via one synchronous .map() pass (no await between calls), so the shared scroll coordinator batches them into one capture/restore');
	assert.ok(body.includes("due.includes('queueMonitor')"), 'queueMonitor\'s flush must also refresh the two intake header buttons — the same coupling the pre-P6 gatedQueueMonitorRefresh had');
	assert.ok(body.includes("refreshIntakeButton('blog')") && body.includes("refreshIntakeButton('youtube')"), 'both intake buttons must be refreshed alongside queueMonitor');

	// The forced-vs-event-driven distinction P5's shouldRepaint() reads (see
	// ctx.eventDriven's doc comment in render/types.ts) only holds if
	// `eventDriven: true` is passed from exactly one call site — flushDirty's
	// batch render. Every other refresh() call site (header Refresh button,
	// sort-header clicks, Ignore/Unignore, this.refresh(id)) must pass no
	// opts at all, which resolves to a forced pass.
	const eventDrivenSites = dashboardSrc.match(/eventDriven: true/g) ?? [];
	assert.equal(eventDrivenSites.length, 1, 'eventDriven: true must appear exactly once in ingestionDashboard.ts — flushDirty is the sole event-driven call site');
});

test('STRUCTURAL (rsp-wp5 P6): the debounce plumbing flushDirty replaces is gone — no Obsidian debounce import, no dead cadence constants', () => {
	assert.equal(/[a-zA-Z_$][\w$]*\s*=\s*debounce\(/.test(dashboardSrc), false, 'no more `const x = debounce(...)` closures — the coordinated flush replaced all of them (comments may still name the pattern in prose)');
	assert.ok(!/import \{[^}]*\bdebounce\b[^}]*\} from 'obsidian';/.test(dashboardSrc), 'the obsidian debounce import must be removed once nothing calls it');
	assert.equal(dashboardSrc.includes('QUEUE_MONITOR_MIN_INTERVAL_MS'), false, 'the queueMonitor-specific gate constant is dead — queueMonitor now shares the SCAN class gate');
	assert.equal(dashboardSrc.includes('YOUTUBE_NO_METADATA_MIN_INTERVAL_MS'), false, 'the youtubeWithoutMetadata-specific gate constant is dead — it now shares the SCAN class gate');
});

test('STRUCTURAL: SectionContext.refresh is built as the scroll-preserving wrapped function at every construction site', () => {
	// ingestionDashboard.ts's generic buildSection() — rsp-wp5 P5/P6: refresh now
	// takes an optional opts param and stamps ctx.eventDriven before rendering,
	// so every call site can be told apart by render/section.ts's shouldRepaint().
	assert.match(
		dashboardSrc,
		/refresh: \(opts\) => \{\s*ctx\.eventDriven = opts\?\.eventDriven === true;\s*return refreshWithScrollPreserved\(body, \(\) => this\.renderSection\(id, body, ctx\)\);\s*\},/,
		'buildSection must wrap ctx.refresh in refreshWithScrollPreserved and stamp ctx.eventDriven from opts first',
	);

	// The private refresh(id) dispatcher stays a plain dispatch — it must not
	// call refreshWithScrollPreserved itself, since ctx.refresh now is that, and
	// it must not pass eventDriven (every host.refresh(id)/refreshAll() call is
	// a forced pass).
	const dispatchStart = dashboardSrc.indexOf('private async refresh(id: SectionId): Promise<void> {');
	assert.ok(dispatchStart >= 0, 'refresh(id) dispatcher not found');
	const dispatchEnd = dashboardSrc.indexOf('\n\t}', dispatchStart);
	const dispatchBody = dashboardSrc.slice(dispatchStart, dispatchEnd);
	assert.ok(!dispatchBody.includes('refreshWithScrollPreserved'), 'refresh(id) must be a plain dispatch, not a second wrap');
	assert.ok(dispatchBody.includes('await ctx.refresh();'), 'refresh(id) must just call the already-wrapped ctx.refresh() with no opts (forced)');

	// The other two SectionContext construction sites (queueMonitor.ts,
	// queueControls.ts) get the same treatment — each imports and applies
	// refreshWithScrollPreserved around its own render function.
	const queueMonitorSrc = readFileSync('src/ingestion/sections/queueMonitor.ts', 'utf8');
	assert.match(
		queueMonitorSrc,
		/refresh: \(\) => refreshWithScrollPreserved\(body, \(\) => renderQueueMonitor\(host, body, ctx, statsRow\)\),/,
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

test('STRUCTURAL: renderQueueMonitor no longer empties the body before the listJobs awaits', () => {
	// WP-7: the direct JobStore.listFolder reach-around moved onto
	// Orchestrator.listJobs (the backend-agnostic seam), but the property under test —
	// no body.empty() before the awaited fetch that populates rows — is unchanged.
	const queueMonitorSrc = readFileSync('src/ingestion/sections/queueMonitor.ts', 'utf8');
	const fnStart = queueMonitorSrc.indexOf('export async function renderQueueMonitor(');
	assert.ok(fnStart >= 0, 'renderQueueMonitor not found');
	const awaitIdx = queueMonitorSrc.indexOf('await Promise.all([orchestrator.listJobs', fnStart);
	assert.ok(awaitIdx > fnStart, 'the listJobs await not found inside renderQueueMonitor');
	const beforeAwait = queueMonitorSrc.slice(fnStart, awaitIdx);
	assert.ok(!beforeAwait.includes('body.empty()'), 'body must not be emptied before the query awaits — that is the blank-window bug');
});

/* -------------------------------------------- (WP-6) STRUCTURAL: Ignore double-render */
//
// The behavioral contract of the echo-suppression primitive itself (one mark = one
// suppressed echo, unrelated ids/expired markers are not swallowed) is covered against
// the real compiled module in ingestionRefreshGates.test.mjs. What's left to prove here
// is that the two real call sites — ingestionDashboard.ts's route() and render/cells.ts's
// Ignore/Unignore handlers — actually invoke it, at the ids that make one click coalesce
// to one render. ingestionDashboard.ts still pulls the full 'obsidian' App/TFile surface
// (see the block comment above), so this stays structural, same as (#2/#5) above;
// cells.ts only imports the 'obsidian' Notice class, so it's cheap enough to bundle with
// the small stub below and drive an actual DOM click through the real compiled handler.

test('STRUCTURAL: route() consumes the self-refresh echo marker for every id it would otherwise redundantly re-render on an IGNORED_IDS_NOTE write', () => {
	const blockStart = dashboardSrc.indexOf('if (path === IGNORED_IDS_NOTE) {');
	assert.ok(blockStart >= 0, 'the IGNORED_IDS_NOTE route() block not found');
	const blockEnd = dashboardSrc.indexOf('\n\t\t\t}', blockStart);
	const block = dashboardSrc.slice(blockStart, blockEnd);
	for (const id of ['ignoredPosts', 'ignoredVideos', 'uncapturedPosts', 'uncapturedVideos', 'blogControl']) {
		assert.match(
			block,
			new RegExp(`if \\(!consumeSelfRefreshedEcho\\('${id}'\\)\\) this\\.markDirty\\('${id}'\\);`),
			`the ${id} dirty mark must be gated on consumeSelfRefreshedEcho('${id}'), not called unconditionally (rsp-wp5 P6: markDirty replaced the old per-section debounced${id[0].toUpperCase()}${id.slice(1)}() closure)`,
		);
	}
	assert.match(dashboardSrc, /import \{ consumeSelfRefreshedEcho \} from '\.\/ingestion\/render\/echoSuppress';/, 'consumeSelfRefreshedEcho must be imported from the real echoSuppress module, not reimplemented');
});

test('STRUCTURAL (WP-DP1): cells.ts marks both the owning and companion section before dispatching either refresh — for renderIgnoreButton/renderSkipButton directly, and for renderClipButton/renderEnrichButton via the shared dispatchPrimaryActionRefresh helper', () => {
	const cellsSrc = readFileSync('src/ingestion/render/cells.ts', 'utf8');
	assert.match(cellsSrc, /import \{ markSelfRefreshedForEcho \} from '\.\/echoSuppress';/, 'cells.ts must import the real primitive, not reimplement it');

	// renderIgnoreButton (kept for youtubeWithoutMetadata.ts) and renderSkipButton (its
	// WP-DP1 replacement for the four sections in scope here) both do the mark-then-
	// refresh dance inline.
	for (const fnName of ['renderIgnoreButton', 'renderSkipButton']) {
		const fnStart = cellsSrc.indexOf(`export function ${fnName}(`);
		assert.ok(fnStart >= 0, `${fnName} not found`);
		const fnEnd = cellsSrc.indexOf('\n}', fnStart);
		const fnBody = cellsSrc.slice(fnStart, fnEnd);
		const markOwn = fnBody.indexOf('markSelfRefreshedForEcho(ownSectionId);');
		const markCompanion = fnBody.indexOf('markSelfRefreshedForEcho(companionSectionId);');
		const ctxRefresh = fnBody.indexOf('ctx.refresh();');
		const hostRefresh = fnBody.indexOf('host.refresh(companionSectionId);');
		assert.ok(markOwn >= 0 && markCompanion >= 0, `${fnName} must mark both ids for echo suppression`);
		assert.ok(
			markOwn < ctxRefresh && markCompanion < hostRefresh,
			`${fnName} must mark each id BEFORE dispatching its refresh, so the marker is armed before the vault event can arrive`,
		);
	}

	// renderClipButton/renderEnrichButton (the Ignored-section un-ignore-then-run path)
	// factor the same mark-then-refresh dance into one shared helper instead of
	// repeating it — assert the helper does it correctly, and that both renderers call it.
	const helperStart = cellsSrc.indexOf('function dispatchPrimaryActionRefresh(');
	assert.ok(helperStart >= 0, 'dispatchPrimaryActionRefresh not found');
	const helperEnd = cellsSrc.indexOf('\n}', helperStart);
	const helperBody = cellsSrc.slice(helperStart, helperEnd);
	const markOwn = helperBody.indexOf('markSelfRefreshedForEcho(opts.ownSectionId);');
	const markCompanion = helperBody.indexOf('markSelfRefreshedForEcho(opts.companionSectionId);');
	const ctxRefresh = helperBody.indexOf('ctx.refresh();');
	const hostRefresh = helperBody.indexOf('host.refresh(opts.companionSectionId);');
	assert.ok(markOwn >= 0 && markCompanion >= 0, 'dispatchPrimaryActionRefresh must mark both ids for echo suppression');
	assert.ok(
		markOwn < ctxRefresh && markCompanion < hostRefresh,
		'dispatchPrimaryActionRefresh must mark each id BEFORE dispatching its refresh',
	);
	for (const fnName of ['renderClipButton', 'renderEnrichButton']) {
		const fnStart = cellsSrc.indexOf(`export function ${fnName}(`);
		assert.ok(fnStart >= 0, `${fnName} not found`);
		const fnEnd = cellsSrc.indexOf('\nexport function', fnStart + 1);
		const fnBody = cellsSrc.slice(fnStart, fnEnd < 0 ? cellsSrc.length : fnEnd);
		assert.ok(fnBody.includes('dispatchPrimaryActionRefresh(host, ctx, opts);'), `${fnName} must dispatch its success refresh via the shared helper`);
	}

	// The Uncaptured-section Skip call sites: own id, companion id — matching the ids
	// route() actually schedules a debounced refresh for on an IGNORED_IDS_NOTE write.
	const skipSites = [
		{ file: 'src/ingestion/sections/uncapturedVideos.ts', own: 'uncapturedVideos', companion: 'ignoredVideos' },
		{ file: 'src/ingestion/sections/uncapturedPosts.ts', own: 'uncapturedPosts', companion: 'ignoredPosts' },
	];
	for (const { file, own, companion } of skipSites) {
		const src = readFileSync(file, 'utf8');
		assert.ok(src.includes('renderSkipButton(td, host, '), `${file} must call renderSkipButton with (td, host, ...) — a DashboardHost, not a bare App`);
		assert.match(
			src,
			new RegExp(`renderSkipButton\\(td, host, '(?:youtube|blog)', [^,]+, '${own}', '${companion}', ctx\\)`),
			`${file} must pass own id '${own}' and companion id '${companion}' to renderSkipButton`,
		);
	}

	// youtubeWithoutMetadata.ts is out of WP-DP1 scope and still uses renderIgnoreButton.
	const ywmSrc = readFileSync('src/ingestion/sections/youtubeWithoutMetadata.ts', 'utf8');
	assert.match(
		ywmSrc,
		/renderIgnoreButton\(td, host, 'youtube', [^,]+, 'youtubeWithoutMetadata', 'ignoredVideos', ctx\)/,
		'youtubeWithoutMetadata.ts must still pass own id \'youtubeWithoutMetadata\' and companion id \'ignoredVideos\' to renderIgnoreButton',
	);

	// ignored.ts: renderClipButton/renderEnrichButton's own/companion ids arrive as
	// opts object fields, not positional args — matching call-site shape asserted in
	// tests/ingestionIgnoredRows.test.mjs's structural block.
	const ignoredSrc = readFileSync('src/ingestion/sections/ignored.ts', 'utf8');
	assert.match(ignoredSrc, /ownSectionId: 'ignoredPosts',\s*\n\s*companionSectionId: 'uncapturedPosts',/, 'ignored.ts renderClipButton call must pass ignoredPosts/uncapturedPosts');
	assert.match(ignoredSrc, /ownSectionId: 'ignoredVideos',\s*\n\s*companionSectionId: 'uncapturedVideos',/, 'ignored.ts renderEnrichButton call must pass ignoredVideos/uncapturedVideos');
});

/* -------------------------------------------------------------- rsp-wp2: P1–P4 */
//
// P1 (queue-root exclusion), P2 (first-sighting + echo-leak fix), and P4 (intake
// button state cache) all live in code that pulls the real 'obsidian' module
// (ingestionDashboard.ts's App/TFile/debounce surface, intake.ts's feedIntake.ts
// import), so per the block comment at the top of this file these stay STRUCTURAL
// (source-text) assertions, same treatment as the WP-4/WP-6 tests above. Each is
// paired with a BEHAVIORAL test that drives the actual guard/gate logic — lifted
// verbatim from the source via regex, or reimplemented as the documented pattern
// where lifting isn't practical — against representative inputs, so the semantics
// are exercised, not just the presence of the right token. P3 (compute-then-paint)
// is a pure ordering fact about the source, so it stays fully structural, matching
// the existing renderQueueMonitor blank-window test above.

test('STRUCTURAL: route() early-returns for any path under orchestrationQueueRoot, before every other branch', () => {
	const routeStart = dashboardSrc.indexOf("const route = (path: string, reason: 'meta' | 'structural') => {");
	assert.ok(routeStart >= 0, 'route() not found');
	const guardRe = /const queueRoot = this\.plugin\.settings\.orchestrationQueueRoot;\s*\n\s*if \(queueRoot && \(path === queueRoot \|\| path\.startsWith\(`\$\{queueRoot\}\/`\)\)\) return;/;
	const match = dashboardSrc.slice(routeStart).match(guardRe);
	assert.ok(match, 'route() must early-return for paths under orchestrationQueueRoot (JobStore.ts inbox/running/done/failed/cancelled all live under this root)');
	const guardIdx = routeStart + match.index;
	const ignoredIdx = dashboardSrc.indexOf('if (path === IGNORED_IDS_NOTE)', routeStart);
	assert.ok(guardIdx < ignoredIdx, 'the queue-root guard must run before the IGNORED_IDS_NOTE branch, so job-file churn never reaches ANY dashboard section');
});

test('BEHAVIORAL: the queue-root guard predicate (lifted from source) matches every JobStore lifecycle subfolder and nothing else', () => {
	const guardRe = /if \((queueRoot && \(path === queueRoot \|\| path\.startsWith\(`\$\{queueRoot\}\/`\)\))\) return;/;
	const match = dashboardSrc.match(guardRe);
	assert.ok(match, 'queue-root guard expression not found in route()');
	// Exercises the exact predicate text lifted from the source above, not a reimplementation.
	const underQueueRoot = new Function('path', 'queueRoot', `return !!(${match[1]});`);
	const root = '_crucible/orchestration/queue';
	for (const bucket of ['inbox', 'running', 'done', 'failed', 'cancelled']) {
		assert.equal(underQueueRoot(`${root}/${bucket}/job-1.md`, root), true, `${bucket}/ must match — JobStore.ts's STATUS_FOLDER mapping`);
	}
	assert.equal(underQueueRoot(root, root), true, 'the bare root path itself also matches');
	assert.equal(underQueueRoot('_crucible/orchestration/queue2/job.md', root), false, 'a sibling folder sharing the string prefix must not be swallowed');
	assert.equal(underQueueRoot('_crucible/orchestration/ignored.md', root), false, 'ignored.md is a sibling of the queue root, not under it');
});

test('STRUCTURAL: the IGNORED_IDS_NOTE route() block returns instead of falling through to the generic branches', () => {
	const blockStart = dashboardSrc.indexOf('if (path === IGNORED_IDS_NOTE) {');
	assert.ok(blockStart >= 0);
	const blockEnd = dashboardSrc.indexOf('\n\t\t\t}', blockStart);
	const block = dashboardSrc.slice(blockStart, blockEnd);
	assert.match(
		block,
		/\n\t\t\t\treturn;\s*$/,
		'the block must return before falling through to the folder-prefix / structural / meta branches below — otherwise the create case (vault.create of ignored.md, no echo check at all downstream) and the modify case (falls into the !prev first-sighting branch) both leak a second render',
	);
});

test('STRUCTURAL: the meta-branch signature checks require an established baseline (prev) before scheduling a scan refresh', () => {
	assert.match(dashboardSrc, /if \(prev && prev\.fm !== next\.fm\) \{/, 'a first sighting (no prev) must not fire the fm-driven scan refreshes');
	assert.match(dashboardSrc, /if \(prev && prev\.links !== next\.links\) \{/, 'a first sighting (no prev) must not fire the orphans scan refresh');
	assert.equal(dashboardSrc.includes('if (!prev || prev.fm !== next.fm)'), false, 'the old always-fire-on-first-sighting form must be gone');
	assert.equal(dashboardSrc.includes('if (!prev || prev.links !== next.links)'), false, 'the old always-fire-on-first-sighting form must be gone');
});

test('BEHAVIORAL: first-sighting establishes a baseline without firing; a real change on a known path still fires', () => {
	// Mirrors the corrected meta-branch shape: compute next, read prev, store next,
	// then gate on `prev && prev.x !== next.x` (not `!prev || ...`).
	const relevantSignatures = new Map();
	const fired = [];
	function routeMeta(path, fmSig) {
		const next = { fm: fmSig, links: '' };
		const prev = relevantSignatures.get(path);
		relevantSignatures.set(path, next);
		if (prev && prev.fm !== next.fm) fired.push(path);
	}
	routeMeta('a.md', 'sig-1');
	assert.deepEqual(fired, [], 'the very first metadataCache event for a previously-unseen path must not schedule a scan refresh');
	routeMeta('a.md', 'sig-1');
	assert.deepEqual(fired, [], 'an unchanged signature on a known path still does not fire');
	routeMeta('a.md', 'sig-2');
	assert.deepEqual(fired, ['a.md'], 'a real frontmatter change on an already-baselined path still fires');
	routeMeta('b.md', 'sig-1');
	assert.deepEqual(fired, ['a.md'], 'a different previously-unseen path (b.md) also just baselines, not fires');
});

test('BEHAVIORAL: the ignored-ids route pattern never reaches the structural/meta branches on either the create or modify write', () => {
	// Mirrors route()'s actual shape (IGNORED_IDS_NOTE handled-and-return, ahead of
	// the `reason === 'structural'` branch and the meta first-sighting check) —
	// proves the create case (Path 2c: the very first Ignore ever creates
	// ignored.md via vault.create, reason 'structural') and the modify case (every
	// later Ignore, reason 'meta') both terminate in the echo branch alone.
	const IGNORED_IDS_NOTE = '_crucible/orchestration/ignored.md';
	const calls = { echoBranch: 0, structural: 0, meta: 0 };
	function route(path, reason) {
		if (path === IGNORED_IDS_NOTE) { calls.echoBranch++; return; }
		if (reason === 'structural') { calls.structural++; return; }
		calls.meta++;
	}
	route(IGNORED_IDS_NOTE, 'structural'); // first-ever Ignore: vault.create
	route(IGNORED_IDS_NOTE, 'meta'); // a later Ignore: vault.modify
	assert.deepEqual(calls, { echoBranch: 2, structural: 0, meta: 0 }, 'ignored.md must never reach the unconditional structural branch or the first-sighting meta branch, on create or modify');
});

test('STRUCTURAL: uncapturedVideos / uncapturedPosts / controlCenters sections compute their rows before touching the DOM', () => {
	const uvSrc = readFileSync('src/ingestion/sections/uncapturedVideos.ts', 'utf8');
	const uvFnStart = uvSrc.indexOf('async function render(body: HTMLElement, ctx: SectionContext): Promise<void> {');
	assert.ok(uvFnStart >= 0, 'uncapturedVideos.ts render() not found');
	const uvAwaitIdx = uvSrc.indexOf('await computeUncapturedVideoRows', uvFnStart);
	assert.ok(uvAwaitIdx > uvFnStart, 'the computeUncapturedVideoRows await not found');
	assert.ok(!uvSrc.slice(uvFnStart, uvAwaitIdx).includes('body.empty()'), 'uncapturedVideos.ts must not empty the body before awaiting the scan — that is the flash bug');

	const upSrc = readFileSync('src/ingestion/sections/uncapturedPosts.ts', 'utf8');
	const upFnStart = upSrc.indexOf('export async function renderUncapturedPosts(');
	assert.ok(upFnStart >= 0, 'renderUncapturedPosts not found');
	const upAwaitIdx = upSrc.indexOf('await computeUncapturedPostRows', upFnStart);
	assert.ok(upAwaitIdx > upFnStart, 'the computeUncapturedPostRows await not found');
	assert.ok(!upSrc.slice(upFnStart, upAwaitIdx).includes('body.empty()'), 'uncapturedPosts.ts must not empty the body before awaiting the scan');

	const ccSrc = readFileSync('src/ingestion/sections/controlCenters.ts', 'utf8');
	const ccCases = [
		['async function renderBlogControl(body: HTMLElement, ctx: SectionContext): Promise<void> {', 'await computeBlogControlRows'],
		['async function renderChannelControl(body: HTMLElement, ctx: SectionContext): Promise<void> {', 'await computeChannelControlRows'],
	];
	for (const [fnStartNeedle, awaitNeedle] of ccCases) {
		const fnStart = ccSrc.indexOf(fnStartNeedle);
		assert.ok(fnStart >= 0, `${fnStartNeedle} not found`);
		const awaitIdx = ccSrc.indexOf(awaitNeedle, fnStart);
		assert.ok(awaitIdx > fnStart, `${awaitNeedle} await not found`);
		assert.ok(!ccSrc.slice(fnStart, awaitIdx).includes('body.empty()'), `${fnStartNeedle} must not empty the body before awaiting the scan`);
	}
});

test('STRUCTURAL: setIntakeButtonState caches the last-rendered state per button and early-returns when unchanged', () => {
	const intakeSrc = readFileSync('src/ingestion/sections/intake.ts', 'utf8');
	assert.match(
		intakeSrc,
		/const lastButtonState = new WeakMap<HTMLButtonElement, 'idle' \| 'queued' \| 'running'>\(\);/,
		'intake.ts must track the last-rendered state per button element',
	);
	const fnStart = intakeSrc.indexOf("function setIntakeButtonState(btn: HTMLButtonElement, state: 'idle' | 'queued' | 'running'): void {");
	assert.ok(fnStart >= 0, 'setIntakeButtonState not found');
	const fnEnd = intakeSrc.indexOf('\n\t}', fnStart);
	const fnBody = intakeSrc.slice(fnStart, fnEnd);
	const guardIdx = fnBody.indexOf('if (lastButtonState.get(btn) === state) return;');
	const emptyIdx = fnBody.indexOf('btn.empty();');
	assert.ok(guardIdx >= 0, 'setIntakeButtonState must early-return when the state has not changed');
	assert.ok(emptyIdx >= 0 && guardIdx < emptyIdx, 'the unchanged-state guard must run before btn.empty() — otherwise the DOM still rebuilds every call');
});

test('BEHAVIORAL: the button-state cache pattern skips the rebuild when state is unchanged and rebuilds on a real change', () => {
	// Mirrors setIntakeButtonState's shape: a WeakMap<button, state> gate ahead of the rebuild.
	const lastButtonState = new WeakMap();
	let rebuilds = 0;
	function setIntakeButtonState(btn, state) {
		if (lastButtonState.get(btn) === state) return;
		lastButtonState.set(btn, state);
		rebuilds++;
	}
	const btn = {};
	setIntakeButtonState(btn, 'idle');
	assert.equal(rebuilds, 1, 'first call always rebuilds');
	setIntakeButtonState(btn, 'idle');
	setIntakeButtonState(btn, 'idle');
	assert.equal(rebuilds, 1, 'repeated same-state queue ticks (~1x/sec) must not rebuild');
	setIntakeButtonState(btn, 'queued');
	assert.equal(rebuilds, 2, 'an actual state change still rebuilds');
	setIntakeButtonState(btn, 'queued');
	assert.equal(rebuilds, 2, 'still no rebuild once settled on the new state');
	setIntakeButtonState(btn, 'running');
	assert.equal(rebuilds, 3);
});

/* ---------------------------------------------- WP-VF-2c: STRUCTURAL "Repair all" wiring */
//
// missingAttachments.ts follows the Orphaned Attachments shape (createXSection factory
// returning {render, renderXAllButton}, a row cache populated by render() and read by the
// heading button) — same reasons as the rest of this file's STRUCTURAL block: it pulls in
// the real 'obsidian' Notice plus render/section.ts + render/cells.ts, disproportionate to
// stand up just for this wiring check. The aggregation ALGORITHM itself (dedupe by note,
// per-note failure tolerance, totals) is covered BEHAVIORALLY below via a lifted-shape
// reimplementation driven with fake repairNote outcomes.

const missingAttachmentsSrc = readFileSync('src/ingestion/sections/missingAttachments.ts', 'utf8');

test('STRUCTURAL: renderRepairAllButton repairs once per DISTINCT note (not once per row), silently, tolerating a per-note failure', () => {
	const fnStart = missingAttachmentsSrc.indexOf('function renderRepairAllButton(heading: HTMLElement): void {');
	assert.ok(fnStart >= 0, 'renderRepairAllButton not found');
	const fnEnd = missingAttachmentsSrc.indexOf('\n\t}\n', fnStart);
	const body = missingAttachmentsSrc.slice(fnStart, fnEnd);

	assert.ok(body.includes('r.repairable'), 'must filter to only repairable rows before doing any work');
	assert.match(body, /new Map\(rows\.map\(r => \[r\.note\.path, r\.note\]\)\)/, 'must dedupe rows down to one entry per distinct note.path — repairNote already repairs every broken ref in a note, so calling it once per ROW would redundantly re-run the same note-wide pass');
	assert.match(body, /repairNote\(note, true\)/, 'the bulk sweep must call repairNote with silent=true — a per-note Notice for every one of dozens of notes would spam');
	assert.match(body, /try \{[\s\S]*?repairNote\(note, true\)[\s\S]*?\} catch \(e\) \{[\s\S]*?logWarn\(/, 'a throw from one note\'s repairNote must be caught (not propagate) so the sweep continues to the remaining notes');
	assert.ok(body.includes("host.refresh('missingAttachments')"), 'must refresh the section after the sweep so repaired rows drop out of the table');
});

test('STRUCTURAL: createMissingAttachmentsSection is wired into ingestionDashboard.ts the same way createOrphanedAttachmentsSection is', () => {
	assert.match(
		dashboardSrc,
		/this\.missingAttachments = createMissingAttachmentsSection\(this\.host\);/,
		'the missingAttachments field must be built via the factory, mirroring orphanedAttachments',
	);
	assert.match(
		dashboardSrc,
		/\(heading\) => this\.missingAttachments\.renderRepairAllButton\(heading\)/,
		'the missingAttachments buildSection() call must wire the Repair-all heading button, mirroring Cleanup all',
	);
	assert.match(
		dashboardSrc,
		/case 'missingAttachments': return this\.missingAttachments\.render\(body, ctx\);/,
		'the renderSection switch must delegate to the section object\'s render(), not a bare function import',
	);
});

test('BEHAVIORAL: the Repair-all aggregation (lifted shape) dedupes by note, sums outcomes, and tolerates a per-note failure', async () => {
	// Mirrors renderRepairAllButton's actual shape: filter repairable -> dedupe to distinct
	// notes -> repairNote(note, true) per note inside try/catch -> aggregate.
	async function repairAll(rows, repairNote) {
		const repairableRows = rows.filter(r => r.repairable);
		const notes = Array.from(new Map(repairableRows.map(r => [r.note.path, r.note])).values());
		let totalRepaired = 0;
		let totalUnrepairable = 0;
		let failedNotes = 0;
		const calledFor = [];
		for (const note of notes) {
			calledFor.push(note.path);
			try {
				const result = await repairNote(note, true);
				if (!result) { failedNotes++; continue; }
				totalRepaired += result.repaired;
				totalUnrepairable += result.unrepairable;
			} catch {
				failedNotes++;
			}
		}
		return { totalRepaired, totalUnrepairable, failedNotes, notesTouched: notes.length, calledFor };
	}

	const noteA = { path: 'a.md' };
	const noteB = { path: 'b.md' };
	const noteC = { path: 'c.md' };
	const rows = [
		{ note: noteA, link: 'x_MD5.png', repairable: true },
		{ note: noteA, link: 'y_MD5.png', repairable: true }, // second broken ref, SAME note as row 1
		{ note: noteB, link: 'z_MD5.png', repairable: true },
		{ note: noteC, link: 'w_MD5.png', repairable: false }, // not repairable -> excluded entirely
	];

	const outcomes = {
		'a.md': { repaired: 2, unrepairable: 0 },
		'b.md': null, // simulates repairNote returning null (internal failure)
	};
	const repairNote = async (note) => {
		if (note.path === 'b.md') return outcomes['b.md'];
		return outcomes[note.path];
	};

	const result = await repairAll(rows, repairNote);
	assert.deepEqual(result.calledFor, ['a.md', 'b.md'], 'exactly one call per distinct repairable note — note A is called ONCE despite carrying two broken refs, and note C (unrepairable) is never called');
	assert.equal(result.notesTouched, 2);
	assert.equal(result.totalRepaired, 2);
	assert.equal(result.totalUnrepairable, 0);
	assert.equal(result.failedNotes, 1, 'note B\'s null return counts as one failed note');
});

test('BEHAVIORAL: a thrown repairNote does not abort the sweep — the remaining notes still get their turn', async () => {
	async function repairAll(rows, repairNote) {
		const notes = Array.from(new Map(rows.map(r => [r.note.path, r.note])).values());
		let totalRepaired = 0;
		let failedNotes = 0;
		const calledFor = [];
		for (const note of notes) {
			calledFor.push(note.path);
			try {
				const result = await repairNote(note);
				totalRepaired += result.repaired;
			} catch {
				failedNotes++;
			}
		}
		return { totalRepaired, failedNotes, calledFor };
	}

	const rows = [
		{ note: { path: 'a.md' } },
		{ note: { path: 'b.md' } },
		{ note: { path: 'c.md' } },
	];
	const repairNote = async (note) => {
		if (note.path === 'b.md') throw new Error('boom');
		return { repaired: 1, unrepairable: 0 };
	};

	const result = await repairAll(rows, repairNote);
	assert.deepEqual(result.calledFor, ['a.md', 'b.md', 'c.md'], 'note C must still be attempted after note B throws');
	assert.equal(result.totalRepaired, 2, 'the two notes that succeeded (a, c) both still contributed');
	assert.equal(result.failedNotes, 1);
});
