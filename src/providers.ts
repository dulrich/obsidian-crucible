import { App } from 'obsidian';
import { Provider, ProviderCompletionResult, ProviderEmbeddingResult, ProviderImageExtractionResult, ProviderKind, ProviderRerankResult, providerModality } from './types';
import { HttpProviderClient, arrayBufferToBase64, buildRerankFallbackUserPrompt, parseRerankCompletionText, RERANK_FALLBACK_SYSTEM_PROMPT } from './providers/shared';
import { openAICompatibleClient } from './providers/openaiCompatible';
import { anthropicClient } from './providers/anthropic';
import { googleClient } from './providers/google';
import { ollamaClient } from './providers/ollama';
import { ProviderCompletionOptions, runCliCompletion } from './providers/cli';
import type { SecretRegistry } from './secretRegistry';

export { CLI_DEFAULT_TIMEOUT_SECONDS } from './providers/cli';
export type { ProviderCompletionOptions } from './providers/cli';

export const providerSecretKey = (id: string) => `crucible-provider-${id}-key`;

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
type OptionalHttpCapability = 'embed' | 'extractImage' | 'rerank';

const CLI_UNSUPPORTED_VERB: Record<OptionalHttpCapability, string> = {
	embed: 'generate embeddings',
	extractImage: 'extract image metadata',
	rerank: 'rerank results',
};

export class ProviderManager {
	app: App;

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
		if (providerModality(provider.kind) === 'cli') {
			const text = await runCliCompletion(this.app, provider, modelId, system, user, options);
			return { text, finishReason: 'stop' };
		}
		const client = HTTP_PROVIDER_CLIENTS[provider.kind];
		if (!client) throw new Error("Unsupported provider kind: " + (provider.kind as string));
		return await client.complete(await this.httpContext(provider, modelId), system, user);
	}

	async embed(provider: Provider, modelId: string, inputs: string[]): Promise<ProviderEmbeddingResult> {
		if (!modelId) {
			throw new Error(`No embedding model selected for provider "${provider.name || provider.id}"`);
		}
		if (inputs.length === 0) return { embeddings: [] };
		const client = this.requireCapability(provider, 'embed', 'embeddings');
		return await client.embed(await this.httpContext(provider, modelId), inputs);
	}

	async extractImageMetadata(provider: Provider, modelId: string, imageBytes: ArrayBuffer, mimeType: string): Promise<ProviderImageExtractionResult> {
		if (!modelId) {
			throw new Error(`No image extraction model selected for provider "${provider.name || provider.id}"`);
		}
		const client = this.requireCapability(provider, 'extractImage', 'image extraction');
		return await client.extractImage(await this.httpContext(provider, modelId), arrayBufferToBase64(imageBytes), mimeType);
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
}
