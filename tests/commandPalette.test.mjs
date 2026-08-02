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

const {
	getPaletteItems,
	getHintCache,
	computeHintCacheSignature,
	CrucibleCommandPaletteModal,
	COMMAND_PALETTE_LIMIT,
} = await import(pathToFileURL(outfile).href);

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

test('the palette modal bounds its row set (COMMAND_PALETTE_LIMIT), mirroring fileOpenPalette', () => {
	const { app, plugin } = paletteFixture([
		['obsidian-crucible:alpha', 'Chain: Alpha task'],
		['obsidian-crucible:beta', 'Chain: Beta task'],
	]);
	const modal = new CrucibleCommandPaletteModal(app, plugin);
	assert.equal(modal.limit, COMMAND_PALETTE_LIMIT);
	assert.ok(COMMAND_PALETTE_LIMIT > 0);
});

test('the palette modal sweeps getPaletteItems exactly once per open, reused for every getItems() call', () => {
	const { app, plugin } = paletteFixture([
		['obsidian-crucible:alpha', 'Chain: Alpha task'],
		['obsidian-crucible:beta', 'Chain: Beta task'],
	]);
	let sweeps = 0;
	const nativeCommandsGetter = app.commands.commands;
	// Object.values(app.commands.commands) is the sweep; count reads of the property.
	Object.defineProperty(app.commands, 'commands', {
		get() { sweeps++; return nativeCommandsGetter; },
	});
	const modal = new CrucibleCommandPaletteModal(app, plugin);
	const first = modal.getItems();
	const second = modal.getItems();
	assert.equal(sweeps, 1, 'expected exactly one sweep of app.commands.commands for the whole open');
	assert.equal(first, second, 'getItems() must return the same cached snapshot on repeat calls');
});

test('computeHintCacheSignature is order-insensitive over the command name list', () => {
	const settings = paletteSettings();
	const sigA = computeHintCacheSignature(['Chain: Alpha task', 'Chain: Beta task'], settings);
	const sigB = computeHintCacheSignature(['Chain: Beta task', 'Chain: Alpha task'], settings);
	assert.equal(sigA, sigB);
});

test('computeHintCacheSignature changes when the command set changes', () => {
	const settings = paletteSettings();
	const sigA = computeHintCacheSignature(['Chain: Alpha task', 'Chain: Beta task'], settings);
	const sigB = computeHintCacheSignature(['Chain: Alpha task', 'Chain: Beta task', 'Chain: Gamma task'], settings);
	assert.notEqual(sigA, sigB);
});

test('computeHintCacheSignature changes when a hint-affecting setting changes', () => {
	const names = ['Chain: Alpha task', 'Chain: Beta task'];
	const sigA = computeHintCacheSignature(names, paletteSettings());
	const sigB = computeHintCacheSignature(names, paletteSettings({ crucibleCommandPaletteHintMaxLen: 8 }));
	const sigC = computeHintCacheSignature(names, paletteSettings({ crucibleCommandPaletteHintFallbackTopMatch: false }));
	assert.notEqual(sigA, sigB);
	assert.notEqual(sigA, sigC);
});

test('getHintCache: same signature is a cache hit; a changed signature invalidates wholesale and only the latest is kept', () => {
	const sig = `probe-sig-${Math.random()}`;
	const first = getHintCache(sig);
	first.set('cmd-id', { text: 'cached', kind: 'unique' });

	const same = getHintCache(sig);
	assert.equal(same, first, 'an unchanged signature must return the SAME Map instance (no recompute)');
	assert.deepEqual(same.get('cmd-id'), { text: 'cached', kind: 'unique' });

	const changed = getHintCache(`${sig}-changed`);
	assert.notEqual(changed, first, 'a changed signature must return a fresh Map');
	assert.equal(changed.size, 0, 'a changed signature starts with zero recomputed entries (wholesale invalidation)');

	// Only the LATEST signature's entries survive — going back to `sig` after visiting a
	// different one must NOT resurrect the earlier cache (bounded to one entry).
	const backToOriginal = getHintCache(sig);
	assert.notEqual(backToOriginal, first);
	assert.equal(backToOriginal.get('cmd-id'), undefined);
});

