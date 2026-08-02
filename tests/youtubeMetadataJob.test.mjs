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

const {
	youtubeMetadataDedupeKey,
	referencedVideoJobParams,
	YOUTUBE_REFERENCED_VIDEO_PARAM,
} = await import(pathToFileURL(outfile).href);

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

// ── referenced-video mode (WP-J2) ────────────────────────────────────────────
//
// The flag, not the {targetPath, videoId} pair, is what selects the composite key:
// every legacy per-note enqueue site already passes both params, so inferring the mode
// from their presence would have re-keyed all of them.

test('referencedVideo flag → key is note:<path>:video:<id>', () => {
	const key = youtubeMetadataDedupeKey(referencedVideoJobParams('notes/a.md', 'v1'));
	assert.equal(key, 'note:notes/a.md:video:v1');
});

test('N referenced videos on ONE note each get their own key (they must not collapse)', () => {
	const key1 = youtubeMetadataDedupeKey(referencedVideoJobParams('notes/a.md', 'v1'));
	const key2 = youtubeMetadataDedupeKey(referencedVideoJobParams('notes/a.md', 'v2'));
	assert.notEqual(key1, key2);
	assert.equal(key2, 'note:notes/a.md:video:v2');
});

test("a referenced job never collapses onto the note's own primary metadata job", () => {
	const primary = youtubeMetadataDedupeKey({ targetPath: 'notes/a.md', videoId: 'own1' });
	const referenced = youtubeMetadataDedupeKey(referencedVideoJobParams('notes/a.md', 'own1'));
	assert.equal(primary, 'note:notes/a.md');
	assert.notEqual(referenced, primary);
});

test('the referenced flag alone (no videoId) does not mint a composite key', () => {
	const key = youtubeMetadataDedupeKey({ targetPath: 'notes/a.md', [YOUTUBE_REFERENCED_VIDEO_PARAM]: true });
	assert.equal(key, 'note:notes/a.md', 'falls back to the per-note shape');
});

test('a truthy-but-not-true flag value does not select referenced mode', () => {
	const key = youtubeMetadataDedupeKey({ targetPath: 'notes/a.md', videoId: 'v1', [YOUTUBE_REFERENCED_VIDEO_PARAM]: 'yes' });
	assert.equal(key, 'note:notes/a.md');
});

test('referencedVideoJobParams carries the flag and an optional title', () => {
	assert.deepEqual(referencedVideoJobParams('notes/a.md', 'v1'), {
		targetPath: 'notes/a.md',
		videoId: 'v1',
		[YOUTUBE_REFERENCED_VIDEO_PARAM]: true,
	});
	assert.deepEqual(referencedVideoJobParams('notes/a.md', 'v1', 'A title'), {
		targetPath: 'notes/a.md',
		videoId: 'v1',
		[YOUTUBE_REFERENCED_VIDEO_PARAM]: true,
		title: 'A title',
	});
});
