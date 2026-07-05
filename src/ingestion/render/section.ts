import type { Column, SortState, TableStateContext } from './types';
import { renderSortableTable } from './sortableTable';

export interface RenderTableSectionOptions<T> {
	body: HTMLElement;
	ctx: TableStateContext;
	rows: T[];
	columns: Column<T>[];
	emptyText: string;
	setCount: (n: number) => void;
	defaultSort?: SortState;
}

// The scaffold shared by every list section: clear the body, publish the row
// count, short-circuit to an empty-state message when there are no rows, seed
// the default sort on first render, then hand off to the sortable table.
export function renderTableSection<T>(opts: RenderTableSectionOptions<T>): void {
	const { body, ctx, rows, columns, emptyText, setCount, defaultSort } = opts;
	body.empty();
	setCount(rows.length);
	if (rows.length === 0) {
		body.createDiv({ cls: 'crucible-empty-state', text: emptyText });
		return;
	}
	if (!ctx.sort && defaultSort) ctx.sort = defaultSort;
	renderSortableTable(body, columns, rows, ctx);
}
