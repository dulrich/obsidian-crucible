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
					//
					// WP-SS1: this remains the transport for every non-search endpoint, PLUS the
					// interactive search endpoint's CORS-fallback path (see the fetch stub below).
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

// WP-SS1: `SearchServiceClient.search()` now goes through the platform `fetch`, not
// `requestUrl` — every pre-existing test below that calls `.search(...)` needs a working global
// `fetch` stub to keep exercising the real client code (rather than silently making a real
// network call to `http://search.local`, which is what the native Node `fetch` would otherwise
// attempt). The stub deliberately reads the SAME `__searchClientResponse`/`__searchClientThrow`
// control globals the requestUrl stub above uses, so none of the pre-existing test bodies below
// need to change what they configure — only the new tests need their own dedicated
// `__searchClientFetchThrow` global (to force the CORS-fallback path specifically, which must
// NOT also make ordinary requestUrl-only endpoints fail).
//
// `init.signal` is honored: aborting it (either the caller's own `AbortSignal`, forwarded by the
// client's internal controller, or the client's own timeout firing) rejects this promise, the
// same as real `fetch`. A `__searchClientResponse` that is itself a pending Promise (used by the
// existing mock-timer tests to simulate "never answers") is never resolved except by that abort
// path — matching the requestUrl stub's identical convention for the same fixtures.
function makeFetchStub() {
	return function fetchStub(url, init = {}) {
		return new Promise((resolveFetch, rejectFetch) => {
			globalThis.__searchClientFetchRequests?.push({ url, method: init.method, headers: init.headers, body: init.body, signal: init.signal });
			let settled = false;
			const onAbort = () => {
				if (settled) return;
				settled = true;
				const err = new Error('The operation was aborted.');
				err.name = 'AbortError';
				rejectFetch(err);
			};
			const signal = init.signal;
			if (signal) {
				if (signal.aborted) { onAbort(); return; }
				signal.addEventListener('abort', onAbort);
			}
			if (globalThis.__searchClientFetchThrow) {
				settled = true;
				rejectFetch(globalThis.__searchClientFetchThrow);
				return;
			}
			const response = globalThis.__searchClientResponse;
			if (response && typeof response.then === 'function') return;
			settled = true;
			resolveFetch({
				status: response?.status,
				text: async () => (typeof response?.text === 'string' ? response.text : JSON.stringify(response?.json ?? {})),
			});
		});
	};
}

globalThis.fetch = makeFetchStub();

const {
	SearchServiceClient,
	SearchServiceUnavailableError,
	SearchAbortedError,
	__resetSearchFetchFallbackForTests,
	__resetSearchClientIdentityForTests,
} = await import(pathToFileURL(outfile));

// Every test starts from the same clean slate: fetch is tried first (the CORS-fallback latch is
// module-level/session-scoped in production for good reason — see client.ts — but that means a
// test that trips it would otherwise poison every later test in this same file/process). The
// WP-SS2 clientId/seq identity is the same story — module-level so it survives
// `SearchManager.client()` minting a fresh instance per call — so it needs the same per-test
// reset.
function resetGlobals() {
	__resetSearchFetchFallbackForTests();
	__resetSearchClientIdentityForTests();
	globalThis.__searchClientThrow = undefined;
	globalThis.__searchClientFetchThrow = undefined;
	globalThis.__searchClientRequests = [];
	globalThis.__searchClientFetchRequests = [];
}

test('SearchServiceClient parses total and hasMore', async () => {
	resetGlobals();
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
	assert.equal(JSON.parse(globalThis.__searchClientFetchRequests[0].body).limit, 12);
});

// `mode`/`semanticAvailable` must be whatever the client derived from the payload, not a
// literal baked into the fixture — that is the whole point of the companion computing them
// instead of hardcoding, and a test that never reads them back can't catch a regression to
// hardcoded values on either side.
test('SearchServiceClient reads mode and semanticAvailable from the payload, not a fixed literal', async () => {
	resetGlobals();
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
	resetGlobals();
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
	resetGlobals();
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
	// fileStates is an indexing-path endpoint (untouched by WP-SS1) and still goes through
	// requestUrl.
	assert.equal(JSON.parse(globalThis.__searchClientRequests[0].body).paths[0], 'note.md');
});

