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
		this.scrollTop = 0;
		this.scrollHeight = 0;
		this.clientHeight = 0;
		this.style = { overflowY: 'visible' };
		this.ownerDocument = null;
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
	return fn(flush).finally(() => { globalThis.requestAnimationFrame = prev; });
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
