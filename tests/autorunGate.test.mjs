import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-autorungate-tests');
const outfile = path.join(outdir, 'autorunGate.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/orchestration/autorunGate.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	logLevel: 'silent',
	outfile,
});

const {
	computeShouldDrain,
	typeAutorunEnabled,
	readTypeAutorun,
	readTypeMinIntervalOverride,
	readTypeMaxParallelOverride,
	resolveMaxParallel,
	setTypeControl,
	migrateJobTypeControls,
} = await import(pathToFileURL(outfile).href);

// --- uniform opt-in gate: a type auto-runs only when queue is enabled AND its
//     per-type auto-run flag is explicitly true (file and memory types alike) ---

test('any type is idle when its per-type auto-run is unset (default opt-in off)', () => {
	for (const drainsWithoutAutorun of [true, false]) {
		assert.equal(computeShouldDrain({
			queueEnabled: true, drainsWithoutAutorun, typeAutorun: undefined, fileDrainReady: true,
		}), false, `drainsWithoutAutorun=${drainsWithoutAutorun}`);
	}
});

test('any type is idle when its per-type auto-run is off', () => {
	for (const drainsWithoutAutorun of [true, false]) {
		assert.equal(computeShouldDrain({
			queueEnabled: true, drainsWithoutAutorun, typeAutorun: false, fileDrainReady: true,
		}), false, `drainsWithoutAutorun=${drainsWithoutAutorun}`);
	}
});

test('memory type drains immediately when its per-type auto-run is on (no file-drain wait)', () => {
	assert.equal(computeShouldDrain({
		queueEnabled: true, drainsWithoutAutorun: true, typeAutorun: true, fileDrainReady: false,
	}), true);
});

test('file type drains when its per-type auto-run is on once the file-drain delay has elapsed', () => {
	assert.equal(computeShouldDrain({
		queueEnabled: true, drainsWithoutAutorun: false, typeAutorun: true, fileDrainReady: true,
	}), true);
});

test('file type with auto-run on still waits for the initial file-drain delay', () => {
	assert.equal(computeShouldDrain({
		queueEnabled: true, drainsWithoutAutorun: false, typeAutorun: true, fileDrainReady: false,
	}), false);
});

// --- the display predicate (Queue Monitor / Queue Configuration chips) ---

test('typeAutorunEnabled: uniform — queue enabled AND per-type flag true, for both families', () => {
	for (const drainsWithoutAutorun of [true, false]) {
		assert.equal(typeAutorunEnabled({ queueEnabled: true, drainsWithoutAutorun, typeAutorun: true }), true);
		assert.equal(typeAutorunEnabled({ queueEnabled: true, drainsWithoutAutorun, typeAutorun: false }), false);
		assert.equal(typeAutorunEnabled({ queueEnabled: true, drainsWithoutAutorun, typeAutorun: undefined }), false);
	}
});

test('display and drain agree: computeShouldDrain is exactly typeAutorunEnabled plus readiness', () => {
	for (const queueEnabled of [true, false]) {
		for (const drainsWithoutAutorun of [true, false]) {
			for (const typeAutorun of [true, false, undefined]) {
				const inputs = { queueEnabled, drainsWithoutAutorun, typeAutorun };
				const label = JSON.stringify(inputs);
				// With readiness satisfied, the drain decision IS the displayed state.
				assert.equal(computeShouldDrain({ ...inputs, fileDrainReady: true }), typeAutorunEnabled(inputs), label);
				// Before readiness, only memory types (which don't wait on it) drain.
				assert.equal(
					computeShouldDrain({ ...inputs, fileDrainReady: false }),
					drainsWithoutAutorun && typeAutorunEnabled(inputs),
					label,
				);
			}
		}
	}
});

// --- the queue-wide panic switch (orchestrationQueueEnabled) ---

test('panic off vetoes every type regardless of the per-type flag', () => {
	for (const drainsWithoutAutorun of [true, false]) {
		for (const typeAutorun of [true, false, undefined]) {
			for (const fileDrainReady of [true, false]) {
				const inputs = { queueEnabled: false, drainsWithoutAutorun, typeAutorun };
				const label = JSON.stringify({ ...inputs, fileDrainReady });
				assert.equal(typeAutorunEnabled(inputs), false, label);
				assert.equal(computeShouldDrain({ ...inputs, fileDrainReady }), false, label);
			}
		}
	}
});

