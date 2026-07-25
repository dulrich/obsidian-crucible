// WP-3: the settings-tab file/folder pickers (`src/suggesters.ts`'s `FileSystemSuggest`,
// `src/folderPicker.ts`'s `MoveFileFolderPickerModal`) had the identical inverted-sort bug
// WP-1 fixed in the file-open palette: `a.result.score - b.result.score` against Obsidian's
// higher-is-better `SearchResult.score`, so they showed the worst matches first.
//
// Both files import real Obsidian runtime values (`AbstractInputSuggest`, `SuggestModal`,
// `instanceof TFile`/`TFolder`, `prepareFuzzySearch`, `renderResults`) and the `obsidian` npm
// package ships type declarations only — no runtime — so esbuild cannot resolve `"obsidian"`
// at all when bundling either file (confirmed: a bare `import { TFile } from "obsidian"` used
// as a value makes `esbuild.build` fail with "Could not resolve obsidian", full stop, even
// when the specific export under test never touches it). There is no way to bundle either
// file for `node:test`. Per the WP-3 brief, this suite instead exercises the shared, already
// bundle-tested `rankScore.ts` scorer through the *exact* comparator/tiebreak/composite-score
// algorithms the two pickers now run, plus structural (source-text) assertions that the
// wasteful re-fuzzy-search patterns the WP set out to remove are actually gone.
//
// Do not invent an injection point that lets a test double define its own score direction —
// that is precisely what hid the original bug. Every score in this file comes from the real
// `rankScore.ts` scorer.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-settings-picker-ranking-tests');
const outfile = path.join(outdir, 'rankScore.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/rankScore.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const {
	TIER_EXACT,
	buildRanges,
	compileQuery,
	scoreCandidateText,
	scoreCompiledText,
} = await import(pathToFileURL(outfile).href);

/* --------------------------------------------------- FileSystemSuggest ranking mirror */

// Mirrors `FileSystemSuggest.getSuggestions`'s fuzzy branch in `src/suggesters.ts`:
// compile once, score every candidate's path, drop non-matches, sort DESCENDING by score
// with shortest-path-then-shallowest-depth as the tiebreak. (`selectTopScored`'s bounded
// min-heap is a performance detail over this same ordering, not a different ordering — a
// full sort and a size-K heap select the same top-K set for a total order.)
function rankFileSystemPaths(query, paths, limit = 100) {
	const compiled = compileQuery(query);
	return paths
		.map(p => ({ path: p, result: scoreCompiledText(compiled, p) }))
		.filter(row => row.result !== null)
		.sort((a, b) => {
			if (a.result.score !== b.result.score) return b.result.score - a.result.score;
			if (a.path.length !== b.path.length) return a.path.length - b.path.length;
			return pathDepth(a.path) - pathDepth(b.path);
		})
		.slice(0, limit)
		.map(row => row.path);
}

function pathDepth(p) {
	return p.split('/').length;
}

test('SETTINGS PICKERS: best match sorts first — the regression that shipped', () => {
	// `FileSuggest`/`FolderSuggest` are the mandated control for every file-path input in
	// the settings tab (per this repo's own UI standards). Under the pre-fix ascending
	// comparator ("a.result.score - b.result.score") this exact-basename hit would have
	// sorted dead last behind every worse-scoring noise match instead of first.
	const noise = Array.from({ length: 50 }, (_, i) => `Archive/misc-${i}/unrelated-file-${i}.md`);
	const candidates = [...noise, 'crucible.md', 'Projects/crucible-notes.md'];
	const ranked = rankFileSystemPaths('crucible', candidates);
	assert.equal(ranked[0], 'crucible.md', 'the exact basename match must be first, not last');

	// The WORD-tier hit must outrank any admitted noise (which can only reach a lower,
	// path-fuzzy tier — nothing in the noise set contains "crucible" as a basename hit).
	const compiled = compileQuery('crucible');
	const wordScore = scoreCompiledText(compiled, 'Projects/crucible-notes.md').score;
	for (const p of noise) {
		const result = scoreCompiledText(compiled, p);
		if (result === null) continue;
		assert.ok(result.score < wordScore, `noise candidate ${p} scored ${result.score} >= WORD-tier hit's ${wordScore}`);
	}
});

