import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Covers clsl-WP-3: the destructive-action confirmation FRAMEWORK
// (src/settings/destructiveActions.ts) — the registry + confirmDestructive/
// resolveConfirmRequired, on their own, before any existing delete handler is retrofitted
// onto it (that retrofit is WP-4). Bundles the real module (not a mirror of the logic); the
// real `../confirmModal` is swapped for a controllable stub (real ConfirmModal needs a live
// DOM) — same technique as tests/searchRebuildIndexConfirm.test.mjs — and `obsidian` is
// stubbed defensively even though the only value-level obsidian import in this module's
// dependency graph is via the stubbed-out confirmModal.

const outdir = path.join(tmpdir(), 'obsidian-crucible-destructive-actions-tests');
const outfile = path.join(outdir, 'destructiveActions.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/settings/destructiveActions.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [
		{
			name: 'confirm-modal-stub',
			setup(build) {
				build.onResolve({ filter: /^\.\.\/confirmModal$/ }, () => ({ path: 'confirm-modal-stub', namespace: 'confirm-stub' }));
				build.onLoad({ filter: /.*/, namespace: 'confirm-stub' }, () => ({
					contents: [
						'globalThis.__confirmModalCalls = globalThis.__confirmModalCalls ?? [];',
						'export class ConfirmModal {',
						'  constructor(app, options) { this.app = app; this.options = options; }',
						'  openAndAwait() {',
						'    globalThis.__confirmModalCalls.push(this.options);',
						'    return Promise.resolve(globalThis.__confirmModalResult);',
						'  }',
						'}',
					].join('\n'),
					loader: 'js',
				}));
			},
		},
		{
			name: 'obsidian-test-stub',
			setup(build) {
				build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
				build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
					contents: [
						'export class App {}',
						'export class Modal { constructor() {} open() {} close() {} }',
					].join('\n'),
					loader: 'js',
				}));
			},
		},
	],
	outfile,
	logLevel: 'silent',
});

const { DESTRUCTIVE_ACTIONS, resolveConfirmRequired, confirmDestructive } = await import(pathToFileURL(outfile).href);

function baseSettings(overrides = {}) {
	return {
		destructiveConfirmGlobal: true,
		destructiveConfirmTier: {},
		destructiveConfirmAction: { 'job-cancel': false },
		...overrides,
	};
}

test('registry ids are unique, non-empty, and every entry has a label and group', () => {
	assert.ok(DESTRUCTIVE_ACTIONS.length > 0);
	const ids = DESTRUCTIVE_ACTIONS.map(a => a.id);
	assert.equal(new Set(ids).size, ids.length, 'duplicate action id in DESTRUCTIVE_ACTIONS');
	for (const action of DESTRUCTIVE_ACTIONS) {
		assert.ok(action.id.length > 0, 'action id must be non-empty');
		assert.ok(action.label.length > 0, `${action.id}: label must be non-empty`);
		assert.ok(action.group.length > 0, `${action.id}: group must be non-empty`);
		assert.ok(['critical', 'high', 'medium', 'low'].includes(action.tier), `${action.id}: tier must be a valid DestructiveTier`);
	}
});

test('registry contains job-cancel, tagged low tier, for the default-suppression test below', () => {
	const jobCancel = DESTRUCTIVE_ACTIONS.find(a => a.id === 'job-cancel');
	assert.ok(jobCancel, 'job-cancel must be registered');
	assert.equal(jobCancel.tier, 'low');
});

test('all-default settings require confirmation for every registered action except job-cancel', () => {
	const settings = baseSettings();
	for (const action of DESTRUCTIVE_ACTIONS) {
		const required = resolveConfirmRequired(settings, action.id);
		if (action.id === 'job-cancel') {
			assert.equal(required, false, 'job-cancel ships default-suppressed');
		} else {
			assert.equal(required, true, `${action.id}: defaults must require confirmation`);
		}
	}
});

test('resolution precedence: per-action override wins over tier and global', () => {
	const action = DESTRUCTIVE_ACTIONS.find(a => a.tier === 'critical');
	assert.ok(action, 'need at least one critical-tier action for this test');
	const settings = baseSettings({
		destructiveConfirmGlobal: true,
		destructiveConfirmTier: { [action.tier]: true },
		destructiveConfirmAction: { [action.id]: false },
	});
	assert.equal(resolveConfirmRequired(settings, action.id), false);
});

test('resolution precedence: tier override wins over global when no action override is set', () => {
	const action = DESTRUCTIVE_ACTIONS.find(a => a.tier === 'high');
	assert.ok(action, 'need at least one high-tier action for this test');
	const settings = baseSettings({
		destructiveConfirmGlobal: true,
		destructiveConfirmTier: { [action.tier]: false },
		destructiveConfirmAction: {},
	});
	assert.equal(resolveConfirmRequired(settings, action.id), false);
});

test('resolution precedence: global is the final fallback when neither override is set', () => {
	const action = DESTRUCTIVE_ACTIONS.find(a => a.tier === 'medium');
	assert.ok(action, 'need at least one medium-tier action for this test');
	const settingsOn = baseSettings({ destructiveConfirmGlobal: true, destructiveConfirmTier: {}, destructiveConfirmAction: {} });
	const settingsOff = baseSettings({ destructiveConfirmGlobal: false, destructiveConfirmTier: {}, destructiveConfirmAction: {} });
	assert.equal(resolveConfirmRequired(settingsOn, action.id), true);
	assert.equal(resolveConfirmRequired(settingsOff, action.id), false);
});

test('unknown action id fails safe: resolveConfirmRequired always returns true', () => {
	const settings = baseSettings({ destructiveConfirmGlobal: false, destructiveConfirmTier: { low: false }, destructiveConfirmAction: { 'no-such-action': false } });
	assert.equal(resolveConfirmRequired(settings, 'no-such-action'), true);
});

test('confirmDestructive returns true without showing a modal when confirmation is suppressed', async () => {
	globalThis.__confirmModalCalls = [];
	const action = DESTRUCTIVE_ACTIONS.find(a => a.id === 'job-cancel');
	const settings = baseSettings();
	const result = await confirmDestructive({}, settings, action.id, { message: 'Cancel this job?' });
	assert.equal(result, true);
	assert.equal(globalThis.__confirmModalCalls.length, 0, 'a suppressed action must not open the modal');
});

test('confirmDestructive shows the modal and honors the user choice when confirmation is required', async () => {
	globalThis.__confirmModalCalls = [];
	globalThis.__confirmModalResult = true;
	const action = DESTRUCTIVE_ACTIONS.find(a => a.id === 'chain-delete');
	const settings = baseSettings();
	const result = await confirmDestructive({}, settings, action.id, { message: 'Delete this chain?', impact: ['Used by 2 triggers.'] });
	assert.equal(result, true);
	assert.equal(globalThis.__confirmModalCalls.length, 1);
	const opts = globalThis.__confirmModalCalls[0];
	assert.equal(opts.title, action.label);
	assert.match(opts.message, /Delete this chain\?/);
	assert.match(opts.message, /Used by 2 triggers\./);
	assert.equal(opts.destructive, true);
});

test('confirmDestructive on an unknown action id always shows the modal, regardless of settings', async () => {
	globalThis.__confirmModalCalls = [];
	globalThis.__confirmModalResult = false;
	const settings = baseSettings({ destructiveConfirmGlobal: false });
	const result = await confirmDestructive({}, settings, 'no-such-action', { message: 'Do the unknown thing?' });
	assert.equal(result, false);
	assert.equal(globalThis.__confirmModalCalls.length, 1, 'unknown action ids must fail safe and always confirm');
});
