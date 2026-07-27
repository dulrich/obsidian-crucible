import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-dates-tests');
const outfile = path.join(outdir, 'dates.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// No obsidian import chain here (src/orchestration/utils/dates.ts has zero imports), so this
// bundles directly with no stub plugin.
await esbuild.build({
	entryPoints: ['src/orchestration/utils/dates.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const { newJobId } = await import(pathToFileURL(outfile).href);

// Job ids appear in queue file names (`${id}.md`) and dedupe maps; the only structural
// assumption any consumer makes (per repo-wide grep of src/ and tests/) is dash-delimited
// `<stamp>-<type>-<suffix>` where stamp itself carries one internal dash — everything else is
// opaque-string equality/localeCompare. This regex documents and locks that shape.
const ID_SHAPE_RE = /^\d{8}-\d{9}-[a-z0-9_]+-[0-9a-f]{8}$/;

test('newJobId ids minted in a tight loop sort lexicographically in mint order', () => {
	const ids = Array.from({ length: 100 }, () => newJobId('image_describe_batch'));
	const sorted = [...ids].sort((a, b) => a.localeCompare(b));
	assert.deepEqual(sorted, ids, 'mint order must already be the sorted order');
	// No duplicates: the monotonic counter (or, on a millisecond rollover mid-loop, the
	// counter reset + fresh stamp) must keep every id unique.
	assert.equal(new Set(ids).size, ids.length);
});

test('newJobId keeps the <stamp>-<type>-<suffix> shape consumers rely on', () => {
	const id = newJobId('search_upsert_batch');
	assert.match(id, ID_SHAPE_RE);
	const parts = id.split('-');
	assert.equal(parts.length, 4, 'date, time+ms+counter+rand-bearing stamp, type, suffix');
	assert.equal(parts[2], 'search_upsert_batch');
});

test('newJobId sanitizes the type the same way as before (non-alnum/underscore -> underscore, lowercased)', () => {
	const id = newJobId('Weird Type!!');
	assert.match(id, /-weird_type__-[0-9a-f]{8}$/);
});

test('newJobId ids minted a millisecond apart still sort chronologically', async () => {
	const first = newJobId('image_describe_batch');
	await new Promise(resolve => setTimeout(resolve, 5));
	const second = newJobId('image_describe_batch');
	assert.ok(first.localeCompare(second) < 0, `${first} should sort before ${second}`);
});
