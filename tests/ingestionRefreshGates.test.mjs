import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Covers idh-WP-3's new flicker-gate pattern (src/ingestion/render/refresh.ts):
// minIntervalGate (the queueMonitor cadence gate) and the scroll/focus capture-restore
// contract of refreshWithScrollPreserved. The module imports nothing from 'obsidian',
// so this just bundles it straight for Node — no stub plugin needed, same as
// queueMonitorCreatedSort.test.mjs's treatment of format.ts.

const outdir = path.join(tmpdir(), 'obsidian-crucible-ingestion-refresh-gates-tests');
const outfile = path.join(outdir, 'refresh.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/ingestion/render/refresh.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const { minIntervalGate, refreshWithScrollPreserved } = await import(pathToFileURL(outfile).href);

// Covers WP-6's echo-suppression primitive (src/ingestion/render/echoSuppress.ts):
// the one-shot, self-expiring marker that coalesces the "Ignore flashes and
// re-renders twice" bug — a button handler's own immediate refresh plus the
// vault-event-driven refresh the underlying write fires a moment later. Also
// dependency-free, so it gets the same standalone-bundle treatment as refresh.ts.
const echoOutfile = path.join(outdir, 'echoSuppress.mjs');
await esbuild.build({
	entryPoints: ['src/ingestion/render/echoSuppress.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile: echoOutfile,
	logLevel: 'silent',
});
const { markSelfRefreshedForEcho, consumeSelfRefreshedEcho } = await import(pathToFileURL(echoOutfile).href);

// --- minIntervalGate ---

test('minIntervalGate: first call after a quiet period fires immediately', () => {
	const calls = [];
	const gate = minIntervalGate(() => calls.push('run'), 1000);
	gate();
	assert.deepEqual(calls, ['run']);
});

test('minIntervalGate: calls inside the window collapse to one trailing invocation', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
	const calls = [];
	const gate = minIntervalGate(() => calls.push(Date.now()), 1000);

	gate(); // t=0, fires immediately (quiet-period start)
	assert.deepEqual(calls, [0]);

	t.mock.timers.tick(100);
	gate(); // t=100, inside window — scheduled trailing call at t=1000
	t.mock.timers.tick(200);
	gate(); // t=300, still inside window — same trailing call, not a second one
	t.mock.timers.tick(200);
	gate(); // t=500, still inside window
	assert.deepEqual(calls, [0], 'no extra calls fire while still inside the window');

	t.mock.timers.tick(500); // advance to t=1000, the trailing call's deadline
	assert.deepEqual(calls, [0, 1000], 'exactly one trailing call fires, carrying the final burst state');
});

test('minIntervalGate: the final burst state always renders, not a stale intermediate one', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
	let state = 'initial';
	const rendered = [];
	const gate = minIntervalGate(() => rendered.push(state), 1000);

	gate(); // fires immediately with state = 'initial'
	state = 'mid-burst-1';
	gate();
	state = 'mid-burst-2';
	gate();
	state = 'final';
	gate();

	t.mock.timers.tick(1000);
	assert.deepEqual(rendered, ['initial', 'final'], 'the gate reads state at run time, so the trailing call sees final, not a stale mid-burst snapshot');
});

test('minIntervalGate: a call after a full quiet period following a burst fires immediately again', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
	const calls = [];
	const gate = minIntervalGate(() => calls.push(Date.now()), 1000);

	gate(); // t=0
	t.mock.timers.tick(1000); // trailing window closes with nothing pending — no extra call
	assert.deepEqual(calls, [0]);

	t.mock.timers.tick(5000); // long quiet period, now t=6000
	gate();
	assert.deepEqual(calls, [0, 6000], 'fires immediately again once the quiet period has passed');
});

