import { Notice } from 'obsidian';
import { renderChannelLink, renderExternalLink, renderFileLink } from '../render/cells';
import { renderControlCenter, type ControlCenterFilter } from '../render/controlCenter';
import { computeRowSignature, shouldRepaint } from '../render/section';
import { computeBlogControlRows } from '../data/blogs';
import { computeChannelControlRows } from '../data/channels';
import { countWithPct, ratio } from '../render/format';
import type { BlogControlRow, ChannelControlRow, DashboardHost, SectionContext } from '../render/types';

export interface ControlCentersSection {
	renderBlogControl(body: HTMLElement, ctx: SectionContext): Promise<void>;
	renderChannelControl(body: HTMLElement, ctx: SectionContext): Promise<void>;
	renderEnrichAllChannelsButton(heading: HTMLElement): void;
}

// Blog + Channel control centers: every known blog/channel with tracked /
// ingested / ignored counts, filterable by tracked status.
export function createControlCentersSection(host: DashboardHost): ControlCentersSection {
	// Blog control center filter: which blogs to list.
	let blogFilter: ControlCenterFilter = 'all';
	// Channel control center filter: which channels to list.
	let channelFilter: ControlCenterFilter = 'all';

	// --- Section: Blog control center ---
	async function renderBlogControl(body: HTMLElement, ctx: SectionContext): Promise<void> {
		// Compute-then-paint: await the scan before touching the DOM. renderControlCenter
		// (unlike renderTableSection) does not clear `body` itself — it appends its filter
		// row and table onto whatever is already there — so the single explicit clear right
		// below stays as the one and only teardown, now happening after the scan resolves
		// instead of before it. A throw here leaves the previous render intact.
		const all = await computeBlogControlRows(host.app, host.plugin);
		// P5: the check must run BEFORE body.empty() — unlike renderTableSection's
		// internal self-contained teardown, this section's only DOM clear is the
		// explicit call right below, so gating after it would still blank the
		// section on a skip. (A filter-button click is always a forced pass —
		// see cells.ts/controlCenter.ts's `ctx.refresh()` — so it doesn't need to
		// be folded into the signature here; it always repaints regardless.)
		if (!shouldRepaint(ctx, computeRowSignature(all))) return;
		body.empty();

		renderControlCenter<BlogControlRow>({
			body, ctx, rows: all,
			filter: blogFilter,
			setFilter: filter => { blogFilter = filter; },
			emptyText: 'No blogs match this filter.',
			defaultSort: { column: 'name', direction: 'asc' },
			setCount: n => host.setSectionCount('blogControl', n),
			columns: [
				{ key: 'name', label: 'Blog', sortable: true, sortKey: r => r.name.toLowerCase(), render: (r, td) => r.link ? renderExternalLink(td, r.link, r.name) : td.setText(r.name) },
				{ key: 'tracked', label: 'Posts', sortable: true, sortKey: r => r.trackedPosts, render: (r, td) => td.setText(String(r.trackedPosts)) },
				{ key: 'ingested', label: 'Ingested', sortable: true, sortKey: r => ratio(r.ingestedPosts, r.trackedPosts), render: (r, td) => td.setText(countWithPct(r.ingestedPosts, r.trackedPosts)) },
				{ key: 'ignored', label: 'Ignored', sortable: true, sortKey: r => ratio(r.ignoredPosts, r.trackedPosts), render: (r, td) => td.setText(countWithPct(r.ignoredPosts, r.trackedPosts)) },
				{ key: 'uncaptured', label: 'Uncaptured', sortable: true, sortKey: r => ratio(r.uncapturedPosts, r.trackedPosts), render: (r, td) => td.setText(countWithPct(r.uncapturedPosts, r.trackedPosts)) },
				{ key: 'isTracked', label: 'Tracked?', sortable: true, sortKey: r => r.tracked ? 1 : 0, render: (r, td) => td.setText(r.tracked ? 'yes' : 'no') },
			],
		});
	}

	// --- Section: Channel control center ---
	async function renderChannelControl(body: HTMLElement, ctx: SectionContext): Promise<void> {
		// Compute-then-paint — see renderBlogControl's comment above; same shape.
		const all = await computeChannelControlRows(host.app, host.plugin);
		// P5: same reasoning as renderBlogControl — check before the only DOM clear.
		if (!shouldRepaint(ctx, computeRowSignature(all))) return;
		body.empty();

		renderControlCenter<ChannelControlRow>({
			body, ctx, rows: all,
			filter: channelFilter,
			setFilter: filter => { channelFilter = filter; },
			emptyText: 'No channels match this filter.',
			defaultSort: { column: 'name', direction: 'asc' },
			setCount: n => host.setSectionCount('channelControl', n),
			columns: [
				{ key: 'name', label: 'Channel', sortable: true, sortKey: r => r.name.toLowerCase(), render: (r, td) => r.aboutFile ? renderFileLink(host.app, td, r.aboutFile, r.name) : renderChannelLink(td, r.channelId, r.name) },
				{ key: 'tracked', label: 'Videos', sortable: true, sortKey: r => r.trackedVideos, render: (r, td) => td.setText(String(r.trackedVideos)) },
				{ key: 'ingested', label: 'Ingested', sortable: true, sortKey: r => ratio(r.ingestedVideos, r.trackedVideos), render: (r, td) => td.setText(countWithPct(r.ingestedVideos, r.trackedVideos)) },
				{ key: 'ignored', label: 'Ignored', sortable: true, sortKey: r => ratio(r.ignoredVideos, r.trackedVideos), render: (r, td) => td.setText(countWithPct(r.ignoredVideos, r.trackedVideos)) },
				{ key: 'uncaptured', label: 'Uncaptured', sortable: true, sortKey: r => ratio(r.uncapturedVideos, r.trackedVideos), render: (r, td) => td.setText(countWithPct(r.uncapturedVideos, r.trackedVideos)) },
				{ key: 'isTracked', label: 'Tracked?', sortable: true, sortKey: r => r.tracked ? 1 : 0, render: (r, td) => td.setText(r.tracked ? 'yes' : 'no') },
				{ key: 'enrich', label: '', render: (r, td) => renderChannelEnrichButton(host, td, r, ctx) },
			],
		});
	}

	function renderEnrichAllChannelsButton(heading: HTMLElement): void {
		const btn = heading.createEl('button', { text: 'Enrich all', cls: 'crucible-ingestion-enqueue-intake' });
		btn.addEventListener('click', () => {
			void (async () => {
				btn.disabled = true;
				try {
					const job = await host.plugin.orchestrator.enqueue('youtube_channel_enrich_sweep', {}, { priority: 'high', lane: 'user' });
					new Notice(job ? 'Enqueued channel enrichment sweep.' : 'Channel enrichment sweep already queued.');
				} finally {
					btn.disabled = false;
					void host.refresh('channelControl');
				}
			})();
		});
	}

	return { renderBlogControl, renderChannelControl, renderEnrichAllChannelsButton };
}

function renderChannelEnrichButton(host: DashboardHost, td: HTMLElement, row: ChannelControlRow, ctx: SectionContext): void {
	const btn = td.createEl('button', { text: row.aboutFile ? 'Re-enrich' : 'Enrich' });
	btn.addEventListener('click', () => {
		void (async () => {
			btn.disabled = true;
			const job = await host.plugin.orchestrator.enqueue('youtube_channel_enrich', {
				channelId: row.channelId,
				force: true,
			}, { priority: 'high', lane: 'user' });
			if (job) {
				btn.setText('Queued');
				new Notice(`Enqueued channel enrichment for ${row.name}.`);
			} else {
				btn.disabled = false;
			}
			void ctx.refresh();
		})();
	});
}
