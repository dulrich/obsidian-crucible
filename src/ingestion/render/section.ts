import type { Column, SortState, TableStateContext } from './types';
import { renderSortableTable } from './sortableTable';

// Default cap for any section built on renderTableSection that doesn't pass its
// own `limit`. Twelve of the thirteen ingestion-dashboard tables render
// uncapped — a long-running vault can grow any of them (uncaptured posts,
// orphaned attachments, ...) into the thousands, at which point every refresh
// re-renders that many rows' worth of DOM. queueMonitor already caps at 100
// (QUEUE_MONITOR_RENDER_LIMIT in queueMonitor.ts) for the same reason; this is
// the equivalent floor for everything else. Callers with a reason to differ
// (a section that's rarely large, or one that wants a tighter cap) pass their
// own `limit`.
export const DEFAULT_TABLE_ROW_LIMIT = 200;

export interface RenderTableSectionOptions<T> {
	body: HTMLElement;
	ctx: TableStateContext;
	rows: T[];
	columns: Column<T>[];
	emptyText: string;
	setCount: (n: number) => void;
	defaultSort?: SortState;
	limit?: number;
}

// The scaffold shared by every list section: clear the body, publish the row
// count, short-circuit to an empty-state message when there are no rows, seed
// the default sort on first render, then hand off to the sortable table. Rows
// beyond `limit` (default DEFAULT_TABLE_ROW_LIMIT) don't render at all — sorting
// happens on the full row set first (renderSortableTable's own `options.limit`
// slices after sorting), so which rows are visible still reflects the active
// sort, not insertion order.
export function renderTableSection<T>(opts: RenderTableSectionOptions<T>): void {
	const { body, ctx, rows, columns, emptyText, setCount, defaultSort, limit = DEFAULT_TABLE_ROW_LIMIT } = opts;
	body.empty();
	setCount(rows.length);
	if (rows.length === 0) {
		body.createDiv({ cls: 'crucible-empty-state', text: emptyText });
		return;
	}
	if (!ctx.sort && defaultSort) ctx.sort = defaultSort;
	renderSortableTable(body, columns, rows, ctx, { limit });
	if (rows.length > limit) {
		body.createDiv({
			cls: 'crucible-ingestion-table-caption',
			text: `showing ${limit} of ${rows.length}`,
		});
	}
}
