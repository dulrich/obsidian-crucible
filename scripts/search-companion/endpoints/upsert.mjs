import { setImmediate as yieldEventLoop } from 'node:timers/promises';

import { normalizeChunkEntities, optionalId, prepareChunkEmbedding } from '../chunks.mjs';
import { HttpError, json, readJson, requireString } from '../http.mjs';

// POST /v1/chunks/upsert — the flush endpoint, and the one that owns the most machinery:
// sub-batch transactions, the per-request width/space guard, the interactive-priority yield,
// and the once-per-flush vector invalidation. Split out of the single-file companion
// (WP-rem-R3) together with the sub-batch splitter it is the only caller of.
//
// Transaction ownership stays here, unchanged: one BEGIN/COMMIT per sub-batch, ROLLBACK on
// throw, and the `try { ... } finally` around the whole loop so a mid-flush throw still
// invalidates every vault an earlier sub-batch committed into.

// A bulk upsert used to run as one BEGIN/COMMIT transaction over every chunk in the request —
// hundreds at a time. `node:sqlite`'s `DatabaseSync` is synchronous, so that whole transaction
// ran without ever yielding the event loop, and a `/health` request arriving mid-upsert simply
// queued behind it: measured 17 such probe timeouts in one indexing run, each landing right
// before a +500 chunk counter jump on a companion that was never actually down (see
// SEARCH_PROBE_TIMEOUT_ESCALATION_THRESHOLD on the client side, which is the other half of
// this fix). Splitting into sub-batches, each its own transaction with an event-loop yield
// between them, lets a pending `/health` (or any other request) get serviced between chunks
// of the upsert instead of only after all of it completes.
//
// Chunk upserts are idempotent per `(vault_id, id)` (a full replace, not a merge — see
// upsertChunk below), so a sub-batch committing before a later one in the same request throws
// is safe: re-sending the request repeats already-correct work rather than corrupting it. That
// idempotency guarantee holds only at the granularity of a whole PATH, though: the first chunk
// seen for a `(vaultId, path)` deletes every existing row for that path before any new rows for
// it are inserted (a full replace, not a merge — see `clearedPaths` below), so if that path's
// chunks were split across two sub-batches and the second one throws, the path would be left
// with its old rows deleted and only some of its new rows committed — stale AND wrong, and
// worse than the pre-split behavior (one transaction, so a throw anywhere rolled the whole
// request back and left the path's previous rows untouched). `splitUpsertSubBatches` therefore
// groups by `(vaultId, path)` first and packs whole groups into sub-batches, letting a
// sub-batch overflow the target size rather than splitting a group. The invariant this
// guarantees: a path's chunks never span sub-batches, so a mid-request failure can leave a path
// stale (untouched, if its sub-batch never ran) or fully-new (committed, if its sub-batch did)
// but never half-written.
export const UPSERT_SUB_BATCH_CHUNKS = 100;

// WP-4: interactive-priority yield. A sub-batch is an uninterruptible ~3.4s synchronous
// transaction (measured at the ~17s/500-chunk throughput this file's other comments cite) —
// `yieldEventLoop()` between sub-batches only lets a QUEUED request start, it does not make the
// flush loop stand aside once a search has actually landed. Without this, a user actively
// searching mid-backfill gets exactly one sub-batch's worth of latency per query and then the
// flush immediately claims the thread again for another 3.4s block. 1500ms is chosen as roughly
// the gap a person leaves between typing a query and its follow-up (a refined term, a repeat
// search) — long enough that a follow-up query lands in the open window and gets served promptly
// rather than queuing behind another full sub-batch, short enough that the backfill still visibly
// grinds forward between searches rather than looking stalled.
export const INTERACTIVE_YIELD_MS = 1500;

// Bounds INTERACTIVE_YIELD_MS's total cost across one flush. Deferral is deliberately per-search
// (see lastInteractiveSearchAt below) so it decays on its own once queries stop arriving, but a
// user who searches continuously — or a scripted client polling — must not be able to hold the
// flush loop open indefinitely; a backfill has to finish. 15s caps the worst case to roughly ten
// extra sub-batch-sized gaps before the flush runs the rest of its sub-batches back-to-back
// regardless of further searches.
export const INTERACTIVE_YIELD_CUMULATIVE_CAP_MS = 15_000;

