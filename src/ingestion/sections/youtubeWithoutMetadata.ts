import { Notice } from 'obsidian';
import { computeRowSignature, renderTableSection, shouldRepaint } from '../render/section';
import { renderFileLink, renderIgnoreButton } from '../render/cells';
import { formatDate } from '../render/format';
import { computeYoutubeNoMetadataRows } from '../data/uncaptured';
import { computeMetadataFetchStatus } from '../data/metadataFetchStatus';
import type { DashboardHost, SectionContext, YoutubeNoMetadataRow } from '../render/types';

// --- Section: YouTube captures without metadata ---
export async function renderYoutubeNoMetadata(host: DashboardHost, body: HTMLElement, ctx: SectionContext): Promise<void> {
	const rows = await computeYoutubeNoMetadataRows(host.app);
	const inFlight = (await computeMetadataFetchStatus(host.plugin)).byPath;

	// P5: the enqueue-metadata cell reads inFlight's LIVE per-path status,
	// which doesn't live on YoutubeNoMetadataRow — fold each row's current
	// in-flight state (not the whole map, which also covers unrelated paths
	// outside this list) into the signature so a badge flip still repaints.
	const inFlightExtra = rows.map(r => inFlight.get(r.file.path) ?? null);
	if (!shouldRepaint(ctx, computeRowSignature(rows, inFlightExtra))) return;

	renderTableSection<YoutubeNoMetadataRow>({
		body, ctx, rows,
		emptyText: 'No captures awaiting metadata.',
		defaultSort: { column: 'created', direction: 'desc' },
		// rsp-wp6: one row per capture note — the vault path is the natural key.
		rowKey: r => r.file.path,
		setCount: n => host.setSectionCount('youtubeWithoutMetadata', n),
		columns: [
			{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => renderFileLink(host.app, td, r.file) },
			{ key: 'created', label: 'Create Date', sortable: true, sortKey: r => r.created, render: (r, td) => td.setText(formatDate(r.created)) },
			{ key: 'enqueue', label: '', render: (r, td) => renderEnqueueMetadataCell(host, td, r, inFlight) },
			{ key: 'ignore', label: '', render: (r, td) => renderIgnoreButton(td, host, 'youtube', r.videoId, 'youtubeWithoutMetadata', 'ignoredVideos', ctx) },
		],
	});
}

function renderEnqueueMetadataCell(host: DashboardHost, td: HTMLElement, row: YoutubeNoMetadataRow, inFlight: Map<string, 'queued' | 'running'>): void {
	const state = inFlight.get(row.file.path);
	if (state) {
		td.setText(state === 'running' ? 'running…' : 'queued');
		return;
	}
	const btn = td.createEl('button', { text: 'Enqueue metadata' });
	btn.addEventListener('click', () => {
		void (async () => {
			btn.disabled = true;
			// enqueueAndRun kicks the type's drain, so a manual enqueue runs
			// regardless of the Auto-enrich gate.
			const job = await host.plugin.orchestrationAutoRunner?.enqueueAndRun('youtube_metadata_fetch', {
				targetPath: row.file.path,
				videoId: row.videoId,
				title: row.title,
			}, { priority: 'high', lane: 'user', inputPaths: [row.file.path] });
			if (job) {
				btn.setText('Queued');
			} else {
				btn.disabled = false;
			}
		})();
	});
}

export function renderEnqueueAllMetadataButton(host: DashboardHost, heading: HTMLElement): void {
	const btn = heading.createEl('button', { text: 'Enqueue all', cls: 'crucible-ingestion-enqueue-intake' });
	btn.addEventListener('click', () => {
		void (async () => {
			btn.disabled = true;
			try {
				const rows = await computeYoutubeNoMetadataRows(host.app);
				if (rows.length === 0) {
					new Notice('No captures awaiting metadata.');
					return;
				}
				const inFlight = (await computeMetadataFetchStatus(host.plugin)).byPath;
				let enqueued = 0;
				// enqueueAndRun kicks the type's drain, so manual enqueues run
				// regardless of the Auto-enrich gate (repeat kicks no-op while the
				// drain is already in flight).
				for (const row of rows) {
					if (inFlight.has(row.file.path)) continue;
					const job = await host.plugin.orchestrationAutoRunner?.enqueueAndRun('youtube_metadata_fetch', {
						targetPath: row.file.path,
						videoId: row.videoId,
						title: row.title,
					}, { priority: 'high', lane: 'user', inputPaths: [row.file.path] });
					if (job) enqueued++;
				}
				new Notice(enqueued > 0 ? `Enqueued ${enqueued} metadata fetch${enqueued === 1 ? '' : 'es'}.` : 'Nothing to enqueue.');
			} finally {
				btn.disabled = false;
				void host.refresh('youtubeWithoutMetadata');
			}
		})();
	});
}
