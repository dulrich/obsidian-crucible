import { App } from 'obsidian';
import { Provider, ProviderCatalogModel, ProviderCompletionResult, ProviderEmbeddingResult, ProviderImageExtractionResult, ProviderKind, ProviderModelDescription, ProviderRerankResult, providerModality } from './types';
import { HttpListCallContext, HttpProviderClient, arrayBufferToBase64, buildRerankFallbackUserPrompt, IMAGE_DESCRIPTION_EXTRACTION_MAX_TOKENS, IMAGE_DESCRIPTION_EXTRACTION_PROMPT, IMAGE_DESCRIPTION_NARRATIVE_MAX_TOKENS, IMAGE_DESCRIPTION_NARRATIVE_PROMPT, parseRerankCompletionText, RERANK_FALLBACK_SYSTEM_PROMPT } from './providers/shared';
import { isLocal as isLocalProvider, openAICompatibleClient } from './providers/openaiCompatible';
import { anthropicClient } from './providers/anthropic';
import { googleClient } from './providers/google';
import { ollamaClient } from './providers/ollama';
import { ProviderCompletionOptions, runCliCompletion } from './providers/cli';
import type { SecretRegistry } from './secretRegistry';
import { logWarn } from './log';

export { CLI_DEFAULT_TIMEOUT_SECONDS } from './providers/cli';
export type { ProviderCompletionOptions } from './providers/cli';

export const providerSecretKey = (id: string) => `crucible-provider-${id}-key`;

// rsp-wp1: default resolution for Provider.maxConcurrentRequests. An explicit positive value
// always wins; otherwise local providers — reusing `isLocal` from providers/openaiCompatible.ts,
// the exact detection that already gates `reasoning_effort` there, rather than a second "is
// local" heuristic — default to 1 (measured: a single-GPU local inference-engine gains no
// throughput from concurrency, and pile-up pushed the tail across the 120s timeout; see
// `runs/dispatch/feedback-image-timeout-investigation.md`). Everything else (cloud HTTP kinds and
// CLI kinds, which run their own local subprocess rather than sharing a GPU-bound HTTP server)
// defaults to unlimited (`Infinity`) — a CLI provider that does share a constrained local
// resource can still be capped by setting the field explicitly.
export function resolveProviderConcurrencyLimit(provider: Provider): number {
	const configured = provider.maxConcurrentRequests;
	if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
		return configured;
	}
	return isLocalProvider(provider) ? 1 : Infinity;
}

interface ConcurrencyState {
	active: number;
	waiters: Array<() => void>;
}

// Per-provider-id completion-class concurrency limiter (rsp-wp1). Only the three ProviderManager
// methods that shape a chat/completions-style request (complete, describeImage,
// extractImageMetadata) route through this — embed() and the native rerank() path never do, by
// design (a different model/latency class; serializing a search embed behind a 2-minute vision
// call would be a regression). Keyed by provider id, not object identity, so in-flight requests
// still share a queue with ones issued after the provider's settings are edited.
class ProviderConcurrencyLimiter {
	private readonly states = new Map<string, ConcurrencyState>();

	// Runs fn() so that at most `limit` calls for the same providerId are in flight at once; extra
	// callers queue FIFO (a released slot hands off directly to the oldest waiter). `limit` <= 0 or
	// non-finite means unlimited — fn() runs immediately with no queue bookkeeping, so the common
	// case (cloud providers) pays zero overhead.
	//
	// LOAD-BEARING: the slot is held for the lifetime of the fn() promise, not for however long a
	// caller waits on the result of run(). A caller racing this against its own timeout
	// (`withTimeout` in orchestration/utils/imageDescribe.ts) and giving up early does NOT release
	// the slot early — fn() (which wraps the actual `requestUrl` call, not anything above it) keeps
	// running to completion and only then triggers `finally`. `requestUrl` has no abort signal, so
	// the HTTP request — and the GPU slot it holds server-side — is still in flight regardless of
	// whether anything is still awaiting it; releasing on abandon instead of on settle would free a
	// plugin-side slot the server is still busy on, letting the next request pile onto it and
	// reproducing the exact amplifier the investigation measured (7/7 "transient" timeouts were
	// requests that had actually completed 2-16s after the plugin gave up).
	async run<T>(providerId: string, limit: number, fn: () => Promise<T>): Promise<T> {
		if (!Number.isFinite(limit) || limit <= 0) return fn();
		await this.acquire(providerId, limit);
		try {
			return await fn();
		} finally {
			this.release(providerId);
		}
	}

