import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-search-workflow-tests');
const outfile = path.join(outdir, 'SearchIndexWorkflow.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
// A single stdin entry re-exporting both the workflows AND the search error classes
// (real relative import of src/search/types.ts, not stubbed — same pattern as
// tests/drainBreaker.test.mjs) so the test can construct/throw
// SearchServiceUnavailableError et al. and have `instanceof` line up against the same
// class the bundled workflow code checks. `TFile` is re-exported from the 'obsidian'
// stub for the same reason: it must be the identical class the bundle's own
// `instanceof TFile` checks compare against.
await esbuild.build({
	stdin: {
		contents: [
			"export { SearchRebuildWorkflow, SearchEmbedMissingWorkflow, SearchUpsertFileWorkflow, SearchUpsertBatchWorkflow, SearchDeletePathWorkflow, SearchSweepWorkflow } from './src/orchestration/workflows/SearchIndexWorkflow';",
			"export { SearchServiceUnavailableError, SearchEmbeddingUnavailableError, SearchEmbeddingMismatchError, SearchEmbeddingConfigError } from './src/search/types';",
			"export { TFile } from 'obsidian';",
		].join('\n'),
		resolveDir: '.',
		sourcefile: 'search-workflow-test-entry.ts',
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
				contents: 'export class TFile {}',
				loader: 'js',
			}));
		},
	}],
	outfile,
	logLevel: 'silent',
});

const {
	SearchRebuildWorkflow,
	SearchUpsertFileWorkflow,
	SearchUpsertBatchWorkflow,
	SearchDeletePathWorkflow,
	SearchServiceUnavailableError,
	SearchEmbeddingUnavailableError,
	SearchEmbeddingMismatchError,
	SearchEmbeddingConfigError,
	TFile,
} = await import(pathToFileURL(outfile));

// A TFile-like stand-in whose `instanceof TFile` matches the bundle's own class.
function fakeFile(filePath) {
	return Object.assign(new TFile(), { path: filePath });
}

function makePlugin(overrides = {}) {
	const enqueued = [];
	return {
		enqueued,
		settings: {
			searchEnabled: true,
			searchServiceUrl: 'http://127.0.0.1:4801',
		},
		searchManager: {
			companionAvailable: async () => true,
			companionUnavailableReason: () => null,
			markCompanionOffline: () => {},
			health: async () => ({ ok: true }),
			resetIndex: async () => {},
			listIndexableFiles: () => [],
			...overrides.searchManager,
		},
		orchestrator: {
			enqueue: async (type, params, options) => {
				enqueued.push({ type, params, options });
				return { id: `${type}-${enqueued.length}`, type, status: 'queued', priority: options?.priority ?? 'normal', lane: options?.lane ?? 'background' };
			},
		},
		app: {
			vault: {
				getAbstractFileByPath: () => null,
			},
		},
	};
}

// The full WorkflowContext shape. Cancellation widened it beyond `{ plugin }`, and
// the search workflows now checkpoint through it, so a partial stub throws.
// `runWorkflowWithTimeout` is what builds this in production.
function makeCtx(plugin, signal = new AbortController().signal) {
	return { plugin, signal, throwIfAborted: () => signal.throwIfAborted() };
}

test('SearchRebuildWorkflow enqueues low-priority batch jobs instead of indexing inline', async () => {
	let resetCount = 0;
	const plugin = makePlugin({
		searchManager: {
			resetIndex: async () => { resetCount++; },
			listIndexableFiles: () => Array.from({ length: 553 }, (_, i) => ({ path: `note-${i}.md` })),
		},
	});
	const result = await new SearchRebuildWorkflow().run({ id: 'rebuild-1', params: {} }, makeCtx(plugin));

	assert.equal(result.status, 'done');
	assert.equal(resetCount, 1);
	assert.equal(plugin.enqueued.length, 6);
	assert.ok(plugin.enqueued.every(job => job.type === 'search_upsert_batch'));
	assert.deepEqual(plugin.enqueued.map(job => job.params.paths.length), [100, 100, 100, 100, 100, 53]);
	assert.ok(plugin.enqueued.every(job => job.options.priority === 'low'));
	assert.ok(plugin.enqueued.every(job => job.options.lane === 'background'));
	assert.deepEqual(plugin.enqueued.map(job => job.params.batchIndex), [0, 1, 2, 3, 4, 5]);
	assert.ok(plugin.enqueued.every(job => job.params.batchCount === 6));
});

