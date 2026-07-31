import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// r2f-WP1: the YouTube Data API playlistItems.list tracker fetch that replaces the dead RSS
// endpoint (see the orchestration AGENTS.md tracker entry — `feeds/videos.xml` 404s for every
// channel as of ~May 2026). Three pure/near-pure surfaces in src/orchestration/utils/youtubeApi.ts:
// `uploadsPlaylistIdFor` (the UC->UU playlist-id string swap, no channels.list resolution call),
// `playlistItemsToRemoteVideos` (the item -> RemoteVideo mapper), and `fetchChannelUploads`'s
// missing-key config-gap error, which must be a plain Error, not YoutubeApiUnavailableError (a
// missing key must never open the shared youtube-api service breaker). Same bundling/requestUrl-stub
// technique as tests/youtubeApiServiceHealth.test.mjs.

const outdir = path.join(tmpdir(), 'obsidian-crucible-youtube-uploads-playlist-tests');
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
					'export async function requestUrl(options) { return await globalThis.__youtubeUploadsRespond(options); }',
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
	uploadsPlaylistIdFor,
	playlistItemsToRemoteVideos,
	fetchChannelUploads,
	YoutubeApiUnavailableError,
	YoutubeApiKeyMissingError,
} = await import(pathToFileURL(outfile).href);

function makePlugin(apiKey) {
	return { secretRegistry: { get: async () => apiKey } };
}

// ── uploadsPlaylistIdFor: pure UC->UU swap, no resolution call ─────────────────────────────

test('uploadsPlaylistIdFor swaps the UC prefix for UU, keeping the rest of the id', () => {
	assert.equal(uploadsPlaylistIdFor('UCxxxxxxxxxxxxxxxxxxxxxx'), 'UUxxxxxxxxxxxxxxxxxxxxxx');
});

test('uploadsPlaylistIdFor only swaps the first two characters', () => {
	assert.equal(uploadsPlaylistIdFor('UCUC1234567890abcdefghij'), 'UUUC1234567890abcdefghij');
});

// ── playlistItemsToRemoteVideos: the pure item -> RemoteVideo mapper ───────────────────────

test('maps a normal playlistItems item to RemoteVideo', () => {
	const json = {
		items: [{
			snippet: { title: 'A Title', publishedAt: '2026-07-01T00:00:00Z', channelTitle: 'A Channel', resourceId: { videoId: 'shouldNotUse1' } },
			contentDetails: { videoId: 'aBcDeFgHiJk', videoPublishedAt: '2026-07-02T00:00:00Z' },
		}],
	};
	const out = playlistItemsToRemoteVideos(json);
	assert.equal(out.length, 1);
	assert.deepEqual(out[0], {
		videoId: 'aBcDeFgHiJk',
		title: 'A Title',
		publishedAt: '2026-07-02T00:00:00Z',
		channelName: 'A Channel',
		url: 'https://www.youtube.com/watch?v=aBcDeFgHiJk',
	});
});

test('falls back to snippet.resourceId.videoId when contentDetails.videoId is missing', () => {
	const json = {
		items: [{
			snippet: { title: 'Fallback Title', publishedAt: '2026-07-03T00:00:00Z', channelTitle: 'C', resourceId: { videoId: 'zYxWvUtSrQp' } },
			contentDetails: {},
		}],
	};
	const out = playlistItemsToRemoteVideos(json);
	assert.equal(out.length, 1);
	assert.equal(out[0].videoId, 'zYxWvUtSrQp');
	assert.equal(out[0].publishedAt, '2026-07-03T00:00:00Z');
});

test('skips an item whose id fails the 11-char shape check', () => {
	const json = {
		items: [
			{ snippet: { title: 'Too short' }, contentDetails: { videoId: 'short' } },
			{ snippet: { title: 'No id at all' }, contentDetails: {} },
			{ snippet: { title: 'Valid', channelTitle: 'C' }, contentDetails: { videoId: 'validId1234' } },
		],
	};
	const out = playlistItemsToRemoteVideos(json);
	assert.equal(out.length, 1);
	assert.equal(out[0].videoId, 'validId1234');
});