test('an exact basename match outranks a fuzzy one over a 42,000-item synthetic vault', () => {
	const rng = mulberry32(42000);
	const candidates = [];
	for (let i = 0; i < 42000; i++) candidates.push(randomVaultPath(rng, i));
	// Planted deep in the corpus, not at either end — sort order must find it regardless.
	candidates.splice(21000, 0, 'Daily/2026/target-note.md');

	const ranked = rankFileSystemPaths('target-note', candidates, 100);
	assert.equal(ranked[0], 'Daily/2026/target-note.md');

	const compiled = compileQuery('target-note');
	const winnerScore = scoreCompiledText(compiled, 'Daily/2026/target-note.md').score;
	assert.equal(scoreCandidateText('target-note', 'Daily/2026/target-note.md').tier, TIER_EXACT);
	// Every other admitted candidate must score strictly lower than the exact match.
	for (const p of candidates) {
		if (p === 'Daily/2026/target-note.md') continue;
		const result = scoreCompiledText(compiled, p);
		if (result === null) continue;
		assert.ok(result.score < winnerScore, `${p} scored ${result.score} >= exact match's ${winnerScore}`);
	}
});

test('depth/length tiebreak matches the palette: shorter path wins, then shallower depth', () => {
	// Two basenames identical in every ranking-relevant way except length/depth.
	const ranked = rankFileSystemPaths('log', ['a/b/log.md', 'a/log.md', 'log.md', 'logbook-extended.md']);
	assert.deepEqual(ranked, ['log.md', 'a/log.md', 'a/b/log.md', 'logbook-extended.md']);
});

test('FileSystemSuggest empty-query ordering: shortest path first, then shallowest depth', () => {
	// Mirrors the `!inputStr` branch in `FileSystemSuggest.getSuggestions` directly — no
	// scorer involved, this is the "most recently listed" fallback ordering.
	const paths = ['a/b/x.md', 'zz.md', 'a/x.md', 'x.md'];
	const ranked = paths
		.slice()
		.sort((a, b) => (a.length - b.length) || (pathDepth(a) - pathDepth(b)));
	assert.deepEqual(ranked, ['x.md', 'zz.md', 'a/x.md', 'a/b/x.md']);
});

/* -------------------------------------------------------- folderPicker composite scoring */

// Mirrors `MoveFileFolderPickerModal.getSuggestions`'s composite-score construction in
// `src/folderPicker.ts`: ONE score call over `pinLabel + ' ' + path` (or bare `path` when
// there is no label) instead of two separate `fuzzySearch` calls. Highlight ranges are then
// built over `path` alone, NOT carried over from the composite — see the range test below.
function scoreFolderItem(compiled, pinLabel, itemPath) {
	const composite = pinLabel ? `${pinLabel} ${itemPath}` : itemPath;
	const result = scoreCompiledText(compiled, composite);
	if (result === null) return null;
	return { score: result.score, composite, ranges: buildRanges(compiled, itemPath) };
}

function rankFolderItems(query, items, limit = 10) {
	const compiled = compileQuery(query);
	return items
		.map((item, pinOrder) => ({ item, pinOrder, scored: scoreFolderItem(compiled, item.pinLabel, item.path) }))
		.filter(row => row.scored !== null)
		.sort((a, b) => {
			if (a.scored.score !== b.scored.score) return b.scored.score - a.scored.score;
			const depthA = pathDepth(a.item.path);
			const depthB = pathDepth(b.item.path);
			if (depthA !== depthB) return depthA - depthB;
			return a.item.path.localeCompare(b.item.path);
		})
		.slice(0, limit)
		.map(row => row.item.path);
}

