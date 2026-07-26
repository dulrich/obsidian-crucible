import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// ── WP-2: the provider-layer "what did the server actually load?" capability ───────────────
//
// Two bundles, same technique as tests/providerRerank.test.mjs / tests/secretRegistry.test.mjs:
//
// 1. src/providers/shared.ts alone — it imports only '../types' and '../log', no 'obsidian', so
//    the pure normalization/heuristic helpers (normalizePrecision, looksLikeCrossEncoder) can be
//    bundled and tested directly without a stub.
// 2. src/providers.ts (+ its transitive imports, including providers/ollama.ts and
//    providers/openaiCompatible.ts) with a stub 'obsidian' module, exactly like
//    tests/providerRerank.test.mjs — requestUrl is wired to a global responder keyed by URL so
//    each test controls exactly what each "server" endpoint returns, and every request is
//    recorded so a test can assert call counts (the caching requirement) and exact URLs (the
//    LM Studio host-root requirement).

const outdir = path.join(tmpdir(), 'obsidian-crucible-provider-model-probe-tests');
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const sharedOutfile = path.join(outdir, 'shared.mjs');
await esbuild.build({
	entryPoints: ['src/providers/shared.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile: sharedOutfile,
	logLevel: 'silent',
});
const { normalizePrecision, looksLikeCrossEncoder, warnIfCrossEncoderEmbedder, buildHttpErrorMessage } = await import(pathToFileURL(sharedOutfile).href);

const providersOutfile = path.join(outdir, 'providers.mjs');
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
						const responder = globalThis.__providerResponders?.find(r => r.test(options.url));
						if (!responder) {
							throw new Error('no responder configured for URL: ' + options.url);
						}
						return await responder.respond(options);
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

const fakeSecrets = { get: async () => 'test-key' };
const fakeApp = {};

// Each entry matches a URL (via RegExp#test) to a responder. Registered in order; the first match
// wins, so put more specific patterns first when a test needs to distinguish e.g. /api/v0/models
// from /models on the same host.
function resetRequests(responders) {
	globalThis.__providerRequests = [];
	globalThis.__providerResponders = responders.map(([pattern, respond]) => ({
		test: url => pattern.test(url),
		respond,
	}));
}

function countRequestsMatching(pattern) {
	return globalThis.__providerRequests.filter(r => pattern.test(r.url)).length;
}

// ── 1. Precision normalization collapses equivalent spellings ──────────────────────────────
//
// This is the whole point of the portable-key design: Q4_K_M (LM Studio's `quant` string),
// q4_k_m (a lowercase spelling some server might use) and GGUF's numeric general.file_type 15
// (ollama's /api/show fallback) must all produce the identical token. If they didn't, the same
// weights served by two runtimes would split into two vector "spaces" and force a pointless full
// re-embed of the vault — see AGENTS.md's embedding-space-identity quirk.

test('normalizePrecision collapses Q4_K_M, q4_k_m, and GGUF file_type 15 to one identical token', () => {
	const fromUppercase = normalizePrecision('Q4_K_M');
	const fromLowercase = normalizePrecision('q4_k_m');
	const fromGgufFileType = normalizePrecision(15);
	assert.equal(fromUppercase, 'q4_k_m');
	assert.equal(fromLowercase, 'q4_k_m');
	assert.equal(fromGgufFileType, 'q4_k_m');
});

test('normalizePrecision folds fp/float spellings onto the GGUF-convention token, not the reverse', () => {
	// The brief's canonical example list is 'fp32' | 'f16' | 'bf16' | ... — asymmetric on purpose:
	// GGUF's own F32/F16 spelling folds onto fp32/f16, not the other way around.
	assert.equal(normalizePrecision('F32'), 'fp32');
	assert.equal(normalizePrecision('fp32'), 'fp32');
	assert.equal(normalizePrecision('float32'), 'fp32');
	assert.equal(normalizePrecision(0), 'fp32'); // GGUF file_type 0 = ALL_F32
	assert.equal(normalizePrecision('F16'), 'f16');
	assert.equal(normalizePrecision('fp16'), 'f16');
	assert.equal(normalizePrecision(1), 'f16'); // GGUF file_type 1 = MOSTLY_F16
	assert.equal(normalizePrecision('BF16'), 'bf16');
	assert.equal(normalizePrecision('bfloat16'), 'bf16');
});

// ── 1b. WP-R3: buildHttpErrorMessage is the pure formatting helper behind every provider
// client's non-2xx error — unit-tested directly here (shared.ts stays 'obsidian'-free) before the
// end-to-end assertions further down exercise it through each client.

test('buildHttpErrorMessage includes the status, prefers a JSON error.message excerpt over raw text, and includes retry-after', () => {
	const message = buildHttpErrorMessage('OpenRouter API', {
		status: 429,
		text: '{"error":{"message":"Rate limit exceeded"}}',
		json: { error: { message: 'Rate limit exceeded' } },
		headers: { 'Retry-After': '30' },
	});
	assert.match(message, /OpenRouter API returned 429/);
	assert.match(message, /retry-after 30/);
	assert.match(message, /Rate limit exceeded/);
});

test('buildHttpErrorMessage falls back to raw text when the JSON body has no error field', () => {
	const message = buildHttpErrorMessage('Ollama API', { status: 503, text: 'model is loading', json: { status: 'loading' } });
	assert.match(message, /Ollama API returned 503/);
	assert.match(message, /model is loading/);
});

test('buildHttpErrorMessage truncates a long body to a bounded excerpt', () => {
	const longBody = 'x'.repeat(500);
	const message = buildHttpErrorMessage('Google API', { status: 500, text: longBody, json: {} });
	assert.match(message, /Google API returned 500/);
	assert.ok(message.length < longBody.length, 'the excerpt must be bounded, not the full body');
});

test('buildHttpErrorMessage degrades gracefully when accessing .json throws (non-JSON body)', () => {
	const throwingResponse = {
		status: 502,
		text: '<html>Bad Gateway</html>',
		get json() { throw new Error('not valid JSON'); },
	};
	const message = buildHttpErrorMessage('Anthropic API', throwingResponse);
	assert.match(message, /Anthropic API returned 502/);
	assert.match(message, /Bad Gateway/);
});

test('buildHttpErrorMessage omits the retry-after segment and excerpt when neither is present', () => {
	const message = buildHttpErrorMessage('Ollama tags API', { status: 500, text: '', json: {} });
	assert.equal(message, 'Ollama tags API returned 500');
});

// ── 2. A server reporting no precision yields undefined, never a guess ─────────────────────
//
// This is the Infinity path and therefore the live one today: Infinity's /v1/models reports only
// `backend`/`capabilities`, no dtype at all.

test('normalizePrecision yields undefined for undefined/null input, not "unknown" or ""', () => {
	assert.equal(normalizePrecision(undefined), undefined);
	assert.equal(normalizePrecision(null), undefined);
	assert.notEqual(normalizePrecision(undefined), 'unknown');
	assert.notEqual(normalizePrecision(undefined), '');
});

test('describeModel() against an Infinity-shaped server (no native endpoint, no dtype field) returns precision: undefined', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({ status: 404, text: 'not found', json: {} })],
		[/\/v1\/models$/, async () => ({
			status: 200,
			json: { data: [{ id: 'bge-m3', backend: 'optimum', capabilities: ['embed'] }], object: 'list' },
		})],
	]);
	const provider = {
		id: 'infinity', name: 'Infinity', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:4802/v1',
		models: [{ id: 'bge-m3', label: 'bge-m3' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const description = await manager.describeModel(provider, 'bge-m3');
	assert.equal(description.precision, undefined);
	assert.equal(description.servedModel, 'bge-m3');
	// Infinity has no per-model weights digest; `backend` ("optimum"/"torch") is the strongest
	// identity it offers, so the fallback prefers it over a generic `owned_by`.
	assert.equal(description.fingerprint, 'optimum');
});

// ── 3. A 200 response carrying an error body is treated as unsupported, not success ────────
//
// LM Studio answers unknown endpoints with HTTP 200 and {"error": "..."} in the body — a
// status-code check alone would mistake that for "the native endpoint exists but has no matching
// model" and never fall through to /models, silently losing the real answer.

test('a 200 response with an error body on /api/v0/models is treated as unsupported and falls through to /models', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({
			status: 200,
			json: { error: 'Unexpected endpoint or method. (GET /api/v0/models)' },
		})],
		[/\/models$/, async () => ({
			status: 200,
			json: { data: [{ id: 'text-embedding-bge-m3', owned_by: 'lmstudio' }], object: 'list' },
		})],
	]);
	const provider = {
		id: 'lmstudio-trap', name: 'LM Studio', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:1234/v1',
		models: [{ id: 'text-embedding-bge-m3', label: 'text-embedding-bge-m3' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const description = await manager.describeModel(provider, 'text-embedding-bge-m3');
	// If the 200-with-error-body were mistaken for a real (empty) native response, servedModel
	// would come back undefined instead of resolving through the /models fallback.
	assert.equal(description.servedModel, 'text-embedding-bge-m3');
	assert.equal(description.precision, undefined); // /models never carries dtype either way
});

test('a real LM Studio /api/v0/models response is used directly, without falling through', async () => {
	// Field name verified live against a running LM Studio (2026-07-25): the wire field is
	// `quantization`, not `quant` (an earlier draft of the probe assumed `quant`, which a live
	// probe caught before shipping — see the report's Decisions section).
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({
			status: 200,
			json: {
				object: 'list',
				data: [
					{ id: 'text-embedding-bge-m3', quantization: 'F16', type: 'embeddings', arch: 'bert', state: 'loaded', compatibility_type: 'gguf' },
				],
			},
		})],
		[/\/models$/, async () => { throw new Error('fallback should not be reached when the native endpoint answers'); }],
	]);
	const provider = {
		id: 'lmstudio', name: 'LM Studio', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:1234/v1',
		models: [{ id: 'text-embedding-bge-m3', label: 'text-embedding-bge-m3' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const description = await manager.describeModel(provider, 'text-embedding-bge-m3');
	assert.equal(description.servedModel, 'text-embedding-bge-m3');
	assert.equal(description.precision, 'f16');
	assert.equal(description.fingerprint, 'text-embedding-bge-m3@F16');
	// The native probe must hit the host root ("/api/v0/models"), not under apiBaseUrl()'s "/v1".
	const nativeRequest = globalThis.__providerRequests.find(r => /\/api\/v0\/models$/.test(r.url));
	assert.equal(nativeRequest.url, 'http://127.0.0.1:1234/api/v0/models');
});

test("a legacy/alternate LM Studio-shaped response using `quant` instead of `quantization` still normalizes", async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({
			status: 200,
			json: { object: 'list', data: [{ id: 'legacy-embedder', quant: 'Q8_0', type: 'embeddings', arch: 'bert' }] },
		})],
	]);
	const provider = { id: 'lmstudio-legacy', name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', models: [] };
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const description = await manager.describeModel(provider, 'legacy-embedder');
	assert.equal(description.precision, 'q8_0');
});

