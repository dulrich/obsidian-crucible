import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// ── Bundle src/providers.ts with a stub 'obsidian' module ──────────────────────
//
// Same technique as tests/providerRerank.test.mjs: providers.ts (and its transitive imports —
// providers/openaiCompatible.ts, providers/shared.ts, src/types.ts) reference 'obsidian' only for
// the handful of exports used here. requestUrl is wired to a global responder so each test
// controls exactly what the "server" returns, and every request is recorded so a test can assert
// on the URL/body it sent.
const providersOutdir = path.join(tmpdir(), 'obsidian-crucible-image-description-provider-tests');
const providersOutfile = path.join(providersOutdir, 'providers.mjs');

await rm(providersOutdir, { recursive: true, force: true });
await mkdir(providersOutdir, { recursive: true });

const obsidianStub = {
	name: 'obsidian-test-stub',
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
		build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
			contents: `
				export class App {}
				export class FileSystemAdapter {}
				export class Notice { constructor() {} }
				export function normalizePath(p) { return p; }
				export async function requestUrl(options) {
					globalThis.__providerRequests.push(options);
					if (typeof globalThis.__providerResponder !== 'function') {
						throw new Error('no responder configured for this test');
					}
					return await globalThis.__providerResponder(options);
				}
			`,
			loader: 'js',
		}));
	},
};

await esbuild.build({
	entryPoints: ['src/providers.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [obsidianStub],
	outfile: providersOutfile,
	logLevel: 'silent',
});

const { ProviderManager } = await import(pathToFileURL(providersOutfile).href);

// A second, separate bundle of the prompt module — used only to assert the request body's prompt
// text against the real exported constants, so this test can't silently drift from what
// providers.ts actually sends by duplicating the prompt strings as literals.
const sharedOutdir = path.join(tmpdir(), 'obsidian-crucible-image-description-provider-shared-tests');
const sharedOutfile = path.join(sharedOutdir, 'shared.mjs');
await rm(sharedOutdir, { recursive: true, force: true });
await mkdir(sharedOutdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/providers/shared.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [obsidianStub],
	outfile: sharedOutfile,
	logLevel: 'silent',
});
const { IMAGE_DESCRIPTION_NARRATIVE_PROMPT, IMAGE_DESCRIPTION_EXTRACTION_PROMPT } = await import(pathToFileURL(sharedOutfile).href);

const fakeSecrets = { get: async () => 'test-key' };
const fakeApp = {};

function resetRequests() {
	globalThis.__providerRequests = [];
	globalThis.__providerResponder = undefined;
}

function jsonOk(content) {
	return async () => ({ status: 200, json: { choices: [{ message: { content } }] } });
}

const imageBytes = new TextEncoder().encode('fake-image-bytes').buffer;

test('describeImage: reasoning_effort "none" is present for a local (openai-compatible) provider', async () => {
	resetRequests();
	globalThis.__providerResponder = jsonOk('A local narrative.');

	const provider = {
		id: 'local-lmstudio', name: 'LM Studio', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:1234/v1',
		models: [{ id: 'gemma-4', label: 'gemma-4' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	const text = await manager.describeImage(provider, 'gemma-4', imageBytes, 'image/png', 'narrative');

	assert.equal(text, 'A local narrative.');
	assert.equal(globalThis.__providerRequests.length, 1);
	const body = JSON.parse(globalThis.__providerRequests[0].body);
	assert.equal(body.reasoning_effort, 'none');
	assert.equal(body.temperature, 0);
});

test('describeImage: reasoning_effort is absent entirely for a remote (openai) provider', async () => {
	resetRequests();
	globalThis.__providerResponder = jsonOk('A remote narrative.');

	const provider = {
		id: 'openai-main', name: 'OpenAI', kind: 'openai',
		models: [{ id: 'gpt-4o', label: 'gpt-4o' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);
	await manager.describeImage(provider, 'gpt-4o', imageBytes, 'image/png', 'narrative');

	const body = JSON.parse(globalThis.__providerRequests[0].body);
	assert.equal('reasoning_effort' in body, false);
});

test('describeImage: the narrative pass sends the narrative prompt, the extraction pass sends the extraction prompt', async () => {
	resetRequests();
	globalThis.__providerResponder = jsonOk('text');

	const provider = {
		id: 'local-lmstudio', name: 'LM Studio', kind: 'openai-compatible',
		baseUrl: 'http://127.0.0.1:1234/v1',
		models: [{ id: 'gemma-4', label: 'gemma-4' }],
	};
	const manager = new ProviderManager(fakeApp, fakeSecrets);

	await manager.describeImage(provider, 'gemma-4', imageBytes, 'image/png', 'narrative');
	const narrativeBody = JSON.parse(globalThis.__providerRequests[0].body);
	assert.equal(narrativeBody.messages[0].content[0].text, IMAGE_DESCRIPTION_NARRATIVE_PROMPT);
	assert.equal(narrativeBody.messages[0].content[1].type, 'image_url');
	assert.match(narrativeBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);

	await manager.describeImage(provider, 'gemma-4', imageBytes, 'image/png', 'extraction');
	const extractionBody = JSON.parse(globalThis.__providerRequests[1].body);
	assert.equal(extractionBody.messages[0].content[0].text, IMAGE_DESCRIPTION_EXTRACTION_PROMPT);

	assert.notEqual(IMAGE_DESCRIPTION_NARRATIVE_PROMPT, IMAGE_DESCRIPTION_EXTRACTION_PROMPT);
});

test('describeImage: a provider kind with no describeImagePass support fails with a precise capability error', async () => {
	resetRequests();
	const provider = { id: 'unregistered', name: 'Unregistered', kind: 'made-up-kind', models: [{ id: 'whatever', label: 'whatever' }] };
	const manager = new ProviderManager(fakeApp, fakeSecrets);

	await assert.rejects(
		manager.describeImage(provider, 'whatever', imageBytes, 'image/png', 'narrative'),
		(err) => {
			assert.match(err.message, /does not support image description yet/);
			return true;
		},
	);
	assert.equal(globalThis.__providerRequests.length, 0);
});