test('SearchServiceClient throws SearchServiceUnavailableError on a 5xx', async () => {
	resetGlobals();
	globalThis.__searchClientResponse = { status: 503, text: 'overloaded', json: {} };
	const client = new SearchServiceClient('http://search.local', 'vault');

	await assert.rejects(client.search({ query: 'x', limit: 1 }), SearchServiceUnavailableError);
});

// WP-SA2: `listPaths()` — the audit/reconcile commands' companion-side data source. Follows the
// SA1 wire contract exactly (sa-1-report.md): `{ok: true, paths: [...], totals: {...}}`.
test('SearchServiceClient.listPaths() parses rows and totals, and goes through requestUrl (not fetch)', async () => {
	resetGlobals();
	globalThis.__searchClientResponse = {
		status: 200,
		json: {
			ok: true,
			paths: [
				{ path: 'a.md', mtime: 100, contentHash: 'hash-a', chunkCount: 2, embeddedCount: 2 },
				{ path: 'b.md', mtime: 50, contentHash: '', chunkCount: 1, embeddedCount: 0 },
			],
			totals: { paths: 2, chunks: 3, embeddedChunks: 2 },
		},
	};
	const client = new SearchServiceClient('http://search.local', 'vault');

	const response = await client.listPaths();

	assert.deepEqual(response.paths[0], { path: 'a.md', mtime: 100, contentHash: 'hash-a', chunkCount: 2, embeddedCount: 2 });
	// An empty-string stored hash normalizes to undefined, per the SA1 contract.
	assert.equal(response.paths[1].contentHash, undefined);
	assert.deepEqual(response.totals, { paths: 2, chunks: 3, embeddedChunks: 2 });
	// listPaths is a bulk vault-wide read, the same shape as fileStates/upsertChunks/deletePath —
	// it must stay on the requestUrl transport, not the abortable interactive fetch path.
	assert.equal(JSON.parse(globalThis.__searchClientRequests[0].body).vaultId, 'vault');
	assert.equal(globalThis.__searchClientFetchRequests.length, 0);
});

test('SearchServiceClient.listPaths() degrades an unindexed/malformed payload to empty arrays and zeroed totals, never throws', async () => {
	resetGlobals();
	globalThis.__searchClientResponse = { status: 200, json: { ok: true, paths: [], totals: { paths: 0, chunks: 0, embeddedChunks: 0 } } };
	const client = new SearchServiceClient('http://search.local', 'vault');

	const response = await client.listPaths();

	assert.deepEqual(response, { paths: [], totals: { paths: 0, chunks: 0, embeddedChunks: 0 } });
});

// WP-SA2: normalizeHealth widened to pass through the full `/health` payload additively — every
// new field, plus proof the pre-existing fields (ok/version/schemaVersion/vectorAvailable/
// message) are unaffected.
test('SearchServiceClient.health() surfaces the full widened payload: version, schema, vector backend/model/dim, spaces, unattributed count', async () => {
	resetGlobals();
	globalThis.__searchClientResponse = {
		status: 200,
		json: {
			ok: true,
			version: '1.2.3',
			schemaVersion: 7,
			vectorAvailable: true,
			vectorBackend: 'flat',
			embeddedChunks: 4200,
			embeddingDim: 384,
			embeddingModel: 'bge-small-en-v1.5',
			embeddingSpaces: ['bge-small-en-v1.5/fp32'],
			embeddingSpace: 'bge-small-en-v1.5/fp32',
			unattributedEmbeddedChunks: 0,
		},
	};
	const client = new SearchServiceClient('http://search.local', 'vault');

	const health = await client.health();

	assert.equal(health.ok, true);
	assert.equal(health.version, '1.2.3');
	assert.equal(health.schemaVersion, 7);
	assert.equal(health.vectorAvailable, true);
	assert.equal(health.vectorBackend, 'flat');
	assert.equal(health.embeddedChunks, 4200);
	assert.equal(health.embeddingDim, 384);
	assert.equal(health.embeddingModel, 'bge-small-en-v1.5');
	assert.deepEqual(health.embeddingSpaces, ['bge-small-en-v1.5/fp32']);
	assert.equal(health.embeddingSpace, 'bge-small-en-v1.5/fp32');
	assert.equal(health.unattributedEmbeddedChunks, 0);
});

