import { setImmediate } from 'node:timers';

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
//
// search-latency-durability WP-2 — off-request maintenance. Above `inlineRowLimit` chunks
// (MAX(rowid), an O(log n) probe) a cold or invalidated stats/matrix entry is NEVER built on
// the caller's stack: `stats` answers from the last value it had (flagged `pending: true`), or
// an empty pending answer when it never had one, and `prepare(vaultId, space)` answers false.
// Either schedules a rebuild task on a serial, time-sliced runner (`setImmediate` between
// slices, each slice <= `sliceMs`) that reads `chunks` in rowid-ranged batches — a fresh
// statement call per batch, so no read cursor stays open across an event-loop turn (which
// would also pin the post-flush WAL checkpoint).
//
// Generations: every `invalidate` bumps a per-vault counter (plus the all-vaults one, and a
// global epoch for invalidate()). A task snapshots its vault's generation at start and
// re-checks it before every batch and at publish; a mismatch restarts the task from rowid 0,
// so a published matrix can never mix pre- and post-invalidation rows. Below the limit
// (every unit test, small vaults) the behaviour is exactly the old synchronous lazy build.
export const DEFAULT_INLINE_ROW_LIMIT = 5000;
const DEFAULT_SLICE_MS = 40;
const STATS_BATCH_ROWS = 2000;
const MATRIX_BATCH_ROWS = 500;

const EMPTY_STATS = Object.freeze({ count: 0, dim: null, model: null, spaces: [], unlabelledCount: 0 });