// ── 4. ollama's digest lands in fingerprint and never in precision ─────────────────────────

test("ollama's digest lands in fingerprint, and precision comes from quantization_level, not the digest", async () => {
	resetRequests([
		[/\/api\/tags$/, async () => ({
			status: 200,
			json: {
				models: [{
					name: 'qwen3.5:latest',
					model: 'qwen3.5:latest',
					digest: 'sha256:deadbeefcafef00d',
					details: { quantization_level: 'Q4_K_M', format: 'gguf' },
				}],
			},
		})],
	]);
	const provider = { id: 'ollama-1', name: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [] };
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const description = await manager.describeModel(provider, 'qwen3.5');
	assert.equal(description.precision, 'q4_k_m');
	assert.equal(description.fingerprint, 'sha256:deadbeefcafef00d');
	assert.notEqual(description.fingerprint, description.precision);
});

test("ollama falls back to /api/show's GGUF file_type when /api/tags has no quantization_level string", async () => {
	resetRequests([
		[/\/api\/tags$/, async () => ({
			status: 200,
			json: { models: [{ name: 'custom-embed:latest', digest: 'sha256:abc123', details: {} }] },
		})],
		[/\/api\/show$/, async () => ({
			status: 200,
			json: { model_info: { 'general.file_type': 15 } },
		})],
	]);
	const provider = { id: 'ollama-2', name: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [] };
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const description = await manager.describeModel(provider, 'custom-embed');
	assert.equal(description.precision, 'q4_k_m');
});

