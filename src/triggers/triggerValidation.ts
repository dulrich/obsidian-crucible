import type { TriggerDef, TriggerScope } from '../types';
import { isPluginManagedPath } from './pluginManagedPath';
import { pathInScope } from './scopeMatch';

// Pure validity rules for a user-configured TriggerDef, per the trigger-storm
// investigation's §validity table. This module has NO obsidian value imports (only
// type-only imports, erased at build) so it bundles standalone for tests the same way
// `guardEval.ts` does — every vault-derived fact (chain names, whether a command id is
// queueable, which job types are registered, whether a scope folder exists) is supplied
// by the caller via `ctx` rather than looked up here.
//
// `errors` is the enable gate: a trigger may be enabled (at creation or after an edit)
// iff `errors.length === 0`. `warnings` are surfaced (warning icon / prose block) but
// never block enabling — they cover legal-but-probably-unintended configurations
// (an unregistered workflow type, a scope folder that doesn't exist, a schedule trigger
// with scope/conditions that are ignored, or a deliberately vault-wide match).

export interface TriggerValidationCtx {
	/** Names of chains the "chain" action can resolve against (settings.chains.map(c => c.name)). */
	chainNames: readonly string[];
	/** True when `id` resolves to an awaited, target-file-aware internal command (ChainManager.hasInternalCommand). */
	hasInternalCommand: (id: string) => boolean;
	/** Registered JobTypes the "workflow" action can enqueue (Orchestrator.jobTypes()). */
	knownJobTypes: readonly string[];
	/**
	 * Optional vault fact: does this (already-normalized) folder path exist? Omitted —
	 * e.g. in unit tests that don't stand up a vault — skips the nonexistent-folder
	 * warning rather than assuming every folder is missing.
	 */
	folderExists?: (folder: string) => boolean;
}

export interface TriggerValidationResult {
	errors: string[];
	warnings: string[];
}

// Exported so callers that need to distinguish this specific warning (e.g. the
// settings UI, to render it next to the match-volume estimate rather than lumped into
// a generic warning icon tooltip) can match on it exactly instead of substring-sniffing
// warning text.
export const BROAD_MATCH_WARNING = 'Empty scope and no conditions: this trigger matches every note in the vault.';

function normalizedFolder(scope: TriggerScope | undefined): string {
	return scope?.folder?.trim().replace(/\/$/, '') ?? '';
}

export function validateTrigger(def: TriggerDef, ctx: TriggerValidationCtx): TriggerValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	const action = def.action;
	if (action.kind === 'chain') {
		const chainName = action.chainName.trim();
		if (!chainName) {
			errors.push('No chain selected; this trigger will not run.');
		} else if (!ctx.chainNames.includes(chainName)) {
			errors.push(`Chain "${chainName}" does not exist.`);
		}
	} else if (action.kind === 'command') {
		const commandId = action.commandId.trim();
		if (!commandId) {
			errors.push('No command selected; this trigger will not run.');
		} else if (!ctx.hasInternalCommand(commandId)) {
			errors.push(`Command "${commandId}" is not a queueable internal command.`);
		}
	} else {
		// Workflow kind: an unregistered job type is inert at enqueue (Orchestrator
		// returns null for an unknown type), not dangerous — and the settings UI only
		// ever offers a closed set of job types in the dropdown, so this rule exists to
		// catch data.json drift (an old/renamed job type), not a UI-reachable mistake.
		// Warning only, per the investigation.
		if (!ctx.knownJobTypes.includes(action.jobType)) {
			warnings.push(`Workflow type "${action.jobType}" is not registered; this trigger is inert.`);
		}
	}

	if ('everyMinutes' in def.on) {
		if (!(def.on.everyMinutes > 0)) {
			errors.push('Schedule interval must be greater than 0 minutes.');
		}
		if (def.scope?.folder || def.conditions.length > 0) {
			warnings.push('Schedule triggers have no note context; scope and conditions are ignored.');
		}
	} else {
		if ('events' in def.on && def.on.events.length === 0) {
			errors.push('No events selected; this trigger will not run.');
		}

		const folder = normalizedFolder(def.scope);
		if (folder && ctx.folderExists && !ctx.folderExists(folder)) {
			warnings.push(`Folder "${folder}" does not exist; this trigger matches nothing.`);
		}
		// Legal but deliberate: an empty scope with no conditions matches every note in
		// the vault (this is exactly the incident trigger's shape, minus the empty
		// chainName that made it an error). Surfaced alongside the match-volume
		// estimate rather than blocked — the user may genuinely want a vault-wide rule.
		if (!folder && def.conditions.length === 0) {
			warnings.push(BROAD_MATCH_WARNING);
		}
	}

	return { errors, warnings };
}

// Upper-bound count of vault notes a trigger's scope currently matches, using the same
// exclusion predicate (`isPluginManagedPath`) TriggerRegistry applies at its chokepoints
// and the same prefix semantics `triggerAdapter.inScope` applies at fire time (via the
// shared `pathInScope`) — a number that disagreed with runtime behavior would be worse
// than no number. Conditions are NOT evaluated here (that needs per-file frontmatter/tag
// reads); the caller's wording should say "upper bound".
export function estimateScopeMatches(
	paths: readonly string[],
	scope: TriggerScope | undefined,
	excludedRoots: readonly string[],
): number {
	let count = 0;
	for (const path of paths) {
		if (isPluginManagedPath(path, excludedRoots)) continue;
		if (pathInScope(path, scope)) count++;
	}
	return count;
}
