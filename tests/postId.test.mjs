import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-postid-tests');
const outfile = path.join(outdir, 'blogs.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/orchestration/utils/blogs.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: 'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	postIdFromUrl,
	buildBlogCanonHostMap,
	parseBlogsTable,
	normalizeCanonMethod,
} = await import(pathToFileURL(outfile));

const SUBSTACK_EMAIL =
	'https://www.emilkirkegaard.com/p/top-universities-and-national-intelligence?publication_id=521681&post_id=200711891&isFreemail=false&r=52ktrf&triedRedirect=true&utm_source=substack&utm_medium=email';
const SUBSTACK_SLUG = 'https://www.emilkirkegaard.com/p/top-universities-and-national-intelligence';

test('substack email link canonicalizes to the bare RSS slug', () => {
	assert.equal(postIdFromUrl(SUBSTACK_EMAIL), SUBSTACK_SLUG);
});

test('substack RSS bare slug is unchanged and equals the email link (dedup invariant)', () => {
	assert.equal(postIdFromUrl(SUBSTACK_SLUG), SUBSTACK_SLUG);
	assert.equal(postIdFromUrl(SUBSTACK_EMAIL), postIdFromUrl(SUBSTACK_SLUG));
});

test('non-substack /p/ slug without substack signature is not stripped', () => {
	// No substack signature param -> auto rule does not match -> only denylist params stripped.
	const url = 'https://example.com/p/some-slug?article_id=123';
	assert.equal(postIdFromUrl(url), 'https://example.com/p/some-slug?article_id=123');
});

test('a real identifier param (article_id) is preserved on unknown hosts', () => {
	const url = 'https://news.example.org/read?article_id=998877';
	assert.equal(postIdFromUrl(url), url);
});

test('generic tracking params are still stripped on unknown hosts', () => {
	const url = 'https://blog.example.org/post-title?utm_source=x&utm_medium=email&fbclid=abc';
	assert.equal(postIdFromUrl(url), 'https://blog.example.org/post-title');
});

test('hash fragments and trailing slashes are dropped', () => {
	assert.equal(postIdFromUrl('https://blog.example.org/post/#section'), 'https://blog.example.org/post');
});

test('keep-params override preserves all query params', () => {
	const url = 'https://example.com/read?article_id=1&utm_source=x';
	assert.equal(postIdFromUrl(url, { method: 'keep-params' }), url);
});

test('strip-params override drops every query param', () => {
	const url = 'https://example.com/read?article_id=1&utm_source=x';
	assert.equal(postIdFromUrl(url, { method: 'strip-params' }), 'https://example.com/read');
});

test('substack override reduces /p/<slug> even without a signature param', () => {
	const url = 'https://example.com/p/my-slug?whatever=1';
	assert.equal(postIdFromUrl(url, { method: 'substack' }), 'https://example.com/p/my-slug');
});

test('hostRules apply an override by hostname', () => {
	const hostRules = new Map([['example.com', 'strip-params']]);
	assert.equal(
		postIdFromUrl('https://example.com/read?article_id=1', { hostRules }),
		'https://example.com/read',
	);
	// A different host is unaffected by the map.
	assert.equal(
		postIdFromUrl('https://other.com/read?article_id=1', { hostRules }),
		'https://other.com/read?article_id=1',
	);
});

test('explicit method wins over hostRules', () => {
	const hostRules = new Map([['example.com', 'strip-params']]);
	const url = 'https://example.com/read?article_id=1';
	assert.equal(postIdFromUrl(url, { method: 'keep-params', hostRules }), url);
});

test('normalizeCanonMethod accepts the four methods and defaults unknown to auto', () => {
	assert.equal(normalizeCanonMethod('substack'), 'substack');
	assert.equal(normalizeCanonMethod('  STRIP-PARAMS '), 'strip-params');
	assert.equal(normalizeCanonMethod('keep-params'), 'keep-params');
	assert.equal(normalizeCanonMethod(''), 'auto');
	assert.equal(normalizeCanonMethod('nonsense'), 'auto');
	assert.equal(normalizeCanonMethod(undefined), 'auto');
});

test('parseBlogsTable reads the Canon column', () => {
	const table = [
		'| Name | Link | Method | Tags | Priority | Canon |',
		'|------|------|--------|------|----------|-------|',
		'| Emil | https://www.emilkirkegaard.com/feed | RSS | research | normal | substack |',
		'| Other | https://other.com/rss | RSS | | low | bogus |',
	].join('\n');
	const { entries } = parseBlogsTable(table);
	assert.equal(entries.length, 2);
	assert.equal(entries[0].canon, 'substack');
	assert.equal(entries[1].canon, 'auto'); // unknown value falls back to auto
});

test('existing 5-column tables still parse with canon defaulting to auto', () => {
	const table = [
		'| Name | Link | Method | Tags | Priority |',
		'|------|------|--------|------|----------|',
		'| Emil | https://www.emilkirkegaard.com/feed | RSS | research | normal |',
	].join('\n');
	const { entries } = parseBlogsTable(table);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].canon, 'auto');
});

test('buildBlogCanonHostMap maps feed hostnames to non-auto overrides only', () => {
	const entries = [
		{ name: 'Emil', link: 'https://www.emilkirkegaard.com/feed', method: 'rss', tags: [], priority: 'normal', canon: 'substack' },
		{ name: 'Auto', link: 'https://auto.example.com/feed', method: 'rss', tags: [], priority: 'normal', canon: 'auto' },
	];
	const map = buildBlogCanonHostMap(entries);
	assert.equal(map.get('www.emilkirkegaard.com'), 'substack');
	assert.equal(map.has('auto.example.com'), false);
});
