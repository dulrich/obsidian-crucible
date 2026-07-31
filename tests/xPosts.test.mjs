// WP-XM4: computeXPostRows (src/ingestion/data/xPosts.ts) is a dependency-free pure
// function — both its imports (`App` from 'obsidian', `XPostRow` from
// ../render/types) are `import type`, so the compiled JS has no runtime import of
// 'obsidian' at all (verified by inspecting the bundle output while writing this
// test). No obsidian stub package is needed, unlike tests/missingAttachments.test.mjs
// which pulls in localizeAttachments.ts's real dependency graph.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-x-posts-data-tests');
const outfile = path.join(outdir, 'xPosts.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/ingestion/data/xPosts.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const { computeXPostRows } = await import(pathToFileURL(outfile).href);

/* -------------------------------------------------------------------- fake app */

// A "file" is just a plain object carrying `path` — computeXPostRows never
// touches anything else on it (no `instanceof TFile`, duck-typed like every
// other pure data module in this directory).
function file(p) {
	return { path: p };
}

function makeApp(entries) {
	// entries: [{ path, frontmatter }]
	const files = entries.map(e => file(e.path));
	const fmByPath = new Map(entries.map(e => [e.path, e.frontmatter]));
	return {
		vault: { getMarkdownFiles: () => files },
		metadataCache: {
			getFileCache: (f) => {
				const fm = fmByPath.get(f.path);
				return fm === undefined ? null : { frontmatter: fm };
			},
		},
	};
}

const REGISTRY_ROOT = '_crucible/link_registry';
const METADATA_ROOT = '_x_metadata';

/* ------------------------------------------------------------------ registry-only */

test('a registry record with no matching metadata note is pending', () => {
	const app = makeApp([
		{
			path: `${REGISTRY_ROOT}/some-link.md`,
			frontmatter: { type: 'link-record', 'x-status-id': '1900000000000000001', canonical_url: 'https://x.com/alice/status/1900000000000000001', source_notes: ['[[a]]', '[[b]]'] },
		},
	]);
	const rows = computeXPostRows(app, REGISTRY_ROOT, METADATA_ROOT);
	assert.equal(rows.length, 1);
	assert.deepEqual(rows[0], {
		statusId: '1900000000000000001',
		url: 'https://x.com/alice/status/1900000000000000001',
		author: null,
		state: 'pending',
		sourceCount: 2,
		metadataFile: null,
	});
});

test('a registry record whose type is not link-record is ignored', () => {
	const app = makeApp([
		{ path: `${REGISTRY_ROOT}/note.md`, frontmatter: { type: 'something-else', 'x-status-id': '123' } },
	]);
	assert.deepEqual(computeXPostRows(app, REGISTRY_ROOT, METADATA_ROOT), []);
});

test('a registry record with an empty/missing x-status-id is ignored', () => {
	const app = makeApp([
		{ path: `${REGISTRY_ROOT}/a.md`, frontmatter: { type: 'link-record', 'x-status-id': '' } },
		{ path: `${REGISTRY_ROOT}/b.md`, frontmatter: { type: 'link-record' } },
	]);
	assert.deepEqual(computeXPostRows(app, REGISTRY_ROOT, METADATA_ROOT), []);
});

test('source_notes coercion: array length, legacy single string -> 1, missing -> 0', () => {
	const app = makeApp([
		{ path: `${REGISTRY_ROOT}/arr.md`, frontmatter: { type: 'link-record', 'x-status-id': '1', source_notes: ['[[a]]', '[[b]]', '[[c]]'] } },
		{ path: `${REGISTRY_ROOT}/legacy.md`, frontmatter: { type: 'link-record', 'x-status-id': '2', source_notes: '[[only-one]]' } },
		{ path: `${REGISTRY_ROOT}/missing.md`, frontmatter: { type: 'link-record', 'x-status-id': '3' } },
	]);
	const rows = computeXPostRows(app, REGISTRY_ROOT, METADATA_ROOT);
	const byId = new Map(rows.map(r => [r.statusId, r]));
	assert.equal(byId.get('1').sourceCount, 3);
	assert.equal(byId.get('2').sourceCount, 1);
	assert.equal(byId.get('3').sourceCount, 0);
});

test('a registry record falls back to `url` when canonical_url is absent', () => {
	const app = makeApp([
		{ path: `${REGISTRY_ROOT}/a.md`, frontmatter: { type: 'link-record', 'x-status-id': '5', url: 'https://twitter.com/bob/status/5' } },
	]);
	const rows = computeXPostRows(app, REGISTRY_ROOT, METADATA_ROOT);
	assert.equal(rows[0].url, 'https://twitter.com/bob/status/5');
});

/* ------------------------------------------------------------------ metadata-only */

test('a materialized note with no registry record still appears, with sourceCount 0', () => {
	const app = makeApp([
		{ path: `${METADATA_ROOT}/alice/42.md`, frontmatter: { 'status-id': '42', url: 'https://x.com/alice/status/42', author: 'Alice', state: 'ok' } },
	]);
	const rows = computeXPostRows(app, REGISTRY_ROOT, METADATA_ROOT);
	assert.equal(rows.length, 1);
	assert.deepEqual(rows[0], {
		statusId: '42',
		url: 'https://x.com/alice/status/42',
		author: 'Alice',
		state: 'materialized',
		sourceCount: 0,
		metadataFile: file(`${METADATA_ROOT}/alice/42.md`),
	});
});

test('author falls back to author-handle when author is absent', () => {
	const app = makeApp([
		{ path: `${METADATA_ROOT}/alice/42.md`, frontmatter: { 'status-id': '42', 'author-handle': 'alice', state: 'ok' } },
	]);
	const rows = computeXPostRows(app, REGISTRY_ROOT, METADATA_ROOT);
	assert.equal(rows[0].author, 'alice');
});

test('a metadata note with no status-id is ignored', () => {
	const app = makeApp([
		{ path: `${METADATA_ROOT}/alice/42.md`, frontmatter: { author: 'Alice', state: 'ok' } },
	]);
	assert.deepEqual(computeXPostRows(app, REGISTRY_ROOT, METADATA_ROOT), []);
});

test('state: unavailable is distinguished from ok (materialized) via the frontmatter state key', () => {
	const app = makeApp([
		{ path: `${METADATA_ROOT}/alice/1.md`, frontmatter: { 'status-id': '1', state: 'ok' } },
		{ path: `${METADATA_ROOT}/_unavailable/2.md`, frontmatter: { 'status-id': '2', state: 'unavailable', 'unavailable-reason': 'deleted-or-private' } },
	]);
	const rows = computeXPostRows(app, REGISTRY_ROOT, METADATA_ROOT);
	const byId = new Map(rows.map(r => [r.statusId, r]));
	assert.equal(byId.get('1').state, 'materialized');
	assert.equal(byId.get('2').state, 'unavailable');
	assert.ok(byId.get('2').metadataFile, 'a tombstone still has a metadataFile — it is a real note');
});

/* ----------------------------------------------------------------------- merge */

test('merges a registry record and its materialized note on statusId: state/author come from the note, sourceCount from the registry', () => {
	const app = makeApp([
		{
			path: `${REGISTRY_ROOT}/rec.md`,
			frontmatter: { type: 'link-record', 'x-status-id': '99', canonical_url: 'https://x.com/carol/status/99', source_notes: ['[[a]]', '[[b]]'] },
		},
		{
			path: `${METADATA_ROOT}/carol/99.md`,
			frontmatter: { 'status-id': '99', url: 'https://x.com/carol/status/99', author: 'Carol', state: 'ok' },
		},
	]);
	const rows = computeXPostRows(app, REGISTRY_ROOT, METADATA_ROOT);
	assert.equal(rows.length, 1, 'one merged row, not two');
	assert.deepEqual(rows[0], {
		statusId: '99',
		url: 'https://x.com/carol/status/99',
		author: 'Carol',
		state: 'materialized',
		sourceCount: 2,
		metadataFile: file(`${METADATA_ROOT}/carol/99.md`),
	});
});

test('merge order independence: the registry record appearing after the metadata note in vault order still merges', () => {
	const app = makeApp([
		{ path: `${METADATA_ROOT}/carol/99.md`, frontmatter: { 'status-id': '99', author: 'Carol', state: 'ok' } },
		{ path: `${REGISTRY_ROOT}/rec.md`, frontmatter: { type: 'link-record', 'x-status-id': '99', source_notes: ['[[a]]'] } },
	]);
	const rows = computeXPostRows(app, REGISTRY_ROOT, METADATA_ROOT);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].sourceCount, 1);
});

