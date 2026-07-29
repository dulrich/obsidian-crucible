import { renderQueueTypeControls } from '../render/queueTypeControls';
import { refreshWithScrollPreserved } from '../render/refresh';
import type { DashboardHost, SectionContext } from '../render/types';

// The Queue Configuration section: the per-type auto-run (drain/execution) and rate
// controls for every registered job type, in one default-collapsed card, so per-type
// gates and rate overrides are configurable while the queues sit idle. This is
// EXECUTION control only — the queue-wide Enabled master lives in Queue monitor, and
// automatically *enqueueing* jobs (e.g. enrichment from Uncaptured Videos) is a
// separate control at its own feature site. Settings-driven, so it renders once at
// build and re-renders only from its own handlers (and the Queue monitor panic
// switch) — never from queue events, which would clobber a mid-edit rate input.
export function buildQueueControlsSection(host: DashboardHost): void {
	const card = host.container.createDiv({ cls: 'crucible-settings-group crucible-ingestion-section' });
	const { countEl, metaEl } = host.createSectionHeader(
		card,
		'Queue Configuration',
		'Per-type auto-run and rate limits.',
		true,
	);
	const body = card.createDiv({ cls: 'crucible-ingestion-section-body' });

	const ctx: SectionContext = {
		id: 'queueControls',
		title: 'Queue Configuration',
		description: '',
		body,
		countEl,
		metaEl,
		sort: null,
		// See render/refresh.ts / AGENTS.md #5: SectionContext.refresh is itself the
		// scroll-preserving wrapped function so every call site is covered for free.
		refresh: () => refreshWithScrollPreserved(body, () => renderQueueControls(host, body)),
	};
	host.registerSection(ctx);
	renderQueueControls(host, body);
}

function renderQueueControls(host: DashboardHost, body: HTMLElement): void {
	body.empty();
	// Every registered type, uniform: auto-run toggle + effective chip + rate override.
	// Each row updates its own chip; the queue-wide Enabled switch re-renders the whole
	// section via refresh('queueControls'), so no cross-row callback is needed here.
	renderQueueTypeControls(host.plugin, body, host.plugin.orchestrator.jobTypes());
}
