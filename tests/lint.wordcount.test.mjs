import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-wordcount-tests');
const outfile = path.join(outdir, 'lint.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/lint.ts'],
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
					'export class Editor {}',
					'export class MarkdownView {}',
					'export class Modal {}',
					'export class Notice { constructor() {} hide() {} setMessage() {} }',
					'export class Plugin {}',
					'export class TFile {}',
					'export class TFolder {}',
					'export class TAbstractFile {}',
					'export const Platform = { isDesktopApp: true, isMobileApp: false };',
					'export function normalizePath(path) { return String(path).replace(/\\/+/g, "/"); }',
					'export function parseYaml() { return {}; }',
					'export function debounce(fn) { return fn; }',
					'export function getAllTags() { return []; }',
					'export const moment = Object.assign(() => ({ format: () => "" }), { format: () => "" });',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	stripNonProseContent,
	calculateWordCount,
	setFrontmatterWordCount,
} = await import(pathToFileURL(outfile));

test('inline <svg> chart contributes no words', () => {
	const svg = '<svg version="1.1" width="620" height="500"><path d="M 0 98.75 L 2.15 92.38 L 4.3 92.80 L 6.45 105.86"></path><text>Index performance</text></svg>';
	assert.equal(calculateWordCount(`Before chart.\n\n${svg}\n\nAfter chart.`), 4);
	assert.equal(stripNonProseContent(svg).trim(), '');
});

test('the Carnage example body counts far below the inflated 7375', () => {
	const svgPath = 'M 0 98.75 ' + Array.from({ length: 200 }, (_, i) => `L ${i * 2.15} ${90 + i}`).join(' ');
	const body = [
		'Fears of rising interest rates collided with worries about AI spending on Wall Street.',
		'',
		`<svg width="620" height="500"><path d="${svgPath}"></path><path d="${svgPath}"></path></svg>`,
		'',
		'Stocks, bonds, oil, gold and bitcoin all tumbled.',
	].join('\n');
	const count = calculateWordCount(body);
	assert.ok(count < 50, `expected prose-only count, got ${count}`);
});

test('fenced and inline code are excluded', () => {
	const body = [
		'Here is some prose.',
		'',
		'```js',
		'const x = computeSomething(alpha, beta, gamma);',
		'```',
		'',
		'Trailing `inlineCodeToken` prose.',
	].join('\n');
	// "Here is some prose." (4) + "Trailing prose." (2) = 6
	assert.equal(calculateWordCount(body), 6);
});

test('image embeds drop, links reduce to visible text', () => {
	assert.equal(calculateWordCount('![](photos/img.png)'), 0);
	assert.equal(calculateWordCount('![[some/embed.png]]'), 0);
	assert.equal(calculateWordCount('See [the report](https://example.com/very/long/url) now.'), 4);
	assert.equal(calculateWordCount('Read [[Some Page|the alias]] today.'), 4);
	assert.equal(calculateWordCount('Read [[PlainTarget]] today.'), 3);
});

test('plain prose counts correctly (regression guard)', () => {
	assert.equal(calculateWordCount('The quick brown fox jumps over the lazy dog.'), 9);
});

test('setFrontmatterWordCount fills an empty clipper-seeded word-count', () => {
	const before = ['---', 'title: THE SWELL', 'word-count:', 'tags:', '  - news', '---', '', 'Body prose here.'].join('\n');
	const after = setFrontmatterWordCount(before, 380);
	assert.match(after, /\nword-count: 380\n/);
	// Only the value line changed; everything else is preserved verbatim.
	assert.equal(after, before.replace('word-count:', 'word-count: 380'));
});

test('setFrontmatterWordCount overwrites an existing numeric value', () => {
	const before = ['---', 'word-count: 12', 'title: X', '---', '', 'Body.'].join('\n');
	assert.match(setFrontmatterWordCount(before, 500), /\nword-count: 500\n/);
	assert.doesNotMatch(setFrontmatterWordCount(before, 500), /word-count: 12/);
});

test('setFrontmatterWordCount preserves indentation of the key', () => {
	const before = ['---', '  word-count: 1', '---', '', 'Body.'].join('\n');
	assert.match(setFrontmatterWordCount(before, 7), /\n {2}word-count: 7\n/);
});

test('setFrontmatterWordCount appends the key when absent from an existing block', () => {
	const before = ['---', 'title: X', '---', '', 'Body.'].join('\n');
	const after = setFrontmatterWordCount(before, 42);
	assert.match(after, /word-count: 42/);
	assert.match(after, /title: X/);
});

test('setFrontmatterWordCount is a no-op when there is no frontmatter block', () => {
	const before = 'Just a body, no frontmatter.';
	assert.equal(setFrontmatterWordCount(before, 99), before);
});

test('setFrontmatterWordCount leaves the body untouched', () => {
	const before = ['---', 'word-count:', '---', '', 'Line one.', 'word-count: not-this', 'Line three.'].join('\n');
	const after = setFrontmatterWordCount(before, 3);
	// The body line mentioning word-count must be preserved; only the frontmatter changes.
	assert.match(after, /\nword-count: not-this\n/);
	assert.match(after, /^---\nword-count: 3\n---/);
});

test('frontmatter is excluded', () => {
	const body = [
		'---',
		'title: Some Title',
		'word-count: 999',
		'tags:',
		'  - clippings',
		'---',
		'',
		'Just three words.',
	].join('\n');
	assert.equal(calculateWordCount(body), 3);
});
