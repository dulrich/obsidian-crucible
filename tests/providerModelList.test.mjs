import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// ── WP-C: the provider-layer "what does the server offer" list capability ──────────────────
//
// Mirrors tests/providerModelProbe.test.mjs exactly: bundle src/providers.ts (+ its transitive
// imports) with a stub 'obsidian' module, wire requestUrl to a URL-pattern-matched responder, and
// assert against ProviderManager.listModels(). Same two reasons for the technique: providers.ts
// imports 'obsidian' (requestUrl), and this lets each test control exactly what each "server"
// endpoint returns while recording every request for call-count / exact-URL assertions.

const outdir = path.join(tmpdir(), 'obsidian-crucible-provider-model-list-tests');
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

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

function secretsThatReturn(key) {
	return { get: async () => key };
}

// ── 1. A probe never writes model.capabilities — including preserving undefined-vs-[] ──────
//
// D2 is the governing constraint of this whole WP: listModels() surfaces server data but must
// never mutate a ProviderModel. This asserts both that the returned catalog entries carry no
// `capabilities` field of their own (a probe result is not a ProviderModel) and — the sharper
// check — that calling listModels() does not touch the `capabilities` on the Provider's existing
// `models` array at all, preserving the undefined-vs-[] distinction pinned by
// tests/modelCapabilities.test.mjs.

test('listModels() never writes model.capabilities, and preserves the undefined-vs-[] distinction on existing models', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({ status: 404, text: 'not found', json: {} })],
		[/\/models$/, async () => ({
			status: 200,
			json: { data: [{ id: 'text-embedding-bge-m3', owned_by: 'lmstudio' }], object: 'list' },
		})],
	]);
	const provider = {
		id: 'lmstudio-caps', name: 'LM Studio', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:1234/v1',
		models: [
			{ id: 'unset-model', label: 'unset', capabilities: undefined },
			{ id: 'emptied-model', label: 'emptied', capabilities: [] },
		],
	};
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));
	const catalog = await manager.listModels(provider);

	assert.equal(catalog.length, 1);
	assert.equal(catalog[0].id, 'text-embedding-bge-m3');
	assert.ok(!('capabilities' in catalog[0]) || catalog[0].capabilities === undefined);

	// The provider's own models array must be untouched — same object identity, same values.
	assert.equal(provider.models[0].capabilities, undefined);
	assert.deepEqual(provider.models[1].capabilities, []);
	assert.notEqual(provider.models[1].capabilities, undefined); // [] must not have collapsed to undefined
});

// ── 2. The catalog is cached — a second call does not re-fetch ─────────────────────────────

test('listModels() results are cached per provider — a second call does not re-fetch', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({ status: 404, text: 'not found', json: {} })],
		[/\/models$/, async () => ({
			status: 200,
			json: { data: [{ id: 'gpt-test', owned_by: 'openai' }], object: 'list' },
		})],
	]);
	const provider = { id: 'openai-cache', name: 'OpenAI', kind: 'openai', models: [] };
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));

	const first = await manager.listModels(provider);
	const second = await manager.listModels(provider);

	assert.deepEqual(first, second);
	assert.equal(countRequestsMatching(/\/v1\/models$/), 1);
});

// A FAILURE, unlike a success, must not be cached. listModels() is reached only from a user
// clicking "Fetch"; someone who sees "server unreachable", starts their server, and clicks again
// means "try again". Caching the rejection would serve them the first click's stale failure until
// they found the Clear-cache button or reloaded Obsidian. (describeModel() caches its failures on
// purpose — it runs unattended on the indexing path, where the trade-off inverts.)
test('a failed listModels() is NOT cached — the next call retries and can succeed', async () => {
	let attempt = 0;
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({ status: 404, text: 'not found', json: {} })],
		[/\/models$/, async () => {
			attempt += 1;
			if (attempt === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:1234');
			return { status: 200, json: { data: [{ id: 'gpt-test', owned_by: 'openai' }], object: 'list' } };
		}],
	]);
	const provider = { id: 'openai-retry', name: 'OpenAI', kind: 'openai', models: [] };
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));

	await assert.rejects(() => manager.listModels(provider), /ECONNREFUSED/);

	const recovered = await manager.listModels(provider);
	assert.deepEqual(recovered.map((m) => m.id), ['gpt-test']);
	assert.equal(attempt, 2, 'the second call must issue a real request, not replay the cached rejection');
});

