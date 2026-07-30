import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-trigger-validation-tests');
const outfile = path.join(outdir, 'triggerValidation.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/triggers/triggerValidation.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const { validateTrigger, estimateScopeMatches, BROAD_MATCH_WARNING } = await import(pathToFileURL(outfile).href);

// A ctx with a permissive folderExists (everything "exists") unless a test overrides it,
// so folder-nonexistence never leaks into unrelated assertions.
function ctx(overrides = {}) {
	return {
		chainNames: ['Ingest YouTube', 'Refine Transcript'],
		hasInternalCommand: (id) => id === 'lint-note',
		knownJobTypes: ['daily_brief_lite', 'youtube_tracker', 'chain_run', 'command_run'],
		folderExists: () => true,
		...overrides,
	};
}

function eventTrigger(overrides = {}) {
	return {
		id: 't1',
		name: 'test trigger',
		enabled: true,
		on: { events: ['create'] },
		scope: { folder: '', includeSubfolders: true },
		conditions: [],
		conditionMode: 'all',
		action: { kind: 'chain', chainName: 'Ingest YouTube' },
		...overrides,
	};
}

test('incident trigger verbatim (blank name, enabled, create, empty folder, no conditions, chain "") is invalid', () => {
	// Exact shape from the trigger-storm investigation: id ec8bbc66-..., name:"",
	// enabled:true, events:["create"], folder:"", conditions:[], action chain chainName:"".
	const def = {
		id: 'ec8bbc66-6b93-45c0-acaa-bfc318efdac2',
		name: '',
		enabled: true,
		on: { events: ['create'] },
		scope: { folder: '', includeSubfolders: true },
		conditions: [],
		conditionMode: 'all',
		action: { kind: 'chain', chainName: '' },
	};
	const result = validateTrigger(def, ctx());
	assert.ok(result.errors.length > 0, 'expected at least one error');
	assert.ok(result.errors.some(e => e.includes('No chain selected')));
	// Also legal-but-deliberate broad-match, surfaced as a warning alongside the error.
	assert.ok(result.warnings.includes(BROAD_MATCH_WARNING));
});

test('chain action: empty chainName is an error', () => {
	const def = eventTrigger({ action: { kind: 'chain', chainName: '   ' } });
	const { errors } = validateTrigger(def, ctx());
	assert.ok(errors.some(e => e.includes('No chain selected')));
});

test('chain action: chainName that does not resolve is an error naming the missing chain', () => {
	const def = eventTrigger({ action: { kind: 'chain', chainName: 'Nonexistent Chain' } });
	const { errors } = validateTrigger(def, ctx());
	assert.ok(errors.some(e => e === 'Chain "Nonexistent Chain" does not exist.'));
});

test('chain action: resolvable chainName is valid', () => {
	const def = eventTrigger({ action: { kind: 'chain', chainName: 'Ingest YouTube' }, scope: { folder: 'Clippings', includeSubfolders: true } });
	const { errors } = validateTrigger(def, ctx());
	assert.deepEqual(errors, []);
});

test('command action: empty commandId is an error', () => {
	const def = eventTrigger({ action: { kind: 'command', commandId: '' } });
	const { errors } = validateTrigger(def, ctx());
	assert.ok(errors.some(e => e.includes('No command selected')));
});

test('command action: commandId not queueable is an error mirroring getTriggerWarning', () => {
	const def = eventTrigger({ action: { kind: 'command', commandId: 'not-a-real-command' } });
	const { errors } = validateTrigger(def, ctx());
	assert.ok(errors.some(e => e === 'Command "not-a-real-command" is not a queueable internal command.'));
});

test('command action: queueable commandId is valid', () => {
	const def = eventTrigger({ action: { kind: 'command', commandId: 'lint-note' }, scope: { folder: 'Clippings', includeSubfolders: true } });
	const { errors } = validateTrigger(def, ctx());
	assert.deepEqual(errors, []);
});

test('workflow action: unregistered jobType is a warning, not an error (inert at enqueue)', () => {
	const def = eventTrigger({ action: { kind: 'workflow', jobType: 'some_removed_job_type' }, scope: { folder: 'Clippings', includeSubfolders: true } });
	const result = validateTrigger(def, ctx());
	assert.deepEqual(result.errors, []);
	assert.ok(result.warnings.some(w => w.includes('some_removed_job_type') && w.includes('not registered')));
});

test('workflow action: registered jobType has no warning', () => {
	const def = eventTrigger({ action: { kind: 'workflow', jobType: 'daily_brief_lite' }, scope: { folder: 'Clippings', includeSubfolders: true } });
	const result = validateTrigger(def, ctx());
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.warnings, []);
});

test('event trigger: explicitly empty events list is an error, not a silent ["create"] default', () => {
	const def = eventTrigger({ on: { events: [] }, scope: { folder: 'Clippings', includeSubfolders: true } });
	const { errors } = validateTrigger(def, ctx());
	assert.ok(errors.some(e => e.includes('No events selected')));
});

test('schedule trigger: everyMinutes <= 0 is an error', () => {
	const def = eventTrigger({ on: { everyMinutes: 0 }, scope: undefined, conditions: [] });
	const { errors } = validateTrigger(def, ctx());
	assert.ok(errors.some(e => e.includes('greater than 0 minutes')));
});