// ── 5. The probe is cached: many embed calls for one provider+model hit the endpoint once ──

test('describeModel results are cached per provider+model — repeated embed() calls hit the metadata endpoint once', async () => {
	resetRequests([
		[/\/api\/tags$/, async () => ({
			status: 200,
			json: { models: [{ name: 'qwen3.5:latest', digest: 'sha256:x', details: { quantization_level: 'F16' } }] },
		})],
		[/\/api\/embed$/, async () => ({ status: 200, json: { model: 'qwen3.5:latest', embeddings: [[0.1, 0.2]] } })],
	]);
	const provider = { id: 'ollama-cache', name: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [] };
	const manager = new ProviderManager(fakeApp, fakeSecrets);

	await manager.embed(provider, 'qwen3.5', ['a']);
	await manager.embed(provider, 'qwen3.5', ['b']);
	await manager.embed(provider, 'qwen3.5', ['c']);

	assert.equal(countRequestsMatching(/\/api\/tags$/), 1);
	assert.equal(countRequestsMatching(/\/api\/embed$/), 3); // the actual embed calls are not cached, only the probe
});

// ── 6. Unsupported capability: precise error, and a CLI provider gets a grammatical sentence ─

test('a provider kind with no describeModel yields the precise unsupported-capability error', async () => {
	resetRequests([]);
	const provider = { id: 'anthropic-1', name: 'Claude', kind: 'anthropic', models: [] };
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	await assert.rejects(
		() => manager.describeModel(provider, 'claude-x'),
		/Provider kind "anthropic" does not support model introspection yet/,
	);
});

