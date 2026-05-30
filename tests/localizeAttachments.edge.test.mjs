import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-localize-tests');
const outfile = path.join(outdir, 'localizeAttachments.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/localizeAttachments.ts'],
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
					'export class Notice { constructor() {} hide() {} setMessage() {} }',
					'export class TFile {}',
					'export class TFolder {}',
					'export const Platform = { isDesktopApp: true, isMobileApp: false };',
					'export function normalizePath(path) { return String(path).replace(/\\/+/g, "/"); }',
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
	clampImageQuality,
	md5HexForBytes,
	rewriteLocalizedAttachmentRefs,
	stripDataUriImagePlaceholders,
} = await import(pathToFileURL(outfile));

test('rewriteLocalizedAttachmentRefs only replaces full markdown image ranges', () => {
	const content = [
		'Numeric alt stays intact: ![2024-01-15](photos/2024-01-15.png)',
		'Numeric filename localizes: ![1](photos/1.png)',
		'Plain numeric filename text stays intact: photos/1.png',
	].join('\n');

	const updated = rewriteLocalizedAttachmentRefs(content, [
		{ from: '![1](photos/1.png)', to: '![](Notes/_attachments/post/abc123_MD5.png)' },
		{ from: 'photos/1.png', to: 'BROKEN' },
	]);

	assert.equal(updated, [
		'Numeric alt stays intact: ![2024-01-15](photos/2024-01-15.png)',
		'Numeric filename localizes: ![](Notes/_attachments/post/abc123_MD5.png)',
		'Plain numeric filename text stays intact: photos/1.png',
	].join('\n'));
});

test('rewriteLocalizedAttachmentRefs keeps numeric-heavy sibling filenames separate', () => {
	const content = [
		'![shot 1](assets/2024-01-15-1.png)',
		'![shot 10](assets/2024-01-15-10.png)',
	].join('\n');

	const updated = rewriteLocalizedAttachmentRefs(content, [
		{ from: '![shot 1](assets/2024-01-15-1.png)', to: '![](assets/hash1_MD5.png)' },
	]);

	assert.equal(updated, [
		'![](assets/hash1_MD5.png)',
		'![shot 10](assets/2024-01-15-10.png)',
	].join('\n'));
});

test('stripDataUriImagePlaceholders removes only image data placeholders', () => {
	const result = stripDataUriImagePlaceholders('A ![](data:image/gif;base64,R0lGODlhAQABAAAAACw=) ![](real.png)');
	assert.equal(result.count, 1);
	assert.equal(result.content, 'A ![](real.png)');
});

test('clampImageQuality handles NaN, undefined, and bounds', () => {
	assert.equal(clampImageQuality(Number.NaN), 0.85);
	assert.equal(clampImageQuality(undefined), 0.85);
	assert.equal(clampImageQuality(10), 0.3);
	assert.equal(clampImageQuality(120), 1);
	assert.equal(clampImageQuality(72), 0.72);
});

test('md5HexForBytes handles empty and numeric bytes deterministically', () => {
	assert.equal(md5HexForBytes(new Uint8Array()), 'd41d8cd98f00b204e9800998ecf8427e');
	assert.equal(md5HexForBytes(new Uint8Array([1, 2, 3, 4, 5])), '7cfdd07889b3295d6a550914ab35e068');
});