// --- P6 (rsp-wp5): coordinated dirty-set flush ---
//
// ingestionDashboard.ts pulls the real 'obsidian' App/TFile surface, so per
// this file's and ingestionTableCapAndGating.test.mjs's established treatment
// its markDirty/flushDirty wiring is verified STRUCTURALLY there (source-text
// assertions against the real compiled shape: FAST_SECTIONS/SCAN_SECTIONS
// membership, markDirty's routing, flushDirty's batch-and-clear order, the
// single `eventDriven: true` call site). What's exercised here, BEHAVIORALLY,
// is the actual coalescing/cadence semantics that shape guarantees — a
// mirror of markDirty/flushDirty built on the REAL compiled minIntervalGate
// above (not a reimplementation of it), driven with fake timers.
function makeDirtyFlushHarness(fastIds, scanIds, renderLog) {
	const dirty = new Set();
	const flushDirty = (classIds) => {
		const due = Array.from(dirty).filter(id => classIds.has(id));
		if (due.length === 0) return;
		for (const id of due) dirty.delete(id);
		for (const id of due) renderLog.push(id);
	};
	const flushFast = minIntervalGate(() => flushDirty(fastIds), 150);
	const flushScan = minIntervalGate(() => flushDirty(scanIds), 1000);
	return {
		markDirty(id) {
			dirty.add(id);
			if (fastIds.has(id)) flushFast();
			else if (scanIds.has(id)) flushScan();
		},
	};
}

test('P6: a burst of N mark-dirty calls for one section produces exactly one render per flush window', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
	const renders = [];
	const { markDirty } = makeDirtyFlushHarness(new Set(['unprocessedClippings']), new Set(), renders);

	markDirty('unprocessedClippings'); // t=0: leading fire (quiet-period start)
	assert.deepEqual(renders, ['unprocessedClippings']);

	// A burst of 20 repeated dirty marks inside the 150ms window must coalesce
	// to the single already-scheduled trailing call, not one render per mark.
	for (let i = 0; i < 20; i++) { t.mock.timers.tick(5); markDirty('unprocessedClippings'); }
	assert.deepEqual(renders, ['unprocessedClippings'], 'no additional renders yet — still inside the 150ms window');
	t.mock.timers.tick(50); // window closes at t=150
	assert.deepEqual(renders, ['unprocessedClippings', 'unprocessedClippings'], 'exactly one trailing render for the whole 20-call burst');
});

test('P6: one flush renders every currently-dirty section of its class together, in one batch', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
	const renders = [];
	const fast = new Set(['unprocessedClippings', 'unrefinedTranscripts', 'blogIntake']);
	const { markDirty } = makeDirtyFlushHarness(fast, new Set(), renders);

	markDirty('unprocessedClippings'); // t=0: leading fire, alone (the others aren't dirty yet)
	assert.deepEqual(renders, ['unprocessedClippings']);
	renders.length = 0;

	t.mock.timers.tick(50); // t=50: inside the window opened by the leading fire above
	markDirty('unprocessedClippings');
	markDirty('unrefinedTranscripts');
	markDirty('blogIntake');
	assert.deepEqual(renders, [], 'nothing renders until the trailing call fires');
	t.mock.timers.tick(100); // window closes at t=150
	assert.deepEqual(
		renders.slice().sort(),
		['blogIntake', 'unprocessedClippings', 'unrefinedTranscripts'],
		'all three currently-dirty sections render together in the one trailing flush — a burst touching N sections costs one pass, not N',
	);
});

test('P6: a burst of fast-class events does not drag a scan-class section along more often than its own ~1000ms floor', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
	const renders = [];
	const fast = new Set(['unprocessedClippings']);
	const scan = new Set(['uncapturedVideos']);
	const { markDirty } = makeDirtyFlushHarness(fast, scan, renders);

	markDirty('uncapturedVideos'); // t=0: scan class's own leading fire
	const scanRenderCount = () => renders.filter(id => id === 'uncapturedVideos').length;
	assert.equal(scanRenderCount(), 1);

	// Mirrors route()'s structural branch, which marks a fast-class section AND
	// a scan-class section from the same event: sustained churn every 100ms
	// (well under the fast class's 150ms floor) for 5 simulated seconds.
	for (let i = 0; i < 50; i++) {
		t.mock.timers.tick(100);
		markDirty('unprocessedClippings');
		markDirty('uncapturedVideos');
	}
	// 5000ms elapsed since the leading fire — a 1000ms floor allows at most one
	// more render per elapsed 1000ms window (5 more, landing at t=1000..5000),
	// never one per 100ms fast-class tick (which would be 50).
	assert.ok(scanRenderCount() <= 6, `scan-class section rendered ${scanRenderCount()} times over 5000ms of continuous churn — must not exceed its ~1000ms floor (leading fire + at most 5 more)`);
	assert.ok(scanRenderCount() >= 4, `sanity: the floor must still let it render periodically rather than starve under sustained churn — got ${scanRenderCount()}`);
	const fastRenderCount = renders.filter(id => id === 'unprocessedClippings').length;
	assert.ok(
		fastRenderCount >= 3 * scanRenderCount(),
		`the fast-class section (${fastRenderCount} renders), sharing none of the scan gate's flooring, must render markedly more often than the scan-class section (${scanRenderCount()} renders) it's churning alongside`,
	);
});

