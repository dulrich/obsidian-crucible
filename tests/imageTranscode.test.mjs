import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// ── Bundle src/search/imageTranscode.ts standalone ──────────────────────────────
//
// No obsidian stub needed (the module imports nothing from 'obsidian' by design). Only the pure,
// DOM-free exports (`needsVisionTranscode`, `extractSvgText`) are exercised here — `transcodeToPng`
// needs `createImageBitmap`/`OffscreenCanvas`, which only exist in Obsidian's Electron renderer,
// and is deliberately left untested under plain `node --test` per the brief.
const outdir = path.join(tmpdir(), 'obsidian-crucible-image-transcode-tests');
const outfile = path.join(outdir, 'imageTranscode.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/imageTranscode.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const { needsVisionTranscode, extractSvgText } = await import(pathToFileURL(outfile).href);

test('needsVisionTranscode: webp/avif need transcoding, other formats do not; case-insensitive; leading-dot tolerant', () => {
	assert.equal(needsVisionTranscode('webp'), true);
	assert.equal(needsVisionTranscode('WEBP'), true);
	assert.equal(needsVisionTranscode('.webp'), true);
	assert.equal(needsVisionTranscode('avif'), true);
	assert.equal(needsVisionTranscode('AVIF'), true);
	assert.equal(needsVisionTranscode('.AVIF'), true);
	assert.equal(needsVisionTranscode('png'), false);
	assert.equal(needsVisionTranscode('jpg'), false);
	assert.equal(needsVisionTranscode('jpeg'), false);
	assert.equal(needsVisionTranscode('gif'), false);
	assert.equal(needsVisionTranscode('svg'), false);
	assert.equal(needsVisionTranscode(''), false);
});

test('extractSvgText: title/desc/text (including nested tspan) concatenated in document order, whitespace-collapsed', () => {
	const svg = `
		<svg xmlns="http://www.w3.org/2000/svg">
			<title>Quarterly  Revenue</title>
			<desc>A bar chart of revenue by quarter.</desc>
			<g>
				<text x="0" y="0">Series A: <tspan>42</tspan> units</text>
			</g>
		</svg>
	`;
	assert.equal(
		extractSvgText(svg),
		'Quarterly Revenue\nA bar chart of revenue by quarter.\nSeries A: 42 units',
	);
});

test('extractSvgText: empty svg, or one with no title/desc/text, returns \'\'', () => {
	assert.equal(extractSvgText('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), '');
	assert.equal(extractSvgText(''), '');
	assert.equal(extractSvgText('<svg><rect width="10" height="10" /></svg>'), '');
});

test('extractSvgText: decodes common XML entities and drops matched elements that collapse to nothing', () => {
	assert.equal(
		extractSvgText('<svg><title>A &amp; B &lt;test&gt;</title><desc>   </desc></svg>'),
		'A & B <test>',
	);
});
