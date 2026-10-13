import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// link-registry-out-of-vault WP-1: the `link_records` table (jobs DB schema v2), the
// LinkRegistryStore merge/no-op-write contract, and the Orchestrator's ownership of
// the one shared connection (linkRegistry() over the queue's handle; dispose() closes
// it once, from onunload). Same bundle + obsidian-stub + :memory: technique as
// tests/orchestratorQuerySeam.test.mjs.

globalThis.require = createRequire(import.meta.url);

const outdir = path.join(tmpdir(), 'obsidian-crucible-link-registry-store-tests');
const outfile = path.join(outdir, 'linkRegistryStore.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { Orchestrator } from './src/orchestration/Orchestrator';",
			"export { SqliteJobStore } from './src/orchestration/db/SqliteJobStore';",
			"export { LinkRegistryStore } from './src/orchestration/db/LinkRegistryStore';",
			"export { openJobsDb, JOBS_SCHEMA_VERSION } from './src/orchestration/db/sqlite';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'link-registry-store-test-entry.ts',
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	external: ['node:sqlite'],
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: [
					'export class Notice {}',
					'export class TFile {}',
					'export class TFolder {}',
					'export class App {}',
					'export class Modal {}',
					'export class Setting {}',
					'export class FuzzySuggestModal {}',
					'export class FileSystemAdapter {}',
					'export function normalizePath(p) { return p; }',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
					'export const Platform = {};',
					'export const moment = () => {};',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { Orchestrator, SqliteJobStore, LinkRegistryStore, openJobsDb, JOBS_SCHEMA_VERSION } = await import(pathToFileURL(outfile).href);

/** Wraps a real :memory: handle and records every write statement that runs. */
function spyDb() {
	const db = openJobsDb(':memory:');
	const writes = [];
	return {
		writes,
		exec: sql => db.exec(sql),
		close: () => db.close(),
		prepare(sql) {
			const stmt = db.prepare(sql);
			return {
				run: (...args) => { writes.push(sql.trim().split(/\s+/)[0]); return stmt.run(...args); },
				get: (...args) => stmt.get(...args),
				all: (...args) => stmt.all(...args),
			};
		},
	};
}

const X = 'https://x.com/alice/status/1900000000000000001';

function input(overrides = {}) {
	return {
		canonicalUrl: X,
		url: `${X}?s=20`,
		domain: 'x.com',
		sourceNotes: ['[[clips/a]]'],
		firstSeen: '2026-10-10',
		lastSeen: '2026-10-10',
		state: 'pending',
		discoveryMethod: 'scan',
		trackedSource: false,
		trackedSourceType: null,
		ytVideoId: null,
		xStatusId: '1900000000000000001',
		...overrides,
	};
}

test('schema v2 creates link_records with an x_status_id index', () => {
	assert.equal(JOBS_SCHEMA_VERSION, 2);
	const db = openJobsDb(':memory:');
	const cols = db.prepare('PRAGMA table_info(link_records)').all().map(r => r.name);
	for (const c of ['canonical_url', 'url', 'domain', 'source_notes', 'first_seen', 'last_seen', 'state', 'discovery_method', 'tracked_source', 'tracked_source_type', 'tracked_source_note', 'referred_material', 'decision_reason', 'yt_video_id', 'x_status_id']) {
		assert.ok(cols.includes(c), `missing column ${c}`);
	}
	const idx = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'link_records'").all().map(r => r.name);
	assert.ok(idx.includes('idx_link_records_x_status_id'));
	assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '2');
});

test('create: a new record is inserted with defaults and reported created', () => {
	const store = new LinkRegistryStore(openJobsDb(':memory:'));
	const r = store.upsert(input());
	assert.deepEqual(r, { created: true, candidateFlagged: false, changed: true });
	const rec = store.get(X);
	assert.equal(rec.trackedSource, false);
	assert.equal(rec.state, 'pending');
	assert.deepEqual(rec.sourceNotes, ['[[clips/a]]']);
	assert.equal(store.listWithXStatus().length, 1);
	assert.equal(store.count(), 1);
});

test('merge: source notes union, earliest first_seen, latest last_seen (order-independent)', () => {
	const store = new LinkRegistryStore(openJobsDb(':memory:'));
	store.upsert(input({ firstSeen: '2026-10-05', lastSeen: '2026-10-05' }));
	const r = store.upsert(input({ sourceNotes: ['[[clips/b]]', '[[clips/a]]'], firstSeen: '2026-09-01', lastSeen: '2026-09-01' }));
	assert.equal(r.created, false);
	assert.equal(r.changed, true);
	const rec = store.get(X);
	assert.deepEqual(rec.sourceNotes, ['[[clips/a]]', '[[clips/b]]']);
	assert.equal(rec.firstSeen, '2026-09-01', 'an older incoming date wins first_seen');
	assert.equal(rec.lastSeen, '2026-10-05', 'an older incoming date never moves last_seen back');
	store.upsert(input({ firstSeen: '2026-10-12', lastSeen: '2026-10-12' }));
	assert.equal(store.get(X).firstSeen, '2026-09-01');
	assert.equal(store.get(X).lastSeen, '2026-10-12');
});

test('merge: tracked_source escalates only false -> candidate, never overwrites a decision', () => {
	const store = new LinkRegistryStore(openJobsDb(':memory:'));
	store.upsert(input());
	const flagged = store.upsert(input({ trackedSource: 'candidate', trackedSourceType: 'youtube-channel' }));
	assert.equal(flagged.candidateFlagged, true);
	assert.equal(store.get(X).trackedSource, 'candidate');
	assert.equal(store.get(X).trackedSourceType, 'youtube-channel');
	const again = store.upsert(input({ trackedSource: 'candidate', trackedSourceType: 'other' }));
	assert.equal(again.candidateFlagged, false, 'already a candidate: no re-flag');
	assert.equal(store.get(X).trackedSourceType, 'youtube-channel');
	const back = store.upsert(input({ trackedSource: false }));
	assert.equal(store.get(X).trackedSource, 'candidate', 'false never de-escalates');
	assert.equal(back.changed, false);
	const created = new LinkRegistryStore(openJobsDb(':memory:')).upsert(input({ trackedSource: 'candidate', trackedSourceType: 'youtube-channel' }));
	assert.deepEqual(created, { created: true, candidateFlagged: true, changed: true });
});

test('merge: yt/x ids only fill empty', () => {
	const store = new LinkRegistryStore(openJobsDb(':memory:'));
	store.upsert(input({ xStatusId: null }));
	assert.equal(store.listWithXStatus().length, 0);
	store.upsert(input({ xStatusId: '111', ytVideoId: 'vid00000001' }));
	store.upsert(input({ xStatusId: '222', ytVideoId: 'vid00000002' }));
	assert.equal(store.get(X).xStatusId, '111');
	assert.equal(store.get(X).ytVideoId, 'vid00000001');
});

test('an unchanged upsert performs no write (changed: false, no UPDATE, row identical)', () => {
	const db = spyDb();
	const store = new LinkRegistryStore(db);
	store.upsert(input());
	const before = store.get(X);
	db.writes.length = 0;
	const r = store.upsert(input());
	assert.deepEqual(r, { created: false, candidateFlagged: false, changed: false });
	assert.deepEqual(db.writes, [], 'no INSERT/UPDATE ran');
	assert.deepEqual(store.get(X), before);
	store.upsert(input({ sourceNotes: ['[[clips/c]]'] }));
	assert.deepEqual(db.writes, ['UPDATE']);
});

test('corrupt source_notes JSON degrades to [] instead of throwing', () => {
	const db = openJobsDb(':memory:');
	const store = new LinkRegistryStore(db);
	store.upsert(input());
	db.prepare('UPDATE link_records SET source_notes = ? WHERE canonical_url = ?').run('{not json', X);
	assert.deepEqual(store.get(X).sourceNotes, []);
});

function makePlugin() {
	return {
		settings: { orchestrationJobRetentionDays: 30, orchestrationJobTypeControls: {} },
		ingestionEvents: null,
		orchestrationAutoRunner: null,
		app: { vault: { getAbstractFileByPath: () => null }, workspace: { onLayoutReady: () => {} } },
	};
}

test('Orchestrator.linkRegistry() shares the queue handle; dispose() closes it exactly once and blocks reopen', () => {
	let opened = 0;
	let closed = 0;
	const raw = openJobsDb(':memory:');
	const handle = { exec: s => raw.exec(s), prepare: s => raw.prepare(s), close: () => { closed++; raw.close(); } };
	const orch = new Orchestrator(makePlugin(), { openDbStore: () => { opened++; return new SqliteJobStore(handle); } });
	const reg = orch.linkRegistry();
	assert.ok(reg instanceof LinkRegistryStore);
	assert.equal(orch.linkRegistry(), reg, 'built once');
	orch.register('command_run', { run: async () => ({ status: 'done' }) }, { persistence: 'db', minIntervalMs: 0, maxParallel: 1 });
	assert.equal(opened, 1, 'one connection for queue + registry');
	orch.dispose();
	orch.dispose();
	assert.equal(closed, 1);
	assert.throws(() => orch.linkRegistry(), /closed/);
	assert.equal(opened, 1, 'never reopened after dispose');
});

test('Orchestrator.linkRegistry() rethrows when the DB cannot open (no fallback)', () => {
	const orch = new Orchestrator(makePlugin(), { openDbStore: () => { throw new Error('node:sqlite missing'); } });
	assert.throws(() => orch.linkRegistry(), /node:sqlite missing/);
});

test('STRUCTURAL: onunload disposes the orchestrator DB after the drain loop', () => {
	const mainSrc = readFileSync('src/main.ts', 'utf8');
	const body = mainSrc.match(/onunload\(\) \{([\s\S]*?)\n\t\}/)?.[1] ?? '';
	const runner = body.indexOf('this.orchestrationAutoRunner?.dispose();');
	const orch = body.indexOf('this.orchestrator?.dispose();');
	assert.ok(runner >= 0 && orch > runner, 'orchestrator?.dispose() must follow the auto-runner dispose in onunload');
});