	private acquire(providerId: string, limit: number): Promise<void> {
		const state = this.stateFor(providerId);
		if (state.active < limit) {
			state.active++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => { state.waiters.push(resolve); });
	}

	private release(providerId: string): void {
		const state = this.states.get(providerId);
		if (!state) return;
		const next = state.waiters.shift();
		if (next) {
			// Hand the slot straight to the oldest waiter — `active` is unchanged, so the count
			// stays correct without a decrement/re-increment race.
			next();
			return;
		}
		state.active = Math.max(0, state.active - 1);
	}

	private stateFor(providerId: string): ConcurrencyState {
		let state = this.states.get(providerId);
		if (!state) {
			state = { active: 0, waiters: [] };
			this.states.set(providerId, state);
		}
		return state;
	}
}

// Registry of HTTP-backed provider clients. A client only declares the capabilities it supports
// (embed/extractImage are optional), so ProviderManager dispatches by looking up the client and
// the method — no per-capability switch statements, and "not supported" is a missing method.
const HTTP_PROVIDER_CLIENTS: Partial<Record<ProviderKind, HttpProviderClient>> = {
	openai: openAICompatibleClient,
	openrouter: openAICompatibleClient,
	'openai-compatible': openAICompatibleClient,
	anthropic: anthropicClient,
	google: googleClient,
	ollama: ollamaClient,
};

// Optional-capability method names requireCapability can be asked for. A Record keyed by this
// union (rather than a string label) is what lets the CLI-provider rejection message below stay
// a lookup instead of a ternary chain: adding a capability that forgets an entry here is a
// compile error, not a wrong sentence at runtime.
type OptionalHttpCapability = 'embed' | 'extractImage' | 'describeImagePass' | 'rerank' | 'describeModel' | 'listModels';

const CLI_UNSUPPORTED_VERB: Record<OptionalHttpCapability, string> = {
	embed: 'generate embeddings',
	extractImage: 'extract image metadata',
	describeImagePass: 'describe images',
	rerank: 'rerank results',
	describeModel: 'describe the loaded model',
	listModels: 'list available models',
};

export class ProviderManager {
	app: App;

	// Session-lifetime caches (this instance lives for the plugin's lifetime — see main.ts). Both
	// exist to satisfy the same constraint: describeModel() runs on the indexing path via embed(),
	// and must not add an HTTP round-trip per batch. Caching the *promise* (not just the resolved
	// value) means concurrent embed() calls for the same provider+model share one in-flight
	// request, and a rejected probe stays cached too — a broken metadata endpoint costs one probe
	// for the session, not one per batch.
	private readonly describeModelCache = new Map<string, Promise<ProviderModelDescription>>();
	private readonly servedModelMismatchWarned = new Set<string>();
	// Same shape as describeModelCache but keyed by provider id alone — a list probe has no modelId.
	// Caches the *promise*, so concurrent callers share one in-flight request. Unlike
	// describeModelCache it does NOT retain a settled rejection: listModels() eviction on failure is
	// explained at the method below. clearModelListCache() is the escape hatch the WP-D "Clear
	// cache" button should call alongside removing Provider.modelCatalog from settings — without
	// it, a session-cached *successful* stale list would outlive an explicit user clear.
	private readonly listModelsCache = new Map<string, Promise<ProviderCatalogModel[]>>();
	// rsp-wp1: gates completion-class calls only — see ProviderConcurrencyLimiter's doc comment.
	private readonly concurrency = new ProviderConcurrencyLimiter();

	constructor(app: App, private readonly secrets: SecretRegistry) {
		this.app = app;
	}

	async loadApiKey(providerId: string): Promise<string> {
		return this.secrets.get(providerSecretKey(providerId));
	}

	async storeApiKey(providerId: string, key: string): Promise<void> {
		await this.secrets.store(providerSecretKey(providerId), key);
	}

	async deleteApiKey(providerId: string): Promise<void> {
		await this.secrets.clear(providerSecretKey(providerId));
	}

