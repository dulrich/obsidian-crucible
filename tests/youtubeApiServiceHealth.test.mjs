import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// SE WP-4: `YoutubeApiUnavailableError` classification in src/orchestration/utils/youtubeApi.ts.
// Network errors, 5xx, 429, and 403-quota are service-level (retryable, deferred); 404,
// 403-bad-key, and malformed JSON stay job-level (permanent, plain Error) — see the plan's
// scope item 2. `requestUrl` is wired to a settable global responder (same technique as
// tests/providerModelProbe.test.mjs) so each test controls exactly one simulated response.

const outdir = path.join(tmpdir(), 'obsidian-crucible-youtube-api-service-health-tests');
const outfile = path.join(outdir, 'youtubeApi.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/orchestration/utils/youtubeApi.ts'],
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

const {
	fetchYoutubeVideo,
	fetchYoutubeChannel,
	YoutubeApiUnavailableError,
	YoutubeVideoUnavailableError,
	youtubeApiDeferredResult,
	YOUTUBE_QUOTA_RETRY_AFTER_MS,
} = await import(pathToFileURL(outfile).href);

function respondWith(status, { text = '', headers = {} } = {}) {
	globalThis.__youtubeApiRespond = async () => ({ status, text, headers, json: undefined, arrayBuffer: new ArrayBuffer(0) });
}

function respondWithNetworkError(message) {
	globalThis.__youtubeApiRespond = async () => { throw new Error(message); };
}

// ── Network-level failure → 'refused' ───────────────────────────────────────────────────────

test('a network-level failure (requestUrl throws) is a YoutubeApiUnavailableError kind refused', async () => {
	respondWithNetworkError('getaddrinfo ENOTFOUND www.googleapis.com');
	await assert.rejects(
		() => fetchYoutubeVideo('key', 'vid1'),
		(err) => {
			assert.ok(err instanceof YoutubeApiUnavailableError);
			assert.equal(err.kind, 'refused');
			assert.match(err.message, /request failed/);
			assert.equal(err.retryAfterMs, undefined);
			return true;
		},
	);
});

// ── 5xx → 'server-error' ────────────────────────────────────────────────────────────────────

test('a 5xx response is a YoutubeApiUnavailableError kind server-error', async () => {
	respondWith(503, { text: 'Service Unavailable' });
	await assert.rejects(
		() => fetchYoutubeVideo('key', 'vid1'),
		(err) => {
			assert.ok(err instanceof YoutubeApiUnavailableError);
			assert.equal(err.kind, 'server-error');
			assert.match(err.message, /HTTP 503/);
			return true;
		},
	);
});

// ── 429 → 'rate-limited', Retry-After header carried through when present ──────────────────

test('a 429 with a Retry-After header carries it as retryAfterMs (seconds -> ms)', async () => {
	respondWith(429, { headers: { 'Retry-After': '120' } });
	await assert.rejects(
		() => fetchYoutubeVideo('key', 'vid1'),
		(err) => {
			assert.ok(err instanceof YoutubeApiUnavailableError);
			assert.equal(err.kind, 'rate-limited');
			assert.equal(err.retryAfterMs, 120_000);
			return true;
		},
	);
});

test('a 429 with no Retry-After header still classifies as rate-limited, with no retryAfterMs guess', async () => {
	respondWith(429, {});
	await assert.rejects(
		() => fetchYoutubeVideo('key', 'vid1'),
		(err) => {
			assert.ok(err instanceof YoutubeApiUnavailableError);
			assert.equal(err.kind, 'rate-limited');
			assert.equal(err.retryAfterMs, undefined);
			return true;
		},
	);
});

// The header lookup is case-insensitive: servers and proxies are inconsistent about casing.
test('the Retry-After header lookup is case-insensitive', async () => {
	respondWith(429, { headers: { 'retry-after': '30' } });
	await assert.rejects(
		() => fetchYoutubeVideo('key', 'vid1'),
		(err) => {
			assert.equal(err.retryAfterMs, 30_000);
			return true;
		},
	);
});

// ── 403 quota → 'rate-limited' with the conservative fixed backoff ─────────────────────────

test('a 403 quota rejection is rate-limited with the fixed YOUTUBE_QUOTA_RETRY_AFTER_MS backoff', async () => {
	assert.equal(YOUTUBE_QUOTA_RETRY_AFTER_MS, 60 * 60_000, 'documented choice: a conservative fixed hour');
	respondWith(403, { text: JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } }) });
	await assert.rejects(
		() => fetchYoutubeVideo('key', 'vid1'),
		(err) => {
			assert.ok(err instanceof YoutubeApiUnavailableError);
			assert.equal(err.kind, 'rate-limited');
			assert.equal(err.retryAfterMs, YOUTUBE_QUOTA_RETRY_AFTER_MS);
			return true;
		},
	);
});

