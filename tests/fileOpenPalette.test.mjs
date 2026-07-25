import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-file-open-tests');
const outfile = path.join(outdir, 'fileOpenRanking.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/fileOpenRanking.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const {
	FILE_OPEN_FLAG_IGNORED,
	MODIFIER_CLAMP,
	RECENCY_MAX,
	applyFileOpenDeltas,
	buildFileOpenMatch,
	buildFileOpenSnapshot,
	compactFileOpenSnapshot,
	createNarrowState,
	formatExtensionFilter,
	normalizeCreatePath,
	parseExtensionFilter,
	recomputeIgnoredFlags,
	selectFileOpenItems,
} = await import(pathToFileURL(outfile).href);

const files = [
	{ path: 'Daily/2026-07-06.md', extension: 'md' },
	{ path: 'Archive/2026-07-06.md', extension: 'md' },
	{ path: 'Media/Chart.PNG', extension: 'png' },
	{ path: '_crucible/debug.md', extension: 'md' },
];

const isIgnoredPath = p => p.startsWith('_crucible') || p.startsWith('Archive/');

function snapshotOf(candidates = files) {
	return buildFileOpenSnapshot(candidates, { isIgnoredPath, exclusionSig: 'search:v1' });
}

function select(overrides = {}) {
	const { query = '2026', snapshot = snapshotOf(), state = null, ...options } = overrides;
	return selectFileOpenItems(snapshot, query, state, {
		extensions: [],
		ignoredFolderMode: 'derank',
		createMissing: false,
		...options,
	});
}

const paths = items => items.map(item => item.path);

/* ------------------------------------------------------------ conventions */

test('SORT DIRECTION: the higher-scoring candidate is returned first', () => {
	// Two candidates for `log`: an exact basename-stem match and a path-only
	// subsequence. Scores are read back off the returned items, so this test fails
	// loudly if the comparator is ever flipped back to ascending.
	const items = select({
		query: 'log',
		snapshot: snapshotOf([
			{ path: 'Legal/Origins.md', extension: 'md' },
			{ path: 'log.md', extension: 'md' },
		]),
		ignoredFolderMode: 'include',
	});
	assert.deepEqual(paths(items), ['log.md', 'Legal/Origins.md']);
	assert.ok(items[0].score > items[1].score, `${items[0].score} must exceed ${items[1].score}`);
});

test('tier ordering table: "log" ranks exact > prefix > word > substring > path fuzzy', () => {
	const candidates = ['log.md', 'logbook.md', 'daily-log.md', 'catalogue.md', 'Legal/Origins.md'];
	const items = select({
		query: 'log',
		snapshot: snapshotOf(candidates.map(p => ({ path: p, extension: 'md' }))),
		ignoredFolderMode: 'include',
	});
	// Under the pre-rewrite ascending sort this list came out backwards.
	assert.deepEqual(paths(items), candidates);
});

test('length normalization and depth tiebreak', () => {
	const shortWins = select({
		query: 'log',
		snapshot: snapshotOf([
			{ path: 'logistics-planning-document.md', extension: 'md' },
			{ path: 'log.md', extension: 'md' },
		]),
		ignoredFolderMode: 'include',
	});
	assert.equal(shortWins[0].path, 'log.md');

	const shallowWins = select({
		query: 'log',
		snapshot: snapshotOf([
			{ path: 'a/b/c/log.md', extension: 'md' },
			{ path: 'a/log.md', extension: 'md' },
		]),
		ignoredFolderMode: 'include',
	});
	assert.deepEqual(paths(shallowWins), ['a/log.md', 'a/b/c/log.md']);
});

/* ---------------------------------------------------------------- filters */

test('fuzzy matching still searches full file paths', () => {
	assert.deepEqual(paths(select({ query: 'mchart' })), ['Media/Chart.PNG']);
});

test('derank mode pushes search-excluded folders below normal matches', () => {
	const items = select();
	assert.equal(items[0].path, 'Daily/2026-07-06.md');
	assert.deepEqual(paths(items).slice(1), ['Archive/2026-07-06.md']);
});