	async complete(provider: Provider, modelId: string, system: string, user: string, options: ProviderCompletionOptions = {}): Promise<ProviderCompletionResult> {
		if (!modelId) {
			throw new Error(`No model selected for provider "${provider.name || provider.id}"`);
		}
		// rsp-wp1: the limiter wraps the actual call (CLI process or HTTP client), not this method —
		// see ProviderConcurrencyLimiter's release-on-settle comment for why that boundary matters.
		return await this.concurrency.run(provider.id, resolveProviderConcurrencyLimit(provider), async () => {
			if (providerModality(provider.kind) === 'cli') {
				const text = await runCliCompletion(this.app, provider, modelId, system, user, options);
				return { text, finishReason: 'stop' };
			}
			const client = HTTP_PROVIDER_CLIENTS[provider.kind];
			if (!client) throw new Error("Unsupported provider kind: " + (provider.kind as string));
			return await client.complete(await this.httpContext(provider, modelId), system, user);
		});
	}

	async embed(provider: Provider, modelId: string, inputs: string[]): Promise<ProviderEmbeddingResult> {
		if (!modelId) {
			throw new Error(`No embedding model selected for provider "${provider.name || provider.id}"`);
		}
		if (inputs.length === 0) return { embeddings: [] };
		const client = this.requireCapability(provider, 'embed', 'embeddings');
		// Best-effort, cached probe of what the server actually loaded (WP-2). This is the
		// mechanism behind the cross-encoder-as-embedder warning: each client's describeModel()
		// checks the served model id/arch against the reranker heuristic and warns (once per
		// session, never throws) internally. Awaited (not fire-and-forget) so the warning is
		// guaranteed to have run before the first batch indexes — but the cache above means this
		// is a one-time cost per provider+model for the whole session, not a round trip per batch,
		// and a probe failure never propagates to the embed() caller (see probeModelForSideEffects).
		await this.probeModelForSideEffects(provider, modelId);
		const result = await client.embed(await this.httpContext(provider, modelId), inputs);
		this.warnOnServedModelMismatch(provider, modelId, result.servedModel);
		return result;
	}

	// Asks the provider's HTTP client what it actually loaded for modelId — see
	// HttpProviderClient.describeModel and ProviderModelDescription for the shape and why
	// `precision` (not `fingerprint`) is the part WP-3 persists as a comparable key. Results are
	// cached per (provider, modelId) for the session; see the field comment on describeModelCache.
	async describeModel(provider: Provider, modelId: string): Promise<ProviderModelDescription> {
		if (!modelId) {
			throw new Error(`No model selected for provider "${provider.name || provider.id}"`);
		}
		const client = this.requireCapability(provider, 'describeModel', 'model introspection');
		const key = `${provider.id}::${modelId}`;
		let cached = this.describeModelCache.get(key);
		if (!cached) {
			cached = client.describeModel(await this.httpContext(provider, modelId));
			this.describeModelCache.set(key, cached);
		}
		return cached;
	}

	// Enumerates what the provider's server actually offers (WP-C). Unlike describeModel(), this
	// has no modelId to key on — cached per provider id alone (see the field comment on
	// listModelsCache). Per D2, this method's result is display-only data for a caller (WP-D's
	// settings UI) to surface and let the user Accept — nothing in this file or in any
	// HttpProviderClient.listModels() implementation may write to a ProviderModel's
	// capabilities/embeddingDimensions/embeddingVariant.
	// Deliberately UNLIKE describeModelCache in one respect: a rejection is evicted rather than
	// cached. describeModel() runs unattended on the indexing path, where re-probing a dead server
	// once per batch is pure waste, so caching its failure is right. listModels() is only ever
	// reached from a user clicking "Fetch" — and a user who clicks Fetch, sees "server
	// unreachable", starts their server, and clicks Fetch again means "try again". Caching the
	// rejection would answer that second click with the first click's stale failure until they
	// found the Clear-cache button or reloaded Obsidian. The promise is still cached while
	// in flight, so concurrent callers share one request; only the settled failure is dropped.
	async listModels(provider: Provider): Promise<ProviderCatalogModel[]> {
		const client = this.requireCapability(provider, 'listModels', 'list available models');
		let cached = this.listModelsCache.get(provider.id);
		if (!cached) {
			cached = client.listModels(await this.httpListContext(provider)).catch((err) => {
				this.listModelsCache.delete(provider.id);
				throw err;
			});
			this.listModelsCache.set(provider.id, cached);
		}
		return cached;
	}

