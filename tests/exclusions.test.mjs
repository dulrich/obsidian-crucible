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
		{ folder: '/archive/', lint: true, search: false, localize: false },
		{ folder: 'archive', lint: false, search: true, localize: true },
	]), [{ folder: 'archive', lint: true, search: true, localize: true }]);
});

test('ensureDefaultSearchExclusion adds _crucible search exclusion once', () => {
	assert.deepEqual(ensureDefaultSearchExclusion([]), [{ folder: '_crucible', lint: false, search: true, localize: false }]);
	assert.deepEqual(
		ensureDefaultSearchExclusion([{ folder: '_crucible', lint: true, search: true, localize: false }]),
		[{ folder: '_crucible', lint: true, search: true, localize: false }],
	);
});

test('migrateExcludedFolders preserves legacy lint exclusions as lint- and localize-excluded', () => {
	assert.deepEqual(migrateExcludedFolders([], ['archive']), [
		{ folder: '_crucible', lint: false, search: true, localize: false },
		{ folder: 'archive', lint: true, search: false, localize: true },
	]);
});

test('migrateExcludedFolders defaults localize to lint for rows missing the field', () => {
	assert.deepEqual(migrateExcludedFolders([
		{ folder: 'linted', lint: true, search: false },
		{ folder: 'searched', lint: false, search: true },
	], []), [
		{ folder: '_crucible', lint: false, search: true, localize: false },
		{ folder: 'linted', lint: true, search: false, localize: true },
		{ folder: 'searched', lint: false, search: true, localize: false },
	]);
});

test('migrateExcludedFolders keeps an explicit localize choice (independent of lint)', () => {
	assert.deepEqual(migrateExcludedFolders([
		{ folder: 'initiatives', lint: false, search: false, localize: true },
	], []), [
		{ folder: '_crucible', lint: false, search: true, localize: false },
		{ folder: 'initiatives', lint: false, search: false, localize: true },
	]);
});

test('isPathExcluded honors the independent localize scope', () => {
	const settings = { excludedFolders: [{ folder: 'initiatives', lint: false, search: false, localize: true }] };
	assert.equal(isPathExcluded(settings, 'initiatives/post.md', 'localize'), true);
	assert.equal(isPathExcluded(settings, 'initiatives/post.md', 'lint'), false);
});
