// Embedding lifecycle: coverage reporting, the coverage-aware skip, model invalidation, and
// the backfill's refusal to write FTS-only chunks.
//
// Every gap covered here fails *silently* today, which is why each case asserts both
// directions: "re-index the uncovered path" is worthless without "and leave the covered one
// alone", or the fix quietly becomes "re-embed the whole vault on every pass".
//
// Companion cases build their own in-memory SQLite database and bind an ephemeral loopback
// port; nothing here touches the live companion on 127.0.0.1:4801 or its real index.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

import { createRequestHandler, createSchema } from '../scripts/search-companion.mjs';

const VAULT = 'test-vault';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-embedding-lifecycle-tests');
const managerOutfile = path.join(outdir, 'SearchManager.mjs');
const clientOutfile = path.join(outdir, 'client.mjs');
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
					globalThis.__searchClientRequests.push(options);
					return globalThis.__searchClientResponse;
				}
			`,
			loader: 'js',
		}));
	},
};

for (const [entry, outfile] of [
	['src/search/SearchManager.ts', managerOutfile],
	['src/search/client.ts', clientOutfile],
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
const { SearchServiceClient } = await import(pathToFileURL(clientOutfile));
const { hashSearchContent } = await import(pathToFileURL(chunkerOutfile));

// ── Companion harness ────────────────────────────────────────────────────────────────────

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
		return await fn(call);
	} finally {
		await new Promise(resolveClose => server.close(resolveClose));
	}
}

function chunkFor(id, filePath, ordinal, embedding, embeddingModel) {
	return {
		id,
		vaultId: VAULT,
		path: filePath,
		contentHash: `hash-${filePath}`,
		title: filePath.replace(/\.md$/, ''),
		heading: '',
		text: `body of ${id}`,
		mtime: 100 + ordinal,
		ordinal,
		metadata: {},
		...(embedding ? { embedding } : {}),
		...(embeddingModel ? { embeddingModel } : {}),
	};
}

function stateFor(json, filePath) {
	return json.files.find(entry => entry.path === filePath);
}

// ── 1. Coverage detection ────────────────────────────────────────────────────────────────

test('/v1/files/state distinguishes unembedded, differently-embedded and fully-covered paths', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		const upsert = await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [
				// Indexed, never embedded — the "enabled semantic later" state.
				chunkFor('bare-0', 'bare.md', 0),
				chunkFor('bare-1', 'bare.md', 1),
				// Embedded under a model that is no longer the active one.
				chunkFor('old-0', 'old-model.md', 0, [1, 0, 0], 'bge-small-en-v1.5'),
				// Fully covered under the active model.
				chunkFor('good-0', 'good.md', 0, [0, 1, 0], 'bge-m3'),
				chunkFor('good-1', 'good.md', 1, [0, 0, 1], 'bge-m3'),
			],
		});
		assert.equal(upsert.status, 200);

		const { status, json } = await call('POST', '/v1/files/state', {
			vaultId: VAULT,
			paths: ['bare.md', 'old-model.md', 'good.md'],
		});
		assert.equal(status, 200);

		const bare = stateFor(json, 'bare.md');
		assert.equal(bare.chunkCount, 2);
		assert.equal(bare.embeddedChunkCount, 0);
		assert.equal(bare.hasEmbeddings, false);
		assert.equal(bare.embeddingModel, undefined);

		const old = stateFor(json, 'old-model.md');
		assert.equal(old.hasEmbeddings, true);
		assert.equal(old.embeddingModel, 'bge-small-en-v1.5');

		const good = stateFor(json, 'good.md');
		assert.equal(good.chunkCount, 2);
		assert.equal(good.embeddedChunkCount, 2);
		assert.equal(good.hasEmbeddings, true);
		assert.equal(good.embeddingModel, 'bge-m3');
	});
	db.close();
});

// ── 2. Partial coverage is not "covered" ─────────────────────────────────────────────────

test('a partly-embedded path reports as needing work, not as covered (the interrupted-backfill state)', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [
				chunkFor('half-0', 'half.md', 0, [1, 0, 0], 'bge-m3'),
				chunkFor('half-1', 'half.md', 1),
				chunkFor('half-2', 'half.md', 2),
			],
		});

		const { json } = await call('POST', '/v1/files/state', { vaultId: VAULT, paths: ['half.md'] });
		const half = stateFor(json, 'half.md');
		assert.equal(half.chunkCount, 3);
		assert.equal(half.embeddedChunkCount, 1);
		// The whole point: "some chunks have vectors" must never read as done, or the remaining
		// two are stranded permanently behind a matching content hash.
		assert.equal(half.hasEmbeddings, false);
	});
	db.close();
});

test('chunks disagreeing about the producing model report no model at all', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [
				chunkFor('mixed-0', 'mixed.md', 0, [1, 0, 0], 'bge-m3'),
				chunkFor('mixed-1', 'mixed.md', 1, [0, 1, 0], 'nomic-embed-text'),
			],
		});
		const { json } = await call('POST', '/v1/files/state', { vaultId: VAULT, paths: ['mixed.md'] });
		const mixed = stateFor(json, 'mixed.md');
		assert.equal(mixed.hasEmbeddings, true);
		// Fails the client's "matches the active model" test closed rather than picking one.
		assert.equal(mixed.embeddingModel, undefined);
	});
	db.close();
});

test('vectors written without model attribution report no model, so they are re-embedded rather than trusted', async () => {
	const db = makeDb();
	await withServer(db, async call => {
		await call('POST', '/v1/chunks/upsert', {
			vaultId: VAULT,
			chunks: [chunkFor('legacy-0', 'legacy.md', 0, [1, 0, 0])],
		});
		const { json } = await call('POST', '/v1/files/state', { vaultId: VAULT, paths: ['legacy.md'] });
		assert.equal(stateFor(json, 'legacy.md').hasEmbeddings, true);
		assert.equal(stateFor(json, 'legacy.md').embeddingModel, undefined);
	});
	db.close();
});

test('SearchServiceClient carries coverage through, and degrades to undefined against a companion that omits it', async () => {
	globalThis.__searchClientRequests = [];
	globalThis.__searchClientResponse = {
		status: 200,
		json: {
			ok: true,
			files: [
				{ path: 'new.md', contentHash: 'h1', chunkCount: 2, embeddedChunkCount: 2, hasEmbeddings: true, embeddingModel: 'bge-m3' },
				// Exactly the shape an older companion returns: no coverage fields at all.
				{ path: 'old.md', contentHash: 'h2', chunkCount: 2 },
			],
		},
	};
	const states = await new SearchServiceClient('http://127.0.0.1:4899', VAULT).fileStates(['new.md', 'old.md']);
	assert.equal(states.get('new.md').hasEmbeddings, true);
	assert.equal(states.get('new.md').embeddingModel, 'bge-m3');
	assert.equal(states.get('old.md').hasEmbeddings, undefined);
	assert.equal(states.get('old.md').embeddingModel, undefined);
});

// ── SearchManager harness ────────────────────────────────────────────────────────────────

function settings(overrides = {}) {
	return {
		excludedFolders: [],
		providers: [{
			id: 'local',
			name: 'Local',
			kind: 'openai-compatible',
			models: [{ id: 'bge-m3', label: 'bge-m3' }],
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
	const parts = filePath.split('/');
	const name = parts[parts.length - 1];
	const extension = name.split('.').pop();
	return {
		path: filePath,
		basename: name.slice(0, -(extension.length + 1)),
		extension,
		stat: { mtime: 123 },
	};
}

function makeManager(contentByPath, client, settingsOverrides = {}, providerManager) {
	const app = {
		metadataCache: { isUserIgnored: () => false },
		vault: { read: async (file) => contentByPath.get(file.path) ?? '' },
	};
	const manager = new SearchManager(app, settings(settingsOverrides), providerManager ?? {
		embed: async (_provider, _modelId, inputs) => ({
			embeddings: inputs.map(() => [1, 0, 0]),
			dimensions: 3,
		}),
	});
	manager.client = () => client;
	return manager;
}

// ── 3. The skip logic re-indexes uncovered paths and leaves covered ones alone ───────────

test('with semantic on, an uncovered path is re-indexed and a fully-covered one is skipped', async () => {
	const covered = makeFile('covered.md');
	const uncovered = makeFile('uncovered.md');
	const contentByPath = new Map([
		[covered.path, '# Covered\n\nBody'],
		[uncovered.path, '# Uncovered\n\nBody'],
	]);
	const upserted = [];
	const client = {
		fileStates: async () => new Map([
			[covered.path, {
				path: covered.path,
				contentHash: hashSearchContent(contentByPath.get(covered.path)),
				hasEmbeddings: true,
				embeddingModel: 'bge-m3',
				// What a schema-4 companion reports for an index migrated from schema 3: the
				// space backfilled from the model id, which is also what the client derives when
				// the runtime reports no precision. Coverage compares this, not the model id.
				embeddingSpace: 'bge-m3',
			}],
			[uncovered.path, {
				path: uncovered.path,
				// Same content hash as on disk — under the old rule this was a skip, and the file
				// stayed vector-less forever with no error anywhere.
				contentHash: hashSearchContent(contentByPath.get(uncovered.path)),
				hasEmbeddings: false,
			}],
		]),
		upsertChunks: async (chunks) => upserted.push(chunks),
	};
	const manager = makeManager(contentByPath, client);

	const result = await manager.indexFiles([covered, uncovered]);

	assert.equal(result.files, 1);
	assert.equal(upserted.length, 1);
	assert.deepEqual(upserted[0].map(chunk => chunk.path), [uncovered.path]);
	// And the re-index actually produces a vector stamped with the active model *and* space.
	assert.deepEqual(upserted[0][0].embedding, [1, 0, 0]);
	assert.equal(upserted[0][0].embeddingModel, 'bge-m3');
	assert.equal(upserted[0][0].embeddingSpace, 'bge-m3');
});

test('a partly-covered path is re-indexed even though its content hash matches', async () => {
	const file = makeFile('half.md');
	const content = '# Half\n\nBody';
	const upserted = [];
	const client = {
		fileStates: async () => new Map([[file.path, {
			path: file.path,
			contentHash: hashSearchContent(content),
			chunkCount: 3,
			embeddedChunkCount: 1,
			hasEmbeddings: false,
			embeddingModel: 'bge-m3',
		}]]),
		upsertChunks: async (chunks) => upserted.push(chunks),
	};
	const manager = makeManager(new Map([[file.path, content]]), client);

	assert.equal((await manager.indexFiles([file])).files, 1);
	assert.equal(upserted.length, 1);
});

test('unknown coverage (an older companion omitting the fields) re-indexes rather than skipping', async () => {
	const file = makeFile('unknown.md');
	const content = '# Unknown\n\nBody';
	const upserted = [];
	const client = {
		fileStates: async () => new Map([[file.path, { path: file.path, contentHash: hashSearchContent(content) }]]),
		upsertChunks: async (chunks) => upserted.push(chunks),
	};
	const manager = makeManager(new Map([[file.path, content]]), client);

	assert.equal((await manager.indexFiles([file])).files, 1);
	assert.equal(upserted.length, 1);
});

// ── 4. Model change invalidates ──────────────────────────────────────────────────────────

test('the same content hash under a different embedding model is not skipped', async () => {
	const file = makeFile('switched.md');
	const content = '# Switched\n\nBody';
	const upserted = [];
	const client = {
		fileStates: async () => new Map([[file.path, {
			path: file.path,
			contentHash: hashSearchContent(content),
			hasEmbeddings: true,
			// Fully covered — just in the wrong vector space.
			embeddingModel: 'nomic-embed-text',
			embeddingSpace: 'nomic-embed-text',
		}]]),
		upsertChunks: async (chunks) => upserted.push(chunks),
	};
	const manager = makeManager(new Map([[file.path, content]]), client);

	assert.equal((await manager.indexFiles([file])).files, 1);
	assert.equal(upserted[0][0].embeddingModel, 'bge-m3');
});

// ── 5. Semantic disabled removes coverage from the condition ─────────────────────────────

test('with semantic off, a fully-indexed unembedded vault skips everything exactly as before', async () => {
	const first = makeFile('a.md');
	const second = makeFile('b.md');
	const contentByPath = new Map([[first.path, '# A\n\nBody'], [second.path, '# B\n\nBody']]);
	const upserted = [];
	const client = {
		fileStates: async () => new Map([
			[first.path, { path: first.path, contentHash: hashSearchContent(contentByPath.get(first.path)), hasEmbeddings: false }],
			[second.path, { path: second.path, contentHash: hashSearchContent(contentByPath.get(second.path)) }],
		]),
		upsertChunks: async (chunks) => upserted.push(chunks),
	};
	const manager = makeManager(contentByPath, client, { searchSemanticEnabled: false, searchEmbeddingModel: undefined });

	const result = await manager.indexFiles([first, second]);

	// Coverage must not enter the condition at all here, or turning semantic off would make
	// every file look stale forever and every pass would re-upsert the whole vault.
	assert.equal(result.files, 0);
	assert.equal(upserted.length, 0);
});

// ── 6. A backfill against a failing embedder refuses ─────────────────────────────────────

test('requireEmbeddings refuses rather than writing FTS-only chunks when the embedder fails', async () => {
	const file = makeFile('needs-vectors.md');
	const content = '# Needs vectors\n\nBody';
	const upserted = [];
	const client = {
		fileStates: async () => new Map(),
		upsertChunks: async (chunks) => upserted.push(chunks),
	};
	const manager = makeManager(new Map([[file.path, content]]), client, {}, {
		embed: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:4802'); },
	});

	await assert.rejects(
		() => manager.indexFiles([file], undefined, { requireEmbeddings: true }),
		(e) => e.name === 'SearchEmbeddingUnavailableError' && /ECONNREFUSED/.test(e.message),
	);
	// Nothing was written: an FTS-only upsert here would mark the path done and leave it
	// permanently uncovered while the job reported success.
	assert.equal(upserted.length, 0);
});

test('ordinary indexing still degrades to FTS-only when the embedder fails', async () => {
	const file = makeFile('ordinary.md');
	const content = '# Ordinary\n\nBody';
	const upserted = [];
	const client = {
		fileStates: async () => new Map(),
		upsertChunks: async (chunks) => upserted.push(chunks),
	};
	const manager = makeManager(new Map([[file.path, content]]), client, {}, {
		embed: async () => { throw new Error('embedder down'); },
	});

	const result = await manager.indexFiles([file]);

	assert.equal(result.files, 1);
	assert.equal(upserted.length, 1);
	assert.equal(upserted[0][0].embedding, undefined);
});

test('a backfill with semantic off or no model refuses before reading a single file', async () => {
	const file = makeFile('nope.md');
	let reads = 0;
	const client = { fileStates: async () => new Map(), upsertChunks: async () => {} };
	const app = {
		metadataCache: { isUserIgnored: () => false },
		vault: { read: async () => { reads++; return '# Nope'; } },
	};
	const manager = new SearchManager(app, settings({ searchSemanticEnabled: false }), {});
	manager.client = () => client;

	await assert.rejects(
		() => manager.indexFiles([file], undefined, { requireEmbeddings: true }),
		/cannot backfill embeddings/,
	);
	assert.equal(reads, 0);
});

// ── Fail fast on a width mismatch, before the upsert ─────────────────────────────────────

test('a provider returning the wrong width fails on the first sub-batch, before any upsert', async () => {
	const file = makeFile('wide.md');
	const content = '# Wide\n\nBody';
	const upserted = [];
	const client = {
		fileStates: async () => new Map(),
		upsertChunks: async (chunks) => upserted.push(chunks),
	};
	const manager = makeManager(new Map([[file.path, content]]), client, {
		providers: [{
			id: 'local',
			name: 'Local',
			kind: 'openai-compatible',
			// Configured width — computed and configurable, and both were previously discarded.
			models: [{ id: 'bge-m3', label: 'bge-m3', embeddingDimensions: 1024 }],
		}],
	}, {
		embed: async (_provider, _modelId, inputs) => ({ embeddings: inputs.map(() => [1, 0, 0]), dimensions: 3 }),
	});

	await assert.rejects(
		() => manager.indexFiles([file], undefined, { requireEmbeddings: true }),
		(e) => e.name === 'SearchEmbeddingMismatchError' && /configured for 1024 dimensions but returned 3/.test(e.message),
	);
	assert.equal(upserted.length, 0);
});
