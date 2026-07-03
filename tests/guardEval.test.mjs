import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-guard-eval-tests');
const outfile = path.join(outdir, 'guardEval.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/triggers/guardEval.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const { evaluateSyncGuard } = await import(pathToFileURL(outfile).href);

test('property-equals keeps scalar exact-match behavior', () => {
	assert.equal(evaluateSyncGuard(
		{ type: 'property-equals', property: 'status', value: 'done' },
		{ fm: { status: 'done' }, tags: [] },
	), true);
	assert.equal(evaluateSyncGuard(
		{ type: 'property-equals', property: 'status', value: 'done' },
		{ fm: { status: 'todo' }, tags: [] },
	), false);
});

test('property-in-set matches scalar property values exactly', () => {
	assert.equal(evaluateSyncGuard(
		{ type: 'property-in-set', property: 'channelId', values: ['CHANNEL_A', 'CHANNEL_B'] },
		{ fm: { channelId: 'CHANNEL_B' }, tags: [] },
	), true);
	assert.equal(evaluateSyncGuard(
		{ type: 'property-in-set', property: 'channelId', values: ['CHANNEL_A', 'CHANNEL_B'] },
		{ fm: { channelId: 'channel_b' }, tags: [] },
	), false);
});

test('property-in-set matches any scalar item in an array property', () => {
	assert.equal(evaluateSyncGuard(
		{ type: 'property-in-set', property: 'channels', values: ['CHANNEL_A', 'CHANNEL_B'] },
		{ fm: { channels: ['CHANNEL_C', 'CHANNEL_A'] }, tags: [] },
	), true);
});

test('property-in-set ignores blank configured values', () => {
	assert.equal(evaluateSyncGuard(
		{ type: 'property-in-set', property: 'channelId', values: ['', '   '] },
		{ fm: { channelId: 'CHANNEL_A' }, tags: [] },
	), false);
	assert.equal(evaluateSyncGuard(
		{ type: 'property-in-set', property: 'channelId', values: [' ', 'CHANNEL_A'] },
		{ fm: { channelId: 'CHANNEL_A' }, tags: [] },
	), true);
});