/* ------------------------------------------------------------------------ sort */

test('sort: pending rows sort before materialized/unavailable rows', () => {
	const app = makeApp([
		{ path: `${METADATA_ROOT}/a/5.md`, frontmatter: { 'status-id': '5', state: 'ok' } },
		{ path: `${REGISTRY_ROOT}/p.md`, frontmatter: { type: 'link-record', 'x-status-id': '1' } },
	]);
	const rows = computeXPostRows(app, REGISTRY_ROOT, METADATA_ROOT);
	assert.deepEqual(rows.map(r => r.state), ['pending', 'materialized']);
});

test('sort: within a state class, statusId sorts numerically descending (snowflake ids), not lexicographically', () => {
	const app = makeApp([
		{ path: `${METADATA_ROOT}/a/9.md`, frontmatter: { 'status-id': '9', state: 'ok' } },
		{ path: `${METADATA_ROOT}/a/10.md`, frontmatter: { 'status-id': '10', state: 'ok' } },
		{ path: `${METADATA_ROOT}/a/2.md`, frontmatter: { 'status-id': '2', state: 'ok' } },
	]);
	const rows = computeXPostRows(app, REGISTRY_ROOT, METADATA_ROOT);
	// Lexicographic desc would read ['9', '2', '10'] — numeric desc must read ['10', '9', '2'].
	assert.deepEqual(rows.map(r => r.statusId), ['10', '9', '2']);
});

test('sort: a non-numeric statusId degrades to a string compare instead of throwing', () => {
	const app = makeApp([
		{ path: `${METADATA_ROOT}/a/x.md`, frontmatter: { 'status-id': 'not-a-number', state: 'ok' } },
		{ path: `${METADATA_ROOT}/a/1.md`, frontmatter: { 'status-id': '1', state: 'ok' } },
	]);
	assert.doesNotThrow(() => computeXPostRows(app, REGISTRY_ROOT, METADATA_ROOT));
});

/* -------------------------------------------------------------------- root guards */

test('files outside both roots are ignored', () => {
	const app = makeApp([
		{ path: 'notes/unrelated.md', frontmatter: { type: 'link-record', 'x-status-id': '1' } },
		{ path: 'notes/other.md', frontmatter: { 'status-id': '1', state: 'ok' } },
	]);
	assert.deepEqual(computeXPostRows(app, REGISTRY_ROOT, METADATA_ROOT), []);
});

test('an empty registryRoot/metadataRoot never matches (no accidental empty-prefix startsWith)', () => {
	const app = makeApp([
		{ path: `${REGISTRY_ROOT}/a.md`, frontmatter: { type: 'link-record', 'x-status-id': '1' } },
		{ path: `${METADATA_ROOT}/a/1.md`, frontmatter: { 'status-id': '1', state: 'ok' } },
	]);
	assert.deepEqual(computeXPostRows(app, '', ''), []);
});
