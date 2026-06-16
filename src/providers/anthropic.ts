import { requestUrl } from 'obsidian';
import { ProviderCompletionResult, ProviderFinishReason, ProviderImageExtractionResult } from '../types';
import {
	HttpProviderClient,
	IMAGE_EXTRACTION_SYSTEM_PROMPT,
	IMAGE_EXTRACTION_USER_PROMPT,
	normalizeRawFinishReason,
	parseImageExtractionResult,
} from './shared';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

function headers(apiKey: string): Record<string, string> {
	return {
		'Content-Type': 'application/json',
		'x-api-key': apiKey,
		'anthropic-version': '2023-06-01',
	};
}

export const anthropicClient: HttpProviderClient = {
	async complete(ctx, system, user): Promise<ProviderCompletionResult> {
		const response = await requestUrl({
			url: ANTHROPIC_MESSAGES_URL,
			method: 'POST',
			headers: headers(ctx.apiKey),
			body: JSON.stringify({
				model: ctx.modelId,
				system,
				messages: [{ role: 'user', content: user }],
				max_tokens: 4096,
			}),
		});

		if (response.status !== 200) {
			throw new Error(`Anthropic API returned ${response.status}: ${response.text}`);
		}

		const data = response.json as { content?: { text?: string }[], stop_reason?: string | null };
		const rawFinishReason = normalizeRawFinishReason(data.stop_reason);
		return {
			text: (data.content ?? []).map(block => block.text ?? '').join(''),
			finishReason: normalizeAnthropicFinishReason(rawFinishReason),
			rawFinishReason,
		};
	},

	async extractImage(ctx, base64, mimeType): Promise<ProviderImageExtractionResult> {
		const response = await requestUrl({
			url: ANTHROPIC_MESSAGES_URL,
			method: 'POST',
			headers: headers(ctx.apiKey),
			body: JSON.stringify({
				model: ctx.modelId,
				system: IMAGE_EXTRACTION_SYSTEM_PROMPT,
				messages: [
					{
						role: 'user',
						content: [
							{ type: 'text', text: IMAGE_EXTRACTION_USER_PROMPT },
							{ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
						],
					},
				],
				max_tokens: 4096,
				temperature: 0,
			}),
		});

		if (response.status !== 200) {
			throw new Error(`Anthropic image extraction API returned ${response.status}: ${response.text}`);
		}

		const data = response.json as { content?: { text?: string }[], stop_reason?: string | null };
		const rawFinishReason = normalizeRawFinishReason(data.stop_reason);
		return parseImageExtractionResult((data.content ?? []).map(block => block.text ?? '').join(''), normalizeAnthropicFinishReason(rawFinishReason), rawFinishReason);
	},
};

function normalizeAnthropicFinishReason(raw: string | undefined): ProviderFinishReason {
	if (!raw) return 'unknown';
	switch (raw.toLowerCase()) {
		case 'end_turn':
		case 'stop_sequence': return 'stop';
		case 'max_tokens': return 'length';
		case 'tool_use': return 'tool_calls';
		case 'refusal': return 'content_filter';
		case 'pause_turn': return 'other';
		default: return 'other';
	}
}
