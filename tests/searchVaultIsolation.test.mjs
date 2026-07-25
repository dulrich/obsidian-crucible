// Vault isolation for chunk ids — the coverage that did not exist when the bug was found.
//
// Every other companion test pins a single vault constant (`VAULT = 'test-vault'` in
// searchCompanionRanking, searchCompanionVector, searchEmbeddingLifecycle), so nothing in the
// suite ever wrote two distinct `vaultId`s into one database. That is exactly why a data-loss
// bug lived in the upsert unnoticed: with `PRIMARY KEY (id)` and a chunk id that omitted the
// vault, indexing vault B re-labelled vault A's row as B's, A's file then vanished from A's own
// `/v1/files/state`, and a reset of B deleted A's data along with B's.
//
// The failure is silent in both directions, and partially self-healing in a way that makes it
// worse: A's next sweep sees the path missing, re-chunks it, and steals the row back, so two
// vaults on a timer ping-pong the same rows forever with no error anywhere. So these cases
// assert the *absence* of the re-label as much as the presence of the right rows.
//
// Every case builds its own in-memory SQLite database and binds an ephemeral loopback port of
// its own; nothing here touches the live companion on 127.0.0.1:4801 or its real index.
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
	createRequestHandler,
	createSchema,
	encodeEmbedding,
	migrateChunksPrimaryKey,
	normalizeEmbedding,
} from '../scripts/search-companion.mjs';

const VAULT_A = 'vault-a';
const VAULT_B = 'vault-b';
const WIDTH = 8;

// ── Harnesses ────────────────────────────────────────────────────────────────────────────

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-vault-isolation-tests');
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
const { buildSearchChunks, hashSearchContent } = await import(pathToFileURL(chunkerOutfile));

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

// The colliding id from the original reproduction, verbatim. Its shape is what the pre-fix
// `stableChunkId` produced for `README.md` chunk 0 — a value both vaults minted independently
// because the vault was not part of it.
const COLLIDING_ID = 'README.md#0:deadbeef';

function upsertBody(vaultId, text) {
	return {
		vaultId,
		chunks: [{
			id: COLLIDING_ID,
			vaultId,
			path: 'README.md',
			contentHash: `hash-${vaultId}`,
			title: 'README',
			heading: '',
			text,
			mtime: 1,
			ordinal: 0,
			metadata: {},
		}],
	};
}

// ── 1. The reproduction ──────────────────────────────────────────────────────────────────

test('vault A survives vault B upserting a colliding chunk id', async () => {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	await withServer(db, async (call) => {
		assert.equal((await call('POST', '/v1/chunks/upsert', upsertBody(VAULT_A, 'alpaca husbandry notes'))).status, 200);
		assert.equal((await call('POST', '/v1/chunks/upsert', upsertBody(VAULT_B, 'barnacle removal notes'))).status, 200);

		// Before the fix this was one row, labelled `vault-b`.
		const rows = db.prepare('SELECT vault_id, text FROM chunks WHERE id = ? ORDER BY vault_id').all(COLLIDING_ID)
			.map(row => ({ vaultId: row.vault_id, text: row.text }));
		assert.deepEqual(rows, [
			{ vaultId: VAULT_A, text: 'alpaca husbandry notes' },
			{ vaultId: VAULT_B, text: 'barnacle removal notes' },
		]);

		// A's file is still A's, with A's content hash — not silently re-homed to B.
		const stateA = await call('POST', '/v1/files/state', { vaultId: VAULT_A, paths: ['README.md'] });
		assert.deepEqual(stateA.json.files.map(file => ({ path: file.path, hash: file.contentHash, chunks: file.chunkCount })), [
			{ path: 'README.md', hash: `hash-${VAULT_A}`, chunks: 1 },
		]);

		// And each vault searches its own text only. The FTS delete was id-keyed too, so before
		// the fix B's upsert evicted A's FTS row on top of re-labelling its chunk.
		const searchA = await call('POST', '/v1/search', { vaultId: VAULT_A, query: 'alpaca' });
		assert.deepEqual(searchA.json.results.map(row => row.path), ['README.md']);
		assert.deepEqual((await call('POST', '/v1/search', { vaultId: VAULT_A, query: 'barnacle' })).json.results, []);
		const searchB = await call('POST', '/v1/search', { vaultId: VAULT_B, query: 'barnacle' });
		assert.deepEqual(searchB.json.results.map(row => row.path), ['README.md']);
	});
	db.close();
});

