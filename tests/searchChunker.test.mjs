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

const {
	buildSearchChunks,
	hashSearchContent,
	isImageChunkHeading,
	IMAGE_CHUNK_HEADING_PREFIX,
	isSearchIndexablePath,
	parseSearchDocument,
} = await import(pathToFileURL(outfile));

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

// ── Image description chunks (WP-2) ──────────────────────────────────────────────────────
//
// The chunker's half of `docs/multimodal-image-search.md` Decision 2: a described image reaches
// the index as ordinary chunks on the *note* that embeds it, distinguished only by an
// `Image: ` heading prefix. Resolution (embeds -> `_MD5` -> store records) happens in
// SearchManager; this module receives plain data and must stay importable standalone, which is
// exactly what this file's bundle-with-no-stubs harness above asserts by existing.

const PROSE = ['---', 'title: Quarterly Report', 'author: Ada Lovelace', '---', '# Findings', 'Revenue rose.'].join('\n');

function chunkInput(overrides = {}) {
	return {
		vaultId: 'test-vault',
		path: 'notes/report.md',
		basename: 'report',
		extension: 'md',
		mtime: 7,
		content: PROSE,
		maxChars: 400,
		overlapChars: 0,
		...overrides,
	};
}

test('a note with no described images is byte-identical to the pre-WP-2 chunker', () => {
	// Golden values captured by bundling the base commit's chunker (pre-image-facet) and running
	// it over `PROSE`. This is the assertion that keeps landing the image facet from re-indexing
	// every note in every vault that has no described images at all — unlike the entity facet,
	// whose one-time vault-wide re-upsert *was* the population mechanism, this facet must be
	// invisible to notes it does not apply to.
	assert.equal(hashSearchContent(PROSE), 'f84cbaae');
	const chunks = buildSearchChunks(chunkInput());
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0].id, 'notes/report.md#0:347085ed');
	assert.equal(chunks[0].contentHash, 'f84cbaae');
	assert.equal(chunks[0].ordinal, 0);
	assert.equal(chunks[0].heading, 'Findings');

	// The three ways a caller can say "no image facet" must all be that same value.
	assert.equal(hashSearchContent(PROSE, undefined), 'f84cbaae');
	assert.equal(hashSearchContent(PROSE, []), 'f84cbaae');
	assert.equal(hashSearchContent(PROSE, ['', '   ']), 'f84cbaae');
	assert.deepEqual(buildSearchChunks(chunkInput({ imageDescriptions: [] })), chunks);
});

test('a described image appends two chunks after the prose, through the same ordinal counter', () => {
	const chunks = buildSearchChunks(chunkInput({
		imageDescriptions: [{
			filename: 'a1b2c3d4e5f60718293a4b5c6d7e8f90_MD5.png',
			narrative: 'A line chart of quarterly revenue climbing through Q4.',
			extraction: 'Title: Quarterly revenue\nQ1 1.2M\nQ2 1.4M\nQ3 1.9M\nQ4 2.6M',
		}],
	}));

	assert.equal(chunks.length, 3);
	// Prose first, images after: adding a description must never renumber a prose chunk, or the
	// companion's full-replace upsert would orphan rows it no longer regenerates.
	assert.deepEqual(chunks.map(c => c.ordinal), [0, 1, 2]);
	assert.equal(chunks[0].heading, 'Findings');
	assert.equal(chunks[1].heading, 'Image: a1b2c3d4e5f60718293a4b5c6d7e8f90_MD5.png');
	assert.equal(chunks[2].heading, 'Image: a1b2c3d4e5f60718293a4b5c6d7e8f90_MD5.png (text)');
	assert.match(chunks[1].text, /line chart of quarterly revenue/);
	assert.match(chunks[2].text, /Q4 2\.6M/);

	// A hit is the note that embeds the figure, never the image file — that is the whole reason
	// descriptions fold into the owning note's chunks rather than being indexed as documents.
	for (const chunk of chunks) {
		assert.equal(chunk.path, 'notes/report.md');
		assert.equal(chunk.title, 'Quarterly Report');
		assert.equal(chunk.vaultId, 'test-vault');
	}
	// The prose chunk's id is untouched by the image chunks appended after it.
	assert.equal(chunks[0].id, 'notes/report.md#0:347085ed');
	assert.equal(new Set(chunks.map(c => c.id)).size, 3);
});

