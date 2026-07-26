import { Notice, requestUrl } from 'obsidian';
import { Provider, ProviderCatalogModel, ProviderCompletionResult, ProviderEmbeddingResult, ProviderFinishReason, ProviderImageExtractionResult, ProviderModelDescription, ProviderRerankResult } from '../types';
import {
	HttpCallContext,
	HttpListCallContext,
	HttpProviderClient,
	IMAGE_EXTRACTION_SYSTEM_PROMPT,
	IMAGE_EXTRACTION_USER_PROMPT,
	looksLikeCrossEncoder,
	normalizeEmbedding,
	normalizePrecision,
	normalizeRawFinishReason,
	normalizeRerankResults,
	parseImageExtractionResult,
	warnIfCrossEncoderEmbedder,
} from './shared';

const OPENROUTER_HEADERS = {
	'HTTP-Referer': 'https://github.com/dulrich/obsidian-crucible',
	'X-Title': 'Crucible Obsidian Plugin',
};

function isOpenRouter(provider: Provider): boolean {
	return provider.kind === 'openrouter';
}

// A user-configured local server (LM Studio, llama.cpp, vLLM, LocalAI, …) speaking the
// OpenAI wire format. It honours provider.baseUrl and treats the API key as optional.
function isLocal(provider: Provider): boolean {
	return provider.kind === 'openai-compatible';
}

function label(provider: Provider): string {
	if (isLocal(provider)) return 'Local';
	return isOpenRouter(provider) ? 'OpenRouter' : 'OpenAI';
}

// Resolves the API base for every endpoint (completion, embedding, image). For the OpenAI and
// OpenRouter vendors this returns their fixed default unless an override is set; for local
// servers it falls back to LM Studio's default port.
function apiBaseUrl(provider: Provider): string {
	const fallback = isOpenRouter(provider)
		? 'https://openrouter.ai/api/v1'
		: isLocal(provider)
			? 'http://localhost:1234/v1'
			: 'https://api.openai.com/v1';
	return (provider.baseUrl || fallback).replace(/\/$/, '');
}

// Structurally typed to `{ apiKey }` (not HttpCallContext specifically) so it also serves
// listModels()'s modelId-free HttpListCallContext without a second header builder.
function authHeaders(ctx: { apiKey: string }): Record<string, string> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	// Local servers may run without auth; only send the header when a key is present.
	if (ctx.apiKey) headers['Authorization'] = `Bearer ${ctx.apiKey}`;
	return headers;
}

// LM Studio's native model-introspection endpoint (`/api/v0/models`) lives at the host root, not
// under the `/v1` prefix apiBaseUrl() returns — e.g. apiBaseUrl() gives
// "http://127.0.0.1:1234/v1" but the native endpoint is "http://127.0.0.1:1234/api/v0/models".
// Using the URL parser (rather than a regex strip of a trailing "/v1") means this works
// regardless of what path segments a user's Server URL setting carries.
function hostRootUrl(apiBase: string): string {
	try {
		const url = new URL(apiBase);
		return `${url.protocol}//${url.host}`;
	} catch {
		return apiBase.replace(/\/(?:v\d+\/?)?$/i, '');
	}
}

interface LmStudioNativeModelEntry {
	id?: string;
	// Verified live against a running LM Studio (2026-07-25): the wire field is `quantization`
	// ("Q8_0", "F16", "Q4_K_M", ...), not `quant` as an earlier draft of this probe assumed —
	// `quant` is kept as a fallback in case a different LM Studio version or a server mimicking
	// this API uses the shorter name, but `quantization` is what a live box actually sends.
	quantization?: string;
	quant?: string;
	type?: string;
	arch?: string;
	state?: string;
	compatibility_type?: string;
	// WP-8: verified live against a running LM Studio (2026-07-25) — the native listing's context
	// size field is `max_context_length`, not the OpenRouter-shaped `context_length` the fallback
	// `/models` branch below reads. Same wire-format caution as `quantization` vs `quant`: don't
	// assume the two branches share a field name just because they both end up in
	// `ProviderCatalogModel.contextLength`.
	max_context_length?: number;
}