test('a CLI provider gets a grammatical CLI_UNSUPPORTED_VERB sentence from describeModel()', async () => {
	resetRequests([]);
	const provider = { id: 'cli-1', name: 'Codex CLI', kind: 'codex-cli', models: [] };
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	await assert.rejects(
		() => manager.describeModel(provider, 'codex'),
		/is a CLI provider and cannot describe the loaded model/,
	);
});

// ── 7. The cross-encoder heuristic warns and never throws ──────────────────────────────────

test('looksLikeCrossEncoder matches "rerank"/"cross-enc" in id or a hint, case-insensitively', () => {
	assert.equal(looksLikeCrossEncoder('text-embedding-bge-reranker-v2-m3'), true);
	assert.equal(looksLikeCrossEncoder('BGE-RERANKER-BASE'), true);
	assert.equal(looksLikeCrossEncoder('some-model', 'cross-encoder-arch'), true);
	assert.equal(looksLikeCrossEncoder('bge-m3'), false);
	assert.equal(looksLikeCrossEncoder('nomic-embed-text'), false);
	assert.equal(looksLikeCrossEncoder('bge-m3', 'bert'), false);
});

test('warnIfCrossEncoderEmbedder does not throw for a matching id, and is a no-op for a normal embedding model id', () => {
	assert.doesNotThrow(() => warnIfCrossEncoderEmbedder('p1', 'Test', 'text-embedding-bge-reranker-v2-m3'));
	assert.doesNotThrow(() => warnIfCrossEncoderEmbedder('p2', 'Test', 'bge-m3'));
});

// ── WP-8: the cross-encoder warning is promoted to a session-deduped, visible Notice ───────
//
// shared.ts stays 'obsidian'-free (this file's whole first bundle depends on that), so the Notice
// itself is never constructed here — `warnIfCrossEncoderEmbedder`'s `notify` callback is the seam
// the two provider clients use to wire a real `new Notice(...)` in. This asserts the seam's
// contract directly: same session dedup gate as logWarn, no throw, hints moved from a rest
// parameter to an array without changing behavior.

test('warnIfCrossEncoderEmbedder calls notify exactly once per (providerId, modelId) this session, and never for a non-matching id', () => {
	const calls = [];
	warnIfCrossEncoderEmbedder('p-notice-1', 'Test', 'bge-reranker-first', [], (msg) => calls.push(msg));
	warnIfCrossEncoderEmbedder('p-notice-1', 'Test', 'bge-reranker-first', [], (msg) => calls.push(msg));
	assert.equal(calls.length, 1, 'a second call for the same (providerId, modelId) must not notify again this session');
	assert.match(calls[0], /cross-encoder/i);

	const normalCalls = [];
	warnIfCrossEncoderEmbedder('p-notice-1', 'Test', 'bge-m3', [], (msg) => normalCalls.push(msg));
	assert.equal(normalCalls.length, 0, 'a normal (non-cross-encoder) id must never notify');
});

test('warnIfCrossEncoderEmbedder still checks hints (now an array parameter, not a rest) for the cross-encoder match', () => {
	const calls = [];
	warnIfCrossEncoderEmbedder('p-notice-2', 'Test', 'some-model-id', ['cross-encoder-arch'], (msg) => calls.push(msg));
	assert.equal(calls.length, 1);
});

