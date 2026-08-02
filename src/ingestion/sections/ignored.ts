import { Notice } from 'obsidian';
import { blogClipBlockedTitle, runBlogIngestCommand } from '../../orchestration/utils/blogsApi';
import { removeIgnoredBlogId, removeIgnoredVideoId } from '../../orchestration/utils/ignoredIds';
import { computeIgnoredPostRows, computeIgnoredVideoRows } from '../data/ignored';
import { computeRowSignature, renderTableSection, shouldRepaint } from '../render/section';
import { renderAuthorCell, renderClipButton, renderEnrichButton, renderExternalIconButton, renderFileLink, renderMetaIconButton } from '../render/cells';
import { blogIgnoreUrl, displayLabel, formatDuration } from '../render/format';
import type { DashboardHost, IgnoredPostRow, IgnoredVideoRow, SectionContext } from '../render/types';

// WP-DP1: the Clip button's `run` callback — duplicated verbatim from
// uncapturedPosts.ts (see its comment) rather than cross-importing between sibling
// section files; keeps cells.ts free of a build-graph dependency on blogsApi.ts.
async function runClip(host: DashboardHost, metadataFile: IgnoredPostRow['metadataFile']): Promise<boolean> {
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

// WP-DP1 rule 4: Ignored sections have no Skip/Un-ignore button — the row's meta and
// primary-action (Clip/Enrich) slots share this one degrade-aware muted title. A
// degrade row (see computeIgnoredPostRows/computeIgnoredVideoRows in
// ../data/ignored.ts) has aged out of every scanned tracker run, so there is nothing
// for either slot to act on.
const AGED_OUT_TITLE = 'No tracker data (aged out)';

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
			// WP-DP1: nowrap on both header and cell.
			{ key: 'publishedAt', label: 'Publish Date', sortable: true, sortKey: r => r.publishedAt ?? '', headerCls: 'crucible-intake-date-cell', render: (r, td) => { td.addClass('crucible-intake-date-cell'); td.setText((r.publishedAt || '').slice(0, 10)); } },
			// WP-DP1: one merged action column, uniform icon-only slot order (external ·
			// meta · command) — read · metadata · Clip. Ignored sections have no skip slot.
			{ key: 'action', label: '', render: (r, td) => renderIgnoredPostActionCell(host, td, r, ctx) },
		],
	});
}

function renderIgnoredPostActionCell(host: DashboardHost, td: HTMLElement, row: IgnoredPostRow, ctx: SectionContext): void {
	td.addClass('crucible-intake-action-cell');
	// Full rows carry their own url; a degrade row falls back to blogIgnoreUrl(id) —
	// ignored blog ids are canonical URLs, so this resolves for the overwhelming
	// majority; the rare non-URL id (hand-edited ignore note) renders muted (WP-DP1
	// rule 1: still present, disabled + titled, never omitted).
	const degraded = row.title === null;
	const url = row.url ?? blogIgnoreUrl(row.id);
	renderExternalIconButton(td, url, 'Read');
	renderMetaIconButton(td, host.app, row.metadataFile, degraded ? AGED_OUT_TITLE : 'No blog metadata note');
	// WP-DP1 rule 4: Clip un-ignores first, then runs the same precondition-gated
	// ingest as Uncaptured Posts (blogClipBlockedTitle) — the degrade override takes
	// precedence since a degrade row has no `hasBody`/metadata to evaluate.
	const blockedTitle = degraded ? AGED_OUT_TITLE : blogClipBlockedTitle(host.plugin, row);
	renderClipButton(td, host, blockedTitle, ctx, () => runClip(host, row.metadataFile), {
		beforeRun: () => removeIgnoredBlogId(host.app, row.id),
		ownSectionId: 'ignoredPosts',
		companionSectionId: 'uncapturedPosts',
	});
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
			// WP-DP1: nowrap on both header and cell.
			{ key: 'publishedAt', label: 'Publish Date', sortable: true, sortKey: r => r.publishedAt ?? '', headerCls: 'crucible-intake-date-cell', render: (r, td) => { td.addClass('crucible-intake-date-cell'); td.setText((r.publishedAt || '').slice(0, 10)); } },
			{ key: 'duration', label: 'Duration', sortable: true, sortKey: r => r.durationSeconds ?? -1, render: (r, td) => td.setText(formatDuration(r.durationSeconds)) },
			// WP-DP1: one merged action column, uniform icon-only slot order (external ·
			// meta · command) — watch · metadata · Enrich. Ignored sections have no skip slot.
			{ key: 'action', label: '', render: (r, td) => renderIgnoredVideoActionCell(host, td, r, ctx) },
		],
	});
}

function renderIgnoredVideoActionCell(host: DashboardHost, td: HTMLElement, row: IgnoredVideoRow, ctx: SectionContext): void {
	td.addClass('crucible-intake-action-cell');
	// A degrade row falls back to the watch URL built straight from the id — always
	// resolvable, unlike the blog case above (a video id is never itself a URL).
	const degraded = row.title === null;
	const url = row.url ?? `https://www.youtube.com/watch?v=${row.id}`;
	renderExternalIconButton(td, url, 'Watch');
	renderMetaIconButton(td, host.app, row.enrichmentFile, degraded ? AGED_OUT_TITLE : 'No enrichment note yet');
	// WP-DP1 rule 4: Enrich un-ignores first, then runs the same enrichment enqueue as
	// Uncaptured Videos. `title`/`channelName` fall back to '' when degraded — never
	// actually read, since a degraded row's blockedTitle disables the click.
	const blockedTitle = degraded ? AGED_OUT_TITLE : row.enrichmentFile ? 'Already enriched' : null;
	renderEnrichButton(td, host, { videoId: row.id, title: row.title ?? '', channelName: row.channelName ?? '' }, blockedTitle, ctx, {
		beforeRun: () => removeIgnoredVideoId(host.app, row.id),
		ownSectionId: 'ignoredVideos',
		companionSectionId: 'uncapturedVideos',
	});
}
