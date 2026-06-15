import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-client-tests');
const outfile = path.join(outdir, 'client.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/client.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: `
					export async function requestUrl(options) {
						globalThis.__searchClientRequests.push(options);
						return globalThis.__searchClientResponse;
					}
				`,
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { SearchServiceClient } = await import(pathToFileURL(outfile));

test('SearchServiceClient parses total and hasMore', async () => {
	globalThis.__searchClientRequests = [];
	globalThis.__searchClientResponse = {
		status: 200,
		json: {
			mode: 'fts',
			semanticAvailable: false,
			total: 47,
			hasMore: true,
			results: [{
				chunkId: 'chunk-1',
				path: 'note.md',
				title: 'Note',
				snippet: 'Needle result',
				score: 0.5,
			}],
		},
	};
	const client = new SearchServiceClient('http://search.local', 'vault');

	const response = await client.search({ query: 'needle', limit: 12 });

	assert.equal(response.total, 47);
	assert.equal(response.hasMore, true);
	assert.equal(response.results.length, 1);
	assert.equal(JSON.parse(globalThis.__searchClientRequests[0].body).limit, 12);
});

test('SearchServiceClient parses file states by path', async () => {
	globalThis.__searchClientRequests = [];
	globalThis.__searchClientResponse = {
		status: 200,
		json: {
			files: [{
				path: 'note.md',
				contentHash: 'abcd1234',
				mtime: 99,
				chunkCount: 3,
			}],
		},
	};
	const client = new SearchServiceClient('http://search.local', 'vault');

	const states = await client.fileStates(['note.md']);

	assert.equal(states.get('note.md')?.contentHash, 'abcd1234');
	assert.equal(states.get('note.md')?.chunkCount, 3);
	assert.equal(JSON.parse(globalThis.__searchClientRequests[0].body).paths[0], 'note.md');
});
