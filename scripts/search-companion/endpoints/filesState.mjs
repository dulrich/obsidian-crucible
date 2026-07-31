import { json, readJson, requireString } from '../http.mjs';

// POST /v1/files/state — per-path content hash, mtime and embedding coverage, which is what
// `SearchManager.indexFiles`' skip condition reads.
//
// Injected dependencies: one prepared statement. No `db`, because this route opens no
// transaction — it is read-only and per-path.
//
// Every field below is fail-closed on purpose: partial coverage is not coverage, and an
// ambiguous model/space reports `undefined` (which the client reads as "unknown" and
// re-embeds) rather than picking one arbitrarily. See `src/search/AGENTS.md`.
export function createFilesStateEndpoint({ statements }) {
	const { selectStateByPath } = statements;
	return async (req, res) => {
		const body = await readJson(req);
		const vaultId = requireString(body.vaultId, 'vaultId');
		const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
		const files = [];
		for (const path of paths) {
			const row = selectStateByPath.get(vaultId, path);
			if (!row) continue;
			const chunkCount = Number(row.chunk_count ?? 0);
			const embeddedCount = Number(row.embedded_count ?? 0);
			const labelledCount = Number(row.embedded_labelled_count ?? 0);
			const modelCount = Number(row.embedding_model_count ?? 0);
			const spacedCount = Number(row.embedded_spaced_count ?? 0);
			const spaceCount = Number(row.embedding_space_count ?? 0);
			files.push({
				path: row.path,
				contentHash: row.content_hash || undefined,
				mtime: row.mtime,
				chunkCount,
				embeddedChunkCount: embeddedCount,
				// Full coverage, never partial. See the comment on selectStateByPath.
				hasEmbeddings: chunkCount > 0 && embeddedCount === chunkCount,
				embeddingModel: embeddedCount > 0 && modelCount === 1 && labelledCount === embeddedCount && row.embedding_model
					? String(row.embedding_model)
					: undefined,
				// Same fail-closed conjunction as embeddingModel, deliberately — at least one
				// embedded chunk, exactly one distinct non-null value, and every embedded
				// chunk labelled. Anything else reports undefined, which the client reads as
				// "unknown" and therefore re-embeds rather than trusting.
				embeddingSpace: embeddedCount > 0 && spaceCount === 1 && spacedCount === embeddedCount && row.embedding_space
					? String(row.embedding_space)
					: undefined,
			});
		}
		return json(res, 200, { ok: true, files });
	};
}
