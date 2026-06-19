import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Bundle blogs.ts with an obsidian stub (DOM-dependent parsers need a browser DOMParser and are
// covered by the in-app end-to-end check; here we exercise the pure enrichment helpers).
const outdir = path.join(tmpdir(), `crucible-blogs-enrich-${process.pid}`);
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
				contents: [
					'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
					'export function normalizePath(p) { return p.replace(/\\\\/g, "/").replace(/\\/+/g, "/"); }',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	normalizeBodyMode,
	parseBlogsTable,
	buildBlogBulletSuffix,
	parseBlogBulletMeta,
	countWords,
} = await import(pathToFileURL(outfile));

const BULLET_RE = /^- \*\*(.*)\*\* — published ([^—]+) — (https?:\/\/\S+)/;

test('normalizeBodyMode accepts full/snippet/auto and defaults unknown to auto', () => {
	assert.equal(normalizeBodyMode('full'), 'full');
	assert.equal(normalizeBodyMode('  SNIPPET '), 'snippet');
	assert.equal(normalizeBodyMode('auto'), 'auto');
	assert.equal(normalizeBodyMode(''), 'auto');
	assert.equal(normalizeBodyMode('nonsense'), 'auto');
	assert.equal(normalizeBodyMode(undefined), 'auto');
});

test('parseBlogsTable reads the optional Body column and defaults to auto', () => {
	const table = [
		'| Name | Link | Method | Tags | Priority | Canon | Body |',
		'|------|------|--------|------|----------|-------|------|',
		'| Full | https://a.com/feed | RSS | | normal | auto | full |',
		'| Snip | https://b.com/feed | RSS | | normal | auto | snippet |',
		'| Bad  | https://c.com/feed | RSS | | normal | auto | bogus |',
	].join('\n');
	const { entries } = parseBlogsTable(table);
	assert.equal(entries.length, 3);
	assert.equal(entries[0].body, 'full');
	assert.equal(entries[1].body, 'snippet');
	assert.equal(entries[2].body, 'auto'); // unknown value falls back to auto
});

test('existing tables without a Body column default body to auto', () => {
	const table = [
		'| Name | Link | Method | Tags | Priority | Canon |',
		'|------|------|--------|------|----------|-------|',
		'| Emil | https://emil.com/feed | RSS | | normal | substack |',
	].join('\n');
	const { entries } = parseBlogsTable(table);
	assert.equal(entries[0].body, 'auto');
});

test('bullet suffix round-trips authors (with commas/spaces), categories, words, kind, hasBody', () => {
	const post = {
		authors: ['Smith, John', 'Jane Doe'],
		categories: ['LLMs', 'tools & toys'],
		wordCount: 1715,
		kind: 'article',
		hasBody: true,
	};
	const meta = parseBlogBulletMeta(buildBlogBulletSuffix(post));
	assert.deepEqual(meta.authors, ['Smith, John', 'Jane Doe']);
	assert.deepEqual(meta.categories, ['LLMs', 'tools & toys']);
	assert.equal(meta.wordCount, 1715);
	assert.equal(meta.kind, 'article');
	assert.equal(meta.hasBody, true);
});

test('podcast / no-body / no-author bullet round-trips', () => {
	const post = { authors: [], categories: [], wordCount: null, kind: 'podcast', hasBody: false };
	const meta = parseBlogBulletMeta(buildBlogBulletSuffix(post));
	assert.deepEqual(meta.authors, []);
	assert.deepEqual(meta.categories, []);
	assert.equal(meta.wordCount, null);
	assert.equal(meta.kind, 'podcast');
	assert.equal(meta.hasBody, false);
});

test('the suffix does not break the existing bullet URL parse', () => {
	const suffix = buildBlogBulletSuffix({ authors: ['A'], categories: [], wordCount: 10, kind: 'article', hasBody: true });
	const line = `- **A title** — published 2024-01-01 — https://example.com/p/post${suffix}`;
	const m = line.match(BULLET_RE);
	assert.ok(m);
	assert.equal(m[3], 'https://example.com/p/post'); // \S+ stops at the space before the comment
});

test('parseBlogBulletMeta returns null for a legacy bullet without the comment', () => {
	const line = '- **Old post** — published 2023-01-01 — https://example.com/old';
	assert.equal(parseBlogBulletMeta(line), null);
});

test('countWords strips tags/entities and counts tokens', () => {
	assert.equal(countWords('<p>Hello <b>world</b> &amp; friends</p>'), 3);
	assert.equal(countWords('<p></p>'), 0);
});