// --- refreshWithScrollPreserved: scroll + focus capture/restore contract ---
//
// The real Obsidian DOM isn't available under plain Node, so this drives the actual
// compiled functions against a minimal hand-rolled element/document stub that exposes
// only what refresh.ts reads: parentElement chains, scrollTop/scrollHeight/clientHeight,
// ownerDocument.defaultView.getComputedStyle, querySelectorAll(tagName), contains(),
// activeElement, and focus(). This is the DOM-heavy path the brief calls out — the
// contract under test is capture-before/restore-after, not any real browser layout.

class FakeElement {
	constructor(tag, { className = '', text = '' } = {}) {
		this.tagName = tag.toUpperCase();
		this.className = className;
		this.textContent = text;
		this.children = [];
		this.parentElement = null;
		this._scrollTop = 0;
		this.scrollHeight = 0;
		this.clientHeight = 0;
		this.style = { overflowY: 'visible' };
		this.ownerDocument = null;
		// A-1: plain settable fields — real offsetTop/isConnected are
		// browser-computed (layout pass / document-attachment walk), but this
		// harness has no layout engine, so tests position/detach elements
		// directly the same way they already drive scrollHeight/clientHeight.
		this.offsetTop = 0;
		this.isConnected = true;
		this._listeners = {};
	}
	// Mirrors real DOM behavior: a scroller can't scroll past its own content, so
	// an out-of-range assignment silently clamps to [0, scrollHeight - clientHeight].
	// This is exactly the mechanism the WP-4 scroll coordinator exists to work
	// around — a sibling section transiently shrinking scrollHeight mid-rebuild
	// clamps both a capture (reads an already-clamped value) and a restore (the
	// assignment itself gets clamped back down) — so without this getter/setter
	// the clamp bug class is untestable: a plain assignable field lets a test
	// "restore" a scrollTop the real DOM would have refused.
	get scrollTop() {
		return this._scrollTop;
	}
	set scrollTop(value) {
		const max = Math.max(0, this.scrollHeight - this.clientHeight);
		const next = Math.max(0, Math.min(value, max));
		// A-3: mirrors real DOM firing 'scroll' only on an actual position change
		// — a redundant re-assignment of the same clamped value (the readback
		// re-assert path exercises this) must not spuriously fire the listener.
		const changed = next !== this._scrollTop;
		this._scrollTop = next;
		if (changed) this._dispatch('scroll');
	}
	append(child) {
		child.parentElement = this;
		child.ownerDocument = this.ownerDocument;
		this.children.push(child);
		return child;
	}
	contains(other) {
		let n = other;
		while (n) {
			if (n === this) return true;
			n = n.parentElement;
		}
		return false;
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
	focus() {
		if (this.ownerDocument) this.ownerDocument.activeElement = this;
	}
	addEventListener(type, cb) {
		(this._listeners[type] ??= []).push(cb);
	}
	removeEventListener(type, cb) {
		if (!this._listeners[type]) return;
		this._listeners[type] = this._listeners[type].filter(l => l !== cb);
	}
	_dispatch(type) {
		for (const cb of this._listeners[type] ?? []) cb();
	}
}

function makeDocument() {
	const doc = { activeElement: null, body: {} };
	doc.defaultView = { getComputedStyle: (node) => node.style };
	return doc;
}

function withRaf(fn) {
	const prev = globalThis.requestAnimationFrame;
	const queue = [];
	globalThis.requestAnimationFrame = (cb) => queue.push(cb);
	const flush = () => { while (queue.length) queue.shift()(); };
	// Pops and runs exactly one queued callback (rather than draining
	// everything), so a test can inject a mutation between two animation
	// frames — needed below to exercise the double-rAF restore's readback
	// re-assert, which only does anything if the world changes between frames.
	const step = () => { if (queue.length) queue.shift()(); };
	return fn(flush, step).finally(() => { globalThis.requestAnimationFrame = prev; });
}

test('refreshWithScrollPreserved restores the scrolling ancestor scrollTop a full teardown/rebuild reset', async () => {
	await withRaf(async (flush) => {
		const doc = makeDocument();
		const scroller = new FakeElement('div');
		scroller.ownerDocument = doc;
		scroller.style.overflowY = 'auto';
		scroller.scrollHeight = 2000;
		scroller.clientHeight = 500;
		scroller.scrollTop = 340; // where the user had scrolled to

		const region = scroller.append(new FakeElement('div'));

		await refreshWithScrollPreserved(region, () => {
			// Simulate the real teardown/rebuild: the region's contents are replaced and,
			// as a side effect of the DOM churn, the scroller's own scrollTop resets to 0
			// (this is exactly what body.empty() + rebuild does in the browser).
			region.children.length = 0;
			scroller.scrollTop = 0;
		});

		assert.equal(scroller.scrollTop, 0, 'scrollTop is not restored until the rAF callback runs');
		flush();
		assert.equal(scroller.scrollTop, 340, 'scrollTop is restored to its pre-rebuild value after rAF');
	});
});

test('refreshWithScrollPreserved re-focuses an equivalent element after rebuild when focus was inside the region', async () => {
	await withRaf(async (flush) => {
		const doc = makeDocument();
		const region = new FakeElement('div');
		region.ownerDocument = doc;
		const button = region.append(new FakeElement('button', { className: 'is-sortable', text: 'Created' }));
		doc.activeElement = button;

		await refreshWithScrollPreserved(region, () => {
			// Teardown/rebuild: the old button is gone, a fresh-but-equivalent one takes
			// its place, and the browser blurs focus back to <body> in between.
			region.children.length = 0;
			doc.activeElement = doc.body;
			region.append(new FakeElement('button', { className: 'is-sortable', text: 'Created' }));
		});
		flush();

		assert.equal(doc.activeElement, region.children[0], 'the equivalent post-rebuild element is refocused');
	});
});

test('refreshWithScrollPreserved does not steal focus if something else claimed it during the render', async () => {
	await withRaf(async (flush) => {
		const doc = makeDocument();
		const region = new FakeElement('div');
		region.ownerDocument = doc;
		const button = region.append(new FakeElement('button', { className: 'is-sortable', text: 'Created' }));
		doc.activeElement = button;

		const elsewhere = new FakeElement('input');
		elsewhere.ownerDocument = doc;

		await refreshWithScrollPreserved(region, () => {
			region.children.length = 0;
			region.append(new FakeElement('button', { className: 'is-sortable', text: 'Created' }));
			doc.activeElement = elsewhere; // user clicked something else mid-render
		});
		flush();

		assert.equal(doc.activeElement, elsewhere, 'restore is a no-op once another element has focus');
	});
});

test('refreshWithScrollPreserved is a harmless no-op when focus was outside the region and nothing is scrollable', async () => {
	await withRaf(async (flush) => {
		const doc = makeDocument();
		const outsideButton = new FakeElement('button');
		outsideButton.ownerDocument = doc;
		doc.activeElement = outsideButton;

		const region = new FakeElement('div');
		region.ownerDocument = doc;

		let ran = false;
		await refreshWithScrollPreserved(region, () => { ran = true; });
		flush();

		assert.equal(ran, true);
		assert.equal(doc.activeElement, outsideButton, 'focus outside the rebuilt region is left untouched');
	});
});

// --- Dashboard-level scroll coordinator (WP-4 #3) ---
//
// All 13 ingestion-dashboard sections share ONE scroller. A per-call capture/
// restore (the pre-WP-4 shape) is wrong once more than one section refreshes
// concurrently: a sibling's teardown can transiently collapse the shared
// scroller, clamping BOTH a concurrent capture (reads the already-clamped value)
// and a concurrent restore (the assignment itself gets clamped back down). These
// tests drive two overlapping `refreshWithScrollPreserved` calls against regions
// that share one scroller and assert the coordinator captures once (before
// either render starts tearing down) and restores once (after both have
// settled), to the pre-burst value — not the collapsed intermediate one.

test('the scroll coordinator does not re-capture while a sibling refresh is still in flight', async () => {
	await withRaf(async (flush) => {
		const doc = makeDocument();
		const scroller = new FakeElement('div');
		scroller.ownerDocument = doc;
		scroller.style.overflowY = 'auto';
		scroller.scrollHeight = 2000;
		scroller.clientHeight = 500;
		scroller.scrollTop = 340; // where the user had scrolled to, before either refresh starts

		const regionA = scroller.append(new FakeElement('div'));
		const regionB = scroller.append(new FakeElement('div'));

		let releaseA;
		const aGate = new Promise(res => { releaseA = res; });

		// A starts first and, like a real teardown/rebuild, collapses the shared
		// scroller's content mid-flight before growing it back. A per-call capture
		// reading `scrollTop` during this window would see 0, not 340.
		const pA = refreshWithScrollPreserved(regionA, async () => {
			scroller.scrollHeight = 50; // collapsed: max scrollTop is now 0
			scroller.scrollTop = 999; // any assignment during this window clamps to 0
			await aGate; // hold the collapse open until B has started and captured
			scroller.scrollHeight = 2000; // rebuild finishes, back to full size
		});

		// B starts while A is still mid-collapse (count is already 1, so the
		// coordinator must NOT re-capture — a re-capture here would record 0).
		let bSawCollapsed = false;
		const pB = refreshWithScrollPreserved(regionB, () => {
			bSawCollapsed = scroller.scrollTop === 0;
		});

		assert.equal(bSawCollapsed, true, 'sanity: the scroller really is collapsed while B renders');

		releaseA();
		await Promise.all([pA, pB]);
		flush();

		assert.equal(
			scroller.scrollTop,
			340,
			'restored to the value captured before EITHER render began, not the collapsed intermediate value B observed',
		);
	});
});

test('the scroll coordinator restores exactly once after all concurrent refreshes settle, not once per call', async () => {
	await withRaf(async (flush) => {
		const doc = makeDocument();
		const scroller = new FakeElement('div');
		scroller.ownerDocument = doc;
		scroller.style.overflowY = 'auto';
		scroller.scrollHeight = 2000;
		scroller.clientHeight = 500;
		scroller.scrollTop = 200;

		const regionA = scroller.append(new FakeElement('div'));
		const regionB = scroller.append(new FakeElement('div'));

		const restores = [];
		const originalDescriptor = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'scrollTop');
		Object.defineProperty(scroller, 'scrollTop', {
			configurable: true,
			get() { return originalDescriptor.get.call(this); },
			set(v) { restores.push(v); originalDescriptor.set.call(this, v); },
		});

		await Promise.all([
			refreshWithScrollPreserved(regionA, () => { regionA.children.length = 0; }),
			refreshWithScrollPreserved(regionB, () => { regionB.children.length = 0; }),
		]);
		flush();

		// The two renders' own churn does not itself assign scrollTop here (unlike
		// the other tests), so every recorded assignment after the initial capture
		// came from the restore path. Coordinated restore-once means exactly one
		// assignment reaches the target value, not one per participating call.
		const restoresToTarget = restores.filter(v => v === 200);
		assert.equal(restoresToTarget.length, 1, 'scrollTop is assigned back to the captured value exactly once, not per concurrent call');
	});
});

