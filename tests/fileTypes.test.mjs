import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-file-types-tests');
const fileTypesOutfile = path.join(outdir, 'fileTypes.mjs');
const chunkerOutfile = path.join(outdir, 'chunker.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await Promise.all([
	esbuild.build({
		entryPoints: ['src/fileTypes.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'es2020',
		outfile: fileTypesOutfile,
		logLevel: 'silent',
	}),
	esbuild.build({
		entryPoints: ['src/search/chunker.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'es2020',
		outfile: chunkerOutfile,
		logLevel: 'silent',
	}),
]);

const {
	ALL_CATALOG_EXTENSIONS,
	FILE_TYPE_CATALOG,
	TEXT_EXTRACTABLE_CATEGORIES,
	commitSelectedExtensions,
	deriveFileTypeGroups,
	resolveSelectedExtensions,
} = await import(pathToFileURL(fileTypesOutfile).href);

const { isSearchIndexablePath } = await import(pathToFileURL(chunkerOutfile).href);

/* -------------------------------------------------------------------------- */
/* catalog well-formedness                                                    */
/* -------------------------------------------------------------------------- */

test('the static catalog has no duplicate extension across categories', () => {
	const seen = new Set();
	const duplicates = [];
	for (const group of FILE_TYPE_CATALOG) {
		for (const ext of group.extensions) {
			if (seen.has(ext)) duplicates.push(ext);
			seen.add(ext);
		}
	}
	assert.deepEqual(duplicates, []);
});

test('every catalog extension is lowercase with no leading dot', () => {
	for (const group of FILE_TYPE_CATALOG) {
		for (const ext of group.extensions) {
			assert.equal(ext, ext.toLowerCase(), `${ext} in ${group.category} is not lowercase`);
			assert.ok(!ext.startsWith('.'), `${ext} in ${group.category} has a leading dot`);
			assert.ok(ext.length > 0, `${group.category} has an empty extension entry`);
		}
	}
});

test('ALL_CATALOG_EXTENSIONS is the flattened catalog', () => {
	const expected = FILE_TYPE_CATALOG.flatMap((g) => g.extensions);
	assert.deepEqual(Array.from(ALL_CATALOG_EXTENSIONS), expected);
});

test('every text-extractable category actually exists in the catalog', () => {
	const categories = new Set(FILE_TYPE_CATALOG.map((g) => g.category));
	for (const category of TEXT_EXTRACTABLE_CATEGORIES) {
		assert.ok(categories.has(category), `${category} is not a catalog category`);
	}
	// Set B's whole reason for existing: image/audio/video/pdf/base are NOT offered.
	assert.ok(!TEXT_EXTRACTABLE_CATEGORIES.includes('Images'));
	assert.ok(!TEXT_EXTRACTABLE_CATEGORIES.includes('Audio'));
	assert.ok(!TEXT_EXTRACTABLE_CATEGORIES.includes('Video'));
	assert.ok(!TEXT_EXTRACTABLE_CATEGORIES.includes('PDF'));
	assert.ok(!TEXT_EXTRACTABLE_CATEGORIES.includes('Base'));
});

/* -------------------------------------------------------------------------- */
/* deriveFileTypeGroups — the app-taking derivation                           */
/* -------------------------------------------------------------------------- */

function fakeApp({ viewRegistry, files = [] } = {}) {
	return {
		viewRegistry,
		vault: {
			getFiles: () => files.map((extension) => ({ extension })),
		},
	};
}

test('registry-derivation falls back cleanly when app.viewRegistry is absent', () => {
	const app = fakeApp({ viewRegistry: undefined });
	assert.doesNotThrow(() => deriveFileTypeGroups(app));
	const groups = deriveFileTypeGroups(app);
	const flat = groups.flatMap((g) => g.extensions).sort();
	assert.deepEqual(flat, Array.from(ALL_CATALOG_EXTENSIONS).sort());
});

test('registry-derivation falls back cleanly when typeByExtension is malformed', () => {
	const malformed = [
		fakeApp({ viewRegistry: {} }),
		fakeApp({ viewRegistry: { typeByExtension: null } }),
		fakeApp({ viewRegistry: { typeByExtension: 'not-an-object' } }),
		{ viewRegistry: { get typeByExtension() { throw new Error('boom'); } }, vault: { getFiles: () => [] } },
	];
	for (const app of malformed) {
		assert.doesNotThrow(() => deriveFileTypeGroups(app));
	}
});

test('vault-present extensions are unioned in even when absent from the catalog and registry', () => {
	const app = fakeApp({ viewRegistry: undefined, files: ['md', 'weird-ext', 'md'] });
	const groups = deriveFileTypeGroups(app);
	const flat = groups.flatMap((g) => g.extensions);
	assert.ok(flat.includes('weird-ext'), 'vault-only extension must be reachable');
	const other = groups.find((g) => g.category === 'Other');
	assert.ok(other, 'an uncategorized extension should land in an Other bucket');
	assert.deepEqual(other.extensions, ['weird-ext']);
});

test('registry extensions are bucketed by their reported view type, not dumped into Other', () => {
	const app = fakeApp({
		viewRegistry: { typeByExtension: { epub: 'image', md: 'markdown' } },
		files: [],
	});
	const groups = deriveFileTypeGroups(app);
	const images = groups.find((g) => g.category === 'Images');
	assert.ok(images.extensions.includes('epub'));
	// 'md' was already in the catalog, so it must not be duplicated anywhere.
	const flatCount = groups.flatMap((g) => g.extensions).filter((e) => e === 'md').length;
	assert.equal(flatCount, 1);
});

test('vault extensions with mixed case are normalized before union', () => {
	const app = fakeApp({ viewRegistry: undefined, files: ['MD', 'PnG'] });
	const groups = deriveFileTypeGroups(app);
	const other = groups.find((g) => g.category === 'Other');
	// png is already in the catalog (Images); MD is already in the catalog (Markdown) —
	// case-insensitive union means neither should create a new "Other" entry.
	assert.ok(!other, `unexpected Other bucket: ${JSON.stringify(other)}`);
});

/* -------------------------------------------------------------------------- */
/* checkbox-grid selection semantics (Set A "empty means all" vs Set B)       */
/* -------------------------------------------------------------------------- */

test('empty palette array still means "all types allowed" (migration-safety case)', () => {
	const all = Array.from(ALL_CATALOG_EXTENSIONS);
	const selected = resolveSelectedExtensions([], all, true);
	assert.deepEqual(Array.from(selected).sort(), all.slice().sort());
});

test('checking every box collapses back to [] for emptyMeansAll sets', () => {
	const all = Array.from(ALL_CATALOG_EXTENSIONS);
	const fullySelected = new Set(all);
	assert.deepEqual(commitSelectedExtensions(fullySelected, all, true), []);
});

test('an empty Set B selection means nothing selected, not everything', () => {
	const all = ['md', 'qmd', 'txt', 'canvas'];
	const selected = resolveSelectedExtensions([], all, false);
	assert.deepEqual(Array.from(selected), []);
});

test('a partial selection round-trips exactly for both empty-means-all and plain sets', () => {
	const all = ['md', 'qmd', 'txt'];
	for (const emptyMeansAll of [true, false]) {
		const selected = resolveSelectedExtensions(['md'], all, emptyMeansAll);
		assert.deepEqual(Array.from(selected), ['md']);
		assert.deepEqual(commitSelectedExtensions(selected, all, emptyMeansAll), ['md']);
	}
});

/* -------------------------------------------------------------------------- */
/* isSearchIndexablePath — settings-driven list + the dotless-path bug fix    */
/* -------------------------------------------------------------------------- */

test('isSearchIndexablePath honors a supplied list', () => {
	assert.equal(isSearchIndexablePath('notes/plan.canvas', ['md', 'canvas']), true);
	assert.equal(isSearchIndexablePath('notes/plan.md', ['canvas']), false);
	assert.equal(isSearchIndexablePath('notes/plan.md', []), false, 'an explicit empty list indexes nothing');
});

test('isSearchIndexablePath defaults to md/qmd/txt when no list is supplied', () => {
	assert.equal(isSearchIndexablePath('daily/note.md'), true);
	assert.equal(isSearchIndexablePath('research/report.qmd'), true);
	assert.equal(isSearchIndexablePath('inbox/raw.txt'), true);
	assert.equal(isSearchIndexablePath('assets/image.png'), false);
});

test('a dotless path is not treated as having an extension', () => {
	// Before the fix, path.split('.').pop() returned the whole dotless path/filename,
	// which happened to never match SEARCH_EXTENSIONS — harmless by luck, not by design.
	assert.equal(isSearchIndexablePath('README', ['md', 'txt']), false);
	assert.equal(isSearchIndexablePath('folder/LICENSE', ['md', 'txt']), false);
	// A trailing-dot filename ("notes.") is the dot > 0 && dot < length - 1 edge case.
	assert.equal(isSearchIndexablePath('folder/notes.', ['md', 'txt']), false);
	// A leading-dot dotfile ("dot === 0") must not be treated as an extension either.
	assert.equal(isSearchIndexablePath('.gitignore', ['gitignore']), false);
});
