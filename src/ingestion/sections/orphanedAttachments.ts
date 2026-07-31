import { Notice } from 'obsidian';
import { ConfirmModal } from '../../confirmModal';
import { confirmDestructive } from '../../settings/destructiveActions';
import { logWarn } from '../../log';
import { computeRowSignature, renderTableSection, shouldRepaint } from '../render/section';
import { renderFileLink } from '../render/cells';
import { formatDateTime } from '../render/format';
import { computeOrphanedAttachmentRows } from '../data/orphanedAttachments';
import type { DashboardHost, OrphanRow, SectionContext } from '../render/types';

export interface OrphanedAttachmentsSection {
	render(body: HTMLElement, ctx: SectionContext): void;
	renderCleanupAllButton(heading: HTMLElement): void;
}

// --- Section: Orphaned Attachments ---
export function createOrphanedAttachmentsSection(host: DashboardHost): OrphanedAttachmentsSection {
	let orphanedAttachmentsCache: OrphanRow[] = [];

	function render(body: HTMLElement, ctx: SectionContext): void {
		// The scan trusts metadataCache.resolvedLinks, which is still rebuilding
		// for a while after startup — computing against the partial map reported
		// 3,323 of 5,284 localized attachments as orphaned (all false). Render a
		// waiting state until the plugin's first-resolve latch flips; the
		// dashboard's own one-shot 'resolved' listener re-renders this section
		// the moment it does. The cache stays empty so "Cleanup all" answers
		// "nothing to clean up" rather than trashing a false cohort.
		if (!host.plugin.metadataCacheReady) {
			orphanedAttachmentsCache = [];
			body.empty();
			body.createDiv({ cls: 'crucible-empty-state', text: 'Waiting for the metadata cache to finish indexing…' });
			host.setSectionCount('orphanedAttachments', 0);
			return;
		}
		const rows = computeOrphanedAttachmentRows(host.app);
		orphanedAttachmentsCache = rows;
		// P5: skip the rebuild on an unchanged row set during an event-driven pass.
		if (!shouldRepaint(ctx, computeRowSignature(rows))) return;
		renderTableSection<OrphanRow>({
			body, ctx, rows,
			emptyText: 'No orphaned attachments.',
			defaultSort: { column: 'size', direction: 'desc' },
			// rsp-wp6: one row per attachment file — the vault path is the natural key.
			rowKey: r => r.file.path,
			setCount: n => host.setSectionCount('orphanedAttachments', n),
			columns: [
				{ key: 'name', label: 'Name', sortable: true, sortKey: r => r.file.name.toLowerCase(), render: (r, td) => renderFileLink(host.app, td, r.file, r.file.name) },
				{ key: 'folder', label: 'Folder', sortable: true, sortKey: r => r.folder.toLowerCase(), render: (r, td) => td.setText(r.folder) },
				{ key: 'type', label: 'Type', sortable: true, sortKey: r => r.type, render: (r, td) => td.setText(r.type) },
				{ key: 'size', label: 'Size (KB)', sortable: true, sortKey: r => r.size, render: (r, td) => td.setText((r.size / 1024).toFixed(1)) },
				{ key: 'mtime', label: 'Modified', sortable: true, sortKey: r => r.mtime, render: (r, td) => td.setText(formatDateTime(r.mtime)) },
				{ key: 'delete', label: '', render: (r, td) => renderDeleteButton(host, td, r, ctx) },
			],
		});
	}

	function renderCleanupAllButton(heading: HTMLElement): void {
		const btn = heading.createEl('button', { text: 'Cleanup all', cls: 'crucible-ingestion-cleanup-all' });
		btn.addClass('mod-warning');
		btn.addEventListener('click', () => {
			void (async () => {
				const rows = orphanedAttachmentsCache;
				if (rows.length === 0) {
					new Notice('No orphaned attachments to clean up.');
					return;
				}
				const totalKb = rows.reduce((sum, r) => sum + r.size, 0) / 1024;
				const confirmed = await new ConfirmModal(host.app, {
					title: 'Cleanup orphaned attachments',
					message: `Trash ${rows.length} orphaned attachment${rows.length === 1 ? '' : 's'} (${totalKb.toFixed(1)} KB)? Files go to the vault's configured trash.`,
					confirmText: 'Trash all',
					destructive: true,
				}).openAndAwait();
				if (!confirmed) return;

				let failed = 0;
				for (const row of rows) {
					try {
						await host.app.fileManager.trashFile(row.file);
					} catch (e) {
						failed++;
						logWarn('cleanup: could not trash', row.file.path, e);
					}
				}
				const ok = rows.length - failed;
				new Notice(failed === 0 ? `Trashed ${ok} attachment${ok === 1 ? '' : 's'}.` : `Trashed ${ok}, ${failed} failed.`);
				void host.refresh('orphanedAttachments');
			})();
		});
	}

	return { render, renderCleanupAllButton };
}

function renderDeleteButton(host: DashboardHost, td: HTMLElement, row: OrphanRow, ctx: SectionContext): void {
	const btn = td.createEl('button', { text: 'Delete' });
	btn.addClass('mod-warning');
	btn.addEventListener('click', () => {
		void (async () => {
			if (!(await confirmDestructive(host.app, host.plugin.settings, 'orphaned-attachment-delete', {
				message: `Trash orphaned attachment "${row.file.name}"? It will go to the vault's configured trash.`,
			}))) return;
			btn.disabled = true;
			try {
				await host.app.fileManager.trashFile(row.file);
				new Notice(`Trashed ${row.file.name}`);
			} catch (e) {
				new Notice(`Failed to trash ${row.file.name}: ${e instanceof Error ? e.message : String(e)}`);
			}
			void ctx.refresh();
		})();
	});
}
