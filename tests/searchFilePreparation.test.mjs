// WP-R2: the file-preparation subsystem extracted out of `SearchManager` into
// `src/search/filePreparation.ts`. The extraction is behavior-preserving by contract, and its one
// sanctioned change is that the two independent facet resolutions (image descriptions, linked
// posts) are now awaited together via `Promise.all` instead of one after the other.
//
// That concurrency change is the reason this file exists. Everything downstream of preparation —
// `contentHash`, every `stableChunkId`, the companion's full-replace upsert, the audit's
// hash/chunk verification — is derived from what preparation produces, and sequential awaits gave
// that determinism for free. Two things carry it under concurrency, and it is worth being precise
// about which does what, because only one of them is a property of this module:
//
//   1. The *facet-array order* is genuinely not load-bearing, and never was: `hashSearchContent`
//      (chunker.ts) trims, de-duplicates and **sorts** the facets before folding them, so the
//      merge could compose them in either order and hash identically. That is asserted directly
//      below rather than assumed, since it is the whole reason a concurrent merge is safe — if a
//      future change made facet order significant, this suite must be the thing that says so.
//   2. Each resolver's *own internal order* — image descriptions sorted by md5, linked documents
//      walked in raw-stamp order so "first listed wins" decides the eight-link cap — is what
//      actually fixes chunk order and therefore every `stableChunkId`. Awaiting the two resolvers
//      together must not perturb either, and a resolver rewritten to complete out of order (the
//      obvious "make it faster too" follow-on) is exactly the regression to catch.
//
// The pins are therefore about the *combination*: a note carrying BOTH facets at once, prepared
// under both settle orders, must produce one hash and one chunk sequence. That shape is invisible
// in every existing single-facet suite (`searchImageDescriptions`, `searchLinkedPostChunks`),
// whose test doubles can each express only one facet. Those suites stay the authority on each
// facet's own rules (emission, tombstones, failure records); nothing here re-litigates them.
//
// Everything runs offline against fakes — no companion, no provider, no ports, no vault.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-file-preparation-tests');
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
const {
	hashSearchContent,
	isImageChunkHeading,
	LINKED_POST_HEADING_PREFIX,
	MAX_LINKED_DOCUMENTS_PER_NOTE,
} = await import(pathToFileURL(chunkerOutfile));
const { ImageDescriptionStore } = await import(pathToFileURL(storeOutfile));

const MD5_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const IMAGE_A = `thread/_attachments/example/${MD5_A}_MD5.png`;

const NOTE = 'thread/example.md';
const LINKED = 'x_metadata/post-one.md';
const LINKED_BODY = 'The linked post body, with a distinctive phrase: pyroclastic.';

// A note carrying BOTH facets: one described embed and one x-metadata stamp.
const CONTENT = [
	'---',
	'title: Example Thread',
	'x-metadata:',
	'  - "[[x_metadata/post-one]]"',
	'---',
	'# Findings',
	'Some prose about the thread.',
	'',
	`![](${IMAGE_A})`,
].join('\n');

const FRONTMATTER = { title: 'Example Thread', 'x-metadata': ['[[x_metadata/post-one]]'] };

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

const tick = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The real store over an in-memory adapter, with an optional per-read delay. `delayMs` is how
 * this file forces the two facet resolutions to settle in a chosen order: every storage read the
 * store performs inside `ensureLoaded`/`get` pays it, so a non-zero delay reliably puts the image
 * facet last even though it is composed first.
 */
function makeStore({ delayMs = 0 } = {}) {
	const files = new Map();
	const wait = async () => { if (delayMs) await tick(delayMs); };
	const storage = {
		read: async (p) => { await wait(); return files.get(p) ?? null; },
		write: async (p, data) => { files.set(p, data); },
		exists: async (p) => files.has(p),
		remove: async (p) => { files.delete(p); },
		list: async (dir) => { await wait(); return [...files.keys()].filter(p => p.startsWith(`${dir}/`)); },
	};
	return new ImageDescriptionStore(storage, 'plugin-data/image-descriptions');
}

