// WP-PF3: linked-post search chunks. A source note's only matching text for a query about the
// *content* of a post it links (via `x-metadata`/`yt-metadata` stamps) is otherwise the
// `_x_metadata`/`_yt_metadata` note itself, which has zero relationship to the source note in any
// ranking leg beyond the client-side link-boost reorder — and that boost cannot add a candidate
// that never matched anything. This facet emits the linked note's own body as an ordinary chunk
// on the *citing* note, exactly like the image-description facet emits a described figure's text
// on the note that embeds it (`tests/searchImageDescriptions.test.mjs` is this file's sibling and
// its structure is deliberately mirrored here).
//
// Two invariants pulled in opposite directions, same as the image facet:
//
// 1. A note with no linked posts must hash and chunk exactly as it did before this facet existed
//    — the overwhelming majority of notes stamp-link nothing, and moving their hashes would
//    re-upsert (and, with semantic search on, re-embed) the whole vault to write byte-identical
//    chunks.
// 2. A note that DOES stamp-link something, or whose linked target's own text later changes, must
//    re-index — the coverage-aware skip compares `contentHash`, and a linked target's identity is
//    not otherwise reflected in the citing note's bytes.
//
// Everything runs offline against fakes — no companion, no provider, no ports, no vault.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-linked-post-tests');
const managerOutfile = path.join(outdir, 'SearchManager.mjs');
const chunkerOutfile = path.join(outdir, 'chunker.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const obsidianStub = {
	name: 'obsidian-test-stub',
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
			contents: `
				export class App {}
				export class FileSystemAdapter {}
				export class Notice { constructor() {} }
				export class TFile {}
				export class TFolder {}
				export const Platform = { isDesktopApp: true, isMobile: false };
				export function normalizePath(path) { return path; }
				export async function requestUrl() { throw new Error('requestUrl not stubbed'); }
			`,
			loader: 'js',
		}));
	},
};

