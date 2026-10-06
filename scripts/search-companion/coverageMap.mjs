// search-latency-tail WP-2 — the coverage leg's in-memory rowid map.
//
// The coverage leg used to read `id`/`path` straight out of `chunks_fts` per hit
// (COVERAGE_SQL). Those are UNINDEXED FTS5 columns, so every hit paid a content-table read;
// at 100k chunks a 9-term query spent most of its time there. The lean form scans rowids only
// (COVERAGE_ROWID_SQL in ./search.mjs) and resolves each rowid through this map — measured
// p50 53→20ms, p90 518→231ms on the 101-query spike, identical results. `chunks_fts.rowid`
// equals `chunks.rowid` by construction (rowid pinning, schema 6), so `chunks` is the source.
//
// The invariant: the map never disagrees with `chunks` at the moment a search reads it.
//   - Every writer of `chunks` (upsert sub-batches, chunk delete, reset) records its rowid
//     changes in a journal (`begin()`) and publishes it with `commit(journal)` only AFTER its
//     own SQL COMMIT. A rolled-back transaction simply drops its journal. This tracks each
//     committed sub-batch individually — it is deliberately NOT tied to the flush-level
//     vector invalidation, which fires only in the upsert finalizer (plan audit item 4).
//   - Until the map is ready, `lookup()` returns null and the caller falls back to today's
//     COVERAGE_SQL — never "no coverage".
//   - A build below `inlineRowLimit` (the vector backend's precedent, MAX(rowid) probe) runs
//     inline on first use. Above it, the build is scheduled off the request path in
//     rowid-ranged slices; journals committed while it runs are applied to the partial map
//     too, which is safe either way: a rowid the scan has not reached yet is overwritten by
//     the scan's (newer) read of the same row, and a deleted one is simply never read.
//   - `invalidate()` (for any future bulk writer that does not journal) discards the map and
//     restarts any running build via a generation counter.
//
// Entries carry the vault so the coverage leg can filter in JS: a chunk id is unique only
// within a vault (src/search/AGENTS.md), and the lean scan is not vault-filtered in SQL.
import { setImmediate } from 'node:timers';

import { DEFAULT_INLINE_ROW_LIMIT } from './vectors.mjs';

const DEFAULT_SLICE_ROWS = 5000;

export function createCoverageMap(db, options = {}) {
	const inlineRowLimit = options.inlineRowLimit ?? DEFAULT_INLINE_ROW_LIMIT;
	const sliceRows = options.sliceRows ?? DEFAULT_SLICE_ROWS;
	const schedule = options.schedule ?? (fn => setImmediate(fn));
	const sizeHint = db.prepare('SELECT MAX(rowid) AS n FROM chunks');
	const sliceStatement = db.prepare('SELECT rowid AS r, id, vault_id, path FROM chunks WHERE rowid > ? ORDER BY rowid LIMIT ?');

	let rows = null; // Map<rowid, { id, vaultId, path }> while ready or building
	let ready = false;
	let building = false;
	let generation = 0;
	let builds = 0;

	function buildSlices(gen, after) {
		if (gen !== generation) return; // superseded by invalidate(); that call rescheduled
		// Graceful shutdown (server.mjs) closes the DB once handlers drain; a slice already
		// queued on setImmediate must not run against the closed handle.
		if (!db.isOpen) {
			building = false;
			return;
		}
		let last = after;
		let n = 0;
		for (const row of sliceStatement.all(after, sliceRows)) {
			rows.set(row.r, { id: row.id, vaultId: row.vault_id, path: row.path });
			last = row.r;
			n++;
		}
		if (n < sliceRows) {
			ready = true;
			building = false;
			builds++;
			return;
		}
		schedule(() => buildSlices(gen, last));
	}

	function startBuild(inline) {
		building = true;
		rows = new Map();
		const gen = generation;
		if (inline) {
			// Inline means "small": loop the slices on this stack.
			let after = 0;
			for (;;) {
				let n = 0;
				for (const row of sliceStatement.all(after, sliceRows)) {
					rows.set(row.r, { id: row.id, vaultId: row.vault_id, path: row.path });
					after = row.r;
					n++;
				}
				if (n < sliceRows) break;
			}
			ready = true;
			building = false;
			builds++;
			return;
		}
		schedule(() => buildSlices(gen, 0));
	}

	return {
		// The ready map, or null (caller falls back to COVERAGE_SQL). Kicks a build when cold.
		lookup() {
			if (ready) return rows;
			if (!building) startBuild(Number(sizeHint.get()?.n ?? 0) <= inlineRowLimit);
			return ready ? rows : null;
		},
		begin() {
			const ops = [];
			return {
				ops,
				delete(rowid) { ops.push([Number(rowid)]); },
				set(rowid, id, vaultId, path) { ops.push([Number(rowid), { id, vaultId, path }]); },
			};
		},
		// Call only after the journal's transaction has COMMITted.
		commit(journal) {
			if (rows === null || !journal) return;
			for (const [rowid, entry] of journal.ops) {
				if (entry) rows.set(rowid, entry);
				else rows.delete(rowid);
			}
		},
		invalidate() {
			generation++;
			rows = null;
			ready = false;
			building = false;
		},
		status() {
			return { ready, building, size: rows ? rows.size : 0, builds };
		},
	};
}