test('hide mode removes search-excluded folders', () => {
	assert.deepEqual(paths(select({ ignoredFolderMode: 'hide' })), ['Daily/2026-07-06.md']);
});

test('include mode ranks ignored folders normally', () => {
	assert.deepEqual(paths(select({ ignoredFolderMode: 'include' })), ['Daily/2026-07-06.md', 'Archive/2026-07-06.md']);
});

test('DERANK WITH REAL SCORES: a perfect ignored match sorts below a terrible clean one', () => {
	const snapshot = buildFileOpenSnapshot([
		// Exact basename stem — the best score the scorer can produce.
		{ path: 'Archive/log.md', extension: 'md' },
		// Path subsequence only — near the bottom of the tier table.
		{ path: 'Legal/Origins.md', extension: 'md' },
	], { isIgnoredPath });

	const deranked = selectFileOpenItems(snapshot, 'log', null, { ignoredFolderMode: 'derank' });
	assert.deepEqual(paths(deranked), ['Legal/Origins.md', 'Archive/log.md']);
	// The scores themselves still say the opposite — the derank group is what reorders,
	// which is only meaningful because the scores are no longer inverted.
	assert.ok(deranked[1].score > deranked[0].score);

	const included = selectFileOpenItems(snapshot, 'log', null, { ignoredFolderMode: 'include' });
	assert.deepEqual(paths(included), ['Archive/log.md', 'Legal/Origins.md']);
});

test('extension filter is case-insensitive and blank means all files', () => {
	assert.deepEqual(paths(select({ query: 'chart', extensions: [] })), ['Media/Chart.PNG']);
	assert.deepEqual(paths(select({ query: 'chart', extensions: ['PNG'] })), ['Media/Chart.PNG']);
	assert.deepEqual(paths(select({ query: 'chart', extensions: ['md'] })), []);
});

test('create row is configurable and suppressed for existing paths', () => {
	assert.deepEqual(select({ query: 'New Note', createMissing: false }).map(item => item.kind), []);
	assert.deepEqual(select({ query: 'New Note', createMissing: true }), [{ kind: 'create', path: 'New Note.md' }]);
	assert.deepEqual(select({ query: 'Daily/2026-07-06.md', createMissing: true }).map(item => item.kind), ['file']);
});

test('create paths append md only when no extension is present', () => {
	assert.equal(normalizeCreatePath('Projects/Foo'), 'Projects/Foo.md');
	assert.equal(normalizeCreatePath('Projects/Foo.md'), 'Projects/Foo.md');
	assert.equal(normalizeCreatePath('Projects/Foo.canvas'), null);
	assert.equal(normalizeCreatePath('Projects/'), null);
});

test('extension filter parser normalizes commas, whitespace, dots, and duplicates', () => {
	const parsed = parseExtensionFilter(' .md, canvas PDF md ');
	assert.deepEqual(parsed, ['md', 'canvas', 'pdf']);
	assert.equal(formatExtensionFilter(parsed), 'canvas, md, pdf');
});

/* ------------------------------------------------------------ empty query */

test('empty query orders by recency, then mtime, then depth', () => {
	const snapshot = buildFileOpenSnapshot([
		{ path: 'Old.md', extension: 'md', mtime: 1000 },
		{ path: 'Newer.md', extension: 'md', mtime: 5000 },
		{ path: 'Recent.md', extension: 'md', mtime: 10 },
		{ path: 'AlsoRecent.md', extension: 'md', mtime: 20 },
	], {});
	const recency = new Map([['Recent.md', 0], ['AlsoRecent.md', 1]]);
	const items = selectFileOpenItems(snapshot, '', null, { recency });
	assert.deepEqual(paths(items), ['Recent.md', 'AlsoRecent.md', 'Newer.md', 'Old.md']);
	assert.deepEqual(items.map(item => item.score), [null, null, null, null]);

	// No recency data at all: pure mtime desc.
	assert.deepEqual(
		paths(selectFileOpenItems(snapshot, '', null, {})),
		['Newer.md', 'Old.md', 'AlsoRecent.md', 'Recent.md'],
	);
});

