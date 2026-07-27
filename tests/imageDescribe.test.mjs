import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-image-describe-tests');
const outfile = path.join(outdir, 'imageDescribe.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// imageDescribe.ts's only real 'obsidian' dependency (transitively, via imageMetadata.ts) is
// TFile + normalizePath. CruciblePlugin (main.ts) is imported type-only and is erased; the
// runtime `plugin` argument is a plain fake object shaped to what this module actually calls.
await esbuild.build({
	entryPoints: ['src/orchestration/utils/imageDescribe.ts'],
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
					export function normalizePath(path) {
						return String(path).replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\//, '').replace(/\\/$/, '');
					}
				`,
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	computeReferencedImagePaths,
	describeMd5Images,
	importLegacyImageMetadataSidecars,
	referencingNotePaths,
	resolveNoteImages,
	shouldEnqueueImageDescribe,
	withTimeout,
} = await import(pathToFileURL(outfile).href);

const TFile = globalThis.__ObsTFile;

// ── test doubles ─────────────────────────────────────────────────────────────

// A real per-key FIFO mutex (promise-chained), not just a call recorder — this is what makes
// the "two concurrent calls, one model invocation" test actually exercise serialization instead
// of asserting a mock was configured correctly.
function createFakeNoteLocks() {
	const chains = new Map();
	const calls = [];
	return {
		calls,
		withResourceLock(kind, id, label, action) {
			calls.push({ kind, id, label });
			const key = `${kind}::${id}`;
			const prev = chains.get(key) ?? Promise.resolve();
			const run = prev.then(action, action);
			chains.set(key, run.then(() => {}, () => {}));
			return run;
		},
	};
}

function createFakeStore(seed = new Map()) {
	return {
		map: seed,
		async ensureLoaded() {},
		has(md5) { return seed.has(md5); },
		async get(md5) { return seed.get(md5) ?? null; },
		async put(input) {
			const record = { ...input, describedAt: 'now', schemaVersion: 1, descriptionHash: `hash-${input.md5}` };
			seed.set(input.md5, record);
			return record;
		},
	};
}

function createFakeProviderManager() {
	const calls = [];
	return {
		calls,
		async describeImage(provider, modelId, bytes, mime, pass) {
			calls.push({ providerId: provider.id, modelId, mime, pass, byteLength: bytes.byteLength });
			return `${pass}-description`;
		},
	};
}

// idh-WP-1: a provider manager whose describeImage rejects whenever `shouldFail(pass, bytes)`
// returns true — used to drive per-image failure isolation without waiting on a real
// `IMAGE_DESCRIBE_PASS_TIMEOUT_MS` timer (a provider throw and a `withTimeout` rejection are
// indistinguishable to `describeOneImage`'s catch, so this exercises the same code path).
function createFailingProviderManager(shouldFail, failureMessage = 'model exploded') {
	const calls = [];
	return {
		calls,
		async describeImage(provider, modelId, bytes, mime, pass) {
			calls.push({ providerId: provider.id, modelId, mime, pass, byteLength: bytes.byteLength });
			if (shouldFail(pass, bytes)) throw new Error(failureMessage);
			return `${pass}-description`;
		},
	};
}

function createFakePlugin({ files = new Map(), storeSeed = new Map(), providerManager = createFakeProviderManager() } = {}) {
	const noteLocks = createFakeNoteLocks();
	const imageDescriptions = createFakeStore(storeSeed);
	const vault = {
		getAbstractFileByPath(p) { return files.has(p) ? new TFile(p) : null; },
		async readBinary(file) { return files.get(file.path).bytes; },
		async read(file) { return files.get(file.path).text; },
	};
	return { app: { vault }, imageDescriptions, noteLocks, providerManager };
}

const provider = { id: 'lmstudio-local', kind: 'openai-compatible', models: [] };

// ── describeMd5Images: SVG path ─────────────────────────────────────────────

test('describeMd5Images: SVG images are extracted as text and never reach the provider', async () => {
	const files = new Map([
		['a/deadbeefdeadbeefdeadbeefdeadbeef_MD5.svg', { text: '<svg><title>Q1 revenue</title><text>42%</text></svg>' }],
	]);
	const plugin = createFakePlugin({ files });
	const image = { path: 'a/deadbeefdeadbeefdeadbeefdeadbeef_MD5.svg', md5: 'deadbeefdeadbeefdeadbeefdeadbeef', ext: 'svg' };

	const result = await describeMd5Images(plugin, provider, 'model-1', [image]);

	assert.equal(result.describedCount, 1);
	assert.equal(plugin.providerManager.calls.length, 0, 'no model call for an SVG');
	const record = plugin.imageDescriptions.map.get(image.md5);
	assert.equal(record.kind, 'svg-text');
	// SVG text lives in `extraction` (the `Image: <name> (text)` chunk), never `narrative` —
	// the WP-2 chunker contract for svg-text records.
	assert.match(record.extraction, /Q1 revenue/);
	assert.match(record.extraction, /42%/);
	assert.equal(record.narrative, '');
});

// ── describeMd5Images: skip-if-described ────────────────────────────────────

test('describeMd5Images: an already-described md5 is skipped before any vault read or model call', async () => {
	const storeSeed = new Map([['abc', { md5: 'abc', narrative: 'x', extraction: 'y', kind: 'vision', describedAt: 'then', schemaVersion: 1, descriptionHash: 'h' }]]);
	const plugin = createFakePlugin({ files: new Map(), storeSeed });
	// No vault entry for this path at all — if the skip check didn't fire first, resolving the
	// file would return null and this would count as 'missing', not 'skipped'.
	const image = { path: 'nowhere/abc_MD5.png', md5: 'abc', ext: 'png' };

	const result = await describeMd5Images(plugin, provider, 'model-1', [image]);

	assert.deepEqual(result, { describedCount: 0, skippedCount: 1, missingCount: 0, failedCount: 0 });
	assert.equal(plugin.providerManager.calls.length, 0);
});

// ── describeMd5Images: resource-lock serialization ──────────────────────────

test('describeMd5Images: two concurrent calls describing the same md5 serialize under image::<md5> and the second finds it already described', async () => {
	const bytes = new Uint8Array([1, 2, 3]).buffer;
	const files = new Map([['shared/dup_MD5.png', { bytes }]]);
	const plugin = createFakePlugin({ files });
	const image = { path: 'shared/dup_MD5.png', md5: 'dup', ext: 'png' };

	const [resultA, resultB] = await Promise.all([
		describeMd5Images(plugin, provider, 'model-1', [image]),
		describeMd5Images(plugin, provider, 'model-1', [image]),
	]);

	// Exactly one pass through the model (narrative + extraction = 2 calls), never two full
	// passes (4 calls) — the second caller's resource-lock acquisition only proceeds after the
	// first has already put() the record.
	assert.equal(plugin.providerManager.calls.length, 2);
	assert.deepEqual(plugin.providerManager.calls.map(c => c.pass), ['narrative', 'extraction']);
	const outcomes = [resultA, resultB].map(r => (r.describedCount === 1 ? 'described' : 'skipped')).sort();
	assert.deepEqual(outcomes, ['described', 'skipped']);
	assert.ok(plugin.noteLocks.calls.every(c => c.kind === 'image' && c.id === 'dup'));
});

test('describeMd5Images: a missing vault file is counted as missing, not described or skipped', async () => {
	const plugin = createFakePlugin({ files: new Map() });
	const image = { path: 'gone/abc_MD5.png', md5: 'gone-md5', ext: 'png' };

	const result = await describeMd5Images(plugin, provider, 'model-1', [image]);

	assert.deepEqual(result, { describedCount: 0, skippedCount: 0, missingCount: 1, failedCount: 0 });
	assert.equal(plugin.providerManager.calls.length, 0);
});

// ── describeMd5Images: WebP/AVIF transcode wiring ───────────────────────────

test('describeMd5Images: a WebP image is transcoded to PNG before the provider ever sees it', async (t) => {
	const originalCreateImageBitmap = globalThis.createImageBitmap;
	const originalOffscreenCanvas = globalThis.OffscreenCanvas;
	t.after(() => {
		globalThis.createImageBitmap = originalCreateImageBitmap;
		globalThis.OffscreenCanvas = originalOffscreenCanvas;
	});
	globalThis.createImageBitmap = async () => ({ width: 2, height: 2 });
	const transcodedBytes = new Uint8Array([9, 9, 9]);
	globalThis.OffscreenCanvas = class {
		constructor(width, height) { this.width = width; this.height = height; }
		getContext() { return { drawImage() {} }; }
		async convertToBlob({ type }) { return new Blob([transcodedBytes], { type }); }
	};

	const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
	const files = new Map([['a/webp_MD5.webp', { bytes }]]);
	const plugin = createFakePlugin({ files });
	const image = { path: 'a/webp_MD5.webp', md5: 'webp-md5', ext: 'webp' };

	const result = await describeMd5Images(plugin, provider, 'model-1', [image]);

	assert.equal(result.describedCount, 1);
	assert.equal(plugin.providerManager.calls.length, 2);
	for (const call of plugin.providerManager.calls) {
		assert.equal(call.mime, 'image/png');
		assert.equal(call.byteLength, transcodedBytes.byteLength);
	}
});

// ── describeMd5Images: cancellation checkpoint ──────────────────────────────

test('describeMd5Images: an already-aborted signal stops before the first image is touched', async () => {
	const plugin = createFakePlugin({ files: new Map() });
	const controller = new AbortController();
	controller.abort(new Error('cancelled'));
	const image = { path: 'never/read_MD5.png', md5: 'never', ext: 'png' };

	await assert.rejects(() => describeMd5Images(plugin, provider, 'model-1', [image], { signal: controller.signal }));
	assert.equal(plugin.providerManager.calls.length, 0);
});

// ── withTimeout ──────────────────────────────────────────────────────────────

test('withTimeout: rejects with a labeled message once ms elapses, without waiting on the original promise', async () => {
	const start = Date.now();
	let lateSettled = false;
	const neverInTime = new Promise(resolve => setTimeout(() => { lateSettled = true; resolve('too late'); }, 100));

	await assert.rejects(
		() => withTimeout(neverInTime, 20, 'slow op'),
		(err) => {
			assert.match(err.message, /slow op timed out after 20ms/);
			return true;
		},
	);
	assert.ok(Date.now() - start < 100, 'rejects at the timeout, not when the original promise eventually settles');
	assert.equal(lateSettled, false, 'the original promise has not resolved yet at the moment withTimeout rejects');

	// Let the original promise settle in the background. If withTimeout failed to attach a
	// handler to it, this would surface as an unhandled promise rejection / fail the test file —
	// there is nothing else to assert here except that the process stays healthy.
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.equal(lateSettled, true);
});

test('withTimeout: resolves normally when the promise settles before ms elapses', async () => {
	const fast = new Promise(resolve => setTimeout(() => resolve('done'), 5));
	assert.equal(await withTimeout(fast, 1000, 'fast op'), 'done');
});

test('withTimeout: propagates the original promise\'s rejection when it rejects before ms elapses', async () => {
	const fails = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('boom')), 5));
	await assert.rejects(() => withTimeout(fails, 1000, 'fast op'), /boom/);
});

// ── describeMd5Images: per-image failure isolation ──────────────────────────

test('describeMd5Images: a provider failure on one image writes a kind:\'failed\' record and the loop continues to describe the next image', async () => {
	const poisonBytes = new Uint8Array([9, 9]).buffer; // byteLength 2, distinguishes from the healthy image below
	const okBytes = new Uint8Array([1, 2, 3]).buffer; // byteLength 3
	const files = new Map([
		['a/poison_MD5.png', { bytes: poisonBytes }],
		['a/ok_MD5.png', { bytes: okBytes }],
	]);
	const providerManager = createFailingProviderManager((pass, bytes) => bytes.byteLength === 2, 'model exploded on this image');
	const plugin = createFakePlugin({ files, providerManager });
	const images = [
		{ path: 'a/poison_MD5.png', md5: 'poison', ext: 'png' },
		{ path: 'a/ok_MD5.png', md5: 'ok', ext: 'png' },
	];

	const result = await describeMd5Images(plugin, provider, 'model-1', images);

	// The loop isolated the poison image and still described the healthy one — a failed file job
	// mid-batch never propagates and aborts the remaining images (`FileJobBackend.ts`: failed jobs
	// move to `failed/` and are never retried, which is exactly why this isolation is required).
	assert.deepEqual(result, { describedCount: 1, skippedCount: 0, missingCount: 0, failedCount: 1 });

	const failedRecord = plugin.imageDescriptions.map.get('poison');
	assert.equal(failedRecord.kind, 'failed');
	assert.equal(failedRecord.narrative, '');
	assert.equal(failedRecord.extraction, '');
	assert.match(failedRecord.failure, /model exploded on this image/);

	const okRecord = plugin.imageDescriptions.map.get('ok');
	assert.equal(okRecord.kind, 'vision');

	// The skip-if-has check keeps skipping a failed record on a later run — has() is true, no
	// special case needed.
	assert.equal(plugin.imageDescriptions.has('poison'), true);
});

test('describeMd5Images: a transcode failure also writes a kind:\'failed\' record rather than throwing out of the loop', async (t) => {
	const originalOffscreenCanvas = globalThis.OffscreenCanvas;
	const originalCreateImageBitmap = globalThis.createImageBitmap;
	t.after(() => {
		globalThis.OffscreenCanvas = originalOffscreenCanvas;
		globalThis.createImageBitmap = originalCreateImageBitmap;
	});
	globalThis.createImageBitmap = async () => ({ width: 2, height: 2 });
	globalThis.OffscreenCanvas = class {
		getContext() { return { drawImage() {} }; }
		async convertToBlob() { throw new Error('canvas exploded'); }
	};

	const bytes = new Uint8Array([1, 2, 3, 4]).buffer;
	const files = new Map([['a/badwebp_MD5.webp', { bytes }]]);
	const plugin = createFakePlugin({ files });
	const image = { path: 'a/badwebp_MD5.webp', md5: 'bad-webp', ext: 'webp' };

	const result = await describeMd5Images(plugin, provider, 'model-1', [image]);

	assert.deepEqual(result, { describedCount: 0, skippedCount: 0, missingCount: 0, failedCount: 1 });
	assert.equal(plugin.providerManager.calls.length, 0, 'the provider is never reached once transcode fails');
	const record = plugin.imageDescriptions.map.get('bad-webp');
	assert.equal(record.kind, 'failed');
	assert.match(record.failure, /canvas exploded/);
});

test('describeMd5Images: a long failure message is truncated in the stored record', async () => {
	const bytes = new Uint8Array([1, 2]).buffer;
	const files = new Map([['a/verbose_MD5.png', { bytes }]]);
	const longMessage = 'x'.repeat(2000);
	const providerManager = createFailingProviderManager(() => true, longMessage);
	const plugin = createFakePlugin({ files, providerManager });
	const image = { path: 'a/verbose_MD5.png', md5: 'verbose', ext: 'png' };

	await describeMd5Images(plugin, provider, 'model-1', [image]);

	const record = plugin.imageDescriptions.map.get('verbose');
	assert.equal(record.kind, 'failed');
	assert.ok(record.failure.length < longMessage.length, 'the stored failure is shorter than the raw thrown message');
	assert.ok(record.failure.length <= 501, 'truncated to ~500 chars plus an ellipsis marker');
});

// ── shouldEnqueueImageDescribe ───────────────────────────────────────────────

function baseSettings(overrides = {}) {
	return {
		imageMetadataExtractionEnabled: true,
		imageMetadataExtractionModel: { providerId: 'p1', modelId: 'm1' },
		providers: [{ id: 'p1', kind: 'openai-compatible', models: [{ id: 'm1', capabilities: ['image-extraction'] }] }],
		...overrides,
	};
}

const md5Path = 'a/0123456789abcdef0123456789abcdef_MD5.png';

test('shouldEnqueueImageDescribe: enabled, valid model, MD5 path -> true', () => {
	assert.equal(shouldEnqueueImageDescribe(baseSettings(), md5Path), true);
});

test('shouldEnqueueImageDescribe: disabled in settings -> false', () => {
	assert.equal(shouldEnqueueImageDescribe(baseSettings({ imageMetadataExtractionEnabled: false }), md5Path), false);
});

test('shouldEnqueueImageDescribe: a non-MD5-named path -> false regardless of settings', () => {
	assert.equal(shouldEnqueueImageDescribe(baseSettings(), 'a/plain-image.png'), false);
});

test('shouldEnqueueImageDescribe: no model configured -> false', () => {
	assert.equal(shouldEnqueueImageDescribe(baseSettings({ imageMetadataExtractionModel: undefined }), md5Path), false);
});

test('shouldEnqueueImageDescribe: configured model lacks image-extraction capability -> false', () => {
	const settings = baseSettings({
		providers: [{ id: 'p1', kind: 'openai-compatible', models: [{ id: 'm1', capabilities: ['chat'] }] }],
	});
	assert.equal(shouldEnqueueImageDescribe(settings, md5Path), false);
});

test('shouldEnqueueImageDescribe: a CLI-modality provider -> false (no image endpoint)', () => {
	const settings = baseSettings({
		providers: [{ id: 'p1', kind: 'claude-cli', models: [{ id: 'm1', capabilities: ['image-extraction'] }] }],
	});
	assert.equal(shouldEnqueueImageDescribe(settings, md5Path), false);
});

// ── legacy sidecar import round-trip ─────────────────────────────────────────

test('importLegacyImageMetadataSidecars: a matching sidecar is imported as kind:imported and trashed; non-sidecar notes are left alone', async () => {
	const sidecarPath = 'attach/0123456789abcdef0123456789abcdef_MD5.md';
	const sidecarContent = [
		'---',
		'image-metadata-schema: 1',
		'---',
		'',
		'# Description',
		'',
		'A bar chart of quarterly revenue.',
		'',
		'# Extracted text',
		'',
		'Q1 Q2 Q3 Q4',
		'',
	].join('\n');
	const notes = [
		{ path: sidecarPath, frontmatter: { 'image-metadata-schema': 1, 'image-metadata-provider': 'lmstudio', 'image-metadata-model': 'gemma-4-12b' }, content: sidecarContent },
		{ path: 'notes/unrelated.md', frontmatter: {}, content: '# Just a note, not a sidecar' },
	];
	const trashed = [];
	const putCalls = [];
	const plugin = {
		app: {
			vault: {
				getMarkdownFiles: () => notes.map(n => new TFile(n.path)),
				read: async (file) => notes.find(n => n.path === file.path).content,
			},
			metadataCache: {
				getFileCache: (file) => ({ frontmatter: notes.find(n => n.path === file.path)?.frontmatter }),
			},
			fileManager: {
				trashFile: async (file) => { trashed.push(file.path); },
			},
		},
	};
	const store = { put: async (input) => { putCalls.push(input); return input; } };

	const result = await importLegacyImageMetadataSidecars(plugin, store);

	assert.equal(result.imported, 1);
	assert.equal(putCalls.length, 1);
	assert.equal(putCalls[0].md5, '0123456789abcdef0123456789abcdef');
	assert.equal(putCalls[0].kind, 'imported');
	assert.equal(putCalls[0].narrative, 'A bar chart of quarterly revenue.');
	assert.equal(putCalls[0].extraction, 'Q1 Q2 Q3 Q4');
	assert.equal(putCalls[0].providerId, 'lmstudio');
	assert.equal(putCalls[0].modelId, 'gemma-4-12b');
	assert.deepEqual(trashed, [sidecarPath]);
});

test('importLegacyImageMetadataSidecars: a *_MD5.md file with no image-metadata-schema frontmatter is not imported', async () => {
	const notes = [
		{ path: 'attach/0123456789abcdef0123456789abcdef_MD5.md', frontmatter: {}, content: '# Some other note that happens to match the naming' },
	];
	const trashed = [];
	const plugin = {
		app: {
			vault: {
				getMarkdownFiles: () => notes.map(n => new TFile(n.path)),
				read: async (file) => notes.find(n => n.path === file.path).content,
			},
			metadataCache: { getFileCache: (file) => ({ frontmatter: notes.find(n => n.path === file.path)?.frontmatter }) },
			fileManager: { trashFile: async (file) => { trashed.push(file.path); } },
		},
	};
	const store = { put: async () => { throw new Error('must not be called'); } };

	const result = await importLegacyImageMetadataSidecars(plugin, store);
	assert.equal(result.imported, 0);
	assert.deepEqual(trashed, []);
});

// ── resolveNoteImages / referencingNotePaths / computeReferencedImagePaths ──

test('resolveNoteImages: resolves embedded MD5 images via metadataCache and dedupes by md5', () => {
	const noteFile = new TFile('notes/source.md');
	const imgPath = 'attach/abcdefabcdefabcdefabcdefabcdefab_MD5.png';
	const plugin = {
		app: {
			metadataCache: {
				getFileCache: (file) => file.path === noteFile.path
					? { embeds: [{ link: 'attach/img.png' }, { link: 'attach/img.png' }] }
					: {},
				getFirstLinkpathDest: () => new TFile(imgPath),
			},
		},
	};
	const images = resolveNoteImages(plugin, noteFile);
	assert.equal(images.length, 1, 'the same embed twice still yields one unique md5');
	assert.equal(images[0].md5, 'abcdefabcdefabcdefabcdefabcdefab');
});

test('referencingNotePaths: returns the source notes whose resolvedLinks point at any of the given image paths', () => {
	const imgA = 'attach/a_MD5.png';
	const imgB = 'attach/b_MD5.png';
	const plugin = {
		app: {
			metadataCache: {
				resolvedLinks: {
					'notes/one.md': { [imgA]: 1 },
					'notes/two.md': { [imgB]: 1 },
					'notes/three.md': { 'attach/unrelated.png': 1 },
				},
			},
		},
	};
	const notes = referencingNotePaths(plugin, [imgA, imgB]).sort();
	assert.deepEqual(notes, ['notes/one.md', 'notes/two.md']);
});

test('computeReferencedImagePaths: keeps only referenced MD5-named image files', () => {
	const referencedPath = 'attach/1111111111111111111111111111111a_MD5.png';
	const orphanedPath = 'attach/2222222222222222222222222222222b_MD5.png';
	const plugin = {
		app: {
			metadataCache: { resolvedLinks: { 'notes/one.md': { [referencedPath]: 1 } } },
			vault: { getFiles: () => [new TFile(referencedPath), new TFile(orphanedPath)] },
		},
	};
	const rows = computeReferencedImagePaths(plugin);
	assert.deepEqual(rows.map(r => r.path), [referencedPath]);
});
