import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

// Bundles the real src/search/queryLog.ts. It imports nothing from `obsidian` (storage is a
// structural four-method interface), so no stub is needed — the module under test here is the
// same code the plugin ships.
const outdir = path.join(tmpdir(), 'obsidian-crucible-search-query-log-tests');
const outfile = path.join(outdir, 'queryLog.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/queryLog.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const {
	SEARCH_QUERY_LOG_VERSION,
	SearchQueryLog,
	appendLogEntry,
	applyOpen,
	applyRerank,
	buildQueryExport,
	normalizeMaxEntries,
	parseQueryLogFile,
	serializeQueryExport,
	serializeQueryLogFile,
	summarizeRanking,
} = await import(pathToFileURL(outfile));

// An in-memory stand-in for `app.vault.adapter`, satisfying the same four methods.
function memoryStorage(seed = {}) {
	const files = new Map(Object.entries(seed));
	return {
		files,
		writes: 0,
		async read(p) {
			if (!files.has(p)) throw new Error(`ENOENT ${p}`);
			return files.get(p);
		},
		async write(p, data) {
			this.writes++;
			files.set(p, data);
		},
		async exists(p) {
			return files.has(p);
		},
		async remove(p) {
			files.delete(p);
		},
	};
}

function makeLog(overrides = {}) {
	const storage = overrides.storage ?? memoryStorage();
	let n = 0;
	const log = new SearchQueryLog({
		storage,
		filePath: 'plugins/crucible/search-query-log.json',
		isEnabled: overrides.isEnabled ?? (() => true),
		maxEntries: overrides.maxEntries ?? (() => 500),
		now: overrides.now ?? (() => new Date('2026-07-26T12:00:00.000Z')),
		newId: overrides.newId ?? (() => `e${++n}`),
	});
	return { log, storage };
}

function entry(over = {}) {
	return {
		id: 'e1',
		at: '2026-07-26T12:00:00.000Z',
		query: 'pocock',
		mode: 'hybrid',
		reranked: false,
		semanticAvailable: true,
		sweep: false,
		shown: 2,
		total: 2,
		results: [{ path: 'A.md', rank: 1 }, { path: 'B.md', rank: 2 }],
		opened: null,
		...over,
	};
}

// --- ranking capture -------------------------------------------------------------------

test('summarizeRanking records paths with their 1-based on-screen ranks and nothing else', () => {
	const refs = summarizeRanking([
		{ path: 'A.md', title: 'A', snippet: 'secret note body', score: 9 },
		{ path: 'B.md', title: 'B', snippet: 'more body', score: 8 },
	]);
	assert.deepEqual(refs, [{ path: 'A.md', rank: 1 }, { path: 'B.md', rank: 2 }]);
	// The privacy contract: no snippet, title, score or chunk id may ride along.
	assert.deepEqual(Object.keys(refs[0]), ['path', 'rank']);
});

test('summarizeRanking keeps the best-ranked duplicate without renumbering the rows below it', () => {
	const refs = summarizeRanking([{ path: 'A.md' }, { path: 'A.md' }, { path: 'B.md' }]);
	// B stays at the rank the user actually saw it at (3), not shifted up to 2 by the dedupe.
	assert.deepEqual(refs, [{ path: 'A.md', rank: 1 }, { path: 'B.md', rank: 3 }]);
});

// --- the bound -------------------------------------------------------------------------

test('appendLogEntry enforces the bound by dropping the oldest entries first', () => {
	let entries = [];
	// 10 is the floor normalizeMaxEntries clamps to, so it is the smallest testable bound.
	for (let i = 1; i <= 13; i++) entries = appendLogEntry(entries, entry({ id: `e${i}` }), 10);
	assert.equal(entries.length, 10);
	assert.deepEqual(entries.map(e => e.id), ['e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10', 'e11', 'e12', 'e13']);
});

test('normalizeMaxEntries clamps to [10, 5000] and falls back on garbage', () => {
	assert.equal(normalizeMaxEntries(1), 10);
	assert.equal(normalizeMaxEntries(999999), 5000);
	assert.equal(normalizeMaxEntries('250'), 250);
	assert.equal(normalizeMaxEntries(250.7), 250);
	assert.equal(normalizeMaxEntries('not a number'), 500);
});

test('the store reads the bound live, so lowering it takes effect on the next search', async () => {
	let cap = 500;
	const { log } = makeLog({ maxEntries: () => cap });
	for (let i = 0; i < 12; i++) log.recordSearch({ query: `q${i}`, shown: 0, results: [] });
	await log.whenIdle();
	assert.equal((await log.snapshot()).length, 12);
	cap = 10;
	log.recordSearch({ query: 'q12', shown: 0, results: [] });
	await log.whenIdle();
	const entries = await log.snapshot();
	assert.equal(entries.length, 10);
	assert.equal(entries[0].query, 'q3');
	assert.equal(entries[9].query, 'q12');
});

// --- the click signal ------------------------------------------------------------------