/**
 * One fake vault serving BOTH facet sources off the same `getFileCache` — the shape a real note
 * with a described figure and a stamped post actually has, and the shape neither single-facet
 * suite's double can express (`searchImageDescriptions` reports only `embeds`,
 * `searchLinkedPostChunks` only `frontmatter`).
 *
 * `linkedDelayMs` is the mirror of `makeStore`'s `delayMs`: it delays the linked target's
 * `cachedRead`, so the linked facet settles last. Between the two, both settle orders are
 * reachable.
 */
function makeManager({
	store = null,
	content = CONTENT,
	frontmatter = FRONTMATTER,
	embeds = [IMAGE_A],
	linkedBody = LINKED_BODY,
	linkedDelayMs = 0,
	resolveLinked = true,
	excluded = false,
	client,
} = {}) {
	const bodies = new Map([[NOTE, content], [LINKED, linkedBody]]);
	const app = {
		metadataCache: {
			isUserIgnored: (p) => excluded && p === NOTE,
			getFileCache: (file) => (file.path === NOTE
				? { frontmatter, embeds: embeds.map(link => ({ link, original: `![](${link})` })) }
				: { frontmatter: {} }),
			getFirstLinkpathDest: (link) => {
				if (link.startsWith('http')) return null;
				if (link === 'x_metadata/post-one') return resolveLinked ? makeFile(LINKED) : null;
				if (link.startsWith('x_metadata/')) return resolveLinked ? makeFile(`${link}.md`) : null;
				return { path: link };
			},
		},
		vault: {
			read: async (file) => bodies.get(file.path) ?? '',
			cachedRead: async (file) => {
				if (linkedDelayMs) await tick(linkedDelayMs);
				return bodies.get(file.path) ?? LINKED_BODY;
			},
		},
	};
	const manager = new SearchManager(app, settings(), {});
	manager.setImageDescriptionStore(store);
	if (client) manager.client = () => client;
	return manager;
}

async function describedStore(options = {}) {
	const store = makeStore(options);
	await store.put({
		md5: MD5_A,
		narrative: 'A line chart of quarterly revenue climbing through Q4.',
		extraction: 'Title: Quarterly revenue\nQ4 2.6M',
		kind: 'vision',
		providerId: 'local',
		modelId: 'a-vision-model',
	});
	return store;
}

function imageFacet(store) {
	return `image-desc:${store.combinedDescriptionHash([MD5_A])}`;
}

function linkedFacet() {
	return `linked:${LINKED}:${hashSearchContent(LINKED_BODY)}`;
}

// The hash the extracted `prepareSearchFile` must produce for the both-facets note: both facets
// folded into `hashSearchContent`. Computed here from the store's own `combinedDescriptionHash`
// and the chunker's own `hashSearchContent`, so this is the contract restated independently
// rather than a copy of the implementation.
function expectedCombinedHash(store) {
	return hashSearchContent(CONTENT, [imageFacet(store), linkedFacet()]);
}

function makeClient(states) {
	const upserted = [];
	return {
		upserted,
		fileStates: async () => new Map(Object.entries(states).map(([p, contentHash]) => [p, { path: p, contentHash }])),
		upsertChunks: async (chunks) => { upserted.push(chunks); },
	};
}

// ── 1. Both facets fold into one hash, and settle order cannot move it ────────────────────

test('hashSearchContent sorts its facets, so the merge order the concurrent resolution produces is not load-bearing', async () => {
	// The property that makes awaiting the two resolvers together safe at the hash level. Stated
	// as its own pin: a future chunker change that made facet order significant would turn the
	// settle-order tests below from redundant belt-and-braces into the only line of defence, and
	// this assertion is what would fail first and name the reason.
	const store = await describedStore();
	assert.equal(
		hashSearchContent(CONTENT, [imageFacet(store), linkedFacet()]),
		hashSearchContent(CONTENT, [linkedFacet(), imageFacet(store)]),
	);
});

