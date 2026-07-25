import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Bundles the real SearchModal.ts (Obsidian UI class) purely to reach its exported pure
// formatting helpers — formatScore/formatAttribution never touch the DOM or the Modal
// lifecycle, so a minimal obsidian stub is enough; nothing here instantiates VaultSearchModal.
const outdir = path.join(tmpdir(), 'obsidian-crucible-search-modal-format-tests');
const outfile = path.join(outdir, 'SearchModal.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/SearchModal.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: `
					export class App {}
					export class Modal { constructor() {} }
					export class Notice { constructor() {} }
					export class TFile {}
					export function debounce(fn) { return fn; }
					export function setIcon() {}
				`,
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { formatScore, formatAttribution } = await import(pathToFileURL(outfile));

test('formatAttribution renders the vector rank beside text/title ranks', () => {
	const parts = formatAttribution({ textRank: null, titleRank: null, vectorRank: 2, pooledChunks: 1 });
	assert.deepEqual(parts, ['vec #2']);
});

test('formatAttribution omits vector rank entirely for an FTS-only row', () => {
	const parts = formatAttribution({ textRank: 3, titleRank: 1, titleBoost: 0.5 });
	assert.deepEqual(parts, ['text #3', 'title #1', 'title +0.50']);
});

test('formatScore includes the vec score and the vector rank together for a hybrid hit', () => {
	const line = formatScore({
		chunkId: 'sem-1',
		path: 'Semantic.md',
		title: 'Semantic',
		snippet: 'x',
		score: 0.031,
		scoreVector: 0.987,
		scoreRrf: 0.031,
		attribution: { textRank: null, titleRank: null, vectorRank: 2, rrf: 0.031, pooledChunks: 1 },
	});
	assert.match(line, /vec 0\.987/);
	assert.match(line, /vec #2/);
});
