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

const { ImageDescriptionStore, IMAGE_DESCRIPTION_SCHEMA_VERSION, classifyFailure } = await import(pathToFileURL(outfile).href);

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

// ── idh-WP-1: kind:'failed' + failure field ─────────────────────────────────

test('put/get round-trip for kind:\'failed\' carries the failure message and empty narrative/extraction', async () => {
	const storage = createFakeStorage();
	const store = new ImageDescriptionStore(storage, BASE_DIR);

	const record = await store.put({
		md5: MD5_A,
		narrative: '',
		extraction: '',
		kind: 'failed',
		failure: 'timed out after 120000ms',
	});

	assert.equal(record.kind, 'failed');
	assert.equal(record.failure, 'timed out after 120000ms');
	assert.equal(record.narrative, '');
	assert.equal(record.extraction, '');
	// `has()` returning true for a failed record is the point — a later run skips the poison
	// image instead of retrying it forever.
	assert.equal(store.has(MD5_A), true);

	const fetched = await store.get(MD5_A);
	assert.deepEqual(fetched, record);
});

test('a persisted kind:\'failed\' record round-trips through a fresh store instance (validation accepts it)', async () => {
	const storage = createFakeStorage();
	const store1 = new ImageDescriptionStore(storage, BASE_DIR);
	await store1.put({ md5: MD5_A, narrative: '', extraction: '', kind: 'failed', failure: 'provider threw' });

	const store2 = new ImageDescriptionStore(storage, BASE_DIR);
	await store2.ensureLoaded();
	assert.equal(store2.has(MD5_A), true);
	const fetched = await store2.get(MD5_A);
	assert.equal(fetched.kind, 'failed');
	assert.equal(fetched.failure, 'provider threw');
});

test('a stored record with a non-string failure field is rejected as structurally malformed', async () => {
	const storage = createFakeStorage();
	storage.files.set(`${BASE_DIR}/${MD5_A}.json`, JSON.stringify({
		md5: MD5_A, narrative: '', extraction: '', kind: 'failed',
		describedAt: 'now', schemaVersion: IMAGE_DESCRIPTION_SCHEMA_VERSION, descriptionHash: 'h',
		failure: 12345, // must be a string
	}));
	const store = new ImageDescriptionStore(storage, BASE_DIR);

	await store.ensureLoaded();
	assert.equal(store.has(MD5_A), false);
	assert.equal(await store.get(MD5_A), null);
});

test('put omitting failure (kind !== \'failed\') round-trips with failure undefined', async () => {
	const storage = createFakeStorage();
	const store = new ImageDescriptionStore(storage, BASE_DIR);
	const record = await store.put({ md5: MD5_A, narrative: 'n', extraction: 'e', kind: 'vision' });
	assert.equal(record.failure, undefined);
});

// ── idh-WP-1: pruneDegenerate ────────────────────────────────────────────────

test('pruneDegenerate: deletes an oversized vision record, keeps healthy/svg-text/imported records, returns pruned md5s', async () => {
	const storage = createFakeStorage();
	const store = new ImageDescriptionStore(storage, BASE_DIR);

	const oversizedMd5 = 'c'.repeat(32);
	const healthyVisionMd5 = 'd'.repeat(32);
	const svgMd5 = 'e'.repeat(32);
	const importedMd5 = 'f'.repeat(32);

	await store.put({ md5: oversizedMd5, narrative: 'A degenerate repetition loop.', extraction: 'x'.repeat(20_001), kind: 'vision' });
	await store.put({ md5: healthyVisionMd5, narrative: 'A normal chart.', extraction: 'Q1: 10', kind: 'vision' });
	// An svg-text/imported record with equally long "extraction" text is not a runaway-generation
	// symptom (it reflects real source content) and must survive the prune.
	await store.put({ md5: svgMd5, narrative: '', extraction: 'y'.repeat(25_000), kind: 'svg-text' });
	await store.put({ md5: importedMd5, narrative: 'legacy', extraction: 'z'.repeat(25_000), kind: 'imported' });

	const pruned = await store.pruneDegenerate(20_000);

	assert.deepEqual(pruned, [oversizedMd5]);
	assert.equal(store.has(oversizedMd5), false, 'the oversized image falls out of has() and re-enters the pending set on the next backfill enumeration');
	assert.equal(await store.get(oversizedMd5), null);
	assert.equal(store.has(healthyVisionMd5), true);
	assert.equal(store.has(svgMd5), true);
	assert.equal(store.has(importedMd5), true);
});

