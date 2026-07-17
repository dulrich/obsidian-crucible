import { renderTableSection } from '../render/section';
import { renderFileLink } from '../render/cells';
import { formatDate } from '../render/format';
import { computeUnrefinedTranscriptRows } from '../data/transcripts';
import type { DashboardHost, SectionContext, TranscriptRow } from '../render/types';

// --- Section: Unrefined Transcripts ---
export function renderUnrefinedTranscripts(host: DashboardHost, body: HTMLElement, ctx: SectionContext): void {
	const dailyFolder = host.plugin.settings.dailyFolder;
	const wpm = host.plugin.settings.ingestionReadingWpm || 250;
	const rows = computeUnrefinedTranscriptRows(host.app, dailyFolder, wpm);
	if (rows === null) {
		body.empty();
		host.setSectionCount('unrefinedTranscripts', 0);
		body.createDiv({ cls: 'crucible-empty-state', text: `Daily folder "${dailyFolder}" not found.` });
		return;
	}

	renderTableSection<TranscriptRow>({
		body, ctx, rows,
		emptyText: 'No unrefined transcripts.',
		// Default sort: created ascending (matches user's DataviewJS).
		defaultSort: { column: 'created', direction: 'asc' },
		setCount: n => host.setSectionCount('unrefinedTranscripts', n),
		columns: [
			{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => renderFileLink(host.app, td, r.file) },
			{ key: 'tags', label: 'Tags', render: (r, td) => td.setText(r.tags.join(', ')) },
			{ key: 'words', label: 'Words', sortable: true, sortKey: r => r.words, render: (r, td) => td.setText(String(r.words)) },
			{ key: 'estRead', label: 'Est. Read', sortable: true, sortKey: r => r.estReadMin ?? 0, render: (r, td) => td.setText(r.estReadMin != null ? `${r.estReadMin.toFixed(1)} min` : '') },
			{ key: 'created', label: 'Created', sortable: true, sortKey: r => r.created, render: (r, td) => td.setText(formatDate(r.created)) },
			{ key: 'read', label: 'Read?', sortable: true, sortKey: r => (r.read ? 1 : 0), render: (r, td) => td.setText(r.read ? '✅' : '❌') },
		],
	});
}
