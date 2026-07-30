import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Covers rsp-wp6's keyed row reconciler: renderSortableTable's `rowKey` option
// (src/ingestion/render/sortableTable.ts) and its threading through
// renderTableSection (src/ingestion/render/section.ts). Both modules import
// nothing from 'obsidian' — sortableTable.ts only calls the Obsidian
// DOM-extension methods (createDiv/createEl/empty/addClass/...) Obsidian
// installs onto real HTMLElement.prototype at runtime, plus a handful of
// PLAIN DOM Node/Element members (firstChild, nextSibling, insertBefore,
// remove, contains, querySelectorAll, ownerDocument.activeElement) that this
// file's stub — a superset of ingestionTableCapAndGating.test.mjs's FakeEl —
// implements to the extent the reconciler actually touches. Same bundle-
// straight-for-Node treatment as that file and ingestionRefreshGates.test.mjs.

const outdir = path.join(tmpdir(), 'obsidian-crucible-ingestion-keyed-reconciler-tests');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

async function bundle(entry, name) {
	const outfile = path.join(outdir, name);
	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'es2020',
		outfile,
		logLevel: 'silent',
	});
	return import(pathToFileURL(outfile).href);
}

const { renderSortableTable } = await bundle('src/ingestion/render/sortableTable.ts', 'sortableTable.mjs');
const { renderTableSection } = await bundle('src/ingestion/render/section.ts', 'section.mjs');

/* ------------------------------------------------------------------- element stub */

// Extends ingestionTableCapAndGating.test.mjs's FakeEl with the plain-DOM
// Node/Element surface the reconciler needs: firstChild/nextSibling (cursor-
// based row reordering), insertBefore (moving an existing node — the DOM spec
// guarantee that it detaches from its current parent first is what makes the
// reorder algorithm correct), remove() (departed-row cleanup), contains() and
// ownerDocument.activeElement (keyed focus capture/restore), and a
// multi-tag querySelectorAll (focus-candidate lookup: 'button, a, input, ...').
class FakeEl {
	constructor(tag = 'div') {
		this.tagName = tag.toUpperCase();
		this.className = '';
		this.textContent = '';
		this.children = [];
		this.parentElement = null;
		this.ownerDocument = null;
		this._listeners = {};
	}
	get firstChild() {
		return this.children[0] ?? null;
	}
	get nextSibling() {
		if (!this.parentElement) return null;
		const idx = this.parentElement.children.indexOf(this);
		return this.parentElement.children[idx + 1] ?? null;
	}
	createDiv(opts) { return this.createEl('div', opts); }
	createSpan(opts) { return this.createEl('span', opts); }
	createEl(tag, opts = {}) {
		const el = new FakeEl(tag);
		el.ownerDocument = this.ownerDocument;
		if (opts.cls) el.className = opts.cls;
		if (opts.text != null) el.textContent = opts.text;
		el.parentElement = this;
		this.children.push(el);
		return el;
	}
	empty() {
		for (const c of this.children) c.parentElement = null;
		this.children = [];
		this.textContent = '';
	}
	remove() {
		if (!this.parentElement) return;
		const siblings = this.parentElement.children;
		const idx = siblings.indexOf(this);
		if (idx >= 0) siblings.splice(idx, 1);
		this.parentElement = null;
	}
	// Mirrors real DOM insertBefore: inserting a node that's already somewhere
	// else in the tree MOVES it (detach-then-insert), which is exactly what
	// the reconciler's reorder loop relies on for rows beyond the first move.
	insertBefore(newNode, referenceNode) {
		if (newNode.parentElement) {
			const oldSiblings = newNode.parentElement.children;
			const idx = oldSiblings.indexOf(newNode);
			if (idx >= 0) oldSiblings.splice(idx, 1);
		}
		newNode.parentElement = this;
		newNode.ownerDocument = this.ownerDocument;
		if (referenceNode == null) {
			this.children.push(newNode);
		} else {
			const idx = this.children.indexOf(referenceNode);
			if (idx < 0) this.children.push(newNode);
			else this.children.splice(idx, 0, newNode);
		}
		return newNode;
	}
	addClass(c) { this.className = this.className ? `${this.className} ${c}` : c; }
	appendText(t) { this.textContent += t; }
	setText(t) {
		this.textContent = t;
		for (const c of this.children) c.parentElement = null;
		this.children = [];
	}
	addEventListener(evt, fn) {
		(this._listeners[evt] ??= []).push(fn);
	}
	click() {
		for (const fn of this._listeners.click ?? []) fn({ target: this });
	}
	focus() {
		if (this.ownerDocument) this.ownerDocument.activeElement = this;
	}
	contains(other) {
		let n = other;
		while (n) {
			if (n === this) return true;
			n = n.parentElement;
		}
		return false;
	}
	querySelectorAll(selector) {
		const wanted = new Set(String(selector).split(',').map(s => s.trim().toUpperCase()));
		const out = [];
		const walk = (node) => {
			for (const c of node.children) {
				if (wanted.has(c.tagName)) out.push(c);
				walk(c);
			}
		};
		walk(this);
		return out;
	}
}

