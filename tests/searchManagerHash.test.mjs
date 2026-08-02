import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-manager-hash-tests');
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
const { hashSearchContent } = await import(pathToFileURL(chunkerOutfile));

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

function makeManager(contentByPath, client) {
	const app = {
		// Nothing on Obsidian's own excluded-files list; these fixtures test hashing, not
		// exclusion. isExcludedFromIndex consults it for every candidate path.
		metadataCache: { isUserIgnored: () => false },
		vault: {
			read: async (file) => contentByPath.get(file.path) ?? '',
		},
	};
	const manager = new SearchManager(app, settings(), {});
	manager.client = () => client;
	return manager;
}

test('unchanged content hash skips search chunk upsert', async () => {
	const file = makeFile('daily/example.md');
	const content = '# Example\n\nBody text';
	const upserted = [];
	const client = {
		fileStates: async () => new Map([[file.path, { path: file.path, contentHash: hashSearchContent(content) }]]),
		upsertChunks: async (chunks) => upserted.push(chunks),
	};
	const manager = makeManager(new Map([[file.path, content]]), client);

	const result = await manager.indexFiles([file]);

	// Hash matched, so nothing is re-indexed: `files` reports work done, not files seen.
	assert.equal(result.files, 0);
	assert.equal(result.chunks, 0);
	assert.equal(upserted.length, 0);
});

test('changed or unknown content hash indexes normally', async () => {
	const changed = makeFile('daily/changed.md');
	const unknown = makeFile('daily/unknown.md');
	const contentByPath = new Map([
		[changed.path, '# Changed\n\nNew body'],
		[unknown.path, '# Unknown\n\nNew body'],
	]);
	const upserted = [];
	const client = {
		fileStates: async () => new Map([[changed.path, { path: changed.path, contentHash: 'old-hash' }]]),
		upsertChunks: async (chunks) => upserted.push(chunks),
	};
	const manager = makeManager(contentByPath, client);

	const result = await manager.indexFiles([changed, unknown]);

	assert.equal(result.files, 2);
	assert.equal(result.chunks, 2);
	assert.equal(upserted.length, 1);
	assert.deepEqual(upserted[0].map(chunk => chunk.path).sort(), [changed.path, unknown.path]);
	assert.ok(upserted[0].every(chunk => chunk.contentHash));
});

// WP-G2: per-file outcomes on indexFiles/indexFile — the honest-notes shape change.

test('indexFiles reports a skipped-unchanged outcome for a hash match, not just files:0/chunks:0', async () => {
	const file = makeFile('daily/example.md');
	const content = '# Example\n\nBody text';
	const client = {
		fileStates: async () => new Map([[file.path, { path: file.path, contentHash: hashSearchContent(content) }]]),
		upsertChunks: async () => {},
	};
	const manager = makeManager(new Map([[file.path, content]]), client);

	const result = await manager.indexFiles([file]);

	assert.deepEqual(result.outcomes.get(file.path), { outcome: 'skipped-unchanged', chunks: 0 });
});

test('indexFiles reports a written outcome with the real chunk count for a changed file', async () => {
	const file = makeFile('daily/changed.md');
	const content = '# Changed\n\nNew body';
	const client = {
		fileStates: async () => new Map([[file.path, { path: file.path, contentHash: 'old-hash' }]]),
		upsertChunks: async () => {},
	};
	const manager = makeManager(new Map([[file.path, content]]), client);

	const result = await manager.indexFiles([file]);

	const outcome = result.outcomes.get(file.path);
	assert.equal(outcome.outcome, 'written');
	assert.equal(outcome.chunks, 1);
});

test('indexFiles reports a no-chunks outcome for a frontmatter-only file the chunker emits nothing for', async () => {
	const file = makeFile('daily/empty.md');
	const content = '---\ntitle: Empty\n---\n';
	const client = {
		fileStates: async () => new Map(),
		upsertChunks: async () => { throw new Error('nothing should be sent for a zero-chunk file'); },
	};
	const manager = makeManager(new Map([[file.path, content]]), client);

	const result = await manager.indexFiles([file]);

	assert.deepEqual(result.outcomes.get(file.path), { outcome: 'no-chunks', chunks: 0 });
	assert.equal(result.chunks, 0);
});

test('indexFile (the single-file wrapper) returns the same SearchFileIndexResult indexFiles records', async () => {
	const file = makeFile('daily/changed.md');
	const content = '# Changed\n\nNew body';
	const client = {
		fileStates: async () => new Map([[file.path, { path: file.path, contentHash: 'old-hash' }]]),
		upsertChunks: async () => {},
	};
	const manager = makeManager(new Map([[file.path, content]]), client);

	const result = await manager.indexFile(file);

	assert.equal(result.outcome, 'written');
	assert.equal(result.chunks, 1);
});

// WP-G2: auditPrepareFile is the audit's hash/chunk-count verification primitive — it must
// compute the exact same contentHash and chunk count the real write path (indexFiles) does,
// since the "do not invent a second hash" constraint requires provable equality, not just two
// implementations that happen to agree.

test('auditPrepareFile\'s contentHash and chunkCount match what indexFiles actually sends for the same file', async () => {
	const file = makeFile('daily/provenance.md');
	const content = '# Provenance\n\nSome body text that produces a real chunk.';
	const upserted = [];
	const client = {
		fileStates: async () => new Map(),
		upsertChunks: async (chunks) => upserted.push(...chunks),
	};
	const manager = makeManager(new Map([[file.path, content]]), client);

	await manager.indexFiles([file]);
	assert.equal(upserted.length, 1, 'sanity: exactly one chunk was actually sent');

	const audited = await manager.auditPrepareFile(file);

	assert.equal(audited.contentHash, upserted[0].contentHash);
	assert.equal(audited.chunkCount, upserted.length);
});

test('auditPrepareFile reports chunkCount 0 for a frontmatter-only file, using the real chunker', async () => {
	const file = makeFile('daily/tombstone.md');
	const content = '---\nstate: unavailable\n---\n';
	const manager = makeManager(new Map([[file.path, content]]), { fileStates: async () => new Map() });

	const audited = await manager.auditPrepareFile(file);

	assert.equal(audited.chunkCount, 0);
	assert.equal(typeof audited.contentHash, 'string');
});
