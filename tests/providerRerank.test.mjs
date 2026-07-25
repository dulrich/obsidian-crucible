import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// ── Bundle src/providers.ts with a stub 'obsidian' module ──────────────────────
//
// Same technique as tests/secretRegistry.test.mjs / tests/searchClient.test.mjs: providers.ts
// (and its transitive imports — providers/openaiCompatible.ts, providers/ollama.ts,
// providers/cli.ts, src/types.ts) reference 'obsidian' only for the handful of exports used
// here. requestUrl is wired to a global responder so each test controls exactly what the
// "server" returns, and every request is recorded so a test can assert on the URL/body it sent.
const providersOutdir = path.join(tmpdir(), 'obsidian-crucible-provider-rerank-tests');
const providersOutfile = path.join(providersOutdir, 'providers.mjs');

await rm(providersOutdir, { recursive: true, force: true });
await mkdir(providersOutdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/providers.ts'],
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
					export class Notice { constructor() {} }
					export function normalizePath(p) { return p; }
					export async function requestUrl(options) {
						globalThis.__providerRequests.push(options);
						if (typeof globalThis.__providerResponder !== 'function') {
							throw new Error('no responder configured for this test');
						}
						return await globalThis.__providerResponder(options);
					}
				`,
				loader: 'js',
			}));
		},
	}],
	outfile: providersOutfile,
	logLevel: 'silent',
});

const { ProviderManager } = await import(pathToFileURL(providersOutfile).href);

// Minimal SecretRegistry stub: rerank never needs a real key for the local/ollama providers
// exercised here, but httpContext() always calls loadApiKey(), so `get` must resolve.
const fakeSecrets = { get: async () => 'test-key' };
const fakeApp = {};

function resetRequests() {
	globalThis.__providerRequests = [];
	globalThis.__providerResponder = undefined;
}

// ── 1. Out-of-order `index` values reorder the right documents ─────────────────
//
// The whole point of `index` is that it names a position in the *request's* `documents` array,
// independent of where that entry sits in the response's `results` array. A fixture whose
// results already arrive in document order can't catch a "map by position" bug — this one
// deliberately ships them shuffled.

test('rerank maps results back by index, not by position in the results array', async () => {
	resetRequests();
	globalThis.__providerResponder = async (options) => {
		assert.equal(options.url, 'http://127.0.0.1:4803/rerank');
		const body = JSON.parse(options.body);
		assert.deepEqual(body.documents, ['doc-zero', 'doc-one', 'doc-two']);
		return {
			status: 200,
			json: {
				object: 'rerank',
				model: body.model,
				results: [
					// Deliberately out of both index order and (0.9 > 0.5 > 0.1) score order relative
					// to their documents-array position.
					{ index: 2, relevance_score: 0.9, document: null },
					{ index: 0, relevance_score: 0.1, document: null },
					{ index: 1, relevance_score: 0.5, document: null },
				],
				usage: {},
				id: 'x',
				created: 0,
			},
		};
	};

	const provider = {
		id: 'reranker', name: 'Local Reranker', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:4803',
		models: [{ id: 'bge-reranker-v2-m3', label: 'bge-reranker-v2-m3' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const result = await manager.rerank(provider, 'bge-reranker-v2-m3', 'query text', ['doc-zero', 'doc-one', 'doc-two']);

	const byIndex = new Map(result.results.map(r => [r.index, r.relevanceScore]));
	assert.equal(byIndex.get(0), 0.1);
	assert.equal(byIndex.get(1), 0.5);
	assert.equal(byIndex.get(2), 0.9);
});

// ── 2. Fallback routing + the precise unsupported-capability error ─────────────

test('a provider without native rerank() routes to the complete()-based fallback', async () => {
	resetRequests();
	globalThis.__providerResponder = async (options) => {
		assert.match(options.url, /\/api\/chat$/);
		return {
			status: 200,
			json: {
				message: {
					content: JSON.stringify({
						results: [
							{ index: 0, relevance_score: 0.2 },
							{ index: 1, relevance_score: 0.8 },
						],
					}),
				},
				done_reason: 'stop',
			},
		};
	};

	const provider = {
		id: 'local-ollama', name: 'Ollama', kind: 'ollama',
		baseUrl: 'http://localhost:11434',
		models: [{ id: 'qwen3.5', label: 'qwen3.5' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const result = await manager.rerank(provider, 'qwen3.5', 'query', ['doc-a', 'doc-b']);

	assert.equal(globalThis.__providerRequests.length, 1);
	const byIndex = new Map(result.results.map(r => [r.index, r.relevanceScore]));
	assert.equal(byIndex.get(0), 0.2);
	assert.equal(byIndex.get(1), 0.8);
});

test('a provider kind with neither native rerank nor a working complete() yields a precise error, not a crash', async () => {
	resetRequests();
	const provider = {
		id: 'unregistered', name: 'Unregistered', kind: 'made-up-kind',
		models: [{ id: 'whatever', label: 'whatever' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);

	await assert.rejects(
		manager.rerank(provider, 'whatever', 'query', ['doc-a']),
		(err) => {
			assert.match(err.message, /Unsupported provider kind: made-up-kind/);
			return true;
		},
	);
	// Never fell through to an HTTP call for either backend.
	assert.equal(globalThis.__providerRequests.length, 0);
});

// ── 5. A malformed/partial rerank response degrades (throws), never corrupts or truncates ──

test('a native rerank response missing the results array throws rather than silently degrading', async () => {
	resetRequests();
	globalThis.__providerResponder = async () => ({ status: 200, json: { object: 'rerank', model: 'm' } });
	const provider = {
		id: 'reranker', name: 'Local Reranker', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:4803',
		models: [{ id: 'bge-reranker-v2-m3', label: 'bge' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	await assert.rejects(
		manager.rerank(provider, 'bge-reranker-v2-m3', 'query', ['doc-a', 'doc-b']),
		/results array/,
	);
});

test('a non-numeric relevance_score throws rather than being coerced or dropped', async () => {
	resetRequests();
	globalThis.__providerResponder = async () => ({
		status: 200,
		json: { results: [{ index: 0, relevance_score: 'high' }, { index: 1, relevance_score: 0.5 }] },
	});
	const provider = {
		id: 'reranker', name: 'Local Reranker', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:4803',
		models: [{ id: 'bge-reranker-v2-m3', label: 'bge' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	await assert.rejects(
		manager.rerank(provider, 'bge-reranker-v2-m3', 'query', ['doc-a', 'doc-b']),
		/non-numeric relevance_score/,
	);
});

test('fewer results than documents throws rather than silently truncating the result set', async () => {
	resetRequests();
	globalThis.__providerResponder = async () => ({
		status: 200,
		json: { results: [{ index: 0, relevance_score: 0.7 }] }, // 1 result for 3 documents
	});
	const provider = {
		id: 'reranker', name: 'Local Reranker', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:4803',
		models: [{ id: 'bge-reranker-v2-m3', label: 'bge' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	await assert.rejects(
		manager.rerank(provider, 'bge-reranker-v2-m3', 'query', ['doc-a', 'doc-b', 'doc-c']),
		/returned 1 results for 3 documents/,
	);
});

test('a fallback completion that is not valid JSON throws with the parser reason rather than fabricating scores', async () => {
	resetRequests();
	globalThis.__providerResponder = async () => ({
		status: 200,
		json: { message: { content: 'I cannot rank these, sorry.' }, done_reason: 'stop' },
	});
	const provider = {
		id: 'local-ollama', name: 'Ollama', kind: 'ollama',
		baseUrl: 'http://localhost:11434',
		models: [{ id: 'qwen3.5', label: 'qwen3.5' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	await assert.rejects(
		manager.rerank(provider, 'qwen3.5', 'query', ['doc-a']),
		/Rerank fallback response was not usable/,
	);
});

// ── 3. Rerank is never reachable from the input handler ────────────────────────
//
// SearchModal.ts is an Obsidian Modal — instantiating it needs a full DOM. Rather than fake one,
// this asserts directly against the source: the `input` event listener that drives type-ahead
// (SEARCH_TYPEAHEAD_DEBOUNCE_MS / shouldAutoSearch) must not, anywhere in its callback body,
// reference the rerank action. Bracket-counted rather than a fixed-width regex so the assertion
// survives reformatting of the listener body.

test('the input event listener body never references rerank', async () => {
	const source = await readFile('src/search/SearchModal.ts', 'utf8');
	const marker = "addEventListener('input'";
	const markerIndex = source.indexOf(marker);
	assert.notEqual(markerIndex, -1, 'expected an input event listener in SearchModal.ts');

	// Walk forward from the marker to the opening brace of the arrow function body, then count
	// braces to find its matching close.
	const bodyStart = source.indexOf('{', source.indexOf('=>', markerIndex));
	assert.notEqual(bodyStart, -1);
	let depth = 0;
	let bodyEnd = -1;
	for (let i = bodyStart; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) { bodyEnd = i; break; }
		}
	}
	assert.notEqual(bodyEnd, -1, 'unbalanced braces while scanning the input listener body');

	const listenerBody = source.slice(bodyStart, bodyEnd + 1);
	assert.doesNotMatch(listenerBody.toLowerCase(), /rerank/);
});

// ── 4. A rerank resolving after a newer search is discarded by the generation counter ──
//
// Bundles the real SearchModal.ts purely to reach its exported pure helpers
// (isRerankStale/buildRerankRowMeta/formatRerankRow), the same technique
// tests/searchModalFormat.test.mjs uses for formatScore/formatAttribution — nothing here
// instantiates a Modal.

const modalOutdir = path.join(tmpdir(), 'obsidian-crucible-search-modal-rerank-tests');
const modalOutfile = path.join(modalOutdir, 'SearchModal.mjs');

await rm(modalOutdir, { recursive: true, force: true });
await mkdir(modalOutdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/SearchModal.ts'],
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
					export class Modal { constructor() {} }
					export class Notice { constructor() {} }
					export class TFile {}
					export function debounce(fn) { return fn; }
					export function setIcon() {}
				`,
				loader: 'js',
			}));
		},
	}],
	outfile: modalOutfile,
	logLevel: 'silent',
});

