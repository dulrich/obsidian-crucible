import { Provider, ProviderCatalogModel, ProviderCompletionResult, ProviderEmbeddingResult, ProviderFinishReason, ProviderImageExtractionResult, ProviderModelDescription, ProviderRerankResult, ProviderRerankResultItem } from '../types';
import { logWarn } from '../log';

/**
 * Races `promise` against a `ms` timer. Obsidian's `requestUrl` (and the in-renderer
 * `OffscreenCanvas` transcode in `orchestration/utils/imageDescribe.ts`, which also races through
 * this) take no `AbortSignal`, so a timeout cannot cancel the underlying work — it can only stop
 * *waiting* on it. On timeout this rejects with an `Error` labeled `label` (`... timed out after
 * <n>ms` —
 * `TIMEOUT_FAILURE_RE`/`TRANSIENT_FAILURE_RE` key on this exact literal shape, so don't change it).
 * `Promise.race` has already attached a handler to the original `promise` as part of racing it, so
 * its late settlement (abandoned, but not orphaned) never surfaces as an unhandled promise
 * rejection.
 *
 * thq WP-4 (B-1): lives here rather than in `orchestration/utils/imageDescribe.ts` (its original
 * home) so `providers.ts` can reuse it for `ProviderManager.describeImage`'s per-pass timer without
 * providers.ts — a low-level module every completion-class caller depends on — reaching *up* into
 * an orchestration-domain, image-description-specific utility (and, concretely, pulling that
 * module's `search/imageDescriptionStore.ts`/`search/imageTranscode.ts` transitive imports into
 * every test that bundles `providers.ts`). `providers/shared.ts` is already a dependency-free leaf
 * (only `../types` + `../log`, no `obsidian` value imports) that `providers.ts` imports today, so
 * it sits below both consumers instead of beside either one. `imageDescribe.ts` re-exports this
 * under its old name for source/test compatibility — see the comment there.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

// Everything a per-provider HTTP client needs to issue a request: the provider config, the
// resolved model id, and the API key (already loaded + validated by ProviderManager). Each
// client reads provider.baseUrl / provider.kind for its own URL + header quirks.
export interface HttpCallContext {
	provider: Provider;
	modelId: string;
	apiKey: string;
}

// Same as HttpCallContext, minus modelId — WP-C's list-models probe asks "what does the server
// offer", not "what did it load for this one id", so there is no model id to carry. Deliberately a
// distinct type rather than HttpCallContext with modelId set to '' or a sentinel: a sentinel value
// could leak into a URL or request body if a caller mixed the two contexts up, where a missing
// property is a compile error instead. `apiKey` may legitimately be empty here even for a keyed
// provider kind (e.g. openrouter's `/models` needs no key) — see ProviderManager.listModels's
// context builder for why it does not enforce the same "key required" check httpContext() does.
export interface HttpListCallContext {
	provider: Provider;
	apiKey: string;
}

// Capability surface for an HTTP-backed provider. `complete` is required; `embed`, `extractImage`,
// `rerank`, `describeModel` and `listModels` are present only on providers that support them, so
// ProviderManager can throw a precise "not supported" by checking for the method rather than
// maintaining switch arms.
export interface HttpProviderClient {
	complete(ctx: HttpCallContext, system: string, user: string): Promise<ProviderCompletionResult>;
	embed?(ctx: HttpCallContext, inputs: string[]): Promise<ProviderEmbeddingResult>;
	extractImage?(ctx: HttpCallContext, base64: string, mimeType: string): Promise<ProviderImageExtractionResult>;
	// The two-pass image description call (narrative / extraction — see IMAGE_DESCRIPTION_*_PROMPT
	// above). Takes the already-resolved prompt text and per-pass max_tokens cap rather than a
	// 'narrative'|'extraction' literal so this layer stays a dumb HTTP call; ProviderManager
	// .describeImage (src/providers.ts) picks the prompt and cap. Plain string result — no JSON
	// envelope, unlike extractImage.
	describeImagePass?(ctx: HttpCallContext, base64: string, mimeType: string, prompt: string, maxTokens: number): Promise<string>;
	rerank?(ctx: HttpCallContext, query: string, documents: string[]): Promise<ProviderRerankResult>;
	// Asks the running server what it actually loaded for ctx.modelId, rather than trusting the
	// requested id/settings string. See ProviderModelDescription (src/types.ts) for what each
	// field means and why `precision` (not `fingerprint`) is the portable, persisted part.
	describeModel?(ctx: HttpCallContext): Promise<ProviderModelDescription>;
	// Enumerates what the server actually offers. See ProviderCatalogModel (src/types.ts) for the
	// shape and the D2 boundary: this method's job ends at "here is what the server says" — it must
	// never be the thing that writes a ProviderModel's capabilities/dimensions/variant.
	listModels?(ctx: HttpListCallContext): Promise<ProviderCatalogModel[]>;
}

export const IMAGE_EXTRACTION_SYSTEM_PROMPT = [
	'You extract searchable metadata from an image for a personal knowledge base.',
	'Return only compact JSON with these keys:',
	'- description: a precise natural-language description of the image.',
	'- extractedText: all readable text/OCR content from the image, preserving useful line breaks.',
	'If there is no readable text, extractedText must be an empty string.',
].join('\n');

export const IMAGE_EXTRACTION_USER_PROMPT = 'Describe this image and extract any visible text, including text in charts, infographics, screenshots, tables, and diagrams.';

// Two-pass image description prompts (`docs/multimodal-image-search.md`, Decision 2 — stored as
// two separate chunks rather than one concatenation, because a focused narrative paragraph and a
// long transcribed table have different shapes and should compete independently in bm25/vector
// scoring). Plain-text output: this is a retrieval surface, not a citation source, so no JSON
// envelope — unlike IMAGE_EXTRACTION_*_PROMPT above, which asks for structured JSON.
export const IMAGE_DESCRIPTION_NARRATIVE_PROMPT = 'In one dense paragraph, describe what this image is (chart, diagram, photo, table, screenshot, etc.), its title or subject, and the trend or point it makes. Plain prose only, no JSON, no markdown formatting.';

export const IMAGE_DESCRIPTION_EXTRACTION_PROMPT = 'Transcribe this image as structured plain text: its title, subtitle, axis labels and ranges, series names, data values, annotations, table content, and component labels, in that order where present. Plain text only, no JSON, no markdown formatting.';

// idh-WP-1 hardening: a bounded worst case for each pass. Observed live without a cap: a
// temp-0 repetition loop generated to the 32k context ceiling (`extraction=597888ms`, a
// 76k/94k-char degenerate record) — one poison image could otherwise stall or fail a whole
// batch. `max_tokens` is a universal chat/completions field (unlike `reasoning_effort`, it
// needs no `isLocal` gate), so both are sent unconditionally. Extraction gets a larger budget
// than narrative because a dense table/chart transcription is legitimately longer than a
// one-paragraph narrative.
export const IMAGE_DESCRIPTION_NARRATIVE_MAX_TOKENS = 512;
export const IMAGE_DESCRIPTION_EXTRACTION_MAX_TOKENS = 2048;

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

// Validates + normalizes the `{ results: [{ index, relevance_score }, ...] }` shape shared by
// both rerank backends: the native `/rerank` endpoint's raw JSON, and the fallback LLM-as-
// reranker's structured completion (see parseRerankCompletionText below, which asks the model
// to emit this exact wire shape so both paths converge on one parser).
//
// Deliberately strict rather than degrading: a missing `results` array, a non-numeric score, an
// out-of-range/duplicate `index`, or a result count that doesn't match `documentCount` all throw
// instead of silently truncating or half-applying the response. Silent truncation is exactly the
// failure this repo has been bitten by before (see the banned-diagnostics/raw-NUL AGENTS.md
// quirks for the general pattern of "a partial-looking success is worse than a loud failure") — a caller
// that receives fewer results than documents has no principled way to guess which document went
// missing, so guessing is not an option.
export function normalizeRerankResults(raw: unknown, documentCount: number): ProviderRerankResultItem[] {
	if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { results?: unknown }).results)) {
		throw new Error('Rerank response did not include a results array');
	}
	const rawResults = (raw as { results: unknown[] }).results;
	if (rawResults.length !== documentCount) {
		throw new Error(`Rerank response returned ${rawResults.length} results for ${documentCount} documents`);
	}
	const seen = new Set<number>();
	const out: ProviderRerankResultItem[] = [];
	for (const entry of rawResults) {
		if (!entry || typeof entry !== 'object') {
			throw new Error('Rerank response contained a malformed result entry');
		}
		const index = (entry as { index?: unknown }).index;
		const relevanceScore = (entry as { relevance_score?: unknown }).relevance_score;
		if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= documentCount) {
			throw new Error(`Rerank response contained an out-of-range or non-integer index: ${String(index)}`);
		}
		if (seen.has(index)) throw new Error(`Rerank response contained a duplicate index: ${index}`);
		if (typeof relevanceScore !== 'number' || !Number.isFinite(relevanceScore)) {
			throw new Error(`Rerank response contained a non-numeric relevance_score for index ${index}`);
		}
		seen.add(index);
		out.push({ index, relevanceScore });
	}
	return out;
}

// System prompt for the fallback backend (C in the WP-5 brief): a provider with no native
// `/rerank` endpoint (plain Ollama, a chat-only CLI provider, ...) scores candidates through the
// existing complete() path instead. Asking for the identical `{results:[{index,relevance_score}]}`
// shape the native backend returns means both backends converge on normalizeRerankResults above —
// one parser, one set of invariants, rather than a second bespoke format to validate.
export const RERANK_FALLBACK_SYSTEM_PROMPT = [
	'You are a relevance-scoring function for a personal knowledge-base search result set.',
	'You will be given a query and a numbered list of documents (snippets, not full notes).',
	'Score how relevant each document is to the query, from 0.0 (irrelevant) to 1.0 (highly relevant).',
	'Respond with ONLY compact JSON of this exact shape, no other text, no markdown fences:',
	'{"results":[{"index":0,"relevance_score":0.0},{"index":1,"relevance_score":0.0}]}',
	'Include exactly one entry per document, covering every index from 0 to N-1 exactly once, in any order.',
].join('\n');

export function buildRerankFallbackUserPrompt(query: string, documents: string[]): string {
	const numbered = documents.map((doc, i) => `[${i}] ${doc}`).join('\n\n');
	return `Query: ${query}\n\nDocuments:\n${numbered}`;
}

// Parses the fallback backend's free-form completion text into the same normalized shape a
// native `/rerank` response produces. Tries the raw text first (models that obey "no markdown
// fences" return bare JSON), then a bare `{...}` slice, then a fenced ```json block — the same
// three-candidate strategy parseImageExtractionJson already uses for a different capability's
// LLM-structured-output problem. Throws with the parser's own message on total failure rather
// than fabricating scores or silently dropping documents; the caller surfaces that to the user
// as a failed rerank, not a corrupted or partial one.
export function parseRerankCompletionText(rawText: string, documentCount: number): ProviderRerankResultItem[] {
	const candidates = [
		rawText.trim(),
		extractJsonObject(rawText),
		extractFencedJson(rawText),
	].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);

	let lastError: unknown = new Error('empty response');
	for (const candidate of candidates) {
		try {
			return normalizeRerankResults(JSON.parse(candidate), documentCount);
		} catch (e) {
			lastError = e;
		}
	}
	const reason = lastError instanceof Error ? lastError.message : String(lastError);
	throw new Error(`Rerank fallback response was not usable: ${reason}`);
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

// ── describeModel() support: precision normalization + the cross-encoder-as-embedder guard ────
//
// GGUF's own ggml_ftype enum (LLAMA_FTYPE_MOSTLY_*), the numeric form ollama's `/api/show`
// reports under `model_info['general.file_type']` when a GGUF model carries no
// `quantization_level` string on `/api/tags`. Values follow llama.cpp's file-type table; only the
// entries a real embedding/chat model is likely to carry are listed, but any future gap should
// still degrade to `undefined` (a clean unknown), never a guess.
const GGUF_FILE_TYPE_TO_QUANT: Record<number, string> = {
	0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
	10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M',
	16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S',
	22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M',
	28: 'IQ2_S', 29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16', 34: 'TQ1_0', 35: 'TQ2_0',
};

// Spellings that mean the same dtype but don't share a lowercase form: GGUF's own convention
// (F32/F16, no "fp" prefix) versus the fp32/fp16/float32/float16 spellings other runtimes (vLLM,
// TEI, a raw PyTorch dtype dump) use for the identical bits. Collapsing both onto one token is the
// entire point of normalizePrecision below — see its doc comment for why this is a persisted-
// contract concern, not cosmetic.
const FLOAT_PRECISION_ALIASES: Record<string, string> = {
	f32: 'fp32', fp32: 'fp32', float32: 'fp32',
	f16: 'f16', fp16: 'f16', float16: 'f16',
	bf16: 'bf16', bfloat16: 'bf16',
};

// The single normalizer every precision-reporting probe (ollama, LM Studio/openai-compatible, and
// any future runtime) must route through before the value becomes part of a comparable key. WP-3
// persists this string as part of a vector-space identity, so `Q4_K_M`, `q4_k_m`, and the GGUF
// numeric file_type `15` must all collapse to the identical token `q4_k_m` — see
// tests/providerModelProbe.test.mjs for the pinned collapse assertions. If two runtimes serving
// byte-identical weights produced different tokens here, an index would split into two "spaces"
// and force a pointless full re-embed of the vault.
//
// Returns `undefined`, never a guess, when the input carries no usable information. This is not
// an edge case: Infinity's `/v1/models` never exposes dtype at all, so `undefined` is the live
// path today for the embedder actually in use.
export function normalizePrecision(raw: string | number | undefined | null): string | undefined {
	if (raw === undefined || raw === null) return undefined;
	const rawToken = typeof raw === 'number' ? GGUF_FILE_TYPE_TO_QUANT[raw] : raw;
	if (!rawToken) return undefined;
	const normalized = rawToken
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '');
	if (!normalized) return undefined;
	return FLOAT_PRECISION_ALIASES[normalized] ?? normalized;
}

const CROSS_ENCODER_PATTERN = /rerank|cross-enc/i;
const crossEncoderWarned = new Set<string>();

// Heuristic-only classifier — exported so it (and its false-positive behavior) can be asserted
// directly in tests without going through a live probe. See warnIfCrossEncoderEmbedder for why a
// match must only ever warn, never block.
export function looksLikeCrossEncoder(...candidates: (string | undefined)[]): boolean {
	return candidates.some(c => typeof c === 'string' && CROSS_ENCODER_PATTERN.test(c));
}

// LM Studio serves cross-encoder rerankers (bge-reranker-v2-m3, bge-reranker-base) through the
// same /v1/embeddings endpoint as real bi-encoders, reporting `type: embeddings` and returning
// properly-shaped, correctly L2-normalized vectors at widths that collide with real embedding
// models (1024d = bge-m3, 768d = nomic-embed-text). Every structural guard passes: width,
// normalization, even the `text-embedding-` id prefix. Measured on one query against two relevant
// and two irrelevant documents, a real bi-encoder (bge-m3) separates them by a 0.3994 cosine
// margin; the reranker used this way manages 0.0080 and ranks the on-topic document below arctic
// tern migration. No field reliably distinguishes cross-encoder from bi-encoder, so this is
// necessarily a heuristic — id or a reported arch/format string containing "rerank" or
// "cross-enc" — and it must therefore only ever warn: a false positive here must not stop a
// legitimate model from being used as an embedder.
//
// Deduplicated per (providerId, modelId) for the life of the module (i.e. the plugin session), so
// a hot indexing loop that calls this once per embed batch logs it exactly once.
//
// WP-8 (plans/sprint-exit-queue-health-and-scrub.md): the warning used to be logWarn-only, which
// is debug-gated (see src/log.ts) — invisible unless the user has already turned on Crucible debug
// output, which someone picking a reranker as an embedder for the first time has no reason to have
// done. `notify`, when supplied, is called with the identical message so a caller with access to
// Obsidian's UI (the two provider clients below; this file stays import-free of 'obsidian' so it
// can keep bundling standalone in tests/providerModelProbe.test.mjs) can surface a visible Notice.
// It shares this function's own session dedup gate rather than getting a second one, so the
// logWarn and the Notice can never drift out of step on "have we already told the user about this
// (provider, model) pair this session". `hints` moved from a rest parameter to an array so an
// optional parameter could follow it; every existing call site is a mechanical wrap in `[...]`.
export function warnIfCrossEncoderEmbedder(
	providerId: string,
	providerLabel: string,
	modelId: string,
	hints: (string | undefined)[] = [],
	notify?: (message: string) => void,
): void {
	if (!looksLikeCrossEncoder(modelId, ...hints)) return;
	const key = `${providerId}::${modelId}`;
	if (crossEncoderWarned.has(key)) return;
	crossEncoderWarned.add(key);
	const message = `${providerLabel}: model "${modelId}" looks like a cross-encoder / reranker (matched "rerank"/"cross-enc" in its id or reported metadata) but is configured as an embedding model. Cross-encoder outputs are not valid similarity vectors for search — verify this is a bi-encoder before indexing with it.`;
	logWarn(message);
	notify?.(message);
}

// ── HTTP error message construction (WP-R3) ─────────────────────────────────────────────────
//
// `requestUrl` throws by default on any status 400+, so a client that calls it with the default
// options can never reach an `if (response.status !== 200) throw ...` branch below it — the
// default throw fires before the check runs, and the crafted error message that check built
// (status + response body) was dead code. Every provider client now passes `throw: false`
// explicitly so a non-2xx response reaches its own status check instead, and builds the message
// through this one helper so a 429/quota body (the case this fix exists for) always surfaces its
// status, a `retry-after` header when present, and a short excerpt of the response body
// (preferring a JSON `error` field/`.message` over raw text) — bounded so an HTML error page or a
// verbose stack trace doesn't blow the thrown message up. This is a formatting helper only: every
// call site still throws its own error (same type as before this fix), preserving each client's
// existing error-type contract.
const HTTP_ERROR_BODY_EXCERPT_LIMIT = 200;

function readResponseJsonSafe(response: { json: unknown }): unknown {
	try {
		return response.json;
	} catch {
		return undefined;
	}
}

function findHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return value;
	}
	return undefined;
}

function excerptHttpErrorBody(response: { text: string; json: unknown }): string {
	const json = readResponseJsonSafe(response);
	let detail: string | undefined;
	if (json && typeof json === 'object') {
		const err = (json as Record<string, unknown>).error;
		if (typeof err === 'string') detail = err;
		else if (err && typeof err === 'object') {
			const message = (err as Record<string, unknown>).message;
			if (typeof message === 'string') detail = message;
		}
	}
	const body = (detail ?? response.text ?? '').trim();
	if (!body) return '';
	return body.length > HTTP_ERROR_BODY_EXCERPT_LIMIT ? `${body.slice(0, HTTP_ERROR_BODY_EXCERPT_LIMIT)}…` : body;
}

// `prefix` is the caller's own "<Provider> <endpoint> API" framing (e.g. "OpenRouter rerank
// API"). Called only after a `requestUrl({ ..., throw: false })` response comes back non-2xx.
export function buildHttpErrorMessage(prefix: string, response: { status: number; text: string; json: unknown; headers?: Record<string, string> }): string {
	const parts = [`${prefix} returned ${response.status}`];
	const retryAfter = findHeader(response.headers, 'retry-after');
	if (retryAfter) parts.push(`retry-after ${retryAfter}`);
	const excerpt = excerptHttpErrorBody(response);
	if (excerpt) parts.push(excerpt);
	return parts.join(': ');
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