test('image chunk ids are deterministic across calls', () => {
	const input = chunkInput({
		imageDescriptions: [
			{ filename: 'one_MD5.png', narrative: 'First figure.', extraction: 'A 1' },
			{ filename: 'two_MD5.png', narrative: 'Second figure.', extraction: 'B 2' },
		],
	});
	const first = buildSearchChunks(input);
	const second = buildSearchChunks(input);
	assert.equal(first.length, 5);
	assert.deepEqual(first.map(c => c.id), second.map(c => c.id));
	assert.deepEqual(first.map(c => c.heading), second.map(c => c.heading));
});

test('an SVG-derived record with no narrative emits one chunk, not an empty one', () => {
	// extractSvgText (WP-1) puts its text in `extraction` and leaves `narrative` empty, so a
	// one-chunk image is the normal case for SVGs — an empty chunk would cost an index row and,
	// with semantic search on, a vector, for nothing.
	const chunks = buildSearchChunks(chunkInput({
		imageDescriptions: [{ filename: 'diagram_MD5.svg', narrative: '', extraction: 'Pipeline\nintake -> enrich -> index' }],
	}));
	assert.equal(chunks.length, 2);
	assert.equal(chunks[1].heading, 'Image: diagram_MD5.svg (text)');
	assert.deepEqual(chunks.map(c => c.ordinal), [0, 1]);

	// Both halves blank (and a blank filename) contribute nothing at all.
	assert.equal(buildSearchChunks(chunkInput({
		imageDescriptions: [
			{ filename: 'blank_MD5.png', narrative: '   ', extraction: '' },
			{ filename: '  ', narrative: 'orphaned', extraction: 'orphaned' },
		],
	})).length, 1);
});

test('a long extraction is packed by the same maxChars rule as prose, sharing one heading', () => {
	const row = 'Region North | Units 1284 | Revenue 91234 | Margin 0.42\n\n';
	const chunks = buildSearchChunks(chunkInput({
		maxChars: 400,
		imageDescriptions: [{ filename: 'table_MD5.webp', narrative: 'A wide sales table.', extraction: row.repeat(40) }],
	}));

	const packed = chunks.filter(c => c.heading === 'Image: table_MD5.webp (text)');
	assert.ok(packed.length > 3, `expected the extraction to pack into several chunks, got ${packed.length}`);
	for (const chunk of packed) assert.ok(chunk.text.length <= 400, `oversized chunk: ${chunk.text.length}`);
	// Same heading, different ordinals — stableChunkId folds the ordinal, so the ids stay distinct.
	assert.equal(new Set(packed.map(c => c.id)).size, packed.length);
	assert.deepEqual(chunks.map(c => c.ordinal), chunks.map((_, i) => i));
});

test('the extra-facet fold changes the hash, is order-independent, and is deduplicated', () => {
	const withFacet = hashSearchContent(PROSE, ['image-desc:deadbeef']);
	assert.notEqual(withFacet, hashSearchContent(PROSE));
	assert.notEqual(withFacet, hashSearchContent(PROSE, ['image-desc:cafebabe']));
	// A property of the *set*, not of the caller's argument order — two call sites building the
	// same facets in different orders must agree or the note re-indexes on every sweep forever.
	assert.equal(
		hashSearchContent(PROSE, ['image-desc:deadbeef', 'other:1']),
		hashSearchContent(PROSE, ['other:1', 'image-desc:deadbeef', 'other:1']),
	);
});

test('the chunker fallback recompute folds the same facets the caller does', () => {
	// SearchManager threads `contentHash` in, so the `:72` fallback normally never runs. It has to
	// agree anyway: a fallback that folded nothing would mint chunks stamped with a hash that the
	// skip comparison could never match.
	const facets = ['image-desc:deadbeef'];
	const fallback = buildSearchChunks(chunkInput({ extraHashFacets: facets }));
	assert.equal(fallback[0].contentHash, hashSearchContent(PROSE, facets));
	assert.notEqual(fallback[0].contentHash, hashSearchContent(PROSE));
});

test('the figure indicator reads the heading prefix, which is the whole UI contract', () => {
	assert.equal(IMAGE_CHUNK_HEADING_PREFIX, 'Image: ');
	assert.equal(isImageChunkHeading('Image: chart_MD5.png'), true);
	assert.equal(isImageChunkHeading('Image: chart_MD5.png (text)'), true);
	assert.equal(isImageChunkHeading('Findings'), false);
	assert.equal(isImageChunkHeading('An Image: of something'), false);
	assert.equal(isImageChunkHeading(''), false);
	assert.equal(isImageChunkHeading(undefined), false);
});
