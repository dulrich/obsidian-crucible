import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-secretregistry-tests');
const outfile = path.join(outdir, 'secretRegistry.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// secretRegistry.ts transitively imports from 'obsidian' (via youtubeApi.ts /
// providers.ts). We stub 'obsidian' so esbuild can bundle it in a plain Node test;
// only the pure exports (computeReconcile, describeSecretKey) are exercised.
await esbuild.build({
	entryPoints: ['src/secretRegistry.ts'],
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
export class App {}
export class TFile {}
export class TFolder {}
export class TAbstractFile {}
export class FileSystemAdapter {}
export class Notice {}
export class Component {}
export function normalizePath(p) { return p; }
export function requestUrl() { throw new Error('requestUrl unavailable in tests'); }
export const Platform = {};
export const moment = () => {};
export function debounce(fn) { return fn; }
`,
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { computeReconcile, describeSecretKey } = await import(pathToFileURL(outfile).href);

// ── computeReconcile ─────────────────────────────────────────────────────────

test('all registered keys present → nothing missing', () => {
	const { merged, result } = computeReconcile(
		['crucible-youtube-data-api-key', 'crucible-provider-or-key'],
		['crucible-youtube-data-api-key', 'crucible-provider-or-key'],
	);
	assert.deepEqual(result.missing, []);
	assert.equal(merged.length, 2);
});

test('a registered key absent from the store is reported missing', () => {
	const { result } = computeReconcile(
		['crucible-youtube-data-api-key', 'crucible-provider-or-key'],
		['crucible-provider-or-key'],
	);
	assert.deepEqual(result.missing, ['crucible-youtube-data-api-key']);
});

test('empty store with a non-empty registry → every registered key missing (the wipe case)', () => {
	const { result } = computeReconcile(['crucible-youtube-data-api-key', 'crucible-provider-or-key'], []);
	assert.deepEqual(result.missing.sort(), ['crucible-provider-or-key', 'crucible-youtube-data-api-key']);
});

test('grow-by-observation: a present key not yet in the registry is folded in and not missing', () => {
	const { merged, result } = computeReconcile([], ['crucible-provider-or-key']);
	assert.deepEqual(merged, ['crucible-provider-or-key']);
	assert.deepEqual(result.missing, []);
});

test('present list is de-duplicated', () => {
	const { result } = computeReconcile([], ['crucible-provider-or-key', 'crucible-provider-or-key']);
	assert.deepEqual(result.present, ['crucible-provider-or-key']);
});

// ── describeSecretKey ────────────────────────────────────────────────────────

test('describeSecretKey maps YouTube and provider keys to human labels', () => {
	const plugin = { settings: { providers: [{ id: 'or', name: 'OpenRouter' }] } };
	assert.equal(describeSecretKey(plugin, 'crucible-youtube-data-api-key'), 'YouTube Data API key');
	assert.equal(describeSecretKey(plugin, 'crucible-provider-or-key'), 'OpenRouter API key');
	assert.equal(describeSecretKey(plugin, 'crucible-unknown'), 'crucible-unknown');
});
