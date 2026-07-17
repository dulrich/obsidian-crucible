import { Notice } from 'obsidian';
import { renderTableSection } from '../render/section';
import { renderFileLink, renderIgnoreButton } from '../render/cells';
import { formatDate } from '../render/format';
import { computeYoutubeNoMetadataRows } from '../data/uncaptured';
import type { DashboardHost, SectionContext, YoutubeNoMetadataRow } from '../render/types';

// youtube_metadata_fetch now runs in the unified queue's in-memory path, so
// in-flight state comes from the enrichment adapter (target note path → status)
// rather than scanning the file-backed job folders.
function youtubeMetadataInFlight(host: DashboardHost): Map<string, 'queued' | 'running'> {
	return host.plugin.enrichmentQueue?.metadataInFlightByPath() ?? new Map();
}

// --- Section: YouTube captures without metadata ---
export async function renderYoutubeNoMetadata(host: DashboardHost, body: HTMLElement, ctx: SectionContext): Promise<void> {
	const rows = await computeYoutubeNoMetadataRows(host.app);
	const inFlight = youtubeMetadataInFlight(host);

	renderTableSection<YoutubeNoMetadataRow>({
		body, ctx, rows,
		emptyText: 'No captures awaiting metadata.',
		defaultSort: { column: 'created', direction: 'desc' },
		setCount: n => host.setSectionCount('youtubeWithoutMetadata', n),
		columns: [
			{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => renderFileLink(host.app, td, r.file) },
			{ key: 'created', label: 'Create Date', sortable: true, sortKey: r => r.created, render: (r, td) => td.setText(formatDate(r.created)) },
			{ key: 'enqueue', label: '', render: (r, td) => renderEnqueueMetadataCell(host, td, r, inFlight) },
			{ key: 'ignore', label: '', render: (r, td) => renderIgnoreButton(td, host.app, 'youtube', r.videoId, ctx, () => void host.refresh('ignoredVideos')) },
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
			const job = await host.plugin.orchestrationAutoRunner.enqueueAndRun('youtube_metadata_fetch', {
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
				const inFlight = youtubeMetadataInFlight(host);
				let enqueued = 0;
				// enqueueAndRun kicks the type's drain, so manual enqueues run
				// regardless of the Auto-enrich gate (repeat kicks no-op while the
				// drain is already in flight).
				for (const row of rows) {
					if (inFlight.has(row.file.path)) continue;
					const job = await host.plugin.orchestrationAutoRunner.enqueueAndRun('youtube_metadata_fetch', {
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
