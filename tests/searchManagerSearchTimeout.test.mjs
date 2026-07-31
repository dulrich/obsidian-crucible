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

// `providerManager` defaults to `{}` (unused unless a test enables semantic search) so every
// existing call site keeps working unmodified — WP-3's embed-latency test is the first one that
// needs a real (stubbed) `embed`.
function makeManager(overrides = {}, providerManager = {}) {
	const app = { metadataCache: { isUserIgnored: () => false } };
	const manager = new SearchManager(app, settings(overrides), providerManager);
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

// WP-SS1: SearchModal passes its per-request AbortController's signal as search()'s third
// argument, all the way through to SearchServiceClient.search()'s third argument — this pins
// that plumbing so a future refactor of either signature can't silently drop it.
test('SearchManager.search() threads an optional AbortSignal through to the client as the third argument', async () => {
	const manager = makeManager();
	const calls = [];
	manager.client = () => ({
		search: async (options, timeoutMs, signal) => {
			calls.push({ timeoutMs, signal });
			return { results: [] };
		},
	});
	const controller = new AbortController();

	await manager.search('needle', undefined, controller.signal);

	assert.equal(calls.length, 1);
	assert.equal(calls[0].signal, controller.signal, 'the exact signal instance must reach the client, not a copy or a stub');
});

// sweep() delegates to search() — SearchIndexWorkflow's sweep call site never passes a signal
// (it has no modal/generation concept), so this pins that the parameter threads through sweep()
// too without breaking that existing no-signal call.
test('SearchManager.sweep() threads an optional AbortSignal through to search(), and omitting it is still valid', async () => {
	const manager = makeManager();
	const calls = [];
	manager.client = () => ({
		search: async (options, timeoutMs, signal) => {
			calls.push({ signal });
			return { results: [] };
		},
	});
	const controller = new AbortController();

	await manager.sweep('a project brief', undefined, controller.signal);
	assert.equal(calls[0].signal, controller.signal);

	await manager.sweep('another brief');
	assert.equal(calls[1].signal, undefined, 'omitting the signal (the workflow call site) must still work');
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
		assert.match(logged, /\(13 terms, embed \d+ms\)/, 'term count and WP-3\'s embed latency must both be in the breadcrumb');
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

// WP-3: embedQuery() runs and is measured entirely BEFORE `startedAt` (the timed window's own
// clock read) — a cold embed must show up in the breadcrumb's `embed Xms` without moving
// `elapsedMs` (which is measured from `startedAt`, after the embed already finished) by the same
// amount. Overriding the module-global Date.now (same technique as
// searchManagerQueryEmbedding.test.mjs's cooldown test) lets the stubbed `embed` call advance the
// clock deterministically, rather than depending on real wall-clock timing.
test('SearchManager.search() breadcrumb reports embedMs, measured outside the timed window', async () => {
	globalThis.__CRUCIBLE_DEBUG__ = true;
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (...args) => { warnings.push(args); };

	const realNow = Date.now;
	let now = realNow();
	Date.now = () => now;
	try {
		const embed = async (_provider, _modelId, texts) => {
			now += 1234; // simulates a cold model load taking real wall-clock time
			return { embeddings: texts.map(() => [0.1, 0.2, 0.3]) };
		};
		const manager = makeManager({
			searchSemanticEnabled: true,
			searchEmbeddingModel: { providerId: 'p1', modelId: 'm1' },
		}, { embed });
		manager.client = () => ({
			search: async () => { throw new SearchServiceUnavailableError('Search service /v1/search timed out after 4000ms', 'timeout'); },
		});

		await assert.rejects(manager.search('needle'), SearchServiceUnavailableError);

		assert.equal(warnings.length, 1);
		const logged = warnings[0].join(' ');
		assert.match(logged, /embed 1234ms/, 'the measured embed latency must reach the breadcrumb');
		// elapsedMs is measured from `startedAt`, which is read AFTER the embed already
		// finished — so it must not also carry the 1234ms the embed took.
		assert.doesNotMatch(logged, /timed out after 1[23]\d\dms/, 'elapsedMs must not double-count the embed time the client.search() call never actually spent');
	} finally {
		console.warn = originalWarn;
		globalThis.__CRUCIBLE_DEBUG__ = false;
		Date.now = realNow;
	}
});
