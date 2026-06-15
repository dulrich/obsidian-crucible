import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-exclusions-tests');
const outfile = path.join(outdir, 'exclusions.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/exclusions.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const {
	dedupeExcludedFolders,
	ensureDefaultSearchExclusion,
	isPathExcluded,
	migrateExcludedFolders,
	normalizeExcludedFolder,
} = await import(pathToFileURL(outfile));

test('normalizeExcludedFolder trims slashes and backslashes', () => {
	assert.equal(normalizeExcludedFolder('/_crucible\\orchestration/'), '_crucible/orchestration');
});

test('isPathExcluded matches exact folders and nested children only', () => {
	const settings = { excludedFolders: [{ folder: '_crucible', lint: false, search: true }] };
	assert.equal(isPathExcluded(settings, '_crucible', 'search'), true);
	assert.equal(isPathExcluded(settings, '_crucible/orchestration/queue/job.md', 'search'), true);
	assert.equal(isPathExcluded(settings, '_crucible-other/note.md', 'search'), false);
});

test('isPathExcluded respects independent lint and search scopes', () => {
	const settings = {
		excludedFolders: [
			{ folder: 'archive', lint: true, search: false },
			{ folder: 'system', lint: false, search: true },
		],
	};
	assert.equal(isPathExcluded(settings, 'archive/note.md', 'lint'), true);
	assert.equal(isPathExcluded(settings, 'archive/note.md', 'search'), false);
	assert.equal(isPathExcluded(settings, 'system/note.md', 'lint'), false);
	assert.equal(isPathExcluded(settings, 'system/note.md', 'search'), true);
});

test('empty exclusion rows are inactive', () => {
	const settings = { excludedFolders: [{ folder: '', lint: true, search: true }] };
	assert.equal(isPathExcluded(settings, 'note.md', 'lint'), false);
	assert.equal(isPathExcluded(settings, 'note.md', 'search'), false);
});

test('dedupeExcludedFolders merges scopes by normalized folder', () => {
	assert.deepEqual(dedupeExcludedFolders([
		{ folder: '/archive/', lint: true, search: false },
		{ folder: 'archive', lint: false, search: true },
	]), [{ folder: 'archive', lint: true, search: true }]);
});

test('ensureDefaultSearchExclusion adds _crucible search exclusion once', () => {
	assert.deepEqual(ensureDefaultSearchExclusion([]), [{ folder: '_crucible', lint: false, search: true }]);
	assert.deepEqual(
		ensureDefaultSearchExclusion([{ folder: '_crucible', lint: true, search: true }]),
		[{ folder: '_crucible', lint: true, search: true }],
	);
});

test('migrateExcludedFolders preserves legacy lint exclusions as lint-only', () => {
	assert.deepEqual(migrateExcludedFolders([], ['archive']), [
		{ folder: '_crucible', lint: false, search: true },
		{ folder: 'archive', lint: true, search: false },
	]);
});
