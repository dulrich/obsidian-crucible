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
		searchServiceUrl: 'http://127.0.0.1:8765',
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

	assert.equal(result.files, 1);
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
