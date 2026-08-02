import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// WP-I1: `enqueueEmbedMissing` / `confirmAndQueueImageDescribeBackfill` /
// `retryFailedImageDescriptions` (src/search/auditRun.ts) are extractions of the
// `search-embed-missing` / `search-describe-vault-images` / `search-retry-failed-image-descriptions`
// command bodies out of src/commands.ts — same shape as WP-H3's `enqueueSearchRepairs` extraction,
// see tests/searchAuditRunEnqueueRepairs.test.mjs. Bundles the real `src/search/auditRun.ts`, with
// `../confirmModal` and `../retryImageDescriptionsModal` swapped for controllable stubs (the
// modals themselves only import `obsidian`, which is stubbed at the boundary same as that file) so
// tests can drive confirm/decline and each retry choice deterministically.
const outdir = path.join(tmpdir(), 'obsidian-crucible-search-audit-run-action-helpers-tests');
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
			name: 'retry-modal-stub',
			setup(build) {
				build.onResolve({ filter: /retryImageDescriptionsModal$/ }, () => ({ path: 'retry-modal-stub', namespace: 'retry-stub' }));
				build.onLoad({ filter: /.*/, namespace: 'retry-stub' }, () => ({
					contents: [
						'globalThis.__retryModalCalls = globalThis.__retryModalCalls ?? [];',
						'export class RetryFailedImageDescriptionsModal {',
						'  constructor(app) { this.app = app; globalThis.__retryModalCalls.push(app); }',
						'  openAndAwait() {',
						'    return Promise.resolve(globalThis.__retryModalChoice);',
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
						'export class Notice {',
						'  constructor(message) {',
						'    globalThis.__noticeMessages = globalThis.__noticeMessages ?? [];',
						'    globalThis.__noticeMessages.push(message);',
						'  }',
						'  hide() {}',
						'  setMessage() {}',
						'}',
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

const {
	enqueueEmbedMissing,
	confirmAndQueueImageDescribeBackfill,
	retryFailedImageDescriptions,
} = await import(pathToFileURL(outfile).href);

function makePlugin(overrides = {}) {
	const enqueueCalls = [];
	const plugin = {
		app: {},
		settings: { destructiveConfirmGlobal: true },
		orchestrator: {
			enqueue: async (...args) => {
				enqueueCalls.push(args);
				return { created: new Date().toISOString() };
			},
		},
		imageDescriptions: {
			pruneFailed: async () => [],
		},
		...overrides,
	};
	return { plugin, enqueueCalls };
}

// --- enqueueEmbedMissing -----------------------------------------------------------------

test('enqueueEmbedMissing enqueues the exact search_embed_missing job (high priority, user lane)', async () => {
	const { plugin, enqueueCalls } = makePlugin();
	await enqueueEmbedMissing(plugin);
	assert.equal(enqueueCalls.length, 1);
	assert.deepEqual(enqueueCalls[0], ['search_embed_missing', {}, { priority: 'high', lane: 'user' }]);
});

// --- confirmAndQueueImageDescribeBackfill -------------------------------------------------

test('confirmAndQueueImageDescribeBackfill: declining the confirm modal enqueues nothing and returns false', async () => {
	const { plugin, enqueueCalls } = makePlugin();
	globalThis.__confirmModalResult = false;
	globalThis.__confirmModalCalls = [];

	const result = await confirmAndQueueImageDescribeBackfill(plugin);

	assert.equal(result, false);
	assert.equal(enqueueCalls.length, 0);
	assert.equal(globalThis.__confirmModalCalls.length, 1);
	assert.equal(globalThis.__confirmModalCalls[0].title, 'Describe every image referenced in the vault?');
	assert.equal(globalThis.__confirmModalCalls[0].confirmText, 'Queue backfill');
});

test('confirmAndQueueImageDescribeBackfill: confirming enqueues image_describe_backfill (low priority, background lane) and returns true', async () => {
	const { plugin, enqueueCalls } = makePlugin();
	globalThis.__confirmModalResult = true;
	globalThis.__confirmModalCalls = [];

	const result = await confirmAndQueueImageDescribeBackfill(plugin);

	assert.equal(result, true);
	assert.equal(enqueueCalls.length, 1);
	assert.deepEqual(enqueueCalls[0], ['image_describe_backfill', {}, { priority: 'low', lane: 'background' }]);
});

// --- retryFailedImageDescriptions ---------------------------------------------------------

test('retryFailedImageDescriptions: cancelling the modal prunes nothing, enqueues nothing, and returns false', async () => {
	const pruneCalls = [];
	const { plugin, enqueueCalls } = makePlugin({
		imageDescriptions: { pruneFailed: async (...args) => { pruneCalls.push(args); return []; } },
	});
	globalThis.__retryModalChoice = null;
	globalThis.__retryModalCalls = [];
	globalThis.__noticeMessages = [];

	const result = await retryFailedImageDescriptions(plugin);

	assert.equal(result, false);
	assert.equal(pruneCalls.length, 0);
	assert.equal(enqueueCalls.length, 0);
	assert.equal(globalThis.__noticeMessages.length, 0);
	assert.equal(globalThis.__retryModalCalls.length, 1, 'the modal must still be opened');
});

test('retryFailedImageDescriptions: choosing "transient" prunes transient, shows the Notice, and queues the backfill', async () => {
	const pruneCalls = [];
	const { plugin, enqueueCalls } = makePlugin({
		imageDescriptions: {
			pruneFailed: async (...args) => { pruneCalls.push(args); return ['md5-a', 'md5-b']; },
		},
	});
	globalThis.__retryModalChoice = 'transient';
	globalThis.__noticeMessages = [];

	const result = await retryFailedImageDescriptions(plugin);

	assert.equal(result, true);
	assert.deepEqual(pruneCalls, [['transient']]);
	assert.equal(globalThis.__noticeMessages.length, 1);
	assert.equal(globalThis.__noticeMessages[0], 'Cleared 2 failed image descriptions (transient); queuing re-describe backfill.');
	assert.equal(enqueueCalls.length, 1);
	assert.deepEqual(enqueueCalls[0], ['image_describe_backfill', {}, { priority: 'low', lane: 'background' }]);
});

test('retryFailedImageDescriptions: choosing "all" prunes all and singularizes the Notice for a single cleared record', async () => {
	const pruneCalls = [];
	const { plugin, enqueueCalls } = makePlugin({
		imageDescriptions: {
			pruneFailed: async (...args) => { pruneCalls.push(args); return ['md5-only']; },
		},
	});
	globalThis.__retryModalChoice = 'all';
	globalThis.__noticeMessages = [];

	const result = await retryFailedImageDescriptions(plugin);

	assert.equal(result, true);
	assert.deepEqual(pruneCalls, [['all']]);
	assert.equal(globalThis.__noticeMessages[0], 'Cleared 1 failed image description (all); queuing re-describe backfill.');
	assert.equal(enqueueCalls.length, 1);
});
