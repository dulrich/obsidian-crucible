import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-image-describe-jobconfig-tests');
const outfile = path.join(outdir, 'jobTypeConfig.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// Same stub shape as youtubeMetadataJob.test.mjs: jobTypeConfig.ts's dependency chain (via
// utils/youtubeApi.ts) imports from 'obsidian'. Only the pure dedupe-key functions are
// exercised here; nothing from the stub is actually called.
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
	imageDescribeBackfillJobConfig,
	imageDescribeBatchDedupeKey,
	imageDescribeBatchJobConfig,
	imageDescribeNoteDedupeKey,
	imageDescribeNoteJobConfig,
} = await import(pathToFileURL(outfile).href);

// ── image_describe_note ──────────────────────────────────────────────────────

test('imageDescribeNoteDedupeKey: targetPath present -> note:<targetPath>', () => {
	assert.equal(imageDescribeNoteDedupeKey({ targetPath: 'notes/a.md' }), 'note:notes/a.md');
});

test('imageDescribeNoteDedupeKey: no targetPath -> empty string (no dedupe key)', () => {
	assert.equal(imageDescribeNoteDedupeKey({}), '');
});

test('imageDescribeNoteJobConfig: file-backed, single worker, dedupeKey matches imageDescribeNoteDedupeKey', () => {
	const config = imageDescribeNoteJobConfig();
	assert.equal(config.persistence, 'file');
	assert.equal(config.maxParallel, 1);
	assert.equal(config.dedupeKey({ targetPath: 'a/b.md' }), 'note:a/b.md');
});

// idh-WP-2: `services` lets the drain stop claiming further image_describe_note jobs once the
// infra breaker reports the image-description provider unhealthy (a connection-class error or 3
// consecutive timeouts in `describeMd5Images`).
test('imageDescribeNoteJobConfig: declares the image-description-provider service dependency', () => {
	const config = imageDescribeNoteJobConfig();
	assert.deepEqual(config.services, ['image-description-provider']);
});

// ── image_describe_backfill ──────────────────────────────────────────────────

test('imageDescribeBackfillJobConfig: fixed single key so repeat enqueues collapse onto one active fan-out', () => {
	const config = imageDescribeBackfillJobConfig();
	assert.equal(config.dedupeKey({}), 'image-describe-backfill');
	assert.equal(config.dedupeKey({ anything: 'else' }), 'image-describe-backfill');
});

test('imageDescribeBackfillJobConfig: pinned to one worker at a time (maxParallelFixed set)', () => {
	const config = imageDescribeBackfillJobConfig();
	assert.equal(typeof config.maxParallelFixed, 'string');
	assert.ok(config.maxParallelFixed.length > 0);
});

// ── image_describe_batch ─────────────────────────────────────────────────────

test('imageDescribeBatchDedupeKey: backfillId + batchIndex -> image-describe:<id>:<index>', () => {
	assert.equal(imageDescribeBatchDedupeKey({ backfillId: 'run-1', batchIndex: 0 }), 'image-describe:run-1:0');
	assert.equal(imageDescribeBatchDedupeKey({ backfillId: 'run-1', batchIndex: 7 }), 'image-describe:run-1:7');
});

test('imageDescribeBatchDedupeKey: missing backfillId or a negative batchIndex -> empty string', () => {
	assert.equal(imageDescribeBatchDedupeKey({ batchIndex: 0 }), '');
	assert.equal(imageDescribeBatchDedupeKey({ backfillId: 'run-1', batchIndex: -1 }), '');
	assert.equal(imageDescribeBatchDedupeKey({ backfillId: 'run-1' }), '');
});

test('imageDescribeBatchJobConfig: two different batches of the same backfill produce different keys', () => {
	const config = imageDescribeBatchJobConfig();
	const key0 = config.dedupeKey({ backfillId: 'run-1', batchIndex: 0 });
	const key1 = config.dedupeKey({ backfillId: 'run-1', batchIndex: 1 });
	assert.notEqual(key0, key1);
});

test('imageDescribeBatchJobConfig: declares the image-description-provider service dependency', () => {
	const config = imageDescribeBatchJobConfig();
	assert.deepEqual(config.services, ['image-description-provider']);
});

test('imageDescribeBackfillJobConfig: does NOT declare the image-description-provider service — it only enqueues batches and prunes the store, never calls the provider itself', () => {
	const config = imageDescribeBackfillJobConfig();
	assert.equal(config.services, undefined);
});
