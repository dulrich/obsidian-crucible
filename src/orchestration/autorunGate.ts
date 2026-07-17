import type { JobType } from './types';

// The per-type queue-control model (settings.orchestrationJobTypeControls) and the
// pure drain-gating decision for the unified queue, factored out of
// OrchestrationAutoRunner so both can be unit-tested without the Obsidian runtime.
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

// One type's persisted queue controls. Absent fields mean "no override".
export interface JobTypeControl {
	/** Per-type auto-run flag; see typeAutorunEnabled for the per-family semantics. */
	autoRun?: boolean;
	/** Overrides the type's configured cooloff between job starts (ms). */
	minIntervalMsOverride?: number;
}

export type JobTypeControlsMap = Partial<Record<JobType, JobTypeControl>>;

export interface AutorunGateInputs {
	drainsWithoutAutorun: boolean;
	/** The per-type auto-run flag from settings, if any. */
	typeAutorun: boolean | undefined;
	globalAutorunEnabled: boolean;
}

// THE per-type auto-run predicate. The Queue Monitor displays it, and the drain
// decision is exactly it plus the file-drain readiness input (computeShouldDrain),
// so what the user sees can never disagree with what the runner does.
export function typeAutorunEnabled(inputs: AutorunGateInputs): boolean {
	if (inputs.drainsWithoutAutorun) {
		// Memory type: only its own per-type flag governs. Default off.
		return inputs.typeAutorun === true;
	}
	// File type: an explicit per-type `false` vetoes; otherwise global autorun governs.
	if (inputs.typeAutorun === false) return false;
	return inputs.globalAutorunEnabled;
}

export function computeShouldDrain(inputs: AutorunGateInputs & { fileDrainReady: boolean }): boolean {
	if (!typeAutorunEnabled(inputs)) return false;
	// Memory types kick their own drains; file types additionally wait out the
	// initial file-drain delay.
	return inputs.drainsWithoutAutorun || inputs.fileDrainReady;
}

// --- settings-map access (tolerant of a missing or garbage map) ----------------

export function readTypeControl(map: JobTypeControlsMap | undefined, type: JobType): JobTypeControl {
	const value = map && typeof map === 'object' ? map[type] : undefined;
	return value && typeof value === 'object' ? value : {};
}

export function readTypeAutorun(map: JobTypeControlsMap | undefined, type: JobType): boolean | undefined {
	const flag = readTypeControl(map, type).autoRun;
	return typeof flag === 'boolean' ? flag : undefined;
}

/** The per-type cooloff override in ms, or undefined when unset/invalid. */
export function readTypeMinIntervalOverride(map: JobTypeControlsMap | undefined, type: JobType): number | undefined {
	const ms = readTypeControl(map, type).minIntervalMsOverride;
	return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

// Merge a patch into one type's control entry, normalizing a missing/garbage map.
// A field explicitly present-but-undefined in the patch clears that field, and an
// entry with nothing left is dropped, so the map only ever holds real overrides.
export function setTypeControl(
	map: JobTypeControlsMap | undefined,
	type: JobType,
	patch: JobTypeControl,
): JobTypeControlsMap {
	const next: JobTypeControlsMap = map && typeof map === 'object' ? { ...map } : {};
	const entry: JobTypeControl = { ...readTypeControl(next, type) };
	if ('autoRun' in patch) {
		if (patch.autoRun === undefined) delete entry.autoRun;
		else entry.autoRun = patch.autoRun;
	}
	if ('minIntervalMsOverride' in patch) {
		if (patch.minIntervalMsOverride === undefined) delete entry.minIntervalMsOverride;
		else entry.minIntervalMsOverride = patch.minIntervalMsOverride;
	}
	if (entry.autoRun === undefined && entry.minIntervalMsOverride === undefined) delete next[type];
	else next[type] = entry;
	return next;
}

// One-shot migration for the sprint-era `orchestrationJobTypeAutorun` boolean map:
// fold each entry into the controls map, seeding the enrichment type's auto-run
// from the legacy Auto-enrich toggle where the old map didn't record it. Values
// already in the controls map always win.
export function migrateJobTypeControls(
	controls: unknown,
	legacyAutorun: unknown,
	autoEnrichEnabled: boolean,
): JobTypeControlsMap {
	let map: JobTypeControlsMap = controls && typeof controls === 'object' ? { ...(controls as JobTypeControlsMap) } : {};
	const folded: Record<string, unknown> = legacyAutorun && typeof legacyAutorun === 'object' ? { ...(legacyAutorun as Record<string, unknown>) } : {};
	if (typeof folded['youtube_metadata_fetch'] !== 'boolean') folded['youtube_metadata_fetch'] = autoEnrichEnabled;
	for (const [type, on] of Object.entries(folded)) {
		if (typeof on !== 'boolean') continue;
		if (readTypeAutorun(map, type as JobType) === undefined) map = setTypeControl(map, type as JobType, { autoRun: on });
	}
	return map;
}
