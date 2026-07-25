import { requestUrl } from 'obsidian';
import { Provider, ProviderCompletionResult, ProviderEmbeddingResult, ProviderFinishReason, ProviderImageExtractionResult, ProviderModelDescription } from '../types';
import {
	HttpCallContext,
	HttpProviderClient,
	IMAGE_EXTRACTION_SYSTEM_PROMPT,
	IMAGE_EXTRACTION_USER_PROMPT,
	normalizeEmbedding,
	normalizePrecision,
	normalizeRawFinishReason,
	parseImageExtractionResult,
	warnIfCrossEncoderEmbedder,
} from './shared';

function baseUrl(provider: Provider): string {
	return (provider.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
}

// ollama tags a pulled model `name:tag` (e.g. "qwen3.5:latest") but a configured Provider.modelId
// is commonly stored without the tag ("qwen3.5"). Compare on the base name so describeModel()
// still finds the entry when the user omitted ":latest".
function baseModelName(name: string): string {
	return name.split(':')[0] ?? name;
}

interface OllamaTagEntry {
	name?: string;
	model?: string;
	digest?: string;
	details?: { quantization_level?: string; format?: string };
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

		const data = response.json as { embeddings?: number[][], embedding?: number[], model?: string };
		const embeddings = data.embeddings
			? data.embeddings.map(normalizeEmbedding)
			: data.embedding
				? [normalizeEmbedding(data.embedding)]
				: [];
		if (embeddings.length !== inputs.length) {
			throw new Error(`Ollama embeddings API returned ${embeddings.length} embeddings for ${inputs.length} inputs`);
		}
		return {
			embeddings,
			dimensions: embeddings[0]?.length,
			servedModel: typeof data.model === 'string' && data.model ? data.model : undefined,
		};
	},

	// Asks ollama what it actually loaded for ctx.modelId. `/api/tags` is the cheap, already-
	// cached-server-side list of pulled models and is the primary source: `details.quantization_level`
	// (a string like "Q4_K_M") normalizes straight to `precision`, and `digest` (sha256 of the
	// weights blob) is the strongest fingerprint any of the three local runtimes offers. If a tag
	// entry is found but carries no quantization string, fall back to `/api/show`, whose
	// `model_info['general.file_type']` is the GGUF numeric code for the same information (see
	// normalizePrecision's collapse of that code onto the identical token). Neither request throws
	// on its own transient failure for the fallback leg — a missing precision must degrade to
	// `undefined`, not abort the whole probe.
	async describeModel(ctx: HttpCallContext): Promise<ProviderModelDescription> {
		// Cheap, network-independent pass first: an id that already reads as a reranker must warn
		// even if both HTTP calls below fail.
		warnIfCrossEncoderEmbedder(ctx.provider.id, 'ollama', ctx.modelId);

		const tagsResponse = await requestUrl({ url: `${baseUrl(ctx.provider)}/api/tags`, method: 'GET' });
		if (tagsResponse.status !== 200) {
			throw new Error(`Ollama tags API returned ${tagsResponse.status}: ${tagsResponse.text}`);
		}
		const tagsData = tagsResponse.json as { models?: OllamaTagEntry[] };
		const models = tagsData.models ?? [];
		const match = models.find(m => m.name === ctx.modelId || m.model === ctx.modelId)
			?? models.find(m => typeof m.name === 'string' && baseModelName(m.name) === baseModelName(ctx.modelId));

		warnIfCrossEncoderEmbedder(ctx.provider.id, 'ollama', ctx.modelId, match?.name, match?.details?.format);

		let precision = normalizePrecision(match?.details?.quantization_level);
		if (precision === undefined && match) {
			precision = await probeOllamaGgufFileType(ctx);
		}

		return {
			servedModel: match?.name ?? match?.model,
			precision,
			fingerprint: match?.digest,
		};
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

// Fallback for the (rarer) case where `/api/tags`'s `details.quantization_level` string is
// absent. `POST /api/show` returns the full GGUF metadata dict under `model_info`, keyed by GGUF
// field name; `general.file_type` is the numeric ggml_ftype enum value normalizePrecision already
// knows how to collapse onto the same token a quantization_level string would produce. Best-effort:
// any failure here (unreachable endpoint, malformed body, older ollama) yields `undefined` rather
// than throwing, since this is only ever reached to fill a gap in an already-successful probe.
async function probeOllamaGgufFileType(ctx: HttpCallContext): Promise<string | undefined> {
	try {
		const response = await requestUrl({
			url: `${baseUrl(ctx.provider)}/api/show`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: ctx.modelId }),
		});
		if (response.status !== 200) return undefined;
		const data = response.json as { model_info?: Record<string, unknown> };
		const fileType = data.model_info?.['general.file_type'];
		return typeof fileType === 'number' ? normalizePrecision(fileType) : undefined;
	} catch {
		return undefined;
	}
}

function normalizeOllamaFinishReason(raw: string | undefined): ProviderFinishReason {
	if (!raw) return 'unknown';
	switch (raw.toLowerCase()) {
		case 'stop': return 'stop';
		case 'length':
		case 'max_tokens': return 'length';
		default: return 'other';
	}
}
