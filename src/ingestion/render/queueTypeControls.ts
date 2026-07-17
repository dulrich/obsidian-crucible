import type CruciblePlugin from '../../main';
import type { JobType } from '../../orchestration/types';
import { readTypeAutorun, readTypeMinIntervalOverride, typeAutorunEnabled } from '../../orchestration/autorunGate';

// Compact per-type control strip for the Queue controls section: one row per
// registered job type (queued work or not, so vetoes and rate overrides are
// configurable while queues sit idle), with the type's auto-run toggle, its
// effective state (the drain gate's decision minus the readiness inputs, so
// display can never disagree with behavior), a rate-limit override, and a manual
// "Run" that drains the type's queued jobs regardless of the auto-run gate.
export function renderQueueTypeControls(
	plugin: CruciblePlugin,
	body: HTMLElement,
	types: JobType[],
	onAutorunChanged?: () => void,
): void {
	if (types.length === 0) return;
	const panel = body.createDiv({ cls: 'crucible-queue-type-controls' });
	panel.createEl('span', { cls: 'crucible-queue-type-controls-label', text: 'Per-type:' });
	for (const type of types.slice().sort()) renderTypeControl(plugin, panel, type, onAutorunChanged);
}

function renderTypeControl(
	plugin: CruciblePlugin,
	panel: HTMLElement,
	type: JobType,
	onAutorunChanged?: () => void,
): void {
	const row = panel.createSpan({ cls: 'crucible-queue-type-control' });
	const drainsWithoutAutorun = plugin.orchestrator.drainsWithoutAutorun(type);
	row.createSpan({ cls: 'crucible-queue-type-name', text: type });

	// Auto-run toggle, writing the per-type flag. Unset defaults: memory types off,
	// file types on (no veto; the global Autorun toggle still governs).
	const typeAutorun = () => readTypeAutorun(plugin.settings.orchestrationJobTypeControls, type);
	const toggleLabel = row.createEl('label', { cls: 'crucible-queue-type-toggle' });
	const toggle = toggleLabel.createEl('input', { type: 'checkbox' });
	toggleLabel.appendText(' auto');
	toggle.checked = drainsWithoutAutorun ? typeAutorun() === true : typeAutorun() !== false;

	const chip = row.createSpan({ cls: 'crucible-queue-type-autorun' });
	chip.title = drainsWithoutAutorun
		? 'Memory type: auto-runs only when its auto toggle is on.'
		: 'File type: auto-runs when its auto toggle and the global Autorun are both on.';
	const updateChip = () => {
		const on = typeAutorunEnabled({
			queueEnabled: plugin.settings.orchestrationQueueEnabled !== false,
			drainsWithoutAutorun,
			typeAutorun: typeAutorun(),
			globalAutorunEnabled: plugin.settings.orchestrationQueueAutorunEnabled === true,
		});
		chip.setText(on ? 'auto-run' : 'idle');
		chip.toggleClass('is-on', on);
		chip.toggleClass('is-off', !on);
	};
	updateChip();
	toggle.addEventListener('change', () => {
		void applyTypeAutorun(plugin, type, toggle.checked).then(() => {
			updateChip();
			onAutorunChanged?.();
		});
	});

	// Rate-limit override in seconds; blank = the type's configured cooloff (shown
	// as the placeholder). The drain loop reads the override live per job start.
	const rateLabel = row.createEl('label', { cls: 'crucible-queue-type-rate' });
	rateLabel.title = "Seconds between this type's job starts. Blank = the configured default.";
	const rate = rateLabel.createEl('input', { type: 'number' });
	rate.min = '0';
	rate.placeholder = String(plugin.orchestrator.getConfig(type).minIntervalMs / 1000);
	const override = readTypeMinIntervalOverride(plugin.settings.orchestrationJobTypeControls, type);
	if (override !== undefined) rate.value = String(override / 1000);
	rateLabel.appendText('s');
	rate.addEventListener('change', () => {
		const n = Number(rate.value);
		const ms = rate.value.trim() !== '' && Number.isFinite(n) && n >= 0 ? n * 1000 : undefined;
		void plugin.setJobTypeMinInterval(type, ms);
	});

	const runBtn = row.createEl('button', { cls: 'crucible-queue-type-run', text: 'Run' });
	runBtn.title = "Run this type's queued jobs now, regardless of the auto-run toggles.";
	runBtn.addEventListener('click', () => {
		plugin.orchestrationAutoRunner?.runType(type);
	});
}

// The enrichment type's auto-run is owned by the Auto-enrich control (the legacy
// flag and the live queue's enabled state move with it); every other type writes
// its per-type flag directly.
function applyTypeAutorun(plugin: CruciblePlugin, type: JobType, enabled: boolean): Promise<void> {
	if (type === 'youtube_metadata_fetch') return plugin.setAutoEnrichEnabled(enabled);
	return plugin.setJobTypeAutorun(type, enabled);
}