test('missing/empty title defaults to (untitled)', () => {
	const json = { items: [{ snippet: {}, contentDetails: { videoId: 'noTitleId12' } }] };
	const out = playlistItemsToRemoteVideos(json);
	assert.equal(out[0].title, '(untitled)');
});

test('missing publishedAt on both contentDetails and snippet defaults to empty string', () => {
	const json = { items: [{ snippet: { title: 'T' }, contentDetails: { videoId: 'noDateId123' } }] };
	const out = playlistItemsToRemoteVideos(json);
	assert.equal(out[0].publishedAt, '');
});

test('an empty/malformed items shape maps to an empty array rather than throwing', () => {
	assert.deepEqual(playlistItemsToRemoteVideos({}), []);
	assert.deepEqual(playlistItemsToRemoteVideos(null), []);
	assert.deepEqual(playlistItemsToRemoteVideos({ items: 'not-an-array' }), []);
});

// ── fetchChannelUploads: missing key is a config gap, not service unhealth ────────────────

test('fetchChannelUploads with no configured key throws a typed, actionable config error', async () => {
	const plugin = makePlugin('');
	await assert.rejects(
		() => fetchChannelUploads(plugin, 'UCxxxxxxxxxxxxxxxxxxxxxx'),
		(err) => {
			assert.ok(!(err instanceof YoutubeApiUnavailableError), 'a config gap must not be YoutubeApiUnavailableError');
			// rem-R1: the consumer classifies on the TYPE. Before, FeedTrackerWorkflow
			// matched this message against a literal it had to keep in sync by hand.
			assert.ok(err instanceof YoutubeApiKeyMissingError, 'the config gap is its own error class');
			assert.equal(err.failureReason, 'no-api-key', 'it carries the typed cause the failed result stamps');
			assert.match(err.message, /YouTube Data API key not configured/, 'and the copy stays actionable');
			return true;
		},
	);
});

// ── fetchChannelUploads: the happy path wires the playlist id and maxResults=15 ────────────

test('fetchChannelUploads requests the UU-swapped playlist id with maxResults=15 and maps the response', async () => {
	let requestedUrl = '';
	globalThis.__youtubeUploadsRespond = async (options) => {
		requestedUrl = options.url;
		return {
			status: 200,
			text: JSON.stringify({
				items: [{
					snippet: { title: 'Live Video', publishedAt: '2026-07-04T00:00:00Z', channelTitle: 'Chan' },
					contentDetails: { videoId: 'liveVideo12' },
				}],
			}),
			headers: {},
		};
	};
	const plugin = makePlugin('test-api-key');
	const out = await fetchChannelUploads(plugin, 'UCabc1234567890abcdefgh');

	assert.match(requestedUrl, /playlistId=UUabc1234567890abcdefgh/);
	assert.match(requestedUrl, /maxResults=15/);
	assert.match(requestedUrl, /key=test-api-key/);
	assert.equal(out.length, 1);
	assert.equal(out[0].videoId, 'liveVideo12');
	assert.equal(out[0].url, 'https://www.youtube.com/watch?v=liveVideo12');
});

// ── fetchChannelUploads: a 5xx still classifies through the shared requestYoutubeApi path ──

test('fetchChannelUploads surfaces a 5xx as YoutubeApiUnavailableError like the other Data API calls', async () => {
	globalThis.__youtubeUploadsRespond = async () => ({ status: 503, text: 'Service Unavailable', headers: {} });
	const plugin = makePlugin('test-api-key');
	await assert.rejects(
		() => fetchChannelUploads(plugin, 'UCabc1234567890abcdefgh'),
		(err) => {
			assert.ok(err instanceof YoutubeApiUnavailableError);
			assert.equal(err.kind, 'server-error');
			return true;
		},
	);
});
