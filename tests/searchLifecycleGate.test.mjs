import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-lifecycle-gate-tests');
const outfile = path.join(outdir, 'lifecycleGate.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/lifecycleGate.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const {
	SEARCH_AUTO_OFFLINE_CACHE_MS,
	SEARCH_AUTO_ONLINE_CACHE_MS,
	SearchAutoIndexGate,
} = await import(pathToFileURL(outfile));

test('SearchAutoIndexGate waits for layout and metadata readiness', () => {
	const gate = new SearchAutoIndexGate();

	assert.equal(gate.isReady(), false);
	gate.markLayoutReady();
	assert.equal(gate.isReady(), false);
	gate.markMetadataResolved();
	assert.equal(gate.isReady(), true);
});

test('SearchAutoIndexGate caches offline companion checks', async () => {
	let now = 1_000;
	let checks = 0;
	const gate = new SearchAutoIndexGate(() => now);
	const health = async () => {
		checks++;
		throw new Error('connection refused');
	};

	assert.equal(await gate.companionAvailable(health), false);
	assert.equal(await gate.companionAvailable(health), false);
	assert.equal(checks, 1);

	now += SEARCH_AUTO_OFFLINE_CACHE_MS + 1;
	assert.equal(await gate.companionAvailable(async () => ({ ok: true })), true);
});

test('SearchAutoIndexGate shares an in-flight health check and caches online status', async () => {
	let now = 1_000;
	let checks = 0;
	let release;
	const gate = new SearchAutoIndexGate(() => now);
	const health = () => {
		checks++;
		return new Promise(resolve => {
			release = () => resolve({ ok: true });
		});
	};

	const first = gate.companionAvailable(health);
	const second = gate.companionAvailable(health);
	release();
	assert.equal(await first, true);
	assert.equal(await second, true);
	assert.equal(checks, 1);

	assert.equal(await gate.companionAvailable(async () => {
		checks++;
		return { ok: false };
	}), true);
	assert.equal(checks, 1);

	now += SEARCH_AUTO_ONLINE_CACHE_MS + 1;
	assert.equal(await gate.companionAvailable(async () => {
		checks++;
		return { ok: false };
	}), false);
	assert.equal(checks, 2);
});
