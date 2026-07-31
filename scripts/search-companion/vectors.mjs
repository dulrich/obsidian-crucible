import { HttpError } from './http.mjs';
import { normalizeEmbedding, writeEmbeddingInto } from './chunks.mjs';

// The vector backend seam. Split out of the single-file companion (WP-rem-R3) — which is a
// file move, not a widening: the contract is still exactly
// `{ name, stats(vaultId?, space?), knn(vaultId, queryVector, k, space?), invalidate(vaultId?) }`
// and nothing outside `createVectorBackend` may assume a flat array or an in-process scan.
// That is what keeps the two documented escape hatches (a vec0/sqlite-vec backend, a
// worker-sharded backend) a swap of this factory rather than a rewrite of runSearch.

// ── The vector backend seam ──────────────────────────────────────────────────────────────
// Everything about *how* similarity is computed lives behind this factory. The rest of the
// companion only ever calls `stats`, `knn` and `invalidate`, and nothing outside it may
// assume a flat array or an in-process scan. That is what makes the documented escape
// hatches a swap rather than a rewrite: a `vec0` (sqlite-vec) backend becomes a `knn` that
// runs `SELECT ... MATCH` instead of a loop, and the worker-sharded variant becomes a `knn`
// that fans the same matrix — already one flat Float32Array — over a SharedArrayBuffer.
// Neither touches the search handler.
//
// Contract:
//   name                                   → string, which backend is answering (/health)
//   stats(vaultId?, space?)                → { count, dim, model, spaces, unlabelledCount };
//                                            cheap, never builds a matrix
//   knn(vaultId, queryVector, k, space?)   → [{ id, path, score }] descending, length ≤ k
//   invalidate(vaultId?)                   → drop cached state (every vault when omitted)
//
// `space` narrows both to one embedding space; omitted means "every vector in the vault", which
// is correct only when the vault holds exactly one space — deciding that is resolveScanSpace's
// job, not the backend's.
//
// `stats` is cached and invalidated with the matrix because /v1/search consults it on every
// request to report `semanticAvailable` honestly, and an uncached COUNT over `chunks` would
// cost more than the FTS query it accompanies.
export function createVectorBackend(db) {
	// `(? IS NULL OR embedding_space = ?)` is the space filter on every statement below: bind
	// null and the statement is the vault-wide form it was before schema 4, bind a space and it
	// is scoped, with no second prepared statement to keep in sync.
	const selectVectors = db.prepare(
		'SELECT id, path, embedding, embedding_dim, embedding_space FROM chunks WHERE vault_id = ? AND embedding IS NOT NULL AND (? IS NULL OR embedding_space = ?) ORDER BY rowid',
	);
	// Grouped by space rather than a flat COUNT/MIN/MAX, so one query answers both "how big is
	// this matrix" and "how many distinct spaces is this index holding" — the latter being what
	// makes a mixed index visible instead of inferred.
	const groupsVault = db.prepare(
		'SELECT embedding_space AS space, COUNT(*) AS count, MIN(embedding_dim) AS min_dim, MAX(embedding_dim) AS max_dim FROM chunks WHERE vault_id = ? AND embedding IS NOT NULL AND (? IS NULL OR embedding_space = ?) GROUP BY embedding_space',
	);
	const groupsAll = db.prepare(
		'SELECT embedding_space AS space, COUNT(*) AS count, MIN(embedding_dim) AS min_dim, MAX(embedding_dim) AS max_dim FROM chunks WHERE embedding IS NOT NULL AND (? IS NULL OR embedding_space = ?) GROUP BY embedding_space',
	);
	const modelVault = db.prepare(
		'SELECT embedding_model AS model, COUNT(*) AS count FROM chunks WHERE vault_id = ? AND embedding IS NOT NULL AND (? IS NULL OR embedding_space = ?) GROUP BY embedding_model ORDER BY count DESC LIMIT 1',
	);
	const modelAll = db.prepare(
		'SELECT embedding_model AS model, COUNT(*) AS count FROM chunks WHERE embedding IS NOT NULL AND (? IS NULL OR embedding_space = ?) GROUP BY embedding_model ORDER BY count DESC LIMIT 1',
	);

	// Two-level caches: vault → space → value. Nesting (rather than one composite string key)
	// buys two things. The keys are `null` for "all vaults"/"no space filter" — a real Map key,
	// so there is no in-band sentinel string to collide with a real vault id or to smuggle a
	// control character into this file, which has happened here before. And invalidating a vault
	// is one delete of its whole inner map, so a write can never leave a matrix built for one
	// space alive under another — the silent version of the very bug the space filter fixes.
	const statsCache = new Map();
	const matrixCache = new Map();
	const vaultKey = vaultId => (typeof vaultId === 'string' && vaultId !== '' ? vaultId : null);
	const spaceKey = space => (typeof space === 'string' && space !== '' ? space : null);

	function cached(cache, vaultId, space, build) {
		const outer = vaultKey(vaultId);
		let inner = cache.get(outer);
		if (!inner) {
			inner = new Map();
			cache.set(outer, inner);
		}
		const key = spaceKey(space);
		let value = inner.get(key);
		if (value === undefined) {
			value = build();
			inner.set(key, value);
		}
		return value;
	}

	function readStats(vaultId, space) {
		return cached(statsCache, vaultId, space, () => {
			const scoped = vaultKey(vaultId) !== null;
			const filter = spaceKey(space);
			const rows = scoped ? groupsVault.all(vaultId, filter, filter) : groupsAll.all(filter, filter);
			let count = 0;
			let minDim = null;
			let maxDim = null;
			let unlabelledCount = 0;
			const spaces = [];
			for (const row of rows) {
				const groupCount = Number(row.count ?? 0);
				count += groupCount;
				const low = row.min_dim === null || row.min_dim === undefined ? null : Number(row.min_dim);
				const high = row.max_dim === null || row.max_dim === undefined ? null : Number(row.max_dim);
				if (low !== null) minDim = minDim === null ? low : Math.min(minDim, low);
				if (high !== null) maxDim = maxDim === null ? high : Math.max(maxDim, high);
				if (typeof row.space === 'string' && row.space !== '') spaces.push(row.space);
				else unlabelledCount += groupCount;
			}
			spaces.sort();
			// A vault holding two widths cannot be scanned as one matrix. The upsert guard makes
			// that unreachable, but reporting dim: null (→ unavailable) is the safe answer if a
			// database ever arrives in that state, rather than scoring across two vector spaces.
			const dim = count > 0 && minDim !== null && minDim === maxDim ? minDim : null;
			const modelRow = count > 0 ? (scoped ? modelVault.get(vaultId, filter, filter) : modelAll.get(filter, filter)) : null;
			return { count, dim, model: modelRow?.model ?? null, spaces, unlabelledCount };
		});
	}

	// One Float32Array of count × dim, plus parallel id/path arrays. Built lazily on the
	// first vector search for a vault and dropped wholesale on any write that touches it —
	// rebuilt rather than patched, which is simpler and cannot drift.
	//
	// Scoped to `space` when one is given, and the row filter is in SQL, not a post-filter in
	// JS: scoring a query against vectors from another space is the failure this whole work
	// package exists to remove, so those rows must never reach the matrix in the first place.
	function buildMatrix(vaultId, space) {
		const stats = readStats(vaultId, space);
		if (stats.count === 0 || !stats.dim) return { count: 0, dim: 0, ids: [], paths: [], matrix: null, model: null };
		const dim = stats.dim;
		const matrix = new Float32Array(stats.count * dim);
		const ids = [];
		const paths = [];
		let row = 0;
		const filter = spaceKey(space);
		for (const record of selectVectors.all(vaultId, filter, filter)) {
			const blob = record.embedding;
			if (!blob || blob.length !== dim * 4 || Number(record.embedding_dim) !== dim) continue;
			writeEmbeddingInto(matrix, row * dim, blob instanceof Uint8Array ? blob : new Uint8Array(blob), dim);
			ids.push(record.id);
			paths.push(record.path);
			row++;
		}
		return { count: row, dim, ids, paths, matrix, model: stats.model };
	}

	function ensureMatrix(vaultId, space) {
		return cached(matrixCache, vaultId, space, () => buildMatrix(vaultId, space));
	}

	return {
		name: 'brute-force-js',
		stats(vaultId, space) {
			return readStats(vaultId, space);
		},
		invalidate(vaultId) {
			if (vaultId === undefined) {
				statsCache.clear();
				matrixCache.clear();
				return;
			}
			// Drops every space's entry for this vault, not just the one that was written.
			statsCache.delete(vaultKey(vaultId));
			matrixCache.delete(vaultKey(vaultId));
			// The unscoped (/health) stats view covers every vault, so any write invalidates it.
			statsCache.delete(null);
			matrixCache.delete(null);
		},
		// Brute force over the FULL matrix — every chunk in the vault, not the FTS candidate
		// pool. Reranking FTS candidates by vector similarity cannot surface a note that
		// shares no keywords with the query, which is the entire reason this leg exists.
		// Measured 13ms at 384d / 33ms at 1024d over 52,257 chunks; the interactive ceiling
		// is ~250k chunks, past which the move is worker sharding (see the plan), not int8 —
		// int8 measured *slower* in scalar JS at this size, 19.6ms vs 12.4ms at 384d.
		knn(vaultId, queryVector, k, space) {
			const state = ensureMatrix(vaultId, space);
			if (state.count === 0) return [];
			const dim = state.dim;
			if (!queryVector || queryVector.length !== dim) {
				throw new HttpError(400, `query embedding is ${queryVector?.length ?? 0}-dimensional but this vault is indexed at ${dim}`);
			}
			const query = normalizeEmbedding(queryVector);
			const wanted = Math.max(1, Math.min(Math.floor(Number(k) || 1), state.count));
			const matrix = state.matrix;
			const best = [];
			let worst = -Infinity;
			for (let row = 0; row < state.count; row++) {
				const offset = row * dim;
				let sum = 0;
				for (let d = 0; d < dim; d++) sum += matrix[offset + d] * query[d];
				if (best.length === wanted && sum <= worst) continue;
				// Both sides are unit vectors, so the dot product *is* the cosine; the clamp
				// only absorbs float32 rounding at the ±1 ends.
				const entry = { id: state.ids[row], path: state.paths[row], score: Math.max(-1, Math.min(1, sum)) };
				let index = best.length - 1;
				best.push(entry);
				while (index >= 0 && best[index].score < entry.score) {
					best[index + 1] = best[index];
					index--;
				}
				best[index + 1] = entry;
				if (best.length > wanted) best.pop();
				worst = best[best.length - 1].score;
			}
			return best;
		},
	};
}
