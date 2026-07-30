import { computeRowSignature, renderTableSection, shouldRepaint } from '../render/section';
import { renderFileLink, renderOpenButton } from '../render/cells';
import { formatDateTime } from '../render/format';
import { computeUnprocessedClippingRows } from '../data/clippings';
import type { ClippingRow, DashboardHost, SectionContext } from '../render/types';

// --- Section: Unprocessed Clippings ---
export function renderUnprocessedClippings(host: DashboardHost, body: HTMLElement, ctx: SectionContext): void {
	const folder = host.plugin.settings.ingestionClipperInboxFolder;
	const rows = computeUnprocessedClippingRows(host.app, folder);
	if (rows === null) {
		body.empty();
		host.setSectionCount('unprocessedClippings', 0);
		body.createDiv({ cls: 'crucible-empty-state', text: `Inbox folder "${folder}" not found.` });
		return;
	}
	// P5: an event-driven pass with an unchanged row set skips the rebuild
	// entirely; a forced pass (header Refresh, ...) always repaints.
	if (!shouldRepaint(ctx, computeRowSignature(rows))) return;

	renderTableSection<ClippingRow>({
		body, ctx, rows,
		emptyText: 'No unprocessed clippings.',
		setCount: n => host.setSectionCount('unprocessedClippings', n),
		columns: [
			{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => renderFileLink(host.app, td, r.file) },
			{ key: 'captured', label: 'Captured', sortable: true, sortKey: r => r.captured, render: (r, td) => td.setText(formatDateTime(r.captured)) },
			{ key: 'size', label: 'Size (KB)', sortable: true, sortKey: r => r.size, render: (r, td) => td.setText((r.size / 1024).toFixed(1)) },
			{ key: 'open', label: '', render: (r, td) => renderOpenButton(host.app, td, r.file) },
		],
	});
}
