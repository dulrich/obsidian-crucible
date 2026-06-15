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
	searchIndexDebounceMs,
} = await import(pathToFileURL(outfile));

test('ordinary search index edits use configured debounce with 5s default', () => {
	assert.equal(searchIndexDebounceMs({ searchIndexDebounceMs: 5_000 }, false), 5_000);
	assert.equal(searchIndexDebounceMs({ searchIndexDebounceMs: Number.NaN }, false), DEFAULT_SEARCH_INDEX_DEBOUNCE_MS);
});

test('active note search index edits wait for the active-note quiet period', () => {
	assert.equal(searchIndexDebounceMs({ searchIndexDebounceMs: 10 }, true), ACTIVE_NOTE_SEARCH_INDEX_DEBOUNCE_MS);
});