await esbuild.build({
	entryPoints: ['src/search/SearchManager.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [obsidianStub],
	outfile: managerOutfile,
	logLevel: 'silent',
});

await esbuild.build({
	entryPoints: ['src/search/chunker.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile: chunkerOutfile,
	logLevel: 'silent',
});

const { SearchManager } = await import(pathToFileURL(managerOutfile));
const {
	buildSearchChunks,
	hashSearchContent,
	LINKED_POST_HEADING_PREFIX,
	MAX_LINKED_DOCUMENTS_PER_NOTE,
} = await import(pathToFileURL(chunkerOutfile));

const NOTE = 'thread/example.md';
const BARE_CONTENT = ['---', 'title: Example Thread', '---', '# Findings', 'Some prose about the thread.'].join('\n');

function settings() {
	return {
		excludedFolders: [],
		providers: [],
		searchVaultId: 'vault',
		searchServiceUrl: 'http://127.0.0.1:4801',
		searchSemanticEnabled: false,
		searchChunkMaxChars: 1800,
		searchChunkOverlapChars: 200,
		searchIndexBatchSize: 24,
		searchResultLimit: 12,
	};
}

function makeFile(filePath) {
	const name = filePath.split('/').pop();
	const extension = name.split('.').pop();
	return { path: filePath, basename: name.slice(0, -(extension.length + 1)), extension, stat: { mtime: 123 } };
}

/**
 * `notes`: Map<path, { frontmatter?: object, content: string }> — every vault file this fixture
 * knows about, source and linked targets alike.
 * `resolve`: Map<linkpath, path> — what `getFirstLinkpathDest` resolves a stripped linkpath to;
 * a linkpath absent from this map resolves to `null`, i.e. an unresolvable/dead stamp.
 */
function makeManager({ notes, resolve = new Map(), client } = {}) {
	const app = {
		metadataCache: {
			isUserIgnored: () => false,
			getFileCache: (file) => {
				const entry = notes.get(file.path);
				return entry ? { frontmatter: entry.frontmatter } : null;
			},
			getFirstLinkpathDest: (linkpath) => {
				const targetPath = resolve.get(linkpath);
				return targetPath ? makeFile(targetPath) : null;
			},
		},
		vault: {
			read: async (file) => notes.get(file.path)?.content ?? '',
			cachedRead: async (file) => notes.get(file.path)?.content ?? '',
		},
	};
	const manager = new SearchManager(app, settings(), {});
	if (client) manager.client = () => client;
	return manager;
}

function linkedHeadings(chunks) {
	return chunks.filter(c => c.heading.startsWith(LINKED_POST_HEADING_PREFIX)).map(c => c.heading);
}

// ── 1. No linked posts: byte-identical to today ───────────────────────────────────────────

test('a note with no x-metadata/yt-metadata stamps hashes and chunks exactly as it did before this facet', async () => {
	const notes = new Map([[NOTE, { frontmatter: { title: 'Example Thread' }, content: BARE_CONTENT }]]);
	const manager = makeManager({ notes });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.equal(chunks[0].contentHash, hashSearchContent(BARE_CONTENT));
	assert.equal(linkedHeadings(chunks).length, 0);
});

test('a note whose frontmatter has no readable cache at all (getFileCache misses) still chunks normally', async () => {
	// `getFileCache` returning null for a path it doesn't know about (the same "no cache yet"
	// shape a freshly-created file can report) must degrade to "no linked posts", not throw.
	const manager = makeManager({ notes: new Map([[NOTE, { frontmatter: undefined, content: BARE_CONTENT }]]) });
	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.equal(chunks[0].contentHash, hashSearchContent(BARE_CONTENT));
});

// ── 2. Resolution rules: list + legacy-scalar x-metadata, scalar yt-metadata, alias/heading forms ──

test('a list-form x-metadata stamp resolves every entry, in order', async () => {
	const content = ['---', 'title: Thread', 'x-metadata:', '  - "[[x_metadata/one]]"', '  - "[[x_metadata/two]]"', '---', 'Prose.'].join('\n');
	const notes = new Map([
		[NOTE, { frontmatter: { title: 'Thread', 'x-metadata': ['[[x_metadata/one]]', '[[x_metadata/two]]'] }, content }],
		['x_metadata/one.md', { frontmatter: {}, content: 'First linked post body.' }],
		['x_metadata/two.md', { frontmatter: {}, content: 'Second linked post body.' }],
	]);
	const resolve = new Map([['x_metadata/one', 'x_metadata/one.md'], ['x_metadata/two', 'x_metadata/two.md']]);
	const manager = makeManager({ notes, resolve });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.deepEqual(linkedHeadings(chunks), [
		`${LINKED_POST_HEADING_PREFIX}one`,
		`${LINKED_POST_HEADING_PREFIX}two`,
	]);
	// Every linked-post chunk carries the CITING note's identity, not the linked note's — a hit is
	// the thread a user can open, never the metadata note.
	for (const chunk of chunks) assert.equal(chunk.path, NOTE);
});

test('a legacy scalar x-metadata value (not yet a list) still resolves', async () => {
	const notes = new Map([
		[NOTE, { frontmatter: { 'x-metadata': '[[x_metadata/one]]' }, content: BARE_CONTENT }],
		['x_metadata/one.md', { frontmatter: {}, content: 'Legacy scalar linked post body.' }],
	]);
	const resolve = new Map([['x_metadata/one', 'x_metadata/one.md']]);
	const manager = makeManager({ notes, resolve });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.deepEqual(linkedHeadings(chunks), [`${LINKED_POST_HEADING_PREFIX}one`]);
});

test('a scalar yt-metadata value resolves', async () => {
	const notes = new Map([
		[NOTE, { frontmatter: { 'yt-metadata': '[[yt_metadata/vid1]]' }, content: BARE_CONTENT }],
		['yt_metadata/vid1.md', { frontmatter: {}, content: 'A video transcript summary.' }],
	]);
	const resolve = new Map([['yt_metadata/vid1', 'yt_metadata/vid1.md']]);
	const manager = makeManager({ notes, resolve });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.deepEqual(linkedHeadings(chunks), [`${LINKED_POST_HEADING_PREFIX}vid1`]);
});

test('alias and heading wikilink forms strip down to the same linkpath', async () => {
	const notes = new Map([
		[NOTE, { frontmatter: { 'x-metadata': ['[[x_metadata/one|Some Alias]]', '[[x_metadata/two#Section]]'] }, content: BARE_CONTENT }],
		['x_metadata/one.md', { frontmatter: {}, content: 'Aliased link target body.' }],
		['x_metadata/two.md', { frontmatter: {}, content: 'Heading-suffixed link target body.' }],
	]);
	const resolve = new Map([['x_metadata/one', 'x_metadata/one.md'], ['x_metadata/two', 'x_metadata/two.md']]);
	const manager = makeManager({ notes, resolve });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.deepEqual(linkedHeadings(chunks), [
		`${LINKED_POST_HEADING_PREFIX}one`,
		`${LINKED_POST_HEADING_PREFIX}two`,
	]);
});

test('an unresolvable stamp (the linked note moved or was deleted) is dropped silently, not thrown', async () => {
	const notes = new Map([[NOTE, { frontmatter: { 'x-metadata': ['[[x_metadata/gone]]'] }, content: BARE_CONTENT }]]);
	const manager = makeManager({ notes, resolve: new Map() });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.equal(linkedHeadings(chunks).length, 0);
	assert.equal(chunks[0].contentHash, hashSearchContent(BARE_CONTENT));
});

// ── 3. Tombstones ───────────────────────────────────────────────────────────────────────────

test('an X tombstone (frontmatter-only, empty body) produces no linked chunk', async () => {
	const tombstoneContent = ['---', 'state: unavailable', '---', ''].join('\n');
	const notes = new Map([
		[NOTE, { frontmatter: { 'x-metadata': ['[[x_metadata/gone]]'] }, content: BARE_CONTENT }],
		['x_metadata/gone.md', { frontmatter: { state: 'unavailable' }, content: tombstoneContent }],
	]);
	const resolve = new Map([['x_metadata/gone', 'x_metadata/gone.md']]);
	const manager = makeManager({ notes, resolve });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.equal(linkedHeadings(chunks).length, 0);
	// A tombstone contributes no facet either — nothing to fold when nothing is emitted.
	assert.equal(chunks[0].contentHash, hashSearchContent(BARE_CONTENT));
});

// ── 4. Cap ──────────────────────────────────────────────────────────────────────────────────

test('more than MAX_LINKED_DOCUMENTS_PER_NOTE stamps are capped, first-listed wins', async () => {
	assert.equal(MAX_LINKED_DOCUMENTS_PER_NOTE, 8);
	const targets = Array.from({ length: 10 }, (_, i) => `x_metadata/t${i}`);
	const stamps = targets.map(t => `[[${t}]]`);
	const notes = new Map([[NOTE, { frontmatter: { 'x-metadata': stamps }, content: BARE_CONTENT }]]);
	const resolve = new Map();
	for (const t of targets) {
		notes.set(`${t}.md`, { frontmatter: {}, content: `Body of ${t}.` });
		resolve.set(t, `${t}.md`);
	}
	const manager = makeManager({ notes, resolve });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	const headings = linkedHeadings(chunks);
	assert.equal(headings.length, 8);
	assert.deepEqual(headings, targets.slice(0, 8).map(t => `${LINKED_POST_HEADING_PREFIX}t${t.slice(-1)}`));
});

// ── 5. Behavioral end-to-end: a distinctive phrase living only in the linked post is findable ──

test('a distinctive phrase that exists only in the linked post reaches a chunk on the citing note', async () => {
	const linkedBody = 'The genius author sysadmin rebuilt the flux capacitor calibration rig overnight.';
	const notes = new Map([
		[NOTE, { frontmatter: { 'x-metadata': ['[[x_metadata/one]]'] }, content: BARE_CONTENT }],
		['x_metadata/one.md', { frontmatter: {}, content: linkedBody }],
	]);
	const resolve = new Map([['x_metadata/one', 'x_metadata/one.md']]);
	const manager = makeManager({ notes, resolve });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	const hit = chunks.find(c => /flux capacitor calibration/.test(c.text));
	assert.ok(hit, 'expected a chunk carrying the linked post text');
	// The whole point: the hit is the THREAD note, not the metadata note.
	assert.equal(hit.path, NOTE);
	assert.equal(hit.heading, `${LINKED_POST_HEADING_PREFIX}one`);
});

// ── 6. Hash fold: population + no-op-until-touched, and forward invalidation ────────────────

test('a stamped note with a linked post re-indexes once, then skips on the next unchanged sweep', async () => {
	const content = ['---', 'title: Thread', 'x-metadata:', '  - "[[x_metadata/one]]"', '---', 'Prose.'].join('\n');
	const notes = new Map([
		[NOTE, { frontmatter: { 'x-metadata': ['[[x_metadata/one]]'] }, content }],
		['x_metadata/one.md', { frontmatter: {}, content: 'Linked post body.' }],
	]);
	const resolve = new Map([['x_metadata/one', 'x_metadata/one.md']]);

	// Before: indexed under the bare content hash (no facet mechanism existed / note not yet
	// re-swept since the stamp landed).
	const client = { fileStates: async () => new Map([[NOTE, { path: NOTE, contentHash: hashSearchContent(content) }]]), upserted: [], upsertChunks: async function (c) { this.upserted.push(c); } };
	const manager = makeManager({ notes, resolve, client });

	const first = await manager.indexFiles([makeFile(NOTE)]);
	assert.equal(first.files, 1, 'the folded hash must differ from the bare-content hash, forcing one re-upsert');
	assert.equal(client.upserted.length, 1);
	const upsertedHash = client.upserted[0][0].contentHash;

	// After: re-sweeping with the companion now reporting the folded hash must skip.
	const client2 = { fileStates: async () => new Map([[NOTE, { path: NOTE, contentHash: upsertedHash }]]), upserted: [], upsertChunks: async function (c) { this.upserted.push(c); } };
	const manager2 = makeManager({ notes, resolve, client: client2 });
	const second = await manager2.indexFiles([makeFile(NOTE)]);
	assert.equal(second.files, 0, 'a facet that re-indexed on every sweep would be as broken as one that never did');
});

test('a linked target whose own text later changes moves the citing note\'s hash, even though the citing note\'s bytes never changed', async () => {
	const content = ['---', 'title: Thread', 'x-metadata:', '  - "[[x_metadata/one]]"', '---', 'Prose.'].join('\n');
	const notesBefore = new Map([
		[NOTE, { frontmatter: { 'x-metadata': ['[[x_metadata/one]]'] }, content }],
		['x_metadata/one.md', { frontmatter: {}, content: 'Original linked post body.' }],
	]);
	const notesAfter = new Map([
		[NOTE, { frontmatter: { 'x-metadata': ['[[x_metadata/one]]'] }, content }],
		// A future refresh feature updating the metadata note's own text — the citing note's bytes
		// are byte-identical to `notesBefore`.
		['x_metadata/one.md', { frontmatter: {}, content: 'Edited linked post body, different text entirely.' }],
	]);
	const resolve = new Map([['x_metadata/one', 'x_metadata/one.md']]);

	const before = await makeManager({ notes: notesBefore, resolve }).buildFileChunks(makeFile(NOTE));
	const after = await makeManager({ notes: notesAfter, resolve }).buildFileChunks(makeFile(NOTE));

	assert.notEqual(before[0].contentHash, after[0].contentHash);
});

// ── 7. Chunker-level: the pure function, exercised directly (no SearchManager/vault at all) ──

test('buildSearchChunks emits an ordinary "Linked post:" chunk per entry, appended after prose', () => {
	const input = {
		vaultId: 'test',
		path: NOTE,
		basename: 'example',
		extension: 'md',
		mtime: 1,
		content: BARE_CONTENT,
		maxChars: 400,
		overlapChars: 0,
		linkedDocuments: [{ path: 'x_metadata/one.md', title: 'one', text: 'Linked body text.' }],
	};
	const chunks = buildSearchChunks(input);
	assert.equal(chunks.length, 2);
	assert.equal(chunks[0].heading, 'Findings');
	assert.equal(chunks[1].heading, `${LINKED_POST_HEADING_PREFIX}one`);
	assert.equal(chunks[1].text, 'Linked body text.');
	assert.equal(chunks[1].path, NOTE, 'the linked chunk carries the citing note\'s path, not the linked note\'s');
	assert.deepEqual(chunks.map(c => c.ordinal), [0, 1]);
});

test('an empty linkedDocuments array is byte-identical to omitting the parameter entirely (regression pin)', () => {
	const base = {
		vaultId: 'test',
		path: NOTE,
		basename: 'example',
		extension: 'md',
		mtime: 1,
		content: BARE_CONTENT,
		maxChars: 400,
		overlapChars: 0,
	};
	const omitted = buildSearchChunks(base);
	const empty = buildSearchChunks({ ...base, linkedDocuments: [] });
	assert.deepEqual(omitted, empty);
	assert.equal(omitted.length, 1, 'no linked-post chunk when there is nothing to link');
});

test('an entry with empty/whitespace-only text is skipped (the tombstone case, exercised directly)', () => {
	const chunks = buildSearchChunks({
		vaultId: 'test',
		path: NOTE,
		basename: 'example',
		extension: 'md',
		mtime: 1,
		content: BARE_CONTENT,
		maxChars: 400,
		overlapChars: 0,
		linkedDocuments: [
			{ path: 'x_metadata/tombstone.md', title: 'tombstone', text: '   ' },
			{ path: 'x_metadata/real.md', title: 'real', text: 'Real body.' },
		],
	});
	assert.deepEqual(linkedHeadings(chunks), [`${LINKED_POST_HEADING_PREFIX}real`]);
});

test('buildSearchChunks itself truncates linkedDocuments to the cap, defensively', () => {
	const linkedDocuments = Array.from({ length: 12 }, (_, i) => ({ path: `x_metadata/t${i}.md`, title: `t${i}`, text: `Body ${i}.` }));
	const chunks = buildSearchChunks({
		vaultId: 'test',
		path: NOTE,
		basename: 'example',
		extension: 'md',
		mtime: 1,
		content: BARE_CONTENT,
		maxChars: 400,
		overlapChars: 0,
		linkedDocuments,
	});
	assert.equal(linkedHeadings(chunks).length, MAX_LINKED_DOCUMENTS_PER_NOTE);
});

test('linked-post chunk ids are deterministic across calls', () => {
	const input = {
		vaultId: 'test',
		path: NOTE,
		basename: 'example',
		extension: 'md',
		mtime: 1,
		content: BARE_CONTENT,
		maxChars: 400,
		overlapChars: 0,
		linkedDocuments: [
			{ path: 'x_metadata/one.md', title: 'one', text: 'First body.' },
			{ path: 'x_metadata/two.md', title: 'two', text: 'Second body.' },
		],
	};
	const first = buildSearchChunks(input);
	const second = buildSearchChunks(input);
	assert.deepEqual(first.map(c => c.id), second.map(c => c.id));
	assert.equal(new Set(first.map(c => c.id)).size, first.length);
});
