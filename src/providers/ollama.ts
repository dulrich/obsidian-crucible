import { Notice, requestUrl } from 'obsidian';
import { Provider, ProviderCatalogModel, ProviderCompletionResult, ProviderEmbeddingResult, ProviderFinishReason, ProviderImageExtractionResult, ProviderModelDescription } from '../types';
import {
	HttpCallContext,
	HttpListCallContext,
	HttpProviderClient,
	IMAGE_EXTRACTION_SYSTEM_PROMPT,
	IMAGE_EXTRACTION_USER_PROMPT,
	looksLikeCrossEncoder,
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
		warnIfCrossEncoderEmbedder(ctx.provider.id, 'ollama', ctx.modelId, [], (msg) => new Notice(msg));

		const tagsResponse = await requestUrl({ url: `${baseUrl(ctx.provider)}/api/tags`, method: 'GET' });
		if (tagsResponse.status !== 200) {
			throw new Error(`Ollama tags API returned ${tagsResponse.status}: ${tagsResponse.text}`);
		}
		const tagsData = tagsResponse.json as { models?: OllamaTagEntry[] };
		const models = tagsData.models ?? [];
		const match = models.find(m => m.name === ctx.modelId || m.model === ctx.modelId)
			?? models.find(m => typeof m.name === 'string' && baseModelName(m.name) === baseModelName(ctx.modelId));

		warnIfCrossEncoderEmbedder(ctx.provider.id, 'ollama', ctx.modelId, [match?.name, match?.details?.format], (msg) => new Notice(msg));

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

	// WP-C: enumerates every pulled model from `/api/tags`, then enriches each one with a per-model
	// `POST /api/show` — the only route that reports `capabilities` (e.g. "embedding", "vision",
	// surfaced here as `serverCapabilities` — see ProviderCatalogModel's doc comment for why the
	// name is deliberately not `capabilities`) and the real `model_info['<arch>.embedding_length']`
	// (per the plan's per-kind table: "a second /api/show gives capabilities and real
	// embedding_length"). The per-model round trip is
	// deliberate, not an oversight: `/api/tags` alone is a weak signal (id + quantization string
	// only), and a typical local install has a handful of pulled models, not hundreds. Each `/api/show`
	// call is best-effort — a failure for one model degrades that entry's capabilities/embeddingLength
	// to `undefined` rather than failing the whole list, matching the resilience of the existing
	// probeOllamaGgufFileType fallback below.
	async listModels(ctx: HttpListCallContext): Promise<ProviderCatalogModel[]> {
		const tagsResponse = await requestUrl({ url: `${baseUrl(ctx.provider)}/api/tags`, method: 'GET' });
		if (tagsResponse.status !== 200) {
			throw new Error(`Ollama tags API returned ${tagsResponse.status}: ${tagsResponse.text}`);
		}
		const tagsData = tagsResponse.json as { models?: OllamaTagEntry[] };
		const models = tagsData.models ?? [];

		const out: ProviderCatalogModel[] = [];
		for (const entry of models) {
			const id = entry.name ?? entry.model;
			if (!id) continue;
			const show = await probeOllamaShow(ctx.provider, id);
			out.push({
				id,
				quantization: entry.details?.quantization_level,
				serverCapabilities: show?.capabilities,
				embeddingLength: show?.embeddingLength,
				looksLikeCrossEncoder: looksLikeCrossEncoder(id, entry.details?.format),
			});
		}
		return out;
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

interface OllamaShowInfo {
	capabilities?: string[];
	embeddingLength?: number;
}

// listModels()'s per-model enrichment call. `capabilities` (e.g. ["completion", "embedding"]) is
// ollama's own classification of what the model is for — the strongest capability signal any
// provider kind offers via a list-shaped probe, per the WP-C plan's table. `embedding_length` is
// arch-prefixed in `model_info` ("bert.embedding_length", "nomic-bert.embedding_length", ...), so
// this scans for the suffix rather than assuming one fixed key, the same way probeOllamaGgufFileType
// above reads a fixed key for the (always `general.*`-prefixed) file-type field. Best-effort: a
// missing/unreachable/malformed response degrades to `undefined` fields, never throws — one model's
// enrichment failing must not drop it from the whole list.
async function probeOllamaShow(provider: Provider, modelName: string): Promise<OllamaShowInfo | undefined> {
	try {
		const response = await requestUrl({
			url: `${baseUrl(provider)}/api/show`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: modelName }),
		});
		if (response.status !== 200) return undefined;
		const data = response.json as { capabilities?: unknown; model_info?: Record<string, unknown> };
		const capabilities = Array.isArray(data.capabilities)
			? data.capabilities.filter((c): c is string => typeof c === 'string')
			: undefined;
		const embeddingLength = findOllamaEmbeddingLength(data.model_info);
		return { capabilities, embeddingLength };
	} catch {
		return undefined;
	}
}

function findOllamaEmbeddingLength(modelInfo: Record<string, unknown> | undefined): number | undefined {
	if (!modelInfo) return undefined;
	for (const [key, value] of Object.entries(modelInfo)) {
		if (key.endsWith('.embedding_length') && typeof value === 'number') return value;
	}
	return undefined;
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
