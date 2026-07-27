// The image-description facet where it actually bites: `SearchManager.prepareFile`.
//
// Two failure modes are being fenced off here, and they pull in opposite directions.
//
// 1. **The permanently-skipped note.** Descriptions live in a store *outside* the vault
//    (`imageDescriptionStore.ts`), so describing a figure changes nothing about the note's bytes.
//    The coverage-aware skip in `indexFiles` compares `contentHash`, so without folding the
//    descriptions into that hash an already-indexed note would be skipped forever and its figures
//    would never reach the index — silently, with no error anywhere. This is the entity facet's
//    "an edit that changes only the folded facet must re-index" argument
//    (`tests/searchEntityFacet.test.mjs`), applied to a facet that is not even in the file.
//
// 2. **The needless vault-wide re-index.** The entity facet could afford to move every note's
//    hash once, because that sweep was how the new column got populated. This facet cannot: the
//    overwhelming majority of notes embed no described image, and moving their hashes would
//    re-upsert (and, with semantic search on, re-embed) the whole vault to write byte-identical
//    chunks. So a note with no described images must hash and chunk exactly as it did before.
//
// Everything runs offline against fakes — no companion, no provider, no ports.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-image-descriptions-tests');
const managerOutfile = path.join(outdir, 'SearchManager.mjs');
const chunkerOutfile = path.join(outdir, 'chunker.mjs');
const storeOutfile = path.join(outdir, 'imageDescriptionStore.mjs');

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

