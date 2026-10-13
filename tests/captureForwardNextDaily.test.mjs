import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// capture-forward-next-daily WP-1: the 'daily-next' capture target, its pure date resolver,
// the no-open materialize path + isMaterializing guard, and mark-as-forwarded persistence.
// Same stub pattern as tests/captureEmptyBodyGuard.test.mjs: a real node_modules/obsidian
// next to the bundle (left external) so `instanceof TFile` / `MarkdownView` match. The stub
// re-exports the repo's real moment so strict date parsing is exercised for real.

const require = createRequire(import.meta.url);
const momentUrl = pathToFileURL(require.resolve('moment')).href;

const outdir = path.join(tmpdir(), 'obsidian-crucible-capture-forward-next-daily-tests');
const obsidianDir = path.join(outdir, 'node_modules', 'obsidian');
const obsidianEntry = path.join(obsidianDir, 'index.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(obsidianDir, { recursive: true });
await writeFile(path.join(obsidianDir, 'package.json'), JSON.stringify({ name: 'obsidian', type: 'module', main: 'index.mjs' }));
await writeFile(
	obsidianEntry,
	[
		`import momentDefault from ${JSON.stringify(momentUrl)};`,
		'export const moment = momentDefault;',
		'export class App {}',
		'export class Modal { constructor(app) { this.app = app; } }',
		'export const notices = [];',
		'export class Notice { constructor(msg) { notices.push(msg); } }',
		'export class TFile {}',
		'export class TFolder {}',
		'export class MarkdownView {}',
		'export class TextComponent { constructor(el) { this.el = el; } }',
		'export const Platform = { isMacOS: false };',
		'export function normalizePath(p) { return String(p); }',
		'',
	].join('\n'),
);

for (const name of ['captures', 'materialize', 'markForwarded']) {
	await esbuild.build({
		entryPoints: [`src/${name}.ts`],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'es2020',
		external: ['obsidian'],
		outfile: path.join(outdir, `${name}.mjs`),
		logLevel: 'silent',
	});
}

const obsidian = await import(pathToFileURL(obsidianEntry).href);
const { TFile, TFolder, MarkdownView, moment } = obsidian;
globalThis.window = { moment };
const { CaptureManager, resolveNextDailyDate } = await import(pathToFileURL(path.join(outdir, 'captures.mjs')).href);
const { markEditorLineForwarded } = await import(pathToFileURL(path.join(outdir, 'markForwarded.mjs')).href);
const { Materializer } = await import(pathToFileURL(path.join(outdir, 'materialize.mjs')).href);

const FMT = 'YYYY-MM-DD';
const NOW = moment('2026-10-13 15:30', 'YYYY-MM-DD HH:mm');
const fmt = (m) => m.format(FMT);

class FakeFile extends TFile {
	constructor(filePath, content = '') {
		super();
		this.path = filePath;
		this.extension = 'md';
		this.basename = filePath.split('/').pop().replace(/\.md$/, '');
		this.stat = { size: content.length };
	}
}

test('resolver: source = today -> tomorrow', () => {
	assert.equal(fmt(resolveNextDailyDate('2026-10-13', FMT, NOW)), '2026-10-14');
});

test('resolver: past source -> today', () => {
	assert.equal(fmt(resolveNextDailyDate('2026-10-01', FMT, NOW)), '2026-10-13');
	assert.equal(fmt(resolveNextDailyDate('2026-10-12', FMT, NOW)), '2026-10-13');
});

test('resolver: future source -> source + 1', () => {
	assert.equal(fmt(resolveNextDailyDate('2026-10-20', FMT, NOW)), '2026-10-21');
});

test('resolver: non-daily or absent basename -> tomorrow', () => {
	assert.equal(fmt(resolveNextDailyDate('Project notes', FMT, NOW)), '2026-10-14');
	assert.equal(fmt(resolveNextDailyDate('2026-10-20 extra', FMT, NOW)), '2026-10-14', 'strict parse');
	assert.equal(fmt(resolveNextDailyDate(undefined, FMT, NOW)), '2026-10-14');
});

test('resolver: month and year rollover', () => {
	const late = moment('2026-12-31 09:00', 'YYYY-MM-DD HH:mm');
	assert.equal(fmt(resolveNextDailyDate('2026-12-31', FMT, late)), '2027-01-01');
	const oct = moment('2026-10-31 09:00', 'YYYY-MM-DD HH:mm');
	assert.equal(fmt(resolveNextDailyDate('2026-10-31', FMT, oct)), '2026-11-01');
});

function makeEnv(initialFiles) {
	const files = new Map(Object.entries(initialFiles).map(([p, c]) => [p, { file: new FakeFile(p, c), content: c }]));
	const state = { flag: false, flagAtModify: [], modified: [], leafOpened: 0, materializeCalls: [] };
	const app = {
		vault: {
			getAbstractFileByPath: (p) => files.get(p)?.file ?? (p === 'daily' ? Object.assign(new TFolder(), { path: p }) : null),
			read: async (f) => files.get(f.path).content,
			modify: async (f, c) => {
				state.flagAtModify.push(state.flag);
				state.modified.push(f.path);
				files.get(f.path).content = c;
			},
			create: async (p, c) => {
				files.set(p, { file: new FakeFile(p, c), content: c });
			},
			createFolder: async () => {},
		},
		workspace: {
			getLeaf: () => ({ openFile: async () => { state.leafOpened++; } }),
			getActiveFile: () => null,
		},
	};
	return { app, files, state };
}

const settings = { dailyEnabled: true, dailyFolder: 'daily', dailyTemplate: '' };
const capture = {
	name: 'Forward',
	targetType: 'daily-next',
	source: 'line',
	file: '',
	targetSectionMode: 'fixed',
	targetSection: '',
	content: '- [ ] {{value}} ({{date}})',
	writeMode: 'append',
};

test('executeCapture daily-next: absent target is materialized without opening a leaf, write stays guarded', async () => {
	const { app, files, state } = makeEnv({ 'daily/2026-10-13.md': '- [ ] task' });
	const setFlag = (v) => { state.flag = v; };
	const real = new Materializer(app, settings, setFlag);
	const materializer = {
		materializeDay: async (date, opts) => {
			state.materializeCalls.push({ date: fmt(date), opts });
			return real.materializeDay(date, opts);
		},
	};
	const manager = new CaptureManager(app, settings, setFlag, materializer);
	const source = files.get('daily/2026-10-13.md').file;

	const ok = await manager.executeCapture(capture, 'task', source, { sourceFile: source });

	assert.equal(ok, true);
	const today = moment();
	const expected = fmt(resolveNextDailyDate('2026-10-13', FMT, today));
	assert.deepEqual(state.materializeCalls, [{ date: expected, opts: { open: false } }]);
	assert.equal(state.leafOpened, 0, 'no leaf opened');
	assert.deepEqual(state.modified, [`daily/${expected}.md`]);
	assert.deepEqual(state.flagAtModify, [true], 'isMaterializing true at the target write');
	assert.equal(state.flag, false, 'flag cleared afterwards');
	assert.equal(files.get(`daily/${expected}.md`).content, `- [ ] task (${expected})`, '{{date}} is the target date');
});

test('executeCapture daily-next: existing target is not re-materialized; flag cleared on throw', async () => {
	const tomorrow = fmt(moment().add(1, 'day'));
	const { app, state } = makeEnv({ [`daily/${tomorrow}.md`]: 'existing' });
	const setFlag = (v) => { state.flag = v; };
	let calls = 0;
	const manager = new CaptureManager(app, settings, setFlag, { materializeDay: async () => { calls++; return true; } });
	assert.equal(await manager.executeCapture(capture, 'x', undefined, {}), true);
	assert.equal(calls, 0);
	assert.equal(state.flag, false);

	app.vault.modify = async () => { throw new Error('boom'); };
	assert.equal(await manager.executeCapture(capture, 'x', undefined, {}), false);
	assert.equal(state.flag, false, 'flag cleared on the throw path');
});

test('real Materializer: default still opens the note', async () => {
	const { app, state } = makeEnv({});
	const m = new Materializer(app, settings, () => {});
	assert.equal(await m.materializeDay(moment('2026-10-20', FMT)), true);
	assert.equal(state.leafOpened, 1);
});

function makeEditor(lines, line) {
	const ed = {
		lines: [...lines],
		getCursor: () => ({ line, ch: 0 }),
		getLine: (n) => ed.lines[n],
		setLine: (n, t) => { ed.lines[n] = t; },
		setCursor: () => {},
	};
	return ed;
}

test('mark-as-forwarded: saves the owning MarkdownView so disk carries [>]', async () => {
	const editor = makeEditor(['# h', '- [ ] carry me'], 1);
	let disk = '# h\n- [ ] carry me';
	const view = Object.assign(new MarkdownView(), { editor, save: async () => { disk = editor.lines.join('\n'); } });
	const app = { workspace: { iterateAllLeaves: (cb) => cb({ view }) }, vault: {} };
	assert.equal(await markEditorLineForwarded(app, editor, null), true);
	assert.equal(disk, '# h\n- [>] carry me');
});

test('mark-as-forwarded: no owning view -> vault.process writes the line; non-checkbox -> false', async () => {
	const editor = makeEditor(['- [ ] a', 'plain'], 0);
	let disk = '- [ ] a\nplain';
	const file = new FakeFile('n.md', disk);
	const app = {
		workspace: { iterateAllLeaves: () => {} },
		vault: { process: async (_f, fn) => { disk = fn(disk); } },
	};
	assert.equal(await markEditorLineForwarded(app, editor, file), true);
	assert.equal(disk, '- [>] a\nplain');
	assert.equal(await markEditorLineForwarded(app, makeEditor(['plain'], 0), file), false);
});
