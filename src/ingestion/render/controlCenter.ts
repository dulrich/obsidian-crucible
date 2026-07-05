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
}

export function renderControlCenter<T extends ControlCenterRow>(opts: RenderControlCenterOptions<T>): void {
	const { body, ctx, rows, filter, setFilter, emptyText, defaultSort, setCount, columns } = opts;
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
	});
}
