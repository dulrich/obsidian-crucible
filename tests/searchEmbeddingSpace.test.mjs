// Embedding-space identity: the migration that must cost nothing, the coverage rule that must
// notice a precision change, the upsert guard, and — the one with teeth — the vector scan's
// space filter.
//
// Every failure these cover is silent. There is no error anywhere today when an ONNX-fp32 index
// and a GGUF-Q4 re-index are treated as one vector space: the model id matches, the width
// matches (bge-m3 is 1024d under every quantization), and the scan never looked at either. So
// each case asserts the *absence* of the wrong behaviour as much as the presence of the right
// one — a migration that quietly re-embeds 5,449 chunks and a scan that quietly mixes two spaces
// both look like success from the outside.
//
// Companion cases build their own in-memory SQLite database and bind an ephemeral loopback port
// of their own; nothing here touches the live companion on 127.0.0.1:4801 or its real index.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

import {
	BACKFILL_EMBEDDING_SPACE_SQL,
	createRequestHandler,
	createSchema,
	createVectorBackend,
	encodeEmbedding,
	normalizeEmbedding,
	resolveScanSpace,
	SCHEMA_VERSION,
} from '../scripts/search-companion.mjs';

const VAULT = 'test-vault';

// bge-m3's width, and the whole point of seeding both spaces at it: at any other width the
// pre-existing dimension guard would reject or skip the mix before the space filter was ever
// asked a question, and the test would pass while testing nothing.
const WIDTH = 1024;

// ── Harnesses ────────────────────────────────────────────────────────────────────────────

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-embedding-space-tests');
const managerOutfile = path.join(outdir, 'SearchManager.mjs');
const typesOutfile = path.join(outdir, 'types.mjs');
const chunkerOutfile = path.join(outdir, 'chunker.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// `requestUrl` really talks to the ephemeral companion below rather than replaying a canned
// payload: the migration case has to prove the *round trip* is a no-op — real client, real
// /v1/files/state, real migrated database — because a stubbed response could only ever confirm
// what the stub was told to say.
const obsidianStub = {
	name: 'obsidian-test-stub',
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
			contents: `
				export class App {}
				export class FileSystemAdapter {}
				export class Notice { constructor() {} }
				export function normalizePath(path) { return path; }
				export async function requestUrl(options) {
					const response = await fetch(options.url, {
						method: options.method,
						headers: options.headers,
						body: options.body,
					});
					const text = await response.text();
					let json;
					try { json = JSON.parse(text); } catch { json = undefined; }
					return { status: response.status, text, json };
				}
			`,
			loader: 'js',
		}));
	},
};

for (const [entry, outfile] of [
	['src/search/SearchManager.ts', managerOutfile],
	['src/search/types.ts', typesOutfile],
	['src/search/chunker.ts', chunkerOutfile],
]) {
	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'es2020',
		plugins: [obsidianStub],
		outfile,
		logLevel: 'silent',
	});
}

const { SearchManager } = await import(pathToFileURL(managerOutfile));
const {
	deriveEmbeddingSpaceIdPrefill,
	embeddingSpaceId,
	isPathShapedModelId,
	normalizePathShapedModelId,
	resolveEmbeddingSpaceModelId,
	SEARCH_REQUIRED_SCHEMA_VERSION,
} = await import(pathToFileURL(typesOutfile));
const { hashSearchContent } = await import(pathToFileURL(chunkerOutfile));

function makeDb() {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	return db;
}

async function withServer(db, fn) {
	const server = createServer(createRequestHandler(db));
	await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = async (method, requestPath, body) => {
		const response = await fetch(`${base}${requestPath}`, {
			method,
			headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, json: await response.json() };
	};
	try {
		return await fn(call, base);
	} finally {
		await new Promise(resolveClose => server.close(resolveClose));
	}
}

// A one-hot 1024-d vector. Two chunks built from different axes are orthogonal, so a query on
// one axis can only be answered by the chunk that shares it — which makes "the wrong space's
// chunk came back" impossible to mistake for a ranking wobble.
function axisVector(axis) {
	const values = new Array(WIDTH).fill(0);
	values[axis % WIDTH] = 1;
	return values;
}

const INSERT_CHUNK_SQL = `INSERT INTO chunks
(id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model, embedding_space)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Seeds a vector row straight through SQL, bypassing /v1/chunks/upsert *on purpose*: the upsert
// guard now refuses a second space in one vault, so a mixed index can no longer be built through
// the API at all. The scan filter is the defence for a database that arrived mixed anyway —
// written before the guard existed, restored from an older snapshot — so the test has to
// manufacture that state directly.
function seedVector(db, { id, path: chunkPath, text, values, model, space, vaultId = VAULT }) {
	const floats = normalizeEmbedding(values);
	db.prepare(INSERT_CHUNK_SQL).run(
		id, vaultId, chunkPath, `hash-${chunkPath}`, chunkPath.replace(/\.md$/, ''), '', text, 0, 0, '{}',
		encodeEmbedding(floats), floats.length, model ?? null, space ?? null,
	);
	db.prepare('INSERT INTO chunks_fts (id, vault_id, path, title, heading, text) VALUES (?, ?, ?, ?, ?, ?)')
		.run(id, vaultId, chunkPath, chunkPath.replace(/\.md$/, ''), '', text);
}

// ── 1. The migration is a no-op: nothing re-embeds ───────────────────────────────────────

// The exact schema-3 `chunks` table, pinned here rather than derived, because the migration's
// whole job is to bring *this* shape forward. Deriving it from the current CREATE TABLE would
// make the test vacuous the moment the column was added to it.
const SCHEMA_3_CHUNKS_SQL = `CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  heading TEXT NOT NULL,
  text TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  embedding BLOB,
  embedding_dim INTEGER,
  embedding_model TEXT
)`;

const SCHEMA_3_FTS_SQL = `CREATE VIRTUAL TABLE chunks_fts USING fts5(
  id UNINDEXED, vault_id UNINDEXED, path UNINDEXED, title, heading, text, prefix='2 3'
)`;

// Builds a database in the shape the live index is in right now: schema 3, embeddings present,
// every one stamped with a model id, no `embedding_space` column at all.
function makeSchema3Db({ model = 'bge-m3', contentHash = 'hash-note', unlabelled = false } = {}) {
	const db = new DatabaseSync(':memory:');
	db.exec(`${SCHEMA_3_CHUNKS_SQL};${SCHEMA_3_FTS_SQL};`);
	const insert = db.prepare(`INSERT INTO chunks
