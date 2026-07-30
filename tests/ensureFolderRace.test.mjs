// thq follow-up: the "Folder already exists." startup storm. `ensureFolder` was a
// check-then-create with no catch — the one time the queue folder tree genuinely
// didn't exist (deleted on disk while Obsidian was closed), every concurrent void'ed
// startup chain saw `null` and raced createFolder; all but the winner rejected
// uncaught. These tests pin the two-layer fix: in-flight creates are shared per path,
// and a rejection is swallowed iff the folder exists afterwards (rethrown otherwise).
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-ensure-folder-tests');
const outfile = path.join(outdir, 'utils.mjs');
const stub = path.join(outdir, 'obsidian-stub.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// Minimal obsidian surface for src/utils.ts: TFolder for instanceof checks, and
// inert placeholders for the rest of its imports. esbuild INLINES this stub into
// the bundle, so the test's own import of it would otherwise get a different class
// instance and break `instanceof` — anchor the classes on globalThis so the bundled
// copy and the test's copy are the same object.
await writeFile(stub, `
export const TFolder = globalThis.__crucibleTestTFolder ??= class TFolder {};
export const TFile = globalThis.__crucibleTestTFile ??= class TFile {};
export const Platform = { isDesktopApp: true, isMobile: false };
export const moment = () => ({ format: () => '' });
export class App {}
`);

await esbuild.build({
	entryPoints: ['src/utils.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
	alias: { obsidian: stub },
});

const { ensureFolder } = await import(pathToFileURL(outfile).href);
const { TFolder } = await import(pathToFileURL(stub).href);

// A fake vault where createFolder resolves after a tick (so concurrent callers
// overlap) and rejects with core's exact message once the folder exists.
function makeApp() {
	const folders = new Set();
	const createCalls = [];
	const app = {
		vault: {
			getAbstractFileByPath: (p) => (folders.has(p) ? Object.assign(new TFolder(), { path: p }) : null),
			createFolder: async (p) => {
				createCalls.push(p);
				await new Promise((r) => setTimeout(r, 5));
				if (folders.has(p)) throw new Error('Folder already exists.');
				folders.add(p);
			},
		},
	};
	return { app, folders, createCalls };
}

test('concurrent ensureFolder calls on the same missing tree all resolve (no uncaught "Folder already exists.")', async () => {
	const { app, folders } = makeApp();
	const target = '_crucible/orchestration/queue/inbox';
	await Promise.all([
		ensureFolder(app, target),
		ensureFolder(app, target),
		ensureFolder(app, target),
	]);
	assert.ok(folders.has('_crucible'));
	assert.ok(folders.has(target));
});

test('in-flight creates are shared per path segment (one createFolder per segment across concurrent callers)', async () => {
	const { app, createCalls } = makeApp();
	await Promise.all([
		ensureFolder(app, '_crucible/orchestration/queue'),
		ensureFolder(app, '_crucible/orchestration/queue'),
	]);
	const perPath = createCalls.reduce((m, p) => m.set(p, (m.get(p) ?? 0) + 1), new Map());
	for (const [p, n] of perPath) assert.equal(n, 1, `expected one create for ${p}, saw ${n}`);
});

test('an "already exists" rejection is swallowed only when the folder actually exists afterwards', async () => {
	const { app, folders } = makeApp();
	// Simulate a foreign writer (another plugin / sync) winning the race between the
	// pre-check and the create: createFolder rejects, but the folder IS there.
	folders.add('a');
	const original = app.vault.createFolder;
	app.vault.createFolder = async (p) => {
		if (p === 'a/b') {
			folders.add('a/b'); // foreign winner landed it
			throw new Error('Folder already exists.');
		}
		return original(p);
	};
	await ensureFolder(app, 'a/b/c');
	assert.ok(folders.has('a/b/c'));
});

test('a rejection whose post-condition does NOT hold is rethrown', async () => {
	const { app, folders } = makeApp();
	folders.add('a');
	app.vault.createFolder = async (p) => {
		if (p === 'a/b') throw new Error('disk full');
		folders.add(p);
	};
	await assert.rejects(() => ensureFolder(app, 'a/b'), /disk full/);
});