function makeDoc() {
	return { activeElement: null, body: {} };
}

function makeRoot(doc) {
	const el = new FakeEl('div');
	el.ownerDocument = doc;
	return el;
}

function idColumn() {
	return { key: 'id', label: 'ID', render: (r, td) => td.setText(String(r.id)) };
}

function tableOf(parent) {
	return parent.children.find(c => c.tagName === 'TABLE');
}
function tbodyOf(parent) {
	return tableOf(parent).children.find(c => c.tagName === 'TBODY');
}
function rowsOf(parent) {
	return tbodyOf(parent).children;
}
function rowById(parent, id) {
	return rowsOf(parent).find(tr => tr.children[0].textContent === String(id));
}

/* --------------------------------------------------------------- reuse / identity */

test('keyed reconciler: re-rendering the same keys reuses the same <tr> element identities', () => {
	const doc = makeDoc();
	const parent = makeRoot(doc);
	const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
	const columns = [idColumn()];
	const ctx = { sort: null, refresh: () => {} };

	renderSortableTable(parent, columns, rows, ctx, { rowKey: r => r.id });
	const table1 = tableOf(parent);
	const trA1 = rowById(parent, 'a');
	const trB1 = rowById(parent, 'b');
	const trC1 = rowById(parent, 'c');

	renderSortableTable(parent, columns, rows, ctx, { rowKey: r => r.id });
	const table2 = tableOf(parent);

	assert.strictEqual(table2, table1, 'the <table>/<tbody> itself is reused, not torn down, across keyed renders');
	assert.strictEqual(rowById(parent, 'a'), trA1, 'row a is the same <tr> object across renders');
	assert.strictEqual(rowById(parent, 'b'), trB1, 'row b is the same <tr> object across renders');
	assert.strictEqual(rowById(parent, 'c'), trC1, 'row c is the same <tr> object across renders');
});

/* ---------------------------------------------------------- removal / addition */

test('keyed reconciler: departed keys are removed, new keys are created, untouched keys keep their identity', () => {
	const doc = makeDoc();
	const parent = makeRoot(doc);
	const columns = [idColumn()];
	const ctx = { sort: null, refresh: () => {} };

	renderSortableTable(parent, columns, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], ctx, { rowKey: r => r.id });
	const trB1 = rowById(parent, 'b');
	const trC1 = rowById(parent, 'c');

	// 'a' departs, 'd' arrives, 'b' and 'c' are untouched.
	renderSortableTable(parent, columns, [{ id: 'b' }, { id: 'c' }, { id: 'd' }], ctx, { rowKey: r => r.id });

	assert.equal(rowById(parent, 'a'), undefined, 'departed row a is removed from the DOM');
	assert.ok(rowById(parent, 'd'), 'new row d is created');
	assert.strictEqual(rowById(parent, 'b'), trB1, 'untouched row b keeps its <tr> identity');
	assert.strictEqual(rowById(parent, 'c'), trC1, 'untouched row c keeps its <tr> identity');
	assert.equal(rowsOf(parent).length, 3, 'exactly the three current rows remain, no leftover departed row');
});

/* --------------------------------------------------------------------------- reorder */