// ── 3. CLI provider kinds reject listModels() through requireCapability ────────────────────

test('a CLI provider gets a grammatical CLI_UNSUPPORTED_VERB sentence from listModels()', async () => {
	resetRequests([]);
	const provider = { id: 'cli-1', name: 'Codex CLI', kind: 'codex-cli', models: [] };
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));
	await assert.rejects(
		() => manager.listModels(provider),
		/is a CLI provider and cannot list available models/,
	);
});

test('a provider kind with no listModels client yields the precise unsupported-capability error', async () => {
	resetRequests([]);
	const provider = { id: 'anthropic-1', name: 'Claude', kind: 'anthropic', models: [] };
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));
	await assert.rejects(
		() => manager.listModels(provider),
		/Provider kind "anthropic" does not support list available models yet/,
	);
});

// ── 4. LM Studio's HTTP-200-with-error-body is "endpoint absent", not a valid empty list ───

test('a 200 response with an error body on /api/v0/models is treated as unsupported, not as a valid empty native list', async () => {
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
		baseUrl: 'http://127.0.0.1:1234/v1', models: [],
	};
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));
	const catalog = await manager.listModels(provider);
	// If the 200-with-error-body were mistaken for "the native endpoint answered with zero
	// models", this would be an empty array instead of the fallback's one real entry.
	assert.equal(catalog.length, 1);
	assert.equal(catalog[0].id, 'text-embedding-bge-m3');
});

// ── 5. The two-tier fallback: native endpoint absent → /v1/models still yields ids ─────────

test('the two-tier fallback works: native endpoint absent (network error) → /v1/models still yields ids', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => { throw new Error('ECONNREFUSED'); }],
		[/\/models$/, async () => ({
			status: 200,
			json: { data: [{ id: 'gpt-test-a', owned_by: 'openai' }, { id: 'gpt-test-b', owned_by: 'openai' }], object: 'list' },
		})],
	]);
	const provider = { id: 'openai-fallback', name: 'OpenAI', kind: 'openai', models: [] };
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));
	const catalog = await manager.listModels(provider);
	assert.deepEqual(catalog.map(m => m.id), ['gpt-test-a', 'gpt-test-b']);
});

test('a real LM Studio /api/v0/models response is used directly, without falling through, and carries quantization/type/arch verbatim', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({
			status: 200,
			json: {
				object: 'list',
				data: [
					{ id: 'text-embedding-bge-m3', quantization: 'F16', type: 'embeddings', arch: 'bert', state: 'loaded', compatibility_type: 'gguf' },
					{ id: 'llama-3-8b-instruct', quantization: 'Q4_K_M', type: 'llm', arch: 'llama' },
				],
			},
		})],
		[/\/models$/, async () => { throw new Error('fallback should not be reached when the native endpoint answers'); }],
	]);
	const provider = {
		id: 'lmstudio', name: 'LM Studio', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:1234/v1', models: [],
	};
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));
	const catalog = await manager.listModels(provider);
	assert.equal(catalog.length, 2);
	const embed = catalog.find(m => m.id === 'text-embedding-bge-m3');
	assert.equal(embed.type, 'embeddings');
	assert.equal(embed.arch, 'bert');
	// Verbatim server casing — NOT run through normalizePrecision (that's the persisted-key path).
	assert.equal(embed.quantization, 'F16');
	const llm = catalog.find(m => m.id === 'llama-3-8b-instruct');
	assert.equal(llm.quantization, 'Q4_K_M');
	// Native probe must hit the host root, not under apiBaseUrl()'s "/v1".
	const nativeRequest = globalThis.__providerRequests.find(r => /\/api\/v0\/models$/.test(r.url));
	assert.equal(nativeRequest.url, 'http://127.0.0.1:1234/api/v0/models');
});

// ── WP-8: LM Studio native listModels() carries max_context_length through as contextLength ──
//
// Verified live against a running LM Studio (2026-07-25): the native listing's context-size field
// is `max_context_length`, not the OpenRouter-shaped `context_length` the fallback branch reads —
// same wire-format-caution family as `quantization` vs `quant`.