(id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	for (const [ordinal, id] of ['legacy-0', 'legacy-1'].entries()) {
		const floats = normalizeEmbedding(axisVector(ordinal));
		insert.run(id, VAULT, 'note.md', contentHash, 'note', '', `body ${ordinal}`, 0, ordinal, '{}',
			encodeEmbedding(floats), floats.length, unlabelled ? null : model);
	}
	// An unembedded row: the migration must not invent a space for a chunk that has no vector.
	insert.run('plain-0', VAULT, 'plain.md', 'hash-plain', 'plain', '', 'no vector here', 0, 0, '{}', null, null, null);
	return db;
}

test('the schema-3 → 4 migration backfills the space from the model id and leaves everything else alone', () => {
	const db = makeSchema3Db();
	assert.equal(db.prepare('PRAGMA table_info(chunks)').all().some(row => row.name === 'embedding_space'), false);

	createSchema(db);

	// node:sqlite hands back null-prototype rows; re-shape so the comparison is about values.
	const rows = db.prepare('SELECT id, embedding_model AS model, embedding_space AS space FROM chunks ORDER BY id')
		.all()
		.map(row => ({ id: row.id, model: row.model, space: row.space }));
	assert.deepEqual(rows, [
		{ id: 'legacy-0', model: 'bge-m3', space: 'bge-m3' },
		{ id: 'legacy-1', model: 'bge-m3', space: 'bge-m3' },
		// No vector, so no space: a chunk that was never embedded must not acquire an identity it
		// cannot back up, or /v1/files/state would count it as attributed.
		{ id: 'plain-0', model: null, space: null },
	]);
	// The backfill is idempotent: a second startup rewrites nothing.
	db.exec(BACKFILL_EMBEDDING_SPACE_SQL);
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE embedding_space = 'bge-m3'").get().n, 2);
	// The same startup also carried this schema-3 fixture through the 4 -> 5 primary-key
	// rebuild. The fixture above deliberately keeps `id TEXT PRIMARY KEY`, so asserting the
	// composite key here is the check that a real pre-schema-5 index arrives keyed by vault.
	assert.match(
		db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks'").get().sql,
		/PRIMARY KEY \(vault_id, id\)/,
	);
	db.close();
});

test('vectors with no model attribution stay unattributed through the migration rather than getting a fabricated space', () => {
	const db = makeSchema3Db({ unlabelled: true });
	createSchema(db);
	assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding_space IS NOT NULL').get().n, 0);
	db.close();
});

