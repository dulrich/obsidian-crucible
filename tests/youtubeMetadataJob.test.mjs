import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-ytjob-tests');
const outfile = path.join(outdir, 'jobTypeConfig.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// jobTypeConfig.ts imports coerceVideoId from youtubeApi.ts, which in turn imports
// from 'obsidian' (and transitively from src/utils.ts and src/frontmatter.ts, both
// of which also import from 'obsidian'). We stub 'obsidian' so esbuild can bundle
// the module in a plain Node test environment, identical to how postId.test.mjs
// stubs it for blogs.ts.
await esbuild.build({
	entryPoints: ['src/orchestration/jobTypeConfig.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({
				path: 'obsidian-test-stub',
				namespace: 'stub',
			}));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				// Provide no-op stubs for every obsidian symbol used in the
				// dependency chain. Only coerceVideoId (pure string logic) is
				// exercised by these tests; none of the Obsidian API calls fire.
				contents: `
export class App {}
export class TFile {}
export class TFolder {}
export function normalizePath(p) { return p; }
export async function requestUrl() { throw new Error('requestUrl unavailable in tests'); }
export const Platform = {};
export const moment = () => {};
`,
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { youtubeMetadataDedupeKey } = await import(pathToFileURL(outfile).href);

// ── youtubeMetadataDedupeKey ─────────────────────────────────────────────────

test('targetPath present → key is note:<targetPath>', () => {
	const key = youtubeMetadataDedupeKey({ targetPath: 'a/b.md', videoId: 'v1' });
	assert.equal(key, 'note:a/b.md');
});

test('no targetPath, videoId present → key is video:<videoId>', () => {
	const key = youtubeMetadataDedupeKey({ videoId: 'v1' });
	assert.equal(key, 'video:v1');
});

test('empty params → empty string (no dedupe key)', () => {
	const key = youtubeMetadataDedupeKey({});
	assert.equal(key, '');
});

test('two params with same videoId but different targetPaths produce different keys (per-note jobs both enqueue)', () => {
	const key1 = youtubeMetadataDedupeKey({ targetPath: 'notes/a.md', videoId: 'v1' });
	const key2 = youtubeMetadataDedupeKey({ targetPath: 'notes/b.md', videoId: 'v1' });
	assert.notEqual(key1, key2, 'different targetPaths → different keys');
	assert.equal(key1, 'note:notes/a.md');
	assert.equal(key2, 'note:notes/b.md');
});
