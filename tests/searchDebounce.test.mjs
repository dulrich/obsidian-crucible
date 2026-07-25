import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-debounce-tests');
const outfile = path.join(outdir, 'debounce.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/debounce.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const {
	ACTIVE_NOTE_SEARCH_INDEX_DEBOUNCE_MS,
	DEFAULT_SEARCH_INDEX_DEBOUNCE_MS,
	SEARCH_TYPEAHEAD_DEBOUNCE_MS,
	SEARCH_TYPEAHEAD_MIN_QUERY_LENGTH,
	searchIndexDebounceMs,
	shouldAutoSearch,
} = await import(pathToFileURL(outfile));

test('ordinary search index edits use configured debounce with 5s default', () => {
	assert.equal(searchIndexDebounceMs({ searchIndexDebounceMs: 5_000 }, false), 5_000);
	assert.equal(searchIndexDebounceMs({ searchIndexDebounceMs: Number.NaN }, false), DEFAULT_SEARCH_INDEX_DEBOUNCE_MS);
});

test('active note search index edits wait for the active-note quiet period', () => {
	assert.equal(searchIndexDebounceMs({ searchIndexDebounceMs: 10 }, true), ACTIVE_NOTE_SEARCH_INDEX_DEBOUNCE_MS);
});

// The gate exists because the companion's cost scales with how much of the index the query
// matches, and the trailing term is prefix-expanded. Measured against the live 52,257-chunk
// index: "c" 733ms, "cr" 239ms, "cru" 27ms. Two characters is 9x the cost of three, so the
// minimum must not drift below 3 without re-measuring.
test('type-ahead only fires once a query is past the measured latency cliff', () => {
	assert.ok(SEARCH_TYPEAHEAD_MIN_QUERY_LENGTH >= 3, 'a 1-2 character query scans most of the index');
	assert.equal(shouldAutoSearch(''), false);
	assert.equal(shouldAutoSearch('cr'), false);
	assert.equal(shouldAutoSearch('cru'), true);
	assert.equal(shouldAutoSearch('crucible'), true);
});

test('type-ahead measures the trimmed query, not the raw input', () => {
	// Leading whitespace is what the user typed, not what gets searched: runSearch trims
	// before issuing, so the gate has to trim too or a padded short query slips through.
	assert.equal(shouldAutoSearch('  c  '), false);
	assert.equal(shouldAutoSearch('  cru  '), true);
});

// A debounce longer than the queries it paces just adds dead time; one much shorter fires a
// request per keystroke. 200ms sits above the ~27ms three-character case and below the point
// where typing feels unacknowledged.
test('type-ahead debounce stays in the interactive band', () => {
	assert.ok(SEARCH_TYPEAHEAD_DEBOUNCE_MS >= 100 && SEARCH_TYPEAHEAD_DEBOUNCE_MS <= 400);
});
