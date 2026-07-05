import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-auto-localize-tests');
const outfile = path.join(outdir, 'autoLocalizeScheduler.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/autoLocalizeScheduler.ts'],
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
					'export class TFile {}',
					'globalThis.__ObsidianTFile = TFile;',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { AutoLocalizeScheduler } = await import(pathToFileURL(outfile).href);

function makeFile(path, size = 0) {
	const file = new globalThis.__ObsidianTFile();
	file.path = path;
	file.extension = 'md';
	file.stat = { size };
	return file;
}

function makeScheduler(files, settings = {}) {
	const calls = [];
	const effectiveSettings = {
		localizeAttachmentsTriggerOnCreate: true,
		localizeAttachmentsTriggerOnEdit: true,
		...settings,
	};
	let locked = false;
	let materializing = false;
	const scheduler = new AutoLocalizeScheduler({
		resolveFile: path => files.get(path) ?? null,
		isLocked: () => locked,
		isMaterializing: () => materializing,
		sourceEnabled: source => source === 'create'
			? effectiveSettings.localizeAttachmentsTriggerOnCreate
			: effectiveSettings.localizeAttachmentsTriggerOnEdit,
		localize: async file => {
			calls.push({ path: file.path, silent: true });
			return true;
		},
	});
	return {
		scheduler,
		calls,
		setLocked: value => { locked = value; },
		setMaterializing: value => { materializing = value; },
	};
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('create-trigger localization waits for an initially empty clipped note to receive content', async () => {
	const file = makeFile('daily/day/2026-06-17/clip.md', 0);
	const files = new Map([[file.path, file]]);
	const { scheduler, calls } = makeScheduler(files, { localizeAttachmentsTriggerOnEdit: false });

	scheduler.schedule(file, 'create', 10);
	file.stat.size = 1024;
	await sleep(30);

	assert.deepEqual(calls, [{ path: file.path, silent: true }]);
	scheduler.clear();
});

test('scheduled localization follows a note rename before it runs', async () => {
	const oldPath = 'Clippings/clip.md';
	const newPath = 'daily/day/2026-06-17/clip.md';
	const file = makeFile(oldPath, 500);
	const files = new Map([[oldPath, file]]);
	const { scheduler, calls } = makeScheduler(files, { localizeAttachmentsTriggerOnEdit: false });

	scheduler.schedule(file, 'create', 50);
	files.delete(oldPath);
	file.path = newPath;
	files.set(newPath, file);
	scheduler.move(oldPath, newPath);
	const movedState = scheduler.get(newPath);
	assert.ok(movedState, 'pending localize timer should move to the renamed path');
	if (movedState.timer) clearTimeout(movedState.timer);
	movedState.timer = null;
	await scheduler.run(movedState);

	assert.deepEqual(calls, [{ path: newPath, silent: true }]);
	scheduler.clear();
});

test('locked edit-trigger localization is retried instead of dropped', async () => {
	const file = makeFile('daily/day/2026-06-17/clip.md', 500);
	const files = new Map([[file.path, file]]);
	const { scheduler, calls, setLocked } = makeScheduler(files, { localizeAttachmentsTriggerOnCreate: false });
	setLocked(true);
	const state = {
		path: file.path,
		sources: new Set(['edit']),
		firstScheduledAt: Date.now(),
		attempts: 0,
		timer: null,
	};

	await scheduler.run(state);
	assert.equal(calls.length, 0);
	const retry = scheduler.get(file.path);
	assert.ok(retry, 'locked note should be rescheduled');
	if (retry.timer) clearTimeout(retry.timer);
	retry.timer = null;

	setLocked(false);
	await scheduler.run(retry);
	assert.deepEqual(calls, [{ path: file.path, silent: true }]);
	scheduler.clear();
});
