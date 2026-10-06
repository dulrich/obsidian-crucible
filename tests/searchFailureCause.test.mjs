// Search-latency-durability WP-3: cause mapping for failed and partial interactive searches.
// The module is pure (no obsidian import), bundled only to compile the TypeScript.
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-failure-cause-tests');
const outfile = path.join(outdir, 'cause.mjs');
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	stdin: {
		contents: `
			export * from './src/search/searchFailureCause';
			export { SearchServiceUnavailableError } from './src/search/types';
		`,
		resolveDir: process.cwd(),
		loader: 'ts',
	},
	bundle: true, platform: 'node', format: 'esm', target: 'es2020', outfile, logLevel: 'silent',
});
const { describeSearchFailure, describePartialResponse, formatBytes, SearchServiceUnavailableError } = await import(pathToFileURL(outfile));

function failed(kind, message, probe) {
	const e = new SearchServiceUnavailableError(message, kind);
	if (probe) e.healthProbe = probe;
	return e;
}
const TIMEOUT = 'Search service /v1/search timed out after 4000ms';
const GiB = 1024 ** 3;

test('probe did not answer → "starting or unavailable", never a confirmed outage', () => {
	const d = describeSearchFailure(failed('timeout', TIMEOUT, { answered: false, error: '/health timed out after 1000ms' }));
	assert.equal(d.status, 'Search failed: Search companion starting or unavailable');
	assert.doesNotMatch(d.status + d.title + d.notice, /\b(down|unreachable|crashed)\b/i);
	assert.match(d.title, /timed out after 4000ms/, 'original error kept as evidence in the title');
	assert.match(d.notice, /starting or unavailable/);
});

test('vector building/stale → semantic index rebuilding', () => {
	for (const status of ['building', 'stale']) {
		const d = describeSearchFailure(failed('timeout', TIMEOUT, { answered: true, health: { ok: true, vector: { status } } }));
		assert.equal(d.status, 'Search failed: semantic index rebuilding');
	}
});

test('indexing.flushActive → indexing in progress', () => {
	const d = describeSearchFailure(failed('server-error', 'returned 503', { answered: true, health: { ok: true, vector: { status: 'ready' }, indexing: { flushActive: true, lastFlushMs: null } } }));
	assert.equal(d.status, 'Search failed: indexing in progress');
});

test('memory pressure/exhausted → under memory pressure with swap/limit in human units', () => {
	for (const pressure of ['pressure', 'exhausted']) {
		const memory = { limitBytes: 4 * GiB, currentBytes: 1, swapBytes: 1.5 * GiB, peakBytes: null, maxEvents: 1, pressure };
		const d = describeSearchFailure(failed('timeout', TIMEOUT, { answered: true, health: { ok: true, memory } }));
		assert.equal(d.status, 'Search failed: under memory pressure (swap 1.5 GiB, limit 4.0 GiB)');
	}
});

test('several causes fire → all reported in precedence order', () => {
	const health = {
		ok: true,
		vector: { status: 'building' },
		indexing: { flushActive: true, lastFlushMs: 5 },
		memory: { limitBytes: null, currentBytes: 1, swapBytes: 0, peakBytes: null, maxEvents: 0, pressure: 'exhausted' },
	};
	const d = describeSearchFailure(failed('timeout', TIMEOUT, { answered: true, health }));
	assert.equal(d.status, 'Search failed: semantic index rebuilding; indexing in progress; under memory pressure (swap 0 B, no limit)');
});

test('old companion health (no vector/indexing/memory) → original error text, unchanged', () => {
	const d = describeSearchFailure(failed('timeout', TIMEOUT, { answered: true, health: { ok: true, schemaVersion: 7 } }));
	assert.equal(d.status, `Search failed: ${TIMEOUT}`);
	assert.equal(d.notice, `Search failed: ${TIMEOUT}`);
	assert.equal(d.title, TIMEOUT);
});

test('healthy snapshot (ready, idle, ok memory) → original error text', () => {
	const health = { ok: true, vector: { status: 'ready' }, indexing: { flushActive: false, lastFlushMs: null }, memory: { limitBytes: GiB, currentBytes: 1, swapBytes: 0, peakBytes: null, maxEvents: 0, pressure: 'ok' } };
	assert.equal(describeSearchFailure(failed('timeout', TIMEOUT, { answered: true, health })).status, `Search failed: ${TIMEOUT}`);
});

test('no probe attached (e.g. 4xx plain Error, refused) → original error text, never bare "Search failed"', () => {
	assert.equal(describeSearchFailure(new Error('HTTP 400: bad query')).status, 'Search failed: HTTP 400: bad query');
	assert.equal(describeSearchFailure(failed('refused', 'connection refused')).status, 'Search failed: connection refused');
});

test('describePartialResponse: vectorPending, degraded, both, neither', () => {
	assert.deepEqual(describePartialResponse({}), { prefix: '', reason: null });
	const pending = describePartialResponse({ vectorPending: true });
	assert.match(pending.reason, /semantic index rebuilding/);
	assert.equal(pending.prefix, `${pending.reason} · `);
	const degraded = describePartialResponse({ degraded: true });
	assert.match(degraded.reason, /partial within the search time budget/);
	const both = describePartialResponse({ degraded: true, vectorPending: true });
	assert.match(both.reason, /semantic index rebuilding.*time budget/);
});

test('formatBytes uses binary units', () => {
	assert.equal(formatBytes(0), '0 B');
	assert.equal(formatBytes(2048), '2.0 KiB');
	assert.equal(formatBytes(4 * GiB), '4.0 GiB');
});