// LM Studio (and any server mimicking its native API) answers an endpoint it does not implement
// with HTTP 200 and `{"error": "..."}` in the body — a status-code check alone would report every
// capability as present. So "does this response actually carry a models list" is a body-shape
// check, not `response.status === 200`.
function isNativeModelsBody(body: unknown): body is { data: LmStudioNativeModelEntry[] } {
	if (!body || typeof body !== 'object') return false;
	if ('error' in (body as Record<string, unknown>)) return false;
	return Array.isArray((body as { data?: unknown }).data);
}

export const openAICompatibleClient: HttpProviderClient = {
	async complete(ctx, system, user): Promise<ProviderCompletionResult> {
		const openRouter = isOpenRouter(ctx.provider);
		const response = await requestUrl({
			url: `${apiBaseUrl(ctx.provider)}/chat/completions`,
			method: 'POST',
			headers: openRouter ? { ...authHeaders(ctx), ...OPENROUTER_HEADERS } : authHeaders(ctx),
			body: JSON.stringify({
				model: ctx.modelId,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: user },
				],
				// OpenAI pins a sampling temperature; OpenRouter and local servers leave it to the model default.
				...(ctx.provider.kind === 'openai' ? { temperature: 0.7 } : {}),
			}),
		});

		if (response.status !== 200) {
			throw new Error(`${label(ctx.provider)} API returned ${response.status}: ${response.text}`);
		}

		const data = response.json as { choices: { message?: { content?: string }, finish_reason?: string | null }[] };
		const choice = data.choices[0];
		if (!choice) throw new Error(`${label(ctx.provider)} API returned no choices`);
		const rawFinishReason = normalizeRawFinishReason(choice.finish_reason);
		return {
			text: choice.message?.content ?? '',
			finishReason: normalizeChatCompletionFinishReason(rawFinishReason),
			rawFinishReason,
		};
	},

	async embed(ctx, inputs): Promise<ProviderEmbeddingResult> {
		const response = await requestUrl({
			url: `${apiBaseUrl(ctx.provider)}/embeddings`,
			method: 'POST',
			headers: authHeaders(ctx),
			body: JSON.stringify({ model: ctx.modelId, input: inputs }),
		});

		if (response.status !== 200) {
			throw new Error(`${label(ctx.provider)} embeddings API returned ${response.status}: ${response.text}`);
		}

		const data = response.json as { data?: { embedding?: number[], index?: number }[], model?: string };
		const rows = (data.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		const embeddings = rows.map(row => normalizeEmbedding(row.embedding));
		if (embeddings.length !== inputs.length) {
			throw new Error(`${label(ctx.provider)} embeddings API returned ${embeddings.length} embeddings for ${inputs.length} inputs`);
		}
		return {
			embeddings,
			dimensions: embeddings[0]?.length,
			servedModel: typeof data.model === 'string' && data.model ? data.model : undefined,
		};
	},

	// Asks the server what it actually loaded for ctx.modelId. LM Studio's native
	// `/api/v0/models` is the only local endpoint of the three that reports quantization at all
	// (`quantization`, plus `type`/`arch`/`state`/`compatibility_type`); its OpenAI-compatible
	// `/v1/models` carries only `id` + `owned_by`. So this tries the native endpoint first (at the
	// host root — see hostRootUrl) and falls back to `{apiBaseUrl}/models` for OpenAI, OpenRouter,
	// and any local server (Infinity, vLLM, plain llama.cpp) that doesn't implement the native
	// route. Infinity's `/v1/models` reports `backend`/`capabilities` but never dtype, so the
	// fallback leg's `precision` is correctly `undefined` there — the live path for the embedder
	// actually in use on this box today.
	async describeModel(ctx: HttpCallContext): Promise<ProviderModelDescription> {
		// Cheap, network-independent pass first: an id that already reads as a reranker must warn
		// even if every request below fails or the server is unreachable.
		warnIfCrossEncoderEmbedder(ctx.provider.id, label(ctx.provider), ctx.modelId, [], (msg) => new Notice(msg));

		const native = await tryLmStudioNativeDescribeModel(ctx);
		if (native) return native;
		return await fallbackModelsDescribeModel(ctx);
	},

	// WP-C: enumerates what the server offers, rather than probing one already-known id. Same
	// two-tier shape as describeModel() above and the same reason — try LM Studio's native
	// `/api/v0/models` first (richer: `type`/`arch`/`quantization`), fall back to the plain
	// `{apiBaseUrl}/models` list every OpenAI-compatible server (including OpenRouter, which needs
	// no API key here) implements. Unlike describeModel(), there is no ctx.modelId to filter
	// against — this returns every entry the server reports.
	async listModels(ctx: HttpListCallContext): Promise<ProviderCatalogModel[]> {
		const native = await tryLmStudioNativeListModels(ctx);
		if (native) return native;
		return await fallbackModelsListModels(ctx);
	},

	// Primary rerank backend (WP-5): `POST {apiBaseUrl}/rerank`, verified against Infinity's
	// actual Pydantic schemas (michaelf34/infinity:0.0.77-cpu) rather than guessed. The
	// reranker is configured as its own provider entry — a different port from the embedder,
	// and (unlike the embedder) its base URL is the bare host with no `/v1` suffix, because
	// that container is deliberately started without `--url-prefix`. Reusing apiBaseUrl()/
	// authHeaders() here means that shape difference is just "what the user typed into Server
	// URL" — no rerank-specific URL branch.
	async rerank(ctx, query, documents): Promise<ProviderRerankResult> {
		const response = await requestUrl({
			url: `${apiBaseUrl(ctx.provider)}/rerank`,
			method: 'POST',
			headers: authHeaders(ctx),
			body: JSON.stringify({ model: ctx.modelId, query, documents }),
		});

		if (response.status !== 200) {
			throw new Error(`${label(ctx.provider)} rerank API returned ${response.status}: ${response.text}`);
		}

		// results[].index refers to the position in *this request's* documents array and is not
		// guaranteed to arrive in that order (Infinity sorts by relevance_score descending) —
		// normalizeRerankResults is the single place that maps back by index rather than position.
		return { results: normalizeRerankResults(response.json, documents.length) };
	},

	async extractImage(ctx, base64, mimeType): Promise<ProviderImageExtractionResult> {
		const headers = isOpenRouter(ctx.provider) ? { ...authHeaders(ctx), ...OPENROUTER_HEADERS } : authHeaders(ctx);
		const response = await requestUrl({
			url: `${apiBaseUrl(ctx.provider)}/chat/completions`,
			method: 'POST',
			headers,
			body: JSON.stringify({
				model: ctx.modelId,
				messages: [
					{ role: 'system', content: IMAGE_EXTRACTION_SYSTEM_PROMPT },
					{
						role: 'user',
						content: [
							{ type: 'text', text: IMAGE_EXTRACTION_USER_PROMPT },
							{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
						],
					},
				],
				temperature: 0,
			}),
		});

		if (response.status !== 200) {
			throw new Error(`${label(ctx.provider)} image extraction API returned ${response.status}: ${response.text}`);
		}

		const data = response.json as { choices?: { message?: { content?: string }, finish_reason?: string | null }[] };
		const choice = data.choices?.[0];
		if (!choice) throw new Error(`${label(ctx.provider)} image extraction API returned no choices`);
		const rawFinishReason = normalizeRawFinishReason(choice.finish_reason);
		return parseImageExtractionResult(choice.message?.content ?? '', normalizeChatCompletionFinishReason(rawFinishReason), rawFinishReason);
	},
};

// Tries LM Studio's native `/api/v0/models` (host root, not under apiBaseUrl()'s `/v1`). Returns
// `null` — not a thrown error — for anything short of a confirmed native response, so the caller
// falls through to the OpenAI-compatible `/models` endpoint instead of failing the whole probe: a
// non-LM-Studio server (OpenAI, OpenRouter, Infinity, vLLM) legitimately has no route here, and a
// network error reaching it is not evidence the model is unknown.
async function tryLmStudioNativeDescribeModel(ctx: HttpCallContext): Promise<ProviderModelDescription | null> {
	let response;
	try {
		response = await requestUrl({ url: `${hostRootUrl(apiBaseUrl(ctx.provider))}/api/v0/models`, method: 'GET', headers: authHeaders(ctx) });
	} catch {
		return null;
	}
	if (response.status !== 200) return null;
	let body: unknown;
	try {
		body = response.json;
	} catch {
		return null;
	}
	// The HTTP-200-with-error-body trap: LM Studio answers an endpoint it doesn't implement with
	// status 200 and `{"error": "..."}`. isNativeModelsBody rejects that shape so it falls through
	// to the /models fallback rather than being mistaken for "this model has no metadata".
	if (!isNativeModelsBody(body)) return null;

	const match = body.data.find(entry => entry.id === ctx.modelId);
	warnIfCrossEncoderEmbedder(ctx.provider.id, label(ctx.provider), ctx.modelId, [match?.id, match?.arch], (msg) => new Notice(msg));
	if (!match) return { servedModel: undefined, precision: undefined, fingerprint: undefined };

	const quant = match.quantization ?? match.quant;
	return {
		servedModel: match.id,
		precision: normalizePrecision(quant),
		// The quant-bearing served id is the strongest identity LM Studio's native API offers —
		// no weights-blob digest is exposed the way ollama's is. Evidence only, never the key.
		fingerprint: quant ? `${match.id ?? ctx.modelId}@${quant}` : match.id,
	};
}

interface FallbackModelEntry {
	id?: string;
	owned_by?: string;
	// Not a standard OpenAI-compatible field, but Infinity's `/v1/models` (verified live
	// 2026-07-25) includes it alongside the plain `id`/`owned_by` shape: "optimum" (embedder
	// container) or "torch" (reranker container). It's the strongest identity Infinity offers
	// since it has no per-model weights digest, so prefer it over `owned_by` when present.
	backend?: string;
	// OpenRouter-only fields (per the WP-C plan's per-kind table: "rich and currently 100% unread").
	// Absent on OpenAI/LM Studio/Infinity — left undefined there, which is the correct, honest
	// result rather than something to guess at.
	context_length?: number;
	architecture?: { input_modalities?: unknown };
	supported_parameters?: unknown;
}

// Fallback for any server without LM Studio's native endpoint: the plain OpenAI-compatible
// `/models` list, which on LM Studio itself (and on OpenAI/OpenRouter) carries only `id` +
// `owned_by` — no dtype. `precision` therefore comes back `undefined` here, which is correct: it
// is a clean unknown, not a guess. Infinity answers this same shape (verified live) with `backend`
// alongside `owned_by`; still no dtype anywhere in the payload.
async function fallbackModelsDescribeModel(ctx: HttpCallContext): Promise<ProviderModelDescription> {
	const response = await requestUrl({ url: `${apiBaseUrl(ctx.provider)}/models`, method: 'GET', headers: authHeaders(ctx) });
	if (response.status !== 200) {
		throw new Error(`${label(ctx.provider)} models API returned ${response.status}: ${response.text}`);
	}
	const body = response.json as { data?: FallbackModelEntry[] } | { error?: unknown };
	if (body && typeof body === 'object' && 'error' in body) {
		throw new Error(`${label(ctx.provider)} models API returned an error body`);
	}
	const list = (body as { data?: FallbackModelEntry[] }).data ?? [];
	const match = list.find(m => m.id === ctx.modelId);
	warnIfCrossEncoderEmbedder(ctx.provider.id, label(ctx.provider), ctx.modelId, [match?.id, match?.backend], (msg) => new Notice(msg));
	return {
		servedModel: match?.id,
		precision: undefined,
		fingerprint: match?.backend ?? match?.owned_by,
	};
}

// listModels() counterpart to tryLmStudioNativeDescribeModel above: same endpoint, same
// HTTP-200-with-error-body trap handling (isNativeModelsBody), but returns every entry rather than
// filtering to one ctx.modelId — there is none to filter by. `quantization` is carried through
// verbatim (server casing, e.g. "F16"), NOT run through normalizePrecision — see
// ProviderCatalogModel's doc comment in src/types.ts for why the catalog is display data, not the
// normalized persisted key.
async function tryLmStudioNativeListModels(ctx: HttpListCallContext): Promise<ProviderCatalogModel[] | null> {
	let response;
	try {
		response = await requestUrl({ url: `${hostRootUrl(apiBaseUrl(ctx.provider))}/api/v0/models`, method: 'GET', headers: authHeaders(ctx) });
	} catch {
		return null;
	}
	if (response.status !== 200) return null;
	let body: unknown;
	try {
		body = response.json;
	} catch {
		return null;
	}
	if (!isNativeModelsBody(body)) return null;

	return body.data
		.filter((entry): entry is LmStudioNativeModelEntry & { id: string } => typeof entry.id === 'string')
		.map(entry => {
			const quant = entry.quantization ?? entry.quant;
			return {
				id: entry.id,
				type: entry.type,
				arch: entry.arch,
				quantization: quant,
				contextLength: typeof entry.max_context_length === 'number' ? entry.max_context_length : undefined,
				looksLikeCrossEncoder: looksLikeCrossEncoder(entry.id, entry.arch),
			};
		});
}

// listModels() counterpart to fallbackModelsDescribeModel above: the plain OpenAI-compatible
// `/models` list, unfiltered. Serves three different response shapes through one mapping —
// OpenAI/LM Studio's `id`+`owned_by`, Infinity's added `backend`, and OpenRouter's
// `context_length`/`architecture.input_modalities`/`supported_parameters` — by simply leaving
// whichever fields a given server doesn't report as `undefined`. This is the "rich and currently
// 100% unread" OpenRouter data the WP-C plan calls out; OpenRouter's `/models` needs no API key
// (ProviderManager.listModels's httpListContext() does not enforce one), so this call succeeds even
// for an OpenRouter provider with no stored key.
async function fallbackModelsListModels(ctx: HttpListCallContext): Promise<ProviderCatalogModel[]> {
	const response = await requestUrl({ url: `${apiBaseUrl(ctx.provider)}/models`, method: 'GET', headers: authHeaders(ctx) });
	if (response.status !== 200) {
		throw new Error(`${label(ctx.provider)} models API returned ${response.status}: ${response.text}`);
	}
	const body = response.json as { data?: FallbackModelEntry[] } | { error?: unknown };
	if (body && typeof body === 'object' && 'error' in body) {
		throw new Error(`${label(ctx.provider)} models API returned an error body`);
	}
	const list = (body as { data?: FallbackModelEntry[] }).data ?? [];
	return list
		.filter((entry): entry is FallbackModelEntry & { id: string } => typeof entry.id === 'string')
		.map(entry => {
			const inputModalities = Array.isArray(entry.architecture?.input_modalities)
				? (entry.architecture.input_modalities as unknown[]).filter((v): v is string => typeof v === 'string')
				: undefined;
			const supportedParameters = Array.isArray(entry.supported_parameters)
				? (entry.supported_parameters as unknown[]).filter((v): v is string => typeof v === 'string')
				: undefined;
			return {
				id: entry.id,
				ownedBy: entry.owned_by,
				contextLength: typeof entry.context_length === 'number' ? entry.context_length : undefined,
				inputModalities,
				supportedParameters,
				looksLikeCrossEncoder: looksLikeCrossEncoder(entry.id, entry.backend),
			};
		});
}

function normalizeChatCompletionFinishReason(raw: string | undefined): ProviderFinishReason {
	if (!raw) return 'unknown';
	switch (raw.toLowerCase()) {
		case 'stop': return 'stop';
		case 'length':
		case 'max_tokens': return 'length';
		case 'content_filter':
		case 'safety': return 'content_filter';
		case 'tool_calls':
		case 'function_call': return 'tool_calls';
		case 'error': return 'error';
		default: return 'other';
	}
}
