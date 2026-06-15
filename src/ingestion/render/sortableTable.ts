import type { Column, SectionContext } from './types';

export type { Column, SortState } from './types';

// Renders a table whose sortable headers toggle `ctx.sort` and re-render the
// section. The rows are sorted by the active column's `sortKey`; clicking a
// header flips direction (or starts ascending on a new column).
export interface SortableTableOptions {
	limit?: number;
}

export function renderSortableTable<T>(
	parent: HTMLElement,
	columns: Column<T>[],
	rows: T[],
	ctx: SectionContext,
	options: SortableTableOptions = {},
): void {
	parent.empty();
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

	const table = parent.createEl('table', { cls: 'crucible-ingestion-table' });
	const thead = table.createEl('thead');
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
	const tbody = table.createEl('tbody');
	for (const row of visible) {
		const tr = tbody.createEl('tr');
		for (const col of columns) {
			const td = tr.createEl('td');
			col.render(row, td);
		}
	}
}