	// Drops the session-cached list (including a cached failure) for one provider, or every
	// provider when called with no id. The settings UI's "Clear cache" action should call this
	// alongside removing Provider.modelCatalog from settings — otherwise a stale or failed
	// session-cached promise would silently outlive an explicit user clear until Obsidian reloads.
	clearModelListCache(providerId?: string): void {
		if (providerId === undefined) {
			this.listModelsCache.clear();
			return;
		}
		this.listModelsCache.delete(providerId);
	}

	// Fire-and-forget wrapper around describeModel(), called from embed() purely for its side
	// effects (populating the session cache, letting the client warn on a cross-encoder-shaped
	// model). A describeModel failure — unreachable metadata endpoint, unsupported server,
	// transient network error — must never propagate to the embed() caller; it just means
	// precision/fingerprint stay unavailable for this session, which downstream code already
	// treats as a clean unknown.
	private async probeModelForSideEffects(provider: Provider, modelId: string): Promise<void> {
		if (!HTTP_PROVIDER_CLIENTS[provider.kind]?.describeModel) return;
		try {
			await this.describeModel(provider, modelId);
		} catch {
			/* diagnostic only — see method comment */
		}
	}

	// The embed response's own echoed `model` field (LM Studio/OpenAI-compatible and ollama both
	// send one) can legitimately differ from the requested id — a server may resolve an alias or
	// serve a dated revision — so this warns rather than throws, and only once per (provider,
	// modelId) per session so a hot indexing loop doesn't spam it per batch.
	private warnOnServedModelMismatch(provider: Provider, requestedModelId: string, servedModel: string | undefined): void {
		if (!servedModel || servedModel === requestedModelId) return;
		const key = `${provider.id}::${requestedModelId}`;
		if (this.servedModelMismatchWarned.has(key)) return;
		this.servedModelMismatchWarned.add(key);
		logWarn(`Provider "${provider.name || provider.id}" echoed a different served model ("${servedModel}") than requested ("${requestedModelId}") for embeddings — the server may have resolved an alias or a different revision.`);
	}

	async extractImageMetadata(provider: Provider, modelId: string, imageBytes: ArrayBuffer, mimeType: string): Promise<ProviderImageExtractionResult> {
		if (!modelId) {
			throw new Error(`No image extraction model selected for provider "${provider.name || provider.id}"`);
		}
		const client = this.requireCapability(provider, 'extractImage', 'image extraction');
		// rsp-wp1: same completion-class limiter as complete()/describeImage() — this is a
		// chat/completions-shaped vision call, not embed/rerank.
		return await this.concurrency.run(provider.id, resolveProviderConcurrencyLimit(provider), async () => {
			return await client.extractImage(await this.httpContext(provider, modelId), arrayBufferToBase64(imageBytes), mimeType);
		});
	}

	// WP-1's two-pass description call (`docs/multimodal-image-search.md`, Decision 2): one call
	// per pass ('narrative' | 'extraction'), each stored as its own chunk by WP-2 rather than
	// concatenated — see the prompt constants' own comment for why. Gated the same way as
	// extractImageMetadata just above: requireCapability on the client method, not on a
	// ProviderModelCapability check — capability *presence* is an HTTP-client concern, capability
	// *selection* (which model the user picked for this) is the settings UI's job, same division
	// extractImageMetadata already draws.
	async describeImage(provider: Provider, modelId: string, imageBytes: ArrayBuffer, mimeType: string, pass: 'narrative' | 'extraction'): Promise<string> {
		if (!modelId) {
			throw new Error(`No image description model selected for provider "${provider.name || provider.id}"`);
		}
		const client = this.requireCapability(provider, 'describeImagePass', 'image description');
		const prompt = pass === 'narrative' ? IMAGE_DESCRIPTION_NARRATIVE_PROMPT : IMAGE_DESCRIPTION_EXTRACTION_PROMPT;
		const maxTokens = pass === 'narrative' ? IMAGE_DESCRIPTION_NARRATIVE_MAX_TOKENS : IMAGE_DESCRIPTION_EXTRACTION_MAX_TOKENS;
		// rsp-wp1: the measured pile-up path (image_describe_batch/note against a single-GPU local
		// server) — gated by the same completion-class limiter as complete().
		return await this.concurrency.run(provider.id, resolveProviderConcurrencyLimit(provider), async () => {
			return await client.describeImagePass(await this.httpContext(provider, modelId), arrayBufferToBase64(imageBytes), mimeType, prompt, maxTokens);
		});
	}

