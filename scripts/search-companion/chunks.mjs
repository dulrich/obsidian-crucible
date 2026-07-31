import { HttpError } from './http.mjs';

// Per-chunk column-value normalizers: the entity facet's flattening rule and the embedding
// codec/validator. These run at upsert time, between the wire payload and the `chunks` row.
// Split out of the single-file companion (WP-rem-R3).
//
// A malformed entity is dropped (no 400); a malformed embedding is a 400, never a 500 — the
// client maps any 5xx to "companion not reachable", so a client-side model mismatch must not
// masquerade as an outage. Both rules are argued at their definitions below.

// The entity facet's flattening rule: a chunk's `entities` arrive structured
// (`{ text, type, source }` — see `SearchEntity` in `src/search/types.ts`) and exactly one part
// of them, the text, reaches FTS. That asymmetry is the forward-compatibility design, not an
// oversight: GLiNER2-sourced entities will arrive in the same array with `source: 'model'` and a
// model-assigned `type`, land in this same column, and be scored at this same bm25 weight —
// producing no schema event at all. Persisting `type`/`source` would only be needed for a
// *typed* query surface ("notes whose author is X" as distinct from "notes mentioning X"), which
// nothing asks for; when something does, it is an additive `entities_json` column, and it does
// not disturb this column, its weight, or anything indexed here.
//
// Three inbound forms are accepted, so a producer is never blocked on the object shape: an array
// of entity objects, an array of bare strings, and a single scalar. Everything else — nested
// arrays, nulls, objects without a usable `text` — is dropped rather than stringified, because
// `[object Object]` in an index column is a junk term that matches nothing and dilutes bm25.
//
// Deduplication is by text alone (not by type), and the bounds are the same as the client's, so
// this reproduces `entityIndexText` in `src/search/chunker.ts` exactly. That agreement is
// load-bearing: the client folds its version of this string into `contentHash`, so if the two
// rules diverged, the hash would describe text the index does not hold.
const MAX_CHUNK_ENTITIES = 32;
const MAX_ENTITY_TEXT_CHARS = 200;
export function normalizeChunkEntities(value) {
	if (value === undefined || value === null) return '';
	const list = Array.isArray(value) ? value : [value];
	const texts = [];
	const seen = new Set();
	for (const entry of list) {
		const raw = entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry.text : entry;
		if (typeof raw !== 'string' && typeof raw !== 'number') continue;
		const text = String(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_ENTITY_TEXT_CHARS);
		if (!text) continue;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		texts.push(text);
		if (texts.length >= MAX_CHUNK_ENTITIES) break;
	}
	return texts.join('\n');
}

// ── Embedding storage ────────────────────────────────────────────────────────────────────
// float32 little-endian, stored as a BLOB. The size win over JSON (~2.7×) is the small
// reason; the real one is that a BLOB reads straight into a Float32Array with zero parse,
// so building the matrix is a memcpy per row instead of 52k JSON.parse calls on the first
// query after wake. Do not reintroduce a JSON hop.
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function encodeEmbedding(values) {
	const floats = values instanceof Float32Array ? values : Float32Array.from(values);
	if (IS_LITTLE_ENDIAN) return new Uint8Array(floats.buffer.slice(floats.byteOffset, floats.byteOffset + floats.byteLength));
	const bytes = new Uint8Array(floats.length * 4);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < floats.length; i++) view.setFloat32(i * 4, floats[i], true);
	return bytes;
}

export function decodeEmbedding(blob) {
	const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
	const dim = Math.floor(bytes.length / 4);
	const out = new Float32Array(dim);
	writeEmbeddingInto(out, 0, bytes, dim);
	return out;
}

// Copies one stored vector into `target` at `offset` floats. On a little-endian host (every
// platform this runs on) that is a straight byte copy into the matrix's own buffer; the
// DataView branch exists so a big-endian host reads the same bytes correctly rather than
// silently scoring garbage.
export function writeEmbeddingInto(target, offset, bytes, dim) {
	if (IS_LITTLE_ENDIAN) {
		const view = new Uint8Array(target.buffer, target.byteOffset + offset * 4, dim * 4);
		view.set(bytes.subarray(0, dim * 4));
		return;
	}
	const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let i = 0; i < dim; i++) target[offset + i] = source.getFloat32(i * 4, true);
}

// Vectors are stored L2-normalised so cosine similarity is a plain dot product. The client
// is not trusted to have normalised — both provider clients return whatever the model
// produced — so normalisation happens here, on write and on the query vector.
export function normalizeEmbedding(values) {
	const length = Number(values?.length ?? 0);
	const floats = new Float32Array(length);
	let sum = 0;
	for (let i = 0; i < length; i++) {
		const value = values[i];
		// Strictly a number, not merely coercible: `null` and `''` both coerce to 0, which
		// would quietly turn a corrupt vector into a valid-looking one pointing somewhere
		// else in the space.
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new HttpError(400, `embedding[${i}] is not a finite number`);
		}
		floats[i] = value;
		sum += floats[i] * floats[i];
	}
	const norm = Math.sqrt(sum);
	if (!(norm > 0) || !Number.isFinite(norm)) throw new HttpError(400, 'embedding must not be a zero vector');
	for (let i = 0; i < floats.length; i++) floats[i] = floats[i] / norm;
	return floats;
}

// Trimmed non-empty string, or null. The one place "no value" is decided for both the model id
// and the space id, so `''`, `'   '` and a missing field cannot mean three different things.
export function optionalId(value) {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// Validation for one inbound chunk embedding. Returns null when the chunk carries none
// (FTS-only indexing stays the default), throws HttpError(400) on anything malformed.
//
// `space` is the vector-space identity — model id plus normalized precision when the runtime
// could report one (`bge-m3/f16`), the bare model id when it could not. It defaults to the model
// id for exactly that reason: a client that sends no space is asserting today's semantics, which
// *are* "the space is the model", and that default is what makes the schema-4 migration and an
// older client both land on the same identity rather than two.
export function prepareChunkEmbedding(embedding, model, space) {
	if (embedding === undefined || embedding === null) return null;
	if (!Array.isArray(embedding) && !ArrayBuffer.isView(embedding)) {
		throw new HttpError(400, 'chunk.embedding must be an array of numbers');
	}
	if (embedding.length === 0) throw new HttpError(400, 'chunk.embedding must not be empty');
	const floats = normalizeEmbedding(embedding);
	const modelId = optionalId(model);
	return { bytes: encodeEmbedding(floats), dim: floats.length, model: modelId, space: optionalId(space) ?? modelId };
}