test('SearchServiceClient.health() flags a mixed index: multiple embeddingSpaces and a null embeddingSpace', async () => {
	resetGlobals();
	globalThis.__searchClientResponse = {
		status: 200,
		json: {
			ok: true,
			schemaVersion: 7,
			embeddingSpaces: ['model-a/fp32', 'model-b/f16'],
			embeddingSpace: null,
			unattributedEmbeddedChunks: 12,
		},
	};
	const client = new SearchServiceClient('http://search.local', 'vault');

	const health = await client.health();

	assert.deepEqual(health.embeddingSpaces, ['model-a/fp32', 'model-b/f16']);
	assert.equal(health.embeddingSpace, null);
	assert.equal(health.unattributedEmbeddedChunks, 12);
});

test('SearchServiceClient.health() degrades a companion that predates the widened fields to undefined, not coerced values', async () => {
	resetGlobals();
	globalThis.__searchClientResponse = { status: 200, json: { ok: true, version: '0.9.0', schemaVersion: 7 } };
	const client = new SearchServiceClient('http://search.local', 'vault');

	const health = await client.health();

	assert.equal(health.ok, true);
	assert.equal(health.version, '0.9.0');
	assert.equal(health.vectorBackend, undefined);
	assert.equal(health.embeddedChunks, undefined);
	assert.equal(health.embeddingDim, undefined);
	assert.equal(health.embeddingModel, undefined);
	assert.equal(health.embeddingSpaces, undefined);
	assert.equal(health.embeddingSpace, undefined);
	assert.equal(health.unattributedEmbeddedChunks, undefined);
});

// An interactive request and a bulk write must not share one timeout. A search that hangs
// should give up quickly so the UI stops waiting; an upsert carries hundreds of chunks and is
// issued from the same main thread that synchronously chunks the batch's files, so the same
// 5s budget declared a healthy companion unreachable mid-rebuild and latched the queue.
test('SearchServiceClient times out a search fast but gives a bulk upsert a long budget', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	resetGlobals();
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
	resetGlobals();
	globalThis.__searchClientThrow = new Error('ECONNREFUSED');
	const client = new SearchServiceClient('http://search.local', 'vault');

	await assert.rejects(client.health(), SearchServiceUnavailableError);
	globalThis.__searchClientThrow = undefined;
});

test('SearchServiceClient keeps a 4xx as a plain (non-retryable) Error', async () => {
	resetGlobals();
	globalThis.__searchClientResponse = { status: 400, text: 'bad request', json: {} };
	const client = new SearchServiceClient('http://search.local', 'vault');

	await assert.rejects(client.search({ query: 'x', limit: 1 }), (err) => {
		assert.equal(err instanceof SearchServiceUnavailableError, false);
		assert.match(err.message, /returned 400/);
		return true;
	});
});

