import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Regression coverage for the JobStore.move claim-path fault: 14 live jobs were found
// stranded in running/ with `status: queued` and `updated == created` — physically
// claimed (moved out of inbox/) but never marked running, because the pre-fix code
// re-derived the moved file via a fresh `getAbstractFileByPath(targetPath)` lookup
// *after* the rename and threw on a miss, before the frontmatter write (and its
// rollback) ever ran. Obsidian TFiles are live: `renameFile` mutates `.path` in place,
// so the in-hand `file` already IS the moved file on the success path.

const outdir = path.join(tmpdir(), 'obsidian-crucible-jobstore-move-tests');
const outfile = path.join(outdir, 'JobStore.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/orchestration/JobStore.ts'],
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
					'export class App {}',
					'export class Notice { constructor() {} hide() {} setMessage() {} }',
					'export class TFile {',
					'  constructor(filePath) {',
					'    this.path = filePath;',
					'    this.name = filePath.split("/").pop();',
					'    this.basename = this.name.replace(/\\.md$/, "");',
					'    this.extension = "md";',
					'  }',
					'}',
					'export class TFolder { constructor() { this.children = []; } }',
					'globalThis.__JobStoreTestTFile = TFile;',
					'globalThis.__JobStoreTestTFolder = TFolder;',
					'export const Platform = { isDesktopApp: true, isMobileApp: false };',
					'export function normalizePath(p) { return String(p).replace(/\\/+/g, "/"); }',
					'export function parseYaml() { return {}; }',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { JobStore } = await import(pathToFileURL(outfile).href);
const TFile = globalThis.__JobStoreTestTFile;
const TFolder = globalThis.__JobStoreTestTFolder;

function baseJob(id, status) {
	return {
		id,
		type: 'search_upsert_file',
		status,
		priority: 'normal',
		lane: 'background',
		created: '2026-07-29T00:00:00.000Z',
		updated: '2026-07-29T00:00:00.000Z',
		inputPaths: [],
		outputPaths: [],
	};
}

// Minimal Obsidian stand-in for JobStore.move. `renameFile` mutates the live TFile's
// `.path`/`.name`/`.basename` in place (the real liveness behavior this fix depends
// on). `getAbstractFileByPath` is overridable per test so a test can simulate a lookup
// that has not caught up with the rename yet.
function makeApp() {
	const state = { renamed: [], processed: [], lookedUp: [] };
	const folderStub = new TFolder();
	const app = {
		vault: {
			getAbstractFileByPath: (p) => {
				state.lookedUp.push(p);
				return folderStub;
			},
			createFolder: async () => {},
			read: async () => '',
		},
		fileManager: {
			renameFile: async (file, newPath) => {
				state.renamed.push({ from: file.path, to: newPath });
				file.path = newPath;
				file.name = newPath.split('/').pop();
				file.basename = file.name.replace(/\.md$/, '');
			},
			processFrontMatter: async (file, update) => {
				const fm = {};
				update(fm);
				state.processed.push({ path: file.path, fm });
			},
		},
		metadataCache: {
			// No frontmatter block in `read()`'s content and no cache entry: the barrier's
			// freshness check treats this as trivially fresh, so updateFrontmatter writes
			// immediately without waiting on a `changed` event (that race is covered by
			// tests/frontmatterBarrier.test.mjs; this suite is about the claim path only).
			getFileCache: () => undefined,
			on: () => ({}),
			offref: () => {},
		},
	};
	return { app, state, folderStub };
}

function makeStore(app) {
	return new JobStore({ settings: { orchestrationQueueRoot: '_crucible/orchestration/queue' }, app });
}

test('move() trusts the live TFile after rename and never strands the file on a lagging lookup', async () => {
	const { app, state } = makeApp();
	const targetPath = '_crucible/orchestration/queue/running/job-1.md';
	// The exact fault symptom: a lookup for the just-renamed path reports a miss. The
	// fixed code must never need this lookup on the success path, because the live
	// `file` object's `.path` already reflects the rename.
	app.vault.getAbstractFileByPath = (p) => {
		state.lookedUp.push(p);
		if (p === targetPath) return null;
		return new TFolder();
	};

	const store = makeStore(app);
	const file = new TFile('_crucible/orchestration/queue/inbox/job-1.md');
	const job = baseJob('job-1', 'queued');

	const result = await store.move(file, job, 'running');

	assert.equal(result.file, file, 'the moved file is the same live TFile instance, not a re-looked-up one');
	assert.equal(result.file.path, targetPath, 'the live file carries the new path');
	assert.equal(result.job.status, 'running');
	assert.equal(state.processed.length, 1, 'the frontmatter write happened exactly once');
	assert.equal(state.processed[0].path, targetPath);
	assert.equal(state.processed[0].fm.status, 'running', 'status landed on the moved file, not stranded as stale queued');
	assert.equal(
		state.lookedUp.includes(targetPath),
		false,
		'a lagging getAbstractFileByPath lookup for the target path must never be consulted on the success path',
	);
});

test('move() falls back to a lookup only when the live file genuinely does not carry the new path, and rolls back + throws if that also misses', async () => {
	const { app, state } = makeApp();
	const targetPath = '_crucible/orchestration/queue/running/job-2.md';
	const fromPath = '_crucible/orchestration/queue/inbox/job-2.md';
	let renameCalls = 0;
	// Simulate an environment where the first rename call resolves but does NOT mutate
	// the TFile's `.path` in place (the assumption this fix leans on failing to hold),
	// forcing the fallback-lookup branch. The lookup also misses, so the only safe
	// outcome is: roll the rename back, leave no stale frontmatter, and throw.
	app.fileManager.renameFile = async (file, newPath) => {
		renameCalls++;
		state.renamed.push({ from: file.path, to: newPath, call: renameCalls });
		if (renameCalls === 2) {
			// The rollback call restores the identity so a caller re-reading `file` sees it
			// back at its original path.
			file.path = newPath;
			file.name = newPath.split('/').pop();
			file.basename = file.name.replace(/\.md$/, '');
		}
	};
	app.vault.getAbstractFileByPath = (p) => {
		state.lookedUp.push(p);
		if (p === targetPath) return null;
		return new TFolder();
	};

	const store = makeStore(app);
	const file = new TFile(fromPath);
	const job = baseJob('job-2', 'queued');

	await assert.rejects(() => store.move(file, job, 'running'), /file disappeared after rename/);

	assert.equal(renameCalls, 2, 'attempted a rollback rename after the fallback lookup missed');
	assert.equal(state.renamed[1].to, fromPath, 'rolled back to the original path');
	assert.equal(file.path, fromPath, 'the file ends up back where it started, not stranded mid-move');
	assert.equal(state.processed.length, 0, 'never wrote frontmatter for an unresolved move');
});