test('reopening the palette with an unchanged command set + settings reuses the persisted hint cache (no recompute)', () => {
	const commandDefs = [
		['obsidian-crucible:alpha', 'Chain: Alpha task'],
		['obsidian-crucible:beta', 'Chain: Beta task'],
	];
	const settingsOver = { crucibleCommandPaletteShowUniqueString: true };
	const { app, plugin, settings } = paletteFixture(commandDefs, settingsOver);

	const first = new CrucibleCommandPaletteModal(app, plugin);
	const alphaCmd = app.commands.commands['obsidian-crucible:alpha'];
	const realHint = first.getUniqueHint(alphaCmd);
	assert.ok(realHint, 'expected a real computed hint for a distinguishable command');

	// Poison the exact cache bucket a second, otherwise-identical open resolves to. If the
	// second modal instance actually reuses the persisted cache (rather than recomputing
	// hints from a fresh per-instance Map, as before this WP), it must read the poisoned
	// value back instead of recomputing the real hint.
	const signature = computeHintCacheSignature(
		commandDefs.map(([, name]) => name),
		settings,
	);
	getHintCache(signature).set('obsidian-crucible:alpha', { text: 'poisoned', kind: 'unique' });

	const second = new CrucibleCommandPaletteModal(app, plugin);
	const cachedHint = second.getUniqueHint(app.commands.commands['obsidian-crucible:alpha']);
	assert.deepEqual(cachedHint, { text: 'poisoned', kind: 'unique' });
});

test('a changed command set invalidates the cache wholesale — a new open gets a freshly computed hint, not a poisoned one', () => {
	const settingsOver = { crucibleCommandPaletteShowUniqueString: true };

	// Poison a cache bucket for a two-command signature (mirrors the previous test).
	const staleSignature = computeHintCacheSignature(
		['Chain: Alpha task', 'Chain: Beta task'],
		paletteSettings(settingsOver),
	);
	getHintCache(staleSignature).set('obsidian-crucible:alpha', { text: 'poisoned', kind: 'unique' });

	// A THIRD command changes the signature entirely.
	const { app, plugin } = paletteFixture([
		['obsidian-crucible:alpha', 'Chain: Alpha task'],
		['obsidian-crucible:beta', 'Chain: Beta task'],
		['obsidian-crucible:gamma', 'Chain: Gamma task'],
	], settingsOver);

	const modal = new CrucibleCommandPaletteModal(app, plugin);
	const hint = modal.getUniqueHint(app.commands.commands['obsidian-crucible:alpha']);
	assert.notDeepEqual(hint, { text: 'poisoned', kind: 'unique' });
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
			crucibleCommandPalettePinned: [],
			crucibleCommandPaletteShowHotkeys: false,
			crucibleCommandPaletteShowUniqueString: false,
			crucibleCommandPaletteHintCharsetMode: 'alphanumeric-whitelist',
			crucibleCommandPaletteHintWhitelist: '.',
			crucibleCommandPaletteHintFallbackTopMatch: true,
			crucibleCommandPaletteHintMaxLen: 6,
			crucibleCommandPaletteHintPrefixPenalty: 1,
			crucibleCommandPaletteHintPositionBias: 0,
			...over,
		},
	};
}

// makePlugin above merges settings overrides directly at the top level (matching the
// existing test helper's shape); this alias reads better at call sites that only want
// to override hint-cache-relevant settings for the module-level cache tests below.
function paletteSettings(over = {}) {
	return makePlugin(over).settings;
}

/** A full plugin+app pair for a modal, sharing one `settings` object between them. */
function paletteFixture(commandDefs, settingsOver = {}) {
	const settings = paletteSettings(settingsOver);
	const app = makeApp(commandDefs.map(([id, name]) => command(id, { name })));
	const plugin = makePlugin(settingsOver);
	plugin.settings = settings;
	plugin.commandRegistry = commandDefs.map(([id]) => entry(id.startsWith('obsidian-crucible:') ? id.slice('obsidian-crucible:'.length) : id));
	return { app, plugin, settings };
}
