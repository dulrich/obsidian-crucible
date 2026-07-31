// WP-PF4: "cited by" hop on metadata-note search results. When a result's path sits under a
// configured metadata root (`_x_metadata` / `_yt_metadata` / `_blog_metadata`, read live from
// settings), the results renderer shows a compact "cited by" line listing the notes that link
// TO it — the reverse lookup a user otherwise has to dig through backlinks for.
//
// `isUnderMetadataRoot`/`isMetadataRootResult`/`buildCitedByDisplay` are pure functions
// exported from SearchModal.ts, bundled and tested directly the same way
// formatScore/formatAttribution/rerankUnavailableReason already are in
// searchModalFormat.test.mjs / searchRerankAffordance.test.mjs.
//
// The DOM-building half (renderCitedBy, the click-stops-propagation wiring, openPath skipping
// the query log) can't be reached the same way without a much larger Obsidian stub — per the
// precedent in searchRerankAffordance.test.mjs, that half is covered here as STRUCTURAL
// (source-text) assertions instead.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-cited-by-tests');
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

const { CITED_BY_MAX, isUnderMetadataRoot, isMetadataRootResult, buildCitedByDisplay } = await import(pathToFileURL(outfile));

/* ------------------------------------------------------------------------- isUnderMetadataRoot */

test('isUnderMetadataRoot: a note directly under the root matches', () => {
	assert.equal(isUnderMetadataRoot('_x_metadata/handle/1.md', '_x_metadata'), true);
});

test('isUnderMetadataRoot: a sibling folder sharing the root as a string prefix does NOT match (boundary)', () => {
	assert.equal(isUnderMetadataRoot('_x_metadata_other/1.md', '_x_metadata'), false);
});

test('isUnderMetadataRoot: an unrelated path does not match', () => {
	assert.equal(isUnderMetadataRoot('daily/2026-07-31.md', '_x_metadata'), false);
});

test('isUnderMetadataRoot: a configured non-default root is respected', () => {
	assert.equal(isUnderMetadataRoot('metadata/x/1.md', 'metadata/x'), true);
	assert.equal(isUnderMetadataRoot('metadata/x-other/1.md', 'metadata/x'), false);
});

test('isUnderMetadataRoot: an empty/unset root never matches (fails closed)', () => {
	assert.equal(isUnderMetadataRoot('anything.md', ''), false);
	assert.equal(isUnderMetadataRoot('anything.md', '   '), false);
});

test('isUnderMetadataRoot: a trailing slash on the configured root is tolerated', () => {
	assert.equal(isUnderMetadataRoot('_x_metadata/handle/1.md', '_x_metadata/'), true);
});

/* ------------------------------------------------------------------------- isMetadataRootResult */

test('isMetadataRootResult: matches when the path is under any of the configured roots', () => {
	const roots = ['_x_metadata', '_yt_metadata', '_blog_metadata'];
	assert.equal(isMetadataRootResult('_yt_metadata/abc123.md', roots), true);
	assert.equal(isMetadataRootResult('_blog_metadata/example-com/post.md', roots), true);
	assert.equal(isMetadataRootResult('daily/2026-07-31.md', roots), false);
});

test('isMetadataRootResult: an empty roots list matches nothing', () => {
	assert.equal(isMetadataRootResult('_x_metadata/handle/1.md', []), false);
});

/* ------------------------------------------------------------------------- buildCitedByDisplay */

test('buildCitedByDisplay: fewer citers than the cap shows all of them with no remainder', () => {
	const display = buildCitedByDisplay(['a.md', 'b.md']);
	assert.deepEqual(display.shown, ['a.md', 'b.md']);
	assert.equal(display.moreCount, 0);
});

test('buildCitedByDisplay: more citers than the cap truncates and reports the remainder', () => {
	const citers = ['a.md', 'b.md', 'c.md', 'd.md', 'e.md'];
	const display = buildCitedByDisplay(citers);
	assert.equal(display.shown.length, CITED_BY_MAX);
	assert.deepEqual(display.shown, citers.slice(0, CITED_BY_MAX));
	assert.equal(display.moreCount, citers.length - CITED_BY_MAX);
});

