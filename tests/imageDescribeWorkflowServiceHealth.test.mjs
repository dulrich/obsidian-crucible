import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// idh-WP-2: the image-describe infra breaker (`describeMd5Images` in
// `src/orchestration/utils/imageDescribe.ts`) sets `abortReason`/`abortKind` when a
// connection-class error or 3 consecutive timeouts stop a batch early. This file asserts the
// workflow-level half of that fix: `ImageDescribeNoteWorkflow`/`ImageDescribeBatchWorkflow`
// surface an abort as `status: 'deferred'` + `serviceUnhealthy: { service:
// 'image-description-provider', ... }` — the same chokepoint `youtubeWorkflowServiceHealth.test.mjs`
// exercises for `youtube-api` — rather than a plain job-level `'failed'`, so the drain stops
// claiming further image_describe_* jobs while the provider is unhealthy and this job itself
// requeues with its original params. It also asserts `ImageDescribeBackfillWorkflow` prunes
// transient-class failed records at the start of every run.

const outdir = path.join(tmpdir(), 'obsidian-crucible-image-describe-workflow-service-health-tests');
const outfile = path.join(outdir, 'imageDescribeWorkflows.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { ImageDescribeNoteWorkflow, ImageDescribeBatchWorkflow, ImageDescribeBackfillWorkflow } from './src/orchestration/workflows/ImageDescribeWorkflow';",
			"export { TFile } from 'obsidian';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'image-describe-workflow-test-entry.ts',
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: `
					export class TFile {
						constructor(path) {
							this.path = path;
							this.name = path.split('/').pop();
							this.extension = this.name.includes('.') ? this.name.split('.').pop() : '';
						}
					}
					globalThis.__ObsTFile = TFile;
					export function normalizePath(p) {
						return String(p).replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\//, '').replace(/\\/$/, '');
					}
				`,
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { ImageDescribeNoteWorkflow, ImageDescribeBatchWorkflow, ImageDescribeBackfillWorkflow, TFile } = await import(pathToFileURL(outfile).href);

// ── test doubles ─────────────────────────────────────────────────────────────

function createFakeStore(seed = new Map()) {
	const pruneFailedCalls = [];
	return {
		map: seed,
		pruneFailedCalls,
		async ensureLoaded() {},
		has(md5) { return seed.has(md5); },
		async get(md5) { return seed.get(md5) ?? null; },
		async put(input) {
			const record = { ...input, describedAt: 'now', schemaVersion: 1, descriptionHash: `hash-${input.md5}` };
			seed.set(input.md5, record);
			return record;
		},
		async pruneDegenerate() { return []; },
		async pruneFailed(scope) {
			pruneFailedCalls.push(scope);
			const pruned = [];
			for (const [md5, record] of [...seed.entries()]) {
				if (record.kind !== 'failed') continue;
				if (scope === 'transient' && record.failureClass !== 'transient') continue;
				seed.delete(md5);
				pruned.push(md5);
			}
			return pruned;
		},
	};
}

// A provider manager whose describeImage rejects with `failureMessage` whenever `shouldFail`
// returns true — same technique as tests/imageDescribe.test.mjs's createFailingProviderManager.
function createFailingProviderManager(shouldFail, failureMessage) {
	return {
		async describeImage(_provider, _modelId, bytes, _mime, pass) {
			if (shouldFail(pass, bytes)) throw new Error(failureMessage);
			return `${pass}-description`;
		},
	};
}

const provider = { id: 'lmstudio-local', kind: 'openai-compatible', models: [{ id: 'm1', capabilities: ['image-extraction'] }] };

function baseSettings() {
	return {
		imageMetadataExtractionEnabled: true,
		imageMetadataExtractionModel: { providerId: 'p1', modelId: 'm1' },
		providers: [provider].map(p => ({ ...p, id: 'p1' })),
		searchEnabled: false,
	};
}

function makePlugin({ files = new Map(), storeSeed = new Map(), providerManager, resolvedLinks = {} } = {}) {
	const enqueued = [];
	return {
		settings: baseSettings(),
		imageDescriptions: createFakeStore(storeSeed),
		providerManager: providerManager ?? { async describeImage() { return 'ok'; } },
		noteLocks: { withResourceLock: (_kind, _id, _label, fn) => fn() },
		app: {
			vault: {
				getAbstractFileByPath: p => (files.has(p) ? new TFile(p) : null),
				readBinary: async file => files.get(file.path).bytes,
				read: async file => files.get(file.path).text,
				getFiles: () => [],
				getMarkdownFiles: () => [],
			},
			metadataCache: {
				getFileCache: () => ({}),
				getFirstLinkpathDest: () => null,
				resolvedLinks,
			},
			fileManager: { trashFile: async () => {} },
		},
		orchestrator: { enqueue: async (type, params, opts) => { enqueued.push({ type, params, opts }); return { id: 'job-x' }; } },
		enqueued,
		ingestionEvents: { emit: () => {} },
		searchManager: null,
	};
}

// WP-J1: both image-describe workflows now report progress per image via the seam
// (`onTiming` -> `ctx.reportProgress`), so a hand-built ctx that omits it throws the
// moment a describe outcome settles. `onProgress` defaults to a no-op; tests that care
// about the message shape pass a collector.
function makeCtx(plugin, onProgress = () => {}) {
	const signal = new AbortController().signal;
	return { plugin, signal, throwIfAborted: () => signal.throwIfAborted(), reportProgress: onProgress };
}

// ── ImageDescribeNoteWorkflow ─────────────────────────────────────────────────

test('ImageDescribeNoteWorkflow: a connection-class provider failure defers with serviceUnhealthy naming image-description-provider, not a plain job failure', async () => {
	const imgPath = 'attach/deadbeefdeadbeefdeadbeefdeadbeef_MD5.png';
	const noteFile = new TFile('notes/source.md');
	const files = new Map([[imgPath, { bytes: new Uint8Array([9, 9]).buffer }]]);
	const providerManager = createFailingProviderManager(() => true, 'net::ERR_CONNECTION_REFUSED');
	const plugin = makePlugin({ files, providerManager });
	plugin.app.vault.getAbstractFileByPath = p => (p === noteFile.path ? noteFile : (files.has(p) ? new TFile(p) : null));
	plugin.app.metadataCache.getFileCache = file => (file.path === noteFile.path ? { embeds: [{ link: 'img.png' }] } : {});
	plugin.app.metadataCache.getFirstLinkpathDest = () => new TFile(imgPath);

	const result = await new ImageDescribeNoteWorkflow().run(
		{ id: 'job-1', params: { targetPath: noteFile.path } },
		makeCtx(plugin),
	);

	assert.equal(result.status, 'deferred');
	assert.deepEqual(result.serviceUnhealthy, {
		service: 'image-description-provider',
		kind: 'refused',
		reason: result.error,
	});
	assert.match(result.error, /net::ERR_CONNECTION_REFUSED/);
	assert.ok(result.retryAfterMs > 0);
	// The triggering image never earns a skip-forever record.
	assert.equal(plugin.imageDescriptions.has('deadbeefdeadbeefdeadbeefdeadbeef'), false);
});

test('ImageDescribeNoteWorkflow: a normal successful describe stays status:\'done\', no serviceUnhealthy', async () => {
	const imgPath = 'attach/deadbeefdeadbeefdeadbeefdeadbeef_MD5.png';
	const noteFile = new TFile('notes/source.md');
	const files = new Map([[imgPath, { bytes: new Uint8Array([1, 2, 3]).buffer }]]);
	const plugin = makePlugin({ files });
	plugin.app.vault.getAbstractFileByPath = p => (p === noteFile.path ? noteFile : (files.has(p) ? new TFile(p) : null));
	plugin.app.metadataCache.getFileCache = file => (file.path === noteFile.path ? { embeds: [{ link: 'img.png' }] } : {});
	plugin.app.metadataCache.getFirstLinkpathDest = () => new TFile(imgPath);

	const messages = [];
	const result = await new ImageDescribeNoteWorkflow().run(
		{ id: 'job-2', params: { targetPath: noteFile.path } },
		makeCtx(plugin, m => messages.push(m)),
	);

	assert.equal(result.status, 'done');
	assert.equal(result.serviceUnhealthy, undefined);
	// Note-scoped jobs skip the "batch N / M:" prefix — no batchIndex/batchCount to name.
	assert.deepEqual(messages, ['1 / 1 images']);
});

// ── ImageDescribeBatchWorkflow ────────────────────────────────────────────────

test('ImageDescribeBatchWorkflow: 3 consecutive timeouts defer with serviceUnhealthy kind \'timeout\', and the resulting failed records ARE written', async () => {
	// localizedImageInfo requires a real 32-hex md5 in the filename — these are synthetic but
	// valid-shaped md5s, one distinguishing byteLength each so createFailingProviderManager can
	// target them individually (same technique as tests/imageDescribe.test.mjs).
	const md5s = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32), '4'.repeat(32)];
	const paths = md5s.map(md5 => `a/${md5}_MD5.png`);
	const files = new Map([
		[paths[0], { bytes: new Uint8Array([1]).buffer }],
		[paths[1], { bytes: new Uint8Array([1, 1]).buffer }],
		[paths[2], { bytes: new Uint8Array([1, 1, 1]).buffer }],
		[paths[3], { bytes: new Uint8Array([1, 1, 1, 1]).buffer }],
	]);
	const providerManager = createFailingProviderManager(() => true, 'image description (narrative pass) timed out after 120000ms');
	const plugin = makePlugin({ files, providerManager });

	const messages = [];
	const result = await new ImageDescribeBatchWorkflow().run(
		{ id: 'job-3', params: { paths, backfillId: 'run-1', batchIndex: 0, batchCount: 1 } },
		makeCtx(plugin, m => messages.push(m)),
	);

	assert.equal(result.status, 'deferred');
	assert.equal(result.serviceUnhealthy.service, 'image-description-provider');
	assert.equal(result.serviceUnhealthy.kind, 'timeout');
	assert.match(result.error, /3 consecutive image description timeouts/);
	assert.equal(plugin.imageDescriptions.has(md5s[0]), true, 'timeout failures are recorded — transient, will re-describe');
	assert.equal(plugin.imageDescriptions.has(md5s[3]), false, 'the 4th image was never attempted');
	// One reportProgress per attempted outcome (the aborted 4th image never fires
	// onTiming), each carrying the batch prefix from batchIndex/batchCount.
	assert.deepEqual(messages, [
		'batch 1 / 1: 1 / 4 images',
		'batch 1 / 1: 2 / 4 images',
		'batch 1 / 1: 3 / 4 images',
	]);
});