test('after the migration, an already-embedded vault is still fully covered: nothing re-embeds', async () => {
	const content = '# Note\n\nBody of the note.';
	const db = makeSchema3Db({ contentHash: hashSearchContent(content) });
	createSchema(db);

	await withServer(db, async (call, base) => {
		// The companion's own answer first: one space, backfilled from the model id.
		const state = await call('POST', '/v1/files/state', { vaultId: VAULT, paths: ['note.md'] });
		const note = state.json.files.find(entry => entry.path === 'note.md');
		assert.equal(note.hasEmbeddings, true);
		assert.equal(note.embeddingModel, 'bge-m3');
		assert.equal(note.embeddingSpace, 'bge-m3');

		// And the client's: the space it derives for a runtime that reports no precision is the
		// bare model id, which is exactly what the migration wrote. If either side drifted, this
		// would re-index — silently, and for all 5,449 chunks of the real index.
		const upserted = [];
		const manager = makeManager({
			base,
			contentByPath: new Map([['note.md', content]]),
			onUpsert: chunks => upserted.push(chunks),
			// Infinity's answer, and therefore the live one.
			describeModel: async () => ({ servedModel: 'bge-m3', precision: undefined, fingerprint: 'optimum' }),
		});

		const result = await manager.indexFiles([makeFile('note.md')]);
		assert.equal(result.files, 0, 'a migrated index must not re-embed a single file');
		assert.equal(upserted.length, 0);

		// The other direction, against the same migrated database, so the skip above is known to
		// be space-driven rather than vacuously true: the moment the runtime reports a precision,
		// the stored `bge-m3` space stops matching `bge-m3/f16` and the file is re-indexed.
		const rebuilt = [];
		const switched = makeManager({
			base,
			contentByPath: new Map([['note.md', content]]),
			onUpsert: chunks => rebuilt.push(chunks),
			describeModel: async () => ({ precision: 'f16' }),
		});
		assert.equal((await switched.indexFiles([makeFile('note.md')])).files, 1);
		assert.equal(rebuilt[0][0].embeddingSpace, 'bge-m3/f16');
	});
	db.close();
});

test('SCHEMA_VERSION and SEARCH_REQUIRED_SCHEMA_VERSION move together, or an older binary silently mixes spaces', () => {
	assert.equal(SCHEMA_VERSION, 7);
	assert.equal(SEARCH_REQUIRED_SCHEMA_VERSION, SCHEMA_VERSION);
});

// ── 2. The space id itself ───────────────────────────────────────────────────────────────

test('an unknown precision yields the bare model id — never "undefined", never a trailing slash', () => {
	// This is the Infinity path, i.e. the live one, and it is also what makes the migration free.
	assert.equal(embeddingSpaceId('bge-m3', undefined), 'bge-m3');
	assert.equal(embeddingSpaceId('bge-m3'), 'bge-m3');
	assert.equal(embeddingSpaceId('bge-m3', ''), 'bge-m3');
	assert.equal(embeddingSpaceId('bge-m3', '   '), 'bge-m3');
	for (const space of [embeddingSpaceId('bge-m3', undefined), embeddingSpaceId('bge-m3', '')]) {
		assert.equal(space.includes('undefined'), false);
		assert.equal(space.endsWith('/'), false);
	}
	// And a known one is model + precision, one separator, nothing else.
	assert.equal(embeddingSpaceId('bge-m3', 'f16'), 'bge-m3/f16');
	assert.equal(embeddingSpaceId('  bge-m3  ', '  q4_k_m  '), 'bge-m3/q4_k_m');
});

// ── 2b. Portable space keys (WP-5 / old plan WP-1) ────────────────────────────────────────

test('isPathShapedModelId: an absolute mount path or a weights-file extension trips it, a plain served id or a Hub-style org/repo id does not', () => {
	// The exact live incident string.
	assert.equal(isPathShapedModelId('/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf'), true);
	// A relative mount / bare filename some configs report — the extension alone is sufficient.
	assert.equal(isPathShapedModelId('bge-m3-f16.gguf'), true);
	for (const ext of ['bin', 'safetensors', 'onnx', 'pt', 'pth', 'ggml']) {
		assert.equal(isPathShapedModelId(`weights.${ext}`), true, ext);
	}
	// A plain served id: no slash, no weights extension.
	assert.equal(isPathShapedModelId('bge-m3'), false);
	// Hugging Face Hub org/repo shorthand — a real, portable model id that happens to contain a
	// slash, and what the live index holds today. Must NOT be treated as path-shaped.
	assert.equal(isPathShapedModelId('BAAI/bge-m3'), false);
	assert.equal(isPathShapedModelId(''), false);
	assert.equal(isPathShapedModelId('   '), false);
});

test('normalizePathShapedModelId: basename, weights extension stripped', () => {
	assert.equal(normalizePathShapedModelId('/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf'), 'bge-m3-f16');
	assert.equal(normalizePathShapedModelId('bge-m3-f16.gguf'), 'bge-m3-f16');
	// A non-path id passed in anyway (callers are expected to check isPathShapedModelId first, but
	// this must still be a safe no-op): no slash, no weights extension to strip.
	assert.equal(normalizePathShapedModelId('BAAI/bge-m3'), 'bge-m3');
	assert.equal(normalizePathShapedModelId('bge-m3'), 'bge-m3');
});

test('resolveEmbeddingSpaceModelId: explicit embeddingSpaceId wins over path normalization, which wins over the raw id; empty reproduces the raw id byte-for-byte', () => {
	// The no-re-embed guarantee: nothing set anywhere, byte-for-byte the model id.
	assert.equal(resolveEmbeddingSpaceModelId({ id: 'bge-m3' }), 'bge-m3');
	// A path-shaped served id, no override: basename-keyed.
	assert.equal(
		resolveEmbeddingSpaceModelId({ id: '/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf' }),
		'bge-m3-f16',
	);
	// An explicit override wins even when the raw id is ALSO path-shaped — the whole point of the
	// field is to let the user override an inference that would otherwise apply.
	assert.equal(
		resolveEmbeddingSpaceModelId({ id: '/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf', embeddingSpaceId: 'bge-m3' }),
		'bge-m3',
	);
	// An explicit override on a perfectly ordinary served id also wins outright.
	assert.equal(resolveEmbeddingSpaceModelId({ id: 'bge-m3', embeddingSpaceId: 'custom-space' }), 'custom-space');
	// Blank/whitespace-only override is not a real override — falls through exactly as if unset.
	assert.equal(resolveEmbeddingSpaceModelId({ id: 'bge-m3', embeddingSpaceId: '   ' }), 'bge-m3');
});

