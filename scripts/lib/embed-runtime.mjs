// Shared embedding-runtime client for the measurement and experiment scripts
// (`embedding-agreement.mjs`, `embedding-quality.mjs`, `inference-bench.mjs`, `dseries-index.mjs`).
//
// These four scripts each grew their own copy of "parse a runtime spec, POST to an embeddings
// endpoint, L2-normalize the result". The copies had already drifted — one validated the runtime
// kind and one did not, one sorted the OpenAI response by `index` and one relied on array order —
// which is exactly the class of difference that makes two arms of the same measurement
// incomparable for reasons nobody writes down. One home.
//
// Diagnostic tooling, not plugin code: the `console.*` ban applies to `src/` only, and the
// Dockerfile copies `scripts/search-companion.mjs` alone, so nothing here reaches the image.

const NORM_TOLERANCE = 1e-4;

// `label=url,model[,kind]`. The label is the arm's name in every table the caller prints, the URL
// is the base (for `openai` it must already include `/v1` — the client appends `/embeddings`),
// and `kind` selects the wire format.
export function parseRuntimeSpec(spec) {
	const eq = spec.indexOf('=');
	if (eq === -1) throw new Error(`Runtime spec must be label=url,model[,kind]: ${spec}`);
	const label = spec.slice(0, eq);
	const rest = spec.slice(eq + 1);
	const parts = rest.split(',');
	if (parts.length < 2) throw new Error(`Runtime spec must be label=url,model[,kind]: ${spec}`);
	const [url, model, kind = 'openai'] = parts;
	if (!label || !url || !model) throw new Error(`Runtime spec must be label=url,model[,kind]: ${spec}`);
	if (kind !== 'openai' && kind !== 'ollama') {
		throw new Error(`Unknown runtime kind "${kind}" in spec: ${spec} (expected "openai" or "ollama")`);
	}
	return { label, url: url.replace(/\/+$/, ''), model, kind };
}

async function embedOpenAICompatible(baseUrl, model, texts) {
	const res = await fetch(`${baseUrl}/embeddings`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model, input: texts }),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`POST ${baseUrl}/embeddings -> ${res.status}: ${body.slice(0, 300)}`);
	}
	const json = await res.json();
	const data = Array.isArray(json.data) ? json.data : [];
	if (data.length !== texts.length) {
		throw new Error(`Expected ${texts.length} embeddings from ${baseUrl}, got ${data.length}`);
	}
	// Place by the response's own `index`: the OpenAI shape does not promise input order, and a
	// server that returns them shuffled would otherwise pair every vector with the wrong text —
	// silently, since the count still matches.
	const out = new Array(texts.length);
	for (let i = 0; i < data.length; i++) {
		const item = data[i];
		const idx = typeof item.index === 'number' ? item.index : i;
		out[idx] = item.embedding;
	}
	return out;
}

async function embedOllama(baseUrl, model, texts) {
	const res = await fetch(`${baseUrl}/api/embed`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ model, input: texts }),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`POST ${baseUrl}/api/embed -> ${res.status}: ${body.slice(0, 300)}`);
	}
	const json = await res.json();
	const embeddings = Array.isArray(json.embeddings) ? json.embeddings : [];
	if (embeddings.length !== texts.length) {
		throw new Error(`Expected ${texts.length} embeddings from ${baseUrl}, got ${embeddings.length}`);
	}
	return embeddings;
}

// One batch, raw — no normalization, no progress. Timing arms want this so the clock covers the
// request and nothing else.
export function embedBatch(runtime, texts) {
	return runtime.kind === 'ollama'
		? embedOllama(runtime.url, runtime.model, texts)
		: embedOpenAICompatible(runtime.url, runtime.model, texts);
}

export function l2Norm(vec) {
	let sum = 0;
	for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
	return Math.sqrt(sum);
}

// "Defensively" because most servers return unit vectors already and we neither assume it nor
// silently paper over it: `stats` counts how many arrived non-unit or zero so the caller can say
// so in its run record. A zero vector is returned untouched rather than divided by zero.
export function normalizeDefensively(vec, stats = null) {
	const norm = l2Norm(vec);
	if (stats) stats.total++;
	if (norm === 0) {
		if (stats) stats.zero++;
		return vec;
	}
	if (stats && Math.abs(norm - 1) > NORM_TOLERANCE) stats.nonUnit++;
	if (norm === 1) return vec;
	const out = new Array(vec.length);
	for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
	return out;
}

export function newNormStats() {
	return { total: 0, zero: 0, nonUnit: 0 };
}

export function dot(a, b) {
	let sum = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) sum += a[i] * b[i];
	return sum;
}

// Embeds every text in request-batches, normalizing as it goes. `onProgress(done, total)` is
// called after each batch; pass nothing for silence.
export async function embedAll(runtime, texts, batchSize, { normStats = null, onProgress = null } = {}) {
	const vectors = [];
	for (let i = 0; i < texts.length; i += batchSize) {
		const batch = texts.slice(i, i + batchSize);
		for (const vec of await embedBatch(runtime, batch)) {
			vectors.push(normalizeDefensively(vec, normStats));
		}
		if (onProgress) onProgress(Math.min(i + batchSize, texts.length), texts.length);
	}
	return vectors;
}