test('folderPicker: descending by score, exactly like the file/folder suggesters', () => {
	const items = [
		{ path: 'Archive/2019/old-notes' },
		{ path: 'Daily' },
		{ path: 'Projects/daily-standups' },
	];
	const ranked = rankFolderItems('daily', items);
	assert.equal(ranked[0], 'Daily', 'the exact basename folder must rank first, not last');
});

test('folderPicker: one composite score call finds matches in either the pin label or the path', () => {
	const compiled = compileQuery('quarterly');
	// Matches only through the pin label — the path alone would never admit this query.
	const viaLabel = scoreFolderItem(compiled, 'Quarterly asset folder', 'Assets/2026-Q3');
	assert.ok(viaLabel !== null, 'a query matching only the pin label must still be admitted');
	// Matches only through the path — no label at all.
	const viaPath = scoreFolderItem(compiled, undefined, 'Reports/Quarterly');
	assert.ok(viaPath !== null);
	// A query matching neither half is rejected.
	assert.equal(scoreFolderItem(compiled, 'Pinned folder', 'Archive/misc'), null);
});

// The regression guard for a real defect found in review. Ranges must be built over `path`,
// never over the composite: a query term that matches only in the pin-label half has no
// position inside `path` at all, so carrying composite ranges across (even shifted by an
// offset) hands `renderResults` indices outside `path` — negative ones for the label half.
// `renderSuggestion` here has no try/catch, so those must never be produced in the first
// place. Every emitted range must be non-negative and inside `path`.
test('folderPicker: highlight ranges stay inside `path` even when the query matches the label', () => {
	const itemPath = 'Projects/notes';
	// "folder" appears ONLY in the pin label; "notes" appears only in the path.
	const compiled = compileQuery('folder notes');
	const scored = scoreFolderItem(compiled, 'Daily asset folder', itemPath);
	assert.ok(scored !== null, 'the composite score must still admit this item');
	assert.equal(scored.composite, 'Daily asset folder Projects/notes');

	for (const [from, to] of scored.ranges) {
		assert.ok(from >= 0, `range start must never be negative, got ${from}`);
		assert.ok(to <= itemPath.length, `range end must stay inside path, got ${to} > ${itemPath.length}`);
		assert.ok(from < to, 'ranges must be non-empty and ascending');
	}
});

test('folderPicker: a label-only match yields a ranked item with no bogus highlight', () => {
	// "quarterly" is absent from the path entirely, so the item still ranks (the label
	// carried it) but produces zero path ranges rather than an out-of-bounds one.
	const compiled = compileQuery('quarterly');
	const scored = scoreFolderItem(compiled, 'Quarterly asset folder', 'Assets/2026-Q3');
	assert.ok(scored !== null, 'a label-only match must still be admitted');
	for (const [from, to] of scored.ranges) {
		assert.ok(from >= 0 && to <= 'Assets/2026-Q3'.length);
	}
});

test('folderPicker: no-label items compose to the bare path', () => {
	const compiled = compileQuery('projects');
	const scored = scoreFolderItem(compiled, undefined, 'Projects/Active');
	assert.ok(scored !== null);
	assert.equal(scored.composite, 'Projects/Active');
	assert.deepEqual(scored.ranges, buildRanges(compiled, 'Projects/Active'));
});

/* ------------------------------------------------------------------------- structural */

const suggestersSrc = readFileSync('src/suggesters.ts', 'utf8');
const folderPickerSrc = readFileSync('src/folderPicker.ts', 'utf8');