const { isRerankStale, buildRerankRowMeta, formatRerankRow } = await import(pathToFileURL(modalOutfile).href);

test('isRerankStale: unchanged generation is not stale, a bumped one is', () => {
	assert.equal(isRerankStale(3, 3), false);
	assert.equal(isRerankStale(3, 4), true);
});

test('a rerank that resolves after a newer search would be discarded (generation mismatch)', () => {
	// This mirrors what SearchModal.runRerank() does: snapshot the generation before awaiting,
	// then — once the (here, already-resolved) outcome is in hand — check staleness before
	// touching any modal state. A caller that skips this check is exactly the type-ahead-unsafe
	// bug the searchGeneration counter exists to prevent.
	const issuedGeneration = 5;
	const currentGenerationAfterNewerSearch = 6; // a fresh runSearch() bumped it while we awaited
	const outcome = {
		results: [{ chunkId: 'a', path: 'a.md', title: 'A', snippet: '' }],
		scores: new Map([['a', 0.99]]),
	};

	let rendered = null;
	if (!isRerankStale(issuedGeneration, currentGenerationAfterNewerSearch)) {
		rendered = outcome; // would only happen if the guard were missing/broken
	}
	assert.equal(rendered, null, 'a stale rerank outcome must never be applied to modal state');
});

