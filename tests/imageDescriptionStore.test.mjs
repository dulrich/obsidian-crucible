import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// ── Bundle src/search/imageDescriptionStore.ts standalone ──────────────────────
//
// Same technique as tests/imageMetadata.test.mjs: the module imports nothing from 'obsidian'
// (only `../log`, which is obsidian-free too), so no stub is needed at all.
const outdir = path.join(tmpdir(), 'obsidian-crucible-image-description-store-tests');
const outfile = path.join(outdir, 'imageDescriptionStore.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/imageDescriptionStore.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const { ImageDescriptionStore, IMAGE_DESCRIPTION_SCHEMA_VERSION } = await import(pathToFileURL(outfile).href);

// Minimal in-memory ImageDescriptionStorage. `list` is non-recursive on purpose (matches the
// contract of a real vault-adapter wrapper): only direct children of `dir` are returned.
function createFakeStorage() {
	const files = new Map();
	return {
		files,
		async read(p) { return files.has(p) ? files.get(p) : null; },
		async write(p, data) { files.set(p, data); },
		async exists(p) { return files.has(p); },
		async remove(p) { files.delete(p); },
		async list(dir) {
			const prefix = dir.endsWith('/') ? dir : `${dir}/`;
			return [...files.keys()].filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'));
		},
	};
}

const BASE_DIR = 'plugin-data/image-descriptions';
const MD5_A = 'a'.repeat(32);
const MD5_B = 'b'.repeat(32);

test('put/get/has/listMd5s round-trip on a stub storage', async () => {
	const storage = createFakeStorage();
	const store = new ImageDescriptionStore(storage, BASE_DIR);

	assert.equal(store.has(MD5_A), false);

	const record = await store.put({
		md5: MD5_A,
		narrative: 'A bar chart of quarterly revenue.',
		extraction: 'Q1: 10\nQ2: 20',
		kind: 'vision',
		providerId: 'local-lmstudio',
		modelId: 'gemma-4',
	});

	assert.equal(record.md5, MD5_A);
	assert.equal(record.kind, 'vision');
	assert.equal(record.schemaVersion, IMAGE_DESCRIPTION_SCHEMA_VERSION);
	assert.equal(typeof record.descriptionHash, 'string');
	assert.ok(record.descriptionHash.length > 0);
	assert.equal(typeof record.describedAt, 'string');

	assert.equal(store.has(MD5_A), true);
	assert.deepEqual(store.listMd5s(), [MD5_A]);

	const fetched = await store.get(MD5_A);
	assert.deepEqual(fetched, record);

	assert.equal(await store.get(MD5_B), null);
	assert.equal(store.has(MD5_B), false);
});

test('a fresh store instance rebuilds its index by listing baseDir (lazy, via ensureLoaded)', async () => {
	const storage = createFakeStorage();
	const store1 = new ImageDescriptionStore(storage, BASE_DIR);
	await store1.put({ md5: MD5_A, narrative: 'n', extraction: 'e', kind: 'vision' });

	const store2 = new ImageDescriptionStore(storage, BASE_DIR);
	assert.equal(store2.has(MD5_A), false); // sync, from an empty index — before ensureLoaded runs
	await store2.ensureLoaded();
	assert.equal(store2.has(MD5_A), true);
	assert.deepEqual(store2.listMd5s(), [MD5_A]);

	const fetched = await store2.get(MD5_A);
	assert.equal(fetched.narrative, 'n');
	assert.equal(fetched.extraction, 'e');

	// ensureLoaded is idempotent: a second call is a no-op, not a second listing/rebuild.
	await store2.ensureLoaded();
	assert.deepEqual(store2.listMd5s(), [MD5_A]);
});

test('a corrupt (unparseable) record file is treated as absent, never thrown', async () => {
	const storage = createFakeStorage();
	storage.files.set(`${BASE_DIR}/${MD5_A}.json`, 'not json{{{');
	const store = new ImageDescriptionStore(storage, BASE_DIR);

	await assert.doesNotReject(store.ensureLoaded());
	assert.equal(store.has(MD5_A), false);
	assert.equal(await store.get(MD5_A), null);
	assert.deepEqual(store.listMd5s(), []);
});

test('a structurally malformed (but valid-JSON) record file is treated as absent', async () => {
	const storage = createFakeStorage();
	storage.files.set(`${BASE_DIR}/${MD5_A}.json`, JSON.stringify({ md5: MD5_A, narrative: 'n' })); // missing required fields
	const store = new ImageDescriptionStore(storage, BASE_DIR);

	await store.ensureLoaded();
	assert.equal(store.has(MD5_A), false);
	assert.equal(await store.get(MD5_A), null);
});

test('descriptionHash is deterministic from (narrative, extraction) only — provider/model do not affect it', async () => {
	const storage1 = createFakeStorage();
	const store1 = new ImageDescriptionStore(storage1, BASE_DIR);
	const r1 = await store1.put({
		md5: MD5_A, narrative: 'same narrative', extraction: 'same extraction',
		kind: 'vision', providerId: 'p1', modelId: 'gemma-4',
	});

	const storage2 = createFakeStorage();
	const store2 = new ImageDescriptionStore(storage2, BASE_DIR);
	const r2 = await store2.put({
		md5: MD5_A, narrative: 'same narrative', extraction: 'same extraction',
		kind: 'imported', providerId: 'p2', modelId: 'a-different-model',
	});

	assert.equal(r1.descriptionHash, r2.descriptionHash);

	// A genuinely different pair hashes differently.
	const storage3 = createFakeStorage();
	const store3 = new ImageDescriptionStore(storage3, BASE_DIR);
	const r3 = await store3.put({ md5: MD5_A, narrative: 'different narrative', extraction: 'same extraction', kind: 'vision' });
	assert.notEqual(r1.descriptionHash, r3.descriptionHash);
});

test('combinedDescriptionHash: order-independent, stable, skips unknown md5s and dedupes, empty -> \'\'', async () => {
	const storage = createFakeStorage();
	const store = new ImageDescriptionStore(storage, BASE_DIR);
	await store.put({ md5: MD5_A, narrative: 'n-a', extraction: 'e-a', kind: 'vision' });
	await store.put({ md5: MD5_B, narrative: 'n-b', extraction: 'e-b', kind: 'vision' });

	const combinedAB = store.combinedDescriptionHash([MD5_A, MD5_B]);
	const combinedBA = store.combinedDescriptionHash([MD5_B, MD5_A]);
	assert.equal(combinedAB, combinedBA, 'order-independent');
	assert.notEqual(combinedAB, '');

	// Stable across repeated calls.
	assert.equal(store.combinedDescriptionHash([MD5_A, MD5_B]), combinedAB);

	// Unknown md5s are skipped, not erroring, and don't change the result vs. the known subset.
	const unknown = 'c'.repeat(32);
	assert.equal(store.combinedDescriptionHash([MD5_A, MD5_B, unknown]), combinedAB);
	assert.equal(store.combinedDescriptionHash([MD5_A, unknown]), store.combinedDescriptionHash([MD5_A]));

	// Duplicates collapse (unique) without changing the result.
	assert.equal(store.combinedDescriptionHash([MD5_A, MD5_A, MD5_B]), combinedAB);

	// Empty input, and input resolving to no known md5s, both hash to ''.
	assert.equal(store.combinedDescriptionHash([]), '');
	assert.equal(store.combinedDescriptionHash([unknown]), '');
});
