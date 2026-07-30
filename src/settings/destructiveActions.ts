import { App } from "obsidian";
import { ConfirmModal } from "../confirmModal";
import { CrucibleSettings } from "../types";
import { logWarn } from "../log";

/**
 * clsl-WP-3: destructive-action confirmation framework.
 *
 * This module is the FRAMEWORK only — the registry, the resolution helper, and the
 * `confirmDestructive` wrapper around the existing `ConfirmModal`. It does not touch any
 * existing delete handler; wiring each audited call site through `confirmDestructive` is
 * WP-4 (a separate work package). See `plans/confirmations-lint-steps-search-latch.md`.
 *
 * New destructive control ⇒ register an action id here + route it through
 * `confirmDestructive`. Never reach for a bare `ConfirmModal` in settings code — going
 * around this registry means the user's global/tier/action suppression settings are
 * silently ignored for that one control.
 */

export type DestructiveTier = 'critical' | 'high' | 'medium' | 'low';

export interface DestructiveAction {
	id: string;
	label: string;
	tier: DestructiveTier;
	/** UI grouping label — the settings tab/section the control lives in (e.g. 'Automate', 'AI'). */
	group: string;
}

/**
 * The registry, from the completed audit in `plans/confirmations-lint-steps-search-latch.md`.
 * File:line references are evidence for WP-4's retrofit, not load-bearing here — they will
 * drift as call sites move; treat them as "where to look", not a contract.
 *
 * Deliberately NOT registered (do not add): the three "Clear cache" buttons (rebuildable by
 * design, not destructive) and Ignore/Unignore in the Ingestion Dashboard (reversible paired
 * buttons, not a one-way delete).
 */
export const DESTRUCTIVE_ACTIONS: DestructiveAction[] = [
	// --- critical ---
	// clsl-WP-4: file:line comments below point at the actual `confirmDestructive('<id>', …)`
	// call site(s) as of the WP-4 retrofit landing — refreshed from the pre-retrofit audit
	// evidence. Still "where to look, not a contract": they will drift again as call sites move.
	{ id: 'chain-delete', label: 'Delete chain', tier: 'critical', group: 'Automate' }, // automate.ts:187
	{ id: 'capture-delete', label: 'Delete capture', tier: 'critical', group: 'Automate' }, // automate.ts:61 — deleteCapture(), shared by both entry points (list row + edit-form button)
	{ id: 'agent-delete', label: 'Delete agent', tier: 'critical', group: 'AI' }, // ai.ts:915 — deleteAgent(), shared by both entry points (list row + edit-form button)
	{ id: 'trigger-delete', label: 'Delete trigger', tier: 'critical', group: 'Automate' }, // triggers.ts:122 — deleteTrigger(), shared by both entry points (list row + edit-form button)
	{ id: 'provider-delete', label: 'Delete provider', tier: 'critical', group: 'AI' }, // ai.ts:125 — deleteProvider(), migrated off its bare-ConfirmModal exemplar in WP-4

	// --- high ---
	{ id: 'api-key-clear', label: 'Clear API key', tier: 'high', group: 'AI' }, // shared.ts:122 (mountSecretControl) — one mount covers provider keys (ai.ts) + YouTube (orchestration.ts)
	{ id: 'chain-step-delete', label: 'Delete chain step', tier: 'high', group: 'Automate' }, // automate.ts:312 — the misclick-geometry one
	{ id: 'trigger-guard-condition-delete', label: 'Delete trigger guard condition', tier: 'high', group: 'Automate' }, // triggers.ts:216
	{ id: 'orphaned-attachment-delete', label: 'Delete orphaned attachment', tier: 'high', group: 'Dashboard' }, // ingestion/sections/orphanedAttachments.ts:82
	{ id: 'lint-vault-run', label: 'Run Lint: all on vault', tier: 'high', group: 'Lint' }, // lint.ts:49 — bulk mutation
	{ id: 'localize-vault-run', label: 'Run Localize attachments on vault', tier: 'high', group: 'Lint' }, // localize.ts:112 — bulk mutation

	// --- medium ---
	{ id: 'chain-variable-delete', label: 'Delete chain variable', tier: 'medium', group: 'Automate' }, // automate.ts:265
	{ id: 'provider-model-delete', label: 'Delete provider model', tier: 'medium', group: 'AI' }, // ai.ts:544
	{ id: 'guard-condition-value-delete', label: 'Delete guard condition value', tier: 'medium', group: 'Automate' }, // guardConditionFields.ts:269
	{ id: 'lint-excluded-folder-delete', label: 'Delete lint excluded folder', tier: 'medium', group: 'Lint' }, // lint.ts:113

	// --- low ---
	{ id: 'folder-template-delete', label: 'Delete folder template', tier: 'low', group: 'Configure' }, // configure.ts:87
	{ id: 'pinned-folder-delete', label: 'Delete pinned folder', tier: 'low', group: 'Configure' }, // configure.ts:251
	{ id: 'shortcut-delete', label: 'Delete shortcut', tier: 'low', group: 'Automate' }, // automate.ts:560
	{ id: 'pinned-command-delete', label: 'Delete pinned command', tier: 'low', group: 'Commands' }, // settings/sections/commands.ts:460
	{ id: 'palette-list-entry-delete', label: 'Delete palette list entry', tier: 'low', group: 'Commands' }, // settings/sections/commands.ts:523
	{ id: 'constrained-binding-model-delete', label: 'Delete constrained-binding model', tier: 'low', group: 'AI' }, // ai.ts:1200
	{ id: 'fx-pair-delete', label: 'Delete FX pair', tier: 'low', group: 'Orchestrator' }, // orchestration.ts:761
	{ id: 'weather-location-delete', label: 'Delete weather location', tier: 'low', group: 'Orchestrator' }, // orchestration.ts:842
	{ id: 'model-ref-clear', label: 'Clear model reference', tier: 'low', group: 'Orchestrator' }, // orchestration.ts:345 / 466 / 504 — one id covers all three
	// default-suppressed (see DEFAULT_SETTINGS.destructiveConfirmAction in src/types.ts): preserves
	// the documented single-row-cancel policy at queueMonitor.ts:159-162. Still overridable on.
	{ id: 'job-cancel', label: 'Cancel job', tier: 'low', group: 'Dashboard' }, // ingestion/sections/queueMonitor.ts:460
];

