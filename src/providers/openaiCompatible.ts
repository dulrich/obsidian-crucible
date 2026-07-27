import { Notice, requestUrl } from 'obsidian';
import { Provider, ProviderCatalogModel, ProviderCompletionResult, ProviderEmbeddingResult, ProviderFinishReason, ProviderImageExtractionResult, ProviderModelDescription, ProviderRerankResult } from '../types';
import { logWarn } from '../log';
import {
	buildHttpErrorMessage,
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
			throw: false,
		});

		if (response.status !== 200) {
			throw new Error(buildHttpErrorMessage(`${label(ctx.provider)} API`, response));
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
		const openRouter = isOpenRouter(ctx.provider);
		const response = await requestUrl({
			url: `${apiBaseUrl(ctx.provider)}/embeddings`,
			method: 'POST',
			headers: openRouter ? { ...authHeaders(ctx), ...OPENROUTER_HEADERS } : authHeaders(ctx),
			body: JSON.stringify({ model: ctx.modelId, input: inputs }),
			throw: false,
		});

		if (response.status !== 200) {
			throw new Error(buildHttpErrorMessage(`${label(ctx.provider)} embeddings API`, response));
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
		const catalog = native ?? await fallbackModelsListModels(ctx);
		// WP-2: OpenRouter's chat catalog (`/models`) never lists embedding models — they live on a
		// separate endpoint. Only OpenRouter has this second leg; LM Studio/llama-server/vLLM/etc.
		// have no such route, and `native` is always null for OpenRouter (no LM Studio endpoint), so
		// this only ever runs against the fallback list.
		if (!isOpenRouter(ctx.provider)) return catalog;
		return await mergeOpenRouterEmbeddingsModels(ctx, catalog);
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
			throw: false,
		});

		if (response.status !== 200) {
			throw new Error(buildHttpErrorMessage(`${label(ctx.provider)} rerank API`, response));
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
			throw: false,
		});

		if (response.status !== 200) {
			throw new Error(buildHttpErrorMessage(`${label(ctx.provider)} image extraction API`, response));
		}

		const data = response.json as { choices?: { message?: { content?: string }, finish_reason?: string | null }[] };
		const choice = data.choices?.[0];
		if (!choice) throw new Error(`${label(ctx.provider)} image extraction API returned no choices`);
		const rawFinishReason = normalizeRawFinishReason(choice.finish_reason);
		return parseImageExtractionResult(choice.message?.content ?? '', normalizeChatCompletionFinishReason(rawFinishReason), rawFinishReason);
	},

	// The two-pass description call behind ProviderManager.describeImage. Copies extractImage's
	// content-part message shape (a text part + an image_url data URI part), but with a single
	// user message (no system prompt — plain-text output needs no JSON-shape instruction) and no
	// response parsing beyond trimming, since the prompt itself asks for plain prose/text.
	//
	// `reasoning_effort: 'none'` for local providers only is a correctness requirement, not a
	// latency tweak: local gemma-4 (served via LM Studio/llama.cpp, `isLocal(ctx.provider)`)
	// returns an EMPTY `content` on this endpoint without it — confirmed against the benched
	// two-pass prompts. Remote providers (OpenAI, OpenRouter) must not receive the field at all,
	// not merely have it ignored — an unrecognized field on a stricter remote API is a request
	// shape difference this module keeps byte-identical to today's extractImage otherwise.
	async describeImagePass(ctx, base64, mimeType, prompt, maxTokens): Promise<string> {
		const headers = isOpenRouter(ctx.provider) ? { ...authHeaders(ctx), ...OPENROUTER_HEADERS } : authHeaders(ctx);
		const body: Record<string, unknown> = {
			model: ctx.modelId,
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: prompt },
						{ type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
					],
				},
			],
			temperature: 0,
			// idh-WP-1: universal on chat/completions (unlike reasoning_effort below, no isLocal
			// gate) — bounds the worst case after a temp-0 repetition loop generated to the 32k
			// context ceiling with no cap at all. See IMAGE_DESCRIPTION_*_MAX_TOKENS in ./shared.
			max_tokens: maxTokens,
		};
		if (isLocal(ctx.provider)) body.reasoning_effort = 'none';

		const response = await requestUrl({
			url: `${apiBaseUrl(ctx.provider)}/chat/completions`,
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			throw: false,
		});

		if (response.status !== 200) {
			throw new Error(buildHttpErrorMessage(`${label(ctx.provider)} image description API`, response));
		}

		const data = response.json as { choices?: { message?: { content?: string } }[] };
		const choice = data.choices?.[0];
		if (!choice) throw new Error(`${label(ctx.provider)} image description API returned no choices`);
		return (choice.message?.content ?? '').trim();
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
		response = await requestUrl({ url: `${hostRootUrl(apiBaseUrl(ctx.provider))}/api/v0/models`, method: 'GET', headers: authHeaders(ctx), throw: false });
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
	// WP-2: `output_modalities` is present on both OpenRouter legs but only ever non-trivial
	// (`["embeddings"]`) on the embeddings-listing leg — chat entries on `/models` report no
	// `output_modalities` at all, or `["text"]`. Shares the `architecture` object with
	// `input_modalities` rather than sitting alongside it, matching the live response shape.
	architecture?: { input_modalities?: unknown, output_modalities?: unknown };
	supported_parameters?: unknown;
	// WP-2: OpenRouter's display name ("OpenAI: Text Embedding Ada 002"), present on both legs.
	name?: string;
	// WP-2: llama-swap's `/v1/models` lists only canonical ids ("bge-m3-f16"); each entry carries
	// its configured aliases ("bge-m3") here instead. A provider model row configured with the
	// alias id would otherwise never match `list.find(m => m.id === ctx.modelId)`. Optional at
	// every level and tolerant of malformed shapes — this is a type assertion over server JSON,
	// not a validated schema, so `aliases` is read as `unknown` and array-checked at the call site.
	meta?: { llamaswap?: { aliases?: unknown } };
}