test('schedule trigger: everyMinutes > 0 with no scope/conditions is valid and quiet', () => {
	const def = eventTrigger({ on: { everyMinutes: 60 }, scope: undefined, conditions: [] });
	const result = validateTrigger(def, ctx());
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.warnings, []);
});

test('schedule trigger with scope or conditions keeps the existing warning', () => {
	const def = eventTrigger({ on: { everyMinutes: 60 }, scope: { folder: 'Clippings', includeSubfolders: true }, conditions: [] });
	const { warnings } = validateTrigger(def, ctx());
	assert.ok(warnings.includes('Schedule triggers have no note context; scope and conditions are ignored.'));
});

test('nonexistent scope folder is a warning', () => {
	const def = eventTrigger({ scope: { folder: 'Ghost Folder', includeSubfolders: true } });
	const { warnings } = validateTrigger(def, ctx({ folderExists: () => false }));
	assert.ok(warnings.some(w => w.includes('Ghost Folder') && w.includes('does not exist')));
});

test('nonexistent-folder warning is skipped when ctx has no folderExists (e.g. no vault available)', () => {
	const def = eventTrigger({ scope: { folder: 'Ghost Folder', includeSubfolders: true } });
	const c = ctx();
	delete c.folderExists;
	const { warnings } = validateTrigger(def, c);
	assert.ok(!warnings.some(w => w.includes('does not exist')));
});

test('broad-match warning: empty scope folder and zero conditions on an otherwise-valid trigger', () => {
	const def = eventTrigger({ scope: { folder: '', includeSubfolders: true }, conditions: [] });
	const result = validateTrigger(def, ctx());
	assert.deepEqual(result.errors, []);
	assert.ok(result.warnings.includes(BROAD_MATCH_WARNING));
});

test('a scoped or conditioned trigger does not trip the broad-match warning', () => {
	const scoped = eventTrigger({ scope: { folder: 'Clippings', includeSubfolders: true }, conditions: [] });
	assert.ok(!validateTrigger(scoped, ctx()).warnings.includes(BROAD_MATCH_WARNING));
	const conditioned = eventTrigger({ scope: { folder: '', includeSubfolders: true }, conditions: [{ type: 'has-tag', tag: 'clip' }] });
	assert.ok(!validateTrigger(conditioned, ctx()).warnings.includes(BROAD_MATCH_WARNING));
});

test('a fully valid chain trigger has no errors and no warnings', () => {
	const def = eventTrigger({ scope: { folder: 'Clippings', includeSubfolders: true }, conditions: [{ type: 'has-tag', tag: 'clip' }] });
	const result = validateTrigger(def, ctx());
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.warnings, []);
});

test('registration-level filtering skips invalid defs (mirrors main.ts registerTriggers)', () => {
	const valid = eventTrigger({ id: 'valid-1', scope: { folder: 'Clippings', includeSubfolders: true } });
	const invalid = {
		id: 'ec8bbc66-6b93-45c0-acaa-bfc318efdac2',
		name: '',
		enabled: true,
		on: { events: ['create'] },
		scope: { folder: '', includeSubfolders: true },
		conditions: [],
		conditionMode: 'all',
		action: { kind: 'chain', chainName: '' },
	};
	const kept = [valid, invalid].filter(def => validateTrigger(def, ctx()).errors.length === 0);
	assert.equal(kept.length, 1);
	assert.equal(kept[0].id, 'valid-1');
});

// --- estimateScopeMatches ---

const ALL_PATHS = [
	'Clippings/a.md',
	'Clippings/sub/b.md',
	'Other/c.md',
	'_crucible/orchestration/queue/inbox/job1.md',
	'_crucible/orchestration/queue/done/job2.md',
	'_crucible/debug.md',
	'_blog_metadata/post.md',
	'root.md',
];

test('estimateScopeMatches: empty scope matches every non-excluded path', () => {
	const count = estimateScopeMatches(ALL_PATHS, { folder: '', includeSubfolders: true }, ['_crucible/orchestration/queue', '_crucible']);
	// Excludes the two queue-root paths and the _crucible/debug.md path; _blog_metadata
	// is NOT excluded (legitimate trigger target).
	assert.equal(count, 5);
});

test('estimateScopeMatches: folder scope with includeSubfolders true counts descendants', () => {
	const count = estimateScopeMatches(ALL_PATHS, { folder: 'Clippings', includeSubfolders: true }, ['_crucible/orchestration/queue', '_crucible']);
	assert.equal(count, 2); // Clippings/a.md, Clippings/sub/b.md
});

test('estimateScopeMatches: folder scope with includeSubfolders false excludes nested files', () => {
	const count = estimateScopeMatches(ALL_PATHS, { folder: 'Clippings', includeSubfolders: false }, ['_crucible/orchestration/queue', '_crucible']);
	assert.equal(count, 1); // Clippings/a.md only, not Clippings/sub/b.md
});

test('estimateScopeMatches: queue-root and _crucible exclusion shares isPluginManagedPath with the registry', () => {
	const excludedRoots = ['_crucible/orchestration/queue', '_crucible'];
	const count = estimateScopeMatches(ALL_PATHS, { folder: '', includeSubfolders: true }, excludedRoots);
	assert.ok(count < ALL_PATHS.length, 'plugin-managed paths must be excluded from the estimate');
	// Without exclusion roots, every path counts (empty scope = whole vault).
	const unfiltered = estimateScopeMatches(ALL_PATHS, { folder: '', includeSubfolders: true }, []);
	assert.equal(unfiltered, ALL_PATHS.length);
});
