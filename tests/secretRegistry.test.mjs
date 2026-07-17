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

const { computeReconcile, describeSecretKey, SecretRegistry } = await import(pathToFileURL(outfile).href);

// Minimal plugin stub backing SecretRegistry: settings.storedSecretKeys is the
// persisted registry, `store` is the fake secretStorage's key→value table (an empty
// string models a cleared-but-still-listed key, matching real SecretStorage's lack of
// an explicit delete).
function makeStubPlugin(initialKeys = []) {
	const settings = { storedSecretKeys: [...initialKeys], providers: [] };
	const store = new Map();
	const secretStorage = {
		getSecret: async (key) => (store.has(key) ? store.get(key) : null),
		setSecret: async (key, value) => { store.set(key, value); },
		listSecrets: async () => Array.from(store.keys()),
	};
	const plugin = { settings, app: { secretStorage }, saveSettings: async () => {} };
	return { plugin, store };
}

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

// ── SecretRegistry facade + reconcile hardening ─────────────────────────────────

test('facade store records the key; facade clear forgets it', async () => {
	const { plugin, store } = makeStubPlugin();
	const registry = new SecretRegistry(plugin);
	const key = 'crucible-provider-or-key';

	await registry.store(key, 'sk-test-value');
	assert.equal(store.get(key), 'sk-test-value');
	assert.ok(registry.isRegistered(key));

	await registry.clear(key);
	assert.equal(store.get(key), '');
	assert.ok(!registry.isRegistered(key));
});

test('facade store with an empty value clears instead of recording', async () => {
	const { plugin, store } = makeStubPlugin(['crucible-provider-or-key']);
	store.set('crucible-provider-or-key', 'sk-existing');
	const registry = new SecretRegistry(plugin);

	await registry.store('crucible-provider-or-key', '');
	assert.equal(store.get('crucible-provider-or-key'), '');
	assert.ok(!registry.isRegistered('crucible-provider-or-key'));
});

test('deleting a provider (facade clear) forgets its key — reconcile reports nothing missing', async () => {
	const { plugin, store } = makeStubPlugin();
	const registry = new SecretRegistry(plugin);
	const key = 'crucible-provider-or-key';

	await registry.store(key, 'sk-test-value');
	// What ProviderManager.deleteApiKey now does: clear via the facade.
	await registry.clear(key);
	assert.equal(store.get(key), ''); // still listed, but empty

	const result = await registry.reconcile();
	assert.deepEqual(result.missing, []);
	assert.deepEqual(result.present, []);
});

test('reconcile treats a listed-but-empty key as absent: no re-register, no false report', async () => {
	const { plugin, store } = makeStubPlugin();
	store.set('crucible-provider-or-key', ''); // cleared out-of-band, still listed
	const registry = new SecretRegistry(plugin);

	const result = await registry.reconcile();
	assert.deepEqual(result.missing, []);
	assert.deepEqual(result.present, []);
	assert.deepEqual(plugin.settings.storedSecretKeys, []);
});

test('reconcile still grows-by-observation and reports missing for genuinely present/absent keys', async () => {
	const { plugin, store } = makeStubPlugin(['crucible-youtube-data-api-key']);
	store.set('crucible-provider-or-key', 'sk-live'); // present, not yet registered
	// crucible-youtube-data-api-key is registered but absent from the store entirely.
	const registry = new SecretRegistry(plugin);

	const result = await registry.reconcile();
	assert.deepEqual(result.missing, ['crucible-youtube-data-api-key']);
	assert.deepEqual(result.present, ['crucible-provider-or-key']);
	assert.deepEqual(plugin.settings.storedSecretKeys.sort(), ['crucible-provider-or-key', 'crucible-youtube-data-api-key']);
});

test('facade get returns empty string when secretStorage is unavailable', async () => {
	const plugin = { settings: { storedSecretKeys: [] }, app: {}, saveSettings: async () => {} };
	const registry = new SecretRegistry(plugin);
	assert.equal(await registry.get('crucible-provider-or-key'), '');
});
