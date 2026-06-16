import { requestUrl } from 'obsidian';
import { Provider, ProviderCompletionResult, ProviderEmbeddingResult, ProviderFinishReason, ProviderImageExtractionResult } from '../types';
import {
	HttpProviderClient,
	IMAGE_EXTRACTION_SYSTEM_PROMPT,
	IMAGE_EXTRACTION_USER_PROMPT,
	normalizeEmbedding,
	normalizeRawFinishReason,
	parseImageExtractionResult,
} from './shared';

function baseUrl(provider: Provider): string {
	return (provider.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
}

export const ollamaClient: HttpProviderClient = {
	async complete(ctx, system, user): Promise<ProviderCompletionResult> {
		const response = await requestUrl({
			url: `${baseUrl(ctx.provider)}/api/chat`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: ctx.modelId,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: user },
				],
				stream: false,
			}),
		});

		if (response.status !== 200) {
			throw new Error(`Ollama API returned ${response.status}: ${response.text}`);
		}

		const data = response.json as { message?: { content?: string }, done_reason?: string | null };
		const rawFinishReason = normalizeRawFinishReason(data.done_reason);
		return {
			text: data.message?.content ?? '',
			finishReason: normalizeOllamaFinishReason(rawFinishReason),
			rawFinishReason,
		};
	},

	async embed(ctx, inputs): Promise<ProviderEmbeddingResult> {
		const response = await requestUrl({
			url: `${baseUrl(ctx.provider)}/api/embed`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: ctx.modelId, input: inputs }),
		});

		if (response.status !== 200) {
			throw new Error(`Ollama embeddings API returned ${response.status}: ${response.text}`);
		}

		const data = response.json as { embeddings?: number[][], embedding?: number[] };
		const embeddings = data.embeddings
			? data.embeddings.map(normalizeEmbedding)
			: data.embedding
				? [normalizeEmbedding(data.embedding)]
				: [];
		if (embeddings.length !== inputs.length) {
			throw new Error(`Ollama embeddings API returned ${embeddings.length} embeddings for ${inputs.length} inputs`);
		}
		return { embeddings, dimensions: embeddings[0]?.length };
	},

	async extractImage(ctx, base64): Promise<ProviderImageExtractionResult> {
		const response = await requestUrl({
			url: `${baseUrl(ctx.provider)}/api/chat`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: ctx.modelId,
				messages: [
					{ role: 'system', content: IMAGE_EXTRACTION_SYSTEM_PROMPT },
					{ role: 'user', content: IMAGE_EXTRACTION_USER_PROMPT, images: [base64] },
				],
				stream: false,
				options: { temperature: 0 },
			}),
		});

		if (response.status !== 200) {
			throw new Error(`Ollama image extraction API returned ${response.status}: ${response.text}`);
		}

		const data = response.json as { message?: { content?: string }, done_reason?: string | null };
		const rawFinishReason = normalizeRawFinishReason(data.done_reason);
		return parseImageExtractionResult(data.message?.content ?? '', normalizeOllamaFinishReason(rawFinishReason), rawFinishReason);
	},
};

function normalizeOllamaFinishReason(raw: string | undefined): ProviderFinishReason {
	if (!raw) return 'unknown';
	switch (raw.toLowerCase()) {
		case 'stop': return 'stop';
		case 'length':
		case 'max_tokens': return 'length';
		default: return 'other';
	}
}