// Alias-aware companion to `list.find(m => m.id === ctx.modelId)`: an exact id match always wins
// (server-reported truth beats a configured alias), falling back to a llama-swap alias hit only
// when no entry's own id matches. Tolerates absent/malformed `meta` — never throws.
function findFallbackModelEntry(list: FallbackModelEntry[], modelId: string): FallbackModelEntry | undefined {
	const exact = list.find(m => m.id === modelId);
	if (exact) return exact;
	return list.find(m => {
		const aliases = m.meta?.llamaswap?.aliases;
		return Array.isArray(aliases) && aliases.includes(modelId);
	});
}

// Shared entry mapper for OpenRouter/OpenAI-compatible-shaped `/models` list entries — used by both
// the main chat catalog (`fallbackModelsListModels`) and the OpenRouter embeddings-listing leg
// (`fetchOpenRouterEmbeddingsModels`), since both endpoints return the same entry shape (WP-2
// pinned facts: "same family as chat entries").
function mapFallbackEntry(entry: FallbackModelEntry & { id: string }): ProviderCatalogModel {
	const inputModalities = Array.isArray(entry.architecture?.input_modalities)
		? (entry.architecture.input_modalities as unknown[]).filter((v): v is string => typeof v === 'string')
		: undefined;
	const outputModalities = Array.isArray(entry.architecture?.output_modalities)
		? (entry.architecture.output_modalities as unknown[]).filter((v): v is string => typeof v === 'string')
		: undefined;
	const supportedParameters = Array.isArray(entry.supported_parameters)
		? (entry.supported_parameters as unknown[]).filter((v): v is string => typeof v === 'string')
		: undefined;
	return {
		id: entry.id,
		ownedBy: entry.owned_by,
		contextLength: typeof entry.context_length === 'number' ? entry.context_length : undefined,
		inputModalities,
		outputModalities,
		supportedParameters,
		displayName: typeof entry.name === 'string' && entry.name ? entry.name : undefined,
		looksLikeCrossEncoder: looksLikeCrossEncoder(entry.id, entry.backend),
	};
}