test('vault A survives vault B resetting its index', async () => {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	await withServer(db, async (call) => {
		await call('POST', '/v1/chunks/upsert', upsertBody(VAULT_A, 'alpaca husbandry notes'));
		await call('POST', '/v1/chunks/upsert', upsertBody(VAULT_B, 'barnacle removal notes'));

		// Reset is, and always was, correctly vault-scoped. It only destroyed A's data because
		// the upsert had already handed A's row to B — which is why the fix belongs at the
		// upsert and reset is deliberately left alone.
		assert.equal((await call('POST', '/v1/index/reset', { vaultId: VAULT_B })).status, 200);

		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?').get(VAULT_A).n, 1);
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?').get(VAULT_B).n, 0);
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks_fts WHERE vault_id = ?').get(VAULT_A).n, 1);
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks_fts WHERE vault_id = ?').get(VAULT_B).n, 0);

		const searchA = await call('POST', '/v1/search', { vaultId: VAULT_A, query: 'alpaca' });
		assert.deepEqual(searchA.json.results.map(row => row.path), ['README.md']);
	});
	db.close();
});

test('deleting a path in one vault leaves the colliding id in the other vault searchable', async () => {
	const db = new DatabaseSync(':memory:');
	createSchema(db);
	await withServer(db, async (call) => {
		await call('POST', '/v1/chunks/upsert', upsertBody(VAULT_A, 'alpaca husbandry notes'));
		await call('POST', '/v1/chunks/upsert', upsertBody(VAULT_B, 'barnacle removal notes'));

		await call('POST', '/v1/chunks/delete', { vaultId: VAULT_B, paths: ['README.md'] });

		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE vault_id = ?').get(VAULT_A).n, 1);
		assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks_fts WHERE vault_id = ?').get(VAULT_A).n, 1);
		const searchA = await call('POST', '/v1/search', { vaultId: VAULT_A, query: 'alpaca' });
		assert.deepEqual(searchA.json.results.map(row => row.path), ['README.md']);
	});
	db.close();
});

