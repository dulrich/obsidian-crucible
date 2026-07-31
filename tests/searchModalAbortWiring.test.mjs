// WP-SS1: SearchModal holds one live AbortController for whichever interactive search is
// in flight, and aborts it at every place that already bumps `searchGeneration` — a new search,
// the below-gate clear, and onClose (src/search/SearchModal.ts). The client-level behavior (the
// controller actually cancelling the fetch, SearchAbortedError never tripping the availability
// latch) is covered end-to-end in tests/searchClient.test.mjs; VaultSearchModal itself is an
// Obsidian `Modal` subclass whose `onOpen()` builds real DOM (contentEl/titleEl/modalEl) that a
// minimal "obsidian" stub does not provide — the established precedent for exactly this gap is
// tests/searchRerankAffordance.test.mjs's STRUCTURAL (source-text) section, which this follows.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync('src/search/SearchModal.ts', 'utf8');

test('STRUCTURAL: abortActiveSearch is idempotent-by-construction (optional chaining + null-out) and defined once', () => {
	const matches = src.match(/private abortActiveSearch\(\): void \{[\s\S]*?\n\t\}/);
	assert.ok(matches, 'abortActiveSearch method not found');
	const body = matches[0];
	assert.match(body, /this\.activeSearchController\?\.abort\(\)/, 'must optional-chain the abort call so it is a no-op with nothing in flight');
	assert.match(body, /this\.activeSearchController = null/, 'must clear the reference after aborting');
});

test('STRUCTURAL: the below-gate clear (below SEARCH_TYPEAHEAD_MIN_QUERY_LENGTH) aborts the active search before bumping searchGeneration', () => {
	const gateIdx = src.indexOf('if (!shouldAutoSearch(query)) {');
	assert.ok(gateIdx >= 0, 'below-gate branch not found');
	const gateEnd = src.indexOf('return;', gateIdx);
	const body = src.slice(gateIdx, gateEnd);
	const abortIdx = body.indexOf('this.abortActiveSearch();');
	const bumpIdx = body.indexOf('this.searchGeneration++;');
	assert.ok(abortIdx >= 0, 'below-gate branch must call abortActiveSearch()');
	assert.ok(bumpIdx >= 0, 'below-gate branch must still bump searchGeneration');
	assert.ok(abortIdx < bumpIdx, 'abort must happen at/before the generation bump, not after');
});

test('STRUCTURAL: onClose aborts the active search before bumping searchGeneration', () => {
	const idx = src.indexOf('onClose(): void {');
	assert.ok(idx >= 0, 'onClose not found');
	const end = src.indexOf('\n\t}', idx);
	const body = src.slice(idx, end);
	const abortIdx = body.indexOf('this.abortActiveSearch();');
	const bumpIdx = body.indexOf('this.searchGeneration++;');
	assert.ok(abortIdx >= 0, 'onClose must call abortActiveSearch()');
	assert.ok(bumpIdx >= 0, 'onClose must still bump searchGeneration');
	assert.ok(abortIdx < bumpIdx, 'abort must happen before the generation bump in onClose');
});

test('STRUCTURAL: runSearch aborts any prior search, mints a fresh AbortController, and threads its signal into both the sweep and plain search calls', () => {
	const idx = src.indexOf('private async runSearch(): Promise<void> {');
	assert.ok(idx >= 0, 'runSearch not found');
	const end = src.indexOf('\n\tprivate renderResults', idx);
	const body = src.slice(idx, end);

	const abortIdx = body.indexOf('this.abortActiveSearch();');
	const generationIdx = body.indexOf('const generation = ++this.searchGeneration;');
	const controllerIdx = body.indexOf('const controller = new AbortController();');
	const assignIdx = body.indexOf('this.activeSearchController = controller;');
	assert.ok(abortIdx >= 0, 'runSearch must abort the previous controller (it is superseding it)');
	assert.ok(generationIdx >= 0, 'runSearch must still bump the generation');
	assert.ok(controllerIdx >= 0, 'runSearch must mint a fresh AbortController for this request');
	assert.ok(assignIdx >= 0, 'runSearch must hold the new controller as the active one');
	assert.ok(abortIdx < controllerIdx, 'the previous controller must be aborted before a new one is minted');

	assert.match(body, /searchManager\.sweep\(query, undefined, controller\.signal\)/, 'sweep() must receive the controller signal');
	assert.match(body, /searchManager\.search\(query, undefined, controller\.signal\)/, 'search() must receive the controller signal');
});

test('STRUCTURAL: the catch block treats SearchAbortedError as silent (no Notice, no "Search failed") ahead of the generation check', () => {
	const idx = src.indexOf('private async runSearch(): Promise<void> {');
	const catchIdx = src.indexOf('} catch (e) {', idx);
	const catchEnd = src.indexOf('\n\t}', catchIdx);
	const body = src.slice(catchIdx, catchEnd);

	const abortCheckIdx = body.indexOf('if (e instanceof SearchAbortedError) return;');
	const generationCheckIdx = body.indexOf('if (generation !== this.searchGeneration) return;');
	const noticeIdx = body.indexOf('new Notice(');
	assert.ok(abortCheckIdx >= 0, 'the catch block must explicitly return early for SearchAbortedError');
	assert.ok(generationCheckIdx >= 0, 'the generation check must still exist as the second line of defense — do not remove it');
	assert.ok(abortCheckIdx < generationCheckIdx, 'the explicit abort check must run before the generic staleness check');
	assert.ok(abortCheckIdx < noticeIdx, 'the abort check must short-circuit before any Notice could be shown');
});

test('STRUCTURAL: SearchAbortedError is imported from ./types, not reimplemented locally', () => {
	assert.match(src, /import\s*\{[^}]*SearchAbortedError[^}]*\}\s*from\s*'\.\/types'/, 'SearchModal must import the shared SearchAbortedError class');
});
