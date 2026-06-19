import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-auto-localize-tests');
const outfile = path.join(outdir, 'main.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/main.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: [
					'export class App {}',
					'export class AbstractInputSuggest {}',
					'export class Editor {}',
					'export class ExtraButtonComponent {}',
					'export class FileSystemAdapter {}',
					'export class FuzzySuggestModal {}',
					'export class ItemView {}',
					'export class MarkdownView {}',
					'export class Modal { constructor() {} open() {} close() {} }',
					'export class Notice { constructor() {} hide() {} setMessage() {} }',
					'export class Plugin { register() {} registerEvent() {} addCommand() {} addRibbonIcon() {} registerView() {} }',
					'export class PluginSettingTab {}',
					'export class Setting {}',
					'export class SuggestModal {}',
					'export class TAbstractFile {}',
					'export class TFile extends TAbstractFile {}',
					'export class TFolder extends TAbstractFile {}',
					'export class TextComponent {}',
					'export class WorkspaceLeaf {}',
					'export const Platform = { isDesktopApp: true, isMobileApp: false, isMacOS: false };',
					'export function debounce(fn) { return fn; }',
					'export function getAllTags() { return []; }',
					'export function htmlToMarkdown(html) { return String(html); }',
					'export function moment() { return { format() { return "2026-06-17"; }, startOf() { return this; }, endOf() { return this; }, add() { return this; }, subtract() { return this; }, clone() { return this; }, isSame() { return false; }, isBefore() { return false; }, toDate() { return new Date(); }, valueOf() { return Date.now(); } }; }',
					'export function normalizePath(p) { return String(p).replace(/\\/+/g, "/"); }',
					'export function parseYaml() { return {}; }',
					'export function prepareFuzzySearch() { return () => null; }',
					'export function renderResults() {}',
					'export function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
					'export function setIcon() {}',
					'globalThis.__ObsidianTFile = TFile;',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { default: CruciblePlugin } = await import(pathToFileURL(outfile).href);

function makeFile(path, size = 0) {
	const file = new globalThis.__ObsidianTFile();
	file.path = path;
	file.extension = 'md';
	file.stat = { size };
	return file;
}

function makePlugin(files, settings = {}) {
	const calls = [];
	const plugin = Object.create(CruciblePlugin.prototype);
	plugin.settings = {
		localizeAttachmentsTriggerOnCreate: true,
		localizeAttachmentsTriggerOnEdit: true,
		...settings,
	};
	plugin.autoLocalizeTimers = new Map();
	plugin.app = {
		vault: {
			getAbstractFileByPath: (path) => files.get(path) ?? null,
		},
	};
	plugin.noteLocks = { isLocked: () => false };
	plugin.isMaterializing = false;
	plugin.attachmentLocalizer = {
		localizeNote: async (file, silent) => {
			calls.push({ path: file.path, silent });
			return true;
		},
	};
	return { plugin, calls };
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('create-trigger localization waits for an initially empty clipped note to receive content', async () => {
	const file = makeFile('daily/day/2026-06-17/clip.md', 0);
	const files = new Map([[file.path, file]]);
	const { plugin, calls } = makePlugin(files, { localizeAttachmentsTriggerOnEdit: false });

	plugin.scheduleAutoLocalize(file, 'create', 10);
	file.stat.size = 1024;
	await sleep(30);

	assert.deepEqual(calls, [{ path: file.path, silent: true }]);
	plugin.clearAutoLocalizeTimers();
});

test('scheduled localization follows a note rename before it runs', async () => {
	const oldPath = 'Clippings/clip.md';
	const newPath = 'daily/day/2026-06-17/clip.md';
	const file = makeFile(oldPath, 500);
	const files = new Map([[oldPath, file]]);
	const { plugin, calls } = makePlugin(files, { localizeAttachmentsTriggerOnEdit: false });

	plugin.scheduleAutoLocalize(file, 'create', 50);
	files.delete(oldPath);
	file.path = newPath;
	files.set(newPath, file);
	plugin.moveAutoLocalizeTimer(oldPath, newPath);
	const movedState = plugin.autoLocalizeTimers.get(newPath);
	assert.ok(movedState, 'pending localize timer should move to the renamed path');
	if (movedState.timer) clearTimeout(movedState.timer);
	movedState.timer = null;
	await plugin.runScheduledAutoLocalize(movedState);

	assert.deepEqual(calls, [{ path: newPath, silent: true }]);
	plugin.clearAutoLocalizeTimers();
});

test('locked edit-trigger localization is retried instead of dropped', async () => {
	const file = makeFile('daily/day/2026-06-17/clip.md', 500);
	const files = new Map([[file.path, file]]);
	const { plugin, calls } = makePlugin(files, { localizeAttachmentsTriggerOnCreate: false });
	let locked = true;
	plugin.noteLocks = { isLocked: () => locked };
	const state = {
		path: file.path,
		sources: new Set(['edit']),
		firstScheduledAt: Date.now(),
		attempts: 0,
		timer: null,
	};

	await plugin.runScheduledAutoLocalize(state);
	assert.equal(calls.length, 0);
	const retry = plugin.autoLocalizeTimers.get(file.path);
	assert.ok(retry, 'locked note should be rescheduled');
	if (retry.timer) clearTimeout(retry.timer);
	retry.timer = null;

	locked = false;
	await plugin.runScheduledAutoLocalize(retry);
	assert.deepEqual(calls, [{ path: file.path, silent: true }]);
	plugin.clearAutoLocalizeTimers();
});