test('pruneDegenerate: a vision record exactly at the threshold is kept (strictly greater-than only)', async () => {
	const storage = createFakeStorage();
	const store = new ImageDescriptionStore(storage, BASE_DIR);
	await store.put({ md5: MD5_A, narrative: 'n', extraction: 'x'.repeat(20_000), kind: 'vision' });

	const pruned = await store.pruneDegenerate(20_000);

	assert.deepEqual(pruned, []);
	assert.equal(store.has(MD5_A), true);
});

test('pruneDegenerate: an empty store prunes nothing', async () => {
	const storage = createFakeStorage();
	const store = new ImageDescriptionStore(storage, BASE_DIR);
	assert.deepEqual(await store.pruneDegenerate(20_000), []);
});

// ── idh-WP-2: classifyFailure ────────────────────────────────────────────────

test('classifyFailure: a withTimeout label -> transient', () => {
	assert.equal(classifyFailure('image description (narrative pass) timed out after 120000ms'), 'transient');
	assert.equal(classifyFailure('image description (extraction pass) timed out after 120000ms'), 'transient');
	assert.equal(classifyFailure('image transcode timed out after 30000ms'), 'transient');
});

test('classifyFailure: a net::ERR_* message -> transient, including variants beyond the breaker\'s specific trio', () => {
	assert.equal(classifyFailure('net::ERR_CONNECTION_REFUSED'), 'transient');
	assert.equal(classifyFailure('net::ERR_CONNECTION_RESET'), 'transient');
	assert.equal(classifyFailure('net::ERR_NETWORK_CHANGED'), 'transient');
	// A legacy record could carry a net::ERR_* variant the infra breaker doesn't specifically
	// abort on (it only aborts on the observed trio) — still transient by this broader match.
	assert.equal(classifyFailure('net::ERR_NAME_NOT_RESOLVED'), 'transient');
});

test('classifyFailure: everything else -> permanent, including undefined/empty', () => {
	assert.equal(classifyFailure('LM Studio image description API returned no choices'), 'permanent');
	assert.equal(classifyFailure('HTTP 500: internal server error'), 'permanent');
	assert.equal(classifyFailure(''), 'permanent');
	assert.equal(classifyFailure(undefined), 'permanent');
});

// ── idh-WP-2: failureClass field ──────────────────────────────────────────────

test('put/get round-trip for kind:\'failed\' carries failureClass, and omitting it round-trips undefined', async () => {
	const storage = createFakeStorage();
	const store = new ImageDescriptionStore(storage, BASE_DIR);

	const transientMd5 = 'c'.repeat(32);
	const legacyMd5 = 'd'.repeat(32);
	await store.put({ md5: transientMd5, narrative: '', extraction: '', kind: 'failed', failure: 'timed out after 120000ms', failureClass: 'transient' });
	await store.put({ md5: legacyMd5, narrative: '', extraction: '', kind: 'failed', failure: 'provider threw' }); // no failureClass — legacy shape

	const transientRecord = await store.get(transientMd5);
	assert.equal(transientRecord.failureClass, 'transient');

	const legacyRecord = await store.get(legacyMd5);
	assert.equal(legacyRecord.failureClass, undefined);
});

