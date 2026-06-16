import { requestUrl } from 'obsidian';
import { Provider, ProviderCompletionResult, ProviderEmbeddingResult, ProviderFinishReason, ProviderImageExtractionResult } from '../types';
import {
	HttpCallContext,
	HttpProviderClient,
	IMAGE_EXTRACTION_SYSTEM_PROMPT,
	IMAGE_EXTRACTION_USER_PROMPT,
	normalizeEmbedding,
	normalizeRawFinishReason,
	parseImageExtractionResult,
} from './shared';

const OPENROUTER_HEADERS = {
	'HTTP-Referer': 'https://github.com/dulrich/obsidian-crucible',
	'X-Title': 'Crucible Obsidian Plugin',
};

function isOpenRouter(provider: Provider): boolean {
	return provider.kind === 'openrouter';
}

function label(provider: Provider): string {
	return isOpenRouter(provider) ? 'OpenRouter' : 'OpenAI';
}

// Honoured by the embedding + image endpoints (completion uses the fixed vendor URL, matching
// the original behaviour).
function apiBaseUrl(provider: Provider): string {
	const fallback = isOpenRouter(provider) ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1';
	return (provider.baseUrl || fallback).replace(/\/$/, '');
}

function authHeaders(ctx: HttpCallContext): Record<string, string> {
	return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ctx.apiKey}` };
}

export const openAICompatibleClient: HttpProviderClient = {
	async complete(ctx, system, user): Promise<ProviderCompletionResult> {
		const openRouter = isOpenRouter(ctx.provider);
		const response = await requestUrl({
			url: openRouter ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions',
			method: 'POST',
			headers: openRouter ? { ...authHeaders(ctx), ...OPENROUTER_HEADERS } : authHeaders(ctx),
			body: JSON.stringify({
				model: ctx.modelId,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: user },
				],
				// OpenAI pins a sampling temperature; OpenRouter intentionally leaves it to the model default.
				...(openRouter ? {} : { temperature: 0.7 }),
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

		const data = response.json as { data?: { embedding?: number[], index?: number }[] };
		const rows = (data.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		const embeddings = rows.map(row => normalizeEmbedding(row.embedding));
		if (embeddings.length !== inputs.length) {
			throw new Error(`${label(ctx.provider)} embeddings API returned ${embeddings.length} embeddings for ${inputs.length} inputs`);
		}
		return { embeddings, dimensions: embeddings[0]?.length };
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
