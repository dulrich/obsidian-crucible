import { FileSystemAdapter } from 'obsidian';
import type { App } from 'obsidian';
import type { SqliteDatabase } from './types';

/**
 * Thrown whenever the plugin cannot open its job-queue database — either
 * `node:sqlite` itself is unavailable in this runtime (wrong Electron/Node build, or
 * a platform where it was never shipped) or the vault isn't backed by a real
 * filesystem (mobile has no `FileSystemAdapter`, and node:sqlite cannot open through
 * `vault.adapter`). Per the WP-5 brief's hard constraints: NO silent fallback, NO
 * alternative storage — every caller on this path is expected to catch this and
 * surface it to the user rather than swallow it.
 */
export class SqliteUnavailableError extends Error {
	constructor(message: string, readonly cause?: unknown) {
		super(message);
		this.name = 'SqliteUnavailableError';
	}
}

interface NodeSqliteModule {
	DatabaseSync: new (path: string) => SqliteDatabase;
}

let cachedModule: NodeSqliteModule | null = null;

/**
 * Lazily requires `node:sqlite`. This MUST stay a runtime `require` inside a
 * function — never a top-level import — for two reasons: (1) esbuild externalizes
 * node builtins bare and `node:`-prefixed (`esbuild.config.mjs`) rather than
 * bundling them, so a top-level `import` would still resolve at Electron-renderer
 * load time, before any capability probe gets a chance to run; (2) the whole point
 * of the probe is to turn "module missing" into a caught, typed, user-visible error
 * instead of an uncaught module-resolution exception at plugin load. Runtime facts
 * verified live in Obsidian devtools 2026-07-30: renderer Node is 22.22.1 and
 * `require('node:sqlite')` loads truthy unflagged there; the test runner is Node 24.
 * Only the stable core surface common to both is used (`DatabaseSync`, `prepare`,
 * `exec`, positional parameters, `:memory:`) — no 23+/24-only options.
 */
function loadNodeSqlite(): NodeSqliteModule {
	if (cachedModule) return cachedModule;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-nodejs-modules, no-undef
		const mod = require('node:sqlite') as NodeSqliteModule;
		if (!mod || typeof mod.DatabaseSync !== 'function') {
			throw new Error('node:sqlite loaded but DatabaseSync is missing');
		}
		cachedModule = mod;
		return mod;
	} catch (err) {
		throw new SqliteUnavailableError(
			'node:sqlite is unavailable in this runtime. The Crucible job queue requires it ' +
			'(Obsidian desktop, an Electron renderer built with node:sqlite enabled) — there is ' +
			'no alternative storage.',
			err,
		);
	}
}

/**
 * Capability probe: true if `node:sqlite` can be loaded and exposes `DatabaseSync`.
 * This is the programmatic form of the devtools precondition check
 * (`require('node:process').versions.node` + `!!require('node:sqlite')`) the user ran
 * before this WP was dispatched — exposed so a caller (settings tab, main.ts onload)
 * can gate on it and surface a clean message instead of letting `openJobsDb` throw
 * deep inside an enqueue call.
 */
export function isSqliteAvailable(): boolean {
	try {
		loadNodeSqlite();
		return true;
	} catch {
		return false;
	}
}

// schema_version lives in a `meta` row rather than `PRAGMA user_version`, per the
// WP-5 brief's item 1 — mirrors the search companion's self-migrating schema-version
// approach (`scripts/search-companion.mjs`) in spirit, not by importing it: same
// "CREATE IF NOT EXISTS + version bump" shape, different storage for the version
// cookie.
export const JOBS_SCHEMA_VERSION = 1;

// The `jobs` table per the WP-5 brief's item 1, plus two additions the brief itself
// calls for elsewhere in the same doc:
//   - `dedupe_key` (item 5: "store a dedupe_key TEXT column ... so this is one
//     lookup") — item 1's literal column list predates item 5's requirement.
//   - `lane_rank` / `priority_rank`, generated VIRTUAL columns rather than stored
//     data, taking item 1's offered option ("or computed rank columns if you rank
//     lanes/priorities numerically"). The CASE expressions are the exact rank maps
//     from `LANE_RANK` (`src/orchestration/lanes.ts:3-6`) and `PRIORITY_RANK`
//     (`src/orchestration/JobStore.ts:17-21`), copied as literals rather than
//     computed in JS so the claim-order index can use them directly — SQLite
//     generated columns are computed at read time, not stored, so keeping them in
//     sync with the TS rank maps only matters if a rank map ever changes, which is
//     already a call for a schema migration bump.
const CREATE_JOBS_TABLE = `
CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	status TEXT NOT NULL,
	lane TEXT,
	priority TEXT,
	created TEXT NOT NULL,
	params TEXT NOT NULL,
	error TEXT,
	failure_kind TEXT,
	defer_until INTEGER,
	progress TEXT,
	output_paths TEXT,
	partial INTEGER NOT NULL DEFAULT 0,
	notes TEXT NOT NULL DEFAULT '',
	claimed_at INTEGER,
	claim_token TEXT,
	settled_at INTEGER,
	dedupe_key TEXT,
	lane_rank INTEGER GENERATED ALWAYS AS (
		CASE lane WHEN 'user' THEN 0 WHEN 'background' THEN 1 ELSE 1 END
	) VIRTUAL,
	priority_rank INTEGER GENERATED ALWAYS AS (
		CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 1 END
	) VIRTUAL
)`;

