import { Notice } from 'obsidian';
import { blogClipBlockedTitle, runBlogIngestCommand } from '../../orchestration/utils/blogsApi';
import { computeRowSignature, renderTableSection, shouldRepaint } from '../render/section';
import { renderAuthorCell, renderClipButton, renderExternalIconButton, renderMetaIconButton, renderSkipButton } from '../render/cells';
import { displayLabel } from '../render/format';
import { computeUncapturedPostRows } from '../data/uncaptured';
import type { DashboardHost, SectionContext, UncapturedPostRow } from '../render/types';

// WP-DP1: the Clip button's `run` callback — kept in the section file (not cells.ts)
// so cells.ts doesn't need a build-graph dependency on blogsApi.ts; see
// renderClipButton's doc comment in render/cells.ts. Shared verbatim by Ignored
// Posts (sections/ignored.ts), which duplicates this small helper rather than
// cross-importing between sibling section files.
async function runClip(host: DashboardHost, metadataFile: UncapturedPostRow['metadataFile']): Promise<boolean> {
	const res = await runBlogIngestCommand(host.plugin, { metadataFile });
	if (res.status === 'ran') {
		new Notice(`Ran ${res.commandId}`);
		return true;
	}
	if (res.status === 'missing-command') {
		new Notice('Choose a queueable blog ingest command in settings.');
		return false;
	}
	new Notice('No blog metadata note found for this post.');
	return false;
}

// Prefer the post's real author(s) (dc:creator / atom author) over the blog name when present.
function postAuthorLabel(row: UncapturedPostRow): string {
	return row.authors.length > 0 ? row.authors.join(', ') : displayLabel(row.blogName);
}

function renderPostAuthorCell(td: HTMLElement, row: UncapturedPostRow): void {
	if (row.authors.length > 0) td.setText(row.authors.join(', '));
	else renderAuthorCell(td, row.blogName);
}

// --- Section: Uncaptured Posts ---
export async function renderUncapturedPosts(host: DashboardHost, body: HTMLElement, ctx: SectionContext): Promise<void> {
	// Compute-then-paint (mirrors uncapturedVideos.ts / queueMonitor.ts): await
	// the whole-vault scan before touching the DOM at all, so renderTableSection
	// emptying the body itself below is the only teardown, and a throw here leaves
	// the previous render on screen instead of a blanked "Scanning…" state.
	const rows = await computeUncapturedPostRows(host.app, host.plugin);
	// P5: an event-driven pass with an unchanged row set skips the rebuild;
	// a forced pass (header Refresh, post-Ignore refresh, ...) always repaints.
	if (!shouldRepaint(ctx, computeRowSignature(rows))) return;

	renderTableSection<UncapturedPostRow>({
		body, ctx, rows,
		emptyText: 'No uncaptured posts.',
		defaultSort: { column: 'publishedAt', direction: 'desc' },
		// rsp-wp6: postId is the natural stable key — one row per post.
		rowKey: r => r.postId,
		setCount: n => host.setSectionCount('uncapturedPosts', n),
		columns: [
			{ key: 'blogName', label: 'Author', sortable: true, sortKey: r => postAuthorLabel(r).toLowerCase(), render: (r, td) => renderPostAuthorCell(td, r) },
			{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => td.setText(r.title) },
			{ key: 'kind', label: 'Type', sortable: true, sortKey: r => r.kind, render: (r, td) => td.setText(r.kind) },
			{ key: 'wordCount', label: 'Words', sortable: true, sortKey: r => r.wordCount ?? -1, render: (r, td) => td.setText(r.wordCount == null ? '—' : String(r.wordCount)) },
			// WP-DP1: nowrap on both header and cell — see uncapturedVideos.ts/ignored.ts
			// for the same treatment on the other three Publish Date columns.
			{ key: 'publishedAt', label: 'Publish Date', sortable: true, sortKey: r => r.publishedAt, headerCls: 'crucible-intake-date-cell', render: (r, td) => { td.addClass('crucible-intake-date-cell'); td.setText((r.publishedAt || '').slice(0, 10)); } },
			// WP-DP1: one merged action column, uniform icon-only slot order (external ·
			// meta · command · skip) — read · metadata · Clip · Skip.
			{ key: 'action', label: '', render: (r, td) => renderPostActionCell(host, td, r, ctx) },
		],
	});
}

function renderPostActionCell(host: DashboardHost, td: HTMLElement, row: UncapturedPostRow, ctx: SectionContext): void {
	td.addClass('crucible-intake-action-cell');
	renderExternalIconButton(td, row.url, 'Read');
	renderMetaIconButton(td, host.app, row.metadataFile, 'No blog metadata note');
	renderClipButton(td, host, blogClipBlockedTitle(host.plugin, row), ctx, () => runClip(host, row.metadataFile));
	renderSkipButton(td, host, 'blog', row.postId, 'uncapturedPosts', 'ignoredPosts', ctx);
}
