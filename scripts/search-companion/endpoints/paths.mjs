import { json, readJson, requireString } from '../http.mjs';

// POST /v1/paths — every indexed path for a vault, with per-path chunk/embedding state.
//
// This is the endpoint the offline audit needs and the companion previously had no way to
// give it: `/v1/files/state` only echoes state for paths the caller already names, so
// nothing could enumerate "what does the index think exists" to diff against the vault's own
// file list (orphan/missing/stale detection was structurally impossible client-side). See
// `src/search/AGENTS.md` and `plans/search-index-audit-health.md` WP-SA1.
//
// One aggregate GROUP BY query (`selectPathsByVault`, statements.mjs) — no per-path loop.
// Additive: no schema change, no change to any existing route's behavior.
//
// Injected dependencies: one prepared statement. No `db`, because this route opens no
// transaction — it is read-only and vault-scoped, same shape as `/v1/files/state`.
export function createPathsEndpoint({ statements }) {
	const { selectPathsByVault } = statements;
	return async (req, res) => {
		const body = await readJson(req);
		const vaultId = requireString(body.vaultId, 'vaultId');
		const rows = selectPathsByVault.all(vaultId);
		const paths = rows.map(row => {
			const chunkCount = Number(row.chunk_count ?? 0);
			const embeddedCount = Number(row.embedded_count ?? 0);
			return {
				path: row.path,
				mtime: row.mtime,
				contentHash: row.content_hash || undefined,
				chunkCount,
				embeddedCount,
			};
		});
		const totals = paths.reduce(
			(acc, row) => {
				acc.paths += 1;
				acc.chunks += row.chunkCount;
				acc.embeddedChunks += row.embeddedCount;
				return acc;
			},
			{ paths: 0, chunks: 0, embeddedChunks: 0 },
		);
		return json(res, 200, { ok: true, paths, totals });
	};
}