test('recency reorders within a tier but can never cross the substring/fuzzy boundary', () => {
	// The arithmetic guarantee, restated against the selection layer.
	assert.ok(RECENCY_MAX + 2 * MODIFIER_CLAMP < 700 - 500);

	const snapshot = buildFileOpenSnapshot([
		{ path: 'catalogue.md', extension: 'md' },
		{ path: 'l-o-g-s.md', extension: 'md' },
	], {});
	const recency = new Map([['l-o-g-s.md', 0]]);
	const items = selectFileOpenItems(snapshot, 'log', null, { recency, recencyCount: 1 });
	assert.deepEqual(paths(items), ['catalogue.md', 'l-o-g-s.md']);
});

/* -------------------------------------------------------------- snapshots */

test('SNAPSHOT DELTA EQUIVALENCE: add/rename/delete converge on a fresh full build', () => {
	const initial = [
		{ path: 'a/one.md', extension: 'md', mtime: 1 },
		{ path: 'a/two.md', extension: 'md', mtime: 2 },
		{ path: 'b/three.canvas', extension: 'canvas', mtime: 3 },
		{ path: 'b/four.png', extension: 'png', mtime: 4 },
		{ path: '_crucible/debug.md', extension: 'md', mtime: 5 },
	];

	const incremental = buildFileOpenSnapshot(initial, { isIgnoredPath, exclusionSig: 'search:v1' });
	applyFileOpenDeltas(incremental, [
		{ kind: 'del', path: 'a/two.md' },
		{ kind: 'add', path: 'c/five.md', extension: 'md', mtime: 6 },
		// A rename is a del + add of the same file.
		{ kind: 'del', path: 'b/four.png' },
		{ kind: 'add', path: 'Archive/four.png', extension: 'png', mtime: 4 },
		{ kind: 'del', path: 'c/five.md' },
		{ kind: 'add', path: 'c/five.md', extension: 'md', mtime: 7 },
	], { isIgnoredPath });
	compactFileOpenSnapshot(incremental);

	const expectedOrder = [
		{ path: 'a/one.md', extension: 'md', mtime: 1 },
		{ path: 'b/three.canvas', extension: 'canvas', mtime: 3 },
		{ path: '_crucible/debug.md', extension: 'md', mtime: 5 },
		{ path: 'Archive/four.png', extension: 'png', mtime: 4 },
		{ path: 'c/five.md', extension: 'md', mtime: 7 },
	];
	const fresh = buildFileOpenSnapshot(expectedOrder, { isIgnoredPath, exclusionSig: 'search:v1' });

	assert.deepEqual(project(incremental), project(fresh));
});

test('chunked row-range builds equal a single full build', () => {
	const candidates = Array.from({ length: 250 }, (_, i) => ({
		path: `folder${i % 7}/note-${i}.md`,
		extension: 'md',
		mtime: i,
	}));
	const full = buildFileOpenSnapshot(candidates, { isIgnoredPath, exclusionSig: 'search:v1' });
	let chunked = null;
	for (let from = 0; from < candidates.length; from += 40) {
		chunked = buildFileOpenSnapshot(candidates, {
			isIgnoredPath,
			exclusionSig: 'search:v1',
			into: chunked ?? undefined,
			from,
			to: Math.min(from + 40, candidates.length),
		});
	}
	assert.deepEqual(project(chunked), project(full));
});

test('duplicate adds do not create duplicate rows', () => {
	const snapshot = snapshotOf();
	const before = snapshot.size;
	applyFileOpenDeltas(snapshot, [{ kind: 'add', path: 'Daily/2026-07-06.md', extension: 'md', mtime: 42 }], { isIgnoredPath });
	assert.equal(snapshot.size, before);
	assert.equal(snapshot.mtime[snapshot.byLower.get('daily/2026-07-06.md')], 42);
});

