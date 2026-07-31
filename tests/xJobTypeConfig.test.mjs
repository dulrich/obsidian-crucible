import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-x-jobconfig-tests');
const outfile = path.join(outdir, 'jobTypeConfig.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// Same stub shape as tests/youtubeMetadataJob.test.mjs: jobTypeConfig.ts's dependency
// chain (via utils/youtubeApi.ts) imports from 'obsidian'. Only the pure dedupe-key
// functions and the two X config factories are exercised here.
await esbuild.build({
	entryPoints: ['src/orchestration/jobTypeConfig.ts'],
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

const { xMetadataFetchDedupeKey, xMetadataFetchJobConfig, xPostDiscoverJobConfig } =
	await import(pathToFileURL(outfile).href);

// ── xMetadataFetchDedupeKey ──────────────────────────────────────────────────────

test('a present statusId produces key status:<statusId>', () => {
	assert.equal(xMetadataFetchDedupeKey({ statusId: '2078296458122645635' }), 'status:2078296458122645635');
});

test('a statusId with surrounding whitespace is trimmed before keying', () => {
	assert.equal(xMetadataFetchDedupeKey({ statusId: '  123  ' }), 'status:123');
});

test('an absent/empty statusId produces the empty string (no dedupe key)', () => {
	assert.equal(xMetadataFetchDedupeKey({}), '');
	assert.equal(xMetadataFetchDedupeKey({ statusId: '' }), '');
	assert.equal(xMetadataFetchDedupeKey({ statusId: '   ' }), '');
});

test('a non-string statusId is coerced to the empty string, not thrown on', () => {
	assert.equal(xMetadataFetchDedupeKey({ statusId: 12345 }), '');
});

// ── xMetadataFetchJobConfig ──────────────────────────────────────────────────────

test('xMetadataFetchJobConfig is single-worker, politely rate-limited, and declares the x-oembed service', () => {
	const config = xMetadataFetchJobConfig();
	assert.equal(config.persistence, 'db');
	assert.equal(config.maxParallel, 1);
	assert.equal(config.minIntervalMs, 1000);
	assert.equal(config.terminalRetentionMs, 60_000);
	assert.deepEqual(config.services, ['x-oembed']);
	assert.equal(config.dedupeKey, xMetadataFetchDedupeKey, 'exports the same function object the discover/backfill paths key on');
});

// ── xPostDiscoverJobConfig ───────────────────────────────────────────────────────

test('xPostDiscoverJobConfig dedupes on note:<targetPath>, empty when absent', () => {
	const config = xPostDiscoverJobConfig();
	assert.equal(config.persistence, 'db');
	assert.equal(config.maxParallel, 1);
	assert.equal(config.dedupeKey({ targetPath: 'clips/a.md' }), 'note:clips/a.md');
	assert.equal(config.dedupeKey({}), '');
	assert.equal(config.dedupeKey({ targetPath: '' }), '');
});

test('xPostDiscoverJobConfig declares no services — discovery never reaches the oEmbed endpoint', () => {
	const config = xPostDiscoverJobConfig();
	assert.equal(config.services, undefined);
});
