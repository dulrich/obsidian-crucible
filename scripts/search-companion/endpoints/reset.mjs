import { json, readJson, requireString } from '../http.mjs';

// POST /v1/index/reset — drops one vault's rows from `chunks` and `chunks_fts`.
//
// Injected dependencies: the raw `db` (this route owns its own transaction), the three
// prepared statements it uses, and the vector backend it invalidates afterwards.
//
// Transaction ownership is deliberately *here*, not in the dispatcher or the handler: the
// BEGIN/COMMIT spans exactly the FTS deletes plus the chunk delete, and the ROLLBACK is on the
// same throw path it always was. `vectors.invalidate` fires after COMMIT, outside the
// transaction, so a rolled-back reset never drops a still-valid matrix.
export function createResetEndpoint({ db, statements, vectors }) {
	const { deleteFtsByRowid, resetChunks, selectRowidsByVault } = statements;
	return async (req, res) => {
		const body = await readJson(req);
		const vaultId = requireString(body.vaultId, 'vaultId');
		db.exec('BEGIN');
		try {
			// Rowids are read from `chunks` (vault_id-indexed via idx_chunks_vault_path)
			// *before* resetChunks deletes them — chunks_fts carries no independent record
			// of which rowids belonged to this vault, only chunks does.
			for (const row of selectRowidsByVault.all(vaultId)) deleteFtsByRowid.run(row.rowid);
			resetChunks.run(vaultId);
			db.exec('COMMIT');
		} catch (e) {
			db.exec('ROLLBACK');
			throw e;
		}
		vectors.invalidate(vaultId);
		return json(res, 200, { ok: true });
	};
}
