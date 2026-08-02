import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// thq WP-7: the job-detail affordance's pure formatting function (`formatJobDetail`,
// consumed by `JobDetailModal`) — the queue monitor's replacement for the job note
// file a db-backed job no longer has (params, error/failureKind, progress, notes).
// Bundles the real queueMonitor.ts (not a mirrored re-implementation, unlike
// tests/queueMonitorCreatedSort.test.mjs's narrower formatDateTime probe) — every
// sibling import it pulls in (failedJobRepair, confirmModal, destructiveActions, the
// render/* helpers) is a real relative import with no additional native
// dependencies, so the only stub needed is 'obsidian' itself, same shape as
// tests/queueControl.test.mjs's stub list. `formatJobDetail` touches no DOM, so this
// avoids needing a full HTMLElement stub for what is otherwise a DOM-heavy module.

const outdir = path.join(tmpdir(), 'obsidian-crucible-queuemonitor-jobdetail-tests');
const outfile = path.join(outdir, 'queueMonitor.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	entryPoints: ['src/ingestion/sections/queueMonitor.ts'],
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
					'export class Notice { constructor(message) {} }',
					'export class Modal { constructor() {} }',
					'export class TFile {}',
					'export class TFolder {}',
					'export class App {}',
					'export class Setting {}',
					'export class FuzzySuggestModal {}',
					'export class FileSystemAdapter {}',
					'export function normalizePath(p) { return p; }',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
					'export const Platform = {};',
					'export const moment = () => {};',
					'export function setIcon() {}',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { formatJobDetail } = await import(pathToFileURL(outfile).href);

function row(overrides = {}) {
	return {
		source: 'file',
		status: 'running',
		type: 'search_upsert_batch',
		key: 'job-1',
		created: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

test('formatJobDetail includes the always-present fields', () => {
	const text = formatJobDetail(row());
	assert.match(text, /^Type: search_upsert_batch$/m);
	assert.match(text, /^ID: job-1$/m);
	assert.match(text, /^Status: running$/m);
	assert.match(text, /^Created: 2026-01-01T00:00:00\.000Z$/m);
});

test('formatJobDetail omits optional fields entirely when absent, rather than printing them empty', () => {
	const text = formatJobDetail(row());
	assert.doesNotMatch(text, /Target:/);
	assert.doesNotMatch(text, /Progress:/);
	assert.doesNotMatch(text, /Error:/);
	assert.doesNotMatch(text, /Failure kind:/);
	assert.doesNotMatch(text, /Notes:/);
	// Params always renders, even when absent — an empty object, not omitted, since
	// "no params" is itself useful information for a job record.
	assert.match(text, /Params:\n\{\}/);
});

test('formatJobDetail renders target, progress, error, failureKind and pretty-printed params when present', () => {
	const text = formatJobDetail(row({
		targetPath: 'notes/example.md',
		progress: 'batch 3 / 10',
		error: 'boom',
		failureKind: 'service',
		params: { paths: ['a.md', 'b.md'], batchIndex: 2 },
	}));
	assert.match(text, /^Target: notes\/example\.md$/m);
	assert.match(text, /^Progress: batch 3 \/ 10$/m);
	assert.match(text, /^Error: boom$/m);
	assert.match(text, /^Failure kind: service$/m);
	assert.match(text, /Params:\n\{\n {2}"paths": \[\n {4}"a\.md",\n {4}"b\.md"\n {2}\],\n {2}"batchIndex": 2\n\}/);
});

test('formatJobDetail appends notes last, only when present', () => {
	const withoutNotes = formatJobDetail(row());
	assert.doesNotMatch(withoutNotes, /Notes:/);

	const withNotes = formatJobDetail(row({ notes: 'line one\nline two' }));
	assert.match(withNotes, /Notes:\nline one\nline two$/);
});

test('formatJobDetail is exported for the Details button — STRUCTURAL: rendered for every row, ungated', () => {
	// thq WP-8: the button used to be gated to `r.source === 'file'`, because the other
	// row source (in-memory enrichment entries) carried no params/notes/failureKind for
	// the modal to show. There is one row source now and every row is a real job, so the
	// gate is gone — and its absence is worth pinning, because re-introducing a
	// per-row-source condition here would silently hide the only remaining surface a
	// db-backed job has (there is no job note to open any more).
	//
	// WP-DP3: Details went icon-only (renderIconButton, 'info' glyph) as part of the
	// row-scope icon language — the pin now matches that shape instead of the old
	// text-button `createEl`.
	const src = readFileSync('src/ingestion/sections/queueMonitor.ts', 'utf8');
	assert.doesNotMatch(src, /r\.source/, 'QueueRow has no `source` discriminant post-cutover');
	assert.match(src, /renderIconButton\(td, 'info', \{\s*\n\s*ariaLabel: 'Details',/);
	assert.match(src, /onClick: \(\) => new JobDetailModal\(host\.app, r\)\.open\(\),/);
});

test('STRUCTURAL: the queue monitor reads every row through the Orchestrator seam, never a store', () => {
	// The reach-around this whole track exists to close. Both statuses go through
	// `orchestrator.listJobs` with a real query-level cap; nothing here touches a
	// storage layer, and no second row source is merged in.
	const src = readFileSync('src/ingestion/sections/queueMonitor.ts', 'utf8');
	assert.match(src, /orchestrator\.listJobs\('running', \{ limit: QUEUE_MONITOR_RENDER_LIMIT \}\)/);
	assert.match(src, /orchestrator\.listJobs\('queued', \{ limit: QUEUE_MONITOR_RENDER_LIMIT \}\)/);
	assert.doesNotMatch(src, /jobStore|listFolder|enrichmentQueue/);
});
