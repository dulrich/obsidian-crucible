import { renderQueueTypeControls } from '../render/queueTypeControls';
import type { DashboardHost, SectionContext } from '../render/types';

// The Queue controls section: every global and per-type auto-run/rate control
// in one default-collapsed card, so per-type vetoes and rate overrides are
// configurable while the queues sit idle. Settings-driven, so it renders once
// at build and re-renders only from its own handlers (and the Queue monitor
// panic switch) — never from queue events, which would clobber a mid-edit
// rate input.
export function buildQueueControlsSection(host: DashboardHost): void {
	const card = host.container.createDiv({ cls: 'crucible-settings-group crucible-ingestion-section' });
	const { countEl, metaEl } = host.createSectionHeader(
		card,
		'Queue controls',
		'Auto-run toggles and rate limits, global and per job type.',
		true,
	);
	const body = card.createDiv({ cls: 'crucible-ingestion-section-body' });

	const ctx: SectionContext = {
		id: 'queueControls',
		title: 'Queue controls',
		description: '',
		body,
		countEl,
		metaEl,
		sort: null,
		refresh: () => renderQueueControls(host, body),
	};
	host.registerSection(ctx);
	renderQueueControls(host, body);

	// Enable + push the initial auto-source if Auto-enrich is on. Both are required:
	// MemoryJobQueue.refill() no-ops unless autoEnabled AND autoSource are set, and
	// nothing else enables the queue on load — without this the box reads ON but
	// enrichment stays idle until the toggle is cycled off/on.
	if (host.plugin.settings.ingestionYoutubeAutoEnrichEnabled === true) {
		void host.plugin.setAutoEnrichEnabled(true, () => host.uncapturedQueueItems());
	}
}

function renderQueueControls(host: DashboardHost, body: HTMLElement): void {
	body.empty();
	const controls = body.createDiv({ cls: 'crucible-ingestion-queue-controls' });

	// --- Orchestrator controls ---
	const autorunLabel = controls.createEl('label', { cls: 'crucible-ingestion-queue-toggle' });
	const autorunToggle = autorunLabel.createEl('input', { type: 'checkbox' });
	autorunToggle.checked = host.plugin.settings.orchestrationQueueAutorunEnabled === true;
	autorunLabel.appendText(' Autorun');
	autorunToggle.addEventListener('change', () => {
		void (async () => {
			host.plugin.settings.orchestrationQueueAutorunEnabled = autorunToggle.checked;
			await host.plugin.saveSettings();
			host.plugin.orchestrationAutoRunner?.setEnabled(autorunToggle.checked);
			// Global Autorun feeds every file type's chip; re-render the strip.
			renderQueueControls(host, body);
		})();
	});

	const runNextBtn = controls.createEl('button', { text: 'Run next', cls: 'crucible-ingestion-run-next' });
	runNextBtn.addEventListener('click', () => {
		void host.plugin.orchestrationAutoRunner?.runOnce();
	});

	// --- Enrichment queue controls ---
	const enrichToggleLabel = controls.createEl('label', { cls: 'crucible-ingestion-queue-toggle' });
	const enrichToggle = enrichToggleLabel.createEl('input', { type: 'checkbox' });
	enrichToggle.checked = host.plugin.settings.ingestionYoutubeAutoEnrichEnabled === true;
	enrichToggleLabel.appendText(' Auto enrich from Uncaptured Videos');
	// setAutoEnrichEnabled owns the flag sync (legacy flag, per-type auto-run,
	// live queue enable); the dashboard supplies its sort-following auto-source.
	enrichToggle.addEventListener('change', () => {
		void host.plugin
			.setAutoEnrichEnabled(enrichToggle.checked, () => host.uncapturedQueueItems())
			// The enrichment type's chip in the strip reflects the same flag.
			.then(() => renderQueueControls(host, body));
	});

	const rateLabel = controls.createEl('label', { cls: 'crucible-ingestion-queue-rate' });
	rateLabel.appendText('Rate limit (seconds): ');
	const rateInput = rateLabel.createEl('input', { type: 'number' });
	rateInput.value = String(host.plugin.settings.ingestionYoutubeEnrichRateLimitSeconds);
	rateInput.min = '0';
	rateInput.addClass('pi-width-small');
	rateInput.addEventListener('change', () => {
		void (async () => {
			const n = Number(rateInput.value);
			const next = Number.isFinite(n) && n >= 0 ? n : 2;
			host.plugin.settings.ingestionYoutubeEnrichRateLimitSeconds = next;
			await host.plugin.saveSettings();
			// The metadata queue's gate reads ingestionYoutubeEnrichRateLimitSeconds
			// live, so saving the setting is all that's needed.
		})();
	});

	// Per-type strip for every registered type. When it flips the enrichment
	// type's auto-run, reassert the dashboard's auto-source (the strip can't
	// supply one, and refill no-ops without it), then re-render so the
	// Auto-enrich checkbox and every chip stay in sync.
	renderQueueTypeControls(host.plugin, body, host.plugin.orchestrator.jobTypes(), () => {
		if (host.plugin.enrichmentQueue?.isAutoEnabled()) {
			host.plugin.enrichmentQueue.setAutoSource(() => host.uncapturedQueueItems());
		}
		renderQueueControls(host, body);
	});
}