test('buildCitedByDisplay: zero citers shows nothing and no remainder', () => {
	const display = buildCitedByDisplay([]);
	assert.deepEqual(display.shown, []);
	assert.equal(display.moreCount, 0);
});

test('buildCitedByDisplay: an explicit max overrides the default cap', () => {
	const display = buildCitedByDisplay(['a.md', 'b.md', 'c.md'], 1);
	assert.deepEqual(display.shown, ['a.md']);
	assert.equal(display.moreCount, 2);
});

/* ------------------------------------------------------------------------- structural */

const searchModalSrc = readFileSync('src/search/SearchModal.ts', 'utf8');

test('STRUCTURAL: renderResults calls renderCitedBy for every result, reading metadata roots from settings', () => {
	const start = searchModalSrc.indexOf('private renderResults(results: SearchResult[]): void {');
	assert.ok(start >= 0, 'renderResults not found');
	const end = searchModalSrc.indexOf('\n\t}', searchModalSrc.indexOf('for (const result of results) {', start));
	const body = searchModalSrc.slice(start, end);
	assert.ok(body.includes('this.renderCitedBy('), 'renderResults must call renderCitedBy per result');
	assert.ok(body.includes('orchestrationXMetadataRoot'), 'must read the X metadata root live from settings');
	assert.ok(body.includes('orchestrationYoutubeMetadataRoot'), 'must read the YouTube metadata root live from settings');
	assert.ok(body.includes('orchestrationBlogsMetadataRoot'), 'must read the blogs metadata root live from settings');
});

test('STRUCTURAL: renderCitedBy renders nothing for zero citers and never a per-result vault scan', () => {
	const start = searchModalSrc.indexOf('private renderCitedBy(');
	assert.ok(start >= 0, 'renderCitedBy not found');
	const end = searchModalSrc.indexOf('\n\t}', start);
	const body = searchModalSrc.slice(start, end);
	assert.ok(body.includes('if (citers.length === 0) return;'), 'zero citers must render nothing');
	assert.ok(body.includes('this.plugin.searchManager.citersOf('), 'must use the cached-graph accessor, not a fresh scan');
	assert.ok(body.includes('is-muted') === false, 'the cited-by line is a neutral fact, not a status pill');
});

test('STRUCTURAL: the citer link click stops propagation so it does not open the main result row', () => {
	const idx = searchModalSrc.indexOf("linkEl.onclick");
	assert.ok(idx >= 0, 'citer link onclick handler not found');
	const end = searchModalSrc.indexOf('};', idx);
	const body = searchModalSrc.slice(idx, end);
	assert.ok(body.includes('evt.stopPropagation()'), 'must stop propagation so the row-level open handler does not also fire');
	assert.ok(body.includes('this.openPath('), 'must open the citer path, not the main result');
});

test('STRUCTURAL: openPath does not touch the query log — a citer is not a graded search result', () => {
	const start = searchModalSrc.indexOf('private async openPath(path: string): Promise<void> {');
	assert.ok(start >= 0, 'openPath not found');
	const end = searchModalSrc.indexOf('\n\t}', start);
	const body = searchModalSrc.slice(start, end);
	assert.ok(!body.includes('recordOpen'), 'openPath must not record a query-log open — see openResult for the graded-result path');
});

test('STRUCTURAL: the cited-by container uses the muted neutral CSS class, not a status/pill class', () => {
	const start = searchModalSrc.indexOf('private renderCitedBy(');
	assert.ok(start >= 0, 'renderCitedBy not found');
	const end = searchModalSrc.indexOf('\n\t}', start);
	const body = searchModalSrc.slice(start, end);
	assert.ok(body.includes("cls: 'crucible-search-result-cited-by'"), 'cited-by row must use its dedicated class');
	assert.ok(!body.includes('crucible-pill'), 'renderCitedBy must not use the pill primitive');
});
