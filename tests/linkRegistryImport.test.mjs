import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// link-registry-out-of-vault WP-2: the legacy note-per-URL registry importer and the
// reconciliation check (read-only against the vault; frontmatter via metadataCache).

globalThis.require = createRequire(import.meta.url);

const outdir = path.join(tmpdir(), 'obsidian-crucible-link-registry-import-tests');
const outfile = path.join(outdir, 'linkRegistryImport.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { LinkRegistryStore } from './src/orchestration/db/LinkRegistryStore';",
			"export { openJobsDb } from './src/orchestration/db/sqlite';",
			"export { importLegacyLinkRegistry, reconcileLegacyLinkRegistry } from './src/orchestration/utils/linkRegistryImport';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'link-registry-import-test-entry.ts',
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

const { LinkRegistryStore, openJobsDb, importLegacyLinkRegistry, reconcileLegacyLinkRegistry } = await import(pathToFileURL(outfile).href);

const ROOT = '_crucible/link_registry';
const X = 'https://x.com/alice/status/1900000000000000001';

function fakeApp(files) {
	return {
		vault: { getMarkdownFiles: () => Object.keys(files).map(path => ({ path })) },
		metadataCache: { getFileCache: f => (files[f.path] === undefined ? null : { frontmatter: files[f.path] }) },
	};
}

function stub(over = {}) {
	return {
		type: 'link-record',
		canonical_url: 'https://example.com/a',
		url: 'https://example.com/a?utm=1',
		domain: 'example.com',
		source_notes: ['[[clips/one]]'],
		first_seen: '2026-01-05',
		last_seen: '2026-02-01',
		state: 'triaged',
		discovery_method: 'enrich',
		tracked_source: 'candidate',
		tracked_source_type: 'blog',
		tracked_source_note: '[[Blogs]]',
		referred_material: 'post',
		decision_reason: 'why',
		'yt-video-id': 'abcdefghijk',
		...over,
	};
}

test('import maps every field and skips non-records with path + reason', () => {
	const store = new LinkRegistryStore(openJobsDb(':memory:'));
	const app = fakeApp({
		[`${ROOT}/a.md`]: stub(),
		[`${ROOT}/nofm.md`]: undefined,
		[`${ROOT}/other.md`]: { type: 'note' },
		[`${ROOT}/nourl.md`]: { type: 'link-record', canonical_url: '' },
		'elsewhere/x.md': stub({ canonical_url: 'https://outside.com' }),
	});
	const r = importLegacyLinkRegistry(app, store, ROOT);
	assert.equal(r.scanned, 4);
	assert.equal(r.imported, 1);
	assert.deepEqual(r.skipped.map(s => s.path).sort(), [`${ROOT}/nofm.md`, `${ROOT}/nourl.md`, `${ROOT}/other.md`]);
	assert.ok(r.skipped.every(s => s.reason));
	const rec = store.get('https://example.com/a');
	assert.deepEqual(rec, {
		canonicalUrl: 'https://example.com/a', url: 'https://example.com/a?utm=1', domain: 'example.com',
		sourceNotes: ['[[clips/one]]'], firstSeen: '2026-01-05', lastSeen: '2026-02-01', state: 'triaged',
		discoveryMethod: 'enrich', trackedSource: 'candidate', trackedSourceType: 'blog', trackedSourceNote: '[[Blogs]]',
		referredMaterial: 'post', decisionReason: 'why', ytVideoId: 'abcdefghijk', xStatusId: null,
	});
	assert.equal(store.get('https://outside.com'), null);
});

test('x-status-id is derived from canonical_url when absent; legacy string source_notes tolerated', () => {
	const store = new LinkRegistryStore(openJobsDb(':memory:'));
	importLegacyLinkRegistry(fakeApp({ [`${ROOT}/x.md`]: stub({ canonical_url: X, url: undefined, source_notes: '[[clips/s]]', 'yt-video-id': undefined }) }), store, ROOT);
	const rec = store.get(X);
	assert.equal(rec.xStatusId, '1900000000000000001');
	assert.equal(rec.url, X);
	assert.deepEqual(rec.sourceNotes, ['[[clips/s]]']);
});

test('duplicate canonical stubs merge; second run is idempotent; one coalesced emit per run', () => {
	const store = new LinkRegistryStore(openJobsDb(':memory:'));
	const app = fakeApp({
		[`${ROOT}/a1.md`]: stub({ first_seen: '2026-01-05', last_seen: '2026-01-10', source_notes: ['[[n/1]]'] }),
		[`${ROOT}/a2.md`]: stub({ first_seen: '2025-12-01', last_seen: '2026-03-01', source_notes: ['[[n/2]]'] }),
		[`${ROOT}/b.md`]: stub({ canonical_url: 'https://example.com/b' }),
	});
	const emits = [];
	const r1 = importLegacyLinkRegistry(app, store, ROOT, n => emits.push(n));
	assert.deepEqual([r1.imported, r1.merged, r1.unchanged], [2, 1, 0]);
	assert.deepEqual(emits, [3]);
	const rec = store.get('https://example.com/a');
	assert.equal(rec.firstSeen, '2025-12-01');
	assert.equal(rec.lastSeen, '2026-03-01');
	assert.deepEqual(rec.sourceNotes, ['[[n/1]]', '[[n/2]]']);
	const r2 = importLegacyLinkRegistry(app, store, ROOT, n => emits.push(n));
	assert.deepEqual([r2.imported, r2.merged, r2.unchanged], [0, 0, 3]);
	assert.deepEqual(emits, [3, 0]);
});

test('import rolls back as one transaction when an upsert throws', () => {
	const store = new LinkRegistryStore(openJobsDb(':memory:'));
	const app = fakeApp({ [`${ROOT}/a.md`]: stub(), [`${ROOT}/b.md`]: stub({ canonical_url: 'https://example.com/b' }) });
	const real = store.upsert.bind(store);
	let n = 0;
	store.upsert = input => { if (++n === 2) throw new Error('boom'); return real(input); };
	assert.throws(() => importLegacyLinkRegistry(app, store, ROOT), /boom/);
	assert.equal(store.count(), 0);
});

test('reconcile: matched, mismatched with reasons, and post-cut-over rows', () => {
	const store = new LinkRegistryStore(openJobsDb(':memory:'));
	const files = {
		[`${ROOT}/a.md`]: stub(),
		[`${ROOT}/x.md`]: stub({ canonical_url: X }),
		[`${ROOT}/junk.md`]: { type: 'note' },
	};
	importLegacyLinkRegistry(fakeApp(files), store, ROOT);
	store.upsert({ canonicalUrl: 'https://new.example/post', url: 'https://new.example/post' });
	let r = reconcileLegacyLinkRegistry(fakeApp(files), store, ROOT);
	assert.equal(r.matched, 2);
	assert.deepEqual(r.mismatched, []);
	assert.equal(r.skipped.length, 1);
	assert.equal(r.postCutover, 1);

	files[`${ROOT}/a.md`] = stub({ source_notes: ['[[clips/one]]', '[[clips/extra]]'], first_seen: '2025-01-01', last_seen: '2027-01-01' });
	files[`${ROOT}/missing.md`] = stub({ canonical_url: 'https://example.com/missing' });
	r = reconcileLegacyLinkRegistry(fakeApp(files), store, ROOT);
	assert.equal(r.matched, 1);
	const byPath = Object.fromEntries(r.mismatched.map(m => [m.path, m.reasons]));
	assert.equal(byPath[`${ROOT}/a.md`].length, 3);
	assert.deepEqual(byPath[`${ROOT}/missing.md`], ['no store row']);
});

test('structural: both legacy registry commands are registered', () => {
	const src = readFileSync('src/commands.ts', 'utf8');
	assert.match(src, /id: 'orchestrator-import-legacy-link-registry'/);
	assert.match(src, /id: 'orchestrator-reconcile-legacy-link-registry'/);
	assert.match(src, /lastLinkRegistryImport = result/);
	assert.match(src, /lastLinkRegistryReconcile = result/);
});
