import type { TFile } from 'obsidian';
import type CruciblePlugin from '../main';
import type { TriggerDef, TriggerScope } from '../types';
import type { OrchestrationTrigger, TriggerJobSeed } from '../orchestration/TriggerRegistry';
import { evaluateSyncGuards, guardContext } from './guardEval';
import { logWarn } from '../log';

// User-trigger ids are namespaced so they never collide with code-defined founding
// triggers and so the settings override map (`orchestrationTriggersEnabled`, keyed by
// founding-trigger id) doesn't accidentally gate them — user triggers carry their own
// `enabled` flag.
export function userTriggerId(defId: string): string {
	return `user:${defId}`;
}

function inScope(file: TFile, scope?: TriggerScope): boolean {
	const folder = scope?.folder?.trim().replace(/\/$/, '');
	if (!folder) return true;
	if (scope?.includeSubfolders === false) {
		return (file.parent?.path ?? '') === folder;
	}
	return file.path === folder || file.path.startsWith(`${folder}/`);
}

function seedsFor(def: TriggerDef, file?: TFile): TriggerJobSeed[] {
	const action = def.action;
	if (action.kind === 'chain') {
		// An empty chainName isn't just inert: it defeats dedupe (chainRunJobConfig's
		// dedupeKey returns '' for a blank name, which FileJobBackend treats as
		// falsy and skips the dedupe branch entirely) — refuse to seed rather than
		// let a degenerate trigger mint unbounded duplicate chain_run jobs.
		if (!action.chainName.trim()) {
			logWarn('trigger', def.id, 'refused to seed chain_run: empty chainName');
			return [];
		}
		return [{ type: 'chain_run', params: { chainName: action.chainName, targetPath: file?.path ?? '' } }];
	}
	if (action.kind === 'command') {
		// Same dedupe hazard as the chain case: commandRunJobConfig's dedupeKey
		// returns '' for a blank commandId.
		if (!action.commandId.trim()) {
			logWarn('trigger', def.id, 'refused to seed command_run: empty commandId');
			return [];
		}
		return [{
			type: 'command_run',
			params: {
				commandId: action.commandId,
				args: action.args ?? {},
				...(file ? { targetPath: file.path } : {}),
			},
		}];
	}
	return [{
		type: action.jobType,
		params: { ...(action.params ?? {}), ...(file ? { targetPath: file.path } : {}) },
	}];
}

function triggerEvents(onDef: Exclude<TriggerDef['on'], { everyMinutes: number }>): OrchestrationTrigger['on'] {
	if ('events' in onDef) {
		// An explicitly empty list adapts to NO events (triggerMatchesEvent's
		// `.includes(event)` over an empty array is always false) rather than
		// silently defaulting to ['create'] — a trigger someone emptied out on
		// purpose (or mid-edit) should go inert, not re-arm on the broadest event.
		return { events: onDef.events };
	}
	return { event: onDef.event };
}

// Convert a user-configured TriggerDef into the OrchestrationTrigger the engine runs.
// Like every trigger it only enqueues jobs; the chain/workflow does the real work.
export function triggerDefToOrchestrationTrigger(def: TriggerDef, plugin: CruciblePlugin): OrchestrationTrigger {
	let on: OrchestrationTrigger['on'];
	if ('everyMinutes' in def.on) {
		const minutes = def.on.everyMinutes;
		on = { everyMs: () => Math.max(0, minutes) * 60_000 };
	} else {
		on = triggerEvents(def.on);
	}
	return {
		id: userTriggerId(def.id),
		description: def.name,
		on,
		enabled: () => def.enabled,
		guard: (file, _fm, cache) => {
			if (!inScope(file, def.scope)) return false;
			const consistentCache = cache ?? plugin.app.metadataCache.getFileCache(file);
			return evaluateSyncGuards(def.conditions, guardContext(consistentCache), def.conditionMode ?? 'all');
		},
		jobs: (file) => seedsFor(def, file),
	};
}