test('panic back on restores the underlying per-type configuration verbatim', () => {
	const memoryOn = { queueEnabled: true, drainsWithoutAutorun: true, typeAutorun: true };
	const fileOn = { queueEnabled: true, drainsWithoutAutorun: false, typeAutorun: true };
	assert.equal(typeAutorunEnabled(memoryOn), true);
	assert.equal(typeAutorunEnabled(fileOn), true);
	assert.equal(typeAutorunEnabled({ ...memoryOn, queueEnabled: false }), false);
	assert.equal(typeAutorunEnabled({ ...fileOn, queueEnabled: false }), false);
	// Flipping queueEnabled back is the only change needed to resume.
	assert.equal(typeAutorunEnabled({ ...memoryOn, queueEnabled: true }), true);
	assert.equal(typeAutorunEnabled({ ...fileOn, queueEnabled: true }), true);
});

// --- settings-map readers ---

test('readTypeAutorun returns the flag when present, undefined otherwise (tolerant of garbage)', () => {
	assert.equal(readTypeAutorun({ youtube_metadata_fetch: { autoRun: true } }, 'youtube_metadata_fetch'), true);
	assert.equal(readTypeAutorun({ youtube_metadata_fetch: { autoRun: false } }, 'youtube_metadata_fetch'), false);
	assert.equal(readTypeAutorun({ youtube_metadata_fetch: {} }, 'youtube_metadata_fetch'), undefined);
	assert.equal(readTypeAutorun({}, 'youtube_metadata_fetch'), undefined);
	assert.equal(readTypeAutorun(undefined, 'youtube_metadata_fetch'), undefined);
	assert.equal(readTypeAutorun({ youtube_metadata_fetch: { autoRun: 'yes' } }, 'youtube_metadata_fetch'), undefined);
	assert.equal(readTypeAutorun({ youtube_metadata_fetch: true }, 'youtube_metadata_fetch'), undefined);
});

test('readTypeMinIntervalOverride returns finite non-negative ms only', () => {
	assert.equal(readTypeMinIntervalOverride({ blogs_tracker: { minIntervalMsOverride: 5000 } }, 'blogs_tracker'), 5000);
	assert.equal(readTypeMinIntervalOverride({ blogs_tracker: { minIntervalMsOverride: 0 } }, 'blogs_tracker'), 0);
	assert.equal(readTypeMinIntervalOverride({ blogs_tracker: { minIntervalMsOverride: -1 } }, 'blogs_tracker'), undefined);
	assert.equal(readTypeMinIntervalOverride({ blogs_tracker: { minIntervalMsOverride: Number.NaN } }, 'blogs_tracker'), undefined);
	assert.equal(readTypeMinIntervalOverride({ blogs_tracker: {} }, 'blogs_tracker'), undefined);
	assert.equal(readTypeMinIntervalOverride(undefined, 'blogs_tracker'), undefined);
});

// --- setTypeControl ---

test('setTypeControl normalizes a missing/garbage map and merges patches per field', () => {
	const fromGarbage = setTypeControl('nonsense', 'blogs_tracker', { autoRun: true });
	assert.deepEqual(fromGarbage, { blogs_tracker: { autoRun: true } });
	const merged = setTypeControl({ blogs_tracker: { autoRun: true } }, 'blogs_tracker', { minIntervalMsOverride: 3000 });
	assert.deepEqual(merged, { blogs_tracker: { autoRun: true, minIntervalMsOverride: 3000 } });
});

test('setTypeControl clears a field on explicit undefined and drops an empty entry', () => {
	const start = { blogs_tracker: { autoRun: true, minIntervalMsOverride: 3000 } };
	const noRate = setTypeControl(start, 'blogs_tracker', { minIntervalMsOverride: undefined });
	assert.deepEqual(noRate, { blogs_tracker: { autoRun: true } });
	const empty = setTypeControl(noRate, 'blogs_tracker', { autoRun: undefined });
	assert.deepEqual(empty, {});
});

test('setTypeControl does not mutate its input map', () => {
	const start = { blogs_tracker: { autoRun: true } };
	setTypeControl(start, 'blogs_tracker', { autoRun: false });
	assert.deepEqual(start, { blogs_tracker: { autoRun: true } });
});

// --- per-type concurrency: the override, and the types that refuse one ---

