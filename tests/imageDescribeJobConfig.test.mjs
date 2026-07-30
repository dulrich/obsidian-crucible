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
//
// thq WP-4 (B-4): `resolveTimeoutMs` (JobBackend.ts) is bundled alongside jobTypeConfig.ts (same
// stdin multi-export technique as tests/workflowCancellation.test.mjs) so the per-type timeoutMs
// on the image job configs can be asserted end to end — "does the config's timeoutMs actually win
// over the global setting" — rather than only pinning the raw field value.
await esbuild.build({
	stdin: {
		contents: [
			"export * from './src/orchestration/jobTypeConfig';",
			"export { resolveTimeoutMs } from './src/orchestration/JobBackend';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'imageDescribeJobConfig-test-entry.ts',
		loader: 'ts',
	},
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
	resolveTimeoutMs,
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

// ── thq WP-4 (B-4): per-type timeoutMs on the image job types ───────────────────
//
// Investigation ground truth (`runs/dispatch/thq-feedback-items-investigation.md` §3): the
// generic 600s job-level backstop (`orchestrationAutorunTimeoutSeconds`) killed a resumed
// `image_describe_batch` that legitimately needed ~16 min of serial local model time. These pin
// the arithmetic from `jobTypeConfig.ts`'s comment (mirroring, not importing, the constants —
// IMAGE_DESCRIBE_PASS_TIMEOUT_MS=120_000, IMAGE_DESCRIBE_TRANSCODE_TIMEOUT_MS=30_000,
// IMAGE_DESCRIBE_BATCH_IMAGES=100 as of this writing) so a change to either side shows up as a
// failing test rather than silent drift.

const EXPECTED_BATCH_TIMEOUT_MS = 100 * (2 * 120_000 + 30_000) + 5 * 60_000; // 27_300_000ms (~7.6h)
const EXPECTED_NOTE_TIMEOUT_MS = EXPECTED_BATCH_TIMEOUT_MS * 5; // 136_500_000ms (~37.9h)

test('imageDescribeBatchJobConfig: timeoutMs is sized from images-per-job x 2 passes x pass-timeout + transcode + slack, well above the 600s generic default', () => {
	const config = imageDescribeBatchJobConfig();
	assert.equal(config.timeoutMs, EXPECTED_BATCH_TIMEOUT_MS);
	assert.ok(config.timeoutMs > 600_000, 'must exceed the generic backstop that killed the observed resumed batch');
});

test('imageDescribeNoteJobConfig: timeoutMs is a generous multiple of the batch ceiling (a note\'s image count is unbounded)', () => {
	const config = imageDescribeNoteJobConfig();
	assert.equal(config.timeoutMs, EXPECTED_NOTE_TIMEOUT_MS);
	assert.ok(config.timeoutMs > imageDescribeBatchJobConfig().timeoutMs, 'the note backstop must be at least as generous as the batch one');
});

test('resolveTimeoutMs: the image job types\' per-type timeoutMs wins over the global autorun setting', () => {
	const fakePlugin = { settings: { orchestrationAutorunTimeoutSeconds: 600 } };
	assert.equal(resolveTimeoutMs(fakePlugin, imageDescribeBatchJobConfig()), EXPECTED_BATCH_TIMEOUT_MS);
	assert.equal(resolveTimeoutMs(fakePlugin, imageDescribeNoteJobConfig()), EXPECTED_NOTE_TIMEOUT_MS);
});

test('resolveTimeoutMs: a type with no timeoutMs override (e.g. the backfill fan-out) still falls back to the global autorun setting', () => {
	const fakePlugin = { settings: { orchestrationAutorunTimeoutSeconds: 45 } };
	assert.equal(resolveTimeoutMs(fakePlugin, imageDescribeBackfillJobConfig()), 45_000);
});

test('resolveTimeoutMs: an explicit timeoutMs of 0 disables the backstop rather than falling back', () => {
	const fakePlugin = { settings: { orchestrationAutorunTimeoutSeconds: 600 } };
	assert.equal(resolveTimeoutMs(fakePlugin, { timeoutMs: 0 }), 0);
});