test('a single refresh through the coordinator behaves exactly as the original per-call capture/restore', async () => {
	await withRaf(async (flush) => {
		const doc = makeDocument();
		const scroller = new FakeElement('div');
		scroller.ownerDocument = doc;
		scroller.style.overflowY = 'auto';
		scroller.scrollHeight = 2000;
		scroller.clientHeight = 500;
		scroller.scrollTop = 450;

		const region = scroller.append(new FakeElement('div'));

		await refreshWithScrollPreserved(region, () => {
			region.children.length = 0;
			scroller.scrollTop = 0;
		});
		assert.equal(scroller.scrollTop, 0, 'not restored yet — still behind the rAF chain');
		flush();
		assert.equal(scroller.scrollTop, 450, 'a lone refresh still restores to its captured value');
	});
});

test('the double-rAF restore re-asserts once if a still-settling sibling clamps the first attempt', async () => {
	await withRaf(async (flush, step) => {
		const doc = makeDocument();
		const scroller = new FakeElement('div');
		scroller.ownerDocument = doc;
		scroller.style.overflowY = 'auto';
		scroller.scrollHeight = 2000;
		scroller.clientHeight = 500;
		scroller.scrollTop = 340;

		const region = scroller.append(new FakeElement('div'));

		await refreshWithScrollPreserved(region, () => {
			region.children.length = 0;
			scroller.scrollTop = 0;
		});

		// Scheduling order after the awaited call above: [scroll-restore outer
		// frame, focus-restore frame] (refreshWithScrollPreserved queues the
		// scroll chain in its `finally`, then the focus rAF right after).
		step(); // outer scroll frame: schedules the inner (actual-assignment) frame
		// A sibling section is still mid-rebuild when the assignment frame runs.
		scroller.scrollHeight = 50;
		step(); // focus-restore frame (no-op: nothing was focused)
		step(); // inner frame: assigns scrollTop = 340, clamped to 0 by the collapse
		assert.equal(scroller.scrollTop, 0, 'the still-settling sibling clamped the first restore attempt');

		// The sibling finishes growing the scroller back before the readback frame.
		scroller.scrollHeight = 2000;
		step(); // readback frame: sees the mismatch and re-asserts
		assert.equal(scroller.scrollTop, 340, 'the readback re-assert recovers once the scroller is back to full size');
	});
});

