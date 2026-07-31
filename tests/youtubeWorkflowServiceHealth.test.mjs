import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// SE WP-4: the two Data API consumer workflows — YoutubeMetadataFetchWorkflow (both its
// per-note and standalone modes) and YoutubeChannelEnrichWorkflow — must catch
// YoutubeApiUnavailableError and defer with `serviceUnhealthy: { service: 'youtube-api', ... }`
// rather than let it propagate as an uncaught exception or misreport it as a job-level
// failure. `requestUrl` is wired to a settable global responder (same technique as
// tests/youtubeApiServiceHealth.test.mjs) so the underlying fetchYoutubeVideo/
// fetchYoutubeChannel calls can be made to surface a real classified error, exercising the
// whole path rather than mocking youtubeApi.ts itself.

const outdir = path.join(tmpdir(), 'obsidian-crucible-youtube-workflow-service-health-tests');
const outfile = path.join(outdir, 'youtubeWorkflows.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { YoutubeMetadataFetchWorkflow } from './src/orchestration/workflows/YoutubeMetadataFetchWorkflow';",
			"export { YoutubeChannelEnrichWorkflow } from './src/orchestration/workflows/YoutubeChannelEnrichWorkflow';",
			"export { TFile } from 'obsidian';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'youtube-workflow-test-entry.ts',
		loader: 'ts',
	},
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
					'export class App {}',
					'export class TFile {}',
					'export class TFolder {}',
					'export function normalizePath(p) { return p; }',
					'export async function requestUrl(options) { return await globalThis.__youtubeApiRespond(options); }',
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

const { YoutubeMetadataFetchWorkflow, YoutubeChannelEnrichWorkflow, TFile } = await import(pathToFileURL(outfile).href);

function respondWith(status, { text = '', headers = {} } = {}) {
	globalThis.__youtubeApiRespond = async () => ({ status, text, headers, json: undefined, arrayBuffer: new ArrayBuffer(0) });
}

// A pass-through lock: these tests are single-flight and not testing lock semantics, only
// that a YoutubeApiUnavailableError thrown from inside the locked callback still reaches the
// workflow's catch.
function makeNoteLocks() {
	return {
		withResourceLock: (_kind, _id, _label, fn) => fn(),
		withLock: (_path, _label, fn) => fn(),
	};
}

function makePlugin({ apiKey = 'test-api-key', existingNote } = {}) {
	return {
		app: {
			vault: {
				getAbstractFileByPath: p => (existingNote && p === existingNote.path ? existingNote : null),
			},
			metadataCache: { getFileCache: () => null },
		},
		settings: { orchestrationYoutubeMetadataRoot: '_yt_metadata' },
		secretRegistry: { get: async () => apiKey },
		noteLocks: makeNoteLocks(),
	};
}

function makeCtx(plugin) {
	const signal = new AbortController().signal;
	return { plugin, signal, throwIfAborted: () => signal.throwIfAborted() };
}

// ── YoutubeMetadataFetchWorkflow: standalone mode (no targetPath) ──────────────────────────

test('standalone metadata fetch defers with serviceUnhealthy naming youtube-api on a 5xx', async () => {
	respondWith(503, {});
	const plugin = makePlugin();
	const result = await new YoutubeMetadataFetchWorkflow().run(
		{ id: 'job-1', params: { videoId: 'vid1' } },
		makeCtx(plugin),
	);

	assert.equal(result.status, 'deferred');
	assert.deepEqual(result.serviceUnhealthy, {
		service: 'youtube-api',
		kind: 'server-error',
		reason: result.error,
	});
});

test('standalone metadata fetch defers on quota with the fixed retryAfterMs', async () => {
	respondWith(403, { text: JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } }) });
	const plugin = makePlugin();
	const result = await new YoutubeMetadataFetchWorkflow().run(
		{ id: 'job-2', params: { videoId: 'vid1' } },
		makeCtx(plugin),
	);

	assert.equal(result.status, 'deferred');
	assert.equal(result.serviceUnhealthy.service, 'youtube-api');
	assert.equal(result.serviceUnhealthy.kind, 'rate-limited');
	assert.equal(result.retryAfterMs, 60 * 60_000);
});

