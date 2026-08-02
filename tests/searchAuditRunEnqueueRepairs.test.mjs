import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// WP-H3: `enqueueSearchRepairs` (src/search/auditRun.ts) is the extraction of
// `search-reconcile-index`'s inline enqueue body — dedupe-honest accounting via the
// `job.created >= startedAt` discriminator, and the orphan `confirmDestructive('search-reconcile-orphans')`
// gate living inside the helper. Bundles the real `src/search/auditRun.ts` (not a copy), the same
// pattern `tests/searchRebuildIndexConfirm.test.mjs` uses for `src/commands.ts`: `./confirmModal`
// (imported as `../confirmModal` from `src/settings/destructiveActions.ts`) is swapped for a
// controllable stub, `obsidian` is stubbed at the boundary, and every other dependency
// (`src/settings/destructiveActions.ts`, `src/search/audit.ts`) is the real module.
const outdir = path.join(tmpdir(), 'obsidian-crucible-search-audit-run-enqueue-repairs-tests');
const outfile = path.join(outdir, 'auditRun.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/search/auditRun.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [
		{
			name: 'confirm-modal-stub',
			setup(build) {
				build.onResolve({ filter: /confirmModal$/ }, () => ({ path: 'confirm-modal-stub', namespace: 'confirm-stub' }));
				build.onLoad({ filter: /.*/, namespace: 'confirm-stub' }, () => ({
					contents: [
						'globalThis.__confirmModalCalls = globalThis.__confirmModalCalls ?? [];',
						'export class ConfirmModal {',
						'  constructor(app, options) { this.app = app; this.options = options; }',
						'  openAndAwait() {',
						'    globalThis.__confirmModalCalls.push(this.options);',
						'    return Promise.resolve(globalThis.__confirmModalResult);',
						'  }',
						'}',
					].join('\n'),
					loader: 'js',
				}));
			},
		},
		{
			name: 'obsidian-test-stub',
			setup(build) {
				build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
				build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
					contents: [
						'export class App {}',
						'export class Modal { constructor() {} open() {} close() {} }',
						'export class Notice { constructor() {} hide() {} setMessage() {} }',
						'export class Plugin {}',
						'export class TFile {}',
						'export class TFolder {}',
						'export class TAbstractFile {}',
						'export function prepareFuzzySearch() { return () => null; }',
						'export function renderResults() {}',
						'export function debounce(fn) { return fn; }',
						'export function setIcon() {}',
						'export function normalizePath(p) { return String(p).replace(/\\\\+/g, "/"); }',
						'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
						'export function htmlToMarkdown() { return ""; }',
						'export function parseYaml() { return {}; }',
						'export function getAllTags() { return []; }',
						'export const Platform = { isDesktopApp: true, isMobileApp: false };',
						'export const moment = Object.assign(() => ({ format: () => "" }), { format: () => "" });',
					].join('\n'),
					loader: 'js',
				}));
			},
		},
	],
	outfile,
	logLevel: 'silent',
});

const { enqueueSearchRepairs } = await import(pathToFileURL(outfile).href);

function makePlugin(enqueueImpl) {
	const enqueueCalls = [];
	const plugin = {
		app: {},
		settings: { destructiveConfirmGlobal: true },
		orchestrator: {
			enqueue: async (...args) => {
				enqueueCalls.push(args);
				return enqueueImpl(...args);
			},
		},
	};
	return { plugin, enqueueCalls };
}

test('dedupe accounting: a newly minted job (created >= startedAt) counts separately from an already-queued job', async () => {
	let call = 0;
	const { plugin } = makePlugin(() => {
		call++;
		// First path's enqueue call hits a dedupe (pre-existing job, created well in the past);
		// second path's enqueue call mints fresh (created well in the future relative to `now`).
		return call === 1
			? { created: '2000-01-01T00:00:00.000Z' }
			: { created: '2999-01-01T00:00:00.000Z' };
	});

	const outcome = await enqueueSearchRepairs(plugin, { upsertPaths: ['a.md', 'b.md'], orphanPaths: [] });

	assert.deepEqual(outcome.upserts, { newCount: 1, dedupedCount: 1 });
	assert.deepEqual(outcome.deletes, { newCount: 0, dedupedCount: 0 });
	assert.equal(outcome.orphansDeclined, false);
});

test('a null enqueue result (registration failure) is skipped, not miscounted', async () => {
	const { plugin } = makePlugin(() => null);
	const outcome = await enqueueSearchRepairs(plugin, { upsertPaths: ['a.md'], orphanPaths: [] });
	assert.deepEqual(outcome.upserts, { newCount: 0, dedupedCount: 0 });
});

test('upsert-only targets never show the orphan confirm gate', async () => {
	const { plugin } = makePlugin(() => ({ created: new Date().toISOString() }));
	globalThis.__confirmModalCalls = [];
	await enqueueSearchRepairs(plugin, { upsertPaths: ['a.md'], orphanPaths: [] });
	assert.equal(globalThis.__confirmModalCalls.length, 0, 'no orphans means no destructive confirm');
});

test('declining the orphan confirm gate enqueues zero search_delete_path jobs and reports orphansDeclined', async () => {
	const { plugin, enqueueCalls } = makePlugin(() => ({ created: new Date().toISOString() }));
	globalThis.__confirmModalResult = false;
	globalThis.__confirmModalCalls = [];

	const outcome = await enqueueSearchRepairs(plugin, { upsertPaths: [], orphanPaths: ['orphan-a.md', 'orphan-b.md'] });

	const deleteCalls = enqueueCalls.filter(([type]) => type === 'search_delete_path');
	assert.equal(deleteCalls.length, 0);
	assert.deepEqual(outcome.deletes, { newCount: 0, dedupedCount: 0 });
	assert.equal(outcome.orphansDeclined, true);
	assert.equal(globalThis.__confirmModalCalls.length, 1, 'the confirm modal must be shown exactly once');
});

test('confirming the orphan gate enqueues search_delete_path for every orphan path with the documented params', async () => {
	const { plugin, enqueueCalls } = makePlugin(() => ({ created: '2999-01-01T00:00:00.000Z' }));
	globalThis.__confirmModalResult = true;
	globalThis.__confirmModalCalls = [];

	const outcome = await enqueueSearchRepairs(plugin, { upsertPaths: [], orphanPaths: ['orphan-a.md'] });

	const deleteCalls = enqueueCalls.filter(([type]) => type === 'search_delete_path');
	assert.equal(deleteCalls.length, 1);
	assert.deepEqual(deleteCalls[0], ['search_delete_path', { path: 'orphan-a.md' }, { priority: 'low', lane: 'user' }]);
	assert.deepEqual(outcome.deletes, { newCount: 1, dedupedCount: 0 });
	assert.equal(outcome.orphansDeclined, false);
});

test('upsert jobs carry the documented search_upsert_file params, including inputPaths', async () => {
	const { plugin, enqueueCalls } = makePlugin(() => ({ created: '2999-01-01T00:00:00.000Z' }));
	await enqueueSearchRepairs(plugin, { upsertPaths: ['missing.md'], orphanPaths: [] });
	const upsertCalls = enqueueCalls.filter(([type]) => type === 'search_upsert_file');
	assert.equal(upsertCalls.length, 1);
	assert.deepEqual(upsertCalls[0], [
		'search_upsert_file',
		{ path: 'missing.md' },
		{ priority: 'low', lane: 'user', inputPaths: ['missing.md'] },
	]);
});
