import type { JobTypeConfig } from './jobTypeConfig';
import type { JobType } from './types';

// The per-type queue-control model (settings.orchestrationJobTypeControls) and the
// pure drain-gating decision for the unified queue, factored out of
// OrchestrationAutoRunner so both can be unit-tested without the Obsidian runtime.
//
// One uniform rule for every job type: a type auto-drains only when the queue-wide
// panic switch (queueEnabled) is on AND its own per-type auto-run flag is explicitly
// true. Absent that flag it stays idle (opt-in) so nothing drains behind the user's
// back. `drainsWithoutAutorun` no longer gates — it only distinguishes readiness:
// memory types (the folded enrichment queue) kick their own drains immediately,
// while file types additionally wait out the initial file-drain delay.
//
// Note: auto-run is EXECUTION control (drain). Whether jobs are automatically
// *enqueued* is a separate concern owned elsewhere (e.g. the enrichment auto-source
// and capture triggers) — enqueueing a type does not imply draining it.
//
// Manual "Run next" / per-job Run / enqueue-and-run bypasses this gate entirely (see
// OrchestrationAutoRunner.runType / runJob).

// One type's persisted queue controls. Absent fields mean "no override".
export interface JobTypeControl {
	/** Per-type auto-run (drain/execution) flag; unset ⇒ idle (opt-in). */
	autoRun?: boolean;
	/** Overrides the type's configured cooloff between job starts (ms). */
	minIntervalMsOverride?: number;
	/** Overrides the type's configured worker count for the drain. Ignored by types that declare themselves serial. */
	maxParallelOverride?: number;
}

export type JobTypeControlsMap = Partial<Record<JobType, JobTypeControl>>;

export interface AutorunGateInputs {
	/** The queue-wide panic switch (settings.orchestrationQueueEnabled). Off vetoes every type. */
	queueEnabled: boolean;
	/** Memory types kick their own drains; file types wait the initial file-drain delay. Readiness only. */
	drainsWithoutAutorun: boolean;
	/** The per-type auto-run flag from settings, if any. Unset ⇒ idle. */
	typeAutorun: boolean | undefined;
}

// THE per-type auto-run predicate. The Queue Monitor displays it, and the drain
// decision is exactly it plus the file-drain readiness input (computeShouldDrain),
// so what the user sees can never disagree with what the runner does. One uniform
// rule for every type: queue enabled AND the type opted in.
export function typeAutorunEnabled(inputs: AutorunGateInputs): boolean {
	// The queue-wide panic switch stops all auto-draining while preserving the
	// per-type flags underneath; manual runs bypass this gate entirely.
	if (!inputs.queueEnabled) return false;
	return inputs.typeAutorun === true;
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

/** The per-type worker-count override, or undefined when unset/invalid. Floored at 1. */
export function readTypeMaxParallelOverride(map: JobTypeControlsMap | undefined, type: JobType): number | undefined {
	const n = readTypeControl(map, type).maxParallelOverride;
	return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

/**
 * THE worker count for `type`: the per-type override when there is one, else the
 * type's configured default, floored at 1.
 *
 * A type carrying `maxParallelFixed` is pinned to its configured value and ignores
 * any override — the constraint is a property of the job type, not a preference. The
 * drain loop and the Queue Configuration table both call this, so the number shown is
 * by construction the number used.
 *
 * Note this is the *per-type* count. The global `orchestrationMaxConcurrent`
 * semaphore still bounds total in-flight jobs across all types, so raising one type
 * above the global cap buys nothing.
 */
export function resolveMaxParallel(
	config: Pick<JobTypeConfig, 'maxParallel' | 'maxParallelFixed'>,
	map: JobTypeControlsMap | undefined,
	type: JobType,
): number {
	const configured = Math.max(1, config.maxParallel);
	if (config.maxParallelFixed) return configured;
	return readTypeMaxParallelOverride(map, type) ?? configured;
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
	if ('maxParallelOverride' in patch) {
		if (patch.maxParallelOverride === undefined) delete entry.maxParallelOverride;
		else entry.maxParallelOverride = patch.maxParallelOverride;
	}
	if (entry.autoRun === undefined && entry.minIntervalMsOverride === undefined && entry.maxParallelOverride === undefined) delete next[type];
	else next[type] = entry;
	return next;
}

// One-shot migration for the sprint-era `orchestrationJobTypeAutorun` boolean map:
// fold each entry into the controls map, seeding the enrichment type's auto-run
// (drain) from the legacy combined enqueue/drain flag where the old map didn't
// record it. Values already in the controls map always win.
export function migrateJobTypeControls(
	controls: unknown,
	legacyAutorun: unknown,
	autoEnqueueEnabled: boolean,
): JobTypeControlsMap {
	let map: JobTypeControlsMap = controls && typeof controls === 'object' ? { ...(controls as JobTypeControlsMap) } : {};
	const folded: Record<string, unknown> = legacyAutorun && typeof legacyAutorun === 'object' ? { ...(legacyAutorun as Record<string, unknown>) } : {};
	if (typeof folded['youtube_metadata_fetch'] !== 'boolean') folded['youtube_metadata_fetch'] = autoEnqueueEnabled;
	for (const [type, on] of Object.entries(folded)) {
		if (typeof on !== 'boolean') continue;
		if (readTypeAutorun(map, type as JobType) === undefined) map = setTypeControl(map, type as JobType, { autoRun: on });
	}
	return map;
}