// Regression: the missing-credential path is NOT a service outage — it must stay a plain
// job-level failure with the existing typed `failureReason`, unaffected by the new try/catch.
test('standalone metadata fetch with no API key stays a job-level failed, not deferred', async () => {
	const plugin = makePlugin({ apiKey: '' });
	const result = await new YoutubeMetadataFetchWorkflow().run(
		{ id: 'job-3', params: { videoId: 'vid1' } },
		makeCtx(plugin),
	);

	assert.equal(result.status, 'failed');
	assert.equal(result.failureReason, 'no-api-key');
	assert.equal(result.serviceUnhealthy, undefined);
});

// ── YoutubeMetadataFetchWorkflow: per-note mode (targetPath set) ───────────────────────────

test('per-note metadata fetch defers with serviceUnhealthy naming youtube-api on a 429', async () => {
	respondWith(429, { headers: { 'Retry-After': '90' } });
	const note = Object.assign(new TFile(), { path: 'note.md' });
	const plugin = makePlugin({ existingNote: note });
	const result = await new YoutubeMetadataFetchWorkflow().run(
		{ id: 'job-4', params: { targetPath: 'note.md', videoId: 'vid1' } },
		makeCtx(plugin),
	);

	assert.equal(result.status, 'deferred');
	assert.deepEqual(result.serviceUnhealthy, {
		service: 'youtube-api',
		kind: 'rate-limited',
		reason: result.error,
	});
	assert.equal(result.retryAfterMs, 90_000);
});

// Regression: a note simply not existing is a job-level problem, never a service deferral.
test('per-note metadata fetch against a missing note stays job-level failed', async () => {
	const plugin = makePlugin();
	const result = await new YoutubeMetadataFetchWorkflow().run(
		{ id: 'job-5', params: { targetPath: 'gone.md', videoId: 'vid1' } },
		makeCtx(plugin),
	);

	assert.equal(result.status, 'failed');
	assert.equal(result.serviceUnhealthy, undefined);
});

// ── YoutubeChannelEnrichWorkflow ─────────────────────────────────────────────────────────────

test('channel enrichment defers with serviceUnhealthy naming youtube-api on a refused connection', async () => {
	globalThis.__youtubeApiRespond = async () => { throw new Error('connect ECONNREFUSED'); };
	const plugin = makePlugin();
	const result = await new YoutubeChannelEnrichWorkflow().run(
		{ id: 'job-6', params: { channelId: 'chan1' } },
		makeCtx(plugin),
	);

	assert.equal(result.status, 'deferred');
	assert.deepEqual(result.serviceUnhealthy, {
		service: 'youtube-api',
		kind: 'refused',
		reason: result.error,
	});
});

// Regression: a missing channel id is a job-level parameter problem, never a service deferral.
test('channel enrichment with no channelId stays job-level failed', async () => {
	const plugin = makePlugin();
	const result = await new YoutubeChannelEnrichWorkflow().run(
		{ id: 'job-7', params: {} },
		makeCtx(plugin),
	);

	assert.equal(result.status, 'failed');
	assert.equal(result.serviceUnhealthy, undefined);
});

// WP-VF-3: the channel workflow now stamps the same typed failureReason the
// metadata-fetch workflow already did — no behavior attaches to it on the
// settle path anymore (the DbJobBackend auto-source latch that read it was
// removed), but it's the single detectable signal UI affordances key off.
test('channel enrichment with no API key stays a job-level failed, stamped no-api-key', async () => {
	const plugin = makePlugin({ apiKey: '' });
	const result = await new YoutubeChannelEnrichWorkflow().run(
		{ id: 'job-8', params: { channelId: 'chan1' } },
		makeCtx(plugin),
	);

	assert.equal(result.status, 'failed');
	assert.equal(result.failureReason, 'no-api-key');
	assert.equal(result.serviceUnhealthy, undefined);
});
