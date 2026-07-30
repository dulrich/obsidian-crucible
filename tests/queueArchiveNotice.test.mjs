import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// thq WP-8's cutover surface: the one-time notice telling the user the old markdown
// queue folder is a frozen archive they may delete. There is no importer and never will
// be (a locked plan decision), so this notice is the ONLY thing standing between the
// user and ~20k orphaned job notes silently inflating their vault forever.

const outdir = path.join(tmpdir(), 'obsidian-crucible-archive-notice-tests');
const outfile = path.join(outdir, 'archiveNotice.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// The stub's TFolder/TFile are re-exported alongside the module under test, so the
// `instanceof TFolder` check inside the bundle matches what these tests construct.
await esbuild.build({
	stdin: {
		contents: [
			"export * from './src/orchestration/archiveNotice';",
			"export { TFolder, TFile } from 'obsidian';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'archive-notice-test-entry.ts',
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: [
					'globalThis.__archiveNotices = globalThis.__archiveNotices ?? [];',
					'export class Notice { constructor(message, timeout) { globalThis.__archiveNotices.push({ message, timeout }); } }',
					'export class TFolder {}',
					'export class TFile {}',
					'export class App {}',
					'export function normalizePath(p) { return p; }',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	shouldShowArchiveNotice,
	archiveNoticeText,
	maybeShowArchiveNotice,
	TFolder,
	TFile,
} = await import(pathToFileURL(outfile).href);

function notices() {
	globalThis.__archiveNotices = globalThis.__archiveNotices ?? [];
	return globalThis.__archiveNotices;
}
function resetNotices() {
	globalThis.__archiveNotices = [];
}

const QUEUE_ROOT = '_crucible/orchestration/queue';

function makeSettings(overrides = {}) {
	return { orchestrationQueueRoot: QUEUE_ROOT, orchestrationArchiveNoticeShown: false, ...overrides };
}

// A vault whose only interesting property is what `getAbstractFileByPath` answers for
// the queue root.
function makeApp({ folderExists = true, asFile = false } = {}) {
	return {
		vault: {
			getAbstractFileByPath: (p) => {
				if (p !== QUEUE_ROOT || !folderExists) return null;
				return asFile ? new TFile() : new TFolder();
			},
		},
	};
}

// --- the pure predicate -------------------------------------------------------

test('the notice is due when the folder still exists and the flag is unset', () => {
	assert.equal(shouldShowArchiveNotice(makeSettings(), true), true);
});

test('the notice is never due twice — the persisted flag is the whole mechanism', () => {
	assert.equal(shouldShowArchiveNotice(makeSettings({ orchestrationArchiveNoticeShown: true }), true), false);
});

test('the notice is not due once the user has deleted the folder', () => {
	// And the flag deliberately stays unset in that case: it means "was shown", and
	// nothing was.
	assert.equal(shouldShowArchiveNotice(makeSettings(), false), false);
});

test('a blank queue-root setting suppresses the notice — there is no folder to name', () => {
	assert.equal(shouldShowArchiveNotice(makeSettings({ orchestrationQueueRoot: '' }), true), false);
});

test('the notice text names the folder and says deleting it is the user\'s call', () => {
	const text = archiveNoticeText(QUEUE_ROOT);
	assert.ok(text.includes(QUEUE_ROOT), 'the user has to be told WHICH folder');
	assert.match(text, /frozen archive/);
	assert.match(text, /you can delete it/, 'and that deleting it is their call to make');
	assert.doesNotMatch(text, /has been deleted|removed for you/i, 'nothing is auto-deleted, so nothing may claim it was');
});

// --- the effectful wrapper ----------------------------------------------------

test('showing the notice sets the flag and persists exactly once', async () => {
	resetNotices();
	const settings = makeSettings();
	let saves = 0;
	const app = makeApp();

	assert.equal(await maybeShowArchiveNotice(app, settings, async () => { saves++; }), true);
	assert.equal(notices().length, 1);
	assert.match(notices()[0].message, /frozen archive/);
	assert.ok(notices()[0].timeout >= 10000, 'long enough to read a path out of');
	assert.equal(settings.orchestrationArchiveNoticeShown, true);
	assert.equal(saves, 1);

	// Second startup: nothing at all.
	assert.equal(await maybeShowArchiveNotice(app, settings, async () => { saves++; }), false);
	assert.equal(notices().length, 1, 'shown once, ever');
	assert.equal(saves, 1, 'and no redundant settings write');
});

test('no folder means no notice, no flag, and no settings write', async () => {
	resetNotices();
	const settings = makeSettings();
	let saves = 0;
	const app = makeApp({ folderExists: false });

	assert.equal(await maybeShowArchiveNotice(app, settings, async () => { saves++; }), false);
	assert.deepEqual(notices(), []);
	assert.equal(settings.orchestrationArchiveNoticeShown, false);
	assert.equal(saves, 0);
});

test('a queue root that resolves to a FILE rather than a folder is not the archive', async () => {
	resetNotices();
	const settings = makeSettings();
	const app = makeApp({ asFile: true });

	assert.equal(await maybeShowArchiveNotice(app, settings, async () => {}), false);
	assert.deepEqual(notices(), []);
});
