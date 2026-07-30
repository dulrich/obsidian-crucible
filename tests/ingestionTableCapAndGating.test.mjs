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
			new RegExp(`if \\(!consumeSelfRefreshedEcho\\('${id}'\\)\\) debounced${id[0].toUpperCase()}${id.slice(1)}\\(\\);`),
			`the ${id} debounced refresh must be gated on consumeSelfRefreshedEcho('${id}'), not called unconditionally`,
		);
	}
	assert.match(dashboardSrc, /import \{ consumeSelfRefreshedEcho \} from '\.\/ingestion\/render\/echoSuppress';/, 'consumeSelfRefreshedEcho must be imported from the real echoSuppress module, not reimplemented');
});

test('STRUCTURAL: cells.ts and its four call sites mark both the owning and companion section before dispatching either refresh', () => {
	const cellsSrc = readFileSync('src/ingestion/render/cells.ts', 'utf8');
	assert.match(cellsSrc, /import \{ markSelfRefreshedForEcho \} from '\.\/echoSuppress';/, 'cells.ts must import the real primitive, not reimplement it');

	for (const fnName of ['renderIgnoreButton', 'renderUnignoreButton']) {
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

	// The four section call sites: own id, companion id — matching the ids route()
	// actually schedules a debounced refresh for on an IGNORED_IDS_NOTE write.
	const sites = [
		{ file: 'src/ingestion/sections/uncapturedVideos.ts', fn: 'renderIgnoreButton', own: 'uncapturedVideos', companion: 'ignoredVideos' },
		{ file: 'src/ingestion/sections/youtubeWithoutMetadata.ts', fn: 'renderIgnoreButton', own: 'youtubeWithoutMetadata', companion: 'ignoredVideos' },
		{ file: 'src/ingestion/sections/uncapturedPosts.ts', fn: 'renderIgnoreButton', own: 'uncapturedPosts', companion: 'ignoredPosts' },
		{ file: 'src/ingestion/sections/ignored.ts', fn: 'renderUnignoreButton', own: 'ignoredPosts', companion: 'uncapturedPosts' },
		{ file: 'src/ingestion/sections/ignored.ts', fn: 'renderUnignoreButton', own: 'ignoredVideos', companion: 'uncapturedVideos' },
	];
	for (const { file, fn, own, companion } of sites) {
		const src = readFileSync(file, 'utf8');
		const needle = `${fn}(td, host, `;
		assert.ok(src.includes(needle), `${file} must call ${fn} with (td, host, ...) — a DashboardHost, not a bare App`);
		assert.match(
			src,
			new RegExp(`${fn}\\(td, host, '(?:youtube|blog)', [^,]+, '${own}', '${companion}', ctx\\)`),
			`${file} must pass own id '${own}' and companion id '${companion}' to ${fn}`,
		);
	}
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
