import { Provider, ProviderCompletionResult, ProviderEmbeddingResult, ProviderFinishReason, ProviderImageExtractionResult } from '../types';

// Everything a per-provider HTTP client needs to issue a request: the provider config, the
// resolved model id, and the API key (already loaded + validated by ProviderManager). Each
// client reads provider.baseUrl / provider.kind for its own URL + header quirks.
export interface HttpCallContext {
	provider: Provider;
	modelId: string;
	apiKey: string;
}

// Capability surface for an HTTP-backed provider. `complete` is required; `embed` and
// `extractImage` are present only on providers that support them, so ProviderManager can throw
// a precise "not supported" by checking for the method rather than maintaining switch arms.
export interface HttpProviderClient {
	complete(ctx: HttpCallContext, system: string, user: string): Promise<ProviderCompletionResult>;
	embed?(ctx: HttpCallContext, inputs: string[]): Promise<ProviderEmbeddingResult>;
	extractImage?(ctx: HttpCallContext, base64: string, mimeType: string): Promise<ProviderImageExtractionResult>;
}

export const IMAGE_EXTRACTION_SYSTEM_PROMPT = [
	'You extract searchable metadata from an image for a personal knowledge base.',
	'Return only compact JSON with these keys:',
	'- description: a precise natural-language description of the image.',
	'- extractedText: all readable text/OCR content from the image, preserving useful line breaks.',
	'If there is no readable text, extractedText must be an empty string.',
].join('\n');

export const IMAGE_EXTRACTION_USER_PROMPT = 'Describe this image and extract any visible text, including text in charts, infographics, screenshots, tables, and diagrams.';

export function normalizeRawFinishReason(reason: unknown): string | undefined {
	if (typeof reason !== 'string') return undefined;
	const trimmed = reason.trim();
	return trimmed ? trimmed : undefined;
}

export function normalizeEmbedding(value: unknown): number[] {
	if (!Array.isArray(value)) throw new Error('Embedding response contained a non-array embedding');
	const out = value.map(v => Number(v));
	if (out.length === 0 || out.some(v => !Number.isFinite(v))) {
		throw new Error('Embedding response contained invalid numeric values');
	}
	return out;
}

export function parseImageExtractionResult(rawText: string, finishReason: ProviderFinishReason, rawFinishReason: string | undefined): ProviderImageExtractionResult {
	const parsed = parseImageExtractionJson(rawText);
	return {
		description: parsed.description,
		extractedText: parsed.extractedText,
		rawText,
		finishReason,
		rawFinishReason,
	};
}

function parseImageExtractionJson(rawText: string): { description: string; extractedText: string } {
	const candidates = [
		rawText.trim(),
		extractJsonObject(rawText),
		extractFencedJson(rawText),
	].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
	for (const candidate of candidates) {
		try {
			const data = JSON.parse(candidate) as { description?: unknown; extractedText?: unknown; extracted_text?: unknown };
			return {
				description: typeof data.description === 'string' ? data.description.trim() : '',
				extractedText: typeof data.extractedText === 'string'
					? data.extractedText.trim()
					: typeof data.extracted_text === 'string'
						? data.extracted_text.trim()
						: '',
			};
		} catch {
			/* try next candidate */
		}
	}
	return { description: rawText.trim(), extractedText: '' };
}

function extractJsonObject(rawText: string): string | null {
	const start = rawText.indexOf('{');
	const end = rawText.lastIndexOf('}');
	return start >= 0 && end > start ? rawText.slice(start, end + 1) : null;
}

function extractFencedJson(rawText: string): string | null {
	const match = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
	return match?.[1] ?? null;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}
