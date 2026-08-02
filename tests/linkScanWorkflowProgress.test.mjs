import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// WP-J1: `LinkScanWorkflow.run` drives `ctx.reportProgress` from two loops (a
// vault-wide read pass, then a registry write pass), each throttled the same
// "every Nth item, plus the last one" way `SearchManager.indexFiles`'s own
// `onProgress` is. `run()` itself needs a real vault + `updateFrontmatter`
// harness to exercise end to end (first built by WP-J3, per the governing
// plan's Critical Files list — LinkScanWorkflow has no dedicated test file
// today). What WP-J1 adds is pure and exported specifically so it's testable
// without that harness: the throttle gate and the two message formats. This
// file pins those directly — the same "extract the pure decision" pattern
// `formatUpsertFileNotes` uses in tests/searchWorkflowQueue.test.mjs.

const outdir = path.join(tmpdir(), 'obsidian-crucible-link-scan-progress-tests');
const outfile = path.join(outdir, 'LinkScanWorkflow.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { shouldReportLinkScanProgress, formatLinkScanScanProgress, formatLinkScanRegistryProgress } from './src/orchestration/workflows/LinkScanWorkflow';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'link-scan-workflow-progress-test-entry.ts',
		loader: 'ts',
	},
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
					'export class App {}',
					'export class TFile {}',
					'export class TFolder {}',
					'export class EventRef {}',
					'export function normalizePath(p) { return p; }',
					'export function parseYaml() { return {}; }',
					'export function stringifyYaml(v) { return JSON.stringify(v); }',
					'export const Platform = {};',
					'export const moment = () => {};',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	shouldReportLinkScanProgress,
	formatLinkScanScanProgress,
	formatLinkScanRegistryProgress,
} = await import(pathToFileURL(outfile).href);

test('shouldReportLinkScanProgress: fires on the last item even off the every-10 cadence', () => {
	assert.equal(shouldReportLinkScanProgress(47, 47), true);
	assert.equal(shouldReportLinkScanProgress(46, 47), false);
});

test('shouldReportLinkScanProgress: fires every 10th item', () => {
	assert.equal(shouldReportLinkScanProgress(10, 100), true);
	assert.equal(shouldReportLinkScanProgress(20, 100), true);
	assert.equal(shouldReportLinkScanProgress(11, 100), false);
});

test('shouldReportLinkScanProgress: an empty total never reports (loop never runs, but stays a real "false" if called)', () => {
	assert.equal(shouldReportLinkScanProgress(0, 0), false);
});

test('shouldReportLinkScanProgress: a single-item total reports on that one item (both "10th" and "last")', () => {
	assert.equal(shouldReportLinkScanProgress(1, 1), true);
});

test('formatLinkScanScanProgress: pinned message shape', () => {
	assert.equal(formatLinkScanScanProgress(20, 200), 'scan 20 / 200 notes');
});

test('formatLinkScanRegistryProgress: pinned message shape', () => {
	assert.equal(formatLinkScanRegistryProgress(3, 12), 'registry 3 / 12 records');
});