test('deriveEmbeddingSpaceIdPrefill (WP-5 UI half): prefills only a path-shaped pick into an empty field, never overwrites', () => {
	// Path-shaped pick, empty field: prefilled.
	assert.equal(
		deriveEmbeddingSpaceIdPrefill('/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf', undefined),
		'bge-m3-f16',
	);
	assert.equal(deriveEmbeddingSpaceIdPrefill('/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf', ''), 'bge-m3-f16');
	// A plain served id, even a Hub-style one containing a slash: nothing to prefill.
	assert.equal(deriveEmbeddingSpaceIdPrefill('bge-m3', undefined), undefined);
	assert.equal(deriveEmbeddingSpaceIdPrefill('BAAI/bge-m3', undefined), undefined);
	// A value already present — user-typed, or an earlier pick's prefill — is never overwritten,
	// even by a second path-shaped pick.
	assert.equal(deriveEmbeddingSpaceIdPrefill('/models/other/bge-m3-q4.gguf', 'user-typed-value'), undefined);
	assert.equal(deriveEmbeddingSpaceIdPrefill('/models/other/bge-m3-q4.gguf', 'bge-m3-f16'), undefined);
	// Whitespace-only current value is not really "present" — treated as empty, so it still fires.
	assert.equal(deriveEmbeddingSpaceIdPrefill('/models/other/bge-m3-q4.gguf', '   '), 'bge-m3-q4');
});

// ── SearchManager harness ────────────────────────────────────────────────────────────────

function settings(overrides = {}) {
	return {
		excludedFolders: [],
		providers: [{
			id: 'local',
			name: 'Local',
			kind: 'openai-compatible',
			models: [{ id: 'bge-m3', label: 'bge-m3', ...(overrides.modelExtras ?? {}) }],
		}],
		searchVaultId: VAULT,
		searchServiceUrl: 'http://127.0.0.1:4899',
		searchSemanticEnabled: true,
		searchEmbeddingModel: { providerId: 'local', modelId: 'bge-m3' },
		searchChunkMaxChars: 1800,
		searchChunkOverlapChars: 200,
		searchIndexBatchSize: 24,
		searchResultLimit: 12,
		...overrides,
	};
}

function makeFile(filePath) {
	const name = filePath.split('/').pop();
	const extension = name.split('.').pop();
	return { path: filePath, basename: name.slice(0, -(extension.length + 1)), extension, stat: { mtime: 123 } };
}

// `base` (a live companion) and `fileStates` (a canned map) are alternatives: the migration case
// needs the real round trip, the coverage cases only need one stored state.
// `modelId` (WP-5) is the id BOTH the provider's catalog entry and `searchEmbeddingModel`'s ref
// carry — it defaults to 'bge-m3' so every pre-WP-5 call site is unaffected, and a test that
// needs a path-shaped served id passes it here rather than juggling `modelExtras.id` and a
// separately-overridden ref by hand.
function makeManager({ base, contentByPath = new Map(), fileStates, onUpsert = () => {}, describeModel, modelExtras, modelId = 'bge-m3' } = {}) {
	const app = {
		metadataCache: { isUserIgnored: () => false },
		vault: { read: async (file) => contentByPath.get(file.path) ?? '' },
	};
	const providerManager = {
		embed: async (_provider, _modelId, inputs) => ({ embeddings: inputs.map(() => axisVector(0)), dimensions: WIDTH }),
		...(describeModel ? { describeModel } : {}),
	};
	const manager = new SearchManager(app, settings({
		searchServiceUrl: base ?? 'http://127.0.0.1:4899',
		modelExtras: { id: modelId, ...(modelExtras ?? {}) },
		searchEmbeddingModel: { providerId: 'local', modelId },
	}), providerManager);
	if (!base) {
		manager.client = () => ({
			fileStates: async () => fileStates ?? new Map(),
			upsertChunks: async (chunks) => onUpsert(chunks),
		});
	} else {
		const real = manager.client();
		manager.client = () => ({
			fileStates: (paths) => real.fileStates(paths),
			upsertChunks: async (chunks) => onUpsert(chunks),
		});
	}
	return manager;
}

function storedState(filePath, content, space) {
	return new Map([[filePath, {
		path: filePath,
		contentHash: hashSearchContent(content),
		hasEmbeddings: true,
		embeddingModel: 'bge-m3',
		...(space === undefined ? {} : { embeddingSpace: space }),
	}]]);
}

