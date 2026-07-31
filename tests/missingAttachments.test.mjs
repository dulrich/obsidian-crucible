// r2f-WP2: the "Missing localized attachments" dashboard section — inverse of Orphaned
// Attachments (data/orphanedAttachments.ts has no test file of its own; this is the first
// one for that data-layer pair). `managedAttachmentBasename` is the pure per-ref decision
// (decode → basename → MD5 match) factored out of `computeMissingAttachmentRows` so it can
// be driven directly against plain strings, per the module's own doc comment. Pure-function
// coverage below is the required part; the `computeMissingAttachmentRows` block that follows
// drives the real compiled module against a minimal mock App/TFile (same style as
// tests/linkGraph.test.mjs and tests/captureEmptyBodyGuard.test.mjs) and is best-effort.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-missing-attachments-tests');
const outfile = path.join(outdir, 'missingAttachments.mjs');
const obsidianDir = path.join(outdir, 'node_modules', 'obsidian');
const obsidianEntry = path.join(obsidianDir, 'index.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(obsidianDir, { recursive: true });

// `computeMissingAttachmentRows` itself only touches App/TFile at runtime, but it imports
// MD5_NAME_RE + planLocalAttachmentRepair (real values) from src/localizeAttachments.ts,
// which pulls in a handful of other 'obsidian' exports used only as parameter types
// elsewhere in that file (Editor, MarkdownView, Notice, TFolder, normalizePath,
// requestUrl) — unused here but esbuild still needs the specifiers to resolve. Written to
// a real node_modules/obsidian (external, not inlined) so `instanceof TFile` below checks
// against the SAME class the compiled module imports.
await writeFile(
	path.join(obsidianDir, 'package.json'),
	JSON.stringify({ name: 'obsidian', type: 'module', main: 'index.mjs' }),
);
await writeFile(
	obsidianEntry,
	[
		'export class App {}',
		'export class TFile {}',
		'export class TFolder {}',
		'export class Editor {}',
		'export class MarkdownView {}',
		'export class Notice { constructor() {} }',
		'export const Platform = { isMobile: false, isMacOS: false };',
		'export const moment = Object.assign(() => ({ format: () => "2026-07-30" }), { format: () => "2026-07-30" });',
		'export function normalizePath(p) { return String(p).replace(/\\\\+/g, "/"); }',
		'export function requestUrl() { throw new Error("requestUrl not implemented in test stub"); }',
		'export function stringifyYaml(v) { return JSON.stringify(v); }',
		'export function parseYaml(s) { return JSON.parse(s); }',
		'',
	].join('\n'),
);

await esbuild.build({
	entryPoints: ['src/ingestion/data/missingAttachments.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	external: ['obsidian'],
	outfile,
	logLevel: 'silent',
});

const { TFile } = await import(pathToFileURL(obsidianEntry).href);
const { managedAttachmentBasename, computeMissingAttachmentRows } = await import(pathToFileURL(outfile).href);

// makeApp's getFirstLinkpathDest below is intentionally strict (exact string key match) so
// these decode tests fail loudly if computeMissingAttachmentRows ever probes with the raw,
// undecoded ref.link again instead of the normalized target.

/* ------------------------------------------------------------- managedAttachmentBasename */

test('managedAttachmentBasename: matches a plain managed attachment name', () => {
	assert.equal(managedAttachmentBasename('deadbeef1234_MD5.png'), 'deadbeef1234_MD5.png');
});

test('managedAttachmentBasename: strips a folder prefix down to the basename', () => {
	assert.equal(managedAttachmentBasename('notes/_attachments/a/deadbeef1234_MD5.png'), 'deadbeef1234_MD5.png');
});

test('managedAttachmentBasename: %20-decodes a folder prefix before taking the basename', () => {
	assert.equal(managedAttachmentBasename('sub%20folder/deadbeef1234_MD5.png'), 'deadbeef1234_MD5.png');
});

test('managedAttachmentBasename: strips a #subpath fragment', () => {
	assert.equal(managedAttachmentBasename('deadbeef1234_MD5.png#page=2'), 'deadbeef1234_MD5.png');
});

test('managedAttachmentBasename: strips a |alias suffix', () => {
	assert.equal(managedAttachmentBasename('deadbeef1234_MD5.png|My Alias'), 'deadbeef1234_MD5.png');
});

test('managedAttachmentBasename: a malformed %-escape does not throw, and still resolves the basename', () => {
	assert.doesNotThrow(() => managedAttachmentBasename('folder%zz/deadbeef1234_MD5.png'));
	assert.equal(managedAttachmentBasename('folder%zz/deadbeef1234_MD5.png'), 'deadbeef1234_MD5.png');
});

test('managedAttachmentBasename: returns null for a ref that is not a managed attachment name', () => {
	assert.equal(managedAttachmentBasename('notes/plain-image.png'), null);
	assert.equal(managedAttachmentBasename('notes/other-note.md'), null);
});

test('managedAttachmentBasename: returns null for an empty ref', () => {
	assert.equal(managedAttachmentBasename(''), null);
});

/* ------------------------------------------------------ computeMissingAttachmentRows (best-effort) */

class FakeFile extends TFile {
	constructor(filePath) {
		super();
		this.path = filePath;
		this.basename = filePath.replace(/\.md$/, '').replace(/^.*\//, '');
		this.extension = 'md';
	}
}

function makeApp({ notes, resolvedDests, files }) {
	return {
		metadataCache: {
			getFileCache: file => notes.get(file.path)?.cache ?? null,
			getFirstLinkpathDest: link => (resolvedDests.has(link) ? new FakeFile(resolvedDests.get(link)) : null),
		},
		vault: {
			getMarkdownFiles: () => Array.from(notes.values()).map(n => n.file),
			getFiles: () => files.map(p => new FakeFile(p)),
		},
	};
}

test('computeMissingAttachmentRows: flags a broken managed-attachment ref and leaves a resolved one alone', () => {
	const noteA = new FakeFile('notes/a.md');
	const noteC = new FakeFile('notes/c.md');
	const notes = new Map([
		['notes/a.md', { file: noteA, cache: { embeds: [{ link: 'attachments/a/deadbeef_MD5.png', original: '' }], links: [] } }],
		['notes/c.md', { file: noteC, cache: { embeds: [{ link: 'ok_MD5.png', original: '' }], links: [] } }],
	]);
	const resolvedDests = new Map([['ok_MD5.png', 'attachments/c/ok_MD5.png']]);
	const app = makeApp({ notes, resolvedDests, files: ['attachments/a/deadbeef_MD5.png', 'attachments/c/ok_MD5.png'] });
	const localizer = { attachmentFolderForNote: note => `attachments/${note.basename}` };

	const rows = computeMissingAttachmentRows(app, localizer);
	assert.equal(rows.length, 1, 'only the broken ref produces a row');
	assert.equal(rows[0].note.path, 'notes/a.md');
	assert.equal(rows[0].link, 'attachments/a/deadbeef_MD5.png');
	assert.equal(rows[0].repairable, true, 'the file already sits at the expected folder, so a repair target exists');
});

test('computeMissingAttachmentRows: ignores broken refs that are not managed attachment names', () => {
	const noteA = new FakeFile('notes/a.md');
	const notes = new Map([
		['notes/a.md', { file: noteA, cache: { embeds: [], links: [{ link: 'notes/missing-note.md', original: '' }] } }],
	]);
	const app = makeApp({ notes, resolvedDests: new Map(), files: [] });
	const localizer = { attachmentFolderForNote: () => 'attachments/a' };

	assert.deepEqual(computeMissingAttachmentRows(app, localizer), []);
});

test('computeMissingAttachmentRows: deduplicates an identical (note, link) pair seen via both embeds and links', () => {
	const noteA = new FakeFile('notes/a.md');
	const ref = { link: 'attachments/a/deadbeef_MD5.png', original: '' };
	const notes = new Map([
		['notes/a.md', { file: noteA, cache: { embeds: [ref], links: [ref] } }],
	]);
	const app = makeApp({ notes, resolvedDests: new Map(), files: [] });
	const localizer = { attachmentFolderForNote: () => 'attachments/a' };

	const rows = computeMissingAttachmentRows(app, localizer);
	assert.equal(rows.length, 1, 'the same (note, link) pair from embeds and links collapses to one row');
});

test('computeMissingAttachmentRows: repairable is false when no safe repair target can be found', () => {
	const noteB = new FakeFile('notes/b.md');
	const notes = new Map([
		['notes/b.md', { file: noteB, cache: { embeds: [{ link: 'somewhere/cafebabe_MD5.jpg', original: '' }], links: [] } }],
	]);
	// Nothing in the vault matches the basename at all — planLocalAttachmentRepair returns null.
	const app = makeApp({ notes, resolvedDests: new Map(), files: ['unrelated/file.png'] });
	const localizer = { attachmentFolderForNote: () => 'attachments/b' };

	const rows = computeMissingAttachmentRows(app, localizer);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].repairable, false);
});

// WP-VF-2d: `repairable` is computed via planLocalAttachmentRepair, which now recovers a
// truncated (spliced) broken basename via a unique prefix match — this row's repairable
// flag must follow that automatically, with no changes needed in this scan module itself.
test('computeMissingAttachmentRows: repairable is true for a truncated ref that uniquely prefix-matches a real managed attachment', () => {
	const noteD = new FakeFile('notes/d.md');
	const notes = new Map([
		['notes/d.md', { file: noteD, cache: { embeds: [{ link: 'somewhere/abcdef12_MD5.pn', original: '' }], links: [] } }],
	]);
	const app = makeApp({ notes, resolvedDests: new Map(), files: ['attachments/d/abcdef1234567890_MD5.png'] });
	const localizer = { attachmentFolderForNote: () => 'attachments/d' };

	const rows = computeMissingAttachmentRows(app, localizer);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].repairable, true, 'the 8-char hash prefix uniquely identifies the real (untruncated) attachment');
});

