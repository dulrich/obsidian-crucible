import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// ── Bundle src/providers.ts with a stub 'obsidian' module ──────────────────────
//
// Same technique as tests/providerRerank.test.mjs / tests/imageDescriptionProvider.test.mjs:
// providers.ts (and its transitive imports — providers/openaiCompatible.ts, providers/shared.ts,
// src/types.ts) reference 'obsidian' only for the handful of exports used here. requestUrl is
// wired to a global responder so each test controls exactly what the "server" returns and when
// it settles — the timing control is the point, since these tests assert on request *order* and
// *concurrency*, not just final results.
const outdir = path.join(tmpdir(), 'obsidian-crucible-provider-concurrency-tests');
const outfile = path.join(outdir, 'providers.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
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
	outfile,
	logLevel: 'silent',
});

const { ProviderManager, resolveProviderConcurrencyLimit } = await import(pathToFileURL(outfile).href);

const fakeSecrets = { get: async () => 'test-key' };
const fakeApp = {};

function resetRequests() {
	globalThis.__providerRequests = [];
	globalThis.__providerResponder = undefined;
}

// A controllable in-flight HTTP call: requestUrl won't settle until `resolve`/`reject` is called
// from the test. Lets a test observe "has the next queued call been dispatched yet" before
// letting the current one finish.
function createDeferred() {
	let resolve, reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function chatOkResponse(text = 'ok') {
	return { status: 200, json: { choices: [{ message: { content: text } }] } };
}

// Lets every request in flight settle before the next assertion — `run()`'s "immediate" path
// still awaits one `Promise.resolve()` tick before calling fn(), so a bare synchronous check
// right after kicking off calls is not reliable.
function flush() {
	return new Promise(resolve => setTimeout(resolve, 0));
}

const imageBytes = new TextEncoder().encode('fake-image-bytes').buffer;

function localProvider(id = 'local-lmstudio') {
	return { id, name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', models: [{ id: 'gemma-4', label: 'gemma-4' }] };
}

function cloudProvider(id = 'openai-main') {
	return { id, name: 'OpenAI', kind: 'openai', models: [{ id: 'gpt-4o', label: 'gpt-4o' }] };
}

// ── resolveProviderConcurrencyLimit: default resolution ─────────────────────

test('resolveProviderConcurrencyLimit: local (openai-compatible) provider defaults to 1', () => {
	assert.equal(resolveProviderConcurrencyLimit(localProvider()), 1);
});

test('resolveProviderConcurrencyLimit: cloud provider defaults to unlimited (Infinity)', () => {
	assert.equal(resolveProviderConcurrencyLimit(cloudProvider()), Infinity);
	assert.equal(resolveProviderConcurrencyLimit({ id: 'openrouter-1', kind: 'openrouter', models: [] }), Infinity);
});

test('resolveProviderConcurrencyLimit: a CLI provider (not the local HTTP heuristic) also defaults to unlimited', () => {
	assert.equal(resolveProviderConcurrencyLimit({ id: 'claude-cli-1', kind: 'claude-cli', models: [] }), Infinity);
});

test('resolveProviderConcurrencyLimit: an explicit positive value always overrides the default, for both local and cloud', () => {
	assert.equal(resolveProviderConcurrencyLimit({ ...localProvider(), maxConcurrentRequests: 3 }), 3);
	assert.equal(resolveProviderConcurrencyLimit({ ...cloudProvider(), maxConcurrentRequests: 2 }), 2);
});

test('resolveProviderConcurrencyLimit: zero, negative or non-finite explicit values fall back to the default rather than disabling the limiter', () => {
	assert.equal(resolveProviderConcurrencyLimit({ ...localProvider(), maxConcurrentRequests: 0 }), 1);
	assert.equal(resolveProviderConcurrencyLimit({ ...localProvider(), maxConcurrentRequests: -5 }), 1);
	assert.equal(resolveProviderConcurrencyLimit({ ...cloudProvider(), maxConcurrentRequests: NaN }), Infinity);
});

// ── FIFO ordering at limit 1 ─────────────────────────────────────────────────

test('ProviderManager.complete: two calls against a local (limit-1) provider serialize FIFO — the second never dispatches until the first settles', async () => {
	resetRequests();
	const deferreds = [];
	globalThis.__providerResponder = async () => {
		const d = createDeferred();
		deferreds.push(d);
		return d.promise;
	};

	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const provider = localProvider();

	const order = [];
	const callA = manager.complete(provider, 'gemma-4', 'sys', 'A').then(r => { order.push('A'); return r; });
	const callB = manager.complete(provider, 'gemma-4', 'sys', 'B').then(r => { order.push('B'); return r; });

	await flush();
	assert.equal(globalThis.__providerRequests.length, 1, 'the second call must not dispatch its HTTP request while the first holds the only slot');

	deferreds[0].resolve(chatOkResponse('first'));
	await flush();
	assert.equal(globalThis.__providerRequests.length, 2, 'releasing the first slot lets the queued second call dispatch');

	deferreds[1].resolve(chatOkResponse('second'));
	await Promise.all([callA, callB]);
	assert.deepEqual(order, ['A', 'B'], 'FIFO: the call that queued first also settles first');
});

test('ProviderManager.complete: a third call against a local provider queues behind both, FIFO', async () => {
	resetRequests();
	const deferreds = [];
	globalThis.__providerResponder = async () => {
		const d = createDeferred();
		deferreds.push(d);
		return d.promise;
	};

	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const provider = localProvider();

	const order = [];
	const calls = ['A', 'B', 'C'].map(label => manager.complete(provider, 'gemma-4', 'sys', label).then(r => { order.push(label); return r; }));

	await flush();
	assert.equal(globalThis.__providerRequests.length, 1);

	deferreds[0].resolve(chatOkResponse());
	await flush();
	assert.equal(globalThis.__providerRequests.length, 2);

	deferreds[1].resolve(chatOkResponse());
	await flush();
	assert.equal(globalThis.__providerRequests.length, 3);

	deferreds[2].resolve(chatOkResponse());
	await Promise.all(calls);
	assert.deepEqual(order, ['A', 'B', 'C']);
});

// ── Concurrent when limit is absent (cloud / unlimited) ──────────────────────

test('ProviderManager.complete: two calls against a cloud (unlimited) provider both dispatch immediately, without waiting on each other', async () => {
	resetRequests();
	const deferreds = [];
	globalThis.__providerResponder = async () => {
		const d = createDeferred();
		deferreds.push(d);
		return d.promise;
	};

	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const provider = cloudProvider();

	const callA = manager.complete(provider, 'gpt-4o', 'sys', 'A');
	const callB = manager.complete(provider, 'gpt-4o', 'sys', 'B');

	await flush();
	assert.equal(globalThis.__providerRequests.length, 2, 'an unlimited provider dispatches both requests without either settling first');

	deferreds[0].resolve(chatOkResponse('a'));
	deferreds[1].resolve(chatOkResponse('b'));
	await Promise.all([callA, callB]);
});

test('ProviderManager.complete: an explicit maxConcurrentRequests raises a local provider above its default-1 serialization', async () => {
	resetRequests();
	const deferreds = [];
	globalThis.__providerResponder = async () => {
		const d = createDeferred();
		deferreds.push(d);
		return d.promise;
	};

	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const provider = { ...localProvider(), maxConcurrentRequests: 2 };

	const callA = manager.complete(provider, 'gemma-4', 'sys', 'A');
	const callB = manager.complete(provider, 'gemma-4', 'sys', 'B');

	await flush();
	assert.equal(globalThis.__providerRequests.length, 2, 'limit 2 lets both calls dispatch at once');

	deferreds[0].resolve(chatOkResponse('a'));
	deferreds[1].resolve(chatOkResponse('b'));
	await Promise.all([callA, callB]);
});

// ── embed() is exempt from the limiter ───────────────────────────────────────

test('ProviderManager.embed: concurrent embed calls on a local (limit-1) provider are NOT gated — embeddings are a different model/latency class', async () => {
	resetRequests();
	const embedDeferreds = [];
	globalThis.__providerResponder = async (options) => {
		if (!options.url.endsWith('/embeddings')) {
			// A describeModel side-effect probe (probeModelForSideEffects) — answer immediately and
			// harmlessly so it never blocks; only the embeddings endpoint itself is deferred.
			return { status: 404, json: {} };
		}
		const d = createDeferred();
		embedDeferreds.push(d);
		return d.promise;
	};

	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const provider = localProvider();

	const callA = manager.embed(provider, 'gemma-4', ['a']);
	const callB = manager.embed(provider, 'gemma-4', ['b']);

	await flush();
	const embedRequests = globalThis.__providerRequests.filter(r => r.url.endsWith('/embeddings'));
	assert.equal(embedRequests.length, 2, 'both embed calls dispatch immediately even though the same provider caps completion-class calls at 1');

	for (const d of embedDeferreds) {
		d.resolve({ status: 200, json: { data: [{ embedding: [0.1, 0.2], index: 0 }] } });
	}
	await Promise.all([callA, callB]);
});

// ── Release-on-settle, not release-on-abandon ────────────────────────────────

test('ProviderManager.describeImage: a caller-side race (withTimeout-style) that abandons the first call does NOT free its slot early — the second call stays queued until the underlying request actually settles', async () => {
	resetRequests();
	const deferreds = [];
	globalThis.__providerResponder = async () => {
		const d = createDeferred();
		deferreds.push(d);
		return d.promise;
	};

	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const provider = localProvider();

	// The real caller (orchestration/utils/imageDescribe.ts withTimeout) races the provider call
	// against a timer and moves on when the timer wins — but never cancels the underlying
	// requestUrl promise, which keeps running (and, per the load-bearing comment on
	// ProviderConcurrencyLimiter.run, keeps holding its concurrency slot) regardless.
	const callA = manager.describeImage(provider, 'gemma-4', imageBytes, 'image/png', 'narrative');
	callA.catch(() => {}); // never actually rejects here, but keep the harness pattern symmetric with withTimeout's own test

	const timeout = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('caller timed out')), 5));
	await assert.rejects(() => Promise.race([callA, timeout]), /caller timed out/);

	// The caller has "abandoned" callA. A second describeImage call for the same provider must
	// still queue behind it — its HTTP request must not have been dispatched yet.
	const callB = manager.describeImage(provider, 'gemma-4', imageBytes, 'image/png', 'narrative');
	await flush();
	assert.equal(globalThis.__providerRequests.length, 1, 'the abandoned-but-still-in-flight first call must still hold the only slot');

	// Only once the first request actually settles does the slot free up for the second.
	deferreds[0].resolve(chatOkResponse('late narrative'));
	await callA; // the original (non-raced) promise resolves normally — it was never cancelled
	await flush();
	assert.equal(globalThis.__providerRequests.length, 2, 'the second call dispatches only after the first settles, not when the caller\'s race gave up on it');

	deferreds[1].resolve(chatOkResponse('second narrative'));
	await callB;
});

