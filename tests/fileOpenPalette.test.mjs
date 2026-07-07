import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-file-open-tests');
const outfile = path.join(outdir, 'fileOpenRanking.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/fileOpenRanking.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const {
	formatExtensionFilter,
	normalizeCreatePath,
	parseExtensionFilter,
	rankFileOpenItems,
} = await import(pathToFileURL(outfile).href);

const files = [
	{ path: 'Daily/2026-07-06.md', extension: 'md' },
	{ path: 'Archive/2026-07-06.md', extension: 'md' },
	{ path: 'Media/Chart.PNG', extension: 'png' },
	{ path: '_crucible/debug.md', extension: 'md' },
];

function scorePath(query, candidate) {
	const q = query.toLowerCase();
	const c = candidate.toLowerCase();
	let pos = -1;
	let score = 0;
	for (const ch of q) {
		pos = c.indexOf(ch, pos + 1);
		if (pos === -1) return null;
		score += pos;
	}
	return score;
}

function rank(overrides = {}) {
	return rankFileOpenItems({
		files,
		query: '2026',
		extensions: [],
		ignoredFolderMode: 'derank',
		createMissing: false,
		isIgnoredPath: p => p.startsWith('_crucible') || p.startsWith('Archive/'),
		scorePath,
		...overrides,
	});
}

test('fuzzy matching searches full file paths', () => {
	const items = rank({ query: 'mchart' });
	assert.deepEqual(items.map(item => item.path), ['Media/Chart.PNG']);
});

test('derank mode pushes search-excluded folders below normal matches', () => {
	const items = rank();
	assert.equal(items[0].path, 'Daily/2026-07-06.md');
	assert.deepEqual(items.slice(1).map(item => item.path), ['Archive/2026-07-06.md']);
});

test('hide mode removes search-excluded folders', () => {
	const items = rank({ ignoredFolderMode: 'hide' });
	assert.deepEqual(items.map(item => item.path), ['Daily/2026-07-06.md']);
});

test('include mode ranks ignored folders normally', () => {
	const items = rank({ ignoredFolderMode: 'include' });
	assert.deepEqual(items.map(item => item.path), ['Daily/2026-07-06.md', 'Archive/2026-07-06.md']);
});

test('extension filter is case-insensitive and blank means all files', () => {
	assert.deepEqual(rank({ query: 'chart', extensions: [] }).map(item => item.path), ['Media/Chart.PNG']);
	assert.deepEqual(rank({ query: 'chart', extensions: ['PNG'] }).map(item => item.path), ['Media/Chart.PNG']);
	assert.deepEqual(rank({ query: 'chart', extensions: ['md'] }).map(item => item.path), []);
});

test('create row is configurable and suppressed for existing paths', () => {
	assert.deepEqual(rank({ query: 'New Note', createMissing: false }).map(item => item.kind), []);
	assert.deepEqual(rank({ query: 'New Note', createMissing: true }), [{ kind: 'create', path: 'New Note.md' }]);
	assert.deepEqual(rank({ query: 'Daily/2026-07-06.md', createMissing: true }).map(item => item.kind), ['file']);
});

test('create paths append md only when no extension is present', () => {
	assert.equal(normalizeCreatePath('Projects/Foo'), 'Projects/Foo.md');
	assert.equal(normalizeCreatePath('Projects/Foo.md'), 'Projects/Foo.md');
	assert.equal(normalizeCreatePath('Projects/Foo.canvas'), null);
	assert.equal(normalizeCreatePath('Projects/'), null);
});

test('extension filter parser normalizes commas, whitespace, dots, and duplicates', () => {
	const parsed = parseExtensionFilter(' .md, canvas PDF md ');
	assert.deepEqual(parsed, ['md', 'canvas', 'pdf']);
	assert.equal(formatExtensionFilter(parsed), 'canvas, md, pdf');
});
