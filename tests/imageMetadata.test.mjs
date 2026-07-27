import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-image-metadata-tests');
const outfile = path.join(outdir, 'imageMetadata.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/orchestration/utils/imageMetadata.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: `
					export function normalizePath(path) {
						return String(path).replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\//, '').replace(/\\/$/, '');
					}
				`,
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { extractMetadataSections, imageMimeType, localizedImageInfo } = await import(pathToFileURL(outfile));

test('localizedImageInfo derives MD5 sidecar path', () => {
	const info = localizedImageInfo('notes/_attachments/a/0123456789abcdef0123456789abcdef_MD5.webp');

	assert.equal(info?.md5, '0123456789abcdef0123456789abcdef');
	assert.equal(info?.ext, 'webp');
	assert.equal(info?.sidecarPath, 'notes/_attachments/a/0123456789abcdef0123456789abcdef_MD5.md');
	assert.equal(localizedImageInfo('notes/_attachments/a/image.webp'), null);
});

test('localizedImageInfo is case-insensitive on the MD5/extension and lowercases the returned md5', () => {
	const info = localizedImageInfo('a/ABCDEF0123456789ABCDEF0123456789_MD5.PNG');
	assert.equal(info?.md5, 'abcdef0123456789abcdef0123456789');
	assert.equal(info?.ext, 'png');
});

test('imageMimeType maps known localize extensions and falls back to image/<ext>', () => {
	assert.equal(imageMimeType('png'), 'image/png');
	assert.equal(imageMimeType('JPG'), 'image/jpeg');
	assert.equal(imageMimeType('svg'), 'image/svg+xml');
	assert.equal(imageMimeType('webp'), 'image/webp');
	assert.equal(imageMimeType('tiff'), 'image/tiff');
});

test('extractMetadataSections pulls the Description and Extracted text bodies out of a legacy sidecar note', () => {
	const content = [
		'---',
		'image-metadata-schema: 1',
		'---',
		'',
		'# Description',
		'',
		'A chart with visible labels.',
		'',
		'# Extracted text',
		'',
		'Revenue: 2026',
		'',
	].join('\n');

	const sections = extractMetadataSections(content);
	assert.equal(sections.description, 'A chart with visible labels.');
	assert.equal(sections.extractedText, 'Revenue: 2026');
});

test('extractMetadataSections returns empty strings when a section is missing', () => {
	const sections = extractMetadataSections('# Description\n\nOnly this section.\n');
	assert.equal(sections.description, 'Only this section.');
	assert.equal(sections.extractedText, '');
});
