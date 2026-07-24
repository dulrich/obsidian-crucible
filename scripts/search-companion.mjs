#!/usr/bin/env node
/* global process */
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
	args.set(process.argv[i], process.argv[i + 1]);
}

const port = Number(args.get('--port') ?? process.env.CRUCIBLE_SEARCH_PORT ?? 4801);
const host = args.get('--host') ?? process.env.CRUCIBLE_SEARCH_HOST ?? '127.0.0.1';
const dbPath = resolve(args.get('--db') ?? process.env.CRUCIBLE_SEARCH_DB ?? '.crucible/search.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  heading TEXT NOT NULL,
  text TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  embedding_json TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  id UNINDEXED,
  vault_id UNINDEXED,
  path UNINDEXED,
  title,
  heading,
  text
);
CREATE INDEX IF NOT EXISTS idx_chunks_vault_path ON chunks(vault_id, path);
`);

const chunkColumns = db.prepare('PRAGMA table_info(chunks)').all().map(row => row.name);
if (!chunkColumns.includes('content_hash')) {
	db.exec("ALTER TABLE chunks ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
}
db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_vault_path_hash ON chunks(vault_id, path, content_hash)');

const upsertChunk = db.prepare(`
INSERT INTO chunks (id, vault_id, path, content_hash, title, heading, text, mtime, ordinal, metadata_json, embedding_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  vault_id = excluded.vault_id,
  path = excluded.path,
  content_hash = excluded.content_hash,
  title = excluded.title,
  heading = excluded.heading,
  text = excluded.text,
  mtime = excluded.mtime,
  ordinal = excluded.ordinal,
  metadata_json = excluded.metadata_json,
  embedding_json = excluded.embedding_json
`);
const deleteFtsById = db.prepare('DELETE FROM chunks_fts WHERE id = ?');
const insertFts = db.prepare('INSERT INTO chunks_fts (id, vault_id, path, title, heading, text) VALUES (?, ?, ?, ?, ?, ?)');
const deleteByPath = db.prepare('DELETE FROM chunks WHERE vault_id = ? AND path = ?');
const selectIdsByPath = db.prepare('SELECT id FROM chunks WHERE vault_id = ? AND path = ?');
const selectStateByPath = db.prepare(`
SELECT path, content_hash, MAX(mtime) AS mtime, COUNT(*) AS chunk_count
FROM chunks
WHERE vault_id = ? AND path = ?
GROUP BY path, content_hash
ORDER BY chunk_count DESC
LIMIT 1
`);
const resetChunks = db.prepare('DELETE FROM chunks WHERE vault_id = ?');
const resetFts = db.prepare('DELETE FROM chunks_fts WHERE vault_id = ?');

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
		if (req.method === 'GET' && url.pathname === '/health') {
			return json(res, 200, { ok: true, version: 'dev-fts', schemaVersion: 1, vectorAvailable: false });
		}
		if (req.method === 'POST' && url.pathname === '/v1/index/reset') {
			const body = await readJson(req);
			const vaultId = requireString(body.vaultId, 'vaultId');
			db.exec('BEGIN');
			try {
				resetChunks.run(vaultId);
				resetFts.run(vaultId);
				db.exec('COMMIT');
			} catch (e) {
				db.exec('ROLLBACK');
				throw e;
			}
			return json(res, 200, { ok: true });
		}
		if (req.method === 'POST' && url.pathname === '/v1/chunks/delete') {
			const body = await readJson(req);
			const vaultId = requireString(body.vaultId, 'vaultId');
			const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
			db.exec('BEGIN');
			try {
				for (const path of paths) {
					for (const row of selectIdsByPath.all(vaultId, path)) deleteFtsById.run(row.id);
					deleteByPath.run(vaultId, path);
				}
				db.exec('COMMIT');
			} catch (e) {
				db.exec('ROLLBACK');
				throw e;
			}
			return json(res, 200, { ok: true });
		}
		if (req.method === 'POST' && url.pathname === '/v1/files/state') {
			const body = await readJson(req);
			const vaultId = requireString(body.vaultId, 'vaultId');
			const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
			const files = [];
			for (const path of paths) {
				const row = selectStateByPath.get(vaultId, path);
				if (!row) continue;
				files.push({
					path: row.path,
					contentHash: row.content_hash || undefined,
					mtime: row.mtime,
					chunkCount: row.chunk_count,
				});
			}
			return json(res, 200, { ok: true, files });
		}
		if (req.method === 'POST' && url.pathname === '/v1/chunks/upsert') {
			const body = await readJson(req);
			const chunks = Array.isArray(body.chunks) ? body.chunks : [];
			db.exec('BEGIN');
			try {
				const clearedPaths = new Set();
				for (const chunk of chunks) {
					const id = requireString(chunk.id, 'chunk.id');
					const vaultId = requireString(chunk.vaultId ?? body.vaultId, 'chunk.vaultId');
					const path = requireString(chunk.path, 'chunk.path');
					const contentHash = requireString(chunk.contentHash, 'chunk.contentHash');
					const title = String(chunk.title ?? path);
					const heading = String(chunk.heading ?? '');
					const text = requireString(chunk.text, 'chunk.text');
					const mtime = Number(chunk.mtime ?? 0);
					const ordinal = Number(chunk.ordinal ?? 0);
					const pathKey = `${vaultId}\n${path}`;
					if (!clearedPaths.has(pathKey)) {
						for (const row of selectIdsByPath.all(vaultId, path)) deleteFtsById.run(row.id);
						deleteByPath.run(vaultId, path);
						clearedPaths.add(pathKey);
					}
					upsertChunk.run(
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
						chunk.embedding ? JSON.stringify(chunk.embedding) : null,
					);
					deleteFtsById.run(id);
					insertFts.run(id, vaultId, path, title, heading, text);
				}
				db.exec('COMMIT');
			} catch (e) {
				db.exec('ROLLBACK');
				throw e;
			}
			return json(res, 200, { ok: true, count: chunks.length });
		}
		if (req.method === 'POST' && url.pathname === '/v1/search') {
			const body = await readJson(req);
			const vaultId = requireString(body.vaultId, 'vaultId');
			const query = requireString(body.query, 'query');
			const limit = Math.max(1, Math.min(Number(body.limit ?? 12), 100));
			const match = buildFtsQuery(query);
			const rows = db.prepare(`
SELECT c.id, c.path, c.title, c.heading,
       snippet(chunks_fts, 5, '', '', '...', 18) AS snippet,
       bm25(chunks_fts) AS score_text,
       c.metadata_json
FROM chunks_fts
JOIN chunks c ON c.id = chunks_fts.id
WHERE chunks_fts.vault_id = ? AND chunks_fts MATCH ?
ORDER BY score_text
LIMIT ?
`).all(vaultId, match, limit);
			const totalRow = db.prepare(`
SELECT COUNT(*) AS total
FROM chunks_fts
WHERE chunks_fts.vault_id = ? AND chunks_fts MATCH ?
`).get(vaultId, match);
			const total = Number(totalRow?.total ?? rows.length);
			return json(res, 200, {
				mode: 'fts',
				semanticAvailable: false,
				total,
				hasMore: total > rows.length,
				results: rows.map(row => ({
					chunkId: row.id,
					path: row.path,
					title: row.title,
					heading: row.heading,
					snippet: row.snippet,
					score: -Number(row.score_text ?? 0),
					scoreText: -Number(row.score_text ?? 0),
					metadata: safeJson(row.metadata_json),
				})),
			});
		}
		return json(res, 404, { ok: false, error: 'not found' });
	} catch (e) {
		return json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
	}
});

server.listen(port, host, () => {
	process.stdout.write(`Crucible search companion listening on http://${host}:${port}\n`);
	process.stdout.write(`SQLite database: ${dbPath}\n`);
});

function readJson(req) {
	return new Promise((resolve, reject) => {
		let raw = '';
		req.setEncoding('utf8');
		req.on('data', chunk => {
			raw += chunk;
			if (raw.length > 20_000_000) reject(new Error('request body too large'));
		});
		req.on('end', () => {
			try {
				resolve(raw ? JSON.parse(raw) : {});
			} catch (e) {
				reject(e);
			}
		});
		req.on('error', reject);
	});
}

function json(res, status, body) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

function requireString(value, name) {
	if (typeof value !== 'string' || value.trim() === '') throw new Error(`Missing ${name}`);
	return value.trim();
}

function buildFtsQuery(query) {
	const terms = query.toLowerCase().match(/[a-z0-9_@./:-]+/g) ?? [];
	const unique = Array.from(new Set(terms)).slice(0, 24);
	if (unique.length === 0) return JSON.stringify(query);
	return unique.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

function safeJson(value) {
	try {
		return JSON.parse(String(value || '{}'));
	} catch {
		return {};
	}
}