test('keyed reconciler: a sort flip reorders existing rows in place — same identities, new order, table not rebuilt', () => {
	const doc = makeDoc();
	const parent = makeRoot(doc);
	const rows = [{ id: 'a', n: 3 }, { id: 'b', n: 1 }, { id: 'c', n: 2 }];
	const columns = [
		idColumn(),
		{ key: 'n', label: 'N', sortable: true, sortKey: r => r.n, render: (r, td) => td.setText(String(r.n)) },
	];
	const ctx = { sort: null, refresh: () => {} };

	renderSortableTable(parent, columns, rows, ctx, { rowKey: r => r.id });
	const table1 = tableOf(parent);
	const trA = rowById(parent, 'a');
	const trB = rowById(parent, 'b');
	const trC = rowById(parent, 'c');
	assert.deepEqual(rowsOf(parent).map(tr => tr.children[0].textContent), ['a', 'b', 'c'], 'insertion order before any sort');

	// Simulate a sort-header click: sortableTable's own header handler does
	// exactly this (set ctx.sort, then re-render) — mirrored here directly
	// rather than through a synthetic click since the click handler itself is
	// exercised by the "listener non-stacking" test below.
	ctx.sort = { column: 'n', direction: 'asc' };
	renderSortableTable(parent, columns, rows, ctx, { rowKey: r => r.id });

	assert.strictEqual(tableOf(parent), table1, 'the table is reconciled in place, not rebuilt, on a sort flip');
	assert.deepEqual(rowsOf(parent).map(tr => tr.children[0].textContent), ['b', 'c', 'a'], 'row order now matches ascending n (1, 2, 3)');
	assert.strictEqual(rowById(parent, 'a'), trA, 'row a is the same <tr>, just relocated');
	assert.strictEqual(rowById(parent, 'b'), trB, 'row b is the same <tr>, just relocated');
	assert.strictEqual(rowById(parent, 'c'), trC, 'row c is the same <tr>, just relocated');
});

/* --------------------------------------------------------------------- unkeyed */

test('unkeyed table: full teardown/rebuild every render — behavior unchanged from before rsp-wp6', () => {
	const doc = makeDoc();
	const parent = makeRoot(doc);
	const rows = [{ id: 'a' }, { id: 'b' }];
	const columns = [idColumn()];
	const ctx = { sort: null, refresh: () => {} };

	renderSortableTable(parent, columns, rows, ctx, {});
	const table1 = tableOf(parent);
	const trA1 = rowById(parent, 'a');

	renderSortableTable(parent, columns, rows, ctx, {});
	const table2 = tableOf(parent);
	const trA2 = rowById(parent, 'a');

	assert.notStrictEqual(table2, table1, 'no rowKey — the whole table is a fresh element every render');
	assert.notStrictEqual(trA2, trA1, 'no rowKey — every <tr> is fresh every render, never reused');
	assert.deepEqual(rowsOf(parent).map(tr => tr.children[0].textContent), ['a', 'b'], 'row content is still correct after the rebuild');
});

/* --------------------------------------------------------------- listener non-stacking */

test('keyed reconciler: re-rendering an unchanged row does not stack click listeners on its cell', () => {
	const doc = makeDoc();
	const parent = makeRoot(doc);
	let clicks = 0;
	const columns = [
		idColumn(),
		{
			key: 'action', label: '', render: (r, td) => {
				const btn = td.createEl('button', { text: 'Go' });
				btn.addEventListener('click', () => { clicks++; });
			},
		},
	];
	const rows = [{ id: 'a' }];
	const ctx = { sort: null, refresh: () => {} };

	renderSortableTable(parent, columns, rows, ctx, { rowKey: r => r.id });
	renderSortableTable(parent, columns, rows, ctx, { rowKey: r => r.id });
	renderSortableTable(parent, columns, rows, ctx, { rowKey: r => r.id });

	const tr = rowById(parent, 'a');
	const btn = tr.children[1].children[0];
	assert.equal(tr.children[1].children.length, 1, 'the action cell holds exactly one button, not one per render');
	btn.click();
	assert.equal(clicks, 1, 'exactly one click handler fires — the cell was emptied before each repaint, so no prior listener survives to also fire');
});

