import type { JobType } from './types';

// Pure drain-gating decision for the unified queue, factored out of
// OrchestrationAutoRunner so it can be unit-tested without the Obsidian runtime.
//
// Two families of job type:
//   - memory types (drainsWithoutAutorun): the folded enrichment queue. They kick
//     their own drains on queue changes and are NOT governed by the global Autorun
//     toggle. Instead each has a per-type auto-run flag; absent that flag they stay
//     idle (default off) so nothing drains behind the user's back.
//   - file types: governed by the global Autorun toggle (and the initial file-drain
//     delay). A per-type flag set to `false` acts as a veto; otherwise the global
//     toggle governs.
//
// Manual "Run next" / enqueue-and-run bypasses this gate entirely (see
// OrchestrationAutoRunner.runType).
export interface DrainGateInputs {
	drainsWithoutAutorun: boolean;
	/** The per-type override from settings.orchestrationJobTypeAutorun[type], if any. */
	typeAutorun: boolean | undefined;
	globalAutorunEnabled: boolean;
	fileDrainReady: boolean;
}

export function computeShouldDrain(inputs: DrainGateInputs): boolean {
	if (inputs.drainsWithoutAutorun) {
		// Memory type: only its own per-type flag governs. Default off.
		return inputs.typeAutorun === true;
	}
	// File type: an explicit per-type `false` vetoes; otherwise global autorun governs.
	if (inputs.typeAutorun === false) return false;
	return inputs.globalAutorunEnabled && inputs.fileDrainReady;
}

// The effective per-type auto-run state for display in the Queue Monitor. This is
// the toggle the user sees, independent of the global-autorun AND / file-drain delay:
//   - memory type: the per-type flag (default off).
//   - file type: the per-type flag if set, else the global Autorun toggle.
export function effectiveTypeAutorun(inputs: {
	drainsWithoutAutorun: boolean;
	typeAutorun: boolean | undefined;
	globalAutorunEnabled: boolean;
}): boolean {
	if (inputs.drainsWithoutAutorun) return inputs.typeAutorun === true;
	if (typeof inputs.typeAutorun === 'boolean') return inputs.typeAutorun;
	return inputs.globalAutorunEnabled;
}

// Read a per-type override out of the settings map (tolerant of a missing map).
export function readJobTypeAutorun(
	map: Record<string, boolean> | undefined,
	type: JobType,
): boolean | undefined {
	const value = map?.[type];
	return typeof value === 'boolean' ? value : undefined;
}
