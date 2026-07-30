import type { EnrichmentQueueItem } from '../../orchestration/EnrichmentQueueAdapter';
import { renderTableSection } from '../render/section';
import { renderEnrichedCell, renderFileLink, renderIgnoreButton, renderChannelLink, renderExternalLink } from '../render/cells';
import { displayLabel, formatDuration } from '../render/format';
import { computeUncapturedVideoRows } from '../data/uncaptured';
import type { DashboardHost, SectionContext, UncapturedVideoRow } from '../render/types';

export interface UncapturedVideosSection {
	render(body: HTMLElement, ctx: SectionContext): Promise<void>;
	// The enrichment auto-source: uncaptured videos without an enrichment file
	// yet, in the section's current sort order. The cache lives here but stays
	// reachable from the host (DashboardHost#uncapturedQueueItems).
	uncapturedQueueItems(): EnrichmentQueueItem[];
	// Renders the Auto-enqueue (source) toggle into the section header — the control
	// that governs whether uncaptured videos are automatically enqueued for metadata
	// enrichment. Draining those jobs is a separate control (Queue Configuration).
	renderAutoEnqueueToggle(heading: HTMLElement): void;
}

// --- Section: Uncaptured Videos ---
export function createUncapturedVideosSection(host: DashboardHost): UncapturedVideosSection {
	let uncapturedVideosCache: UncapturedVideoRow[] = [];

	// Re-assert the auto-source enable from the persisted setting on load: the queue's
	// autoSourceEnabled flag is runtime-only, and the auto-source is dashboard-owned,
	// so nothing else turns it back on when the dashboard mounts.
	if (host.plugin.settings.ingestionYoutubeAutoEnqueueEnabled === true) {
		void host.plugin.setEnrichmentAutoEnqueue(true, () => uncapturedQueueItems());
	}

	async function render(body: HTMLElement, ctx: SectionContext): Promise<void> {
		// Compute-then-paint: the previous shape blanked the body to "Scanning…"
		// before awaiting the whole-vault scan below, so even a single perfectly-
		// coalesced render produced a visible flash. Await the scan first and let
		// renderTableSection empty the body itself (below), immediately before it
		// rebuilds — not a scan's-worth of time before that. Mirrors queueMonitor.ts's
		// renderQueueMonitor (see its rationale comment). If the scan throws, nothing
		// here has torn down the body yet, so the previous render stays on screen
		// instead of being left blank.
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
				{ key: 'ignore', label: '', render: (r, td) => renderIgnoreButton(td, host, 'youtube', r.videoId, 'uncapturedVideos', 'ignoredVideos', ctx) },
				{ key: 'enriched', label: 'Enriched?', render: (r, td) => renderEnrichedCell(td, host.plugin, r) },
			],
		});

		// Refresh the queue's auto-source so it stays aligned with current sort.
		if (host.plugin.enrichmentQueue?.isAutoSourceEnabled()) {
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

	function renderAutoEnqueueToggle(heading: HTMLElement): void {
		const label = heading.createEl('label', { cls: 'crucible-ingestion-queue-toggle crucible-ingestion-header-toggle' });
		const toggle = label.createEl('input', { type: 'checkbox' });
		toggle.checked = host.plugin.settings.ingestionYoutubeAutoEnqueueEnabled === true;
		label.appendText(' Auto-enqueue enrichment');
		label.title = 'Automatically enqueues metadata fetches for uncaptured videos. Draining them is a separate per-type control.';
		toggle.addEventListener('change', () => {
			void host.plugin.setEnrichmentAutoEnqueue(toggle.checked, () => uncapturedQueueItems());
		});
	}

	return { render, uncapturedQueueItems, renderAutoEnqueueToggle };
}
