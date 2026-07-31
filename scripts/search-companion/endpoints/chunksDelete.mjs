import { json, readJson, requireString } from '../http.mjs';

// POST /v1/chunks/delete — drops every chunk of the named paths, for one vault.
//
// Injected dependencies: the raw `db` (this route owns its own transaction), the three
// prepared statements it uses, and the vector backend it invalidates afterwards.
//
// Transaction ownership is unchanged: one BEGIN/COMMIT around the whole path list (not one
// per path), ROLLBACK on throw, and a single `vectors.invalidate` after COMMIT.
export function createChunksDeleteEndpoint({ db, statements, vectors }) {
	const { deleteByPath, deleteFtsByRowid, selectRowidsByPath } = statements;
	return async (req, res) => {
		const body = await readJson(req);
		const vaultId = requireString(body.vaultId, 'vaultId');
		const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
		db.exec('BEGIN');
		try {
			for (const path of paths) {
				for (const row of selectRowidsByPath.all(vaultId, path)) deleteFtsByRowid.run(row.rowid);
				deleteByPath.run(vaultId, path);
			}
			db.exec('COMMIT');
		} catch (e) {
			db.exec('ROLLBACK');
			throw e;
		}
		vectors.invalidate(vaultId);
		return json(res, 200, { ok: true });
	};
}