test('recomputeIgnoredFlags is a flags-only pass that preserves narrowing state', () => {
	const snapshot = snapshotOf();
	const version = snapshot.version;
	assert.equal((snapshot.flags[snapshot.byLower.get('archive/2026-07-06.md')] & FILE_OPEN_FLAG_IGNORED) !== 0, true);

	recomputeIgnoredFlags(snapshot, () => false, 'search:v2');
	assert.equal(snapshot.exclusionSig, 'search:v2');
	assert.equal(snapshot.version, version, 'a flags pass must not invalidate row ids');
	for (let i = 0; i < snapshot.size; i++) {
		assert.equal(snapshot.flags[i] & FILE_OPEN_FLAG_IGNORED, 0);
	}
	assert.deepEqual(paths(select({ snapshot, ignoredFolderMode: 'hide' })), ['Daily/2026-07-06.md', 'Archive/2026-07-06.md']);
});

/* -------------------------------------------------------------- narrowing */

test('NARROWING EQUIVALENCE: every prefix path, including backspace, matches a cold select', () => {
	const rng = mulberry32(20260724);
	const corpus = Array.from({ length: 900 }, (_, i) => ({
		path: randomPath(rng, i),
		extension: 'md',
		mtime: i,
	}));
	const snapshot = buildFileOpenSnapshot(corpus, { isIgnoredPath });
	const options = { ignoredFolderMode: 'derank', createMissing: true, limit: 25 };

	for (const target of ['log', 'daily-log', 'archive/2026', 'note x', 'crucible', 'zzz', 'l']) {
		const cold = selectFileOpenItems(snapshot, target, null, options);

		// Typed one character at a time.
		const typing = createNarrowState();
		for (let i = 1; i <= target.length; i++) selectFileOpenItems(snapshot, target.slice(0, i), typing, options);
		assert.deepEqual(selectFileOpenItems(snapshot, target, typing, options), cold, `typing "${target}"`);

		// ...then backspaced all the way down and retyped.
		for (let i = target.length; i >= 0; i--) selectFileOpenItems(snapshot, target.slice(0, i), typing, options);
		for (let i = 1; i <= target.length; i++) selectFileOpenItems(snapshot, target.slice(0, i), typing, options);
		assert.deepEqual(selectFileOpenItems(snapshot, target, typing, options), cold, `backspace "${target}"`);

		// ...and reached by a paste (non-prefix edit) from an unrelated query.
		const pasting = createNarrowState();
		selectFileOpenItems(snapshot, 'unrelated query', pasting, options);
		assert.deepEqual(selectFileOpenItems(snapshot, target, pasting, options), cold, `paste "${target}"`);
	}
});

test('narrowing survives a random walk of edits', () => {
	const rng = mulberry32(4242);
	const corpus = Array.from({ length: 600 }, (_, i) => ({ path: randomPath(rng, i), extension: 'md', mtime: i }));
	const snapshot = buildFileOpenSnapshot(corpus, { isIgnoredPath });
	const options = { ignoredFolderMode: 'hide', limit: 10 };
	const state = createNarrowState();
	const alphabet = 'aeloginrst /-2';
	let query = '';
	for (let step = 0; step < 600; step++) {
		const roll = rng();
		if (roll < 0.35 && query.length > 0) query = query.slice(0, -1);
		else if (roll < 0.45) query = alphabet.slice(0, 1 + Math.floor(rng() * 5));
		else query += alphabet[Math.floor(rng() * alphabet.length)];
		const warm = selectFileOpenItems(snapshot, query, state, options);
		const cold = selectFileOpenItems(snapshot, query, null, options);
		assert.deepEqual(warm, cold, `query ${JSON.stringify(query)}`);
	}
});

test('narrowing state resets when the snapshot or the filters change', () => {
	const snapshot = snapshotOf();
	const state = createNarrowState();
	const options = { ignoredFolderMode: 'include', limit: 50 };
	selectFileOpenItems(snapshot, '2026', state, options);

	applyFileOpenDeltas(snapshot, [{ kind: 'add', path: 'Daily/2026-08-01.md', extension: 'md' }], { isIgnoredPath });
	assert.deepEqual(
		selectFileOpenItems(snapshot, '2026', state, options),
		selectFileOpenItems(snapshot, '2026', null, options),
	);

	selectFileOpenItems(snapshot, '2026', state, options);
	const filtered = { ...options, extensions: ['md'] };
	assert.deepEqual(
		selectFileOpenItems(snapshot, '2026', state, filtered),
		selectFileOpenItems(snapshot, '2026', null, filtered),
	);
});