test('a stored record with an invalid failureClass value is rejected as structurally malformed', async () => {
	const storage = createFakeStorage();
	storage.files.set(`${BASE_DIR}/${MD5_A}.json`, JSON.stringify({
		md5: MD5_A, narrative: '', extraction: '', kind: 'failed',
		describedAt: 'now', schemaVersion: IMAGE_DESCRIPTION_SCHEMA_VERSION, descriptionHash: 'h',
		failureClass: 'sometimes', // must be 'transient' | 'permanent'
	}));
	const store = new ImageDescriptionStore(storage, BASE_DIR);

	await store.ensureLoaded();
	assert.equal(store.has(MD5_A), false);
	assert.equal(await store.get(MD5_A), null);
});

// ── idh-WP-2: pruneFailed ─────────────────────────────────────────────────────

test('pruneFailed(\'transient\'): removes only failed records classifying transient (explicit failureClass), leaves permanent-failed and non-failed records untouched', async () => {
	const storage = createFakeStorage();
	const store = new ImageDescriptionStore(storage, BASE_DIR);

	const transientMd5 = 'c'.repeat(32);
	const permanentMd5 = 'd'.repeat(32);
	const visionMd5 = 'e'.repeat(32);
	await store.put({ md5: transientMd5, narrative: '', extraction: '', kind: 'failed', failure: 'timed out after 120000ms', failureClass: 'transient' });
	await store.put({ md5: permanentMd5, narrative: '', extraction: '', kind: 'failed', failure: 'provider returned no choices', failureClass: 'permanent' });
	await store.put({ md5: visionMd5, narrative: 'n', extraction: 'e', kind: 'vision' });

	const pruned = await store.pruneFailed('transient');

	assert.deepEqual(pruned, [transientMd5]);
	assert.equal(store.has(transientMd5), false, 'transient-failed falls out of has() and re-enters pending');
	assert.equal(store.has(permanentMd5), true, 'permanent-failed is left alone — skip-forever stays correct');
	assert.equal(store.has(visionMd5), true, 'a real description is never touched by a failed-record prune');
});

test('pruneFailed(\'transient\'): a legacy failed record with no failureClass is classified lazily via classifyFailure', async () => {
	const storage = createFakeStorage();
	const store = new ImageDescriptionStore(storage, BASE_DIR);

	const legacyTimeoutMd5 = 'c'.repeat(32);
	const legacyNetMd5 = 'd'.repeat(32);
	const legacyPermanentMd5 = 'e'.repeat(32);
	// Simulate records written before idh-WP-2 (no failureClass at all).
	await store.put({ md5: legacyTimeoutMd5, narrative: '', extraction: '', kind: 'failed', failure: 'timed out after 120000ms' });
	await store.put({ md5: legacyNetMd5, narrative: '', extraction: '', kind: 'failed', failure: 'net::ERR_CONNECTION_REFUSED' });
	await store.put({ md5: legacyPermanentMd5, narrative: '', extraction: '', kind: 'failed', failure: 'provider returned no choices' });

	const pruned = await store.pruneFailed('transient');

	assert.deepEqual(pruned.sort(), [legacyNetMd5, legacyTimeoutMd5].sort());
	assert.equal(store.has(legacyPermanentMd5), true);
});

test('pruneFailed(\'all\'): removes every failed record regardless of classification, still leaves non-failed records untouched', async () => {
	const storage = createFakeStorage();
	const store = new ImageDescriptionStore(storage, BASE_DIR);

	const transientMd5 = 'c'.repeat(32);
	const permanentMd5 = 'd'.repeat(32);
	const visionMd5 = 'e'.repeat(32);
	await store.put({ md5: transientMd5, narrative: '', extraction: '', kind: 'failed', failure: 'timed out after 120000ms', failureClass: 'transient' });
	await store.put({ md5: permanentMd5, narrative: '', extraction: '', kind: 'failed', failure: 'provider returned no choices', failureClass: 'permanent' });
	await store.put({ md5: visionMd5, narrative: 'n', extraction: 'e', kind: 'vision' });

	const pruned = await store.pruneFailed('all');

	assert.deepEqual(pruned.sort(), [permanentMd5, transientMd5].sort());
	assert.equal(store.has(visionMd5), true);
});