test('a note carrying both facets folds both into its contentHash', async () => {
	const store = await describedStore();
	const manager = makeManager({ store });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.equal(chunks[0].contentHash, expectedCombinedHash(store));
	// Neither facet alone is enough — this is the combination, not either single-facet suite.
	assert.notEqual(chunks[0].contentHash, hashSearchContent(CONTENT, [imageFacet(store)]));
	assert.notEqual(chunks[0].contentHash, hashSearchContent(CONTENT, [linkedFacet()]));
});

test('the same hash results when the image facet settles LAST (slow description store)', async () => {
	const store = await describedStore({ delayMs: 15 });
	const manager = makeManager({ store });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.equal(chunks[0].contentHash, expectedCombinedHash(store));
});

test('the same hash results when the linked facet settles LAST (slow cachedRead)', async () => {
	const store = await describedStore();
	const manager = makeManager({ store, linkedDelayMs: 15 });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.equal(chunks[0].contentHash, expectedCombinedHash(store));
});

test('swapping which facet settles first does not change one byte of the prepared hash', async () => {
	const imageLast = await describedStore({ delayMs: 15 });
	const linkedLast = await describedStore();

	const a = await makeManager({ store: imageLast }).buildFileChunks(makeFile(NOTE));
	const b = await makeManager({ store: linkedLast, linkedDelayMs: 15 }).buildFileChunks(makeFile(NOTE));

	assert.equal(a[0].contentHash, b[0].contentHash);
});

// ── 2. Chunk ids and chunk order are byte-identical across settle orders ──────────────────

test('chunk ids, order and headings are identical whichever facet settles first', async () => {
	const imageLast = await describedStore({ delayMs: 15 });
	const linkedLast = await describedStore();

	const a = await makeManager({ store: imageLast }).buildFileChunks(makeFile(NOTE));
	const b = await makeManager({ store: linkedLast, linkedDelayMs: 15 }).buildFileChunks(makeFile(NOTE));

	assert.deepEqual(a.map(c => c.id), b.map(c => c.id));
	assert.deepEqual(a.map(c => c.heading), b.map(c => c.heading));
	assert.deepEqual(a.map(c => c.text), b.map(c => c.text));
});

test('both facets emit onto the same note, prose first, then image chunks, then linked-post chunks', async () => {
	const store = await describedStore();
	const chunks = await makeManager({ store }).buildFileChunks(makeFile(NOTE));

	const kinds = chunks.map(c => {
		if (isImageChunkHeading(c.heading)) return 'image';
		if (c.heading.startsWith(LINKED_POST_HEADING_PREFIX)) return 'linked';
		return 'prose';
	});
	// The ordering claim: no image chunk after a linked chunk, no prose chunk after either.
	assert.deepEqual(kinds, [...kinds].sort((x, y) => {
		const rank = { prose: 0, image: 1, linked: 2 };
		return rank[x] - rank[y];
	}));
	assert.ok(kinds.includes('image'), 'the described figure must emit at least one chunk');
	assert.ok(kinds.includes('linked'), 'the stamped post must emit at least one chunk');
	// Description and linked-post chunks alike carry the CITING note's path — hits are notes.
	for (const chunk of chunks) assert.equal(chunk.path, NOTE);
});

test('repeated preparation of an unchanged note is byte-identical (deterministic ids, no accumulated facets)', async () => {
	const store = await describedStore();
	const manager = makeManager({ store });

	const first = await manager.buildFileChunks(makeFile(NOTE));
	const second = await manager.buildFileChunks(makeFile(NOTE));

	assert.deepEqual(first.map(c => c.id), second.map(c => c.id));
	assert.deepEqual(first.map(c => c.contentHash), second.map(c => c.contentHash));
});

// ── 3. The public entry points still agree with each other and with the write path ────────

