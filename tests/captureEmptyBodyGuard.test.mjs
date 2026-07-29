import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Covers idh-WP-3 scope (d): CaptureManager.executeCapture's empty-body guard. The original
// guard (`if (!contentRaw) return true;`) runs BEFORE frontmatter stripping, so a capture
// whose resolved template is YAML-only (e.g. a template that only sets frontmatter
// properties, with no body content) passes it — contentRaw is non-empty — and then strips to
// an empty `content` after `contentRaw.replace(FRONTMATTER_REGEX, '').trim()`. For
// `writeMode: 'replace'` that used to still call `vault.modify`, blanking the note's existing
// body. The fix adds a second guard, evaluated on the post-strip `content`, that no-ops
// (returns true, same shape as the original guard) specifically for `writeMode: 'replace'` —
// other write modes are unaffected since they can't destroy existing content the same way.
// This drives the REAL CaptureManager.executeCapture / applyTemplateString / insertIntoSection
// wiring (not a mirror) against a minimal hand-rolled Obsidian stub.
//
// `executeCapture` does `file instanceof TFile`, so — unlike the other WP-3 test files, which
// inline the obsidian stub via an esbuild virtual module (making its classes inaccessible
// outside the bundle) — this stub is written to a real `node_modules/obsidian` next to the
// bundle output and left external, so the test can import the exact same module instance
// (same resolved file URL => Node's module cache treats it as one singleton) and construct a
// real `TFile` the production code will recognize.

const outdir = path.join(tmpdir(), 'obsidian-crucible-capture-empty-body-guard-tests');
const outfile = path.join(outdir, 'captures.mjs');
const obsidianDir = path.join(outdir, 'node_modules', 'obsidian');
const obsidianEntry = path.join(obsidianDir, 'index.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(obsidianDir, { recursive: true });

await writeFile(
	path.join(obsidianDir, 'package.json'),
	JSON.stringify({ name: 'obsidian', type: 'module', main: 'index.mjs' }),
);
await writeFile(
	obsidianEntry,
	[
		'export class App {}',
		'export class Modal { constructor(app) { this.app = app; } }',
		'export class Notice { constructor() {} }',
		'export class TFile {}',
		'export class TFolder {}',
		'export class TextComponent { constructor(el) { this.el = el; } }',
		'export const Platform = { isMacOS: false };',
		'export function normalizePath(path) { return String(path).replace(/\\\\+/g, "/"); }',
		'export const moment = Object.assign(() => ({ format: () => "2026-07-27" }), { format: () => "2026-07-27" });',
		'',
	].join('\n'),
);

await esbuild.build({
	entryPoints: ['src/captures.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	external: ['obsidian'],
	outfile,
	logLevel: 'silent',
});

// applyTemplateString reads window.moment() directly (src/utils.ts), independent of the
// `moment` import used for typing — mirrors the fakeMoment pattern in
// tests/templateTokens.test.mjs.
globalThis.window = { moment: () => ({ format: (fmt) => (fmt === 'YYYY-MM-DD' ? '2026-07-29' : '00:00') }) };

const { TFile } = await import(pathToFileURL(obsidianEntry).href);
const { CaptureManager } = await import(pathToFileURL(outfile).href);

class FakeFile extends TFile {
	constructor(filePath) {
		super();
		this.path = filePath;
		this.extension = 'md';
		this.basename = filePath.replace(/\.md$/, '');
	}
}

function makeApp({ content }) {
	const state = { content, modifyCalls: [] };
	const file = new FakeFile('note.md');
	const app = {
		vault: {
			getAbstractFileByPath: (p) => (p === file.path ? file : null),
			read: async () => state.content,
			modify: async (_file, newContent) => {
				state.modifyCalls.push(newContent);
				state.content = newContent;
			},
		},
	};
	return { app, state, file };
}

function baseCapture(overrides = {}) {
	return {
		name: 'Test capture',
		targetType: 'active',
		source: 'dialog',
		file: '',
		targetSectionMode: 'fixed',
		targetSection: '', // no section target: exercises the whole-note branch
		content: '',
		writeMode: 'replace',
		...overrides,
	};
}

function baseSettings() {
	return {}; // getPeriodConfigByTarget('active', settings) short-circuits before reading settings keys
}

test('a YAML-only capture value is a no-op for writeMode "replace" (no vault.modify call)', async () => {
	const existing = '---\ntitle: note\n---\n\nOriginal body, must survive untouched.';
	const { app, state, file } = makeApp({ content: existing });
	const manager = new CaptureManager(app, baseSettings(), () => {});

	const capture = baseCapture({
		content: '---\ncaptured: true\n---\n', // resolves to YAML-only after templating
		writeMode: 'replace',
	});

	const ok = await manager.executeCapture(capture, '', file);

	assert.equal(ok, true, 'a YAML-only replace capture reports success');
	assert.deepEqual(state.modifyCalls, [], 'vault.modify is never called — the body is not blanked');
	assert.equal(state.content, existing, 'the note content is byte-identical to before the capture');
});

test('a normal (non-empty) capture value still writes for writeMode "replace" (unchanged behavior)', async () => {
	const existing = '---\ntitle: note\n---\n\nOriginal body.';
	const { app, state, file } = makeApp({ content: existing });
	const manager = new CaptureManager(app, baseSettings(), () => {});

	const capture = baseCapture({
		content: 'Fresh replacement body.',
		writeMode: 'replace',
	});

	const ok = await manager.executeCapture(capture, '', file);

	assert.equal(ok, true);
	assert.equal(state.modifyCalls.length, 1, 'vault.modify fires exactly once for a genuine replace');
	assert.match(state.content, /Fresh replacement body\./, 'the new body actually landed');
});

test('a YAML-only capture value still writes for writeMode "append" (other write modes unaffected)', async () => {
	const existing = '---\ntitle: note\n---\n\nOriginal body.';
	const { app, state, file } = makeApp({ content: existing });
	const manager = new CaptureManager(app, baseSettings(), () => {});

	const capture = baseCapture({
		content: '---\ncaptured: true\n---\n', // resolves to YAML-only after templating
		writeMode: 'append',
	});

	const ok = await manager.executeCapture(capture, '', file);

	assert.equal(ok, true);
	assert.equal(state.modifyCalls.length, 1, 'append is not gated by the new replace-only guard');
});