// ── B-1 (thq WP-4): the optional per-pass timer now lives inside the limiter ────
//
// Investigation ground truth (`runs/dispatch/thq-feedback-items-investigation.md` §3): the old
// `withTimeout` wrap lived at the `imageDescribe.ts` call site, around the ENTIRE
// `providerManager.describeImage(...)` call — including the wait for a limit-1 local provider's
// slot. These pin the fix: `describeImage`'s optional `timeoutMs` only starts its clock once the
// slot is actually acquired, and (per the release-on-settle test above, unaffected by this change)
// racing it never frees the slot early.

test('ProviderManager.describeImage: an optional timeoutMs does NOT time out while queued behind a slow holder — the clock only starts once the slot is acquired', async () => {
	resetRequests();
	const deferreds = [];
	globalThis.__providerResponder = async () => {
		const d = createDeferred();
		deferreds.push(d);
		return d.promise;
	};

	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const provider = localProvider();

	// callA holds the only slot with no timeout of its own, indefinitely.
	const callA = manager.describeImage(provider, 'gemma-4', imageBytes, 'image/png', 'narrative');
	callA.catch(() => {});

	// callB queues behind it with a short timeoutMs.
	const callB = manager.describeImage(provider, 'gemma-4', imageBytes, 'image/png', 'narrative', 30);
	let callBSettled = false;
	callB.then(() => { callBSettled = true; }, () => { callBSettled = true; });

	// Outlast callB's 30ms budget while it is still queued — if the timer started at call time
	// (the old bug), callB would already have rejected by now.
	await new Promise(resolve => setTimeout(resolve, 80));
	assert.equal(globalThis.__providerRequests.length, 1, 'callB must still be queued behind callA, not dispatched');
	assert.equal(callBSettled, false, 'callB must not have timed out while merely waiting for the slot');

	// Release callA; callB now acquires the slot and its request answers immediately — well inside
	// its 30ms budget, proving the timer only started once the slot was actually granted.
	deferreds[0].resolve(chatOkResponse('first'));
	await callA;
	await flush();
	assert.equal(globalThis.__providerRequests.length, 2, 'releasing callA lets callB dispatch');

	deferreds[1].resolve(chatOkResponse('second'));
	assert.equal(await callB, 'second');
});

