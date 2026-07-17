import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-autorungate-tests');
const outfile = path.join(outdir, 'autorunGate.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/orchestration/autorunGate.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	logLevel: 'silent',
	outfile,
});

const { computeShouldDrain, effectiveTypeAutorun, readJobTypeAutorun } = await import(pathToFileURL(outfile).href);

// --- memory types (the folded enrichment queue) ---

test('memory type does not drain when its per-type auto-run is unset (default idle)', () => {
	assert.equal(computeShouldDrain({
		drainsWithoutAutorun: true,
		typeAutorun: undefined,
		globalAutorunEnabled: true, // global Autorun must not force a memory drain
		fileDrainReady: true,
	}), false);
});

test('memory type does not drain when its per-type auto-run is off', () => {
	assert.equal(computeShouldDrain({
		drainsWithoutAutorun: true,
		typeAutorun: false,
		globalAutorunEnabled: true,
		fileDrainReady: true,
	}), false);
});

test('memory type drains when its per-type auto-run is on, independent of global Autorun', () => {
	assert.equal(computeShouldDrain({
		drainsWithoutAutorun: true,
		typeAutorun: true,
		globalAutorunEnabled: false,
		fileDrainReady: false,
	}), true);
});

// --- file types (job-store backed) ---

test('file type drains under global Autorun once the file-drain delay has elapsed', () => {
	assert.equal(computeShouldDrain({
		drainsWithoutAutorun: false,
		typeAutorun: undefined,
		globalAutorunEnabled: true,
		fileDrainReady: true,
	}), true);
});

test('file type waits for the initial file-drain delay even with global Autorun on', () => {
	assert.equal(computeShouldDrain({
		drainsWithoutAutorun: false,
		typeAutorun: undefined,
		globalAutorunEnabled: true,
		fileDrainReady: false,
	}), false);
});

test('file type does not drain when global Autorun is off', () => {
	assert.equal(computeShouldDrain({
		drainsWithoutAutorun: false,
		typeAutorun: undefined,
		globalAutorunEnabled: false,
		fileDrainReady: true,
	}), false);
});

test('file type per-type false vetoes even when global Autorun is on', () => {
	assert.equal(computeShouldDrain({
		drainsWithoutAutorun: false,
		typeAutorun: false,
		globalAutorunEnabled: true,
		fileDrainReady: true,
	}), false);
});

// --- effective per-type auto-run state (Queue Monitor display) ---

test('effectiveTypeAutorun: memory type reflects its per-type flag, default off', () => {
	assert.equal(effectiveTypeAutorun({ drainsWithoutAutorun: true, typeAutorun: undefined, globalAutorunEnabled: true }), false);
	assert.equal(effectiveTypeAutorun({ drainsWithoutAutorun: true, typeAutorun: true, globalAutorunEnabled: false }), true);
});

test('effectiveTypeAutorun: file type follows the global toggle unless overridden', () => {
	assert.equal(effectiveTypeAutorun({ drainsWithoutAutorun: false, typeAutorun: undefined, globalAutorunEnabled: true }), true);
	assert.equal(effectiveTypeAutorun({ drainsWithoutAutorun: false, typeAutorun: undefined, globalAutorunEnabled: false }), false);
	assert.equal(effectiveTypeAutorun({ drainsWithoutAutorun: false, typeAutorun: false, globalAutorunEnabled: true }), false);
	assert.equal(effectiveTypeAutorun({ drainsWithoutAutorun: false, typeAutorun: true, globalAutorunEnabled: false }), true);
});

// --- settings-map reader ---

test('readJobTypeAutorun returns the boolean when present, undefined otherwise', () => {
	assert.equal(readJobTypeAutorun({ youtube_metadata_fetch: true }, 'youtube_metadata_fetch'), true);
	assert.equal(readJobTypeAutorun({ youtube_metadata_fetch: false }, 'youtube_metadata_fetch'), false);
	assert.equal(readJobTypeAutorun({}, 'youtube_metadata_fetch'), undefined);
	assert.equal(readJobTypeAutorun(undefined, 'youtube_metadata_fetch'), undefined);
	assert.equal(readJobTypeAutorun({ youtube_metadata_fetch: 'yes' }, 'youtube_metadata_fetch'), undefined);
});
