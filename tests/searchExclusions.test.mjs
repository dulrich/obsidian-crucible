import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-exclusion-tests');
const outfile = path.join(outdir, 'SearchManager.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/SearchManager.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: [
					'export class Notice { constructor() {} }',
					'export class FileSystemAdapter {}',
					'export function normalizePath(path) { return path; }',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { SearchManager } = await import(pathToFileURL(outfile));

const settings = {
	searchEnabled: true,
	searchServiceUrl: 'http://127.0.0.1:8765',
	searchVaultId: 'test',
	searchSemanticEnabled: false,
	searchChunkMaxChars: 1800,
	searchChunkOverlapChars: 200,
	searchIndexBatchSize: 24,
	searchResultLimit: 12,
	excludedFolders: [{ folder: '_crucible', lint: false, search: true }],
	providers: [],
};

test('SearchManager listIndexableFiles excludes configured search folders', () => {
	const app = {
		vault: {
			getFiles: () => [
				{ path: '_crucible/orchestration/queue/job.md' },
				{ path: 'daily/note.md' },
				{ path: 'assets/image.png' },
			],
		},
	};
	const manager = new SearchManager(app, settings, {});
	assert.deepEqual(manager.listIndexableFiles().map(file => file.path), ['daily/note.md']);
});

test('SearchManager indexFile skips search-excluded paths before reading', async () => {
	const app = {
		vault: {
			read: async () => {
				throw new Error('excluded file should not be read');
			},
		},
	};
	const manager = new SearchManager(app, settings, {});
	const count = await manager.indexFile({
		path: '_crucible/orchestration/queue/job.md',
		basename: 'job',
		extension: 'md',
		stat: { mtime: 1 },
	});
	assert.equal(count, 0);
});
