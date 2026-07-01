import type { TFile } from 'obsidian';
import type CruciblePlugin from '../main';
import type { TriggerDef, TriggerScope } from '../types';
import type { OrchestrationTrigger, TriggerJobSeed } from '../orchestration/TriggerRegistry';
import { evaluateSyncGuards, guardContext } from './guardEval';

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
		return [{ type: 'chain_run', params: { chainName: action.chainName, targetPath: file?.path ?? '' } }];
	}
	if (action.kind === 'command') {
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

// Convert a user-configured TriggerDef into the OrchestrationTrigger the engine runs.
// Like every trigger it only enqueues jobs; the chain/workflow does the real work.
export function triggerDefToOrchestrationTrigger(def: TriggerDef, plugin: CruciblePlugin): OrchestrationTrigger {
	let on: OrchestrationTrigger['on'];
	if ('everyMinutes' in def.on) {
		const minutes = def.on.everyMinutes;
		on = { everyMs: () => Math.max(0, minutes) * 60_000 };
	} else {
		on = { event: def.on.event };
	}
	return {
		id: userTriggerId(def.id),
		description: def.name,
		on,
		enabled: () => def.enabled,
		guard: (file) => {
			if (!inScope(file, def.scope)) return false;
			const cache = plugin.app.metadataCache.getFileCache(file);
			return evaluateSyncGuards(def.conditions, guardContext(cache), def.conditionMode ?? 'all');
		},
		jobs: (file) => seedsFor(def, file),
	};
}