// ── 3. Coverage compares the space, not the model id ─────────────────────────────────────

test('the same model at a different precision is NOT covered — the case width and model id both miss', async () => {
	const file = makeFile('quantized.md');
	const content = '# Quantized\n\nBody';
	const upserted = [];
	const manager = makeManager({
		contentByPath: new Map([[file.path, content]]),
		// Stored under fp32; the runtime now reports f16. Identical model id, identical 1024
		// width — every other guard in the system passes this through.
		fileStates: storedState(file.path, content, 'bge-m3/fp32'),
		onUpsert: chunks => upserted.push(chunks),
		describeModel: async () => ({ precision: 'f16' }),
	});

	assert.equal((await manager.indexFiles([file])).files, 1);
	assert.equal(upserted[0][0].embeddingSpace, 'bge-m3/f16');
	// The model id is still recorded — it answers a different question and stays useful.
	assert.equal(upserted[0][0].embeddingModel, 'bge-m3');
});

test('a companion that reports no space at all counts as uncovered, not as covered', async () => {
	const file = makeFile('unknown-space.md');
	const content = '# Unknown\n\nBody';
	const upserted = [];
	const manager = makeManager({
		contentByPath: new Map([[file.path, content]]),
		// Fully embedded under the right model, but the space is unknown (an older companion, or
		// vectors written before the column existed and not yet migrated).
		fileStates: storedState(file.path, content, undefined),
		onUpsert: chunks => upserted.push(chunks),
	});
	assert.equal((await manager.indexFiles([file])).files, 1);
	assert.equal(upserted.length, 1);
});

test('a probed precision beats a declared variant; a declared variant is used when the probe is silent', async () => {
	const file = makeFile('variant.md');
	const content = '# Variant\n\nBody';

	// Probe wins.
	const probed = [];
	const withProbe = makeManager({
		contentByPath: new Map([[file.path, content]]),
		fileStates: new Map(),
		onUpsert: chunks => probed.push(chunks),
		describeModel: async () => ({ precision: 'F16' }),
		modelExtras: { embeddingVariant: 'q4_k_m' },
	});
	await withProbe.indexFiles([file]);
	// …and both sides go through the one normalizer, so `F16` is `f16`.
	assert.equal(probed[0][0].embeddingSpace, 'bge-m3/f16');

	// Probe silent (Infinity, vLLM, TEI, plain llama.cpp): the declared fallback carries it, also
	// normalized, so a hand-typed `Q4_K_M` cannot split the index from a probed `q4_k_m`.
	const declared = [];
	const withoutProbe = makeManager({
		contentByPath: new Map([[file.path, content]]),
		fileStates: new Map(),
		onUpsert: chunks => declared.push(chunks),
		describeModel: async () => ({ precision: undefined }),
		modelExtras: { embeddingVariant: 'Q4_K_M' },
	});
	await withoutProbe.indexFiles([file]);
	assert.equal(declared[0][0].embeddingSpace, 'bge-m3/q4_k_m');

	// A probe that throws is a clean unknown, never an error and never a guess.
	const failed = [];
	const brokenProbe = makeManager({
		contentByPath: new Map([[file.path, content]]),
		fileStates: new Map(),
		onUpsert: chunks => failed.push(chunks),
		describeModel: async () => { throw new Error('metadata endpoint unreachable'); },
	});
	await brokenProbe.indexFiles([file]);
	assert.equal(failed[0][0].embeddingSpace, 'bge-m3');
});

// ── 3b. Portable space keys through the real SearchManager path (WP-5) ───────────────────

test('a path-shaped served id (a container mount path) keys the space on its normalized basename, not the full path', async () => {
	const file = makeFile('mount-path.md');
	const content = '# Mount path\n\nBody';
	const upserted = [];
	// The exact live-incident string: "Fetch Models" populating a llama-server mount path.
	const manager = makeManager({
		contentByPath: new Map([[file.path, content]]),
		fileStates: new Map(),
		onUpsert: chunks => upserted.push(chunks),
		modelId: '/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf',
	});
	assert.equal((await manager.indexFiles([file])).files, 1);
	assert.equal(upserted[0][0].embeddingSpace, 'bge-m3-f16');
	// The REQUEST still carries the full path — this is a space-key-only normalization, never
	// applied to what is sent to the provider.
	assert.equal(upserted[0][0].embeddingModel, '/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf');
});

test('an explicit ProviderModel.embeddingSpaceId wins over both the path normalization and the raw id', async () => {
	const file = makeFile('explicit-space.md');
	const content = '# Explicit space\n\nBody';

	// Wins even when the served id is ALSO path-shaped.
	const overPathShaped = [];
	const managerA = makeManager({
		contentByPath: new Map([[file.path, content]]),
		fileStates: new Map(),
		onUpsert: chunks => overPathShaped.push(chunks),
		modelId: '/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf',
		modelExtras: { embeddingSpaceId: 'bge-m3' },
	});
	assert.equal((await managerA.indexFiles([file])).files, 1);
	assert.equal(overPathShaped[0][0].embeddingSpace, 'bge-m3');

	// Wins over a perfectly ordinary served id too.
	const overPlainId = [];
	const managerB = makeManager({
		contentByPath: new Map([[file.path, content]]),
		fileStates: new Map(),
		onUpsert: chunks => overPlainId.push(chunks),
		modelExtras: { embeddingSpaceId: 'custom-space' },
	});
	assert.equal((await managerB.indexFiles([file])).files, 1);
	assert.equal(overPlainId[0][0].embeddingSpace, 'custom-space');
});