// A ref that also carries `_MD5.ext` shape but shares its short prefix with two vault
// candidates must still report unrepairable — ambiguity does not become a guess.
test('computeMissingAttachmentRows: repairable stays false when a truncated ref prefix-matches more than one candidate', () => {
	const noteE = new FakeFile('notes/e.md');
	const notes = new Map([
		['notes/e.md', { file: noteE, cache: { embeds: [{ link: 'somewhere/abcdef12_MD5.pn', original: '' }], links: [] } }],
	]);
	const app = makeApp({
		notes,
		resolvedDests: new Map(),
		files: ['attachments/e/abcdef1234567890_MD5.png', 'attachments/e2/abcdef12ffffffffff_MD5.png'],
	});
	const localizer = { attachmentFolderForNote: () => 'attachments/e' };

	const rows = computeMissingAttachmentRows(app, localizer);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].repairable, false);
});

/* --------------------------------------------- WP-PF1: decode before the getFirstLinkpathDest probe */

test('computeMissingAttachmentRows: a %20-encoded markdown ref that Obsidian resolves is NOT flagged missing', () => {
	const noteF = new FakeFile('notes/f.md');
	const notes = new Map([
		['notes/f.md', { file: noteF, cache: { embeds: [], links: [{ link: 'attachments/my%20folder/a_MD5.pdf', original: '[doc](attachments/my%20folder/a_MD5.pdf)' }] } }],
	]);
	// The mock's getFirstLinkpathDest is keyed on the exact decoded target — resolving only
	// when the probe passes the DECODED form, not the raw %20 text.
	const resolvedDests = new Map([['attachments/my folder/a_MD5.pdf', 'attachments/my folder/a_MD5.pdf']]);
	const app = makeApp({ notes, resolvedDests, files: ['attachments/my folder/a_MD5.pdf'] });
	const localizer = { attachmentFolderForNote: () => 'attachments/f' };

	assert.deepEqual(computeMissingAttachmentRows(app, localizer), [], 'the ref resolves once decoded, so it must not appear as a missing row');
});