// Fallback for any server without LM Studio's native endpoint: the plain OpenAI-compatible
// `/models` list, which on LM Studio itself (and on OpenAI/OpenRouter) carries only `id` +
// `owned_by` — no dtype. `precision` therefore comes back `undefined` here, which is correct: it
// is a clean unknown, not a guess. Infinity answers this same shape (verified live) with `backend`
// alongside `owned_by`; still no dtype anywhere in the payload.
async function fallbackModelsDescribeModel(ctx: HttpCallContext): Promise<ProviderModelDescription> {
	const response = await requestUrl({ url: `${apiBaseUrl(ctx.provider)}/models`, method: 'GET', headers: authHeaders(ctx), throw: false });
	if (response.status !== 200) {
		throw new Error(buildHttpErrorMessage(`${label(ctx.provider)} models API`, response));
	}
	const body = response.json as { data?: FallbackModelEntry[] } | { error?: unknown };
	if (body && typeof body === 'object' && 'error' in body) {
		throw new Error(`${label(ctx.provider)} models API returned an error body`);
	}
	const list = (body as { data?: FallbackModelEntry[] }).data ?? [];
	// findFallbackModelEntry matches on the entry's own id first, falling back to a llama-swap
	// alias hit (meta.llamaswap.aliases) — see its doc comment. Either way `match.id` is the
	// canonical id the server actually reports, which is what `servedModel` below returns: server-
	// reported truth, never the alias the row happened to be configured with.
	const match = findFallbackModelEntry(list, ctx.modelId);
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
		response = await requestUrl({ url: `${hostRootUrl(apiBaseUrl(ctx.provider))}/api/v0/models`, method: 'GET', headers: authHeaders(ctx), throw: false });
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
	const openRouter = isOpenRouter(ctx.provider);
	const response = await requestUrl({
		url: `${apiBaseUrl(ctx.provider)}/models`,
		method: 'GET',
		headers: openRouter ? { ...authHeaders(ctx), ...OPENROUTER_HEADERS } : authHeaders(ctx),
		throw: false,
	});
	if (response.status !== 200) {
		throw new Error(buildHttpErrorMessage(`${label(ctx.provider)} models API`, response));
	}
	const body = response.json as { data?: FallbackModelEntry[] } | { error?: unknown };
	if (body && typeof body === 'object' && 'error' in body) {
		throw new Error(`${label(ctx.provider)} models API returned an error body`);
	}
	const list = (body as { data?: FallbackModelEntry[] }).data ?? [];
	return list
		.filter((entry): entry is FallbackModelEntry & { id: string } => typeof entry.id === 'string')
		.map(mapFallbackEntry);
}

// WP-2: OpenRouter's embedding models live on a separate endpoint from the main chat catalog
// (verified live 2026-07-26: `GET /api/v1/models` returns 343 models, zero embedding models;
// `GET /api/v1/embeddings/models` returns 27, same entry shape as a chat entry). Kind `openrouter`
// only — no other server this client speaks to has this route.
async function fetchOpenRouterEmbeddingsModels(ctx: HttpListCallContext): Promise<ProviderCatalogModel[]> {
	const response = await requestUrl({
		url: `${apiBaseUrl(ctx.provider)}/embeddings/models`,
		method: 'GET',
		headers: { ...authHeaders(ctx), ...OPENROUTER_HEADERS },
		throw: false,
	});
	if (response.status !== 200) {
		throw new Error(buildHttpErrorMessage('OpenRouter embeddings models API', response));
	}
	const body = response.json as { data?: FallbackModelEntry[] } | { error?: unknown };
	if (body && typeof body === 'object' && 'error' in body) {
		throw new Error('OpenRouter embeddings models API returned an error body');
	}
	const list = (body as { data?: FallbackModelEntry[] }).data ?? [];
	return list
		.filter((entry): entry is FallbackModelEntry & { id: string } => typeof entry.id === 'string')
		.map(mapFallbackEntry);
}

// Merges the OpenRouter embeddings-listing leg into the main chat catalog, id-deduped with the
// embeddings entry winning any collision (the more specific classification for an id reported on
// both legs — none is known live today, but the merge must still have a defined winner). A failure
// fetching the embeddings leg degrades to the chat-only catalog rather than failing listModels()
// entirely — the embeddings leg is additive data, not a prerequisite for the rest of the catalog.
async function mergeOpenRouterEmbeddingsModels(ctx: HttpListCallContext, chatModels: ProviderCatalogModel[]): Promise<ProviderCatalogModel[]> {
	let embeddingModels: ProviderCatalogModel[];
	try {
		embeddingModels = await fetchOpenRouterEmbeddingsModels(ctx);
	} catch (err) {
		logWarn('openaiCompatible.listModels', 'OpenRouter embeddings-models fetch failed; returning chat-only catalog', err);
		return chatModels;
	}
	const byId = new Map<string, ProviderCatalogModel>();
	for (const model of chatModels) byId.set(model.id, model);
	for (const model of embeddingModels) byId.set(model.id, model);
	return Array.from(byId.values());
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