// --- A-1 anchor-delta restore + A-3 user-scroll cancel (thq WP-3) ---

test('refreshWithScrollPreserved: anchor follows scrollTop when content above it grows (A-1)', async () => {
	await withRaf(async (flush) => {
		const doc = makeDocument();
		const scroller = new FakeElement('div');
		scroller.ownerDocument = doc;
		scroller.style.overflowY = 'auto';
		scroller.scrollHeight = 2000;
		scroller.clientHeight = 500;

		const region = scroller.append(new FakeElement('div'));
		const rowAbove = region.append(new FakeElement('div', { className: 'row' }));
		rowAbove.offsetTop = 100;
		const anchorRow = region.append(new FakeElement('div', { className: 'row' }));
		anchorRow.offsetTop = 260;
		const rowBelow = region.append(new FakeElement('div', { className: 'row' }));
		rowBelow.offsetTop = 500;

		scroller.scrollTop = 250; // viewport top sits between rowAbove and anchorRow — anchorRow qualifies

		await refreshWithScrollPreserved(region, () => {
			// A section above the anchor (e.g. Queue Monitor) grows by 40px,
			// pushing everything below it down. The keyed reconciler keeps the
			// same row identities — only their offsetTop moves.
			anchorRow.offsetTop += 40;
			rowBelow.offsetTop += 40;
			scroller.scrollTop = 0; // teardown/rebuild resets scrollTop like real DOM
		});

		flush();
		assert.equal(scroller.scrollTop, 290, 'restored scrollTop follows the anchor, shifting by the same delta (40) the content above it grew — not pinned to the stale absolute 250');
	});
});

