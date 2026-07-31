import { json } from '../http.mjs';
import { SCHEMA_VERSION, SERVICE_VERSION } from '../schema.mjs';

// GET /health — the client's availability probe and the schema-pairing check.
//
// Injected dependencies: the vector backend only. No database handle, no clock, no body read
// (this is the one route that never calls readJson), which is what keeps a probe cheap enough
// to fire on a timer.
export function createHealthEndpoint({ vectors }) {
	return (req, res) => {
		// Computed, not a literal: `vectorAvailable` is "this index actually holds
		// vectors the scan can use", across every vault in the database.
		const stats = vectors.stats();
		return json(res, 200, {
			ok: true,
			version: SERVICE_VERSION,
			schemaVersion: SCHEMA_VERSION,
			vectorAvailable: stats.count > 0 && Boolean(stats.dim),
			vectorBackend: vectors.name,
			embeddedChunks: stats.count,
			embeddingDim: stats.dim,
			embeddingModel: stats.model,
			// Distinct spaces across every vault, so a mixed index is *visible* here
			// rather than inferred from searches that quietly went keyword-only. More
			// than one entry — or any unattributed vectors alongside attributed ones —
			// means some search will degrade; see resolveScanSpace.
			embeddingSpaces: stats.spaces ?? [],
			embeddingSpace: (stats.spaces ?? []).length === 1 && !stats.unlabelledCount ? stats.spaces[0] : null,
			unattributedEmbeddedChunks: stats.unlabelledCount ?? 0,
		});
	};
}
