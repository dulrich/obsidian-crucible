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
const { normalizePrecision, looksLikeCrossEncoder, warnIfCrossEncoderEmbedder } = await import(pathToFileURL(sharedOutfile).href);

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
