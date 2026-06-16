import { requestUrl } from 'obsidian';
import { ProviderCompletionResult, ProviderFinishReason, ProviderImageExtractionResult } from '../types';
import {
	HttpProviderClient,
	IMAGE_EXTRACTION_SYSTEM_PROMPT,
	IMAGE_EXTRACTION_USER_PROMPT,
	normalizeRawFinishReason,
	parseImageExtractionResult,
} from './shared';

function generateContentUrl(modelId: string, apiKey: string): string {
	return `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
}

export const googleClient: HttpProviderClient = {
	async complete(ctx, system, user): Promise<ProviderCompletionResult> {
		const response = await requestUrl({
			url: generateContentUrl(ctx.modelId, ctx.apiKey),
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				system_instruction: system ? { parts: [{ text: system }] } : undefined,
				contents: [{ role: 'user', parts: [{ text: user }] }],
				generationConfig: {
					temperature: 0.7,
					maxOutputTokens: 4096,
				},
			}),
		});

		if (response.status !== 200) {
			throw new Error("Google API returned " + response.status + ": " + response.text);
		}

		const data = response.json as { candidates: { content?: { parts?: { text?: string }[] }, finishReason?: string }[] };
		const candidate = data.candidates[0];
		if (!candidate) throw new Error('Google API returned no candidates');
		const rawFinishReason = normalizeRawFinishReason(candidate.finishReason);
		return {
			text: (candidate.content?.parts ?? []).map(part => part.text ?? '').join(''),
			finishReason: normalizeGoogleFinishReason(rawFinishReason),
			rawFinishReason,
		};
	},

	async extractImage(ctx, base64, mimeType): Promise<ProviderImageExtractionResult> {
		const response = await requestUrl({
			url: generateContentUrl(ctx.modelId, ctx.apiKey),
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				system_instruction: { parts: [{ text: IMAGE_EXTRACTION_SYSTEM_PROMPT }] },
				contents: [
					{
						role: 'user',
						parts: [
							{ text: IMAGE_EXTRACTION_USER_PROMPT },
							{ inline_data: { mime_type: mimeType, data: base64 } },
						],
					},
				],
				generationConfig: {
					temperature: 0,
					maxOutputTokens: 4096,
				},
			}),
		});

		if (response.status !== 200) {
			throw new Error(`Google image extraction API returned ${response.status}: ${response.text}`);
		}

		const data = response.json as { candidates?: { content?: { parts?: { text?: string }[] }, finishReason?: string }[] };
		const candidate = data.candidates?.[0];
		if (!candidate) throw new Error('Google image extraction API returned no candidates');
		const rawFinishReason = normalizeRawFinishReason(candidate.finishReason);
		return parseImageExtractionResult((candidate.content?.parts ?? []).map(part => part.text ?? '').join(''), normalizeGoogleFinishReason(rawFinishReason), rawFinishReason);
	},
};

function normalizeGoogleFinishReason(raw: string | undefined): ProviderFinishReason {
	if (!raw) return 'unknown';
	switch (raw.toUpperCase()) {
		case 'STOP': return 'stop';
		case 'MAX_TOKENS': return 'length';
		case 'SAFETY':
		case 'RECITATION':
		case 'BLOCKLIST':
		case 'PROHIBITED_CONTENT':
		case 'SPII': return 'content_filter';
		case 'MALFORMED_FUNCTION_CALL': return 'tool_calls';
		case 'FINISH_REASON_UNSPECIFIED': return 'unknown';
		default: return 'other';
	}
}