test('an empty (unset) embeddingSpaceId on a non-path-shaped id reproduces today\'s key byte-for-byte — the no-re-embed guarantee', async () => {
	const file = makeFile('unset-space.md');
	const content = '# Unset\n\nBody';
	const upserted = [];
	const manager = makeManager({
		contentByPath: new Map([[file.path, content]]),
		fileStates: new Map(),
		onUpsert: chunks => upserted.push(chunks),
		// No embeddingSpaceId, no path-shaped id, no precision: exactly today's `bge-m3`.
	});
	assert.equal((await manager.indexFiles([file])).files, 1);
	assert.equal(upserted[0][0].embeddingSpace, 'bge-m3');
});

test('with semantic off the space leaves the skip condition entirely, exactly as the model id did', async () => {
	const file = makeFile('fts-only.md');
	const content = '# FTS only\n\nBody';
	const upserted = [];
	const manager = makeManager({
		contentByPath: new Map([[file.path, content]]),
		fileStates: storedState(file.path, content, undefined),
		onUpsert: chunks => upserted.push(chunks),
	});
	manager.settings.searchSemanticEnabled = false;
	// No vectors are part of the contract, so an unembedded, space-less path is still up to date.
	assert.equal((await manager.indexFiles([file])).files, 0);
	assert.equal(upserted.length, 0);
});

// ── 4. The upsert guard: 4xx, never 5xx ──────────────────────────────────────────────────

test('a second embedding space in one vault is refused at upsert with 4xx — never 5xx, which reads as "the container is down"', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const chunkFor = (id, chunkPath, space) => ({
			id,
			vaultId: VAULT,
			path: chunkPath,
			contentHash: `hash-${id}`,
			title: chunkPath,
			heading: '',
			text: `body of ${id}`,
			mtime: 0,
			ordinal: 0,
			metadata: {},
			embedding: axisVector(0),
			embeddingModel: 'bge-m3',
			embeddingSpace: space,
		});

		assert.equal((await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks: [chunkFor('a', 'A.md', 'bge-m3/fp32')] })).status, 200);

		// Same model, same 1024 width, different precision. The width guard cannot see this.
		const conflict = await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks: [chunkFor('b', 'B.md', 'bge-m3/q4_k_m')] });
		assert.equal(conflict.status, 400);
		assert.notEqual(conflict.status, 500);
		assert.match(conflict.json.error, /embedding space/i);

		// Refused atomically: the conflicting batch left nothing behind.
		assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?').get(VAULT).n), 1);

		// The same path re-embedded into a new space is allowed — its own rows are cleared first,
		// so nothing survives to be mixed with. That is how a deliberate re-index proceeds.
		assert.equal((await call('POST', '/v1/chunks/upsert', { vaultId: VAULT, chunks: [chunkFor('a', 'A.md', 'bge-m3/q4_k_m')] })).status, 200);
		assert.equal(db.prepare('SELECT embedding_space AS space FROM chunks WHERE id = ?').get('a').space, 'bge-m3/q4_k_m');

		// A different vault is a different index and none of this vault's business.
		assert.equal((await call('POST', '/v1/chunks/upsert', {
			vaultId: 'other-vault',
			chunks: [{ ...chunkFor('c', 'C.md', 'nomic-embed-text'), vaultId: 'other-vault' }],
		})).status, 200);
	});
	db.close();
});

test('a chunk sent with no space is stored under its model id, so an older client cannot create a phantom second space', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const response = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [{
				id: 'a', vaultId: VAULT, path: 'A.md', contentHash: 'h', title: 'A', heading: '',
				text: 'body', mtime: 0, ordinal: 0, metadata: {},
				embedding: axisVector(0), embeddingModel: 'bge-m3',
			}],
		});
		assert.equal(response.status, 200);
		assert.equal(db.prepare('SELECT embedding_space AS space FROM chunks WHERE id = ?').get('a').space, 'bge-m3');
	});
	db.close();
});

// ── 5. The scan filters by space — the fix with teeth ────────────────────────────────────

// Two spaces, one vault, both 1024-d, orthogonal vectors so provenance is unambiguous.
function makeMixedSpaceDb() {
	const db = makeDb();
	seedVector(db, { id: 'fp32-a', path: 'Fp32.md', text: 'alpha prose', values: axisVector(0), model: 'bge-m3', space: 'bge-m3/fp32' });
	seedVector(db, { id: 'q4-a', path: 'Q4.md', text: 'beta prose', values: axisVector(1), model: 'bge-m3', space: 'bge-m3/q4_k_m' });
	return db;
}

