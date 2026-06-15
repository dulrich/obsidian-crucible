import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-chunker-tests');
const outfile = path.join(outdir, 'chunker.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/chunker.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const { buildSearchChunks, hashSearchContent, isSearchIndexablePath, parseSearchDocument } = await import(pathToFileURL(outfile));

test('search index accepts markdown, qmd, and text files only', () => {
	assert.equal(isSearchIndexablePath('daily/note.md'), true);
	assert.equal(isSearchIndexablePath('research/report.qmd'), true);
	assert.equal(isSearchIndexablePath('inbox/raw.txt'), true);
	assert.equal(isSearchIndexablePath('assets/image.png'), false);
});

test('frontmatter metadata and heading fallback are parsed for chunks', () => {
	const parsed = parseSearchDocument([
		'---',
		'title: Cedar Policy Harness',
		'source: https://example.com/source',
		'tags:',
		'  - search',
		'  - agents',
		'---',
		'# Ignored fallback',
		'Body text',
	].join('\n'), 'fallback');

	assert.equal(parsed.metadata.title, 'Cedar Policy Harness');
	assert.equal(parsed.metadata.source, 'https://example.com/source');
	assert.deepEqual(parsed.metadata.tags, ['search', 'agents']);
});

test('chunks are stable and retain section headings', () => {
	const input = {
		vaultId: 'test',
		path: 'daily/example.md',
		basename: 'example',
		extension: 'md',
		mtime: 1,
		maxChars: 80,
		overlapChars: 10,
		content: [
			'---',
			'title: Example',
			'---',
			'# First',
			'Alpha '.repeat(20),
			'',
			'## Second',
			'Beta '.repeat(20),
		].join('\n'),
	};

	const first = buildSearchChunks(input);
	const second = buildSearchChunks(input);
	assert.ok(first.length > 1);
	assert.deepEqual(first.map(c => c.id), second.map(c => c.id));
	assert.ok(first.some(c => c.heading === 'First'));
	assert.ok(first.some(c => c.heading === 'Second'));
	assert.equal(first[0].vaultId, 'test');
	assert.equal(first[0].path, 'daily/example.md');
	assert.equal(first[0].contentHash, hashSearchContent(input.content));
	assert.notEqual(first[0].contentHash, hashSearchContent(`${input.content}\nChanged`));
});
