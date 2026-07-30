import { logWarn } from '../../log';
import type { Column, TableStateContext } from './types';

export type { Column, SortState } from './types';

// Renders a table whose sortable headers toggle `ctx.sort` and re-render the
// section. The rows are sorted by the active column's `sortKey`; clicking a
// header flips direction (or starts ascending on a new column).
export interface SortableTableOptions<T> {
	limit?: number;
	// rsp-wp6: when present, `renderSortableTable` reconciles rows by key
	// instead of tearing the table down every render — see the reconciler
	// section below. Must return a value that is unique and stable per row
	// across renders of the SAME `parent` (a vault path, video id, job id, ...
	// — never the row's array index, which is exactly what churns on
	// sort/insert/delete and would defeat reuse). Omit for tables with no
	// natural stable key; they keep today's full-rebuild behavior byte-for-
	// byte (see `renderFullRebuild`).
	rowKey?: (row: T) => string;
}

export function renderSortableTable<T>(
	parent: HTMLElement,
	columns: Column<T>[],
	rows: T[],
	ctx: TableStateContext,
	options: SortableTableOptions<T> = {},
): void {
	const sort = ctx.sort;
	const sorted = sort
		? [...rows].sort((a, b) => {
			const col = columns.find(c => c.key === sort.column);
			if (!col || !col.sortKey) return 0;
			const av = col.sortKey(a);
			const bv = col.sortKey(b);
			const cmp = av < bv ? -1 : av > bv ? 1 : 0;
			return sort.direction === 'asc' ? cmp : -cmp;
		})
		: rows;
	const visible = options.limit ? sorted.slice(0, options.limit) : sorted;

	const rowKey = options.rowKey;
	if (!rowKey) {
		// Unkeyed path: byte-identical to the pre-rsp-wp6 shape. Also drop any
		// stale keyed state for this `parent` — a call site's `rowKey` is static
		// per section, so this only matters for tests/future call sites that
		// toggle it, and it keeps `tableStates` from pinning a detached table.
		tableStates.delete(parent);
		renderFullRebuild(parent, columns, visible, ctx);
		return;
	}

	// Duplicate keys make the reconciler's Map<key, tr> ambiguous (a second row
	// would silently clobber the first's tracked element) — detected up front,
	// before any DOM mutation, so the fallback below is a clean full rebuild
	// rather than a half-reconciled table.
	const keys = visible.map(rowKey);
	const seen = new Set<string>();
	let duplicate: string | null = null;
	for (const k of keys) {
		if (seen.has(k)) { duplicate = k; break; }
		seen.add(k);
	}
	if (duplicate !== null) {
		logWarn('renderSortableTable: duplicate rowKey — falling back to a full rebuild for this render', duplicate);
		tableStates.delete(parent);
		renderFullRebuild(parent, columns, visible, ctx);
		return;
	}

	// Reconciler path. `state.table` might be stale if something OTHER than
	// this function cleared `parent` since the last render (e.g. queueMonitor's
	// own `body.empty()` on its zero-rows/error branches) — `parentElement`
	// having drifted off `parent` is the tell, and it's cheap to check on every
	// call rather than trust the cache blindly.
	let state = tableStates.get(parent);
	if (!state || state.table.parentElement !== parent) {
		parent.empty();
		const table = parent.createEl('table', { cls: 'crucible-ingestion-table' });
		const thead = table.createEl('thead');
		const tbody = table.createEl('tbody');
		state = { table, thead, tbody, rowMap: new Map() };
		tableStates.set(parent, state);
	}

	// Captured before any teardown below — see captureKeyedFocus's own comment
	// for why this can locate an exact (key, column) target that the
	// tag+class+text+ordinal fingerprint in refresh.ts can only guess at.
	const focusToken = captureKeyedFocus(state);

	renderHeader(state.thead, columns, ctx);

	const newMap = new Map<string, HTMLTableRowElement>();
	let cursor: ChildNode | null = state.tbody.firstChild;
	for (const row of visible) {
		const key = rowKey(row);
		let tr = state.rowMap.get(key);
		if (!tr) {
			tr = state.tbody.createEl('tr');
			for (let c = 0; c < columns.length; c++) tr.createEl('td');
		}
		// Classic keyed-list reconciliation: walk the desired order with a
		// cursor into the current DOM order. A row already sitting at the
		// cursor needs no move (just advance the cursor); anything else is
		// relocated via insertBefore, which — per the DOM spec — removes it
		// from wherever it currently lives before reinserting, so this also
		// correctly relocates a row from anywhere later in tbody, not just
		// newly-created ones appended at the end.
		if (tr === cursor) {
			cursor = cursor.nextSibling;
		} else {
			state.tbody.insertBefore(tr, cursor);
		}
		paintRow(tr, row, columns);
		newMap.set(key, tr);
	}
	// Anything left in the old map under a key not present in newMap is a
	// departed row — remove its <tr> from the DOM.
	for (const [key, tr] of state.rowMap) {
		if (!newMap.has(key)) tr.remove();
	}
	state.rowMap = newMap;

	restoreKeyedFocus(newMap, focusToken);
}