test('LM Studio native listModels() carries max_context_length through as ProviderCatalogModel.contextLength', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({
			status: 200,
			json: {
				object: 'list',
				data: [{ id: 'llama-3-8b-instruct', quantization: 'Q4_K_M', type: 'llm', arch: 'llama', max_context_length: 8192 }],
			},
		})],
	]);
	const provider = {
		id: 'lmstudio-ctx', name: 'LM Studio', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:1234/v1', models: [],
	};
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));
	const catalog = await manager.listModels(provider);
	assert.equal(catalog[0].contextLength, 8192);
});

test('LM Studio native listModels() omits contextLength when max_context_length is absent — never fabricated', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({
			status: 200,
			json: { object: 'list', data: [{ id: 'no-ctx-model', type: 'llm' }] },
		})],
	]);
	const provider = { id: 'lmstudio-noctx', name: 'LM Studio', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', models: [] };
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));
	const catalog = await manager.listModels(provider);
	assert.equal(catalog[0].contextLength, undefined);
});

// ── 6. OpenRouter's rich, currently-unread metadata surfaces, and no API key is required ───

test('OpenRouter /models metadata (context_length, input_modalities, supported_parameters) surfaces, with no API key configured', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => { throw new Error('OpenRouter has no LM Studio-native endpoint'); }],
		[/\/models$/, async () => ({
			status: 200,
			json: {
				data: [{
					id: 'anthropic/claude-x',
					context_length: 200000,
					architecture: { input_modalities: ['text', 'image'] },
					supported_parameters: ['tools', 'temperature'],
				}],
			},
		})],
	]);
	const provider = { id: 'openrouter-1', name: 'OpenRouter', kind: 'openrouter', models: [] };
	// No stored key at all — get() resolves '' the way SecretRegistry.get does when absent.
	const manager = new ProviderManager(fakeApp, secretsThatReturn(''));
	const catalog = await manager.listModels(provider);
	assert.equal(catalog.length, 1);
	assert.equal(catalog[0].contextLength, 200000);
	assert.deepEqual(catalog[0].inputModalities, ['text', 'image']);
	assert.deepEqual(catalog[0].supportedParameters, ['tools', 'temperature']);
	// No Authorization header should have been sent for the empty key.
	const listRequest = globalThis.__providerRequests.find(r => /\/models$/.test(r.url));
	assert.equal(listRequest.headers.Authorization, undefined);
});

// ── WP-2: OpenRouter's embedding models live on a separate endpoint ────────────────────────
//
// GET /api/v1/models never lists embedding models (verified live 2026-07-26: 343 models, zero
// embeddings); they live on GET /api/v1/embeddings/models (27 models). listModels() must fetch
// both for kind `openrouter` and merge id-deduped, tagging the merged-in entries so
// inferCapabilities can classify them.

test('OpenRouter listModels() merges the embeddings-models leg into the chat catalog, id-deduped', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => { throw new Error('OpenRouter has no LM Studio-native endpoint'); }],
		[/\/embeddings\/models$/, async () => ({
			status: 200,
			json: {
				data: [{
					id: 'openai/text-embedding-3-small',
					name: 'OpenAI: Text Embedding 3 Small',
					context_length: 8191,
					architecture: { modality: 'text->embeddings', input_modalities: ['text'], output_modalities: ['embeddings'] },
				}],
			},
		})],
		[/\/models$/, async () => ({
			status: 200,
			json: { data: [{ id: 'anthropic/claude-x', name: 'Anthropic: Claude X', context_length: 200000 }] },
		})],
	]);
	const provider = { id: 'openrouter-merge', name: 'OpenRouter', kind: 'openrouter', models: [] };
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));
	const catalog = await manager.listModels(provider);

	assert.equal(catalog.length, 2);
	const chat = catalog.find(m => m.id === 'anthropic/claude-x');
	assert.equal(chat.displayName, 'Anthropic: Claude X');
	const embedding = catalog.find(m => m.id === 'openai/text-embedding-3-small');
	assert.ok(embedding, 'the embeddings-listing leg entry must be present in the merged catalog');
	assert.equal(embedding.displayName, 'OpenAI: Text Embedding 3 Small');
	assert.deepEqual(embedding.outputModalities, ['embeddings']);
	assert.equal(embedding.contextLength, 8191);
});

