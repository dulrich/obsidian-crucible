import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Covers clsl-WP-4: the mechanical retrofit of every audited destructive call site onto
// `confirmDestructive` (src/settings/destructiveActions.ts, landed in WP-3). Two checks:
//
// 1. A structural sweep — every DESTRUCTIVE_ACTIONS id has at least one
//    `confirmDestructive('<id>'` call site somewhere under src/. This is a deliberate
//    source-text grep, not an AST walk: the WP-4 brief calls this "the cheap honest
//    check", and it catches the actual regression class (an id registered but never
//    wired to a call site, or a call site typo'd against the registry).
// 2. A behavioral test proving a suppressed action truly skips the confirmation modal
//    AND lets the wrapped action proceed — not just that `confirmDestructive` resolves
//    `true` (destructiveActions.test.mjs already covers that in isolation), but that the
//    exact `if (!(await confirmDestructive(...))) return; <mutate>` shape used at every
//    real call site (see queueMonitor.ts's job-cancel handler) really does fall through
//    to the mutation when suppressed, and really does NOT when the user cancels.

const SRC_DIR = path.join(process.cwd(), 'src');

async function collectTsFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...await collectTsFiles(full));
		} else if (entry.isFile() && entry.name.endsWith('.ts')) {
			files.push(full);
		}
	}
	return files;
}

const outdir = path.join(tmpdir(), 'obsidian-crucible-destructive-actions-wp4-tests');
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
						'globalThis.__wp4ConfirmModalCalls = globalThis.__wp4ConfirmModalCalls ?? [];',
						'export class ConfirmModal {',
						'  constructor(app, options) { this.app = app; this.options = options; }',
						'  openAndAwait() {',
						'    globalThis.__wp4ConfirmModalCalls.push(this.options);',
						'    return Promise.resolve(globalThis.__wp4ConfirmModalResult);',
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

const { DESTRUCTIVE_ACTIONS, confirmDestructive } = await import(pathToFileURL(outfile).href);

function baseSettings(overrides = {}) {
	return {
		destructiveConfirmGlobal: true,
		destructiveConfirmTier: {},
		destructiveConfirmAction: { 'job-cancel': false },
		...overrides,
	};
}

test('every DESTRUCTIVE_ACTIONS id has at least one confirmDestructive(\'<id>\' call site under src/', async () => {
	const tsFiles = await collectTsFiles(SRC_DIR);
	const contents = await Promise.all(tsFiles.map(f => readFile(f, 'utf8')));
	const combined = contents.join('\n---FILE---\n');

	const missing = [];
	for (const action of DESTRUCTIVE_ACTIONS) {
		// Matches both `confirmDestructive(tab.app, s, 'id', {` and `confirmDestructive(..., "id", {`
		// call-site shapes — quote style varies by file, so check both.
		const singleQuoted = combined.includes(`confirmDestructive(`) && new RegExp(`confirmDestructive\\([^;]*?['"]${action.id}['"]`, 's').test(combined);
		if (!singleQuoted) missing.push(action.id);
	}
	assert.deepEqual(missing, [], `every registered action must have a confirmDestructive('<id>'…) call site; missing: ${missing.join(', ')}`);
});

test('no bare "new ConfirmModal(" call site exists under settings/sections/ (framework bypass guard)', async () => {
	const sectionsDir = path.join(SRC_DIR, 'settings', 'sections');
	const tsFiles = await collectTsFiles(sectionsDir);
	const offenders = [];
	for (const file of tsFiles) {
		const content = await readFile(file, 'utf8');
		if (/new ConfirmModal\(/.test(content)) offenders.push(path.relative(SRC_DIR, file));
	}
	assert.deepEqual(offenders, [], `settings/sections/*.ts must route destructive confirms through confirmDestructive(), not a bare ConfirmModal: ${offenders.join(', ')}`);
});

// Mirrors the exact call-site shape every retrofit uses (see e.g. queueMonitor.ts's
// job-cancel Cancel handler): `if (!(await confirmDestructive(...))) return; <mutate>`.
// Exercises the REAL confirmDestructive/resolveConfirmRequired, not a re-implementation.
async function runGuardedAction(app, settings, actionId, message, mutate) {
	if (!(await confirmDestructive(app, settings, actionId, { message }))) return false;
	mutate();
	return true;
}

test('job-cancel: default-suppressed settings skip the modal AND still perform the action', async () => {
	globalThis.__wp4ConfirmModalCalls = [];
	const settings = baseSettings(); // ships with destructiveConfirmAction['job-cancel'] === false
	let mutated = false;
	const performed = await runGuardedAction({}, settings, 'job-cancel', 'Cancel this job?', () => { mutated = true; });

	assert.equal(performed, true, 'a suppressed action must still perform the mutation');
	assert.equal(mutated, true, 'the mutate callback must have run');
	assert.equal(globalThis.__wp4ConfirmModalCalls.length, 0, 'a suppressed action must not open the modal');
});

test('job-cancel: when explicitly re-enabled, cancelling the modal blocks the action', async () => {
	globalThis.__wp4ConfirmModalCalls = [];
	globalThis.__wp4ConfirmModalResult = false;
	const settings = baseSettings({ destructiveConfirmAction: { 'job-cancel': true } });
	let mutated = false;
	const performed = await runGuardedAction({}, settings, 'job-cancel', 'Cancel this job?', () => { mutated = true; });

	assert.equal(performed, false, 'cancelling the modal must not perform the mutation');
	assert.equal(mutated, false);
	assert.equal(globalThis.__wp4ConfirmModalCalls.length, 1, 're-enabled confirmation must show the modal');
});

test('job-cancel: when explicitly re-enabled, confirming the modal performs the action', async () => {
	globalThis.__wp4ConfirmModalCalls = [];
	globalThis.__wp4ConfirmModalResult = true;
	const settings = baseSettings({ destructiveConfirmAction: { 'job-cancel': true } });
	let mutated = false;
	const performed = await runGuardedAction({}, settings, 'job-cancel', 'Cancel this job?', () => { mutated = true; });

	assert.equal(performed, true);
	assert.equal(mutated, true);
	assert.equal(globalThis.__wp4ConfirmModalCalls.length, 1);
});