// Sized against the measured corpus, not the vault's raw markdown count: ~37,000 of this
// vault's ~42,000 .md files are the queue's own job files under the search-excluded
// `_crucible/`, leaving ~5,500 genuinely indexable. The batch size has to keep the job count
// well clear of the 25-era job spam (which was ~220 jobs at this scale) while staying fine
// enough that one failed batch doesn't lose a big slice of progress.
test('SearchRebuildWorkflow keeps a full-corpus rebuild to a few dozen job files', async () => {
	const CORPUS = 5_456;
	const plugin = makePlugin({
		searchManager: {
			listIndexableFiles: () => Array.from({ length: CORPUS }, (_, i) => ({ path: `note-${i}.md` })),
		},
	});
	const result = await new SearchRebuildWorkflow().run({ id: 'rebuild-2', params: {} }, makeCtx(plugin));

	assert.equal(result.status, 'done');
	assert.equal(plugin.enqueued.length, 55, '5,456 files at 100/batch is 55 jobs');
	// Every file is still covered exactly once, in order: batching must not drop a tail.
	const allPaths = plugin.enqueued.flatMap(job => job.params.paths);
	assert.equal(allPaths.length, CORPUS);
	assert.equal(new Set(allPaths).size, CORPUS);
	assert.equal(allPaths[0], 'note-0.md');
	assert.equal(allPaths[CORPUS - 1], `note-${CORPUS - 1}.md`);
	// The tail batch is the remainder, not a padded or dropped one.
	assert.equal(plugin.enqueued.at(-1).params.paths.length, CORPUS % 100);
});

test('search upsert defers quietly while the companion is offline', async () => {
	const plugin = makePlugin({
		searchManager: {
			companionAvailable: async () => false,
		},
	});
	const result = await new SearchUpsertFileWorkflow().run({ id: 'upsert-1', params: { path: 'note.md' } }, makeCtx(plugin));

	assert.equal(result.status, 'deferred');
	assert.match(result.error, /Search companion not reachable/);
	assert.equal(result.retryAfterMs, 30_000);
	// SE WP-4: every deferral names its service. There was no thrown exception to read a
	// finer kind from here (the gate already knew the companion was down), so this path
	// uses the same conservative default kind SearchServiceUnavailableError itself
	// defaults to for an unclassified failure.
	assert.deepEqual(result.serviceUnhealthy, { service: 'search-companion', kind: 'refused', reason: result.error });
});

// A reachable companion serving an index schema this build cannot query is unavailable too,
// but telling the user to go start the container would send them to restart something that
// is already running and healthy. When the companion gave a reason, it wins.
test('search upsert surfaces the companion reason instead of the not-reachable text', async () => {
	const reason = 'Search companion index schema 1 is older than this build requires (2). Rebuild the index.';
	const plugin = makePlugin({
		searchManager: {
			companionAvailable: async () => false,
			companionUnavailableReason: () => reason,
		},
	});
	const result = await new SearchUpsertFileWorkflow().run({ id: 'upsert-2', params: { path: 'note.md' } }, makeCtx(plugin));

	assert.equal(result.status, 'deferred');
	assert.equal(result.error, reason);
	assert.doesNotMatch(result.error, /not reachable/);
	assert.equal(result.retryAfterMs, 30_000);
	assert.deepEqual(result.serviceUnhealthy, { service: 'search-companion', kind: 'refused', reason });
});

// A companion outage discovered MID-RUN (a thrown SearchServiceUnavailableError, as
// opposed to the upfront gate already knowing it was down) must name the service with
// the error's OWN kind, not the conservative default — the client observed exactly what
// happened, so the deferral should say so.
test('a mid-run companion outage defers with serviceUnhealthy naming search-companion and the error\'s own kind', async () => {
	let offlineReason = null;
	const plugin = makePlugin({
		searchManager: {
			deletePath: async () => { throw new SearchServiceUnavailableError('connect ECONNREFUSED 127.0.0.1:4801', 'server-error'); },
			markCompanionOffline: (reason) => { offlineReason = reason; },
			companionUnavailableReason: () => offlineReason,
		},
	});
	const result = await new SearchDeletePathWorkflow().run({ id: 'del-1', params: { path: 'note.md' } }, makeCtx(plugin));

	assert.equal(result.status, 'deferred');
	assert.deepEqual(result.serviceUnhealthy, {
		service: 'search-companion',
		kind: 'server-error',
		reason: 'connect ECONNREFUSED 127.0.0.1:4801',
	});
});

