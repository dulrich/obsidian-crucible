import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// xPost.ts and urlCanonicalize.ts are both dependency-light leaves (no obsidian
// import, directly or transitively — urlCanonicalize.ts's other dependency,
// youtube.ts, only pulls in the pure markdownTable helper), so no obsidian stub
// is needed here, unlike the youtubeApi/xApi test suites.
const outdir = path.join(tmpdir(), 'obsidian-crucible-xpost-tests');
const outfile = path.join(outdir, 'xPost.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { extractXStatusFromUrl, canonicalXStatusUrl } from './src/orchestration/utils/xPost';",
			"export { canonicalizeUrl } from './src/orchestration/utils/urlCanonicalize';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'x-post-test-entry.ts',
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const { extractXStatusFromUrl, canonicalXStatusUrl, canonicalizeUrl } = await import(pathToFileURL(outfile).href);

const STATUS_ID = '2078296458122645635';
const HANDLE = 'PandaAshwinee';

// ── extractXStatusFromUrl: host variants ────────────────────────────────────

const HOST_VARIANTS = ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'];

for (const host of HOST_VARIANTS) {
	test(`extractXStatusFromUrl parses the handle+status path on ${host}`, () => {
		const ref = extractXStatusFromUrl(`https://${host}/${HANDLE}/status/${STATUS_ID}`);
		assert.deepEqual(ref, { handle: HANDLE, statusId: STATUS_ID });
	});
}

test('extractXStatusFromUrl is case-insensitive on the hostname', () => {
	const ref = extractXStatusFromUrl(`https://WWW.X.COM/${HANDLE}/status/${STATUS_ID}`);
	assert.deepEqual(ref, { handle: HANDLE, statusId: STATUS_ID });
});

// ── query-param variants (the dup-record bug this WP fixes) ────────────────

test('?s=20 tracking param does not affect extraction', () => {
	const ref = extractXStatusFromUrl(`https://x.com/${HANDLE}/status/${STATUS_ID}?s=20`);
	assert.deepEqual(ref, { handle: HANDLE, statusId: STATUS_ID });
});

test('?t=abc tracking param does not affect extraction', () => {
	const ref = extractXStatusFromUrl(`https://twitter.com/${HANDLE}/status/${STATUS_ID}?t=abc`);
	assert.deepEqual(ref, { handle: HANDLE, statusId: STATUS_ID });
});

// ── /i/web/status/ (handle-less) ────────────────────────────────────────────

test('/i/web/status/<id> parses with a null handle', () => {
	const ref = extractXStatusFromUrl(`https://x.com/i/web/status/${STATUS_ID}`);
	assert.deepEqual(ref, { handle: null, statusId: STATUS_ID });
});

// ── trailing path suffix tolerance ──────────────────────────────────────────

test('a trailing /photo/1 segment after the id is tolerated', () => {
	const ref = extractXStatusFromUrl(`https://x.com/${HANDLE}/status/${STATUS_ID}/photo/1`);
	assert.deepEqual(ref, { handle: HANDLE, statusId: STATUS_ID });
});

// ── invalid inputs → null ───────────────────────────────────────────────────

test('an unrecognized host returns null', () => {
	assert.equal(extractXStatusFromUrl(`https://example.com/${HANDLE}/status/${STATUS_ID}`), null);
});

test('a recognized host with a non-status path returns null', () => {
	assert.equal(extractXStatusFromUrl(`https://x.com/${HANDLE}`), null);
	assert.equal(extractXStatusFromUrl(`https://x.com/${HANDLE}/likes`), null);
});

test('a digit run glued to trailing letters (not a clean id) returns null', () => {
	assert.equal(extractXStatusFromUrl(`https://x.com/${HANDLE}/status/${STATUS_ID}abc`), null);
});

test('a non-http(s) protocol returns null', () => {
	assert.equal(extractXStatusFromUrl(`ftp://x.com/${HANDLE}/status/${STATUS_ID}`), null);
});

test('an unparseable URL string returns null', () => {
	assert.equal(extractXStatusFromUrl('not a url'), null);
});

// ── id precision: 19-digit ids must survive as strings, never Number()'d ───

test('a 19-digit status id is preserved exactly as a string', () => {
	const bigId = '9223372036854775807'; // near int64 max — well past Number.MAX_SAFE_INTEGER
	const ref = extractXStatusFromUrl(`https://x.com/${HANDLE}/status/${bigId}`);
	assert.equal(ref.statusId, bigId);
	assert.equal(typeof ref.statusId, 'string');
});

// ── canonicalXStatusUrl ──────────────────────────────────────────────────────

test('canonicalXStatusUrl with a handle', () => {
	assert.equal(canonicalXStatusUrl(HANDLE, STATUS_ID), `https://x.com/${HANDLE}/status/${STATUS_ID}`);
});

test('canonicalXStatusUrl with a null handle uses the /i/web/status/ form', () => {
	assert.equal(canonicalXStatusUrl(null, STATUS_ID), `https://x.com/i/web/status/${STATUS_ID}`);
});

// ── canonicalizeUrl: every variant of one status converges on one identity ──

test('canonicalizeUrl maps every host/query/handle-suffix variant of one status to the same canonical string and exposes xStatusId', () => {
	const variants = [
		`https://x.com/${HANDLE}/status/${STATUS_ID}`,
		`https://www.x.com/${HANDLE}/status/${STATUS_ID}`,
		`https://mobile.x.com/${HANDLE}/status/${STATUS_ID}`,
		`https://twitter.com/${HANDLE}/status/${STATUS_ID}`,
		`https://www.twitter.com/${HANDLE}/status/${STATUS_ID}`,
		`https://mobile.twitter.com/${HANDLE}/status/${STATUS_ID}`,
		`https://x.com/${HANDLE}/status/${STATUS_ID}?s=20`,
		`https://x.com/${HANDLE}/status/${STATUS_ID}?t=someTrackingToken`,
		`https://twitter.com/${HANDLE}/status/${STATUS_ID}/photo/1`,
	];
	const expected = `https://x.com/${HANDLE}/status/${STATUS_ID}`;
	for (const url of variants) {
		const canon = canonicalizeUrl(url);
		assert.ok(canon, `expected ${url} to canonicalize`);
		assert.equal(canon.canonical, expected, `variant: ${url}`);
		assert.equal(canon.xStatusId, STATUS_ID, `variant: ${url}`);
	}
});

test('canonicalizeUrl on the handle-less /i/web/status/ form', () => {
	const canon = canonicalizeUrl(`https://x.com/i/web/status/${STATUS_ID}`);
	assert.equal(canon.canonical, `https://x.com/i/web/status/${STATUS_ID}`);
	assert.equal(canon.xStatusId, STATUS_ID);
});

test('canonicalizeUrl does not set xStatusId or youtubeVideoId on a non-status X URL', () => {
	const canon = canonicalizeUrl(`https://x.com/${HANDLE}`);
	assert.ok(canon);
	assert.equal(canon.xStatusId, undefined);
	assert.equal(canon.youtubeVideoId, undefined);
});

// ── regression: YT + arXiv behavior is unchanged ────────────────────────────

test('regression: a youtu.be short link still canonicalizes to a youtube.com watch URL with youtubeVideoId, and xStatusId is unset', () => {
	const canon = canonicalizeUrl('https://youtu.be/dQw4w9WgXcQ');
	assert.ok(canon);
	assert.equal(canon.canonical, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
	assert.equal(canon.youtubeVideoId, 'dQw4w9WgXcQ');
	assert.equal(canon.xStatusId, undefined);
});

test('regression: an arxiv abs URL is unaffected by the X branch', () => {
	const canon = canonicalizeUrl('https://arxiv.org/abs/2301.12345');
	assert.ok(canon);
	assert.equal(canon.canonical, 'https://arxiv.org/abs/2301.12345');
	assert.equal(canon.xStatusId, undefined);
	assert.equal(canon.youtubeVideoId, undefined);
});
