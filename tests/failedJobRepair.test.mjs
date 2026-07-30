import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// `classifyFailedJob`'s pattern table — the pure, shared half of failedJobRepair.
//
// thq WP-8: the bulk-requeue mechanics that used to live here (six tests driving a fake
// markdown JobStore through the deleted per-file classify/clearError/move loop) migrated
// to tests/failedJobRepairRequeue.test.mjs, which exercises the surviving single-UPDATE
// requeue against a real `:memory:` store. `DbJobBackend.failEntry`'s use of this SAME
// classifier — the forward-looking failureKind stamp — is tested alongside the rest of
// failEntry's behavior in tests/queueControl.test.mjs, not duplicated here.
const outdir = path.join(tmpdir(), 'obsidian-crucible-failedjobrepair-tests');
const outfile = path.join(outdir, 'failedJobRepair.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/orchestration/failedJobRepair.ts'],
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
					'globalThis.__failedJobRepairNotices = globalThis.__failedJobRepairNotices ?? [];',
					'export class Notice { constructor(message) { globalThis.__failedJobRepairNotices.push(message); } }',
					'export class Modal { constructor() {} open() {} close() {} }',
					'export class App {}',
					'export class TFile {}',
					'export class TFolder {}',
					'export class Setting {}',
					'export class FuzzySuggestModal {}',
					'export class FileSystemAdapter {}',
					'export function normalizePath(p) { return p; }',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
					'export const Platform = {};',
					'export const moment = () => {};',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { classifyFailedJob } = await import(pathToFileURL(outfile).href);

const JOB = { type: 'search_upsert_batch' };

// --- classifyFailedJob: the conservative pattern table -----------------------

test('classifyFailedJob matches every outage signature in the pattern table', () => {
	const mustMatch = [
		// connection-refused: both runtime shapes the real 2,022-file cohort could carry.
		'Search service /v1/index/upsert unreachable: TypeError: fetch failed: net::ERR_CONNECTION_REFUSED',
		'connect ECONNREFUSED 127.0.0.1:4801',
		// companion-unreachable
		'Search companion not reachable at http://localhost:4801/health. Start it with: home-compose up crucible-search (dev fallback: npm run search:serve)',
		'Search service /v1/index/upsert unreachable: TypeError: fetch failed',
		// companion-5xx
		'Search service /v1/search returned 503: Service Unavailable',
		'Search service /v1/index/upsert returned 500: internal error',
		// youtube-quota / youtube-5xx
		'YouTube Data API: quota exceeded',
		'YouTube Data API: HTTP 503 — Service Unavailable',
		// all-channel-feeds-failed
		'All 12 channel feeds failed to fetch.',
		'All 1 channel feeds failed to fetch.',
	];
	for (const text of mustMatch) {
		assert.equal(classifyFailedJob(JOB, text), 'service-outage', `expected a match: ${text}`);
	}
});

test('classifyFailedJob never matches the excluded genuine-failure shapes', () => {
	const mustNotMatch = [
		// video-not-found
		'YouTube Data API: video dQw4w9WgXcQ not found',
		'YouTube Data API: channel UC12345 not found',
		// bad/missing API key
		'YouTube Data API: forbidden (HTTP 403). Check the API key and Data API enablement.',
		'YouTube Data API key not configured.',
		// malformed JSON
		'YouTube Data API: malformed JSON response',
		'Unexpected token < in JSON at position 0',
		// a 4xx from the companion is a real client-side bug, not an outage
		'Search service /v1/index/upsert returned 400: width conflict',
		// cancelled
		'Job cancelled by user',
		'Cancelled before it ran',
	];
	for (const text of mustNotMatch) {
		assert.equal(classifyFailedJob(JOB, text), 'genuine', `expected no match: ${text}`);
	}
});

test('unclassifiable or missing error text is always genuine — never requeue what cannot be classified', () => {
	assert.equal(classifyFailedJob(JOB, undefined), 'genuine');
	assert.equal(classifyFailedJob(JOB, ''), 'genuine');
	assert.equal(classifyFailedJob(JOB, 'something totally unrelated happened'), 'genuine');
});