test('refreshWithScrollPreserved: a detached anchor falls back to the absolute scrollTop restore (A-1)', async () => {
	await withRaf(async (flush) => {
		const doc = makeDocument();
		const scroller = new FakeElement('div');
		scroller.ownerDocument = doc;
		scroller.style.overflowY = 'auto';
		scroller.scrollHeight = 2000;
		scroller.clientHeight = 500;

		const region = scroller.append(new FakeElement('div'));
		const anchorRow = region.append(new FakeElement('div', { className: 'row' }));
		anchorRow.offsetTop = 300;

		scroller.scrollTop = 260; // anchorRow (offsetTop 300) qualifies, offset = 40

		await refreshWithScrollPreserved(region, () => {
			// Unkeyed container rebuild (blogControl/channelControl, queueMonitor's
			// body.empty() branches): the old row is gone entirely, not reconciled
			// in place.
			region.children.length = 0;
			anchorRow.parentElement = null;
			anchorRow.isConnected = false;
			scroller.scrollTop = 0;
		});

		flush();
		assert.equal(scroller.scrollTop, 260, 'absolute fallback restores the captured scrollTop once the anchor element is no longer connected/contained');
	});
});

test('refreshWithScrollPreserved: a user scroll after renders settle cancels the pending restore (A-3)', async () => {
	await withRaf(async (flush) => {
		const doc = makeDocument();
		const scroller = new FakeElement('div');
		scroller.ownerDocument = doc;
		scroller.style.overflowY = 'auto';
		scroller.scrollHeight = 2000;
		scroller.clientHeight = 500;
		scroller.scrollTop = 340;

		const region = scroller.append(new FakeElement('div'));

		await refreshWithScrollPreserved(region, () => {
			// Render-time reset (real teardown behavior) — must NOT itself be
			// mistaken for a user scroll; it happens while the coordinator is busy.
			region.children.length = 0;
			scroller.scrollTop = 0;
		});

		// Renders have settled (count back to 0) but the restore's own writes
		// haven't run yet — still behind the double rAF. A real scroll landing in
		// this window means the user actively repositioned the view.
		scroller.scrollTop = 120;

		flush();
		assert.equal(scroller.scrollTop, 120, 'the user-driven position is left alone; the coordinator does not fight it');
	});
});

