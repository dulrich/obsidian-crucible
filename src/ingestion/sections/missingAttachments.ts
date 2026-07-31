import { Notice } from 'obsidian';
import { logWarn } from '../../log';
import { computeRowSignature, renderTableSection, shouldRepaint } from '../render/section';
import { renderFileLink } from '../render/cells';
import { computeMissingAttachmentRows } from '../data/missingAttachments';
import type { DashboardHost, MissingRefRow, SectionContext } from '../render/types';

export interface MissingAttachmentsSection {
	render(body: HTMLElement, ctx: SectionContext): void;
	renderRepairAllButton(heading: HTMLElement): void;
}

// --- Section: Missing localized attachments ---
// Inverse of Orphaned Attachments: rows are broken refs (note → dead …_MD5.ext target),
// not unreferenced files. Cloned structurally from orphanedAttachments.ts — same
// metadataCacheReady waiting gate (this scan reads the same resolvedLinks-adjacent
// metadata cache state via getFirstLinkpathDest, so it's exposed to the identical
// partial-index false-positive window right after startup), same P5 signature skip, same
// keyed table, and now the same cached-row-set shape for a heading-level bulk action.
// Repair is restorative, not destructive: no confirmDestructive, no mod-warning, no
// DESTRUCTIVE_ACTIONS entry.
export function createMissingAttachmentsSection(host: DashboardHost): MissingAttachmentsSection {
	let missingAttachmentsCache: MissingRefRow[] = [];

	function render(body: HTMLElement, ctx: SectionContext): void {
		if (!host.plugin.metadataCacheReady) {
			missingAttachmentsCache = [];
			body.empty();
			body.createDiv({ cls: 'crucible-empty-state', text: 'Waiting for the metadata cache to finish indexing…' });
			host.setSectionCount('missingAttachments', 0);
			return;
		}
		const rows = computeMissingAttachmentRows(host.app, host.plugin.attachmentLocalizer);
		missingAttachmentsCache = rows;
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
				{ key: 'repairable', label: 'Repairable', sortable: true, sortKey: r => r.repairable ? 1 : 0, render: (r, td) => renderRepairablePill(td, r) },
				{ key: 'repair', label: '', render: (r, td) => renderRepairButton(host, td, r, ctx) },
			],
		});
	}

	function renderRepairAllButton(heading: HTMLElement): void {
		const btn = heading.createEl('button', { text: 'Repair all', cls: 'crucible-ingestion-repair-all' });
		btn.addEventListener('click', () => {
			void (async () => {
				const rows = missingAttachmentsCache.filter(r => r.repairable);
				if (rows.length === 0) {
					new Notice('No repairable attachment links found.');
					return;
				}
				// repairNote operates on the whole note (every broken ref, not just one row —
				// see the "Repair scope note" quirk), so repairing per DISTINCT note avoids
				// running the same note-wide repair pass once per broken ref it happens to
				// carry.
				const notePaths = new Set(rows.map(r => r.note.path));
				const notes = Array.from(new Map(rows.map(r => [r.note.path, r.note])).values());
				btn.disabled = true;
				let totalRepaired = 0;
				let totalUnrepairable = 0;
				let failedNotes = 0;
				for (const note of notes) {
					try {
						const result = await host.plugin.attachmentLocalizer.repairNote(note, true);
						if (!result) {
							failedNotes++;
							logWarn('repair all: repairNote returned null', note.path);
							continue;
						}
						totalRepaired += result.repaired;
						totalUnrepairable += result.unrepairable;
					} catch (e) {
						// Restorative sweep: one throw must not abort the rest of the notes.
						failedNotes++;
						logWarn('repair all: could not repair', note.path, e);
					}
				}
				btn.disabled = false;
				new Notice(
					`Repair all: fixed ${totalRepaired} attachment link${totalRepaired === 1 ? '' : 's'} across ${notePaths.size} note${notePaths.size === 1 ? '' : 's'}` +
					`${totalUnrepairable ? `, ${totalUnrepairable} still unrepairable` : ''}` +
					`${failedNotes ? `, ${failedNotes} note${failedNotes === 1 ? '' : 's'} failed` : ''}.`,
				);
				void host.refresh('missingAttachments');
			})();
		});
	}

	return { render, renderRepairAllButton };
}

function renderRepairablePill(td: HTMLElement, row: MissingRefRow): void {
	// Neutral pill, never a status hue — repairability is a fact about the ref, not an
	// ok/warn/error condition (the row itself carries the alarm). A non-repairable row
	// names its resolver reason inline ("no · missing" / "no · ambiguous") so the pill is
	// never an opaque "no" — the reason was previously visible only in the Localize debug
	// log, and only on the repair path.
	const text = row.repairable ? 'yes' : `no · ${row.reason ?? 'missing'}`;
	td.createSpan({ cls: 'crucible-pill is-muted', text });
}

function renderRepairButton(host: DashboardHost, td: HTMLElement, row: MissingRefRow, ctx: SectionContext): void {
	const btn = td.createEl('button', { text: 'Repair' });
	btn.disabled = !row.repairable;
	btn.addEventListener('click', () => {
		void (async () => {
			btn.disabled = true;
			try {
				// Silent: repairNote's own generic Notice would talk about "this note" without
				// making clear it just processed EVERY broken ref in that note, not only the
				// one behind this button — so build a scope-honest message from the return
				// value instead of relying on repairNote's internal one.
				const result = await host.plugin.attachmentLocalizer.repairNote(row.note, true);
				if (result === null) {
					new Notice(`Repair failed for "${row.note.basename}".`);
				} else if (result.repaired === 0 && result.unrepairable === 0) {
					// repairNote's only silent-both-zero outcome is the excluded-note
					// short-circuit (or a non-.md file, which never reaches this button).
					new Notice(`"${row.note.basename}" is excluded from localize — no attachment links were touched.`);
				} else {
					new Notice(
						`"${row.note.basename}": repaired ${result.repaired} attachment link${result.repaired === 1 ? '' : 's'}` +
						`${result.unrepairable ? `, ${result.unrepairable} still unrepairable` : ''} ` +
						`(repair covers every broken ref in this note, not just this row).`,
					);
				}
			} catch (e) {
				new Notice(`Repair failed: ${e instanceof Error ? e.message : String(e)}`);
			}
			void ctx.refresh();
		})();
	});
}
