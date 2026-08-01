import { computeIgnoredPostRows, computeIgnoredVideoRows } from '../data/ignored';
import { computeRowSignature, renderTableSection, shouldRepaint } from '../render/section';
import { renderAuthorCell, renderExternalLink, renderFileLink, renderUnignoreButton } from '../render/cells';
import { blogIgnoreUrl, displayLabel, formatDuration } from '../render/format';
import type { DashboardHost, IgnoredPostRow, IgnoredVideoRow, SectionContext } from '../render/types';

// WP-IC2: shared by both sections — a degrade row (see computeIgnoredPostRows/
// computeIgnoredVideoRows in ../data/ignored.ts) has a null `title`, so the raw id
// renders (muted) instead, guaranteeing the row is never blank.
function renderIgnoredTitleCell(row: { id: string; title: string | null }, td: HTMLElement): void {
	if (row.title === null) {
		td.createSpan({ cls: 'crucible-muted', text: row.id });
		return;
	}
	td.setText(row.title);
}

// --- Section: Ignored blogs ---
export async function renderIgnoredPosts(host: DashboardHost, body: HTMLElement, ctx: SectionContext): Promise<void> {
	// Compute-then-paint (mirrors uncapturedPosts.ts): await the whole scan+join
	// before touching the DOM at all.
	const rows = await computeIgnoredPostRows(host.app, host.plugin);
	// P5: skip the rebuild on an unchanged row set during an event-driven pass.
	if (!shouldRepaint(ctx, computeRowSignature(rows))) return;
	renderTableSection<IgnoredPostRow>({
		body, ctx, rows,
		emptyText: 'No ignored blogs.',
		defaultSort: { column: 'publishedAt', direction: 'desc' },
		// rsp-wp6: the post id itself is the natural stable key.
		rowKey: r => r.id,
		setCount: n => host.setSectionCount('ignoredPosts', n),
		columns: [
			{ key: 'blogName', label: 'Author', sortable: true, sortKey: r => (r.blogName ?? '').toLowerCase(), render: (r, td) => (r.blogName ? renderAuthorCell(td, r.blogName) : td.setText('—')) },
			{ key: 'title', label: 'Title', sortable: true, sortKey: r => (r.title ?? r.id).toLowerCase(), render: renderIgnoredTitleCell },
			{ key: 'kind', label: 'Type', sortable: true, sortKey: r => r.kind ?? '', render: (r, td) => td.setText(r.kind ?? '—') },
			{ key: 'wordCount', label: 'Words', sortable: true, sortKey: r => r.wordCount ?? -1, render: (r, td) => td.setText(r.wordCount == null ? '—' : String(r.wordCount)) },
			// Degrade rows carry a null publishedAt, which sorts as '' — the empty
			// string sorts before every real date, so on the default `desc` sort it
			// lands last (see computeIgnoredPostRows' doc comment on the degrade shape).
			{ key: 'publishedAt', label: 'Publish Date', sortable: true, sortKey: r => r.publishedAt ?? '', render: (r, td) => td.setText((r.publishedAt || '').slice(0, 10)) },
			// WP-IC2: one merged action column (read · Un-ignore) — same
			// `.crucible-intake-action-cell` shape WP-IC1 introduced for Uncaptured.
			{ key: 'action', label: '', render: (r, td) => renderIgnoredPostActionCell(host, td, r, ctx) },
		],
	});
}

function renderIgnoredPostActionCell(host: DashboardHost, td: HTMLElement, row: IgnoredPostRow, ctx: SectionContext): void {
	td.addClass('crucible-intake-action-cell');
	// Full rows carry their own url; a degrade row falls back to blogIgnoreUrl(id) —
	// ignored blog ids are canonical URLs, so this resolves for the overwhelming
	// majority; the rare non-URL id (hand-edited ignore note) renders muted text
	// instead of a link, same fallback shape as the metadata cell in uncapturedPosts.ts.
	const url = row.url ?? blogIgnoreUrl(row.id);
	if (url) renderExternalLink(td, url, 'read');
	else td.createSpan({ cls: 'crucible-muted', text: 'read' });
	renderUnignoreButton(td, host, 'blog', row.id, 'ignoredPosts', 'uncapturedPosts', ctx);
}

// --- Section: Ignored videos ---
export async function renderIgnoredVideos(host: DashboardHost, body: HTMLElement, ctx: SectionContext): Promise<void> {
	// Compute-then-paint (mirrors uncapturedVideos.ts).
	const rows = await computeIgnoredVideoRows(host.app, host.plugin);
	// P5: skip the rebuild on an unchanged row set during an event-driven pass.
	if (!shouldRepaint(ctx, computeRowSignature(rows))) return;
	renderTableSection<IgnoredVideoRow>({
		body, ctx, rows,
		emptyText: 'No ignored videos.',
		defaultSort: { column: 'publishedAt', direction: 'desc' },
		// rsp-wp6: the video id itself is the natural stable key.
		rowKey: r => r.id,
		setCount: n => host.setSectionCount('ignoredVideos', n),
		columns: [
			{ key: 'channelName', label: 'Creator', sortable: true, sortKey: r => (r.channelName ?? '').toLowerCase(), render: (r, td) => (r.channelAboutFile ? renderFileLink(host.app, td, r.channelAboutFile, displayLabel(r.channelName ?? r.id)) : td.setText(r.channelName ? displayLabel(r.channelName) : '—')) },
			{ key: 'title', label: 'Title', sortable: true, sortKey: r => (r.title ?? r.id).toLowerCase(), render: renderIgnoredTitleCell },
			// Degrade rows carry a null publishedAt, which sorts as '' — the empty
			// string sorts before every real date, so on the default `desc` sort it
			// lands last (see computeIgnoredVideoRows' doc comment on the degrade shape).
			{ key: 'publishedAt', label: 'Publish Date', sortable: true, sortKey: r => r.publishedAt ?? '', render: (r, td) => td.setText((r.publishedAt || '').slice(0, 10)) },
			{ key: 'duration', label: 'Duration', sortable: true, sortKey: r => r.durationSeconds ?? -1, render: (r, td) => td.setText(formatDuration(r.durationSeconds)) },
			// WP-IC2: one merged action column (watch · Un-ignore) — same shape as posts above.
			{ key: 'action', label: '', render: (r, td) => renderIgnoredVideoActionCell(host, td, r, ctx) },
		],
	});
}

function renderIgnoredVideoActionCell(host: DashboardHost, td: HTMLElement, row: IgnoredVideoRow, ctx: SectionContext): void {
	td.addClass('crucible-intake-action-cell');
	// A degrade row falls back to the watch URL built straight from the id — always
	// resolvable, unlike the blog case above (a video id is never itself a URL).
	const url = row.url ?? `https://www.youtube.com/watch?v=${row.id}`;
	renderExternalLink(td, url, 'watch');
	renderUnignoreButton(td, host, 'youtube', row.id, 'ignoredVideos', 'uncapturedVideos', ctx);
}
