import { Notice } from 'obsidian';
import { computeRowSignature, renderTableSection, shouldRepaint } from '../render/section';
import { renderFileLink } from '../render/cells';
import { computeXPostRows } from '../data/xPosts';
import { xMetadataRoot } from '../../orchestration/utils/xApi';
import type { DashboardHost, SectionContext, XPostRow } from '../render/types';

export interface XPostsSection {
	render(body: HTMLElement, ctx: SectionContext): void;
	renderBackfillButton(heading: HTMLElement): void;
}

// --- Section: X posts ---
// Same factory shape as missingAttachments.ts (createMissingAttachmentsSection):
// compute-then-signature-skip render, keyed table, a heading-level bulk action.
// Unlike Repair All, "Backfill from registry" doesn't operate on this section's
// own row set — XBackfillWorkflow re-walks the link registry itself — so there's
// no per-row cache to carry between render() and the button handler here.
// Restorative/additive, not destructive: no confirmDestructive, no mod-warning.
export function createXPostsSection(host: DashboardHost): XPostsSection {
	function render(body: HTMLElement, ctx: SectionContext): void {
		const registryRoot = host.plugin.settings.orchestrationLinkRegistryRoot;
		const metadataRoot = xMetadataRoot(host.plugin);
		const rows = computeXPostRows(host.app, registryRoot, metadataRoot);
		// P5: skip the rebuild on an unchanged row set during an event-driven pass.
		if (!shouldRepaint(ctx, computeRowSignature(rows))) return;
		renderTableSection<XPostRow>({
			body, ctx, rows,
			emptyText: 'No X posts discovered yet.',
			defaultSort: { column: 'statusId', direction: 'desc' },
			// rsp-wp6: statusId is the natural key — one row per X post.
			rowKey: r => r.statusId,
			setCount: n => host.setSectionCount('xPosts', n),
			columns: [
				{ key: 'statusId', label: 'Status', sortable: true, sortKey: r => r.statusId, render: (r, td) => renderStatusCell(host, td, r) },
				{ key: 'author', label: 'Author', sortable: true, sortKey: r => (r.author ?? '').toLowerCase(), render: (r, td) => td.setText(r.author ?? '—') },
				{ key: 'state', label: 'State', sortable: true, sortKey: r => r.state, render: (r, td) => renderStatePill(td, r.state) },
				{ key: 'sources', label: 'Sources', sortable: true, sortKey: r => r.sourceCount, render: (r, td) => td.setText(String(r.sourceCount)) },
				{ key: 'action', label: '', render: (r, td) => renderActionCell(host, td, r) },
			],
		});
	}

	function renderBackfillButton(heading: HTMLElement): void {
		const btn = heading.createEl('button', { text: 'Backfill from registry', cls: 'crucible-ingestion-backfill-x' });
		btn.addEventListener('click', () => {
			void (async () => {
				btn.disabled = true;
				try {
					// enqueueAndRun kicks the type's drain, so a manual click runs regardless
					// of the Auto-run gate. Not destructive: it only enqueues x_metadata_fetch
					// jobs for statuses not yet materialized (XBackfillWorkflow) — no confirm.
					const job = await host.plugin.orchestrationAutoRunner?.enqueueAndRun(
						'x_metadata_backfill', {}, { priority: 'high', lane: 'user' },
					);
					new Notice(job ? 'Backfill enqueued: scanning the link registry for X posts.' : 'Could not enqueue the backfill.');
				} finally {
					btn.disabled = false;
				}
			})();
		});
	}

	return { render, renderBackfillButton };
}

function renderStatusCell(host: DashboardHost, td: HTMLElement, row: XPostRow): void {
	if (row.metadataFile) {
		renderFileLink(host.app, td, row.metadataFile, row.statusId);
		return;
	}
	td.setText(row.statusId);
}

function renderStatePill(td: HTMLElement, state: XPostRow['state']): void {
	if (state === 'unavailable') {
		// unavailable is a real semantic state (the fetch happened; the post is
		// gone) — the fleet taxonomy's one case here that earns a status hue.
		td.createSpan({ cls: 'crucible-pill is-warn', text: 'unavailable' });
		return;
	}
	// pending and materialized are both facts at rest, not alerts — neutral pill.
	td.createSpan({ cls: 'crucible-pill is-muted', text: state });
}

function renderActionCell(host: DashboardHost, td: HTMLElement, row: XPostRow): void {
	if (row.state !== 'pending') return;
	const btn = td.createEl('button', { text: 'Fetch' });
	btn.addEventListener('click', () => {
		void (async () => {
			btn.disabled = true;
			// sourcePaths empty: this button fetches a status the registry already
			// knows about, but stamping source notes with x-metadata is a discovery-
			// time concern (XPostDiscoverWorkflow / XBackfillWorkflow's own resolved
			// sourcePaths) — not this dashboard's job.
			const job = await host.plugin.orchestrationAutoRunner?.enqueueAndRun('x_metadata_fetch', {
				statusId: row.statusId,
				url: row.url,
				sourcePaths: [],
			}, { priority: 'high', lane: 'user' });
			if (job) {
				btn.setText('Queued');
			} else {
				btn.disabled = false;
				new Notice('Could not enqueue the fetch.');
			}
		})();
	});
}