test('pruneFailed: an empty store prunes nothing', async () => {
	const storage = createFakeStorage();
	const store = new ImageDescriptionStore(storage, BASE_DIR);
	assert.deepEqual(await store.pruneFailed('transient'), []);
	assert.deepEqual(await store.pruneFailed('all'), []);
});

// ── idh-WP-2: store load tolerates + deletes corrupt (zero-byte/unparseable) files ────────────

test('ensureLoaded: a zero-byte record file is skipped, and the corrupt file is deleted from storage', async () => {
	const storage = createFakeStorage();
	storage.files.set(`${BASE_DIR}/${MD5_A}.json`, ''); // zero-byte — JSON.parse('') throws
	const store = new ImageDescriptionStore(storage, BASE_DIR);

	await store.ensureLoaded();

	assert.equal(store.has(MD5_A), false);
	assert.equal(storage.files.has(`${BASE_DIR}/${MD5_A}.json`), false, 'the corrupt file is deleted, not left to warn forever on every future load');
});

test('ensureLoaded: an unparseable record file is skipped, and the corrupt file is deleted from storage', async () => {
	const storage = createFakeStorage();
	storage.files.set(`${BASE_DIR}/${MD5_A}.json`, 'not json{{{');
	const store = new ImageDescriptionStore(storage, BASE_DIR);

	await store.ensureLoaded();

	assert.equal(store.has(MD5_A), false);
	assert.equal(storage.files.has(`${BASE_DIR}/${MD5_A}.json`), false);
});

test('ensureLoaded: a structurally malformed (valid-JSON) record file is skipped, and the corrupt file is deleted from storage', async () => {
	const storage = createFakeStorage();
	storage.files.set(`${BASE_DIR}/${MD5_A}.json`, JSON.stringify({ md5: MD5_A, narrative: 'n' })); // missing required fields
	const store = new ImageDescriptionStore(storage, BASE_DIR);

	await store.ensureLoaded();

	assert.equal(store.has(MD5_A), false);
	assert.equal(storage.files.has(`${BASE_DIR}/${MD5_A}.json`), false);
});

test('ensureLoaded: corrupt-file deletion does not disturb a healthy record loaded in the same sweep', async () => {
	const storage = createFakeStorage();
	storage.files.set(`${BASE_DIR}/${MD5_A}.json`, ''); // corrupt
	const store1 = new ImageDescriptionStore(storage, BASE_DIR);
	await store1.put({ md5: MD5_B, narrative: 'n', extraction: 'e', kind: 'vision' }); // healthy, same storage

	const store2 = new ImageDescriptionStore(storage, BASE_DIR);
	await store2.ensureLoaded();

	assert.equal(store2.has(MD5_A), false);
	assert.equal(store2.has(MD5_B), true);
	assert.equal(storage.files.has(`${BASE_DIR}/${MD5_A}.json`), false);
	assert.equal(storage.files.has(`${BASE_DIR}/${MD5_B}.json`), true);
});

test('a corrupt record is NOT deleted by a per-md5 get() (deletion is scoped to the load() sweep)', async () => {
	// get() only reaches readRecord for an md5 already in the index (has() true), so a corrupt
	// file that was never indexed (e.g. written directly, bypassing put()) simply returns null —
	// there is no code path where get() deletes a file. This documents that scoping explicitly.
	const storage = createFakeStorage();
	const store = new ImageDescriptionStore(storage, BASE_DIR);
	await store.put({ md5: MD5_A, narrative: 'n', extraction: 'e', kind: 'vision' });
	// Corrupt the file on disk after put() succeeded but without going through the store again.
	storage.files.set(`${BASE_DIR}/${MD5_A}.json`, 'not json{{{');

	const fetched = await store.get(MD5_A);

	assert.equal(fetched, null);
	// The index still (stale-)believes it's present; the point of this test is only that get()
	// itself does not reach into storage.remove.
	assert.equal(storage.files.has(`${BASE_DIR}/${MD5_A}.json`), true);
});