test('ProviderManager.describeImage: a slow pass AFTER acquisition times out, with the "timed out after <n>ms" shape and the pass label', async () => {
	resetRequests();
	globalThis.__providerResponder = () => new Promise(() => {}); // never settles

	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const provider = localProvider();

	await assert.rejects(
		() => manager.describeImage(provider, 'gemma-4', imageBytes, 'image/png', 'narrative', 20),
		(err) => {
			assert.match(err.message, /timed out after \d+ms/);
			assert.equal(err.message, 'image description (narrative pass) timed out after 20ms');
			return true;
		},
	);
});

test('ProviderManager.describeImage: the extraction pass carries its own label in the timeout message', async () => {
	resetRequests();
	globalThis.__providerResponder = () => new Promise(() => {}); // never settles

	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const provider = localProvider();

	await assert.rejects(
		() => manager.describeImage(provider, 'gemma-4', imageBytes, 'image/png', 'extraction', 15),
		(err) => {
			assert.equal(err.message, 'image description (extraction pass) timed out after 15ms');
			return true;
		},
	);
});

test('ProviderManager.describeImage: without timeoutMs, no timer is armed at all — a slow pass just awaits normally', async () => {
	resetRequests();
	const d = createDeferred();
	globalThis.__providerResponder = async () => d.promise;

	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const provider = localProvider();

	const call = manager.describeImage(provider, 'gemma-4', imageBytes, 'image/png', 'narrative');
	await new Promise(resolve => setTimeout(resolve, 40));
	d.resolve(chatOkResponse('late but fine'));
	assert.equal(await call, 'late but fine');
});

test('ProviderManager.describeImage: a timeout still releases the slot only once the underlying request actually settles (release-on-settle preserved under the new timer)', async () => {
	resetRequests();
	const deferreds = [];
	globalThis.__providerResponder = async () => {
		const d = createDeferred();
		deferreds.push(d);
		return d.promise;
	};

	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const provider = localProvider();

	// callA times out quickly, but its underlying request is still "in flight" (deferred, not
	// resolved) — release-on-settle means the slot must not free up yet.
	const callA = manager.describeImage(provider, 'gemma-4', imageBytes, 'image/png', 'narrative', 15);
	await assert.rejects(() => callA, /timed out after 15ms/);

	const callB = manager.describeImage(provider, 'gemma-4', imageBytes, 'image/png', 'narrative');
	await flush();
	assert.equal(globalThis.__providerRequests.length, 1, 'callB must still be queued — callA\'s slot has not released despite its caller-facing timeout');

	deferreds[0].resolve(chatOkResponse('late narrative'));
	await flush();
	assert.equal(globalThis.__providerRequests.length, 2, 'the slot only frees once callA\'s real request settles');

	deferreds[1].resolve(chatOkResponse('second narrative'));
	assert.equal(await callB, 'second narrative');
});