test('applyOpen resolves the clicked rank from the ranking that was shown', () => {
	const next = applyOpen([entry()], 'e1', 'B.md', '2026-07-26T12:00:05.000Z');
	assert.deepEqual(next[0].opened, { path: 'B.md', rank: 2, at: '2026-07-26T12:00:05.000Z' });
});

test('applyOpen records a rank of null for a path that was not in the ranking', () => {
	const next = applyOpen([entry()], 'e1', 'Z.md', 'T');
	assert.equal(next[0].opened.rank, null);
});

test('applyOpen keeps the first click and ignores a later one', () => {
	const once = applyOpen([entry()], 'e1', 'B.md', 'T1');
	const twice = applyOpen(once, 'e1', 'A.md', 'T2');
	assert.equal(twice[0].opened.path, 'B.md');
});

test('applyOpen ignores an unknown id rather than throwing (the entry may have aged out)', () => {
	const next = applyOpen([entry()], 'gone', 'A.md', 'T');
	assert.equal(next[0].opened, null);
});

test('a search with no click is recorded as an absence, never as a failure flag', async () => {
	const { log } = makeLog();
	log.recordSearch({ query: 'unclicked', shown: 3, results: [{ path: 'A.md' }] });
	await log.whenIdle();
	const [logged] = await log.snapshot();
	assert.equal(logged.opened, null);
	// Nothing anywhere in the persisted entry may label the absence.
	const serialized = JSON.stringify(logged);
	for (const word of ['abandon', 'fail', 'miss', 'unsuccessful']) {
		assert.equal(serialized.toLowerCase().includes(word), false, `entry must not label the absence: ${word}`);
	}
});

// --- rerank ----------------------------------------------------------------------------

test('applyRerank replaces the recorded ranking and flags the entry', () => {
	const next = applyRerank([entry()], 'e1', [{ path: 'B.md' }, { path: 'A.md' }]);
	assert.equal(next[0].reranked, true);
	assert.deepEqual(next[0].results, [{ path: 'B.md', rank: 1 }, { path: 'A.md', rank: 2 }]);
});

test('a click after a rerank is scored against the reranked order', async () => {
	const { log } = makeLog();
	const id = log.recordSearch({ query: 'q', shown: 2, results: [{ path: 'A.md' }, { path: 'B.md' }] });
	log.recordRerank(id, [{ path: 'B.md' }, { path: 'A.md' }]);
	log.recordOpen(id, 'B.md');
	await log.whenIdle();
	const [logged] = await log.snapshot();
	assert.equal(logged.opened.rank, 1);
});

// --- the store: enablement, persistence, tolerance --------------------------------------

test('recordSearch is a no-op that writes nothing when logging is disabled', async () => {
	const { log, storage } = makeLog({ isEnabled: () => false });
	const id = log.recordSearch({ query: 'private', shown: 1, results: [{ path: 'A.md' }] });
	await log.whenIdle();
	assert.equal(id, null);
	assert.equal(storage.writes, 0);
	assert.equal(storage.files.size, 0);
});

test('an empty or whitespace-only query is not logged', async () => {
	const { log } = makeLog();
	assert.equal(log.recordSearch({ query: '   ', shown: 0, results: [] }), null);
	await log.whenIdle();
	assert.equal((await log.snapshot()).length, 0);
});

test('the log round-trips through the file and re-reads what a previous session wrote', async () => {
	const { log, storage } = makeLog();
	log.recordSearch({ query: 'first', mode: 'fts', shown: 1, results: [{ path: 'A.md' }] });
	await log.whenIdle();

	const reopened = new SearchQueryLog({
		storage,
		filePath: 'plugins/crucible/search-query-log.json',
		isEnabled: () => true,
		maxEntries: () => 500,
	});
	const entries = await reopened.snapshot();
	assert.equal(entries.length, 1);
	assert.equal(entries[0].query, 'first');
	assert.equal(entries[0].mode, 'fts');
});

test('concurrent records serialize: no write interleaves and no entry is lost', async () => {
	const { log } = makeLog();
	for (let i = 0; i < 20; i++) log.recordSearch({ query: `q${i}`, shown: 0, results: [] });
	await log.whenIdle();
	const entries = await log.snapshot();
	assert.equal(entries.length, 20);
	assert.deepEqual(entries.map(e => e.query), Array.from({ length: 20 }, (_, i) => `q${i}`));
});

test('a failing storage write never surfaces as a rejection to the search path', async () => {
	const storage = memoryStorage();
	storage.write = async () => { throw new Error('disk full'); };
	const { log } = makeLog({ storage });
	log.recordSearch({ query: 'q', shown: 0, results: [] });
	await log.whenIdle(); // must resolve, not reject
	// And the chain stays usable afterwards.
	log.recordSearch({ query: 'q2', shown: 0, results: [] });
	await log.whenIdle();
});

