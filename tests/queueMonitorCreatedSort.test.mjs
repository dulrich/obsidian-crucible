import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Covers the queueMonitor.ts "Created" column fix: file rows carry `job.created` (already
// millisecond ISO) and memory rows now carry `new Date(addedAt).toISOString()` instead of a
// pre-formatted human string — so both sources land in `QueueRow.created` as the same raw ISO
// format and a plain lexicographic sort on that field is chronologically correct regardless of
// source mix. This test exercises `formatDateTime` (the actual render-time formatter
// queueMonitor.ts now calls) directly rather than driving the DOM-heavy
// `renderSortableTable`/`renderQueueMonitor` path, which needs a full Obsidian HTMLElement
// stub out of proportion for this fix; `sortableTable.ts`'s generic sort-by-sortKey mechanics
// are unchanged by this WP and are not what was broken.

const outdir = path.join(tmpdir(), 'obsidian-crucible-queuemonitor-created-sort-tests');
const outfile = path.join(outdir, 'format.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/ingestion/render/format.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const { formatDateTime } = await import(pathToFileURL(outfile).href);

// Mirrors the exact row-mapping expressions in queueMonitor.ts (file rows: raw
// `e.job.created`; memory rows: `new Date(e.addedAt).toISOString()`).
function fileRow(created) {
	return { source: 'file', created: created ?? '' };
}
function memoryRow(addedAtMs) {
	return { source: 'memory', created: addedAtMs ? new Date(addedAtMs).toISOString() : '' };
}

// Same sort used by sortableTable.ts: `av < bv ? -1 : av > bv ? 1 : 0` over `col.sortKey(row)`.
function sortByCreated(rows) {
	return [...rows].sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
}

test('mixed file/memory rows sort chronologically on the raw-ISO created field', () => {
	const memoryMs = Date.parse('2026-07-27T12:00:00.200Z');
	const rows = [
		fileRow('2026-07-27T12:00:00.900Z'), // latest
		memoryRow(memoryMs), // middle
		fileRow('2026-07-27T12:00:00.050Z'), // earliest
	];

	const sorted = sortByCreated(rows);

	assert.deepEqual(
		sorted.map(r => r.created),
		['2026-07-27T12:00:00.050Z', new Date(memoryMs).toISOString(), '2026-07-27T12:00:00.900Z'],
	);
});

test('render-time formatting of a memory row matches what formatDateTime(addedAt) produced before the fix', () => {
	const addedAt = Date.parse('2026-07-27T12:34:56.000Z');
	const row = memoryRow(addedAt);

	// Old behavior: `created: formatDateTime(addedAt)` computed at collection time.
	const oldDisplay = formatDateTime(addedAt);
	// New behavior: `created` holds raw ISO; the render cell now computes
	// `formatDateTime(Date.parse(r.created))` at render time.
	const newDisplay = formatDateTime(Date.parse(row.created));

	assert.equal(newDisplay, oldDisplay);
});

test('empty created renders as empty string, not "Invalid Date"', () => {
	const row = memoryRow(0);
	assert.equal(row.created, '');
	// Mirrors queueMonitor.ts's render cell exactly: `r.created ? formatDateTime(Date.parse(r.created)) : ''`.
	const rendered = row.created ? formatDateTime(Date.parse(row.created)) : '';
	assert.equal(rendered, '');
});
