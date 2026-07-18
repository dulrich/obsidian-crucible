import type CruciblePlugin from '../../main';
import type { JobType } from '../../orchestration/types';
import { readTypeAutorun, readTypeMinIntervalOverride, typeAutorunEnabled } from '../../orchestration/autorunGate';

// Per-type control cards for the Queue Configuration section: one card per
// registered job type (queued work or not, so auto-run and rate overrides are
// configurable while queues sit idle), with the type's auto-run (drain/execution)
// toggle, its effective state (the drain gate's decision minus the readiness
// inputs, so display can never disagree with behavior), and a rate-limit override.
// This is EXECUTION control only — automatically enqueueing a type is a separate
// concern owned elsewhere (e.g. the enrichment auto-source). Manual per-job Run
// lives on the Queue Monitor rows.
export function renderQueueTypeControls(
	plugin: CruciblePlugin,
	body: HTMLElement,
	types: JobType[],
	onAutorunChanged?: () => void,
): void {
	if (types.length === 0) return;
	const panel = body.createDiv({ cls: 'crucible-queue-type-controls' });
	for (const type of types.slice().sort()) renderTypeControl(plugin, panel, type, onAutorunChanged);
}

function renderTypeControl(
	plugin: CruciblePlugin,
	panel: HTMLElement,
	type: JobType,
	onAutorunChanged?: () => void,
): void {
	const row = panel.createDiv({ cls: 'crucible-queue-type-control' });
	row.createSpan({ cls: 'crucible-queue-type-name', text: type });

	// Auto-run (drain) toggle, writing the per-type flag. Uniform for every type:
	// unset ⇒ idle (opt-in), so the checkbox is checked only when the flag is true.
	const typeAutorun = () => readTypeAutorun(plugin.settings.orchestrationJobTypeControls, type);
	const toggleLabel = row.createEl('label', { cls: 'crucible-queue-type-toggle' });
	const toggle = toggleLabel.createEl('input', { type: 'checkbox' });
	toggleLabel.appendText(' auto');
	toggle.checked = typeAutorun() === true;

	const chip = row.createSpan({ cls: 'crucible-queue-type-autorun' });
	chip.title = 'Auto-runs when both this toggle and the queue are enabled.';
	const updateChip = () => {
		const on = typeAutorunEnabled({
			queueEnabled: plugin.settings.orchestrationQueueEnabled !== false,
			drainsWithoutAutorun: plugin.orchestrator.drainsWithoutAutorun(type),
			typeAutorun: typeAutorun(),
		});
		chip.setText(on ? 'auto-run' : 'idle');
		chip.toggleClass('is-on', on);
		chip.toggleClass('is-off', !on);
	};
	updateChip();
	toggle.addEventListener('change', () => {
		void plugin.setJobTypeAutorun(type, toggle.checked).then(() => {
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
}
