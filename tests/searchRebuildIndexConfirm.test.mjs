import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// WP-R6: `search-rebuild-index` must route through ConfirmModal before enqueuing the
// destructive `search_rebuild` job (which calls resetIndex()), and its name must call
// out the reset. Bundles the real `src/commands.ts` (not a copy) so the assertions
// exercise the actual registered command; `./confirmModal` is swapped for a controllable
// stub (real ConfirmModal needs a live DOM) while every other dependency is the real
// module, stubbing only the 'obsidian' surface they touch.
const outdir = path.join(tmpdir(), 'obsidian-crucible-search-rebuild-confirm-tests');
const outfile = path.join(outdir, 'commands.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/commands.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [
		{
			name: 'confirm-modal-stub',
			setup(build) {
				build.onResolve({ filter: /^\.\/confirmModal$/ }, () => ({ path: 'confirm-modal-stub', namespace: 'confirm-stub' }));
				build.onLoad({ filter: /.*/, namespace: 'confirm-stub' }, () => ({
					contents: [
						'globalThis.__confirmModalCalls = globalThis.__confirmModalCalls ?? [];',
						'export class ConfirmModal {',
						'  constructor(app, options) { this.app = app; this.options = options; }',
						'  openAndAwait() {',
						'    globalThis.__confirmModalCalls.push(this.options);',
						'    return Promise.resolve(globalThis.__confirmModalResult);',
						'  }',
						'}',
					].join('\n'),
					loader: 'js',
				}));
			},
		},
		{
			name: 'obsidian-test-stub',
			setup(build) {
				build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
				build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
					contents: [
						'export class App {}',
						'export class Modal { constructor() {} open() {} close() {} }',
						'export class Notice { constructor() {} hide() {} setMessage() {} }',
						'export class Plugin {}',
						'export class TFile {}',
						'export class TFolder {}',
						'export class TAbstractFile {}',
						'export class FuzzySuggestModal { constructor() {} open() {} close() {} }',
						'export class SuggestModal { constructor() {} open() {} close() {} }',
						'export function prepareFuzzySearch() { return () => null; }',
						'export function renderResults() {}',
						'export function debounce(fn) { return fn; }',
						'export function setIcon() {}',
						'export function normalizePath(p) { return String(p).replace(/\\\\+/g, "/"); }',
						'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
						'export function htmlToMarkdown() { return ""; }',
						'export function parseYaml() { return {}; }',
						'export function getAllTags() { return []; }',
						'export const Platform = { isDesktopApp: true, isMobileApp: false };',
						'export const moment = Object.assign(() => ({ format: () => "" }), { format: () => "" });',
					].join('\n'),
					loader: 'js',
				}));
			},
		},
	],
	outfile,
	logLevel: 'silent',
});

const { registerStaticCommands } = await import(pathToFileURL(outfile).href);

function makePlugin() {
	const entries = new Map();
	const enqueueCalls = [];
	const plugin = {
		manifest: { id: 'obsidian-crucible' },
		app: {},
		settings: {},
		registerCrucibleCommand: (entry) => entries.set(entry.id, entry),
		registerMoveFileCommands: () => {},
		orchestrator: {
			enqueue: async (...args) => { enqueueCalls.push(args); },
		},
	};
	return { plugin, entries, enqueueCalls };
}

test('search-rebuild-index is renamed to name the reset', () => {
	const { plugin, entries } = makePlugin();
	registerStaticCommands(plugin);
	const entry = entries.get('search-rebuild-index');
	assert.ok(entry, 'search-rebuild-index must still be registered');
	assert.equal(entry.name, 'Search: reset and rebuild index');
	assert.equal(entry.group, 'Search');
});

test('the non-destructive alternative command is still registered under its documented name', () => {
	const { plugin, entries } = makePlugin();
	registerStaticCommands(plugin);
	const entry = entries.get('search-embed-missing');
	assert.ok(entry, 'search-embed-missing must still be registered');
	assert.equal(entry.name, 'Search: embed missing vectors');
});

test('cancelling the confirm modal does not enqueue search_rebuild', async () => {
	const { plugin, entries, enqueueCalls } = makePlugin();
	registerStaticCommands(plugin);
	globalThis.__confirmModalResult = false;
	globalThis.__confirmModalCalls = [];
	await entries.get('search-rebuild-index').run();
	assert.equal(enqueueCalls.length, 0, 'cancelling must not enqueue the destructive job');
	assert.equal(globalThis.__confirmModalCalls.length, 1, 'the confirm modal must be shown exactly once');
});

test('confirming enqueues search_rebuild with the existing priority/lane', async () => {
	const { plugin, entries, enqueueCalls } = makePlugin();
	registerStaticCommands(plugin);
	globalThis.__confirmModalResult = true;
	globalThis.__confirmModalCalls = [];
	await entries.get('search-rebuild-index').run();
	assert.equal(enqueueCalls.length, 1, 'confirming must enqueue exactly once');
	assert.deepEqual(enqueueCalls[0], ['search_rebuild', {}, { priority: 'high', lane: 'user' }]);
});

test('the confirm copy names the reset and points at the non-destructive backfill command', async () => {
	const { plugin, entries } = makePlugin();
	registerStaticCommands(plugin);
	globalThis.__confirmModalResult = false;
	globalThis.__confirmModalCalls = [];
	await entries.get('search-rebuild-index').run();
	const options = globalThis.__confirmModalCalls[0];
	assert.ok(options, 'ConfirmModal must have been constructed with options');
	assert.match(options.message, /drops the entire search index/i);
	assert.match(options.message, /re-embeds everything/i);
	assert.match(options.message, /Search: embed missing vectors/);
	assert.equal(options.destructive, true, 'the reset is destructive styling, per the fleet pattern');
});