// F1 regression, WP-SS1 rescoped: Obsidian's requestUrl throws on any status >= 400 by default
// (RequestUrlParam `throw` defaults to true), so every requestUrl call site must pass
// `throw: false` explicitly or a companion 4xx gets misclassified as
// SearchServiceUnavailableError ("companion not reachable") before the client's own status
// branch ever runs. `search()` itself no longer goes through requestUrl in its normal path (see
// the plain fetch-based 4xx test above, which needs no throw:false at all — fetch never throws
// on an HTTP status by construction), but it still falls back to requestUrl when fetch is
// structurally unusable (the CORS-fallback path), and that fallback call must carry the same
// safety property or a companion 4xx reached only after a CORS failure would silently become an
// infinite retry loop instead of the non-retryable request bug it is.
test('SearchServiceClient\'s requestUrl fallback still passes throw:false, so a 4xx surfaces via the client\'s own status branch', async () => {
	resetGlobals();
	globalThis.__searchClientFetchThrow = new TypeError('Failed to fetch');
	globalThis.__searchClientResponse = { status: 400, text: 'bad request', json: {} };
	const client = new SearchServiceClient('http://search.local', 'vault');

	await assert.rejects(client.search({ query: 'x', limit: 1 }), (err) => {
		assert.equal(err instanceof SearchServiceUnavailableError, false, 'a 4xx must never be misread as "companion not reachable"');
		assert.match(err.message, /returned 400/);
		assert.match(err.message, /bad request/, 'the response body\'s message must survive, not just the status code');
		return true;
	});
	assert.equal(globalThis.__searchClientRequests[0].throw, false, 'the requestUrl fallback must be called with throw:false');
});

test('SearchServiceClient throws SearchServiceUnavailableError with kind "server-error" on a 5xx', async () => {
	resetGlobals();
	globalThis.__searchClientResponse = { status: 503, text: 'overloaded', json: {} };
	const client = new SearchServiceClient('http://search.local', 'vault');

	await assert.rejects(client.search({ query: 'x', limit: 1 }), (err) => {
		assert.ok(err instanceof SearchServiceUnavailableError);
		assert.equal(err.kind, 'server-error');
		return true;
	});
});

test('SearchServiceClient throws SearchServiceUnavailableError with kind "refused" when the request fails below the HTTP layer', async () => {
	resetGlobals();
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
	resetGlobals();
	globalThis.__searchClientResponse = { status: 200, json: { results: [] } };
	const client = new SearchServiceClient('http://search.local', 'vault');

	await client.search({ query: 'x', limit: 1 });
	assert.equal(JSON.parse(globalThis.__searchClientFetchRequests[0].body).budgetMs, 4000, 'default timeout (5000) * 0.8');

	globalThis.__searchClientFetchRequests = [];
	await client.search({ query: 'x', limit: 1 }, 10_000);
	assert.equal(JSON.parse(globalThis.__searchClientFetchRequests[0].body).budgetMs, 8000, 'a caller-supplied timeout (10000) * 0.8');
});

// Settings threading (WP-5): SearchManager passes a configured `searchQueryTimeoutMs` as the
// second argument to `search()`, which must actually change how long the client is willing to
// wait — not just what it tells the companion.
test('SearchServiceClient.search() respects a caller-supplied timeout, not just the 5s default', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	resetGlobals();
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
	resetGlobals();

	globalThis.__searchClientResponse = { status: 200, json: { results: [], degraded: true } };
	const degraded = await new SearchServiceClient('http://search.local', 'vault').search({ query: 'x', limit: 1 });
	assert.equal(degraded.degraded, true);

	globalThis.__searchClientResponse = { status: 200, json: { results: [] } };
	const notDegraded = await new SearchServiceClient('http://search.local', 'vault').search({ query: 'x', limit: 1 });
	assert.equal(notDegraded.degraded, undefined, 'an older companion that never sends the field must normalize to undefined, not false');
});

// WP-3: `sentAt` is the client's own clock at send time, sent alongside `budgetMs` so the
// companion can start its cooperative deadline from send time instead of only from its own
// handler-dispatch clock (see resolveSearchDeadlineStart in scripts/search-companion.mjs).
// Additive and back-compatible both directions, same as `budgetMs` itself.
test('SearchServiceClient.search() sends sentAt as the current time', async () => {
	resetGlobals();
	globalThis.__searchClientResponse = { status: 200, json: { results: [] } };
	const client = new SearchServiceClient('http://search.local', 'vault');

	const before = Date.now();
	await client.search({ query: 'x', limit: 1 });
	const after = Date.now();

	const sentAt = JSON.parse(globalThis.__searchClientFetchRequests[0].body).sentAt;
	assert.equal(typeof sentAt, 'number');
	assert.ok(sentAt >= before && sentAt <= after, 'sentAt must be the client\'s own clock at send time');
});

