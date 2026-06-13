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
	repointAttachmentFolderPrefix,
	planLocalAttachmentRepair,
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

test('repointAttachmentFolderPrefix rewrites moved embed prefixes (md + wiki, encoded + raw)', () => {
	const oldFolder = '_resources/Clippings/elon-musk';
	const newFolder = '_resources/daily/day/2026-06-13/elon-musk';
	const content = [
		'![](_resources/Clippings/elon-musk/3ff_MD5.webp)',
		'![[_resources/Clippings/elon-musk/abc_MD5.png]]',
		'Prose mentioning _resources/Clippings/elon-musk/ stays untouched.',
	].join('\n');

	const updated = repointAttachmentFolderPrefix(content, oldFolder, newFolder);

	assert.equal(updated, [
		'![](_resources/daily/day/2026-06-13/elon-musk/3ff_MD5.webp)',
		'![[_resources/daily/day/2026-06-13/elon-musk/abc_MD5.png]]',
		'Prose mentioning _resources/Clippings/elon-musk/ stays untouched.',
	].join('\n'));
});

test('repointAttachmentFolderPrefix handles %20-encoded markdown prefixes and is idempotent', () => {
	const oldFolder = '_resources/My Clips/post';
	const newFolder = '_resources/daily/post';
	const md = '![](_resources/My%20Clips/post/x_MD5.webp)';
	const once = repointAttachmentFolderPrefix(md, oldFolder, newFolder);
	assert.equal(once, '![](_resources/daily/post/x_MD5.webp)');
	// Already-updated content has no old prefix left -> no-op.
	assert.equal(repointAttachmentFolderPrefix(once, oldFolder, newFolder), once);
	// No-op when folders are equal.
	assert.equal(repointAttachmentFolderPrefix(md, oldFolder, oldFolder), md);
});

test('planLocalAttachmentRepair prefers the expected folder, then a unique name match', () => {
	const expected = '_resources/daily/day/2026-06-13/elon-musk';
	const vaultPaths = [
		'_resources/daily/day/2026-06-13/elon-musk/3ff_MD5.webp',
		'_resources/other/elsewhere/3ff_MD5.webp',
	];
	// Expected-folder candidate wins even when a same-named file exists elsewhere.
	assert.equal(
		planLocalAttachmentRepair('_resources/Clippings/elon-musk/3ff_MD5.webp', expected, vaultPaths),
		'_resources/daily/day/2026-06-13/elon-musk/3ff_MD5.webp',
	);
	// Falls back to a unique vault-wide match when not in the expected folder.
	assert.equal(
		planLocalAttachmentRepair('_resources/Clippings/x/uniq_MD5.png', expected, ['_resources/wherever/uniq_MD5.png']),
		'_resources/wherever/uniq_MD5.png',
	);
	// Ambiguous (multiple same-named, none in expected folder) -> null.
	assert.equal(
		planLocalAttachmentRepair('_resources/Clippings/x/dup_MD5.png', expected, ['a/dup_MD5.png', 'b/dup_MD5.png']),
		null,
	);
	// Missing entirely -> null.
	assert.equal(planLocalAttachmentRepair('_resources/Clippings/x/gone_MD5.png', expected, vaultPaths), null);
	// Decodes %20 before matching the basename.
	assert.equal(
		planLocalAttachmentRepair('_resources/Clippings/x/a%20b_MD5.png', expected, ['_resources/keep/a b_MD5.png']),
		'_resources/keep/a b_MD5.png',
	);
});
