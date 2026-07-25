// Provider-model capability flags: the `undefined` vs `[]` distinction.
//
// Every case here is a regression test for one reported bug — a model flagged Rerank and only
// Rerank kept regaining the Chat capability across plugin reloads. The cause was not in any
// load, migrate or restart path (there is no capability defaulting in any of them); it was the
// toggles themselves treating a present-but-empty array as "unset" and re-seeding `['chat']`
// from it. Because the model row is not re-rendered after a toggle, the damage was invisible
// until the settings tab was rebuilt on reload, which is what made a toggle bug present as a
// restart bug.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-model-capabilities-tests');
const outfile = path.join(outdir, 'modelCapabilities.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: [path.join(import.meta.dirname, '..', 'src', 'settings', 'modelCapabilities.ts')],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});
const { modelHasCapability, setModelCapability } = await import(pathToFileURL(outfile));

const model = (capabilities) => (capabilities === undefined ? { id: 'm', label: 'M' } : { id: 'm', label: 'M', capabilities });

// ── Reading ──────────────────────────────────────────────────────────────────────────────

test('an unset capability list reads as chat-only — the documented legacy contract', () => {
	const m = model(undefined);
	assert.equal(modelHasCapability(m, 'chat'), true);
	assert.equal(modelHasCapability(m, 'embedding'), false);
	assert.equal(modelHasCapability(m, 'rerank'), false);
	assert.equal(modelHasCapability(m, 'image-extraction'), false);
});

test('an EMPTY capability list is not an unset one: it reads as no capabilities, chat included', () => {
	const m = model([]);
	assert.equal(modelHasCapability(m, 'chat'), false, 'an explicit "nothing enabled" must not render the Chat toggle on');
	assert.equal(modelHasCapability(m, 'rerank'), false);
});

test('a populated list is read literally', () => {
	const m = model(['rerank']);
	assert.equal(modelHasCapability(m, 'rerank'), true);
	assert.equal(modelHasCapability(m, 'chat'), false);
});

// ── Writing: the reported bug ────────────────────────────────────────────────────────────

test('THE BUG: turning Chat off then Rerank on yields rerank alone, never ["chat","rerank"]', () => {
	// Exactly the sequence "Add model" (which seeds ['chat']) then configuring a reranker.
	const m = model(['chat']);
	setModelCapability(m, 'chat', false);
	assert.deepEqual(m.capabilities, [], 'turning the only capability off must leave an empty list');
	setModelCapability(m, 'rerank', true);
	assert.deepEqual(m.capabilities, ['rerank']);
});

test('THE BUG, second shape: toggling Rerank off and back on does not resurrect Chat', () => {
	const m = model(['rerank']);
	setModelCapability(m, 'rerank', false);
	assert.deepEqual(m.capabilities, []);
	setModelCapability(m, 'rerank', true);
	assert.deepEqual(m.capabilities, ['rerank'], 'the round trip must be identity, not a re-seed');
});

test('a rerank-only model survives an arbitrary number of unrelated toggles', () => {
	// The reported symptom was "across reload/restart cycles", i.e. cumulative. If any single
	// toggle re-seeds, repetition makes it certain, so assert stability under churn.
	const m = model(['rerank']);
	for (let i = 0; i < 10; i++) {
		setModelCapability(m, 'embedding', true);
		setModelCapability(m, 'embedding', false);
	}
	assert.deepEqual(m.capabilities, ['rerank']);
	assert.equal(modelHasCapability(m, 'chat'), false);
});

test('the legacy default still applies when writing to a model that never had a list', () => {
	// An unset model reads as chat, so enabling a second capability must keep chat rather than
	// silently dropping it — the flip side of the fix, and the reason `undefined` is not just
	// normalized to [].
	const m = model(undefined);
	setModelCapability(m, 'embedding', true);
	assert.deepEqual(m.capabilities, ['chat', 'embedding']);
});

test('disabling the sole capability of a never-configured model records the intent explicitly', () => {
	const m = model(undefined);
	setModelCapability(m, 'chat', false);
	assert.deepEqual(m.capabilities, [], 'not undefined — otherwise the next read would say chat again');
	assert.equal(modelHasCapability(m, 'chat'), false);
});

test('enabling a capability twice is idempotent — no duplicate entries reach settings', () => {
	const m = model(['rerank']);
	setModelCapability(m, 'rerank', true);
	setModelCapability(m, 'rerank', true);
	assert.deepEqual(m.capabilities, ['rerank']);
});

test('disabling a capability the model never had is a no-op, not a re-seed', () => {
	const m = model(['embedding']);
	setModelCapability(m, 'chat', false);
	assert.deepEqual(m.capabilities, ['embedding']);
});