test('SearchServiceClient throws SearchServiceUnavailableError with kind "timeout" when the request times out', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	resetGlobals();
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

/* ------------------------------------------------------------------------- WP-SS1: abort */

// The core acceptance case: SearchModal aborts its previous controller when a newer search
// supersedes it. This pins the mechanism one layer down — the client actually cancels the
// in-flight fetch and rejects with SearchAbortedError, rather than merely letting the caller
// discard a response that keeps computing on the wire.
test('SearchServiceClient.search() aborts the underlying fetch when the caller\'s AbortSignal fires, and rejects with SearchAbortedError', async () => {
	resetGlobals();
	globalThis.__searchClientResponse = new Promise(() => {}); // never resolves on its own
	const client = new SearchServiceClient('http://search.local', 'vault');
	const controller = new AbortController();

	const search = client.search({ query: 'x', limit: 1 }, 5000, controller.signal);
	// Give the fetch stub a microtask to register its abort listener before firing.
	await Promise.resolve();
	assert.equal(globalThis.__searchClientFetchRequests.length, 1, 'the request must actually have been sent (this is a supersede, not a debounce skip)');
	assert.equal(globalThis.__searchClientFetchRequests[0].signal.aborted, false, 'not aborted yet');

	controller.abort();

	await assert.rejects(search, SearchAbortedError);
	assert.equal(globalThis.__searchClientFetchRequests[0].signal.aborted, true, 'the request-scoped signal fired — the fetch was actually cancelled, not just abandoned');
});

test('SearchServiceClient.search() rejects immediately with SearchAbortedError when handed an already-aborted signal', async () => {
	resetGlobals();
	globalThis.__searchClientResponse = { status: 200, json: { results: [] } };
	const client = new SearchServiceClient('http://search.local', 'vault');
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(client.search({ query: 'x', limit: 1 }, 5000, controller.signal), SearchAbortedError);
});

// The client timeout must actually cancel the request now, not just race a timer against a
// promise it then abandons (the pre-WP-SS1 `withTimeout` behavior every other endpoint still
// uses) — a superseded/timed-out search used to keep running to completion on the companion
// regardless of what the client did locally.
test('SearchServiceClient.search()\'s own timeout aborts the fetch (not just abandons it), with kind "timeout" not treated as a supersede-abort', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	resetGlobals();
	globalThis.__searchClientResponse = new Promise(() => {});
	const client = new SearchServiceClient('http://search.local', 'vault');

	const search = client.search({ query: 'x', limit: 1 });
	const assertion = assert.rejects(search, (err) => {
		assert.ok(err instanceof SearchServiceUnavailableError, 'a genuine timeout is still the existing SearchServiceUnavailableError kind, not SearchAbortedError');
		assert.equal(err.kind, 'timeout');
		return true;
	});
	t.mock.timers.tick(5_001);
	await assertion;
	assert.equal(globalThis.__searchClientFetchRequests[0].signal.aborted, true, 'the timeout must actually cancel the fetch, not merely abandon it');
	globalThis.__searchClientResponse = undefined;
});

// Abort must never be misclassified as a companion failure — every caller that gates the
// availability latch / failure counters keys specifically on `instanceof
// SearchServiceUnavailableError` (CompanionAvailabilityGate.probe, SearchIndexWorkflow's
// runSearchWorkflow catch), so SearchAbortedError deliberately failing that check IS the
// contract that keeps an abort from ever tripping either.
test('an aborted search\'s error is not a SearchServiceUnavailableError of any kind (never trips the availability latch)', async () => {
	resetGlobals();
	globalThis.__searchClientResponse = new Promise(() => {});
	const client = new SearchServiceClient('http://search.local', 'vault');
	const controller = new AbortController();

	const search = client.search({ query: 'x', limit: 1 }, 5000, controller.signal);
	await Promise.resolve();
	controller.abort();

	await assert.rejects(search, (err) => {
		assert.equal(err instanceof SearchAbortedError, true);
		assert.equal(err instanceof SearchServiceUnavailableError, false, 'an abort must not be classifiable as a companion outage');
		return true;
	});
});

