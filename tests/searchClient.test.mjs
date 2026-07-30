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
					// Mirrors real Obsidian requestUrl: it throws when the status is 400+ UNLESS
					// the caller passes throw:false (RequestUrlParam.throw defaults to true). The
					// stub used to always return the response object regardless of status, which
					// is not what the real API does — a client that forgot throw:false would still
					// pass every test here even though every real 4xx/5xx would have thrown before
					// the client's own status branches ever ran.
					export async function requestUrl(options) {
						globalThis.__searchClientRequests.push(options);
						if (globalThis.__searchClientThrow) throw globalThis.__searchClientThrow;
						const response = globalThis.__searchClientResponse;
						const status = response && typeof response.status === 'number' ? response.status : undefined;
						if (status !== undefined && status >= 400 && options.throw !== false) {
							throw new Error('Request failed, status ' + status);
						}
						return response;
					}
				`,
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { SearchServiceClient, SearchServiceUnavailableError } = await import(pathToFileURL(outfile));

test('SearchServiceClient parses total and hasMore', async () => {
	globalThis.__searchClientThrow = undefined;
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

// `mode`/`semanticAvailable` must be whatever the client derived from the payload, not a
// literal baked into the fixture — that is the whole point of the companion computing them
// instead of hardcoding, and a test that never reads them back can't catch a regression to
// hardcoded values on either side.
test('SearchServiceClient reads mode and semanticAvailable from the payload, not a fixed literal', async () => {
	globalThis.__searchClientThrow = undefined;
	const client = new SearchServiceClient('http://search.local', 'vault');

	globalThis.__searchClientResponse = { status: 200, json: { mode: 'fts', semanticAvailable: false, results: [] } };
	const ftsOnly = await client.search({ query: 'x', limit: 1 });
	assert.equal(ftsOnly.mode, 'fts');
	assert.equal(ftsOnly.semanticAvailable, false);

	globalThis.__searchClientResponse = { status: 200, json: { mode: 'hybrid', semanticAvailable: true, results: [] } };
	const hybrid = await client.search({ query: 'x', limit: 1 });
	assert.equal(hybrid.mode, 'hybrid');
	assert.equal(hybrid.semanticAvailable, true);

	// A payload omitting both fields entirely (an older companion, or a stubbed test double)
	// must not be coerced to a truthy/falsy guess — both stay undefined.
	globalThis.__searchClientResponse = { status: 200, json: { results: [] } };
	const omitted = await client.search({ query: 'x', limit: 1 });
	assert.equal(omitted.mode, undefined);
	assert.equal(omitted.semanticAvailable, undefined);
});

// A vector-only hit is a genuinely new row shape from WP-1: no bm25 match (attribution.textRank
// is null, not a fabricated rank), a snippet synthesised from the chunk head instead of an FTS
// match, and its vector rank/score. The failure mode this guards is silent: the row exists on
// the companion but `normalizeSearchResponse`'s trailing `.filter(row => row.path && row.snippet)`
// could drop it with no error anywhere if either field went missing on the way through.
test('a vector-only result survives normalization intact', async () => {
	globalThis.__searchClientThrow = undefined;
	globalThis.__searchClientResponse = {
		status: 200,
		json: {
			mode: 'hybrid',
			semanticAvailable: true,
			results: [{
				chunkId: 'sem-1',
				path: 'Semantic.md',
				title: 'Semantic',
				snippet: 'gardening lawnmower rhubarb entirely unrelated prose',
				score: 0.031,
				scoreVector: 0.987,
				scoreRrf: 0.031,
				attribution: {
					base: -0,
					textRank: null,
					titleRank: null,
					vectorRank: 2,
					rrf: 0.031,
					pooledChunks: 1,
				},
			}],
		},
	};
	const client = new SearchServiceClient('http://search.local', 'vault');

	const response = await client.search({ query: 'sustained attention', limit: 10 });

	assert.equal(response.results.length, 1, 'the vector-only row must not be dropped by the trailing filter');
	const row = response.results[0];
	assert.equal(row.path, 'Semantic.md');
	assert.ok(row.snippet.length > 0);
	assert.equal(row.scoreVector, 0.987);
	assert.equal(row.attribution.vectorRank, 2);
	assert.equal(row.attribution.textRank, undefined, 'a null textRank normalizes to undefined, not 0 or a fabricated rank');
});

test('SearchServiceClient parses file states by path', async () => {
	globalThis.__searchClientThrow = undefined;
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

test('SearchServiceClient throws SearchServiceUnavailableError on a 5xx', async () => {
	globalThis.__searchClientThrow = undefined;
	globalThis.__searchClientRequests = [];
	globalThis.__searchClientResponse = { status: 503, text: 'overloaded', json: {} };
	const client = new SearchServiceClient('http://search.local', 'vault');

	await assert.rejects(client.search({ query: 'x', limit: 1 }), SearchServiceUnavailableError);
});

// An interactive request and a bulk write must not share one timeout. A search that hangs
// should give up quickly so the UI stops waiting; an upsert carries hundreds of chunks and is
// issued from the same main thread that synchronously chunks the batch's files, so the same
// 5s budget declared a healthy companion unreachable mid-rebuild and latched the queue.
test('SearchServiceClient times out a search fast but gives a bulk upsert a long budget', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	globalThis.__searchClientThrow = undefined;
	globalThis.__searchClientRequests = [];
	// Never resolves: the only thing that can settle these calls is the timeout.
	globalThis.__searchClientResponse = new Promise(() => {});
	const client = new SearchServiceClient('http://search.local', 'vault');
	// Drains the microtask queue so a rejection would have landed by the assertion below.
	// Deliberately not a timer-based yield: setTimeout is mocked in this test.
	const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

	const search = client.search({ query: 'x', limit: 1 });
	const searchOutcome = search.then(() => 'resolved', () => 'rejected');
	t.mock.timers.tick(5_001);
	assert.equal(await searchOutcome, 'rejected', 'the interactive timeout fires at 5s');

	const upsert = client.upsertChunks([{ id: 'c1', path: 'note.md', text: 'body' }]);
	let upsertSettled = false;
	upsert.then(() => { upsertSettled = true; }, () => { upsertSettled = true; });

	t.mock.timers.tick(5_001);
	await flush();
	assert.equal(upsertSettled, false, 'a bulk upsert must still be in flight well past the interactive timeout');

	t.mock.timers.tick(60_000);
	await assert.rejects(upsert, SearchServiceUnavailableError, 'but it does eventually time out rather than hanging forever');

	globalThis.__searchClientResponse = undefined;
});

test('SearchServiceClient throws SearchServiceUnavailableError when the request fails', async () => {
	globalThis.__searchClientRequests = [];
	globalThis.__searchClientThrow = new Error('ECONNREFUSED');
	const client = new SearchServiceClient('http://search.local', 'vault');

	await assert.rejects(client.health(), SearchServiceUnavailableError);
	globalThis.__searchClientThrow = undefined;
});

test('SearchServiceClient keeps a 4xx as a plain (non-retryable) Error', async () => {
	globalThis.__searchClientThrow = undefined;
	globalThis.__searchClientRequests = [];
	globalThis.__searchClientResponse = { status: 400, text: 'bad request', json: {} };
	const client = new SearchServiceClient('http://search.local', 'vault');

	await assert.rejects(client.search({ query: 'x', limit: 1 }), (err) => {
		assert.equal(err instanceof SearchServiceUnavailableError, false);
		assert.match(err.message, /returned 400/);
		return true;
	});
});

// F1 regression: Obsidian's requestUrl throws on any status >= 400 by default (RequestUrlParam
// `throw` defaults to true). Without an explicit `throw: false`, that default fires BEFORE the
// client's own status branches ever run, so every companion 4xx — including the deliberate
// width/space-conflict 400s — would land in the generic catch block and get misclassified as
// SearchServiceUnavailableError ("companion not reachable"), which the caller then defers and
// retries forever instead of surfacing as the non-retryable request bug it is. The test stub
// above now mirrors that real throw-on-4xx+ behavior, so this test would fail without the fix.
test('SearchServiceClient passes throw:false to requestUrl, so a 4xx surfaces via the client\'s own status branch', async () => {
	globalThis.__searchClientThrow = undefined;
	globalThis.__searchClientRequests = [];
	globalThis.__searchClientResponse = { status: 400, text: 'bad request', json: {} };
	const client = new SearchServiceClient('http://search.local', 'vault');

	await assert.rejects(client.search({ query: 'x', limit: 1 }), (err) => {
		assert.equal(err instanceof SearchServiceUnavailableError, false, 'a 4xx must never be misread as "companion not reachable"');
		assert.match(err.message, /returned 400/);
		assert.match(err.message, /bad request/, 'the response body\'s message must survive, not just the status code');
		return true;
	});
	assert.equal(globalThis.__searchClientRequests[0].throw, false, 'requestUrl must be called with throw:false');
});

test('SearchServiceClient throws SearchServiceUnavailableError with kind "server-error" on a 5xx', async () => {
	globalThis.__searchClientThrow = undefined;
	globalThis.__searchClientRequests = [];
	globalThis.__searchClientResponse = { status: 503, text: 'overloaded', json: {} };
	const client = new SearchServiceClient('http://search.local', 'vault');

	await assert.rejects(client.search({ query: 'x', limit: 1 }), (err) => {
		assert.ok(err instanceof SearchServiceUnavailableError);
		assert.equal(err.kind, 'server-error');
		return true;
	});
});

test('SearchServiceClient throws SearchServiceUnavailableError with kind "refused" when the request fails below the HTTP layer', async () => {
	globalThis.__searchClientRequests = [];
	globalThis.__searchClientThrow = new Error('ECONNREFUSED');
	const client = new SearchServiceClient('http://search.local', 'vault');

	await assert.rejects(client.health(), (err) => {
		assert.ok(err instanceof SearchServiceUnavailableError);
		assert.equal(err.kind, 'refused');
		return true;
	});
	globalThis.__searchClientThrow = undefined;
});

// WP-5: SearchServiceClient.search() now accepts a caller-supplied timeout (SearchManager
// threads the configurable `searchQueryTimeoutMs` setting through it) and derives the
// companion's own cooperative `budgetMs` from whatever timeout is actually in effect — so the
// two constants documented in client.ts (SEARCH_QUERY_BUDGET_FRACTION, 0.8) stay in the
// documented relationship (companion budget strictly below the client timeout) automatically.
test('SearchServiceClient.search() sends budgetMs derived from the timeout actually passed in', async () => {
	globalThis.__searchClientThrow = undefined;
	globalThis.__searchClientRequests = [];
	globalThis.__searchClientResponse = { status: 200, json: { results: [] } };
	const client = new SearchServiceClient('http://search.local', 'vault');

	await client.search({ query: 'x', limit: 1 });
	assert.equal(JSON.parse(globalThis.__searchClientRequests[0].body).budgetMs, 4000, 'default timeout (5000) * 0.8');

	globalThis.__searchClientRequests = [];
	await client.search({ query: 'x', limit: 1 }, 10_000);
	assert.equal(JSON.parse(globalThis.__searchClientRequests[0].body).budgetMs, 8000, 'a caller-supplied timeout (10000) * 0.8');
});

// Settings threading (WP-5): SearchManager passes a configured `searchQueryTimeoutMs` as the
// second argument to `search()`, which must actually change how long the client is willing to
// wait — not just what it tells the companion.
test('SearchServiceClient.search() respects a caller-supplied timeout, not just the 5s default', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	globalThis.__searchClientThrow = undefined;
	globalThis.__searchClientRequests = [];
	globalThis.__searchClientResponse = new Promise(() => {});
	const client = new SearchServiceClient('http://search.local', 'vault');
	const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

	const search = client.search({ query: 'x', limit: 1 }, 9000);
	let settled = false;
	search.then(() => { settled = true; }, () => { settled = true; });

	t.mock.timers.tick(5_001);
	await flush();
	assert.equal(settled, false, 'the 5s default must not fire when a longer timeout was explicitly passed');

	t.mock.timers.tick(4_000);
	await assert.rejects(search, SearchServiceUnavailableError);
	globalThis.__searchClientResponse = undefined;
});

// Additive-only, degraded-response tolerance (WP-5): a companion that hit its own cooperative
// deadline carries `degraded: true`; the client must surface it, and its absence — every
// existing/older companion response — must normalize to undefined, never a coerced false.
test('SearchServiceClient.search() surfaces a companion degraded flag, and tolerates its absence', async () => {
	globalThis.__searchClientThrow = undefined;

	globalThis.__searchClientResponse = { status: 200, json: { results: [], degraded: true } };
	const degraded = await new SearchServiceClient('http://search.local', 'vault').search({ query: 'x', limit: 1 });
	assert.equal(degraded.degraded, true);

	globalThis.__searchClientResponse = { status: 200, json: { results: [] } };
	const notDegraded = await new SearchServiceClient('http://search.local', 'vault').search({ query: 'x', limit: 1 });
	assert.equal(notDegraded.degraded, undefined, 'an older companion that never sends the field must normalize to undefined, not false');
});

test('SearchServiceClient throws SearchServiceUnavailableError with kind "timeout" when the request times out', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	globalThis.__searchClientThrow = undefined;
	globalThis.__searchClientRequests = [];
	globalThis.__searchClientResponse = new Promise(() => {});
	const client = new SearchServiceClient('http://search.local', 'vault');

	const search = client.search({ query: 'x', limit: 1 });
	const assertion = assert.rejects(search, (err) => {
		assert.ok(err instanceof SearchServiceUnavailableError);
		assert.equal(err.kind, 'timeout');
		return true;
	});
	t.mock.timers.tick(5_001);
	await assertion;
	globalThis.__searchClientResponse = undefined;
});