test('the vector scan returns only the querying space, even though the other space is the same model at the same width', async () => {
	const db = makeMixedSpaceDb();
	await withServer(db, async call => {
		// A query that matches no text at all, so every result present is a vector result.
		const fp32 = await call('POST', '/v1/search', {
			vaultId: VAULT,
			query: 'zzzznothingmatchesthis',
			limit: 10,
			queryEmbedding: axisVector(0),
			embeddingSpace: 'bge-m3/fp32',
		});
		assert.equal(fp32.status, 200);
		assert.deepEqual(fp32.json.results.map(row => row.path), ['Fp32.md']);
		assert.equal(fp32.json.mode, 'hybrid');

		// The query vector is a perfect match for its own space and orthogonal to the other, so
		// an unfiltered scan would have returned Q4.md at cosine 0 — present, and ranked.
		const q4 = await call('POST', '/v1/search', {
			vaultId: VAULT,
			query: 'zzzznothingmatchesthis',
			limit: 10,
			queryEmbedding: axisVector(1),
			embeddingSpace: 'bge-m3/q4_k_m',
		});
		assert.deepEqual(q4.json.results.map(row => row.path), ['Q4.md']);

		// Scanning a space is honest about being partial rather than pretending to be whole.
		assert.match(fp32.json.message, /2 embedding spaces/);
		assert.match(fp32.json.message, /bge-m3\/fp32/);
	});
	db.close();
});

test('the backend filters in SQL, so vectors from another space never enter the matrix at all', () => {
	const db = makeMixedSpaceDb();
	const backend = createVectorBackend(db);
	assert.deepEqual(backend.knn(VAULT, axisVector(0), 10, 'bge-m3/fp32').map(hit => hit.id), ['fp32-a']);
	assert.deepEqual(backend.knn(VAULT, axisVector(0), 10, 'bge-m3/q4_k_m').map(hit => hit.id), ['q4-a']);
	// Unfiltered is still the whole vault — the filter is a caller's decision, not the backend's.
	assert.equal(backend.knn(VAULT, axisVector(0), 10).length, 2);
	const stats = backend.stats(VAULT);
	assert.deepEqual(stats.spaces, ['bge-m3/fp32', 'bge-m3/q4_k_m']);
	assert.equal(stats.count, 2);
	assert.equal(backend.stats(VAULT, 'bge-m3/fp32').count, 1);
	db.close();
});

test('the matrix cache is keyed by space: a query in one space is never answered from the other space\'s matrix', async () => {
	const db = makeMixedSpaceDb();
	await withServer(db, async call => {
		const search = (space, axis) => call('POST', '/v1/search', {
			vaultId: VAULT,
			query: 'zzzznothingmatchesthis',
			limit: 10,
			queryEmbedding: axisVector(axis),
			embeddingSpace: space,
		});

		// Space B first, so its matrix is the one already built and cached.
		assert.deepEqual((await search('bge-m3/q4_k_m', 1)).json.results.map(row => row.path), ['Q4.md']);
		// …then space A. A cache keyed only by vault would answer this from B's matrix, which is
		// the same bug this whole work package removes, wearing a different hat.
		assert.deepEqual((await search('bge-m3/fp32', 0)).json.results.map(row => row.path), ['Fp32.md']);
		// And back again, in case the second build clobbered the first entry.
		assert.deepEqual((await search('bge-m3/q4_k_m', 1)).json.results.map(row => row.path), ['Q4.md']);
	});
	db.close();
});

// ── 6. A mixed index degrades, never fails ───────────────────────────────────────────────

test('a mixed-space vault degrades to keyword-only with an explanation, and still answers 200', async () => {
	const db = makeMixedSpaceDb();
	await withServer(db, async call => {
		// No space named — an older client, or a client that could not derive one. There is no
		// honest scan available, so the request is answered with keywords and says why.
		const unnamed = await call('POST', '/v1/search', {
			vaultId: VAULT,
			query: 'alpha prose',
			limit: 10,
			queryEmbedding: axisVector(0),
		});
		assert.equal(unnamed.status, 200);
		assert.equal(unnamed.json.mode, 'fts');
		assert.match(unnamed.json.message, /2 embedding spaces/);
		// Keyword search is untouched: the degrade costs semantic ranking, not the results.
		assert.deepEqual(unnamed.json.results.map(row => row.path), ['Fp32.md']);

		// A space this index does not hold degrades the same way rather than scanning the ones it
		// does hold.
		const foreign = await call('POST', '/v1/search', {
			vaultId: VAULT,
			query: 'alpha prose',
			limit: 10,
			queryEmbedding: axisVector(0),
			embeddingSpace: 'nomic-embed-text',
		});
		assert.equal(foreign.status, 200);
		assert.equal(foreign.json.mode, 'fts');
		assert.match(foreign.json.message, /nomic-embed-text/);
	});
	db.close();
});