/* -------------------------------------------------------- WP-SS2: client identity (clientId/seq) */

// The pinned design decision (src/search/client.ts): clientId/seq are attached ONLY when the
// caller supplies a `signal` — the interactive search modal always passes one, the background
// SearchIndexWorkflow.sweep() never does. A signal-less call is exactly the sweep's shape, so
// this is what proves a sweep search stays byte-identical to today's wire body.
test('search() without a signal sends no clientId/seq at all', async () => {
	resetGlobals();
	globalThis.__searchClientResponse = { status: 200, json: { results: [] } };
	const client = new SearchServiceClient('http://search.local', 'vault');

	await client.search({ query: 'x', limit: 1 });

	const body = JSON.parse(globalThis.__searchClientFetchRequests[0].body);
	assert.equal('clientId' in body, false, 'a signal-less request (e.g. the background sweep) must carry no clientId at all — not even undefined, which JSON.stringify would already drop, but proven here on the actual wire body');
	assert.equal('seq' in body, false);
});

// The core acceptance case: a signal-bearing caller (the interactive modal) gets a stable
// per-session clientId and a strictly monotonic seq across calls, so the companion's supersede
// tracker (scripts/search-companion/searchClients.mjs) can tell two requests from the same
// session apart and order them.
test('search() with a signal attaches a stable clientId and a monotonically increasing seq', async () => {
	resetGlobals();
	globalThis.__searchClientResponse = { status: 200, json: { results: [] } };
	const client = new SearchServiceClient('http://search.local', 'vault');
	const controller = new AbortController();

	await client.search({ query: 'first', limit: 1 }, 5000, controller.signal);
	await client.search({ query: 'second', limit: 1 }, 5000, controller.signal);
	await client.search({ query: 'third', limit: 1 }, 5000, controller.signal);

	const bodies = globalThis.__searchClientFetchRequests.map(r => JSON.parse(r.body));
	assert.equal(bodies.length, 3);
	const clientIds = bodies.map(b => b.clientId);
	assert.equal(typeof clientIds[0], 'string');
	assert.ok(clientIds[0].length > 0);
	assert.deepEqual(clientIds, [clientIds[0], clientIds[0], clientIds[0]], 'the same session must reuse one stable clientId across searches, not mint a fresh one per call');

	const seqs = bodies.map(b => b.seq);
	assert.equal(typeof seqs[0], 'number');
	assert.ok(seqs[1] > seqs[0], 'seq must strictly increase across calls');
	assert.ok(seqs[2] > seqs[1]);
});

// `SearchManager.client()` mints a fresh `SearchServiceClient` per call (the pinned design
// rationale for keeping this state module-level, not per-instance) — a second client instance in
// the same session must still see the SAME clientId and a seq counter that keeps advancing
// rather than resetting, or the companion's supersede tracker would see every new
// `SearchServiceClient` as a brand-new, unrelated session.
test('a fresh SearchServiceClient instance in the same session reuses the module-level clientId and keeps advancing the same seq counter', async () => {
	resetGlobals();
	globalThis.__searchClientResponse = { status: 200, json: { results: [] } };
	const controller = new AbortController();

	const clientA = new SearchServiceClient('http://search.local', 'vault');
	await clientA.search({ query: 'first', limit: 1 }, 5000, controller.signal);

	const clientB = new SearchServiceClient('http://search.local', 'vault');
	await clientB.search({ query: 'second', limit: 1 }, 5000, controller.signal);

	const bodies = globalThis.__searchClientFetchRequests.map(r => JSON.parse(r.body));
	assert.equal(bodies[0].clientId, bodies[1].clientId, 'a fresh client instance is still the same session');
	assert.ok(bodies[1].seq > bodies[0].seq, 'the counter must not reset for a new SearchServiceClient instance');
});

/* -------------------------------------------------------------- WP-SS1: CORS/network fallback */