	// WP-5: rerank has two backends. Primary is the provider's native rerank() (currently only
	// the openai-compatible client, targeting Infinity's /rerank) — routed through
	// requireCapability exactly like embed/extractImage, so "not supported" stays a missing-
	// method check rather than a parallel dispatch mechanism. When the provider has no native
	// rerank(), this falls back to scoring the candidates with one structured complete() call
	// (see RERANK_FALLBACK_SYSTEM_PROMPT) — which reuses complete()'s own dispatch, so CLI
	// providers work as a fallback reranker too, and a provider kind with neither backend still
	// fails through complete()'s existing precise "Unsupported provider kind" error rather than
	// throwing something new here.
	async rerank(provider: Provider, modelId: string, query: string, documents: string[]): Promise<ProviderRerankResult> {
		if (!modelId) {
			throw new Error(`No model selected for provider "${provider.name || provider.id}"`);
		}
		if (documents.length === 0) return { results: [] };
		if (this.hasNativeRerank(provider)) {
			const client = this.requireCapability(provider, 'rerank', 'reranking');
			return await client.rerank(await this.httpContext(provider, modelId), query, documents);
		}
		const completion = await this.complete(provider, modelId, RERANK_FALLBACK_SYSTEM_PROMPT, buildRerankFallbackUserPrompt(query, documents));
		return { results: parseRerankCompletionText(completion.text, documents.length) };
	}

	private hasNativeRerank(provider: Provider): boolean {
		if (providerModality(provider.kind) === 'cli') return false;
		return !!HTTP_PROVIDER_CLIENTS[provider.kind]?.rerank;
	}

	// Resolve an HTTP client that implements the named capability, or throw the precise reason it
	// can't run (CLI provider, unknown kind, or capability not implemented).
	private requireCapability<M extends OptionalHttpCapability>(
		provider: Provider,
		method: M,
		label: string,
	): HttpProviderClient & Required<Pick<HttpProviderClient, M>> {
		if (providerModality(provider.kind) === 'cli') {
			throw new Error(`Provider "${provider.name || provider.id}" is a CLI provider and cannot ${CLI_UNSUPPORTED_VERB[method]}`);
		}
		const client = HTTP_PROVIDER_CLIENTS[provider.kind];
		if (!client?.[method]) {
			throw new Error(`Provider kind "${provider.kind}" does not support ${label} yet`);
		}
		return client as HttpProviderClient & Required<Pick<HttpProviderClient, M>>;
	}

	// Load + validate the API key once for any HTTP provider call. Ollama needs no key;
	// openai-compatible (local servers like LM Studio) may optionally carry one.
	private async httpContext(provider: Provider, modelId: string): Promise<{ provider: Provider; modelId: string; apiKey: string }> {
		const apiKey = provider.kind === 'ollama' ? '' : await this.loadApiKey(provider.id);
		if (!apiKey && provider.kind !== 'ollama' && provider.kind !== 'openai-compatible') {
			throw new Error(`API key missing for provider "${provider.name || provider.id}" — re-enter it in Settings → AI.`);
		}
		return { provider, modelId, apiKey };
	}

	// Same idea as httpContext(), but deliberately does NOT throw when no key is stored. A list
	// probe is triggered by a user clicking "Fetch" to see what's available, possibly *before* they
	// have entered a key — and per the WP-C plan's per-kind table, openrouter's `/models` endpoint
	// specifically needs no key at all. Rather than special-case openrouter, this lets every kind
	// attempt the request with whatever key (or none) is on hand; a key-requiring server that gets
	// none simply answers with its own 401/403, which listModels() surfaces as a normal thrown
	// error instead of a pre-flight guess about which kinds need a key.
	private async httpListContext(provider: Provider): Promise<HttpListCallContext> {
		const apiKey = provider.kind === 'ollama' ? '' : await this.loadApiKey(provider.id);
		return { provider, apiKey };
	}
}
