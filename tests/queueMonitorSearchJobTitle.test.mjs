// WP-F3: `jobTitle`'s two new cases (search_upsert_file, search_delete_path) — before this,
// both fell to the `default: job.id` branch and a queue-monitor row for either type read as a
// bare job id instead of naming the file, since neither type carries `targetPath` (only
// `params.path`, mirroring `SearchIndexCoordinator.enqueueAutomatic`'s payload shape — see the
// `/v1/paths` audit/reconcile quirk in src/search/AGENTS.md). Also pins the Target-cell fallback
// (renders the raw vault path, not the job id/title) as a STRUCTURAL source-text check, matching
// the established pattern in tests/queueMonitorJobDetail.test.mjs for DOM-heavy render paths that
// aren't worth a full sortable-table harness.
//
// Bundles the real queueMonitor.ts against the same minimal obsidian stub as
// tests/queueMonitorJobDetail.test.mjs — `jobTitle` touches no DOM, so no Obsidian scaffolding
// beyond module resolution is needed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-queuemonitor-search-jobtitle-tests');
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

const { jobTitle } = await import(pathToFileURL(outfile).href);

function job(type, params, overrides = {}) {
	return { type, params, status: 'queued', key: 'job-1', id: 'job-1', created: '2026-01-01T00:00:00.000Z', ...overrides };
}

test('jobTitle names a search_upsert_file job "Index: <basename>"', () => {
	assert.equal(jobTitle(job('search_upsert_file', { path: 'notes/example.md' })), 'Index: example.md');
});

test('jobTitle names a search_delete_path job "De-index: <basename>"', () => {
	assert.equal(jobTitle(job('search_delete_path', { path: 'notes/deleted.md' })), 'De-index: deleted.md');
});

test('jobTitle falls back to a generic label when the path param is missing or not a string', () => {
	assert.equal(jobTitle(job('search_upsert_file', {})), 'Index update');
	assert.equal(jobTitle(job('search_delete_path', { path: 42 })), 'Index delete');
});

test('jobTitle still falls back to job.id for a genuinely unhandled job type', () => {
	assert.equal(jobTitle(job('some_future_type', { path: 'x.md' }, { id: 'unhandled-1' })), 'unhandled-1');
});

test('STRUCTURAL: the Target cell renders the raw vault path (not the title/job id) for search_upsert_file/search_delete_path when no TFile resolves', () => {
	const src = readFileSync('src/ingestion/sections/queueMonitor.ts', 'utf8');
	assert.match(
		src,
		/if \(r\.type === 'search_upsert_file' \|\| r\.type === 'search_delete_path'\) \{\s*\n\s*td\.setText\(r\.targetPath\);/,
	);
});
