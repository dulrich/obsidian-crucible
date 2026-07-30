import type { Column, SortState, TableStateContext } from './types';
import { renderTableSection } from './section';

export type ControlCenterFilter = 'all' | 'tracked' | 'untracked';

export interface ControlCenterRow {
	tracked: boolean;
}

export interface RenderControlCenterOptions<T extends ControlCenterRow> {
	body: HTMLElement;
	ctx: TableStateContext;
	rows: T[];
	filter: ControlCenterFilter;
	setFilter: (filter: ControlCenterFilter) => void;
	emptyText: string;
	defaultSort?: SortState;
	setCount: (n: number) => void;
	columns: Column<T>[];
	// rsp-wp6: forwarded to renderTableSection's own `rowKey` — see its doc
	// comment. Not used by either call site today: both blogControl and
	// channelControl (controlCenters.ts) unconditionally `body.empty()` the
	// OUTER section body — which owns the `tableBody` div this module builds
	// below — before calling in, so the reconciler's target container is torn
	// down and recreated every render regardless of what's passed here. Wiring
	// stays in place so a future pass that fixes controlCenters.ts's own
	// teardown (a natural key already exists on both row types — channelId /
	// blogKey) doesn't also need a signature change here.
	rowKey?: (row: T) => string;
}

export function renderControlCenter<T extends ControlCenterRow>(opts: RenderControlCenterOptions<T>): void {
	const { body, ctx, rows, filter, setFilter, emptyText, defaultSort, setCount, columns, rowKey } = opts;
	const controls = body.createDiv({ cls: 'crucible-ingestion-queue-controls' });
	const filters: Array<{ id: ControlCenterFilter; label: string }> = [
		{ id: 'all', label: 'All' },
		{ id: 'tracked', label: 'Tracked' },
		{ id: 'untracked', label: 'Untracked' },
	];
	for (const f of filters) {
		const btn = controls.createEl('button', { text: f.label });
		if (filter === f.id) btn.addClass('mod-cta');
		btn.addEventListener('click', () => {
			if (filter === f.id) return;
			setFilter(f.id);
			void ctx.refresh();
		});
	}

	const filteredRows = rows.filter(row =>
		filter === 'all'
			? true
			: filter === 'tracked' ? row.tracked : !row.tracked);

	const tableBody = body.createDiv();
	renderTableSection<T>({
		body: tableBody,
		ctx,
		rows: filteredRows,
		emptyText,
		defaultSort,
		setCount,
		columns,
		rowKey,
	});
}