test('readTypeMaxParallelOverride takes whole worker counts of 1 or more and rejects the rest', () => {
	assert.equal(readTypeMaxParallelOverride({ search_upsert_batch: { maxParallelOverride: 4 } }, 'search_upsert_batch'), 4);
	assert.equal(readTypeMaxParallelOverride({ search_upsert_batch: { maxParallelOverride: 3.7 } }, 'search_upsert_batch'), 3,
		'a fractional worker count floors rather than being discarded');
	for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY, '4', null]) {
		assert.equal(readTypeMaxParallelOverride({ search_upsert_batch: { maxParallelOverride: bad } }, 'search_upsert_batch'), undefined,
			`rejects ${String(bad)}`);
	}
	assert.equal(readTypeMaxParallelOverride(undefined, 'search_upsert_batch'), undefined);
});

test('resolveMaxParallel prefers the override, falls back to the config default, and floors at 1', () => {
	const config = { maxParallel: 1 };
	assert.equal(resolveMaxParallel(config, { search_upsert_batch: { maxParallelOverride: 6 } }, 'search_upsert_batch'), 6);
	assert.equal(resolveMaxParallel(config, {}, 'search_upsert_batch'), 1, 'no override ⇒ the configured default');
	assert.equal(resolveMaxParallel({ maxParallel: 4 }, {}, 'youtube_channel_enrich'), 4);
	assert.equal(resolveMaxParallel({ maxParallel: 0 }, undefined, 'chain_run'), 1, 'never fewer than one worker');
});

test('a maxParallelFixed type ignores an override rather than obeying it', () => {
	const serial = { maxParallel: 1, maxParallelFixed: 'one fan-out at a time' };
	assert.equal(
		resolveMaxParallel(serial, { search_embed_missing: { maxParallelOverride: 8 } }, 'search_embed_missing'),
		1,
		'the constraint is a property of the job type, not a user preference to be overridden',
	);
	// The override may still be stored (a type could stop being fixed later); what
	// must never happen is the drain acting on it while the marker is present.
	assert.equal(readTypeMaxParallelOverride({ search_embed_missing: { maxParallelOverride: 8 } }, 'search_embed_missing'), 8);
});

test('setTypeControl round-trips and clears a worker-count override, dropping an emptied entry', () => {
	let map = setTypeControl({}, 'search_upsert_batch', { maxParallelOverride: 4 });
	assert.deepEqual(map, { search_upsert_batch: { maxParallelOverride: 4 } });

	map = setTypeControl(map, 'search_upsert_batch', { autoRun: true });
	assert.deepEqual(map, { search_upsert_batch: { maxParallelOverride: 4, autoRun: true } },
		'the two overrides are independent fields on one entry');

	map = setTypeControl(map, 'search_upsert_batch', { maxParallelOverride: undefined });
	assert.deepEqual(map, { search_upsert_batch: { autoRun: true } });

	map = setTypeControl(map, 'search_upsert_batch', { autoRun: undefined });
	assert.deepEqual(map, {}, 'an entry with nothing left is dropped, not left as an empty object');
});

// --- one-shot migration from orchestrationJobTypeAutorun ---

test('migrateJobTypeControls folds legacy boolean entries and seeds enrichment from Auto-enrich', () => {
	const map = migrateJobTypeControls({}, { blogs_tracker: false }, true);
	assert.deepEqual(map, {
		blogs_tracker: { autoRun: false },
		youtube_metadata_fetch: { autoRun: true },
	});
});

test('migrateJobTypeControls: an explicit controls entry wins over the legacy map and the seed', () => {
	const map = migrateJobTypeControls(
		{ youtube_metadata_fetch: { autoRun: false, minIntervalMsOverride: 9000 } },
		{ youtube_metadata_fetch: true },
		true,
	);
	assert.deepEqual(map, { youtube_metadata_fetch: { autoRun: false, minIntervalMsOverride: 9000 } });
});

test('migrateJobTypeControls: a legacy enrichment entry wins over the Auto-enrich seed', () => {
	const map = migrateJobTypeControls({}, { youtube_metadata_fetch: false }, true);
	assert.deepEqual(map, { youtube_metadata_fetch: { autoRun: false } });
});

test('migrateJobTypeControls tolerates garbage inputs and non-boolean legacy values', () => {
	const map = migrateJobTypeControls('nonsense', { blogs_tracker: 'yes' }, false);
	assert.deepEqual(map, { youtube_metadata_fetch: { autoRun: false } });
});