// The client half. The composite key makes a collision harmless; this makes it not happen, and
// it is what keeps ids unique for any consumer that still treats a chunk id as a bare handle.
test('stableChunkId is vault-qualified: the same note in two vaults mints different ids', () => {
	const content = '# README\n\nAlpaca husbandry notes.';
	const input = vaultId => ({
		vaultId,
		path: 'README.md',
		basename: 'README',
		content,
		mtime: 1,
		maxChars: 1800,
		overlapChars: 0,
	});
	const a = buildSearchChunks(input(VAULT_A));
	const b = buildSearchChunks(input(VAULT_B));
	assert.equal(a.length, 1);
	assert.equal(b.length, 1);
	assert.notEqual(a[0].id, b[0].id);
	// The readable prefix is unchanged — a chunk id is still `path#ordinal:hash`, so nothing
	// that logs or displays one starts leaking a vault name.
	assert.match(a[0].id, /^README\.md#0:[0-9a-f]{8}$/);
	// Deterministic within a vault: the id is stable across calls, which is what makes the
	// per-path upsert a replace rather than an accumulation.
	assert.equal(buildSearchChunks(input(VAULT_A))[0].id, a[0].id);
});

// ── 2. The primary-key migration is lossless ─────────────────────────────────────────────

// The schema-4 `chunks` table, pinned verbatim rather than derived from the current shape —
// deriving it would make this test vacuous the moment the key changed. This is the migration's
// *input*, so it deliberately keeps `id TEXT PRIMARY KEY`.
const SCHEMA_4_CHUNKS_SQL = `CREATE TABLE chunks (
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
  embedding_model TEXT,
  embedding_space TEXT
)`;

const SCHEMA_4_FTS_SQL = `CREATE VIRTUAL TABLE chunks_fts USING fts5(
  id UNINDEXED, vault_id UNINDEXED, path UNINDEXED, title, heading, text, prefix='2 3'
)`;

function axisVector(axis) {
	const values = new Array(WIDTH).fill(0);
	values[axis % WIDTH] = 1;
	return values;
}

// A schema-4 index holding two vaults. Their ids differ, because under `PRIMARY KEY (id)` they
// had to — which is precisely why the copy into `PRIMARY KEY (vault_id, id)` cannot collide:
// the new key is strictly weaker than the one the source table already enforced.
function makeSchema4Db() {
	const db = new DatabaseSync(':memory:');
	db.exec(`${SCHEMA_4_CHUNKS_SQL};${SCHEMA_4_FTS_SQL};`);
	const insertChunk = db.prepare(`INSERT INTO chunks
(id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model, embedding_space)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	const insertFts = db.prepare('INSERT INTO chunks_fts (id, vault_id, path, title, heading, text) VALUES (?, ?, ?, ?, ?, ?)');
	const seed = [
		{ id: 'a-0', vaultId: VAULT_A, path: 'Notes/Alpaca.md', text: 'alpaca husbandry notes', axis: 0, embedded: true },
		{ id: 'a-1', vaultId: VAULT_A, path: 'Notes/Alpaca.md', text: 'shearing schedule', axis: 1, embedded: true },
		{ id: 'b-0', vaultId: VAULT_B, path: 'Notes/Barnacle.md', text: 'barnacle removal notes', axis: 2, embedded: true },
		{ id: 'b-1', vaultId: VAULT_B, path: 'Plain.md', text: 'no vector on this one', axis: 3, embedded: false },
	];
	for (const [ordinal, row] of seed.entries()) {
		const floats = row.embedded ? normalizeEmbedding(axisVector(row.axis)) : null;
		insertChunk.run(
			row.id, row.vaultId, row.path, `hash-${row.path}`, row.path.replace(/\.md$/, ''), '', row.text, 100 + ordinal, ordinal,
			JSON.stringify({ tags: [row.id] }),
			floats ? encodeEmbedding(floats) : null,
			floats ? floats.length : null,
			row.embedded ? 'bge-m3' : null,
			row.embedded ? 'bge-m3' : null,
		);
		insertFts.run(row.id, row.vaultId, row.path, row.path.replace(/\.md$/, ''), '', row.text);
	}
	return db;
}

// Every column of every row, in a shape `assert.deepEqual` can compare (node:sqlite hands back
// null-prototype rows, and BLOBs come back as Uint8Array).
function snapshotChunks(db) {
	return db.prepare('SELECT rowid AS rid, * FROM chunks ORDER BY id').all().map(row => ({
		rowid: Number(row.rid),
		id: row.id,
		vaultId: row.vault_id,
		path: row.path,
		contentHash: row.content_hash,
		title: row.title,
		heading: row.heading,
		text: row.text,
		mtime: Number(row.mtime),
		ordinal: Number(row.ordinal),
		metadata: row.metadata_json,
		embedding: row.embedding ? Array.from(new Uint8Array(row.embedding)) : null,
		embeddingDim: row.embedding_dim === null ? null : Number(row.embedding_dim),
		embeddingModel: row.embedding_model,
		embeddingSpace: row.embedding_space,
	}));
}

test('the schema-4 to 5 primary-key rebuild copies every row, every column and every FTS entry', () => {
	const db = makeSchema4Db();
	const before = snapshotChunks(db);
	const ftsBefore = db.prepare('SELECT id, vault_id, path, title, heading, text FROM chunks_fts ORDER BY id')
		.all().map(row => ({ ...row }));
	assert.equal(before.length, 4);

	assert.equal(createSchema(db), true);

	const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks'").get().sql;
	assert.match(sql, /PRIMARY KEY \(vault_id, id\)/);
	assert.doesNotMatch(sql, /id TEXT PRIMARY KEY/);

	// Lossless, column for column — including the embedding BLOBs, which a drop-and-reindex
	// would have thrown away and forced 5,449 chunks' worth of re-embedding to recover.
	assert.deepEqual(snapshotChunks(db), before);
	assert.deepEqual(
		db.prepare('SELECT id, vault_id, path, title, heading, text FROM chunks_fts ORDER BY id').all().map(row => ({ ...row })),
		ftsBefore,
	);

	// The indexes the query plan depends on came back with the rebuilt table, and no scratch
	// table was left behind.
	const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'chunks'").all().map(row => row.name);
	assert.ok(indexes.includes('idx_chunks_vault_path'));
	assert.ok(indexes.includes('idx_chunks_vault_path_hash'));
	assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'chunks_migrated'").get().n, 0);

	// Idempotent: a second startup is a no-op, so the rebuild cost is paid exactly once.
	assert.equal(migrateChunksPrimaryKey(db), false);
	assert.equal(createSchema(db), false);
	assert.deepEqual(snapshotChunks(db), before);
	db.close();
});

test('a migrated index answers each vault with only its own rows', async () => {
	const db = makeSchema4Db();
	createSchema(db);
	await withServer(db, async (call) => {
		const searchA = await call('POST', '/v1/search', { vaultId: VAULT_A, query: 'notes' });
		assert.deepEqual(searchA.json.results.map(row => row.path), ['Notes/Alpaca.md']);
		const searchB = await call('POST', '/v1/search', { vaultId: VAULT_B, query: 'notes' });
		assert.deepEqual(searchB.json.results.map(row => row.path), ['Notes/Barnacle.md']);

		// And the new composite key is enforced, not merely declared.
		assert.throws(() => db.prepare('INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
			.run('a-0', VAULT_A, 'Notes/Alpaca.md', 'x', 'x', '', 'x', 0, 0, '{}'));
		// The same id under a different vault is now legal — the whole point.
		db.prepare('INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
			.run('a-0', 'vault-c', 'Notes/Alpaca.md', 'x', 'x', '', 'x', 0, 0, '{}');
	});
	db.close();
});

// ── 3. A pre-existing single-vault index is unaffected ───────────────────────────────────

function makeFile(filePath) {
	const name = filePath.split('/').pop();
	const extension = name.split('.').pop();
	return { path: filePath, basename: name.slice(0, -(extension.length + 1)), extension, stat: { mtime: 123 } };
}

function settings(overrides = {}) {
	return {
		excludedFolders: [],
		providers: [{ id: 'local', name: 'Local', kind: 'openai-compatible', models: [{ id: 'bge-m3', label: 'bge-m3' }] }],
		searchVaultId: VAULT_A,
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

// A single-vault schema-4 index whose one note is fully embedded and whose content hash matches
// what the client will compute — i.e. the live index's exact situation.
function makeCoveredDb(content) {
	const db = new DatabaseSync(':memory:');
	db.exec(`${SCHEMA_4_CHUNKS_SQL};${SCHEMA_4_FTS_SQL};`);
	const floats = normalizeEmbedding(axisVector(0));
	db.prepare(`INSERT INTO chunks
(id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding, embedding_dim, embedding_model, embedding_space)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
		'note.md#0:legacy', VAULT_A, 'note.md', hashSearchContent(content), 'Note', '', 'Body of the note.', 123, 0, '{}',
		encodeEmbedding(floats), floats.length, 'bge-m3', 'bge-m3',
	);
	db.prepare('INSERT INTO chunks_fts (id, vault_id, path, title, heading, text) VALUES (?, ?, ?, ?, ?, ?)')
		.run('note.md#0:legacy', VAULT_A, 'note.md', 'Note', '', 'Body of the note.');
	return db;
}

test('a pre-existing single-vault index is untouched: the migration triggers no re-index', async () => {
	const content = '# Note\n\nBody of the note.';
	const db = makeCoveredDb(content);
	createSchema(db);

	await withServer(db, async (_call, base) => {
		const upserted = [];
		const app = {
			metadataCache: { isUserIgnored: () => false },
			vault: { read: async () => content },
		};
		const providerManager = {
			embed: async (_provider, _modelId, inputs) => ({ embeddings: inputs.map(() => axisVector(0)), dimensions: WIDTH }),
			describeModel: async () => ({ servedModel: 'bge-m3', precision: undefined, fingerprint: 'optimum' }),
		};
		const manager = new SearchManager(app, settings({ searchServiceUrl: base }), providerManager);
		const real = manager.client();
		manager.client = () => ({
			fileStates: paths => real.fileStates(paths),
			upsertChunks: async chunks => upserted.push(chunks),
		});

		// The old row keeps its pre-fix, vault-less id. It stays reachable because every lookup
		// that matters is by `(vault_id, path)`, so coverage is still satisfied and nothing
		// re-chunks — which is what makes the client-side id change need no migration.
		const result = await manager.indexFiles([makeFile('note.md')]);
		assert.equal(result.files, 0, 'a migrated single-vault index must not re-index a single file');
		assert.equal(upserted.length, 0);
		assert.equal(db.prepare('SELECT id FROM chunks').get().id, 'note.md#0:legacy');
	});
	db.close();
});