export function createVectorBackend(db, options = {}) {
	const inlineRowLimit = options.inlineRowLimit ?? DEFAULT_INLINE_ROW_LIMIT;
	const sliceMs = options.sliceMs ?? DEFAULT_SLICE_MS;
	const scheduleSlice = options.schedule ?? (fn => setImmediate(fn));
	const clock = options.clock ?? (() => performance.now());
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
	// The sliced (deferred-regime) readers. `rowid > ?` + `ORDER BY rowid` + LIMIT walks the
	// table btree directly; `+vault_id` keeps the planner off idx_chunks_vault_path, which would
	// otherwise turn every batch into an index scan plus a sort.
	const sizeHint = db.prepare('SELECT MAX(rowid) AS n FROM chunks');
	const statsSlice = db.prepare(
		'SELECT rowid AS rid, embedding_space AS space, embedding_dim AS dim, embedding_model AS model FROM chunks WHERE rowid > ? AND (? IS NULL OR +vault_id = ?) AND embedding IS NOT NULL AND (? IS NULL OR embedding_space = ?) ORDER BY rowid LIMIT ?',
	);
	const matrixSlice = db.prepare(
		'SELECT rowid AS rid, id, path, embedding, embedding_dim FROM chunks WHERE rowid > ? AND +vault_id = ? AND embedding IS NOT NULL AND (? IS NULL OR embedding_space = ?) ORDER BY rowid LIMIT ?',
	);

	// Two-level caches: vault → space → value. Nesting (rather than one composite string key)
	// buys two things. The keys are `null` for "all vaults"/"no space filter" — a real Map key,
	// so there is no in-band sentinel string to collide with a real vault id or to smuggle a
	// control character into this file, which has happened here before. And invalidating a vault
	// is one delete of its whole inner map, so a write can never leave a matrix built for one
	// space alive under another — the silent version of the very bug the space filter fixes.
	const statsCache = new Map();
	const matrixCache = new Map();
	// Last-known stats per vault/space, kept across an invalidation so a deferred-regime search
	// can still report `semanticAvailable` while the fresh value is being rebuilt. Tiny; the
	// matrix itself is never kept stale (hundreds of MB, and serving it is not allowed).
	const staleStats = new Map();
	let matrixStale = false;
	const vaultKey = vaultId => (typeof vaultId === 'string' && vaultId !== '' ? vaultId : null);
	const spaceKey = space => (typeof space === 'string' && space !== '' ? space : null);

	let epoch = 0;
	const generations = new Map();
	const generationOf = vault => `${epoch}:${generations.get(vault) ?? 0}`;
	const bump = vault => generations.set(vault, (generations.get(vault) ?? 0) + 1);

	const deferred = () => Number(sizeHint.get()?.n ?? 0) > inlineRowLimit;

	function peek(cache, vaultId, space) {
		return cache.get(vaultKey(vaultId))?.get(spaceKey(space));
	}
	function store(cache, vaultId, space, value) {
		const outer = vaultKey(vaultId);
		let inner = cache.get(outer);
		if (!inner) {
			inner = new Map();
			cache.set(outer, inner);
		}
		inner.set(spaceKey(space), value);
	}
	function cached(cache, vaultId, space, build) {
		let value = peek(cache, vaultId, space);
		if (value === undefined) {
			value = build();
			store(cache, vaultId, space, value);
		}
		return value;
	}

	function computeStatsInline(vaultId, space) {
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
	}

	// The same aggregate as computeStatsInline, accumulated in JS over rowid-ranged batches.
	// Yields after every batch; returns the stats object (the runner publishes it).
	function* statsTask(vaultId, space) {
		const vault = vaultKey(vaultId);
		const filter = spaceKey(space);
		const bySpace = new Map();
		const byModel = new Map();
		let count = 0;
		let minDim = null;
		let maxDim = null;
		let after = 0;
		for (;;) {
			const rows = statsSlice.all(after, vault, vault, filter, filter, STATS_BATCH_ROWS);
			for (const row of rows) {
				count++;
				const dim = row.dim === null || row.dim === undefined ? null : Number(row.dim);
				if (dim !== null) {
					minDim = minDim === null ? dim : Math.min(minDim, dim);
					maxDim = maxDim === null ? dim : Math.max(maxDim, dim);
				}
				const label = typeof row.space === 'string' && row.space !== '' ? row.space : null;
				bySpace.set(label, (bySpace.get(label) ?? 0) + 1);
				byModel.set(row.model ?? null, (byModel.get(row.model ?? null) ?? 0) + 1);
				after = Number(row.rid);
			}
			if (rows.length < STATS_BATCH_ROWS) break;
			yield;
		}
		const spaces = [...bySpace.keys()].filter(label => label !== null).sort();
		const unlabelledCount = bySpace.get(null) ?? 0;
		let model = null;
		let best = 0;
		for (const [name, n] of byModel) if (n > best) { best = n; model = name; }
		const dim = count > 0 && minDim !== null && minDim === maxDim ? minDim : null;
		return { count, dim, model: count > 0 ? model : null, spaces, unlabelledCount };
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
		// `.iterate()`, not `.all()`: `.all()` held every embedding blob alive at once beside the
		// Float32Array it was being copied into (measured 992MB -> 477MB peak RSS, 1.68s -> 0.71s
		// at 99k vectors).
		for (const record of selectVectors.iterate(vaultId, filter, filter)) {
			const blob = record.embedding;
			if (!blob || blob.length !== dim * 4 || Number(record.embedding_dim) !== dim) continue;
			writeEmbeddingInto(matrix, row * dim, blob instanceof Uint8Array ? blob : new Uint8Array(blob), dim);
			ids.push(record.id);
			paths.push(record.path);
			row++;
		}
		return { count: row, dim, ids, paths, matrix, model: stats.model };
	}

	// The sliced twin of buildMatrix: stats first (fresh, same generation), then batches of
	// MATRIX_BATCH_ROWS embeddings copied into the preallocated matrix.
	function* matrixTask(vaultId, space) {
		let stats = peek(statsCache, vaultId, space);
		if (stats === undefined) {
			stats = yield* statsTask(vaultId, space);
			store(statsCache, vaultId, space, stats);
			staleStats.get(vaultKey(vaultId))?.delete(spaceKey(space));
		}
		if (stats.count === 0 || !stats.dim) return { count: 0, dim: 0, ids: [], paths: [], matrix: null, model: null };
		const dim = stats.dim;
		const matrix = new Float32Array(stats.count * dim);
		const ids = [];
		const paths = [];
		let row = 0;
		const filter = spaceKey(space);
		let after = 0;
		for (;;) {
			const records = matrixSlice.all(after, vaultId, filter, filter, MATRIX_BATCH_ROWS);
			for (const record of records) {
				after = Number(record.rid);
				const blob = record.embedding;
				if (row >= stats.count) continue;
				if (!blob || blob.length !== dim * 4 || Number(record.embedding_dim) !== dim) continue;
				writeEmbeddingInto(matrix, row * dim, blob instanceof Uint8Array ? blob : new Uint8Array(blob), dim);
				ids.push(record.id);
				paths.push(record.path);
				row++;
			}
			if (records.length < MATRIX_BATCH_ROWS) break;
			yield;
		}
		return { count: row, dim, ids, paths, matrix, model: stats.model };
	}

	// ── The serial, time-sliced rebuild runner ───────────────────────────────────────────
	const queue = [];
	const queuedKeys = new Set();
	let current = null;
	let slicing = false;
	let restarts = 0;
	let builds = 0;
	// Graceful shutdown: once stopped, nothing new is queued and an already-scheduled
	// `setImmediate` slice returns without touching the database, so the DB can be closed
	// right after stop() without a pending slice running against a closed handle.
	let stopped = false;

	function enqueue(kind, vaultId, space) {
		if (stopped) return;
		const vault = vaultKey(vaultId);
		const scope = spaceKey(space);
		const key = JSON.stringify([kind, vault, scope]);
		if (queuedKeys.has(key)) return;
		queuedKeys.add(key);
		queue.push({ kind, vault, space: scope, key });
		if (!slicing) {
			slicing = true;
			scheduleSlice(runSlice);
		}
	}

	function startTask(task) {
		task.generation = generationOf(task.vault);
		task.iterator = task.kind === 'matrix' ? matrixTask(task.vault, task.space) : statsTask(task.vault, task.space);
	}

	function runSlice() {
		if (stopped) {
			slicing = false;
			return;
		}
		const startedAt = clock();
		// At least one batch per slice, however slow the clock says the last one was.
		let first = true;
		while (first || clock() - startedAt < sliceMs) {
			first = false;
			if (!current) {
				current = queue.shift() ?? null;
				if (!current) break;
				startTask(current);
			}
			// An invalidation landed between batches: everything read so far may predate it, so
			// throw the partial work away and start over from rowid 0.
			if (current.generation !== generationOf(current.vault)) {
				restarts++;
				startTask(current);
			}
			const step = current.iterator.next();
			if (!step.done) continue;
			// Publish only if the generation still matches — this check and the last batch run
			// on the same tick, so no write can slip between them.
			if (current.generation === generationOf(current.vault)) {
				if (current.kind === 'matrix') {
					store(matrixCache, current.vault, current.space, step.value);
					matrixStale = false;
				} else {
					store(statsCache, current.vault, current.space, step.value);
				}
				staleStats.get(current.vault)?.delete(current.space);
				queuedKeys.delete(current.key);
				builds++;
				current = null;
			} else {
				restarts++;
				startTask(current);
			}
		}
		if (current || queue.length > 0) scheduleSlice(runSlice);
		else slicing = false;
	}

	function readStats(vaultId, space) {
		const fresh = peek(statsCache, vaultId, space);
		if (fresh !== undefined) return fresh;
		if (!deferred()) return cached(statsCache, vaultId, space, () => computeStatsInline(vaultId, space));
		enqueue('stats', vaultId, space);
		const last = staleStats.get(vaultKey(vaultId))?.get(spaceKey(space));
		return { ...(last ?? EMPTY_STATS), pending: true };
	}

	function ensureMatrix(vaultId, space) {
		return cached(matrixCache, vaultId, space, () => buildMatrix(vaultId, space));
	}

	function retire(vault) {
		const inner = statsCache.get(vault);
		if (inner) {
			const kept = staleStats.get(vault) ?? new Map();
			for (const [key, value] of inner) kept.set(key, value);
			staleStats.set(vault, kept);
		}
		statsCache.delete(vault);
		const live = matrixCache.get(vault);
		if (live && live.size > 0) {
			matrixStale = true;
			// A matrix a search was actually using is rebuilt proactively, off-request, rather
			// than waiting for the next search to find it missing (and answer vectorPending).
			// Only in the deferred regime: below the limit the next search rebuilds inline, as
			// it always did.
			if (deferred()) for (const space of live.keys()) enqueue('matrix', vault, space);
		}
		matrixCache.delete(vault);
	}

	return {
		name: 'brute-force-js',
		stats(vaultId, space) {
			return readStats(vaultId, space);
		},
		// WP-2: true when knn(vaultId, …, space) can answer from a fresh matrix without
		// building on the caller's stack. Below inlineRowLimit it builds inline and answers
		// true (the pre-WP-2 behaviour); above it, it schedules the sliced rebuild and answers
		// false, and the caller reports `vectorPending` instead of waiting.
		prepare(vaultId, space) {
			if (peek(matrixCache, vaultId, space) !== undefined) return true;
			if (!deferred()) {
				ensureMatrix(vaultId, space);
				return true;
			}
			enqueue('matrix', vaultId, space);
			return false;
		},
		// Graceful shutdown: drop the queue and the in-progress task; any slice already
		// scheduled becomes a no-op. Idempotent.
		stop() {
			stopped = true;
			queue.length = 0;
			queuedKeys.clear();
			current = null;
		},
		// WP-2 /health readout. Cheap: Map lookups only.
		status() {
			let vector;
			if (current || queue.length > 0) vector = 'building';
			else if ([...matrixCache.values()].some(inner => inner.size > 0)) vector = 'ready';
			else if (matrixStale) vector = 'stale';
			else vector = 'absent';
			return { vector, builds, restarts };
		},
		invalidate(vaultId) {
			if (vaultId === undefined) {
				epoch++;
				for (const vault of [...statsCache.keys()]) retire(vault);
				statsCache.clear();
				matrixCache.clear();
				return;
			}
			// Drops every space's entry for this vault, not just the one that was written.
			bump(vaultKey(vaultId));
			retire(vaultKey(vaultId));
			// The unscoped (/health) stats view covers every vault, so any write invalidates it.
			bump(null);
			retire(null);
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
