// WP-PF1: computeOrphanedAttachmentRows had no test file of its own (same gap
// missingAttachments.test.mjs's header note calls out for its sibling module). Covers the
// pre-existing resolvedLinks-only behavior plus the fix this WP adds: unioning
// getFileCache(f).frontmatterLinks targets into the referenced set (src/ingestion/AGENTS.md's
// documented Orphaned-Attachments gap — a managed attachment referenced only from a
// frontmatter property, e.g. `cover:`, was falsely flagged orphaned). Same stub pattern as
// tests/missingAttachments.test.mjs: a real node_modules/obsidian so `App`/`TFile` line up
// with what the compiled module imports.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-orphaned-attachments-tests');
const outfile = path.join(outdir, 'orphanedAttachments.mjs');
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
		'export class TFile {}',
		'export class TFolder {}',
		'export class Editor {}',
		'export class MarkdownView {}',
		'export class Notice { constructor() {} }',
		'export const Platform = { isMobile: false, isMacOS: false };',
		'export const moment = Object.assign(() => ({ format: () => "2026-07-31" }), { format: () => "2026-07-31" });',
		'export function normalizePath(p) { return String(p).replace(/\\\\+/g, "/"); }',
		'export function requestUrl() { throw new Error("requestUrl not implemented in test stub"); }',
		'export function stringifyYaml(v) { return JSON.stringify(v); }',
		'export function parseYaml(s) { return JSON.parse(s); }',
		'',
	].join('\n'),
);

await esbuild.build({
	entryPoints: ['src/ingestion/data/orphanedAttachments.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	external: ['obsidian'],
	outfile,
	logLevel: 'silent',
});

const { TFile } = await import(pathToFileURL(obsidianEntry).href);
const { computeOrphanedAttachmentRows } = await import(pathToFileURL(outfile).href);

class FakeFile extends TFile {
	constructor(filePath, { size = 100, mtime = 0 } = {}) {
		super();
		this.path = filePath;
		this.name = filePath.replace(/^.*\//, '');
		this.basename = this.name.replace(/\.[^.]+$/, '');
		this.extension = (this.name.split('.').pop() ?? '').toLowerCase();
		const slash = filePath.lastIndexOf('/');
		this.parent = slash >= 0 ? { path: filePath.slice(0, slash) } : { path: '' };
		this.stat = { size, mtime };
	}
}

function makeApp({ files, resolvedLinks = {}, frontmatterLinksByPath = {}, dests = {} }) {
	const fileByPath = new Map(files.map(p => [p, new FakeFile(p)]));
	return {
		metadataCache: {
			resolvedLinks,
			getFileCache: file => {
				const fmLinks = frontmatterLinksByPath[file.path];
				return fmLinks ? { frontmatterLinks: fmLinks } : null;
			},
			getFirstLinkpathDest: (link) => (dests[link] ? fileByPath.get(dests[link]) ?? null : null),
		},
		vault: {
			getFiles: () => Array.from(fileByPath.values()),
		},
	};
}

test('computeOrphanedAttachmentRows: a managed attachment with no referrer at all is orphaned', () => {
	const app = makeApp({ files: ['attachments/a_MD5.png'], resolvedLinks: {} });
	const rows = computeOrphanedAttachmentRows(app);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].file.path, 'attachments/a_MD5.png');
	assert.equal(rows[0].type, 'images');
	assert.equal(rows[0].folder, 'attachments');
});

test('computeOrphanedAttachmentRows: a managed attachment referenced via resolvedLinks (embed/body link) is NOT orphaned', () => {
	const app = makeApp({
		files: ['notes/a.md', 'attachments/a_MD5.png'],
		resolvedLinks: { 'notes/a.md': { 'attachments/a_MD5.png': 1 } },
	});
	assert.deepEqual(computeOrphanedAttachmentRows(app), []);
});

test('computeOrphanedAttachmentRows: ignores non-managed files and non-localizable extensions', () => {
	const app = makeApp({ files: ['notes/a.md', 'plain-image.png', 'notes.txt'], resolvedLinks: {} });
	assert.deepEqual(computeOrphanedAttachmentRows(app), []);
});

/* ---------------------------------------- WP-PF1: frontmatterLinks union (the fix under test) */

test('computeOrphanedAttachmentRows: a managed attachment referenced ONLY from a frontmatter property is NOT orphaned', () => {
	const app = makeApp({
		files: ['notes/a.md', 'attachments/cover_MD5.png'],
		resolvedLinks: {}, // deliberately empty — resolvedLinks does NOT see frontmatter links
		frontmatterLinksByPath: { 'notes/a.md': [{ link: 'attachments/cover_MD5.png', key: 'cover', original: '[[attachments/cover_MD5.png]]' }] },
		dests: { 'attachments/cover_MD5.png': 'attachments/cover_MD5.png' },
	});
	assert.deepEqual(computeOrphanedAttachmentRows(app), [], 'a frontmatter-only referrer must union into the referenced set, not just resolvedLinks');
});

test('computeOrphanedAttachmentRows: a frontmatter link that fails to resolve to a real file does not spuriously mark anything referenced', () => {
	const app = makeApp({
		files: ['notes/a.md', 'attachments/cover_MD5.png'],
		resolvedLinks: {},
		frontmatterLinksByPath: { 'notes/a.md': [{ link: 'attachments/does-not-exist_MD5.png', key: 'cover', original: '' }] },
		dests: {}, // getFirstLinkpathDest resolves nothing
	});
	const rows = computeOrphanedAttachmentRows(app);
	assert.equal(rows.length, 1, 'the real attachment is still unreferenced -> still orphaned; the unresolved frontmatter link is simply skipped');
	assert.equal(rows[0].file.path, 'attachments/cover_MD5.png');
});

test('computeOrphanedAttachmentRows: a note with an empty frontmatterLinks array is handled without error', () => {
	const app = makeApp({
		files: ['notes/a.md', 'attachments/a_MD5.png'],
		resolvedLinks: {},
		frontmatterLinksByPath: { 'notes/a.md': [] },
	});
	const rows = computeOrphanedAttachmentRows(app);
	assert.equal(rows.length, 1);
});

test('computeOrphanedAttachmentRows: resolvedLinks and frontmatterLinks referrers compose — either one clears the orphan flag', () => {
	const app = makeApp({
		files: ['notes/a.md', 'notes/b.md', 'attachments/x_MD5.png', 'attachments/y_MD5.png'],
		resolvedLinks: { 'notes/a.md': { 'attachments/x_MD5.png': 1 } },
		frontmatterLinksByPath: { 'notes/b.md': [{ link: 'attachments/y_MD5.png', key: 'cover', original: '' }] },
		dests: { 'attachments/y_MD5.png': 'attachments/y_MD5.png' },
	});
	assert.deepEqual(computeOrphanedAttachmentRows(app), [], 'both attachments are referenced, one via each mechanism');
});
