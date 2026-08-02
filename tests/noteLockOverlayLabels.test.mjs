import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Pure label-mapping tests for `src/noteLockOverlay.ts` (WP-H2). The module
// imports `obsidian` for `MarkdownView`/`CruciblePlugin` typing only, so bundle
// against the same minimal obsidian stub the other note-lock/chain tests use —
// `labelToText` itself never touches any of it.

const outdir = path.join(tmpdir(), 'obsidian-crucible-notelockoverlay-tests');
const outfile = path.join(outdir, 'noteLockOverlay.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/noteLockOverlay.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: [
					'export class MarkdownView {}',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { labelToText } = await import(pathToFileURL(outfile).href);

test('labelToText: the three named labels stay byte-identical', () => {
	assert.equal(labelToText('localize'), 'Localizing attachments…');
	assert.equal(labelToText('lint'), 'Linting…');
	assert.equal(labelToText('yt-metadata'), 'Fetching metadata…');
});

test('labelToText: chain:* stays byte-identical', () => {
	assert.equal(labelToText('chain:Ingest as News'), 'Running chain: Ingest as News');
	assert.equal(labelToText('chain:'), 'Running chain: ');
});

test('labelToText: command:<id> maps to "Running: <id>…" (new in WP-H2)', () => {
	assert.equal(labelToText('command:lint-note'), 'Running: lint-note…');
	assert.equal(labelToText('command:lint-cleanup-transcript'), 'Running: lint-cleanup-transcript…');
	assert.equal(labelToText('command:'), 'Running: …');
});

test('labelToText: unknown labels still fall back to "Working…"', () => {
	assert.equal(labelToText('something-unmapped'), 'Working…');
	assert.equal(labelToText(''), 'Working…');
});