test('keyed reconciler: the sort-header click handler is not duplicated across renders (header is rebuilt fresh every render, keyed or not)', () => {
	const doc = makeDoc();
	const parent = makeRoot(doc);
	const rows = [{ id: 'a', n: 1 }];
	const columns = [
		idColumn(),
		{ key: 'n', label: 'N', sortable: true, sortKey: r => r.n, render: (r, td) => td.setText(String(r.n)) },
	];
	let refreshes = 0;
	const ctx = { sort: null, refresh: () => { refreshes++; } };

	renderSortableTable(parent, columns, rows, ctx, { rowKey: r => r.id });
	renderSortableTable(parent, columns, rows, ctx, { rowKey: r => r.id });

	const thead = tableOf(parent).children.find(c => c.tagName === 'THEAD');
	const nHeader = thead.children[0].children[1]; // <tr> -> [th ID, th N]
	nHeader.click();
	assert.equal(refreshes, 1, 'one click on the header fires ctx.refresh() exactly once, even after multiple renders rebuilt the header');
});

/* -------------------------------------------------------------------- duplicate keys */

test('keyed reconciler: a duplicate rowKey logs a warning and falls back to a full rebuild instead of half-reconciling', async () => {
	const doc = makeDoc();
	const parent = makeRoot(doc);
	const rows = [{ id: 'a' }, { id: 'a' }, { id: 'b' }];
	const columns = [idColumn()];
	const ctx = { sort: null, refresh: () => {} };

	const originalWarn = console.warn;
	const warnCalls = [];
	console.warn = (...args) => { warnCalls.push(args); };
	globalThis.__CRUCIBLE_DEBUG__ = true;
	try {
		renderSortableTable(parent, columns, rows, ctx, { rowKey: r => r.id });
	} finally {
		console.warn = originalWarn;
		delete globalThis.__CRUCIBLE_DEBUG__;
	}

	assert.ok(warnCalls.length >= 1, 'a duplicate key must log via logWarn');
	assert.ok(warnCalls.some(args => args.some(a => String(a).toLowerCase().includes('duplicate'))), 'the warning identifies the duplicate-key condition');
	assert.equal(rowsOf(parent).length, 3, 'the fallback still renders every row (a full rebuild, not a partial/broken table)');

	// A subsequent render with the duplicates resolved recovers the keyed path
	// cleanly rather than staying wedged in fallback mode.
	renderSortableTable(parent, columns, [{ id: 'a' }, { id: 'b' }], ctx, { rowKey: r => r.id });
	assert.equal(rowsOf(parent).length, 2, 'a later render with unique keys reconciles normally');
});

/* ----------------------------------------------------------------------- focus restore */

test('keyed reconciler: focus is restored by row key + cell position, not left on a stale element or lost', () => {
	const doc = makeDoc();
	const parent = makeRoot(doc);
	const rows = [{ id: 'a' }, { id: 'b' }];
	const columns = [
		idColumn(),
		{
			key: 'action', label: '', render: (r, td) => {
				td.createEl('button', { text: 'Cancel' });
			},
		},
	];
	const ctx = { sort: null, refresh: () => {} };

	renderSortableTable(parent, columns, rows, ctx, { rowKey: r => r.id });
	const trB1 = rowById(parent, 'b');
	const btnB1 = trB1.children[1].children[0];
	btnB1.focus();
	assert.equal(doc.activeElement, btnB1);

	renderSortableTable(parent, columns, rows, ctx, { rowKey: r => r.id });

	const trB2 = rowById(parent, 'b');
	const btnB2 = trB2.children[1].children[0];
	assert.strictEqual(trB2, trB1, 'row b is reused (same <tr> identity) across the render');
	assert.notStrictEqual(btnB2, btnB1, 'the cell was repainted with a fresh button — idempotent-cell contract, not element preservation');
	assert.strictEqual(doc.activeElement, btnB2, 'focus followed the (row key, cell) coordinate to the freshly-painted equivalent element, not a tag/class/text/ordinal guess');
});