// `fetch` is not verifiable headlessly against Electron's real CORS behavior (see the SS1
// brief), so the client must degrade instead of breaking: a `TypeError` thrown by `fetch` itself
// — the shape both a CORS rejection and a plain "can't reach the host" failure share, with no
// reliable way to tell them apart from the caller's side of the Fetch API — permanently falls
// back to the always-worked `requestUrl` transport for the rest of the session, retrying the
// SAME request rather than losing it.
test('a CORS/network-shaped fetch TypeError falls back to requestUrl for that request, and logs exactly one warning', async () => {
	globalThis.__CRUCIBLE_DEBUG__ = true;
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (...args) => { warnings.push(args); };

	try {
		resetGlobals();
		globalThis.__searchClientFetchThrow = new TypeError('Failed to fetch');
		globalThis.__searchClientResponse = { status: 200, json: { results: [], mode: 'fts' } };
		const client = new SearchServiceClient('http://search.local', 'vault');

		const response = await client.search({ query: 'x', limit: 1 });

		assert.equal(response.mode, 'fts', 'the fallback request still returns a real, usable response');
		assert.equal(globalThis.__searchClientFetchRequests.length, 1, 'fetch was attempted once');
		assert.equal(globalThis.__searchClientRequests.length, 1, 'and retried exactly once via requestUrl, not dropped');
		assert.equal(JSON.parse(globalThis.__searchClientRequests[0].body).query, 'x', 'the SAME request body, not a re-derived one');
		assert.equal(warnings.length, 1, 'exactly one logWarn for the fallback transition');
		assert.match(warnings[0].join(' '), /falling back to requestUrl/);
	} finally {
		console.warn = originalWarn;
		globalThis.__CRUCIBLE_DEBUG__ = false;
	}
});

test('the CORS-fallback latch stays on for the rest of the session: a second search skips fetch entirely and logs no further warning', async () => {
	globalThis.__CRUCIBLE_DEBUG__ = true;
	const warnings = [];
	const originalWarn = console.warn;
	console.warn = (...args) => { warnings.push(args); };

	try {
		resetGlobals();
		globalThis.__searchClientFetchThrow = new TypeError('Failed to fetch');
		globalThis.__searchClientResponse = { status: 200, json: { results: [] } };
		const client = new SearchServiceClient('http://search.local', 'vault');

		await client.search({ query: 'first', limit: 1 });
		assert.equal(warnings.length, 1);
		assert.equal(globalThis.__searchClientFetchRequests.length, 1);

		// Even though __searchClientFetchThrow is still set, a second search must not attempt
		// fetch at all now that the session-scoped latch is on — it should go straight to
		// requestUrl and succeed without ever touching the fetch stub again.
		globalThis.__searchClientResponse = { status: 200, json: { results: [], mode: 'hybrid' } };
		const response = await client.search({ query: 'second', limit: 1 });

		assert.equal(response.mode, 'hybrid');
		assert.equal(globalThis.__searchClientFetchRequests.length, 1, 'fetch must not be attempted again once the fallback latch is on');
		assert.equal(globalThis.__searchClientRequests.length, 2, 'both requests landed via requestUrl');
		assert.equal(warnings.length, 1, 'no repeat warning for a latch that is already on');
	} finally {
		console.warn = originalWarn;
		globalThis.__CRUCIBLE_DEBUG__ = false;
	}
});

// The fallback is scoped to the interactive search endpoint specifically — an unrelated fetch
// failure must never make a non-search endpoint's requestUrl call somehow route through fetch
// (there is no such path) or otherwise misbehave.
test('a fetch TypeError does not affect non-search endpoints, which were never routed through fetch to begin with', async () => {
	resetGlobals();
	globalThis.__searchClientFetchThrow = new TypeError('Failed to fetch');
	globalThis.__searchClientResponse = { status: 200, json: { files: [] } };
	const client = new SearchServiceClient('http://search.local', 'vault');

	const states = await client.fileStates(['note.md']);
	assert.equal(states.size, 0);
	assert.equal(globalThis.__searchClientFetchRequests.length, 0, 'fileStates never touches fetch');
	assert.equal(globalThis.__searchClientRequests.length, 1);
});