// Claim-order index: `(status, lane, priority, created, id)` in the brief's own words,
// realized against the generated rank columns above so `ORDER BY` doesn't need a
// string-collation fallback for lane/priority. `(type, status)` backs
// `countByTypeAndStatus`/`hasActive`. `dedupe_key` gets its own index for
// `findActive` — nullable, so NULL keys (empty/falsy dedupe keys, per item 5) never
// collide in an index lookup; SQLite indexes treat every NULL as distinct from every
// other NULL, which is exactly "never collapse".
const CREATE_INDEXES = [
	'CREATE INDEX IF NOT EXISTS idx_jobs_claim_order ON jobs (status, lane_rank, priority_rank, created, id)',
	'CREATE INDEX IF NOT EXISTS idx_jobs_type_status ON jobs (type, status)',
	'CREATE INDEX IF NOT EXISTS idx_jobs_dedupe_key ON jobs (dedupe_key)',
];

function readSchemaVersion(db: SqliteDatabase): number {
	const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
	if (!row) return 0;
	const n = Number(row.value);
	return Number.isFinite(n) ? n : 0;
}

function writeSchemaVersion(db: SqliteDatabase, version: number): void {
	db.prepare(
		'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
	).run('schema_version', String(version));
}

/**
 * Self-migrating CREATE-IF-NOT-EXISTS + version-bump, run unconditionally by
 * `openJobsDb` on every open. Today there is exactly one version (1); the shape
 * (`if (current < N) { ...; writeSchemaVersion(db, N); }`) is what a future migration
 * appends to, matching the search companion's `createSchema`/migration-chain pattern
 * in spirit (`scripts/search-companion.mjs`).
 */
function migrate(db: SqliteDatabase): void {
	db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
	const current = readSchemaVersion(db);
	if (current < 1) {
		db.exec(CREATE_JOBS_TABLE);
		for (const sql of CREATE_INDEXES) db.exec(sql);
		writeSchemaVersion(db, 1);
	}
}

/**
 * Opens (creating if needed) the jobs database at `path` and runs the migration
 * chain. WAL mode is requested unconditionally; SQLite silently reports `memory`
 * instead of applying it for `:memory:` databases (verified — no error), which is
 * exactly the behavior the test suite relies on to open `:memory:` databases through
 * this same helper.
 */
export function openJobsDb(path: string): SqliteDatabase {
	const { DatabaseSync } = loadNodeSqlite();
	const db = new DatabaseSync(path);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA synchronous = NORMAL');
	migrate(db);
	return db;
}

interface PathJoiner { join(...parts: string[]): string; }
let cachedPath: PathJoiner | null = null;
function loadPath(): PathJoiner {
	if (cachedPath) return cachedPath;
	// eslint-disable-next-line @typescript-eslint/no-require-imports, import/no-nodejs-modules, no-undef
	cachedPath = require('path') as PathJoiner;
	return cachedPath;
}

/**
 * Resolves a plugin-data-relative path (e.g. `plugin.pluginDataPath('jobs.sqlite')`,
 * `src/main.ts:627-630`) to an absolute filesystem path node:sqlite can open —
 * `vault.adapter` cannot open a sqlite file itself, even when it's a
 * `FileSystemAdapter` (queue-db investigation, §Storage decision). Guarded the way
 * the repo guards other platform-specific filesystem code (`src/providers/cli.ts`'s
 * `createCliRunArtifacts`), except this path treats a missing `FileSystemAdapter` as
 * a hard error rather than a silent skip: unlike CLI run-artifact logging (an
 * optional nicety), the job queue has no other storage to fall back to on this
 * platform, so the same "no silent fallback" rule from the node:sqlite probe applies
 * here too. `path.join` (not string concatenation) so the OS-native separator is used
 * even though `relativeDataPath` is always forward-slash (vault paths are).
 */
export function resolveJobsDbPath(app: App, relativeDataPath: string): string {
	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) {
		throw new SqliteUnavailableError(
			'The Crucible job queue requires a filesystem-backed vault (desktop Obsidian) — ' +
			'this vault has no FileSystemAdapter.',
		);
	}
	const basePath = adapter.getBasePath();
	return loadPath().join(basePath, relativeDataPath);
}
