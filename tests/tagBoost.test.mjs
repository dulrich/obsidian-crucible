// WP-TB2: client-side tag boost, gated on WP-TB1's spike measurement (weight 0.005,
// zero-regression across 52 graded corpus queries — plans/tag-boost-spike.md). `tagBoost.ts` is
// a pure, obsidian-free leaf module in the style of `linkGraph.ts`'s `applyLinkBoost`, so it
// unit-tests against plain data via the same esbuild-bundle-then-import pattern as
// tests/providerRefs.test.mjs / tests/linkGraph.test.mjs.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-tag-boost-tests');
const outfile = path.join(outdir, 'tagBoost.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/tagBoost.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const { applyTagBoost, normalizeTag, normalizeTagBoostTagsInput } = await import(pathToFileURL(outfile));

function result(resultPath, score, tags) {
	const r = { chunkId: `${resultPath}#0`, path: resultPath, title: resultPath, snippet: '', score };
	if (tags !== undefined) r.metadata = { tags };
	return r;
}

test('a matching result gains exactly weight; a non-matching result is untouched', () => {
	const results = [
		result('a.md', 0.5, ['gold']),
		result('b.md', 0.4, ['silver']),
	];
	const boosted = applyTagBoost(results, { tags: ['gold'], weight: 0.005 });
	const a = boosted.find(r => r.path === 'a.md');
	const b = boosted.find(r => r.path === 'b.md');
	assert.equal(a.score, 0.505);
	assert.equal(b.score, 0.4);
	assert.equal(b.attribution, undefined, 'non-matching result carries no attribution at all');
});

test('multi-tag config: a result matches if any configured tag matches any of its tags', () => {
	const results = [result('a.md', 0.5, ['bronze', 'silver'])];
	const boosted = applyTagBoost(results, { tags: ['gold', 'silver'], weight: 0.01 });
	assert.equal(boosted[0].score, 0.51);
});

test('normalizeTag strips a leading #, trims, and lowercases', () => {
	assert.equal(normalizeTag('#Gold'), 'gold');
	assert.equal(normalizeTag('  Gold  '), 'gold');
	assert.equal(normalizeTag('gold'), 'gold');
});

test('# and case normalization: configured "#Gold" matches a result tagged "gold"', () => {
	const results = [result('a.md', 0.5, ['gold'])];
	const boosted = applyTagBoost(results, { tags: [normalizeTag('#Gold')], weight: 0.01 });
	assert.equal(boosted[0].score, 0.51);
});

test('a result tagged "#Gold" (unnormalized, as if it slipped past the index) matches configured "gold"', () => {
	const results = [result('a.md', 0.5, ['#Gold'])];
	const boosted = applyTagBoost(results, { tags: ['gold'], weight: 0.01 });
	assert.equal(boosted[0].score, 0.51);
});

test('undefined metadata is guarded, not thrown', () => {
	const results = [result('a.md', 0.5)]; // no metadata at all
	const boosted = applyTagBoost(results, { tags: ['gold'], weight: 0.01 });
	assert.equal(boosted[0].score, 0.5);
});

test('non-array metadata.tags is guarded', () => {
	const r = result('a.md', 0.5);
	r.metadata = { tags: undefined };
	const boosted = applyTagBoost([r], { tags: ['gold'], weight: 0.01 });
	assert.equal(boosted[0].score, 0.5);
});

test('re-sort: a lower-ranked matching result can overtake a higher-ranked non-matching one', () => {
	const results = [
		result('top.md', 0.9, ['silver']),
		result('boosted.md', 0.85, ['gold']),
	];
	const boosted = applyTagBoost(results, { tags: ['gold'], weight: 0.1 });
	assert.deepEqual(boosted.map(r => r.path), ['boosted.md', 'top.md']);
});

test('attribution.boosts.tag is recorded on a boosted result and merges with an existing boosts.link', () => {
	const r = result('a.md', 0.5, ['gold']);
	r.attribution = { boosts: { link: 0.02 } };
	const boosted = applyTagBoost([r], { tags: ['gold'], weight: 0.005 });
	assert.deepEqual(boosted[0].attribution.boosts, { link: 0.02, tag: 0.005 });
});

test('gate-off (weight 0) is a byte-identical no-op: same result objects, same order', () => {
	const results = [result('a.md', 0.5, ['gold']), result('b.md', 0.4, ['silver'])];
	const boosted = applyTagBoost(results, { tags: ['gold'], weight: 0 });
	assert.equal(boosted, results, 'same array reference — structural early return, no map at all');
});

test('empty configured tag list is a byte-identical no-op', () => {
	const results = [result('a.md', 0.5, ['gold'])];
	const boosted = applyTagBoost(results, { tags: [], weight: 0.01 });
	assert.equal(boosted, results);
});

test('no result matches any configured tag: byte-identical no-op, same array reference', () => {
	const results = [result('a.md', 0.5, ['silver']), result('b.md', 0.4, ['bronze'])];
	const boosted = applyTagBoost(results, { tags: ['gold'], weight: 0.01 });
	assert.equal(boosted, results, 'same array reference — no matches means no map/sort at all');
});

test('empty results array is a byte-identical no-op', () => {
	const results = [];
	const boosted = applyTagBoost(results, { tags: ['gold'], weight: 0.01 });
	assert.equal(boosted, results);
});

test('structurally cannot add or remove a result — same path set in, same path set out', () => {
	const results = [result('a.md', 0.5, ['gold']), result('b.md', 0.4, []), result('c.md', 0.3)];
	const boosted = applyTagBoost(results, { tags: ['gold'], weight: 0.01 });
	assert.deepEqual(
		boosted.map(r => r.path).sort(),
		results.map(r => r.path).sort(),
	);
});

test('normalizeTagBoostTagsInput: split on comma, trim, strip leading #, drop empties, lowercase', () => {
	assert.deepEqual(
		normalizeTagBoostTagsInput(' #Gold, silver ,, #Bronze'),
		['gold', 'silver', 'bronze'],
	);
});

test('normalizeTagBoostTagsInput on an empty string yields an empty list', () => {
	assert.deepEqual(normalizeTagBoostTagsInput(''), []);
	assert.deepEqual(normalizeTagBoostTagsInput('   '), []);
});