test('OpenRouter listModels() dedupes by id, and the embeddings-listing entry wins on collision', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => { throw new Error('OpenRouter has no LM Studio-native endpoint'); }],
		// Same id reported on both legs — shouldn't happen live today, but the merge must have a
		// defined winner. The embeddings-leg version (with output_modalities) must survive.
		[/\/embeddings\/models$/, async () => ({
			status: 200,
			json: { data: [{ id: 'shared/model-x', name: 'Shared Model (embeddings)', architecture: { output_modalities: ['embeddings'] } }] },
		})],
		[/\/models$/, async () => ({
			status: 200,
			json: { data: [{ id: 'shared/model-x', name: 'Shared Model (chat)' }] },
		})],
	]);
	const provider = { id: 'openrouter-collide', name: 'OpenRouter', kind: 'openrouter', models: [] };
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));
	const catalog = await manager.listModels(provider);

	assert.equal(catalog.length, 1);
	assert.equal(catalog[0].displayName, 'Shared Model (embeddings)');
	assert.deepEqual(catalog[0].outputModalities, ['embeddings']);
});

test('OpenRouter listModels() degrades to the chat-only catalog when the embeddings-listing leg fetch fails', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => { throw new Error('OpenRouter has no LM Studio-native endpoint'); }],
		[/\/embeddings\/models$/, async () => { throw new Error('ECONNRESET'); }],
		[/\/models$/, async () => ({
			status: 200,
			json: { data: [{ id: 'anthropic/claude-x', name: 'Anthropic: Claude X' }] },
		})],
	]);
	const provider = { id: 'openrouter-degrade', name: 'OpenRouter', kind: 'openrouter', models: [] };
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));
	const catalog = await manager.listModels(provider);

	// Must not throw, and must not lose the chat catalog just because the embeddings leg failed.
	assert.deepEqual(catalog.map(m => m.id), ['anthropic/claude-x']);
});

test('OpenRouter listModels() degrades to the chat-only catalog when the embeddings-listing leg returns a non-200', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => { throw new Error('OpenRouter has no LM Studio-native endpoint'); }],
		[/\/embeddings\/models$/, async () => ({ status: 500, text: 'internal error', json: {} })],
		[/\/models$/, async () => ({
			status: 200,
			json: { data: [{ id: 'anthropic/claude-x' }] },
		})],
	]);
	const provider = { id: 'openrouter-degrade-500', name: 'OpenRouter', kind: 'openrouter', models: [] };
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));
	const catalog = await manager.listModels(provider);
	assert.deepEqual(catalog.map(m => m.id), ['anthropic/claude-x']);
});

test('OpenRouter listModels() sends OPENROUTER_HEADERS on both the chat and embeddings-listing requests', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => { throw new Error('OpenRouter has no LM Studio-native endpoint'); }],
		[/\/embeddings\/models$/, async () => ({ status: 200, json: { data: [] } })],
		[/\/models$/, async () => ({ status: 200, json: { data: [{ id: 'anthropic/claude-x' }] } })],
	]);
	const provider = { id: 'openrouter-headers', name: 'OpenRouter', kind: 'openrouter', models: [] };
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));
	await manager.listModels(provider);

	const chatRequest = globalThis.__providerRequests.find(r => /\/v1\/models$/.test(r.url));
	const embeddingsRequest = globalThis.__providerRequests.find(r => /\/embeddings\/models$/.test(r.url));
	for (const req of [chatRequest, embeddingsRequest]) {
		assert.equal(req.headers['X-Title'], 'Crucible Obsidian Plugin');
		assert.equal(req.headers['HTTP-Referer'], 'https://github.com/dulrich/obsidian-crucible');
	}
});

test('OpenRouter embed() sends OPENROUTER_HEADERS alongside the standard OpenAI embeddings request shape', async () => {
	resetRequests([
		[/\/embeddings$/, async () => ({
			status: 200,
			json: { model: 'openai/text-embedding-3-small', data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] },
		})],
	]);
	const provider = { id: 'openrouter-embed', name: 'OpenRouter', kind: 'openrouter', models: [] };
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));
	const result = await manager.embed(provider, 'openai/text-embedding-3-small', ['hello world']);

	assert.deepEqual(result.embeddings, [[0.1, 0.2, 0.3]]);
	assert.equal(result.dimensions, 3);
	assert.equal(result.servedModel, 'openai/text-embedding-3-small');
	const embedRequest = globalThis.__providerRequests.find(r => /\/embeddings$/.test(r.url));
	assert.equal(embedRequest.headers['X-Title'], 'Crucible Obsidian Plugin');
	assert.equal(embedRequest.headers['HTTP-Referer'], 'https://github.com/dulrich/obsidian-crucible');
	assert.equal(embedRequest.headers.Authorization, 'Bearer test-key');
	const body = JSON.parse(embedRequest.body);
	assert.deepEqual(body, { model: 'openai/text-embedding-3-small', input: ['hello world'] });
});

