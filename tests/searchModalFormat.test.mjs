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

const { formatScore, formatAttribution, formatSearchStatus } = await import(pathToFileURL(outfile));

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

// WP-3: a `degraded: true` response gets its own distinct status wording — visually paired in
// SearchModal.runSearch with the `is-degraded` CSS class — rather than reading like either a
// complete result set or a failure.
test('formatSearchStatus surfaces a degraded response distinctly from a normal one', () => {
	const normal = formatSearchStatus(5, 5, 'fts', false);
	const degraded = formatSearchStatus(0, 0, 'fts', false, false, true);
	assert.doesNotMatch(normal, /Partial results/);
	assert.match(degraded, /^Partial results — indexing in progress, retry in a moment/);
});

// The degraded prefix must not swallow the existing mode/FTS-only/rebuild-required suffixes —
// those are independent facts about the same response.
test('formatSearchStatus keeps the degraded prefix and the existing suffixes both present', () => {
	const line = formatSearchStatus(3, 10, 'hybrid', true, true, true);
	assert.match(line, /^Partial results — indexing in progress, retry in a moment · Showing 3 of 10 · hybrid · FTS only · index rebuild required$/);
});

// A default (omitted) `degraded` argument must stay the pre-WP-3 shape byte-for-byte — every
// existing call site that doesn't know about `degraded` yet must be unaffected.
test('formatSearchStatus defaults degraded to false, unchanged from before WP-3', () => {
	assert.equal(formatSearchStatus(2, undefined, undefined, false), '2 results');
});