// Pure and exported for unit testing without a database — see the module-shape note at the top
// of this file. `size <= 0` is treated as "no splitting" (one batch) rather than looping
// forever.
//
// `fallbackVaultId` mirrors the per-chunk `chunk.vaultId ?? body.vaultId` resolution the request
// handler applies when actually writing each chunk (a chunk may omit its own `vaultId` and rely
// on the request's top-level one). Grouping on `chunk.vaultId` alone, ignoring that fallback,
// could split what is really one (vaultId, path) group in two — one sub-group keyed on the
// explicit vaultId a sibling chunk happened to repeat, one keyed on `undefined` — which would
// silently reopen the same straddling bug this helper exists to close. Pass it whenever the
// caller has a request-level `vaultId` to fall back to.
export function splitUpsertSubBatches(chunks, size = UPSERT_SUB_BATCH_CHUNKS, fallbackVaultId) {
	if (!Array.isArray(chunks) || chunks.length === 0) return [];
	const target = size > 0 ? size : Infinity;

	// Group by (vaultId, path), preserving first-seen order. Callers already send one path's
	// chunks contiguously in practice, but this does not assume it — every chunk is grouped by
	// identity, not by position, so even a caller that interleaves two paths' chunks still gets
	// each path's chunks packed together, never split.
	const groups = [];
	const groupIndexByKey = new Map();
	for (const chunk of chunks) {
		const vaultId = (chunk && chunk.vaultId) ?? fallbackVaultId;
		const key = `${vaultId}\n${chunk && chunk.path}`;
		let index = groupIndexByKey.get(key);
		if (index === undefined) {
			index = groups.length;
			groupIndexByKey.set(key, index);
			groups.push([]);
		}
		groups[index].push(chunk);
	}

	// Pack whole groups into sub-batches of ~`size`, letting a sub-batch overflow rather than
	// split a group — see the invariant documented above UPSERT_SUB_BATCH_CHUNKS. A single path
	// with more than `size` chunks becomes its own oversized sub-batch; that's the pre-existing
	// atomicity for that path, not a regression.
	const batches = [];
	let current = [];
	let currentCount = 0;
	for (const group of groups) {
		if (current.length > 0 && currentCount + group.length > target) {
			batches.push(current);
			current = [];
			currentCount = 0;
		}
		current.push(...group);
		currentCount += group.length;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

// Injected dependencies: the raw `db` (this route owns a transaction per sub-batch), the
// prepared statements it writes through, the vector backend it invalidates, the clock, the
// pause, and the handler-scoped `state` holder it *reads* `lastInteractiveSearchAt` from.
// `now` and `delay` are seams for the real-HTTP tests — production always gets `Date.now` and
// the real `setTimeout` promise via the handler's defaults.
export function createUpsertEndpoint({ db, statements, vectors, now, delay, state }) {
	const {
		deleteByPath,
		deleteFtsByRowid,
		insertFts,
		selectRowidsByPath,
		selectVaultEmbeddingDim,
		selectVaultEmbeddingSpace,
		upsertChunk,
	} = statements;
	return async (req, res) => {
		const body = await readJson(req);
		const chunks = Array.isArray(body.chunks) ? body.chunks : [];
		const touchedVaults = new Set();
		// Width *and* space consistency, enforced once per vault per REQUEST — across every
		// sub-batch below, not reset per sub-batch, so splitting the transaction does not
		// weaken the check. Mixing two vector spaces inside one index is the failure mode
		// that produces confidently wrong rankings with no error anywhere — and width alone
		// does not catch it: bge-m3 is 1024d under every quantization, so an fp32 index and
		// a Q4 re-index pass a width check unchanged. Both are refused here.
		//
		// Deliberately *not* also a per-batch space check, unlike `batchDim`. A mixed-width
		// batch cannot be stored coherently at all, whereas chunks disagreeing about their
		// producing model inside one batch is a state /v1/files/state already reports
		// fail-closed (it answers `undefined`, so the client re-embeds) and the scan filter
		// already survives. Refusing it here would only delete that defence's test coverage.
		const checkedVaults = new Set();
		const clearedPaths = new Set();
		let batchDim = null;
		// Split into sub-batches, each its own transaction, so a `/health` request (or
		// anything else) queued behind a large upsert gets serviced between them instead of
		// only after the whole thing completes. See UPSERT_SUB_BATCH_CHUNKS. `body.vaultId`
		// is passed as the fallback so grouping matches the same `chunk.vaultId ?? body.vaultId`
		// resolution used below when a chunk omits its own vaultId.
		const subBatches = splitUpsertSubBatches(chunks, UPSERT_SUB_BATCH_CHUNKS, body.vaultId);
		// WP-4: this flush's own interactive-yield state. `flushStartedAt` scopes
		// `state.lastInteractiveSearchAt` (handler-scoped, since a search always arrives as a
		// separate request from the flush) to "served during THIS flush" — a search served
		// before this flush even started must not trigger a deferral here.
		// `cumulativeDeferMs` is this flush's own running total against
		// INTERACTIVE_YIELD_CUMULATIVE_CAP_MS; it is a fresh local for every
		// /v1/chunks/upsert request, so the cap never carries over between flushes.
		const flushStartedAt = now();
		let cumulativeDeferMs = 0;
		try {
		for (let batchIndex = 0; batchIndex < subBatches.length; batchIndex++) {
			const subBatch = subBatches[batchIndex];
			db.exec('BEGIN');
			try {
				for (const chunk of subBatch) {
					const id = requireString(chunk.id, 'chunk.id');
					const vaultId = requireString(chunk.vaultId ?? body.vaultId, 'chunk.vaultId');
					const path = requireString(chunk.path, 'chunk.path');
					const contentHash = requireString(chunk.contentHash, 'chunk.contentHash');
					const title = String(chunk.title ?? path);
					const heading = String(chunk.heading ?? '');
					const text = requireString(chunk.text, 'chunk.text');
					const mtime = Number(chunk.mtime ?? 0);
					const ordinal = Number(chunk.ordinal ?? 0);
					// Never a 400: a malformed entity is dropped, not refused. Unlike a
					// wrong-width vector — which cannot be stored coherently at all and so
					// must fail loudly — a junk `author:` value is user-authored text that
					// should cost the note its facet, not its entire indexing.
					const entities = normalizeChunkEntities(chunk.entities);
					const pathKey = `${vaultId}\n${path}`;
					// The first chunk seen for a (vaultId, path) clears every existing row
					// for that path: an upsert is a full replace, not a merge.
					if (!clearedPaths.has(pathKey)) {
						for (const row of selectRowidsByPath.all(vaultId, path)) deleteFtsByRowid.run(row.rowid);
						deleteByPath.run(vaultId, path);
						clearedPaths.add(pathKey);
					}
					touchedVaults.add(vaultId);

					const embedding = prepareChunkEmbedding(
						chunk.embedding,
						chunk.embeddingModel ?? body.embeddingModel,
						chunk.embeddingSpace ?? body.embeddingSpace,
					);
					if (embedding) {
						if (batchDim === null) batchDim = embedding.dim;
						else if (embedding.dim !== batchDim) {
							throw new HttpError(400, `chunk "${id}" carries a ${embedding.dim}-dimension embedding but this batch established ${batchDim}`);
						}
						if (!checkedVaults.has(vaultId)) {
							// Read *after* this path's rows were cleared, so re-embedding a
							// vault that holds exactly one path is allowed while a genuine
							// mix (other paths still at the old width, or in the old space)
							// is refused.
							const existing = selectVaultEmbeddingDim.get(vaultId);
							const existingDim = existing?.dim === null || existing?.dim === undefined ? null : Number(existing.dim);
							if (existingDim && existingDim !== embedding.dim) {
								throw new HttpError(400, `vault "${vaultId}" is indexed with ${existingDim}-dimension embeddings; refusing a ${embedding.dim}-dimension vector. Reset the index before changing the embedding model.`);
							}
							const existingSpace = optionalId(selectVaultEmbeddingSpace.get(vaultId)?.space);
							if (existingSpace && embedding.space && existingSpace !== embedding.space) {
								throw new HttpError(400, `vault "${vaultId}" is indexed in embedding space "${existingSpace}"; refusing a vector from "${embedding.space}". Two spaces in one index cannot be compared, so reset the index before changing the embedding model or its precision.`);
							}
							checkedVaults.add(vaultId);
						}
					}

					// `.get()`, not `.run()`: the RETURNING clause makes this a row-producing
					// statement, and the chunk's rowid is what pins the chunks_fts row below
					// to the right rowid — see the comment on `upsertChunk`'s declaration.
					const { rowid } = upsertChunk.get(
						id,
						vaultId,
						path,
						contentHash,
						title,
						heading,
						text,
						Number.isFinite(mtime) ? mtime : 0,
						Number.isFinite(ordinal) ? ordinal : 0,
						JSON.stringify(chunk.metadata ?? {}),
						embedding ? embedding.bytes : null,
						embedding ? embedding.dim : null,
						embedding ? embedding.model : null,
						embedding ? embedding.space : null,
						entities,
					);
					deleteFtsByRowid.run(rowid);
					insertFts.run(rowid, id, vaultId, path, title, heading, text, entities);
				}
				db.exec('COMMIT');
			} catch (e) {
				db.exec('ROLLBACK');
				throw e;
			}
			if (batchIndex < subBatches.length - 1) {
				await yieldEventLoop();
				// WP-4: interactive-priority yield — see INTERACTIVE_YIELD_MS's declaration for
				// the full rationale. `lastInteractiveSearchAt >= flushStartedAt` is what scopes
				// this to a search that landed DURING this flush (the plain `yieldEventLoop()`
				// above is what let it interleave at all); a search from before the flush began
				// must not retrigger a deferral here. Per-search and self-decaying: once
				// `INTERACTIVE_YIELD_MS` has elapsed since the last search with no further one
				// arriving, `remaining` goes non-positive and this becomes a no-op again on its
				// own, with no separate "reset" step needed. Bounded in total by
				// `INTERACTIVE_YIELD_CUMULATIVE_CAP_MS` so continuous searching cannot stall the
				// flush indefinitely.
				if (state.lastInteractiveSearchAt >= flushStartedAt) {
					const remaining = INTERACTIVE_YIELD_MS - (now() - state.lastInteractiveSearchAt);
					const budgetLeft = INTERACTIVE_YIELD_CUMULATIVE_CAP_MS - cumulativeDeferMs;
					if (remaining > 0 && budgetLeft > 0) {
						const waitMs = Math.min(remaining, budgetLeft);
						await delay(waitMs);
						cumulativeDeferMs += waitMs;
					}
				}
			}
		}
		} finally {
			// WP-4: once per completed flush, per touched vault — moved off the per-sub-batch
			// schedule above. During an active backfill, invalidating after every ~100-chunk
			// commit meant the ~117MB/28.7k-chunk matrix (and `statsCache`, dropped on the same
			// call) was rebuilt on effectively every search, at a measured ~800ms each; the
			// matrix was never warm for the duration of the backfill. Trade-off, deliberate: a
			// newly-upserted chunk is not vector-searchable until the WHOLE flush finishes, not
			// after its own sub-batch. The `try { ... } finally` (rather than only invalidating
			// after the loop) is what preserves the correctness invariant on a mid-flush throw:
			// `touchedVaults` already holds every vault an EARLIER, successfully-committed
			// sub-batch wrote into by the time a LATER sub-batch fails, and those vaults' cached
			// matrix/stats are genuinely stale regardless of the later failure — they must still
			// be invalidated here rather than left stale because the request as a whole 500s.
			// (A vault that only appears here because it belongs to this request's own
			// rolled-back sub-batch gets an extra, harmless invalidate: `invalidate` never
			// discards real data, it only forces the next read to rebuild from whatever is
			// actually on disk.)
			for (const vault of touchedVaults) vectors.invalidate(vault);
		}
		return json(res, 200, { ok: true, count: chunks.length });
	};
}
