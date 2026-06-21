import { App } from 'obsidian';
import { Provider, ProviderCompletionResult, ProviderEmbeddingResult, ProviderImageExtractionResult, ProviderKind, providerModality } from './types';
import { HttpProviderClient, arrayBufferToBase64 } from './providers/shared';
import { openAICompatibleClient } from './providers/openaiCompatible';
import { anthropicClient } from './providers/anthropic';
import { googleClient } from './providers/google';
import { ollamaClient } from './providers/ollama';
import { ProviderCompletionOptions, runCliCompletion } from './providers/cli';

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

export class ProviderManager {
	app: App;

	constructor(app: App) {
		this.app = app;
	}

	async loadApiKey(providerId: string): Promise<string> {
		if (!this.app.secretStorage) return '';
		return this.app.secretStorage.getSecret(providerSecretKey(providerId)) || '';
	}

	async storeApiKey(providerId: string, key: string): Promise<void> {
		if (!this.app.secretStorage) return;
		this.app.secretStorage.setSecret(providerSecretKey(providerId), key);
	}

	async deleteApiKey(providerId: string): Promise<void> {
		if (!this.app.secretStorage) return;
		// SecretStorage doesn't always have an explicit delete, so we clear it.
		this.app.secretStorage.setSecret(providerSecretKey(providerId), '');
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

	// Resolve an HTTP client that implements the named capability, or throw the precise reason it
	// can't run (CLI provider, unknown kind, or capability not implemented).
	private requireCapability<M extends 'embed' | 'extractImage'>(
		provider: Provider,
		method: M,
		label: string,
	): HttpProviderClient & Required<Pick<HttpProviderClient, M>> {
		if (providerModality(provider.kind) === 'cli') {
			throw new Error(`Provider "${provider.name || provider.id}" is a CLI provider and cannot ${label === 'embeddings' ? 'generate embeddings' : 'extract image metadata'}`);
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
			throw new Error(`API key missing for provider "${provider.name || provider.id}"`);
		}
		return { provider, modelId, apiKey };
	}
}
