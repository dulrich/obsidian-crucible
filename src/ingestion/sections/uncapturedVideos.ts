import type { EnrichmentQueueItem } from '../../orchestration/EnrichmentQueueAdapter';
import { renderTableSection } from '../render/section';
import { renderEnrichedCell, renderFileLink, renderIgnoreButton, renderChannelLink, renderExternalLink } from '../render/cells';
import { displayLabel, formatDuration } from '../render/format';
import { computeUncapturedVideoRows } from '../data/uncaptured';
import type { DashboardHost, SectionContext, UncapturedVideoRow } from '../render/types';

export interface UncapturedVideosSection {
	render(body: HTMLElement, ctx: SectionContext): Promise<void>;
	// The enrichment auto-source: uncaptured videos without an enrichment file
	// yet, in the section's current sort order. Read by queueControls.ts via
	// DashboardHost#uncapturedQueueItems, so the cache lives here but stays
	// reachable from the host.
	uncapturedQueueItems(): EnrichmentQueueItem[];
}

// --- Section: Uncaptured Videos ---
export function createUncapturedVideosSection(host: DashboardHost): UncapturedVideosSection {
	let uncapturedVideosCache: UncapturedVideoRow[] = [];

	async function render(body: HTMLElement, ctx: SectionContext): Promise<void> {
		body.empty();
		body.createDiv({ cls: 'crucible-empty-state', text: 'Scanning…' });
		const rows = await computeUncapturedVideoRows(host.app, host.plugin);
		uncapturedVideosCache = rows;

		renderTableSection<UncapturedVideoRow>({
			body, ctx, rows,
			emptyText: 'No uncaptured videos.',
			defaultSort: { column: 'publishedAt', direction: 'desc' },
			setCount: n => host.setSectionCount('uncapturedVideos', n),
			columns: [
				{ key: 'channelName', label: 'Creator', sortable: true, sortKey: r => displayLabel(r.channelName).toLowerCase(), render: (r, td) => r.channelAboutFile ? renderFileLink(host.app, td, r.channelAboutFile, displayLabel(r.channelName)) : renderChannelLink(td, r.channelId, r.channelName) },
				{ key: 'title', label: 'Title', sortable: true, sortKey: r => r.title.toLowerCase(), render: (r, td) => td.setText(r.title) },
				{ key: 'publishedAt', label: 'Publish Date', sortable: true, sortKey: r => r.publishedAt, render: (r, td) => td.setText((r.publishedAt || '').slice(0, 10)) },
				{ key: 'duration', label: 'Duration', sortable: true, sortKey: r => r.durationSeconds ?? -1, render: (r, td) => td.setText(formatDuration(r.durationSeconds)) },
				{ key: 'watch', label: '', render: (r, td) => renderExternalLink(td, r.url, 'watch') },
				{ key: 'ignore', label: '', render: (r, td) => renderIgnoreButton(td, host.app, 'youtube', r.videoId, ctx, () => void host.refresh('ignoredVideos')) },
				{ key: 'enriched', label: 'Enriched?', render: (r, td) => renderEnrichedCell(td, host.plugin, r) },
			],
		});

		// Refresh the queue's auto-source so it stays aligned with current sort.
		if (host.plugin.enrichmentQueue?.isAutoEnabled()) {
			host.plugin.enrichmentQueue.setAutoSource(() => uncapturedQueueItems());
		}
	}

	function uncapturedQueueItems(): EnrichmentQueueItem[] {
		return uncapturedVideosCache
			.filter(r => !r.enrichmentFile)
			.map(r => ({
				videoId: r.videoId,
				title: r.title,
				channelName: r.channelName,
			}));
	}

	return { render, uncapturedQueueItems };
}