// --- Unkeyed full rebuild (pre-rsp-wp6 shape, preserved verbatim) ---

function renderFullRebuild<T>(parent: HTMLElement, columns: Column<T>[], visible: T[], ctx: TableStateContext): void {
	parent.empty();
	const table = parent.createEl('table', { cls: 'crucible-ingestion-table' });
	const thead = table.createEl('thead');
	renderHeader(thead, columns, ctx);
	const tbody = table.createEl('tbody');
	for (const row of visible) {
		const tr = tbody.createEl('tr');
		for (const col of columns) {
			const td = tr.createEl('td');
			col.render(row, td);
		}
	}
}

function renderHeader<T>(thead: HTMLElement, columns: Column<T>[], ctx: TableStateContext): void {
	// Rebuilt fresh every render regardless of keyed/unkeyed: header row width
	// is O(columns), not O(rows), so there's no perf case for reconciling it,
	// and tearing it down avoids having to separately guard against the
	// sort-arrow / is-sorted-* class and the click listener stacking across
	// renders.
	thead.empty();
	const sort = ctx.sort;
	const headerRow = thead.createEl('tr');
	for (const col of columns) {
		const th = headerRow.createEl('th', { text: col.label });
		if (col.sortable) {
			th.addClass('is-sortable');
			if (sort && sort.column === col.key) {
				th.addClass(sort.direction === 'asc' ? 'is-sorted-asc' : 'is-sorted-desc');
				th.appendText(sort.direction === 'asc' ? ' ▲' : ' ▼');
			}
			th.addEventListener('click', () => {
				const current = ctx.sort;
				if (current && current.column === col.key) {
					ctx.sort = { column: col.key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
				} else {
					ctx.sort = { column: col.key, direction: 'asc' };
				}
				void ctx.refresh();
			});
		}
	}
}

// A cell renderer (cells.ts, or a section's inline `render`) is written to
// fill a <td> it assumes is empty — that was always true under the old
// tear-down-everything shape. The reconciler preserves that contract from the
// renderer's point of view: every cell, reused or new, is emptied immediately
// before `col.render` runs, so a renderer never has to know whether its <td>
// is fresh or being repainted, and a stale button/listener from a prior paint
// never survives (the node — and any listener on it — is detached, not
// individually unwired). This is what the brief calls "idempotent cells" via
// "empty the cell before re-rendering into it" — no per-renderer changes were
// needed in cells.ts or the section modules.
function paintRow<T>(tr: HTMLTableRowElement, row: T, columns: Column<T>[]): void {
	if (tr.children.length !== columns.length) {
		// Defensive only — columns are static per call site, so this should
		// never actually trigger, but a column-count drift would otherwise
		// silently misalign `tr.children[i]` against `columns[i]` below.
		tr.empty();
		for (let c = 0; c < columns.length; c++) tr.createEl('td');
	}
	for (const [i, col] of columns.entries()) {
		const td = tr.children[i] as HTMLElement;
		td.empty();
		col.render(row, td);
	}
}

// --- Row-map storage: WeakMap keyed on the container element ---
//
// `parent` is the section's long-lived body element (constructed once per
// dashboard mount in buildSection/buildXSection and reused for every render
// of that section — the same object `render/section.ts`'s `lastRowSignatures`
// keys its own WeakMap on, for the same reason). A WeakMap needs no explicit
// teardown on unmount: a fresh mount builds a fresh body element, so the
// previous mount's entry simply becomes unreachable and is collected — no
// leak, no dashboard-lifecycle hook required here.
interface TableState {
	table: HTMLTableElement;
	thead: HTMLElement;
	tbody: HTMLElement;
	rowMap: Map<string, HTMLTableRowElement>;
}

const tableStates = new WeakMap<HTMLElement, TableState>();

// --- Keyed focus restore ---
//
// refresh.ts's captureFocus/restoreFocus fingerprint (tag + class + trimmed
// text + ordinal) is a best-effort guess because unkeyed rebuilt DOM has no
// other stable identity. A keyed table doesn't have that excuse: the row's
// key IS its stable identity, and the column index pins down which cell
// within it. This resolves the row/cell exactly (no ordinal guessing, no
// ambiguity between e.g. two rows whose visible "Cancel" button text and
// class collide), then locates a live element inside that cell to focus.
//
// This intentionally does not touch refresh.ts's fingerprint path — it fires
// from inside renderSortableTable itself, synchronously, before
// refreshWithScrollPreserved's own rAF-deferred restoreFocus runs. Since a
// removed focused element resets `document.activeElement` to `<body>`,
// restoreFocus's existing "don't steal it back" guard (only acts when
// `activeElement === body`) means: if this keyed restore succeeds, the
// fingerprint restore sees focus already claimed and backs off on its own;
// if this table is unkeyed (or the row/cell can't be resolved), activeElement
// is still `body` when the fingerprint path runs, so it falls through to that
// heuristic exactly as it did before rsp-wp6.
interface KeyedFocusToken {
	key: string;
	colIndex: number;
	tag: string;
	className: string;
}

function isElementLike(node: unknown): node is HTMLElement {
	return !!node && typeof (node as HTMLElement).tagName === 'string';
}

function captureKeyedFocus(state: TableState): KeyedFocusToken | null {
	const doc = state.tbody.ownerDocument;
	const active = doc?.activeElement;
	if (!isElementLike(active) || !state.tbody.contains(active)) return null;

	let tr: HTMLElement | null = active;
	while (tr && tr.parentElement !== state.tbody) tr = tr.parentElement;
	if (!tr) return null;

	let key: string | null = null;
	for (const [k, v] of state.rowMap) {
		if (v === tr) { key = k; break; }
	}
	if (key === null) return null;

	let cell: HTMLElement | null = active;
	while (cell && cell.parentElement !== tr) cell = cell.parentElement;
	if (!cell) return null;
	const colIndex = Array.prototype.indexOf.call(tr.children, cell);
	if (colIndex < 0) return null;

	return { key, colIndex, tag: active.tagName, className: active.className };
}

function restoreKeyedFocus(newMap: Map<string, HTMLTableRowElement>, token: KeyedFocusToken | null): void {
	if (!token) return;
	const tr = newMap.get(token.key);
	if (!tr) return; // the focused row departed — nothing to restore focus to
	const td = tr.children[token.colIndex] as HTMLElement | undefined;
	if (!td) return;
	const candidates = Array.from(td.querySelectorAll<HTMLElement>('button, a, input, select, textarea'));
	const first = candidates[0];
	if (!first) return;
	const exact = candidates.find(el => el.tagName === token.tag && el.className === token.className);
	(exact ?? first).focus();
}