test('auditPrepareFile, buildFileChunks and indexFiles agree on the both-facets note', async () => {
	const store = await describedStore();
	const client = makeClient({});
	const manager = makeManager({ store, client });

	const audited = await manager.auditPrepareFile(makeFile(NOTE));
	const built = await manager.buildFileChunks(makeFile(NOTE));
	await manager.indexFiles([makeFile(NOTE)]);

	assert.equal(client.upserted.length, 1);
	const sent = client.upserted[0];
	assert.equal(audited.contentHash, expectedCombinedHash(store));
	assert.equal(audited.chunkCount, built.length);
	assert.equal(audited.chunkCount, sent.length);
	assert.deepEqual(built.map(c => c.id), sent.map(c => c.id));
	for (const chunk of sent) assert.equal(chunk.contentHash, audited.contentHash);
});

test('a note whose combined hash already matches the index skips without building chunks', async () => {
	const store = await describedStore();
	const client = makeClient({ [NOTE]: expectedCombinedHash(store) });
	const manager = makeManager({ store, client });

	const result = await manager.indexFiles([makeFile(NOTE)]);
	assert.equal(result.files, 0);
	assert.equal(client.upserted.length, 0);
	assert.deepEqual(result.outcomes.get(NOTE), { outcome: 'skipped-unchanged', chunks: 0 });
});

test('an excluded path prepares to nothing on both entry points', async () => {
	const store = await describedStore();
	const manager = makeManager({ store, excluded: true });

	assert.deepEqual(await manager.buildFileChunks(makeFile(NOTE)), []);
	assert.equal(await manager.auditPrepareFile(makeFile(NOTE)), null);
});

// ── 4. Empty / tombstone / cap behavior survives the concurrent resolution ────────────────

test('a tombstoned linked target (empty body after the frontmatter slice) leaves only the image facet', async () => {
	const store = await describedStore();
	const manager = makeManager({ store, linkedBody: ['---', 'state: unavailable', '---', ''].join('\n') });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.equal(chunks[0].contentHash, hashSearchContent(CONTENT, [imageFacet(store)]));
	assert.equal(chunks.filter(c => c.heading.startsWith(LINKED_POST_HEADING_PREFIX)).length, 0);
});

test('an unresolvable stamp leaves only the image facet; an undescribed image leaves only the linked facet', async () => {
	const store = await describedStore();
	const imageOnly = await makeManager({ store, resolveLinked: false }).buildFileChunks(makeFile(NOTE));
	assert.equal(imageOnly[0].contentHash, hashSearchContent(CONTENT, [imageFacet(store)]));

	// Same note, no store at all: the image facet disappears and the linked one stands alone.
	const linkedOnly = await makeManager({ store: null }).buildFileChunks(makeFile(NOTE));
	assert.equal(linkedOnly[0].contentHash, hashSearchContent(CONTENT, [linkedFacet()]));
});

test('neither facet present hashes exactly as a note did before either facet existed', async () => {
	const bare = ['---', 'title: Example Thread', '---', '# Findings', 'Some prose about the thread.'].join('\n');
	const manager = makeManager({ store: null, content: bare, frontmatter: { title: 'Example Thread' }, embeds: [] });

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	assert.equal(chunks[0].contentHash, hashSearchContent(bare));
});

test('the eight-link cap still applies to the raw stamp list, first-listed wins, under concurrent resolution', async () => {
	const stamps = Array.from({ length: MAX_LINKED_DOCUMENTS_PER_NOTE + 3 }, (_, i) => `[[x_metadata/post-${i}]]`);
	const store = await describedStore({ delayMs: 10 });
	const manager = makeManager({
		store,
		frontmatter: { title: 'Example Thread', 'x-metadata': stamps },
	});

	const chunks = await manager.buildFileChunks(makeFile(NOTE));
	const linked = chunks.filter(c => c.heading.startsWith(LINKED_POST_HEADING_PREFIX));
	assert.equal(linked.length, MAX_LINKED_DOCUMENTS_PER_NOTE);
	assert.deepEqual(
		linked.map(c => c.heading),
		Array.from({ length: MAX_LINKED_DOCUMENTS_PER_NOTE }, (_, i) => `${LINKED_POST_HEADING_PREFIX}post-${i}`),
	);
});