// The end-to-end sanity the sprint promised: a companion-refused outage, observed exactly
// as `client.ts` would classify it (kind 'refused'), flows through the workflow with the
// shape the backend needs to open the breaker (WP-2's `deferEntry` reads exactly this
// field). tests/drainBreaker.test.mjs proves the backend/registry/drain half; this proves
// the workflow half produces the contract, using the REAL SearchDeletePathWorkflow rather
// than a hand-rolled outage stub.
test('a refused-connection outage produces the exact serviceUnhealthy shape the backend opens the breaker on', async () => {
	const plugin = makePlugin({
		searchManager: {
			deletePath: async () => { throw new SearchServiceUnavailableError('connect ECONNREFUSED 127.0.0.1:4801', 'refused'); },
		},
	});
	const result = await new SearchDeletePathWorkflow().run({ id: 'del-2', params: { path: 'note.md' } }, makeCtx(plugin));

	assert.equal(result.status, 'deferred');
	assert.equal(result.serviceUnhealthy.service, 'search-companion');
	assert.equal(result.serviceUnhealthy.kind, 'refused');
	assert.equal(typeof result.serviceUnhealthy.reason, 'string');
	assert.ok(result.serviceUnhealthy.reason.length > 0);
});

// The backfill path (requireEmbeddings) is the one that can observe the embedder
// failing to produce vectors at all — see SearchEmbedMissingWorkflow's doc comment.
// This must defer and name search-embedder, not fail the job outright: a
// `restart: unless-stopped` embedder blipping is a normal few-second event.
test('a backfill batch whose embedder is unavailable defers with serviceUnhealthy naming search-embedder', async () => {
	const plugin = makePlugin({
		searchManager: {
			indexFiles: async () => { throw new SearchEmbeddingUnavailableError('the embedder produced vectors for only 3 of 5 chunks'); },
		},
	});
	plugin.app.vault.getAbstractFileByPath = fakeFile;
	const result = await new SearchUpsertBatchWorkflow().run(
		{ id: 'batch-1', params: { paths: ['note.md'], batchIndex: 0, batchCount: 1, requireEmbeddings: true } },
		makeCtx(plugin),
	);

	assert.equal(result.status, 'deferred');
	assert.deepEqual(result.serviceUnhealthy, {
		service: 'search-embedder',
		kind: 'timeout',
		reason: 'the embedder produced vectors for only 3 of 5 chunks',
	});
	assert.equal(result.retryAfterMs, 30_000);
});

// SearchEmbeddingConfigError (an orphaned {providerId, modelId} ref) is PERMANENT — WP-6's
// whole point. It must come back as a loud job-level failure, never a deferral: deferring
// it would have the breaker read "search-embedder is down" and keep probing a
// misconfiguration that will never self-heal.
test('a backfill batch whose embedding ref is orphaned fails outright — permanent, not deferred', async () => {
	const plugin = makePlugin({
		searchManager: {
			indexFiles: async () => { throw new SearchEmbeddingConfigError('Embedding model not found: gone-model'); },
		},
	});
	plugin.app.vault.getAbstractFileByPath = fakeFile;
	const result = await new SearchUpsertBatchWorkflow().run(
		{ id: 'batch-2', params: { paths: ['note.md'], batchIndex: 0, batchCount: 1, requireEmbeddings: true } },
		makeCtx(plugin),
	);

	assert.equal(result.status, 'failed');
	assert.equal(result.error, 'Embedding model not found: gone-model');
	assert.equal(result.serviceUnhealthy, undefined,
		'a config error must never open the search-embedder breaker — retrying a misconfiguration is not a recovery');
});

// The same permanent-failure rule applies to a plain (non-backfill) index: a vector-width
// mismatch is a configuration bug regardless of which workflow discovered it.
test('a plain index whose embedder returns a width mismatch fails outright rather than deferring', async () => {
	const plugin = makePlugin({
		searchManager: {
			indexFile: async () => { throw new SearchEmbeddingMismatchError('Embedding model "x" is configured for 768 dimensions but returned 1024.'); },
		},
	});
	plugin.app.vault.getAbstractFileByPath = fakeFile;
	const result = await new SearchUpsertFileWorkflow().run({ id: 'upsert-4', params: { path: 'note.md' } }, makeCtx(plugin));

	assert.equal(result.status, 'failed');
	assert.match(result.error, /dimensions but returned/);
	assert.equal(result.serviceUnhealthy, undefined);
});
