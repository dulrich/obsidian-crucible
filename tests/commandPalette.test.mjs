import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-command-palette-tests');
const outfile = path.join(outdir, 'commandPalette.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/commandPalette.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: [
					'export class App {}',
					'export class TFolder {}',
					'export const Platform = { isMacOS: false };',
					'export class FuzzySuggestModal {',
					'  constructor(app) { this.app = app; this.modalEl = { addClass() {} }; }',
					'  setPlaceholder() {}',
					'  getSuggestions() { return []; }',
					'  renderSuggestion() {}',
					'}',
					'export function prepareFuzzySearch(query) {',
					'  const q = String(query).toLowerCase();',
					'  return text => String(text).toLowerCase().includes(q) ? { score: 0, matches: [] } : null;',
					'}',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
});

const { getPaletteItems } = await import(pathToFileURL(outfile).href);

test('getPaletteItems filters Crucible commands by hidden and available state', () => {
	const app = makeApp([
		command('obsidian-crucible:available'),
		command('obsidian-crucible:unavailable'),
		command('obsidian-crucible:hidden'),
	]);
	const plugin = makePlugin({
		hiddenCommands: ['hidden'],
		commandRegistry: [
			entry('available'),
			entry('unavailable', { available: () => false }),
			entry('hidden'),
		],
	});

	assert.deepEqual(getPaletteItems(app, plugin).map(cmd => cmd.id), ['obsidian-crucible:available']);
});

test('getPaletteItems filters non-Crucible commands by checkCallback and blacklist', () => {
	const app = makeApp([
		command('other:plain'),
		command('other:available', { checkCallback: () => true }),
		command('other:unavailable', { checkCallback: () => false }),
		command('other:void-check', { checkCallback: () => undefined }),
		command('other:blacklisted'),
	]);
	const plugin = makePlugin({
		crucibleCommandPaletteBlacklist: ['other:blacklisted'],
	});

	assert.deepEqual(getPaletteItems(app, plugin).map(cmd => cmd.id), ['other:plain', 'other:available']);
});

test('getPaletteItems keeps whitelist behavior after availability filtering', () => {
	const app = makeApp([
		command('other:whitelisted', { checkCallback: () => true }),
		command('other:whitelisted-unavailable', { checkCallback: () => false }),
		command('other:not-listed'),
	]);
	const plugin = makePlugin({
		crucibleCommandPaletteFilterMode: 'whitelist',
		crucibleCommandPaletteWhitelist: ['other:whitelisted', 'other:whitelisted-unavailable'],
	});

	assert.deepEqual(getPaletteItems(app, plugin).map(cmd => cmd.id), ['other:whitelisted']);
});

function command(id, over = {}) {
	return { id, name: id, ...over };
}

function entry(id, over = {}) {
	return {
		id,
		name: id,
		group: 'Other',
		mutating: false,
		queueable: false,
		...over,
	};
}

function makeApp(commands) {
	return {
		commands: {
			commands: Object.fromEntries(commands.map(cmd => [cmd.id, cmd])),
		},
	};
}

function makePlugin(over = {}) {
	return {
		manifest: { id: 'obsidian-crucible' },
		commandRegistry: over.commandRegistry ?? [],
		settings: {
			hiddenCommands: [],
			crucibleCommandPaletteFilterMode: 'blacklist',
			crucibleCommandPaletteWhitelist: [],
			crucibleCommandPaletteBlacklist: [],
			...over,
		},
	};
}
