import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// rem-R1 (review finding F1): `WorkflowResult` is a discriminated union, not one bag of
// optional fields. The union's real guarantees are COMPILE-time — `npx tsc -noEmit` is
// the gate that proves a `{status:'done', error}` or a `{status:'failed'}` with no error
// cannot be written — so what a runtime suite can add is the other half: that the four
// variants each settle correctly through the one backend, that the settlement is a single
// exhaustive switch with an `assertNever` backstop (so a fifth variant is a compile error
// rather than a job that never settles), and that the `'Workflow returned failed status'`
// placeholder the old optional `error` needed is gone rather than merely unused.

globalThis.require = createRequire(import.meta.url);

const outdir = path.join(tmpdir(), 'obsidian-crucible-workflow-result-union-tests');
const outfile = path.join(outdir, 'union.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { assertNever } from './src/orchestration/types';",
			"export { applyCancellation, cancelledResultFor } from './src/orchestration/cancellation';",
			"export { DbJobBackend } from './src/orchestration/DbJobBackend';",
			"export { SqliteJobStore } from './src/orchestration/db/SqliteJobStore';",
			"export { openJobsDb } from './src/orchestration/db/sqlite';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'workflow-result-union-test-entry.ts',
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	external: ['node:sqlite'],
	plugins: [{
		name: 'obsidian-test-stub',
		setup(build) {
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-test-stub', namespace: 'stub' }));
			build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
				contents: [
					'globalThis.__unionNotices = globalThis.__unionNotices ?? [];',
					'export class Notice { constructor(message) { globalThis.__unionNotices.push(message); } }',
					'export class TFile {}',
					'export class TFolder {}',
					'export class App {}',
					'export class Modal {}',
					'export class Setting {}',
					'export class FuzzySuggestModal {}',
					'export class FileSystemAdapter {}',
					'export function normalizePath(p) { return p; }',
					'export async function requestUrl() { throw new Error("requestUrl unavailable in tests"); }',
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
	DbJobBackend,
	SqliteJobStore,
	openJobsDb,
	applyCancellation,
	assertNever,
} = await import(pathToFileURL(outfile).href);

// `command_run` has no settings toggle in `DbJobBackend.isWorkflowEnabled`, so it is
// enabled by default and these tests exercise settlement rather than the enable gate.
const TEST_TYPE = 'command_run';
const TEST_CONFIG = { persistence: 'db', minIntervalMs: 0, maxParallel: 1 };

function makePlugin(overrides = {}) {
	return {
		settings: {
			orchestrationEnabled: true,
			orchestrationQueueEnabled: true,
			orchestrationAutorunTimeoutSeconds: 0,
			orchestrationRoutineNoticesEnabled: {},
			orchestrationJobRetentionDays: 30,
			...(overrides.settings ?? {}),
		},
		ingestionEvents: null,
		orchestrationAutoRunner: null,
		serviceHealth: null,
		orchestrator: null,
		app: { vault: { getAbstractFileByPath: () => null }, workspace: { onLayoutReady: () => {} } },
		...overrides,
	};
}

// Runs one job whose workflow returns `result`, and hands back the settled row.
async function settle(result, { id = 'job-1' } = {}) {
	const store = new SqliteJobStore(openJobsDb(':memory:'));
	store.insert({ id, type: TEST_TYPE, created: new Date().toISOString(), params: {} });
	const backend = new DbJobBackend(
		makePlugin(), store, TEST_TYPE, TEST_CONFIG, { async run() { return result; } },
	);
	const outcome = await backend.runNext();
	return { row: store.get(id), store, outcome };
}

// ── each variant settles into its own bucket ──────────────────────────────────────────

test('a done result settles into done, carrying its outputPaths and notes', async () => {
	const { row, outcome } = await settle({
		status: 'done',
		outputPaths: ['notes/out.md'],
		notes: 'wrote one note',
	});
	assert.equal(outcome, 'ran');
	assert.equal(row.status, 'done');
	assert.deepEqual(row.outputPaths, ['notes/out.md']);
	assert.match(row.notes, /wrote one note/);
	assert.equal(row.error, undefined, 'a done job carries no error');
});

test('a failed result settles into failed with the workflow\'s own error — no placeholder', async () => {
	const { row, outcome } = await settle({ status: 'failed', error: 'the step blew up' });
	assert.equal(outcome, 'ran');
	assert.equal(row.status, 'failed');
	assert.equal(row.error, 'the step blew up');
	// `error` is required on the failed variant, so the backend never substitutes text.
	assert.doesNotMatch(row.error, /Workflow returned failed status/);
});

test('a deferred result goes back to queued with a defer window, not into failed', async () => {
	const { row, store, outcome } = await settle({
		status: 'deferred',
		error: 'companion down',
		notes: 'retrying shortly',
		retryAfterMs: 5_000,
	});
	// No `serviceUnhealthy`, so the drain keeps going rather than blocking the type.
	assert.equal(outcome, 'ran');
	assert.equal(row.status, 'queued', 'a deferral re-queues; it is not terminal');
	assert.equal(store.count('failed'), 0, 'a deferral must never read as a failure');
	assert.ok(row.deferUntil > Date.now(), 'the defer window survives the requeue');
	// The deferral message is written by setDeferred, NOT appended as run narration —
	// the settlement switch deliberately skips the notes append for this variant.
	assert.doesNotMatch(row.notes, /retrying shortly/);
});

test('a deferred result naming an unhealthy service blocks the type\'s drain', async () => {
	const { row, outcome } = await settle({
		status: 'deferred',
		error: 'companion down',
		retryAfterMs: 5_000,
		serviceUnhealthy: { service: 'search-companion', kind: 'refused', reason: 'companion down' },
	});
	assert.equal(outcome, 'blocked', 'a service outage ends this pass instead of sweeping the queue');
	assert.equal(row.status, 'queued');
});

test('a cancelled result settles into cancelled, never failed, and carries no error', async () => {
	const { row, store, outcome } = await settle({ status: 'cancelled', notes: 'Cancelled; stopped early' });
	assert.equal(outcome, 'ran');
	assert.equal(row.status, 'cancelled');
	assert.equal(store.count('failed'), 0, 'a cancellation is not a diagnostic failure');
	assert.equal(row.error, undefined);
	assert.match(row.notes, /stopped early/);
});

// ── the union's own shape rules, demonstrated at the runtime boundary ─────────────────

test('a cancelled result built by applyCancellation is settleable as-is', async () => {
	// The full round trip the review asked for: the pure rewrite produces a clean
	// cancelled variant, and that exact object settles into the cancelled bucket without
	// the backend having to defend against leftover deferred/failed fields.
	const rewritten = applyCancellation({
		status: 'deferred',
		error: 'youtube-api down',
		notes: 'all feeds failed',
		outputPaths: ['_intake/run.md'],
		retryAfterMs: 3_600_000,
		serviceUnhealthy: { service: 'youtube-api', kind: 'rate-limited', reason: 'quota' },
	}, true);
	assert.deepEqual(Object.keys(rewritten).sort(), ['notes', 'outputPaths', 'status']);

	const { row } = await settle(rewritten);
	assert.equal(row.status, 'cancelled');
	assert.equal(row.deferUntil, undefined, 'no deferral leaked across the rewrite');
	assert.deepEqual(row.outputPaths, ['_intake/run.md'], 'work already written is still recorded');
});

test('assertNever throws rather than silently returning undefined', () => {
	assert.throws(() => assertNever({ status: 'invented-variant' }), /Unhandled union member/);
});

// ── structural: the settlement ladder is one exhaustive switch ────────────────────────

test('DbJobBackend settles through an exhaustive switch with an assertNever backstop', async () => {
	const src = await readFile('src/orchestration/DbJobBackend.ts', 'utf8');
	assert.match(src, /switch \(result\.status\) \{/, 'settlement is a switch over the discriminant');
	for (const variant of ['done', 'failed', 'deferred', 'cancelled']) {
		assert.match(src, new RegExp(`case '${variant}':`), `every variant has its own case: ${variant}`);
	}
	assert.match(src, /return assertNever\(result\);/, 'the default branch is the exhaustiveness backstop');
	assert.doesNotMatch(src, /Workflow returned failed status/,
		'the required `error` makes the placeholder fallback dead code — it must be deleted, not kept');
});

test('the cancelled variant is constructed, never spread out of another variant', async () => {
	const src = await readFile('src/orchestration/cancellation.ts', 'utf8');
	assert.doesNotMatch(src, /\.\.\.result,/,
		'spreading one variant into another is the one hole the compiler leaves open');
	assert.doesNotMatch(src, /error: undefined/,
		'erasing an invalid field to undefined leaves it on the result as if it belonged there');
});

// The declaration body of one interface, doc comments excluded — so a comment that
// *mentions* a field can't make (or break) an assertion about which variant declares it.
function interfaceBody(src, name) {
	const start = src.indexOf(`export interface ${name} `);
	assert.notEqual(start, -1, `${name} must exist`);
	const open = src.indexOf('{', start);
	const close = src.indexOf('\n}', open);
	assert.ok(close > open, `${name} must be a brace-delimited declaration`);
	return src.slice(open, close);
}

test('WorkflowResult is a union, and only deferred declares the service fields', async () => {
	const src = await readFile('src/orchestration/types.ts', 'utf8');
	assert.match(src, /export type WorkflowResult =\s*\|\s*WorkflowDoneResult/, 'it is a union type');
	for (const variant of ['WorkflowFailedResult', 'WorkflowDeferredResult', 'WorkflowCancelledResult']) {
		assert.match(src, new RegExp(`\\|\\s*${variant}`), `${variant} is a member of the union`);
	}

	const done = interfaceBody(src, 'WorkflowDoneResult');
	const failed = interfaceBody(src, 'WorkflowFailedResult');
	const deferred = interfaceBody(src, 'WorkflowDeferredResult');
	const cancelled = interfaceBody(src, 'WorkflowCancelledResult');

	assert.match(deferred, /serviceUnhealthy\?:/, 'the service fields live on deferred');
	assert.match(deferred, /retryAfterMs\?: number;/);
	assert.match(failed, /\n\terror: string;/, 'error is required on failed, not optional');
	assert.doesNotMatch(failed, /serviceUnhealthy|retryAfterMs/, 'failed results carry no service-deferral data');
	for (const [name, body] of [['done', done], ['cancelled', cancelled]]) {
		assert.doesNotMatch(body, /error|failureReason|retryAfterMs|serviceUnhealthy/,
			`${name} carries only the common fields`);
	}
});
