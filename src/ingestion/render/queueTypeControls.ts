import type CruciblePlugin from '../../main';
import type { JobType } from '../../orchestration/types';
import {
	readTypeAutorun,
	readTypeMaxParallelOverride,
	readTypeMinIntervalOverride,
	resolveMaxParallel,
	typeAutorunEnabled,
} from '../../orchestration/autorunGate';

// Per-type controls for the Queue Configuration section: one row per registered job
// type (queued work or not, so auto-run, rate and concurrency overrides are
// configurable while queues sit idle), with the type's auto-run (drain/execution)
// toggle, its effective state (the drain gate's decision minus the readiness inputs,
// so display can never disagree with behavior), a rate-limit override and a worker
// count. This is EXECUTION control only — automatically enqueueing a type is a
// separate concern owned elsewhere (e.g. the enrichment auto-source). Manual per-job
// Run and Cancel live on the Queue Monitor rows.
//
// **One full-width table, not a grid of per-type cards.** The old layout flowed each
// card's controls inline after a monospace type name, and type names run from
// `chain_run` (9 characters) to `youtube_channel_enrich_sweep` (28) — so every card
// placed its controls at a different x, and two-up above the breakpoint a long name
// wrapped the controls onto a second line in some cards but not others. Fixed column
// tracks fix the alignment, but the headers that make a numeric column legible (what
// unit? seconds? what does a blank mean?) cannot survive being repeated in two
// side-by-side card columns at this width — five tracks including a 28-character
// monospace name do not fit in half of the 52rem clamp. So the two-column breakpoint
// goes and the header row stays, which is the trade the plan asks for by name.
export function renderQueueTypeControls(
	plugin: CruciblePlugin,
	body: HTMLElement,
	types: JobType[],
	onAutorunChanged?: () => void,
): void {
	if (types.length === 0) return;
	const panel = body.createDiv({ cls: 'crucible-queue-type-controls' });
	renderHeaderRow(panel);
	for (const type of types.slice().sort()) renderTypeControl(plugin, panel, type, onAutorunChanged);

	// The ceiling worth naming, because neither number alone predicts throughput: the
	// per-type worker count is bounded by the global cap, and the search types push a
	// single-threaded companion, so the curve flattens well before the number does.
	const cap = Math.max(1, plugin.settings.orchestrationMaxConcurrent || 1);
	body.createDiv({
		cls: 'crucible-queue-type-hint',
		text: `Workers are per type; the global cap (${cap} concurrent) still bounds every type together, so raising one `
			+ 'type above it buys nothing. The search types issue their concurrent work at one single-threaded companion '
			+ 'over a single SQLite database, so returns flatten quickly. Blank means the type\'s configured default.',
	});
}

// Header cells are what make the numeric columns legible. Before this the units lived
// only in per-control `title` tooltips and a trailing "s" glyph, which is not
// discoverable — you had to hover a control to learn what it measured.
function renderHeaderRow(panel: HTMLElement): void {
	const row = panel.createDiv({ cls: 'crucible-queue-type-header' });
	row.createSpan({ cls: 'crucible-queue-type-th', text: 'Type' });
	row.createSpan({ cls: 'crucible-queue-type-th', text: 'Auto' });
	row.createSpan({ cls: 'crucible-queue-type-th', text: 'State' });
	const rate = row.createSpan({ cls: 'crucible-queue-type-th is-numeric', text: 'Rate (s)' });
	rate.title = "Seconds between this type's job starts.";
	const workers = row.createSpan({ cls: 'crucible-queue-type-th is-numeric', text: 'Workers' });
	workers.title = 'How many jobs of this type drain in parallel, within the global concurrency cap.';
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
	toggle.checked = typeAutorun() === true;
	toggleLabel.title = 'Auto-run (drain) this type.';

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
	const rateCell = row.createDiv({ cls: 'crucible-queue-type-cell is-numeric' });
	const rate = rateCell.createEl('input', { type: 'number', cls: 'crucible-queue-type-num' });
	rate.min = '0';
	rate.placeholder = String(plugin.orchestrator.getConfig(type).minIntervalMs / 1000);
	rate.title = "Seconds between this type's job starts. Blank = the configured default.";
	const override = readTypeMinIntervalOverride(plugin.settings.orchestrationJobTypeControls, type);
	if (override !== undefined) rate.value = String(override / 1000);
	rate.addEventListener('change', () => {
		const n = Number(rate.value);
		const ms = rate.value.trim() !== '' && Number.isFinite(n) && n >= 0 ? n * 1000 : undefined;
		void plugin.setJobTypeMinInterval(type, ms);
	});

	renderConcurrencyCell(plugin, row, type);
}

function renderConcurrencyCell(plugin: CruciblePlugin, row: HTMLElement, type: JobType): void {
	const cell = row.createDiv({ cls: 'crucible-queue-type-cell is-numeric' });
	const config = plugin.orchestrator.getConfig(type);
	const cap = Math.max(1, plugin.settings.orchestrationMaxConcurrent || 1);

	// A pinned type states the constraint as what it is — a property of the job type,
	// carrying its own reason — rather than as a disabled input, which reads as a bug
	// or as something the user is failing to unlock.
	if (config.maxParallelFixed) {
		const pill = cell.createSpan({ cls: 'crucible-queue-type-serial', text: 'serial' });
		pill.title = `This type always runs one job at a time. ${config.maxParallelFixed}`;
		return;
	}

	const input = cell.createEl('input', { type: 'number', cls: 'crucible-queue-type-num' });
	input.min = '1';
	input.placeholder = String(Math.max(1, config.maxParallel));
	const stored = readTypeMaxParallelOverride(plugin.settings.orchestrationJobTypeControls, type);
	if (stored !== undefined) input.value = String(stored);
	// The effective value, not just whatever was typed: the override, the config
	// default it replaces, and the global cap that bounds them both.
	const describe = () => {
		const effective = resolveMaxParallel(config, plugin.settings.orchestrationJobTypeControls, type);
		input.title = `Jobs of this type in parallel. Blank = the configured default (${Math.max(1, config.maxParallel)}). `
			+ `Effective now: ${effective}, within a global cap of ${cap} in flight across all types.`;
	};
	describe();
	input.addEventListener('change', () => {
		const n = Number(input.value);
		const workers = input.value.trim() !== '' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
		if (workers === undefined) input.value = '';
		void plugin.setJobTypeMaxParallel(type, workers).then(describe);
	});
}