// ── 7. ollama: /api/tags + per-model /api/show enrichment ──────────────────────────────────

test('ollama listModels() enriches each /api/tags entry with /api/show capabilities and embedding_length', async () => {
	resetRequests([
		[/\/api\/tags$/, async () => ({
			status: 200,
			json: {
				models: [
					{ name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', digest: 'sha256:aaa', details: { quantization_level: 'F16' } },
					{ name: 'qwen3.5:latest', model: 'qwen3.5:latest', digest: 'sha256:bbb', details: { quantization_level: 'Q4_K_M' } },
				],
			},
		})],
		[/\/api\/show$/, async (options) => {
			const body = JSON.parse(options.body);
			if (body.model === 'nomic-embed-text:latest') {
				return { status: 200, json: { capabilities: ['embedding'], model_info: { 'nomic-bert.embedding_length': 768 } } };
			}
			return { status: 200, json: { capabilities: ['completion'], model_info: { 'llama.context_length': 8192 } } };
		}],
	]);
	const provider = { id: 'ollama-list', name: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [] };
	const manager = new ProviderManager(fakeApp, secretsThatReturn(''));
	const catalog = await manager.listModels(provider);
	assert.equal(catalog.length, 2);
	const embedder = catalog.find(m => m.id === 'nomic-embed-text:latest');
	assert.deepEqual(embedder.serverCapabilities, ['embedding']);
	assert.equal(embedder.embeddingLength, 768);
	assert.equal(embedder.quantization, 'F16');
	const chat = catalog.find(m => m.id === 'qwen3.5:latest');
	assert.deepEqual(chat.serverCapabilities, ['completion']);
	assert.equal(chat.embeddingLength, undefined); // no *.embedding_length key present for this model
});

test('ollama listModels() degrades one entry to undefined capabilities/embeddingLength when its /api/show call fails, without dropping the entry', async () => {
	resetRequests([
		[/\/api\/tags$/, async () => ({
			status: 200,
			json: { models: [{ name: 'flaky-model:latest', model: 'flaky-model:latest', digest: 'sha256:ccc', details: { quantization_level: 'Q8_0' } }] },
		})],
		[/\/api\/show$/, async () => { throw new Error('ECONNRESET'); }],
	]);
	const provider = { id: 'ollama-flaky', name: 'ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [] };
	const manager = new ProviderManager(fakeApp, secretsThatReturn(''));
	const catalog = await manager.listModels(provider);
	assert.equal(catalog.length, 1);
	assert.equal(catalog[0].id, 'flaky-model:latest');
	assert.equal(catalog[0].serverCapabilities, undefined);
	assert.equal(catalog[0].embeddingLength, undefined);
	assert.equal(catalog[0].quantization, 'Q8_0'); // /api/tags data itself is unaffected
});

// ── 8. Cross-encoder suspicion is carried, never acted on ──────────────────────────────────

test('a reranker-shaped model id is flagged looksLikeCrossEncoder in the catalog, but the call still succeeds', async () => {
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
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));
	const catalog = await manager.listModels(provider);
	assert.equal(catalog.length, 1);
	assert.equal(catalog[0].looksLikeCrossEncoder, true);
});

// ── 9. clearModelListCache() drops the session cache so a subsequent call re-fetches ───────

test('clearModelListCache(providerId) drops the session cache so the next listModels() call re-fetches', async () => {
	resetRequests([
		[/\/api\/v0\/models$/, async () => ({ status: 404, text: 'not found', json: {} })],
		[/\/models$/, async () => ({ status: 200, json: { data: [{ id: 'gpt-test', owned_by: 'openai' }] } })],
	]);
	const provider = { id: 'openai-clear', name: 'OpenAI', kind: 'openai', models: [] };
	const manager = new ProviderManager(fakeApp, secretsThatReturn('test-key'));

	await manager.listModels(provider);
	assert.equal(countRequestsMatching(/\/v1\/models$/), 1);

	manager.clearModelListCache(provider.id);
	await manager.listModels(provider);
	assert.equal(countRequestsMatching(/\/v1\/models$/), 2);
});