test('parseQueryLogFile tolerates garbage, a version mismatch and malformed entries', () => {
	assert.deepEqual(parseQueryLogFile('{ truncated'), []);
	assert.deepEqual(parseQueryLogFile('null'), []);
	assert.deepEqual(parseQueryLogFile(JSON.stringify({ version: 99, entries: [entry()] })), []);
	const mixed = JSON.stringify({ version: SEARCH_QUERY_LOG_VERSION, entries: [entry(), { id: 'bad' }] });
	assert.equal(parseQueryLogFile(mixed).length, 1);
});

test('serializeQueryLogFile stamps the version and round-trips', () => {
	const raw = serializeQueryLogFile([entry()]);
	assert.equal(JSON.parse(raw).version, SEARCH_QUERY_LOG_VERSION);
	assert.equal(parseQueryLogFile(raw)[0].id, 'e1');
});

test('a corrupt log file is replaced rather than blocking new records', async () => {
	const storage = memoryStorage({ 'plugins/crucible/search-query-log.json': '{{{ not json' });
	const { log } = makeLog({ storage });
	log.recordSearch({ query: 'after corruption', shown: 0, results: [] });
	await log.whenIdle();
	const entries = await log.snapshot();
	assert.equal(entries.length, 1);
	assert.equal(entries[0].query, 'after corruption');
});

test('clear() empties the log and deletes the file', async () => {
	const { log, storage } = makeLog();
	log.recordSearch({ query: 'q', shown: 0, results: [] });
	await log.whenIdle();
	const discarded = await log.clear();
	assert.equal(discarded, 1);
	assert.equal(storage.files.size, 0);
	assert.deepEqual(await log.snapshot(), []);
});

// --- the S2 export ---------------------------------------------------------------------

test('buildQueryExport emits {id, text, source, targetPaths} seeded from what was opened', () => {
	const entries = [
		entry({ id: 'e1', query: 'pocock', opened: { path: 'A.md', rank: 4, at: 'T' } }),
	];
	const result = buildQueryExport(entries);
	assert.deepEqual(result.queries, [{ id: 'q-001', text: 'pocock', source: 'vault-log', targetPaths: ['A.md'] }]);
});

test('buildQueryExport omits click-less queries and counts them instead of exporting a zero-target row', () => {
	const entries = [
		entry({ id: 'e1', query: 'clicked', opened: { path: 'A.md', rank: 1, at: 'T' } }),
		entry({ id: 'e2', query: 'never clicked', opened: null }),
	];
	const result = buildQueryExport(entries);
	assert.equal(result.queries.length, 1);
	assert.equal(result.queries[0].text, 'clicked');
	assert.equal(result.withoutTarget, 1);
	// The point of the omission: no exported row may carry an empty target set, because every
	// IR metric would score it as a miss — i.e. as an abandoned search.
	assert.equal(result.queries.every(q => q.targetPaths.length > 0), true);
});

test('buildQueryExport collapses repeats of one query and orders targets by how often they were opened', () => {
	const entries = [
		entry({ id: 'e1', query: 'Pocock', opened: { path: 'A.md', rank: 1, at: 'T' } }),
		entry({ id: 'e2', query: '  pocock  ', opened: { path: 'B.md', rank: 2, at: 'T' } }),
		entry({ id: 'e3', query: 'pocock', opened: { path: 'B.md', rank: 2, at: 'T' } }),
	];
	const result = buildQueryExport(entries);
	assert.equal(result.queries.length, 1);
	assert.equal(result.queries[0].text, 'Pocock'); // first-seen spelling wins
	assert.deepEqual(result.queries[0].targetPaths, ['B.md', 'A.md']); // 2 opens vs 1
});

test('buildQueryExport excludes sweep briefs by default and includes them on request', () => {
	const entries = [
		entry({ id: 'e1', query: 'a project brief', sweep: true, opened: { path: 'A.md', rank: 1, at: 'T' } }),
		entry({ id: 'e2', query: 'a term', opened: { path: 'B.md', rank: 1, at: 'T' } }),
	];
	const plain = buildQueryExport(entries);
	assert.deepEqual(plain.queries.map(q => q.text), ['a term']);
	assert.equal(plain.sweepsSkipped, 1);
	const withSweeps = buildQueryExport(entries, { includeSweeps: true });
	assert.deepEqual(withSweeps.queries.map(q => q.text), ['a project brief', 'a term']);
});

test('buildQueryExport numbers ids densely over the exported rows only', () => {
	const entries = [
		entry({ id: 'e1', query: 'no click', opened: null }),
		entry({ id: 'e2', query: 'one', opened: { path: 'A.md', rank: 1, at: 'T' } }),
		entry({ id: 'e3', query: 'two', opened: { path: 'B.md', rank: 1, at: 'T' } }),
	];
	assert.deepEqual(buildQueryExport(entries).queries.map(q => q.id), ['q-001', 'q-002']);
});

test('serializeQueryExport writes a parseable S2 query file', () => {
	const { queries } = buildQueryExport([entry({ opened: { path: 'A.md', rank: 1, at: 'T' } })]);
	const parsed = JSON.parse(serializeQueryExport(queries));
	assert.deepEqual(parsed.queries[0].targetPaths, ['A.md']);
});