test('warnIfCrossEncoderEmbedder is safe to call with no notify callback at all (the existing call-site shape)', () => {
	assert.doesNotThrow(() => warnIfCrossEncoderEmbedder('p-notice-3', 'Test', 'bge-reranker-plain'));
});

test('describeModel() against a reranker-shaped LM Studio model does not throw (warns internally)', async () => {
	// Fixture matches a live LM Studio probe (2026-07-25): text-embedding-bge-reranker-v2-m3
	// reports type: "embeddings" at quantization Q8_0.
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({
			status: 200,
			json: {
				object: 'list',
				data: [{ id: 'text-embedding-bge-reranker-v2-m3', quantization: 'Q8_0', type: 'embeddings', arch: 'bert' }],
			},
		})],
	]);
	const provider = {
		id: 'lmstudio-crossencoder', name: 'LM Studio', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:1234/v1', models: [],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	// The whole point: this must resolve normally, not reject, even though the model is a
	// cross-encoder masquerading as an embedder.
	const description = await manager.describeModel(provider, 'text-embedding-bge-reranker-v2-m3');
	assert.equal(description.servedModel, 'text-embedding-bge-reranker-v2-m3');
	assert.equal(description.precision, 'q8_0');
});

// ── D. servedModel is populated from the embed response, and disagreement warns, not throws ─

test('embed() populates servedModel from the response and does not throw on a resolved-alias mismatch', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({ status: 404, text: 'nope', json: {} })],
		[/\/models$/, async () => ({ status: 200, json: { data: [] } })],
		[/\/embeddings$/, async () => ({
			status: 200,
			json: { model: 'text-embedding-bge-m3-f16', data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] },
		})],
	]);
	const provider = {
		id: 'lmstudio-alias', name: 'LM Studio', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:1234/v1', models: [],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const result = await manager.embed(provider, 'bge-m3', ['hello']);
	assert.equal(result.servedModel, 'text-embedding-bge-m3-f16');
	assert.notEqual(result.servedModel, 'bge-m3'); // disagreement — must not have thrown
});

// ── 9. WP-R3: `requestUrl` throws on non-2xx by default, so every client below now passes
// `throw: false` and builds its own informative error explicitly — this section is the live
// proof those branches actually fire. The test stub's `requestUrl` (top of this file) never
// throws on its own for a non-2xx status; it just returns whatever the responder returns. That
// means these branches were already reachable *in this harness* even before the fix (the gap was
// real `requestUrl`'s default-throw in production, not this test double) — what these tests pin
// down is the message CONTENT (status + retry-after + body excerpt) and that the thrown type is
// unchanged (a plain Error, same as every call site threw before WP-R3).

test('openai-compatible complete() surfaces a 429 with status, retry-after header, and the JSON error.message excerpt', async () => {
	resetRequests([
		[/\/chat\/completions$/, async () => ({
			status: 429,
			text: '{"error":{"message":"Rate limit exceeded, please slow down"}}',
			json: { error: { message: 'Rate limit exceeded, please slow down' } },
			headers: { 'retry-after': '30' },
		})],
	]);
	const provider = {
		id: 'openrouter-429', name: 'OpenRouter', kind: 'openrouter',
		baseUrl: 'https://openrouter.ai/api/v1', models: [{ id: 'm', label: 'm' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	await assert.rejects(
		() => manager.complete(provider, 'm', 'sys', 'hi'),
		(err) => {
			assert.ok(err instanceof Error, 'must still throw a plain Error, not a new error type');
			assert.match(err.message, /429/);
			assert.match(err.message, /retry-after 30/);
			assert.match(err.message, /Rate limit exceeded/);
			return true;
		},
	);
});

test('openai-compatible embed() surfaces a non-2xx status and a plain-text body excerpt', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({ status: 404, text: 'nope', json: {} })],
		[/\/models$/, async () => ({ status: 200, json: { data: [] } })],
		[/\/embeddings$/, async () => ({ status: 500, text: 'internal server error: model not loaded', json: {} })],
	]);
	const provider = {
		id: 'lmstudio-embed-500', name: 'LM Studio', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:1234/v1', models: [{ id: 'm', label: 'm' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	await assert.rejects(
		() => manager.embed(provider, 'm', ['hello']),
		(err) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /500/);
			assert.match(err.message, /model not loaded/);
			return true;
		},
	);
});