test('keyed reconciler: focus is not restored to the wrong row when the focused row departs', () => {
	const doc = makeDoc();
	const parent = makeRoot(doc);
	const columns = [
		idColumn(),
		{ key: 'action', label: '', render: (r, td) => { td.createEl('button', { text: 'Cancel' }); } },
	];
	const ctx = { sort: null, refresh: () => {} };

	renderSortableTable(parent, columns, [{ id: 'a' }, { id: 'b' }], ctx, { rowKey: r => r.id });
	const trA1 = rowById(parent, 'a');
	const btnA1 = trA1.children[1].children[0];
	btnA1.focus();

	// Row a departs this render. Real DOM auto-blurs `document.activeElement`
	// back to <body> the instant a focused node is removed — refresh.ts's own
	// tests simulate that same fact by hand for the same reason (see
	// ingestionRefreshGates.test.mjs's teardown mocks): this stub doesn't
	// model it, so `doc.activeElement` staying exactly `btnA1` afterward is
	// the correct signal that restoreKeyedFocus made no assignment at all
	// once its token's key (`a`) resolves to nothing in the new row map —
	// not that it "guessed safely", but that it did nothing, leaving
	// whatever the (real) browser already did as the last word. In the real
	// pipeline that's exactly what lets refresh.ts's fingerprint fallback
	// take over, per its own "don't steal it back" / activeElement===body
	// guard.
	renderSortableTable(parent, columns, [{ id: 'b' }], ctx, { rowKey: r => r.id });

	const btnB = rowById(parent, 'b').children[1].children[0];
	assert.strictEqual(doc.activeElement, btnA1, 'restoreKeyedFocus must not touch activeElement when the focused row has departed');
	assert.notStrictEqual(doc.activeElement, btnB, 'and must never spill focus onto an unrelated remaining row');
});

/* ------------------------------------------------------- renderTableSection integration */

test('renderTableSection: a keyed table persists across renders (body is not wiped every call)', () => {
	const body = new FakeEl();
	const rows = [{ id: 'x' }];
	const columns = [idColumn()];
	const ctx = { sort: null, refresh: () => {} };

	renderTableSection({ body, ctx, rows, columns, emptyText: 'none', setCount: () => {}, rowKey: r => r.id });
	const table1 = tableOf(body);
	renderTableSection({ body, ctx, rows, columns, emptyText: 'none', setCount: () => {}, rowKey: r => r.id });
	const table2 = tableOf(body);

	assert.strictEqual(table2, table1, 'the table element is reused across renderTableSection calls once rowKey is set');
});

test('renderTableSection: the row-limit caption does not stack across repeated keyed renders', () => {
	const body = new FakeEl();
	const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }));
	const columns = [idColumn()];
	const ctx = { sort: null, refresh: () => {} };

	for (let i = 0; i < 3; i++) {
		renderTableSection({ body, ctx, rows, columns, emptyText: 'none', setCount: () => {}, limit: 5, rowKey: r => r.id });
	}

	const captions = body.children.filter(c => c.className === 'crucible-ingestion-table-caption');
	assert.equal(captions.length, 1, 'exactly one caption survives three renders, not one per render');
	assert.equal(captions[0].textContent, 'showing 5 of 10');
});

test('renderTableSection: a keyed table transitioning to zero rows then back reconciles cleanly (self-heals the reconciler cache)', () => {
	const body = new FakeEl();
	const columns = [idColumn()];
	const ctx = { sort: null, refresh: () => {} };

	renderTableSection({ body, ctx, rows: [{ id: 'a' }], columns, emptyText: 'Empty.', setCount: () => {}, rowKey: r => r.id });
	assert.ok(tableOf(body), 'table renders with rows present');

	renderTableSection({ body, ctx, rows: [], columns, emptyText: 'Empty.', setCount: () => {}, rowKey: r => r.id });
	assert.equal(tableOf(body), undefined, 'the empty-state branch clears the table entirely');
	assert.equal(body.children.find(c => c.className === 'crucible-empty-state')?.textContent, 'Empty.');

	renderTableSection({ body, ctx, rows: [{ id: 'a' }, { id: 'b' }], columns, emptyText: 'Empty.', setCount: () => {}, rowKey: r => r.id });
	assert.ok(tableOf(body), 'the table rebuilds cleanly once rows reappear, even though the reconciler\'s cached table reference went stale');
	assert.equal(rowsOf(body).length, 2);
});