test('computeMissingAttachmentRows: an angle-bracket-wrapped ref target that Obsidian resolves is NOT flagged missing', () => {
	const noteG = new FakeFile('notes/g.md');
	const notes = new Map([
		['notes/g.md', { file: noteG, cache: { embeds: [], links: [{ link: '<attachments/a_MD5.pdf>', original: '[doc](<attachments/a_MD5.pdf>)' }] } }],
	]);
	const resolvedDests = new Map([['attachments/a_MD5.pdf', 'attachments/a_MD5.pdf']]);
	const app = makeApp({ notes, resolvedDests, files: ['attachments/a_MD5.pdf'] });
	const localizer = { attachmentFolderForNote: () => 'attachments/g' };

	assert.deepEqual(computeMissingAttachmentRows(app, localizer), [], 'the angle-bracket wrapper must be stripped before the resolve probe');
});

test('computeMissingAttachmentRows: a genuinely broken encoded ref is still flagged missing (the decode fix is not a false-negative machine)', () => {
	const noteH = new FakeFile('notes/h.md');
	const notes = new Map([
		['notes/h.md', { file: noteH, cache: { embeds: [], links: [{ link: 'attachments/my%20folder/gone_MD5.pdf', original: '' }] } }],
	]);
	const app = makeApp({ notes, resolvedDests: new Map(), files: [] });
	const localizer = { attachmentFolderForNote: () => 'attachments/h' };

	const rows = computeMissingAttachmentRows(app, localizer);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].link, 'attachments/my%20folder/gone_MD5.pdf', 'the row keeps the RAW ref.link for display — only the resolve probe is normalized');
});