/**
 * Pure resolution helper — no modal, so tests (and `confirmDestructive` itself) can check
 * whether a given action currently requires confirmation without touching the DOM.
 *
 * Precedence: per-action override > per-tier override > global default. An unknown action id
 * resolves to `true` (fail safe — ask rather than silently skip).
 */
export function resolveConfirmRequired(settings: CrucibleSettings, actionId: string): boolean {
	const action = DESTRUCTIVE_ACTIONS.find(a => a.id === actionId);
	if (!action) return true;

	const actionOverride = settings.destructiveConfirmAction?.[actionId];
	if (actionOverride !== undefined) return actionOverride;

	const tierOverride = settings.destructiveConfirmTier?.[action.tier];
	if (tierOverride !== undefined) return tierOverride;

	return settings.destructiveConfirmGlobal;
}

export interface ConfirmDestructiveOptions {
	/** Defaults to the registered action's label, or a generic fallback for unknown ids. */
	title?: string;
	message: string;
	/** Extra detail lines (e.g. "in use by ..."), appended below `message`. */
	impact?: string[];
}

/**
 * Resolves whether `actionId` currently requires confirmation and, if so, shows the shared
 * `ConfirmModal`. Returns `true` when the caller should proceed with the destructive action —
 * either because confirmation is suppressed for this action/tier/globally, or because the user
 * confirmed the modal. Returns `false` when the user cancelled or dismissed the modal.
 *
 * An unknown `actionId` (a bug — every call site should register first) always shows the modal
 * regardless of settings: fail safe, never fail open.
 */
export async function confirmDestructive(
	app: App,
	settings: CrucibleSettings,
	actionId: string,
	opts: ConfirmDestructiveOptions,
): Promise<boolean> {
	const action = DESTRUCTIVE_ACTIONS.find(a => a.id === actionId);
	if (!action) {
		logWarn(`confirmDestructive: unknown action id "${actionId}" — confirming unconditionally (fail safe).`);
	} else if (!resolveConfirmRequired(settings, actionId)) {
		return true;
	}

	const message = opts.impact && opts.impact.length > 0
		? `${opts.message}\n\n${opts.impact.join('\n')}`
		: opts.message;

	return new ConfirmModal(app, {
		title: opts.title ?? action?.label ?? 'Confirm destructive action',
		message,
		destructive: true,
	}).openAndAwait();
}
