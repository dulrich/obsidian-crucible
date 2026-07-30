import { Notice } from 'obsidian';
import { runBlogIngestCommand } from '../../orchestration/utils/blogsApi';
import { computeRowSignature, renderTableSection, shouldRepaint } from '../render/section';
import { renderAuthorCell, renderExternalLink, renderFileLink, renderIgnoreButton } from '../render/cells';
import { displayLabel } from '../render/format';
import { computeUncapturedPostRows } from '../data/uncaptured';
import type { DashboardHost, SectionContext, UncapturedPostRow } from '../render/types';

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
		setCount: n => host.setSectionCount('uncapturedPosts', n),
		columns: [
			{ key: 'blogName', label: 'Author', sortable: true, sortKey: r => postAuthorLabel(r).toLowerCase(), render: (r, td) => renderPostAuthorCell(td, r) },
			{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => td.setText(r.title) },
			{ key: 'kind', label: 'Type', sortable: true, sortKey: r => r.kind, render: (r, td) => td.setText(r.kind) },
			{ key: 'wordCount', label: 'Words', sortable: true, sortKey: r => r.wordCount ?? -1, render: (r, td) => td.setText(r.wordCount == null ? '—' : String(r.wordCount)) },
			{ key: 'publishedAt', label: 'Publish Date', sortable: true, sortKey: r => r.publishedAt, render: (r, td) => td.setText((r.publishedAt || '').slice(0, 10)) },
			{ key: 'action', label: '', render: (r, td) => renderPostActionCell(host, td, r, ctx) },
			{ key: 'ignore', label: '', render: (r, td) => renderIgnoreButton(td, host, 'blog', r.postId, 'uncapturedPosts', 'ignoredPosts', ctx) },
		],
	});
}

function renderPostActionCell(host: DashboardHost, td: HTMLElement, row: UncapturedPostRow, ctx: SectionContext): void {
	renderExternalLink(td, row.url, 'read');
	td.createSpan({ text: '  ' });
	if (row.metadataFile) {
		renderFileLink(host.app, td, row.metadataFile, 'metadata');
	} else {
		td.createSpan({ text: 'metadata' }).addClass('crucible-muted');
	}
	if (!row.hasBody) return;
	td.createSpan({ text: '  ' });
	renderIngestButton(host, td, row, ctx);
}

function renderIngestButton(host: DashboardHost, td: HTMLElement, row: UncapturedPostRow, ctx: SectionContext): void {
	const btn = td.createEl('button', { text: 'Ingest' });
	btn.addEventListener('click', () => {
		void (async () => {
			btn.disabled = true;
			try {
				const res = await runBlogIngestCommand(host.plugin, row);
				if (res.status === 'ran') {
					new Notice(`Ran ${res.commandId}`);
				} else if (res.status === 'missing-command') {
					new Notice('Choose a queueable blog ingest command in settings.');
					btn.disabled = false;
					return;
				} else {
					new Notice('No blog metadata note found for this post.');
					btn.disabled = false;
					return;
				}
			} catch (e) {
				new Notice(`Ingest failed: ${e instanceof Error ? e.message : String(e)}`);
				btn.disabled = false;
				return;
			}
			void ctx.refresh();
		})();
	});
}
