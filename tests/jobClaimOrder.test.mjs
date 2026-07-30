import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Claim order: lane, then priority, then `created`, then id.
//
// thq WP-8 moved this file off `JobStore.listFolder`'s JS comparator (it was
// tests/jobStoreQueue.test.mjs) and onto `SqliteJobStore`'s
// `ORDER BY lane_rank, priority_rank, created, id`. The ordering contract is the same
// one — it has to be, because it is what the queue monitor renders and what `claimNext`
// claims — so pinning it against the store that now decides it is the point of the
// migration rather than incidental to it.
//
// The `created` tie-break in particular is load-bearing and non-obvious: batch fan-outs
// mint dozens of ids inside one tick, and before `newJobId` stamped milliseconds the
// comparator fell through to the random hex suffix, so batches claimed in random order
// relative to their batchIndex (see the newJobId quirk in orchestration/AGENTS.md).

globalThis.require = createRequire(import.meta.url);

const outdir = path.join(tmpdir(), 'obsidian-crucible-job-claim-order-tests');
const outfile = path.join(outdir, 'jobClaimOrder.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
	stdin: {
		contents: [
			"export { SqliteJobStore } from './src/orchestration/db/SqliteJobStore';",
			"export { openJobsDb } from './src/orchestration/db/sqlite';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'job-claim-order-test-entry.ts',
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
					'export class Notice {}',
					'export class TFile {}',
					'export class TFolder {}',
					'export class App {}',
					'export class FileSystemAdapter {}',
					'export function normalizePath(p) { return p; }',
				].join('\n'),
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const { SqliteJobStore, openJobsDb } = await import(pathToFileURL(outfile).href);

const TYPE = 'search_upsert_file';

function newStore() {
	return new SqliteJobStore(openJobsDb(':memory:'));
}

function insert(store, id, { priority, lane, created = id, params = {} } = {}) {
	store.insert({ id, type: TYPE, created, priority, lane, params });
}

function queuedIds(store) {
	return store.list('queued', {}).map(row => row.id);
}

test('the user lane is claimed before a higher-priority background job', () => {
	const store = newStore();
	insert(store, '001-background-high', { priority: 'high', lane: 'background' });
	insert(store, '002-user-low', { priority: 'low', lane: 'user' });
	insert(store, '003-user-high', { priority: 'high', lane: 'user' });

	assert.deepEqual(queuedIds(store), [
		'003-user-high',
		'002-user-low',
		'001-background-high',
	], 'lane outranks priority: a user-lane low beats a background high');
});

test('created tie-break inverts id order when id would sort the other way', () => {
	const store = newStore();
	insert(store, 'z-earlier', { priority: 'normal', lane: 'background', created: '2026-07-27T12:00:00.100Z' });
	insert(store, 'a-later', { priority: 'normal', lane: 'background', created: '2026-07-27T12:00:00.900Z' });

	// id compare alone would put 'a-later' first ('a' < 'z'); the created tie-break must
	// win and put the chronologically earlier job first instead.
	assert.deepEqual(queuedIds(store), ['z-earlier', 'a-later']);
});

test('identical created falls through to id compare', () => {
	const store = newStore();
	insert(store, 'b-second', { priority: 'normal', lane: 'background', created: '2026-07-27T12:00:00.500Z' });
	insert(store, 'a-first', { priority: 'normal', lane: 'background', created: '2026-07-27T12:00:00.500Z' });

	assert.deepEqual(queuedIds(store), ['a-first', 'b-second']);
});

test('a high-priority job with no lane defaults to the user lane', () => {
	// The markdown queue had legacy job files predating the lane field; the store keeps
	// the same defaulting rule (defaultLaneForPriority), so a caller that specifies only
	// a priority still lands where it always did.
	const store = newStore();
	insert(store, '001-background-normal', { priority: 'normal', lane: 'background' });
	insert(store, '002-legacy-high', { priority: 'high' });

	const rows = store.list('queued', {});
	assert.equal(rows[0].id, '002-legacy-high');
	assert.equal(rows[0].lane, 'user');
});

test('claimNext takes exactly the head of that order', () => {
	// The property the whole comparator exists for: what the queue monitor shows at the
	// top is what the drain claims next.
	const store = newStore();
	insert(store, 'c-background', { priority: 'normal', lane: 'background', created: '2026-07-27T12:00:00.100Z' });
	insert(store, 'a-user', { priority: 'normal', lane: 'user', created: '2026-07-27T12:00:00.900Z' });

	assert.deepEqual(queuedIds(store), ['a-user', 'c-background']);
	assert.equal(store.claimNext(Date.now(), [TYPE]).id, 'a-user');
	assert.equal(store.claimNext(Date.now(), [TYPE]).id, 'c-background');
	assert.equal(store.claimNext(Date.now(), [TYPE]), null);
});