test('openai-compatible rerank() surfaces a non-2xx status with a body excerpt', async () => {
	resetRequests([
		[/\/rerank$/, async () => ({ status: 503, text: 'reranker container is warming up', json: {} })],
	]);
	const provider = {
		id: 'reranker-503', name: 'Local Reranker', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:4803', models: [{ id: 'bge-reranker-v2-m3', label: 'bge' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	await assert.rejects(
		() => manager.rerank(provider, 'bge-reranker-v2-m3', 'query', ['doc-a']),
		(err) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /503/);
			assert.match(err.message, /warming up/);
			return true;
		},
	);
});

test('ollama complete() surfaces a non-2xx status and body excerpt', async () => {
	resetRequests([
		[/\/api\/chat$/, async () => ({ status: 503, text: 'model is loading', json: {} })],
	]);
	const provider = { id: 'ollama-503', name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', models: [{ id: 'qwen3.5', label: 'qwen3.5' }] };
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	await assert.rejects(
		() => manager.complete(provider, 'qwen3.5', 'sys', 'hi'),
		(err) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /503/);
			assert.match(err.message, /model is loading/);
			return true;
		},
	);
});

test('ollama embed() surfaces a non-2xx status and body excerpt', async () => {
	resetRequests([
		[/\/api\/embed$/, async () => ({ status: 404, text: 'model not found', json: {} })],
	]);
	const provider = { id: 'ollama-embed-404', name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', models: [{ id: 'qwen3.5', label: 'qwen3.5' }] };
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	await assert.rejects(
		() => manager.embed(provider, 'qwen3.5', ['hi']),
		(err) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /404/);
			assert.match(err.message, /model not found/);
			return true;
		},
	);
});

test('anthropic complete() surfaces a non-2xx status and the JSON error.message excerpt', async () => {
	resetRequests([
		[/api\.anthropic\.com/, async () => ({
			status: 400,
			text: '{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens is too large"}}',
			json: { error: { message: 'max_tokens is too large' } },
		})],
	]);
	const provider = { id: 'anthropic-400', name: 'Claude', kind: 'anthropic', models: [{ id: 'claude-x', label: 'claude-x' }] };
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	await assert.rejects(
		() => manager.complete(provider, 'claude-x', 'sys', 'hi'),
		(err) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /400/);
			assert.match(err.message, /max_tokens is too large/);
			return true;
		},
	);
});

test('google complete() surfaces a non-2xx status and a plain-text body excerpt', async () => {
	resetRequests([
		[/generativelanguage\.googleapis\.com/, async () => ({ status: 403, text: 'API key not valid', json: {} })],
	]);
	const provider = { id: 'google-403', name: 'Gemini', kind: 'google', models: [{ id: 'gemini-x', label: 'gemini-x' }] };
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	await assert.rejects(
		() => manager.complete(provider, 'gemini-x', 'sys', 'hi'),
		(err) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /403/);
			assert.match(err.message, /API key not valid/);
			return true;
		},
	);
});

// The LM-Studio-native describeModel()/listModels() legs must keep tolerating ANY failure short
// of a confirmed native response — including a non-2xx status, not just a network exception — and
// fall through to the /models fallback silently (no thrown error reaches the caller). This is the
// "quality of surfaced errors changes, tolerance does not" contract the brief calls out.

test('describeModel() LM-Studio-native leg tolerates a 500 (not just 404) and falls through silently to /models', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({ status: 500, text: 'internal error', json: {} })],
		[/\/models$/, async () => ({ status: 200, json: { data: [{ id: 'bge-m3', owned_by: 'lmstudio' }] } })],
	]);
	const provider = {
		id: 'lmstudio-native-500', name: 'LM Studio', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:1234/v1', models: [{ id: 'bge-m3', label: 'bge-m3' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const description = await manager.describeModel(provider, 'bge-m3');
	assert.equal(description.servedModel, 'bge-m3'); // resolved via the /models fallback, no throw
});

test('listModels() LM-Studio-native leg tolerates a 500 (not just 404) and falls through silently to /models', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({ status: 500, text: 'internal error', json: {} })],
		[/\/models$/, async () => ({ status: 200, json: { data: [{ id: 'gpt-test', owned_by: 'openai' }] } })],
	]);
	const provider = { id: 'lmstudio-list-500', name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', models: [] };
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const catalog = await manager.listModels(provider);
	assert.deepEqual(catalog.map((m) => m.id), ['gpt-test']);
});