// ── ImageDescribeBackfillWorkflow ─────────────────────────────────────────────

test('ImageDescribeBackfillWorkflow: prunes transient-failed records at run start and reports the count in job notes', async () => {
	const storeSeed = new Map([
		['transient1', { md5: 'transient1', narrative: '', extraction: '', kind: 'failed', failureClass: 'transient', describedAt: 'x', schemaVersion: 1, descriptionHash: 'h' }],
		['permanent1', { md5: 'permanent1', narrative: '', extraction: '', kind: 'failed', failureClass: 'permanent', describedAt: 'x', schemaVersion: 1, descriptionHash: 'h' }],
	]);
	const plugin = makePlugin({ storeSeed });

	const result = await new ImageDescribeBackfillWorkflow().run(
		{ id: 'job-4', params: {} },
		makeCtx(plugin),
	);

	assert.equal(result.status, 'done');
	assert.deepEqual(plugin.imageDescriptions.pruneFailedCalls, ['transient']);
	assert.match(result.notes, /Pruned 1 transient-failed description\(s\) for re-describe/);
	assert.equal(plugin.imageDescriptions.has('transient1'), false);
	assert.equal(plugin.imageDescriptions.has('permanent1'), true, 'permanent-class failures are left alone by the backfill\'s automatic prune');
});
