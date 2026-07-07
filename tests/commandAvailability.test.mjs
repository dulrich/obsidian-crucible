import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-command-availability-tests');
const outfile = path.join(outdir, 'commandAvailability.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/commandAvailability.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const {
	commandAvailabilityHelp,
	featureDisabledCommandIds,
	featureDisabledCommandExcludeIds,
	mergeCommandExcludeIds,
} = await import(pathToFileURL(outfile).href);

test('commandAvailabilityHelp returns null when a command is not feature-disabled', () => {
	assert.equal(commandAvailabilityHelp({}), null);
	assert.equal(commandAvailabilityHelp({ availabilityHelp: () => null }), null);
});

test('commandAvailabilityHelp returns the feature-disabled help text', () => {
	assert.equal(
		commandAvailabilityHelp({ availabilityHelp: () => 'Enable the feature.' }),
		'Enable the feature.',
	);
});

test('featureDisabledCommandIds returns only commands with active feature-gate help', () => {
	assert.deepEqual(featureDisabledCommandIds([
		{ id: 'always-on' },
		{ id: 'currently-on', availabilityHelp: () => null },
		{ id: 'feature-off', availabilityHelp: () => 'Enable the feature.' },
	]), ['feature-off']);
});

test('mergeCommandExcludeIds dedupes hidden and feature-disabled command ids', () => {
	assert.deepEqual(mergeCommandExcludeIds(
		['hidden', 'shared'],
		['feature-disabled', 'shared'],
	), ['hidden', 'shared', 'feature-disabled']);
});

test('featureDisabledCommandExcludeIds includes registered and prefixed command ids', () => {
	assert.deepEqual(featureDisabledCommandExcludeIds([
		{ id: 'feature-off', availabilityHelp: () => 'Enable the feature.' },
	], 'obsidian-crucible'), [
		'feature-off',
		'obsidian-crucible:feature-off',
		'crucible:feature-off',
	]);
});