await esbuild.build({
	entryPoints: ['src/search/imageDescriptionStore.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile: storeOutfile,
	logLevel: 'silent',
});

const { SearchManager } = await import(pathToFileURL(managerOutfile));
const { hashSearchContent, isImageChunkHeading } = await import(pathToFileURL(chunkerOutfile));
const { ImageDescriptionStore } = await import(pathToFileURL(storeOutfile));

const MD5_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const MD5_B = '0f9e8d7c6b5a493827160f5e4d3c2b1a';
const IMAGE_A = `notes/_attachments/report/${MD5_A}_MD5.png`;
const IMAGE_B = `notes/_attachments/report/${MD5_B}_MD5.svg`;
const NOTE = 'notes/report.md';
const CONTENT = ['---', 'title: Quarterly Report', '---', '# Findings', 'Revenue rose.', '', `![](${IMAGE_A})`].join('\n');

// The real store over an in-memory adapter — the point is the *interaction* (ensureLoaded /
// has / get / combinedDescriptionHash), so faking the store would fake away the thing under test.
function makeStore() {
	const files = new Map();
	const storage = {
		read: async (p) => files.get(p) ?? null,
		write: async (p, data) => { files.set(p, data); },
		exists: async (p) => files.has(p),
		remove: async (p) => { files.delete(p); },
		list: async (dir) => [...files.keys()].filter(p => p.startsWith(`${dir}/`)),
	};
	return new ImageDescriptionStore(storage, 'plugin-data/image-descriptions');
}

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

// `embeds` is what the metadata cache reports for a note; `getFirstLinkpathDest` is how a link
// becomes a vault path. Same pair `AttachmentLocalizer.parseAttachmentRefs` walks.
function makeManager({ store = null, embeds = [], content = CONTENT, client } = {}) {
	const app = {
		metadataCache: {
			isUserIgnored: () => false,
			getFileCache: () => ({ embeds: embeds.map(link => ({ link, original: `![](${link})` })) }),
			getFirstLinkpathDest: (link) => (link.startsWith('http') ? null : { path: link }),
		},
		vault: { read: async () => content },
	};
	const manager = new SearchManager(app, settings(), {});
	manager.setImageDescriptionStore(store);
	if (client) manager.client = () => client;
	return manager;
}

// A client that reports every path as already indexed at `contentHash`, and records what it is
// asked to upsert. This is the skip path under test.
function makeClient(states) {
	const upserted = [];
	return {
		upserted,
		fileStates: async () => new Map(Object.entries(states).map(([p, contentHash]) => [p, { path: p, contentHash }])),
		upsertChunks: async (chunks) => { upserted.push(chunks); },
	};
}

// ── 1. No described images: nothing changes, at all ───────────────────────────────────────

test('a note whose images are undescribed hashes and chunks exactly as it did before the facet', async () => {
	const bare = makeManager({ store: null, embeds: [IMAGE_A] });
	const withEmptyStore = makeManager({ store: makeStore(), embeds: [IMAGE_A] });

	const bareChunks = await bare.buildFileChunks(makeFile(NOTE));
	const emptyStoreChunks = await withEmptyStore.buildFileChunks(makeFile(NOTE));

	// The unwired case (no store at all — what `main.ts` produces until the setter is called) and
	// the wired-but-nothing-described case must both land on the untouched hash.
	assert.equal(bareChunks[0].contentHash, hashSearchContent(CONTENT));
	assert.equal(emptyStoreChunks[0].contentHash, hashSearchContent(CONTENT));
	assert.deepEqual(bareChunks.map(c => c.id), emptyStoreChunks.map(c => c.id));
	assert.equal(bareChunks.some(c => isImageChunkHeading(c.heading)), false);
	assert.equal(emptyStoreChunks.some(c => isImageChunkHeading(c.heading)), false);
});

test('an unchanged note with no new descriptions still skips', async () => {
	const store = makeStore();
	// A described image the note does NOT embed: present in the store, irrelevant to this note.
	await store.put({ md5: MD5_B, narrative: 'Some other figure.', extraction: '', kind: 'vision' });

	const client = makeClient({ [NOTE]: hashSearchContent(CONTENT) });
	const manager = makeManager({ store, embeds: [IMAGE_A], client });

	const result = await manager.indexFiles([makeFile(NOTE)]);
	assert.equal(result.files, 0);
	assert.equal(result.chunks, 0);
	assert.equal(client.upserted.length, 0);
});

// ── 2. A description arriving must re-index a note whose bytes never changed ──────────────

test('a description arriving for an unchanged note changes its hash, so it re-indexes instead of being skipped', async () => {
	const store = makeStore();
	const client = makeClient({ [NOTE]: hashSearchContent(CONTENT) });
	const manager = makeManager({ store, embeds: [IMAGE_A], client });

	// Before: the store knows nothing, the hash is the plain one, the note skips.
	assert.equal(await store.ensureLoaded().then(() => store.has(MD5_A)), false);
	assert.equal((await manager.indexFiles([makeFile(NOTE)])).files, 0);

	// The figure gets described. Not one byte of `notes/report.md` changed.
	await store.put({
		md5: MD5_A,
		narrative: 'A line chart of quarterly revenue climbing through Q4.',
		extraction: 'Title: Quarterly revenue\nQ4 2.6M',
		kind: 'vision',
		providerId: 'local',
		modelId: 'a-vision-model',
	});

	const result = await manager.indexFiles([makeFile(NOTE)]);
	// The load-bearing assertion. Without the fold this is 0 and the note's figure is never
	// indexed — no error, no retry, no way to notice short of searching for the figure and
	// finding nothing.
	assert.equal(result.files, 1);
	assert.equal(client.upserted.length, 1);

	const chunks = client.upserted[0];
	const imageChunks = chunks.filter(c => isImageChunkHeading(c.heading));
	assert.equal(imageChunks.length, 2);
	assert.deepEqual(imageChunks.map(c => c.heading), [
		`Image: ${MD5_A}_MD5.png`,
		`Image: ${MD5_A}_MD5.png (text)`,
	]);
	// Description chunks carry the owning NOTE's path — hits are notes, never images.
	for (const chunk of chunks) assert.equal(chunk.path, NOTE);
	assert.notEqual(chunks[0].contentHash, hashSearchContent(CONTENT));
});

test('once re-indexed under the new hash, the described note skips again', async () => {
	const store = makeStore();
	await store.put({ md5: MD5_A, narrative: 'A line chart.', extraction: 'Q4 2.6M', kind: 'vision' });

	const describedHash = hashSearchContent(CONTENT, [`image-desc:${store.combinedDescriptionHash([MD5_A])}`]);
	const client = makeClient({ [NOTE]: describedHash });
	const manager = makeManager({ store, embeds: [IMAGE_A], client });

	const result = await manager.indexFiles([makeFile(NOTE)]);
	// A facet that re-indexed on *every* sweep would be as broken as one that never did.
	assert.equal(result.files, 0);
	assert.equal(client.upserted.length, 0);
});

test('re-describing an image with different text moves the hash again', async () => {
	const store = makeStore();
	await store.put({ md5: MD5_A, narrative: 'A line chart.', extraction: 'Q4 2.6M', kind: 'vision' });
	const first = store.combinedDescriptionHash([MD5_A]);

	await store.put({ md5: MD5_A, narrative: 'A bar chart, actually.', extraction: 'Q4 2.6M', kind: 'vision' });
	const second = store.combinedDescriptionHash([MD5_A]);

	assert.notEqual(first, second);
	assert.notEqual(
		hashSearchContent(CONTENT, [`image-desc:${first}`]),
		hashSearchContent(CONTENT, [`image-desc:${second}`]),
	);
});

// ── 3. Resolution rules ───────────────────────────────────────────────────────────────────

test('only the note\'s own described embeds contribute, and each md5 contributes once', async () => {
	const store = makeStore();
	await store.put({ md5: MD5_A, narrative: 'Figure A.', extraction: 'A', kind: 'vision' });
	await store.put({ md5: MD5_B, narrative: '', extraction: 'Pipeline: intake -> enrich -> index', kind: 'svg-text' });

	const manager = makeManager({
		store,
		// The same image twice, a second described image, an undescribed one, a remote ref, and a
		// non-`_MD5` attachment that the naming convention cannot key a description on.
		embeds: [IMAGE_A, IMAGE_A, IMAGE_B, 'notes/plain-diagram.png', 'https://example.com/remote.png'],
	});

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	const headings = chunks.filter(c => isImageChunkHeading(c.heading)).map(c => c.heading);
	// A: narrative + extraction = 2. B: SVG, extraction only = 1. Nothing else resolves.
	assert.deepEqual(headings, [
		`Image: ${MD5_B}_MD5.svg (text)`,
		`Image: ${MD5_A}_MD5.png`,
		`Image: ${MD5_A}_MD5.png (text)`,
	], 'images are ordered by md5 so the chunk ids are stable across sessions');
	assert.equal(chunks[0].contentHash, hashSearchContent(CONTENT, [`image-desc:${store.combinedDescriptionHash([MD5_A, MD5_B])}`]));
});

test('a record with no narrative and no extraction contributes neither a chunk nor a hash change', async () => {
	const store = makeStore();
	await store.put({ md5: MD5_A, narrative: '   ', extraction: '', kind: 'vision' });
	const manager = makeManager({ store, embeds: [IMAGE_A] });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.equal(chunks.some(c => isImageChunkHeading(c.heading)), false);
	// The invariant the fold exists to state: the hash covers exactly what reaches the index.
	// A record that emits nothing must not move it, or the note re-indexes to rewrite itself.
	assert.equal(chunks[0].contentHash, hashSearchContent(CONTENT));
});

// ── idh-WP-1: kind:'failed' records must emit no chunks and no facet ─────────

test('a failed-description record contributes neither a chunk nor a hash change', async () => {
	const store = makeStore();
	await store.put({ md5: MD5_A, narrative: '', extraction: '', kind: 'failed', failure: 'timed out' });
	const manager = makeManager({ store, embeds: [IMAGE_A] });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.equal(chunks.some(c => isImageChunkHeading(c.heading)), false);
	// A failure appearing in the store must not move the note's contentHash — same invariant as
	// the "record with no narrative and no extraction" case, but here it's asserted by kind, not
	// by the fields happening to be empty.
	assert.equal(chunks[0].contentHash, hashSearchContent(CONTENT));
});

test('an arriving failure record does not re-index an already-indexed note (no facet, so no hash change)', async () => {
	const store = makeStore();
	const client = makeClient({ [NOTE]: hashSearchContent(CONTENT) });
	const manager = makeManager({ store, embeds: [IMAGE_A], client });

	assert.equal((await manager.indexFiles([makeFile(NOTE)])).files, 0, 'skips before any failure record exists');

	await store.put({ md5: MD5_A, narrative: '', extraction: '', kind: 'failed', failure: 'provider threw' });

	const result = await manager.indexFiles([makeFile(NOTE)]);
	assert.equal(result.files, 0, 'a failure landing must not be mistaken for new content to index');
	assert.equal(client.upserted.length, 0);
});

test('a described image and a failed image on the same note: only the described one contributes, to both chunks and the combined hash', async () => {
	const store = makeStore();
	await store.put({ md5: MD5_A, narrative: 'Figure A.', extraction: 'A', kind: 'vision' });
	await store.put({ md5: MD5_B, narrative: '', extraction: '', kind: 'failed', failure: 'timed out' });

	const manager = makeManager({ store, embeds: [IMAGE_A, IMAGE_B] });
	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	const imageHeadings = chunks.filter(c => isImageChunkHeading(c.heading)).map(c => c.heading);

	assert.deepEqual(imageHeadings, [`Image: ${MD5_A}_MD5.png`, `Image: ${MD5_A}_MD5.png (text)`]);
	// The combined hash matches what MD5_A alone would produce — MD5_B (failed) is excluded from
	// the md5 list fed to combinedDescriptionHash, not just from the chunk list.
	assert.equal(chunks[0].contentHash, hashSearchContent(CONTENT, [`image-desc:${store.combinedDescriptionHash([MD5_A])}`]));
	assert.notEqual(
		chunks[0].contentHash,
		hashSearchContent(CONTENT, [`image-desc:${store.combinedDescriptionHash([MD5_A, MD5_B])}`]),
		'a hash that folded the failed record in would disagree with the correct one',
	);
});

test('a note with no embeds at all never touches the store', async () => {
	const store = makeStore();
	await store.put({ md5: MD5_A, narrative: 'Figure A.', extraction: 'A', kind: 'vision' });
	const manager = makeManager({ store, embeds: [] });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.equal(chunks[0].contentHash, hashSearchContent(CONTENT));
	assert.equal(chunks.some(c => isImageChunkHeading(c.heading)), false);
});