// ── Job-level, NOT service-level: 403-bad-key, 404, malformed JSON ──────────────────────────

test('a non-quota 403 (bad API key) stays a plain job-level Error, not YoutubeApiUnavailableError', async () => {
	respondWith(403, { text: JSON.stringify({ error: { errors: [{ reason: 'forbidden' }] } }) });
	await assert.rejects(
		() => fetchYoutubeVideo('key', 'vid1'),
		(err) => {
			assert.ok(!(err instanceof YoutubeApiUnavailableError));
			assert.match(err.message, /forbidden/);
			return true;
		},
	);
});

// The live not-found shape (WP-K1): the HTTP-404 branch is dead in practice, but stays
// typed for symmetry — see requestYoutubeApi's doc comment.
test('a 404 is a YoutubeVideoUnavailableError(deleted-or-private), not YoutubeApiUnavailableError', async () => {
	respondWith(404, {});
	await assert.rejects(
		() => fetchYoutubeVideo('key', 'missing-video'),
		(err) => {
			assert.ok(!(err instanceof YoutubeApiUnavailableError));
			assert.ok(err instanceof YoutubeVideoUnavailableError);
			assert.equal(err.reason, 'deleted-or-private');
			assert.match(err.message, /not found/);
			return true;
		},
	);
});

// ── The live not-found shape: HTTP 200 with items: [] (WP-K1) ──────────────────────────────

test('a 200 response with an empty items array is a YoutubeVideoUnavailableError(deleted-or-private)', async () => {
	respondWith(200, { text: JSON.stringify({ items: [] }) });
	await assert.rejects(
		() => fetchYoutubeVideo('key', 'deleted-video'),
		(err) => {
			assert.ok(!(err instanceof YoutubeApiUnavailableError));
			assert.ok(err instanceof YoutubeVideoUnavailableError);
			assert.equal(err.reason, 'deleted-or-private');
			assert.match(err.message, /deleted-video not found/);
			return true;
		},
	);
});

test('a 200 response with a missing items key is treated the same as an empty array', async () => {
	respondWith(200, { text: JSON.stringify({}) });
	await assert.rejects(
		() => fetchYoutubeVideo('key', 'deleted-video'),
		(err) => err instanceof YoutubeVideoUnavailableError && err.reason === 'deleted-or-private',
	);
});

test('malformed JSON in an otherwise-200 response stays a plain job-level Error', async () => {
	respondWith(200, { text: 'not json{{{' });
	await assert.rejects(
		() => fetchYoutubeVideo('key', 'vid1'),
		(err) => {
			assert.ok(!(err instanceof YoutubeApiUnavailableError));
			assert.match(err.message, /malformed JSON/);
			return true;
		},
	);
});

// ── The channel fetch path shares the same classifier ───────────────────────────────────────

test('fetchYoutubeChannel classifies a 5xx the same way as fetchYoutubeVideo', async () => {
	respondWith(500, {});
	await assert.rejects(
		() => fetchYoutubeChannel('key', 'chan1'),
		(err) => {
			assert.ok(err instanceof YoutubeApiUnavailableError);
			assert.equal(err.kind, 'server-error');
			return true;
		},
	);
});

// ── The pure result-shaping helper every consumer workflow uses ────────────────────────────

test('youtubeApiDeferredResult builds a deferred WorkflowResult naming youtube-api', () => {
	const err = new YoutubeApiUnavailableError('quota exceeded', 'rate-limited', 3_600_000);
	const result = youtubeApiDeferredResult(err);
	assert.deepEqual(result, {
		status: 'deferred',
		error: 'quota exceeded',
		notes: 'quota exceeded. Retrying shortly.',
		retryAfterMs: 3_600_000,
		serviceUnhealthy: { service: 'youtube-api', kind: 'rate-limited', reason: 'quota exceeded' },
	});
});

test('youtubeApiDeferredResult passes through an undefined retryAfterMs untouched', () => {
	const err = new YoutubeApiUnavailableError('rate limited (HTTP 429)', 'rate-limited');
	const result = youtubeApiDeferredResult(err);
	assert.equal(result.retryAfterMs, undefined);
});