test('a single-space vault queried from a different space degrades rather than scoring across the two', async () => {
	const db = makeDb();
	seedVector(db, { id: 'a', path: 'A.md', text: 'alpha prose', values: axisVector(0), model: 'bge-m3', space: 'bge-m3/fp32' });
	await withServer(db, async call => {
		const mismatched = await call('POST', '/v1/search', {
			vaultId: VAULT,
			query: 'alpha prose',
			limit: 10,
			queryEmbedding: axisVector(0),
			embeddingSpace: 'bge-m3/q4_k_m',
		});
		assert.equal(mismatched.status, 200);
		assert.equal(mismatched.json.mode, 'fts');
		assert.match(mismatched.json.message, /bge-m3\/fp32/);

		// The same vault queried from its own space is a normal hybrid search.
		const matched = await call('POST', '/v1/search', {
			vaultId: VAULT,
			query: 'alpha prose',
			limit: 10,
			queryEmbedding: axisVector(0),
			embeddingSpace: 'bge-m3/fp32',
		});
		assert.equal(matched.json.mode, 'hybrid');
		// One space, so nothing partial to report.
		assert.equal(matched.json.message, undefined);
	});
	db.close();
});

test('a client that names no space still gets semantic ranking from a single-space vault', async () => {
	const db = makeDb();
	seedVector(db, { id: 'a', path: 'A.md', text: 'alpha prose', values: axisVector(0), model: 'bge-m3', space: 'bge-m3' });
	await withServer(db, async call => {
		const response = await call('POST', '/v1/search', {
			vaultId: VAULT, query: 'zzzznothingmatchesthis', limit: 10, queryEmbedding: axisVector(0),
		});
		assert.equal(response.json.mode, 'hybrid');
		assert.deepEqual(response.json.results.map(row => row.path), ['A.md']);
	});
	db.close();
});

test('resolveScanSpace: every branch, including the ones only a damaged database reaches', () => {
	const stats = (spaces, unlabelledCount = 0) => ({ spaces, unlabelledCount });

	// No vectors, or a backend that does not report spaces at all (a stand-in, an older seam
	// implementation): treated as single-space, because unknown must not disable semantic search.
	assert.deepEqual(resolveScanSpace(stats([]), 'bge-m3'), { space: null, note: null, skip: false });
	assert.deepEqual(resolveScanSpace({}, 'bge-m3'), { space: null, note: null, skip: false });

	// One space: scan it whole, with or without the query naming it.
	assert.deepEqual(resolveScanSpace(stats(['bge-m3']), 'bge-m3'), { space: null, note: null, skip: false });
	assert.deepEqual(resolveScanSpace(stats(['bge-m3']), undefined), { space: null, note: null, skip: false });
	assert.equal(resolveScanSpace(stats(['bge-m3']), 'bge-m3/f16').skip, true);

	// Unattributed vectors cannot be proven to share the query's space.
	assert.deepEqual(resolveScanSpace(stats([], 5), undefined), { space: null, note: null, skip: false });
	assert.equal(resolveScanSpace(stats([], 5), 'bge-m3').skip, true);

	// Mixed: scan the named space, refuse to guess when none is named.
	assert.equal(resolveScanSpace(stats(['a', 'b']), 'a').space, 'a');
	assert.equal(resolveScanSpace(stats(['a', 'b']), 'a').skip, false);
	assert.match(resolveScanSpace(stats(['a', 'b']), 'a').note, /only "a"/);
	assert.equal(resolveScanSpace(stats(['a', 'b']), undefined).skip, true);
	assert.equal(resolveScanSpace(stats(['a', 'b']), 'c').skip, true);
	// Attributed *and* unattributed vectors side by side is a mix too.
	assert.equal(resolveScanSpace(stats(['a'], 3), undefined).skip, true);
	assert.equal(resolveScanSpace(stats(['a'], 3), 'a').space, 'a');
	// Blank is not a space id.
	assert.deepEqual(resolveScanSpace(stats(['a']), '   '), { space: null, note: null, skip: false });
});

// ── 7. /health makes a mixed index visible instead of inferred ───────────────────────────

test('/health reports the distinct spaces present, so a mixed index is visible rather than inferred', async () => {
	const db = makeMixedSpaceDb();
	await withServer(db, async call => {
		const health = (await call('GET', '/health')).json;
		assert.equal(health.schemaVersion, SCHEMA_VERSION);
		assert.deepEqual(health.embeddingSpaces, ['bge-m3/fp32', 'bge-m3/q4_k_m']);
		// No single space to name, which is exactly the state worth noticing.
		assert.equal(health.embeddingSpace, null);
		assert.equal(health.unattributedEmbeddedChunks, 0);
	});
	db.close();

	const single = makeDb();
	seedVector(single, { id: 'a', path: 'A.md', text: 'alpha', values: axisVector(0), model: 'bge-m3', space: 'bge-m3' });
	await withServer(single, async call => {
		const health = (await call('GET', '/health')).json;
		assert.deepEqual(health.embeddingSpaces, ['bge-m3']);
		assert.equal(health.embeddingSpace, 'bge-m3');
	});
	single.close();
});