test('buildRerankRowMeta maps before/after rank and score by chunkId, including reordering', () => {
	const before = [
		{ chunkId: 'a', path: 'a.md', title: 'A', snippet: '' },
		{ chunkId: 'b', path: 'b.md', title: 'B', snippet: '' },
		{ chunkId: 'c', path: 'c.md', title: 'C', snippet: '' },
	];
	// Reranked: c moved from #3 to #1, a stayed at #2... wait — after excludes b intentionally
	// to model a result beyond the reranked top-N (no score => no row meta at all).
	const outcome = {
		results: [
			{ chunkId: 'c', path: 'c.md', title: 'C', snippet: '' },
			{ chunkId: 'a', path: 'a.md', title: 'A', snippet: '' },
			{ chunkId: 'b', path: 'b.md', title: 'B', snippet: '' },
		],
		scores: new Map([['c', 0.9], ['a', 0.4]]), // b was beyond top-N: no score
	};

	const meta = buildRerankRowMeta(before, outcome);
	assert.deepEqual(meta.get('c'), { beforeRank: 3, afterRank: 1, relevanceScore: 0.9 });
	assert.deepEqual(meta.get('a'), { beforeRank: 1, afterRank: 2, relevanceScore: 0.4 });
	assert.equal(meta.has('b'), false);
});

test('formatRerankRow renders an explicit "(unchanged)" when the rank did not move', () => {
	assert.match(formatRerankRow({ beforeRank: 3, afterRank: 3, relevanceScore: 0.5 }), /#3 \(unchanged\)/);
	assert.match(formatRerankRow({ beforeRank: 7, afterRank: 2, relevanceScore: 0.93 }), /#7 → #2/);
});