test('STRUCTURAL: FileSystemSuggest.renderSuggestion reuses the scoring match, it does not recompute it', () => {
	const classStart = suggestersSrc.indexOf('export abstract class FileSystemSuggest');
	assert.ok(classStart >= 0, 'FileSystemSuggest class not found');
	const classEnd = suggestersSrc.indexOf('\nexport class FolderSuggest', classStart);
	assert.ok(classEnd > classStart);
	const classBody = suggestersSrc.slice(classStart, classEnd);

	// The whole point of the fix: no second fuzzy pass inside the render path.
	assert.ok(!classBody.includes('prepareFuzzySearch'), 'FileSystemSuggest must not call prepareFuzzySearch at all');

	const renderStart = classBody.indexOf('renderSuggestion(');
	const renderEnd = classBody.indexOf('\n    }', renderStart);
	const renderBody = classBody.slice(renderStart, renderEnd);
	// It must read from the same cache getSuggestions writes to, not score again.
	assert.ok(/matchCache\.get\(/.test(renderBody), 'renderSuggestion must look up a cached match, not recompute one');
	assert.ok(!/scoreCompiledText|scoreCandidateText|compileQuery/.test(renderBody), 'renderSuggestion must not re-score');

	const suggestionsStart = classBody.indexOf('getSuggestions(');
	const suggestionsBody = classBody.slice(suggestionsStart, renderStart);
	assert.ok(/matchCache\.set\(/.test(suggestionsBody), 'getSuggestions must populate the cache renderSuggestion reads');
});

test('STRUCTURAL: folderPicker collapses to a single score call per item, not two fuzzySearch calls', () => {
	assert.ok(!folderPickerSrc.includes('prepareFuzzySearch'), 'folderPicker.ts must not import/call prepareFuzzySearch');
	const suggestionsStart = folderPickerSrc.indexOf('getSuggestions(query: string)');
	const suggestionsEnd = folderPickerSrc.indexOf('\n\t}', suggestionsStart);
	const body = folderPickerSrc.slice(suggestionsStart, suggestionsEnd);
	const scoreCalls = (body.match(/scoreCompiledText\(/g) ?? []).length;
	assert.equal(scoreCalls, 1, 'getSuggestions must score each item exactly once per candidate loop iteration');
});

test('STRUCTURAL: folderPicker builds highlight ranges over `path`, never over the composite', () => {
	const suggestionsStart = folderPickerSrc.indexOf('getSuggestions(query: string)');
	const suggestionsEnd = folderPickerSrc.indexOf('\n\t}', suggestionsStart);
	const body = folderPickerSrc.slice(suggestionsStart, suggestionsEnd);
	assert.ok(/buildRanges\(compiled,\s*item\.path\)/.test(body), 'ranges must be built over item.path');
	assert.ok(!/buildRanges\(compiled,\s*composite\)/.test(body), 'ranges must NOT be built over the composite — label-half matches have no position in path');
	// The undocumented 4th `renderResults` parameter must stay unused; rebuilding over
	// `path` is what makes it unnecessary.
	assert.ok(!/matchOffset/.test(folderPickerSrc), 'the offset shim should be gone entirely');
});

test('STRUCTURAL: both pickers sort descending by score — grep for the inverted-sort regression', () => {
	for (const [name, src] of [['suggesters.ts', suggestersSrc], ['folderPicker.ts', folderPickerSrc]]) {
		assert.ok(!/result\.score\s*-\s*(?:b|winner)?\.?result\.score/.test(src), `${name}: found a suspicious ascending score subtraction`);
		assert.ok(!/a\.score\s*-\s*b\.score/.test(src), `${name}: found the exact inverted-sort pattern`);
	}
});

/* ---------------------------------------------------------------- helpers */

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const VAULT_WORDS = ['daily', 'log', 'notes', 'crucible', 'archive', 'media', 'chart', 'origins', 'legal', 'meeting', 'project', 'src'];
const VAULT_EXTENSIONS = ['md', 'png', 'canvas', 'pdf'];

function randomVaultPath(rng, i) {
	const depth = Math.floor(rng() * 4);
	const parts = [];
	for (let d = 0; d < depth; d++) parts.push(pick(rng, VAULT_WORDS));
	parts.push(`${pick(rng, VAULT_WORDS)}-${i}.${pick(rng, VAULT_EXTENSIONS)}`);
	return parts.join('/');
}

function pick(rng, list) {
	return list[Math.floor(rng() * list.length) % list.length];
}
