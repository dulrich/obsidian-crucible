import { Notice } from 'obsidian';
import { computeRowSignature, renderTableSection, shouldRepaint } from '../render/section';
import { renderFileLink } from '../render/cells';
import { computeMissingAttachmentRows } from '../data/missingAttachments';
import type { DashboardHost, MissingRefRow, SectionContext } from '../render/types';

// --- Section: Missing localized attachments ---
// Inverse of Orphaned Attachments: rows are broken refs (note → dead …_MD5.ext target),
// not unreferenced files. Cloned structurally from orphanedAttachments.ts — same
// metadataCacheReady waiting gate (this scan reads the same resolvedLinks-adjacent
// metadata cache state via getFirstLinkpathDest, so it's exposed to the identical
// partial-index false-positive window right after startup), same P5 signature skip, same
// keyed table. Repair is restorative, not destructive: no confirmDestructive, no
// mod-warning, no DESTRUCTIVE_ACTIONS entry.
export function renderMissingAttachments(host: DashboardHost, body: HTMLElement, ctx: SectionContext): void {
	if (!host.plugin.metadataCacheReady) {
		body.empty();
		body.createDiv({ cls: 'crucible-empty-state', text: 'Waiting for the metadata cache to finish indexing…' });
		host.setSectionCount('missingAttachments', 0);
		return;
	}
	const rows = computeMissingAttachmentRows(host.app, host.plugin.attachmentLocalizer);
	// P5: skip the rebuild on an unchanged row set during an event-driven pass.
	if (!shouldRepaint(ctx, computeRowSignature(rows))) return;
	renderTableSection<MissingRefRow>({
		body, ctx, rows,
		emptyText: 'No missing localized attachments.',
		// rsp-wp6: (note, link) is the natural key — a note can carry more than one broken ref.
		rowKey: r => r.note.path + '→' + r.link,
		setCount: n => host.setSectionCount('missingAttachments', n),
		columns: [
			{ key: 'note', label: 'Note', sortable: true, sortKey: r => r.note.basename.toLowerCase(), render: (r, td) => renderFileLink(host.app, td, r.note, r.note.basename) },
			{ key: 'link', label: 'Broken ref', sortable: true, sortKey: r => r.link.toLowerCase(), render: (r, td) => td.setText(r.link) },
			{ key: 'repairable', label: 'Repairable', sortable: true, sortKey: r => r.repairable ? 1 : 0, render: (r, td) => renderRepairablePill(td, r.repairable) },
			{ key: 'repair', label: '', render: (r, td) => renderRepairButton(host, td, r, ctx) },
		],
	});
}

function renderRepairablePill(td: HTMLElement, repairable: boolean): void {
	// Neutral pill, never a status hue — repairability is a fact about the ref, not an
	// ok/warn/error condition (the row itself carries the alarm).
	td.createSpan({ cls: 'crucible-pill is-muted', text: repairable ? 'yes' : 'no' });
}

function renderRepairButton(host: DashboardHost, td: HTMLElement, row: MissingRefRow, ctx: SectionContext): void {
	const btn = td.createEl('button', { text: 'Repair' });
	btn.disabled = !row.repairable;
	btn.addEventListener('click', () => {
		void (async () => {
			btn.disabled = true;
			try {
				// repairNote already Notices its own outcome.
				await host.plugin.attachmentLocalizer.repairNote(row.note);
			} catch (e) {
				new Notice(`Repair failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			void ctx.refresh();
		})();
	});
}
