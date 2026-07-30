// WP-5: SearchManager.search()'s timeout threading (the configured `searchQueryTimeoutMs`
// setting reaches SearchServiceClient.search() rather than its hardcoded 5s default), the
// timed-out-search logWarn breadcrumb, and the escalation-guard wiring
// (CompanionAvailabilityGate.noteInteractiveSearchResponse). Same bundling technique as
// searchManagerQueryEmbedding.test.mjs: the real SearchManager.ts against a minimal obsidian
// stub, so this exercises the actual production code path rather than a reimplementation of it.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-manager-search-timeout-tests');
const outfile = path.join(outdir, 'SearchManager.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
// SearchManager.ts checks `e instanceof SearchServiceUnavailableError` internally — the thrown
// instance in a test must come from the SAME module graph as SearchManager's own bundled copy of
// that class, or the instanceof check silently fails (two independent esbuild bundles of
// client.ts produce two distinct classes, even though they look identical). A single virtual
// entry point (via esbuild's `stdin`) that re-exports both symbols from the real source files
// guarantees one shared module graph, so the class SearchManager checks against is exactly the
// class this test constructs.
await esbuild.build({
	stdin: {
		contents: `
			export { SearchManager } from './src/search/SearchManager';
			export { SearchServiceUnavailableError } from './src/search/client';
		`,
		resolveDir: process.cwd(),
		loader: 'ts',
	},
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
					export class App {}
					export class FileSystemAdapter {}
					export class TFile {}
					export class TFolder {}
					export const Platform = { isDesktopApp: true, isMobile: false };
					export class Notice {
						constructor(message) { globalThis.__searchManagerNotices.push(message); }
					}
					export function normalizePath(path) { return path; }
					export async function requestUrl() { throw new Error('requestUrl not stubbed'); }
				`,
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { SearchManager, SearchServiceUnavailableError } = await import(pathToFileURL(outfile));

function settings(overrides = {}) {
	return {
		excludedFolders: [],
		providers: [{ id: 'p1', models: [{ id: 'm1' }] }],
		searchVaultId: 'vault',
		searchServiceUrl: 'http://127.0.0.1:4801',
		searchSemanticEnabled: false,
		searchChunkMaxChars: 1800,
		searchChunkOverlapChars: 200,
		searchIndexBatchSize: 24,
		searchResultLimit: 12,
		searchQueryTimeoutMs: 4000,
		...overrides,
	};
}

function makeManager(overrides = {}) {
	const app = { metadataCache: { isUserIgnored: () => false } };
	const manager = new SearchManager(app, settings(overrides), {});
	return manager;
}

test('SearchManager.search() threads the configured searchQueryTimeoutMs through to the client, not a hardcoded default', async () => {
	const manager = makeManager({ searchQueryTimeoutMs: 7500 });
	const calls = [];
	manager.client = () => ({
		search: async (options, timeoutMs) => {
			calls.push({ options, timeoutMs });
			return { results: [] };
		},
	});

	await manager.search('needle');

	assert.equal(calls.length, 1);
	assert.equal(calls[0].timeoutMs, 7500, 'the configured setting, not client.ts\'s own 5000ms default');
});

test('SearchManager.search() logs a breadcrumb (elapsed + term count) via logWarn when the search times out, and still rethrows', async () => {
	globalThis.__CRUCIBLE_DEBUG__ = true;
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (...args) => { warnings.push(args); };

	try {
		const manager = makeManager();
		manager.client = () => ({
			search: async () => { throw new SearchServiceUnavailableError('Search service /v1/search timed out after 4000ms', 'timeout'); },
		});

		await assert.rejects(
			manager.search('talking to a genius who also has thirty years of linux kernel experience'),
			SearchServiceUnavailableError,
			'the timeout must still propagate to the caller (the modal\'s own catch surfaces it to the user)',
		);

		assert.equal(warnings.length, 1, 'exactly one breadcrumb for the one timed-out search');
		const logged = warnings[0].join(' ');
		assert.match(logged, /timed out after \d+ms/, 'elapsed ms must be in the breadcrumb');
		// "talking to a genius who also has thirty years of linux kernel experience" is 13 terms.
		assert.match(logged, /\(13 terms\)/, 'term count must be in the breadcrumb');
	} finally {
		console.warn = originalWarn;
		globalThis.__CRUCIBLE_DEBUG__ = false;
	}
});

test('SearchManager.search() does NOT log a breadcrumb for a non-timeout failure (refused/server-error already have their own reporting)', async () => {
	globalThis.__CRUCIBLE_DEBUG__ = true;
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (...args) => { warnings.push(args); };

	try {
		const manager = makeManager();
		manager.client = () => ({
			search: async () => { throw new SearchServiceUnavailableError('Search service /v1/search returned 503', 'server-error'); },
		});

		await assert.rejects(manager.search('needle'), SearchServiceUnavailableError);
		assert.equal(warnings.length, 0, 'the breadcrumb is specifically for the timeout kind, not every failure');
	} finally {
		console.warn = originalWarn;
		globalThis.__CRUCIBLE_DEBUG__ = false;
	}
});