test('ADMISSION MONOTONICITY: nothing admitted for q+c was rejected for q', () => {
	const rng = mulberry32(31337);
	const corpus = Array.from({ length: 800 }, (_, i) => ({ path: randomPath(rng, i), extension: 'md', mtime: i }));
	const snapshot = buildFileOpenSnapshot(corpus, { isIgnoredPath });
	const options = { ignoredFolderMode: 'include', limit: corpus.length };

	for (const target of ['daily-log', 'archive 2026', 'crucible/notes', 'ml']) {
		for (let i = 1; i < target.length; i++) {
			const shorter = new Set(paths(selectFileOpenItems(snapshot, target.slice(0, i), null, options)));
			for (const admitted of paths(selectFileOpenItems(snapshot, target.slice(0, i + 1), null, options))) {
				assert.ok(shorter.has(admitted), `"${admitted}" admitted for a longer query but not the shorter one`);
			}
		}
	}
});

/* ----------------------------------------------------------------- render */

test('buildFileOpenMatch returns renderResults-safe ranges', () => {
	const match = buildFileOpenMatch('chart', 'Media/Chart.PNG', 12);
	assert.equal(match.score, 12);
	assert.deepEqual(match.matches, [[6, 11]]);
	assert.equal('Media/Chart.PNG'.slice(6, 11), 'Chart');
	assert.deepEqual(buildFileOpenMatch('', 'Media/Chart.PNG').matches, []);
	assert.deepEqual(buildFileOpenMatch('zzz', 'Media/Chart.PNG').matches, []);
});

test('the top-K heap returns exactly the best `limit` rows', () => {
	const candidates = Array.from({ length: 400 }, (_, i) => ({
		path: `note-${String(i).padStart(3, '0')}-log.md`,
		extension: 'md',
		mtime: i,
	}));
	const snapshot = buildFileOpenSnapshot(candidates, {});
	const all = selectFileOpenItems(snapshot, 'log', null, { limit: candidates.length });
	const top = selectFileOpenItems(snapshot, 'log', null, { limit: 10 });
	assert.equal(all.length, 400);
	assert.equal(top.length, 10);
	assert.deepEqual(paths(top), paths(all).slice(0, 10));
});

/* ---------------------------------------------------------------- helpers */

function project(snapshot) {
	const rows = [];
	for (let i = 0; i < snapshot.size; i++) {
		rows.push({
			path: snapshot.paths[i],
			lower: snapshot.lower[i],
			nameStart: snapshot.nameStart[i],
			nameLen: snapshot.nameLen[i],
			pathLen: snapshot.pathLen[i],
			depth: snapshot.depth[i],
			extId: snapshot.extId[i],
			ext: snapshot.extNames[snapshot.extId[i]],
			maskPath: snapshot.maskPath[i],
			maskName: snapshot.maskName[i],
			flags: snapshot.flags[i],
			mtime: snapshot.mtime[i],
		});
	}
	return {
		rows,
		size: snapshot.size,
		tombstones: snapshot.tombstones,
		exclusionSig: snapshot.exclusionSig,
		extNames: snapshot.extNames,
		extIds: Array.from(snapshot.extIds.entries()),
		byLower: Array.from(snapshot.byLower.entries()),
		capacity: snapshot.nameStart.length,
	};
}

function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = ['daily', 'log', 'notes', 'crucible', 'archive', 'media', 'chart', 'origins', 'legal', 'note', 'x', '2026'];

function randomPath(rng, index) {
	const depth = Math.floor(rng() * 4);
	const parts = [];
	for (let i = 0; i < depth; i++) parts.push(WORDS[Math.floor(rng() * WORDS.length)]);
	const stem = `${WORDS[Math.floor(rng() * WORDS.length)]}-${WORDS[Math.floor(rng() * WORDS.length)]}-${index}`;
	parts.push(`${stem}.md`);
	return parts.join('/');
}