test('refreshWithScrollPreserved: a scroll caused by the render itself (while busy) does not cancel the restore', async () => {
	await withRaf(async (flush) => {
		const doc = makeDocument();
		const scroller = new FakeElement('div');
		scroller.ownerDocument = doc;
		scroller.style.overflowY = 'auto';
		scroller.scrollHeight = 2000;
		scroller.clientHeight = 500;
		scroller.scrollTop = 340;

		const region = scroller.append(new FakeElement('div'));

		await refreshWithScrollPreserved(region, () => {
			// Several scrollTop-moving side effects during teardown/rebuild — all
			// of them happen while the coordinator is "busy" (a render is still in
			// flight) and must be ignored by the A-3 listener, exactly like the
			// pre-existing collapse/regrow tests already rely on.
			region.children.length = 0;
			scroller.scrollTop = 999; // clamps
			scroller.scrollTop = 0;
		});

		flush();
		assert.equal(scroller.scrollTop, 340, 'render-time scrollTop churn is not treated as a user scroll — the absolute restore still lands');
	});
});

// --- echoSuppress: markSelfRefreshedForEcho / consumeSelfRefreshedEcho (WP-6) ---

test('consumeSelfRefreshedEcho returns false when nothing was marked for that id', () => {
	assert.equal(consumeSelfRefreshedEcho('echo-unmarked'), false);
});

test('consumeSelfRefreshedEcho returns true exactly once after a mark — the one-shot contract', () => {
	markSelfRefreshedForEcho('echo-one-shot');
	assert.equal(consumeSelfRefreshedEcho('echo-one-shot'), true, 'the expected echo is consumed and suppressed');
	assert.equal(consumeSelfRefreshedEcho('echo-one-shot'), false, 'a second, unrelated event for the same id is not swallowed too');
});

test('marking one id does not suppress a different id — the exact-bug-class scope', () => {
	markSelfRefreshedForEcho('echo-own');
	assert.equal(consumeSelfRefreshedEcho('echo-companion'), false, 'a section that was not manually refreshed still schedules its debounced refresh');
	assert.equal(consumeSelfRefreshedEcho('echo-own'), true, 'the marked id is still pending and gets suppressed once');
});

test('a marker older than the suppression window is not treated as the expected echo', (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: 0 });
	markSelfRefreshedForEcho('echo-stale');
	t.mock.timers.tick(10_000); // well past the 5s window — the expected echo never arrived
	assert.equal(
		consumeSelfRefreshedEcho('echo-stale'),
		false,
		'a stale marker falls through to a normal refresh rather than silently swallowing a later unrelated change',
	);
});

test('one Ignore click yields exactly one render of the owning section and its companion — the WP-6 contract', () => {
	// Mirrors the real shape: the button handler marks both ids and renders them
	// immediately (own section via ctx.refresh(), companion via host.refresh());
	// the vault-event-driven route() dispatch arrives afterward and must render
	// neither again.
	const renders = { uncapturedVideosTest: 0, ignoredVideosTest: 0 };

	// 1) The click handler's immediate, synchronous refresh (post-write).
	markSelfRefreshedForEcho('uncapturedVideosTest');
	markSelfRefreshedForEcho('ignoredVideosTest');
	renders.uncapturedVideosTest++; // ctx.refresh()
	renders.ignoredVideosTest++; // host.refresh(companionId)

	// 2) The event-routed dispatch the underlying vault write also triggers —
	// gated exactly the way ingestionDashboard.ts's route() is: only render if
	// this is NOT the expected echo of the write we already handled above.
	if (!consumeSelfRefreshedEcho('uncapturedVideosTest')) renders.uncapturedVideosTest++;
	if (!consumeSelfRefreshedEcho('ignoredVideosTest')) renders.ignoredVideosTest++;

	assert.deepEqual(renders, { uncapturedVideosTest: 1, ignoredVideosTest: 1 }, 'each section renders exactly once per click, not twice');
});
