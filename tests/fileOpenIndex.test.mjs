import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-file-open-index-tests');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

async function bundle(entry) {
	const outfile = path.join(outdir, `${path.basename(entry, '.ts')}.mjs`);
	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'es2020',
		outfile,
		logLevel: 'silent',
	});
	return import(pathToFileURL(outfile).href);
}

// `fileOpenIndex.ts` imports `CruciblePlugin` as `import type` only, so this bundles and
// runs in bare Node exactly like `fileOpenRanking.ts`/`rankScore.ts` — no `obsidian` value
// import ever gets pulled in. That is the whole point of the design: it's what lets the
// lifecycle class itself be unit-tested, not just its pure sub-pieces.
const {
	FILE_OPEN_BUILD_CHUNK_SIZE,
	FileOpenIndex,
	buildRecencyMap,
	shouldDiscardDeltaQueue,
} = await bundle('src/fileOpenIndex.ts');

const {
	compileExclusions,
	isPathExcluded,
	isPathExcludedCompiled,
} = await bundle('src/exclusions.ts');

const {
	FILE_OPEN_FLAG_IGNORED,
	FILE_OPEN_FLAG_TOMBSTONE,
	MODIFIER_CLAMP,
	RECENCY_MAX,
	buildFileOpenSnapshot,
} = await bundle('src/fileOpenRanking.ts');
const { TIER_FUZZY, TIER_SUBSTR } = await bundle('src/rankScore.ts');

/* -------------------------------------------------------------------------- */
/* test fixtures                                                              */
/* -------------------------------------------------------------------------- */

function candidate(path, extension = 'md', mtime = 1) {
	return { path, extension, stat: { mtime } };
}

function makePlugin(files, excludedFolders = [], chunkSize, userIgnored = []) {
	const ignored = new Set(userIgnored);
	const plugin = {
		app: {
			// Obsidian's own "Excluded files" list feeds the same IGNORED flag as Crucible's
			// excluded folders; getConfig exposes the raw list so a change to it shows up in
			// the exclusion signature.
			metadataCache: { isUserIgnored: path => ignored.has(path) },
			vault: {
				getFiles: () => files,
				getConfig: key => (key === 'userIgnoreFilters' ? [...ignored] : undefined),
			},
		},
		settings: { excludedFolders },
	};
	return chunkSize === undefined ? [plugin, {}] : [plugin, { chunkSize }];
}

/** Sorted, order-independent projection of the live (non-tombstoned) rows. */
function liveRows(snapshot) {
	const rows = [];
	for (let i = 0; i < snapshot.size; i++) {
		if ((snapshot.flags[i] & FILE_OPEN_FLAG_TOMBSTONE) !== 0) continue;
		rows.push({ path: snapshot.paths[i], ignored: (snapshot.flags[i] & FILE_OPEN_FLAG_IGNORED) !== 0 });
	}
	rows.sort((a, b) => a.path.localeCompare(b.path));
	return rows;
}

function corpus(n, prefix = 'note') {
	return Array.from({ length: n }, (_, i) => candidate(`folder${i % 5}/${prefix}-${i}.md`, 'md', i));
}

/* -------------------------------------------------------------------------- */
/* compileExclusions / isPathExcludedCompiled parity with isPathExcluded      */
/* -------------------------------------------------------------------------- */

test('compileExclusions + isPathExcludedCompiled agree with isPathExcluded', () => {
	const settings = {
		excludedFolders: [
			{ folder: '/Archive/', lint: true, search: false, localize: false },
			{ folder: '_crucible', lint: false, search: true, localize: false },
			{ folder: '', lint: true, search: true, localize: true }, // inactive row
			{ folder: 'Archive', lint: false, search: true, localize: false }, // dup, different scope
		],
	};

	for (const scope of ['lint', 'search', 'localize']) {
		const prefixes = compileExclusions(settings, scope);
		for (const p of ['Archive/note.md', 'Archive', '_crucible/debug.md', 'Unrelated/note.md', '', 'archive/note.md']) {
			assert.equal(
				isPathExcludedCompiled(prefixes, p),
				isPathExcluded(settings, p, scope),
				`scope=${scope} path=${JSON.stringify(p)}`,
			);
		}
	}
});

test('compileExclusions normalizes and dedupes, sorted', () => {
	const settings = {
		excludedFolders: [
			{ folder: '/Archive/', search: true },
			{ folder: 'Archive', search: true },
			{ folder: 'Zeta', search: true },
		],
	};
	assert.deepEqual(compileExclusions(settings, 'search'), ['Archive', 'Zeta']);
});

/* -------------------------------------------------------------------------- */
/* FileOpenIndex: chunked build lifecycle                                     */
/* -------------------------------------------------------------------------- */

test('getSnapshot() finishes a chunked build synchronously when opened mid-build', () => {
	const files = corpus(37);
	const [plugin, opts] = makePlugin(files, [], 5); // 5 rows/slice, 37 rows -> 8 slices
	const index = new FileOpenIndex(plugin, opts);
	index.markLayoutReady();
	// No timer has fired yet (we haven't yielded the event loop) -- getSnapshot() must
	// still return the complete set, exactly the "opened mid-build" contract.
	const snapshot = index.getSnapshot();
	assert.equal(snapshot.size, 37);
	assert.deepEqual(liveRows(snapshot).map(r => r.path), liveRows(buildFileOpenSnapshot(files.map(f => ({ path: f.path, extension: f.extension, mtime: f.stat.mtime })))).map(r => r.path));
});

test('a chunked build (many small slices) is field-equivalent to one full build', () => {
	const files = corpus(250);
	const asCandidates = files.map(f => ({ path: f.path, extension: f.extension, mtime: f.stat.mtime }));
	const fresh = buildFileOpenSnapshot(asCandidates);

	const [plugin, opts] = makePlugin(files, [], 7);
	const index = new FileOpenIndex(plugin, opts);
	index.markLayoutReady();
	const chunked = index.getSnapshot();

	assert.deepEqual(liveRows(chunked), liveRows(fresh));
	assert.equal(chunked.size, fresh.size);
});

test('default chunk size is exported and matches the WP-2 design (4000 rows/slice)', () => {
	assert.equal(FILE_OPEN_BUILD_CHUNK_SIZE, 4000);
});

/* -------------------------------------------------------------------------- */
/* FileOpenIndex: delta queue lifecycle                                       */
/* -------------------------------------------------------------------------- */

test('deltas are ignored until markLayoutReady(), so the initial create replay does not thrash', () => {
	const files = corpus(5);
	const [plugin, opts] = makePlugin(files, [], 2);
	const index = new FileOpenIndex(plugin, opts);

	// Vault replay before layout-ready: these must be dropped, not queued.
	index.handleCreate({ path: 'too-early.md', extension: 'md', mtime: 1 });
	index.handleDelete('folder0/note-0.md');

	index.markLayoutReady();
	const snapshot = index.getSnapshot();
	assert.equal(snapshot.byLower.has('too-early.md'), false);
	assert.equal(snapshot.byLower.has('folder0/note-0.md'), true);
});

test('add/delete/rename deltas converge on a fresh build of the same final set', () => {
	const files = corpus(30);
	const [plugin, opts] = makePlugin(files, [], 6);
	const index = new FileOpenIndex(plugin, opts);
	index.markLayoutReady();
	index.getSnapshot(); // force the initial build to finish before deltas arrive

	index.handleDelete('folder0/note-0.md');
	index.handleCreate({ path: 'new/added.md', extension: 'md', mtime: 999 });
	index.handleRename({ path: 'folder1/renamed.md', extension: 'md', mtime: 5 }, 'folder1/note-1.md');

	const incremental = index.getSnapshot();

	const expectedCandidates = files
		.map(f => ({ path: f.path, extension: f.extension, mtime: f.stat.mtime }))
		.filter(c => c.path !== 'folder0/note-0.md' && c.path !== 'folder1/note-1.md')
		.concat([
			{ path: 'new/added.md', extension: 'md', mtime: 999 },
			{ path: 'folder1/renamed.md', extension: 'md', mtime: 5 },
		]);
	const fresh = buildFileOpenSnapshot(expectedCandidates);

	assert.deepEqual(liveRows(incremental), liveRows(fresh));
});

test('a delta queue past the discard threshold is dropped and replaced by a full rebuild', () => {
	const initialFiles = corpus(100);
	const [plugin, opts] = makePlugin(initialFiles, [], 25);
	const index = new FileOpenIndex(plugin, opts);
	index.markLayoutReady();
	index.getSnapshot();

	// max(2000, 100 * 0.05) = 2000, so 2001 queued creates must trigger a discard+rebuild
	// rather than 2001 individual applies. Simulate a bulk import by mutating what the
	// "vault" reports and then queuing the same number of creates for it.
	const bulkFiles = initialFiles.concat(corpus(2001, 'bulk'));
	plugin.app.vault.getFiles = () => bulkFiles;
	for (let i = 0; i < 2001; i++) {
		index.handleCreate({ path: `folder${i % 5}/bulk-${i}.md`, extension: 'md', mtime: i });
	}

	const snapshot = index.getSnapshot();
	// The rebuild re-scans the (now-bulk) vault via getFiles(), so the result reflects the
	// full corpus, not a partial delta-applied state.
	assert.equal(snapshot.size, bulkFiles.length);
});

test('shouldDiscardDeltaQueue: max(2000, 5% of snapshot size)', () => {
	assert.equal(shouldDiscardDeltaQueue(2000, 100), false);
	assert.equal(shouldDiscardDeltaQueue(2001, 100), true);
	assert.equal(shouldDiscardDeltaQueue(5000, 200_000), false); // 5% of 200k = 10k
	assert.equal(shouldDiscardDeltaQueue(10_001, 200_000), true);
});

/* -------------------------------------------------------------------------- */
/* FileOpenIndex: exclusion-signature invalidation                            */
/* -------------------------------------------------------------------------- */

test('exclusion-signature invalidation: a settings change flips ignored flags without a full rebuild', () => {
	const files = [candidate('Archive/one.md'), candidate('Daily/two.md')];
	const [plugin, opts] = makePlugin(files, [{ folder: 'Archive', search: true }], 10);
	const index = new FileOpenIndex(plugin, opts);
	index.markLayoutReady();

	const before = index.getSnapshot();
	assert.equal(liveRows(before).find(r => r.path === 'Archive/one.md').ignored, true);
	assert.equal(liveRows(before).find(r => r.path === 'Daily/two.md').ignored, false);
	const versionBefore = before.version;

	// Exclusion config changes between opens (a settings edit) -- no vault event fires.
	plugin.settings.excludedFolders = [{ folder: 'Daily', search: true }];
	const after = index.getSnapshot();

	assert.equal(after, before, 'flags-only recompute reuses the same snapshot object');
	assert.equal(after.version, versionBefore, 'a flags-only pass must not bump version (narrowing state survives it)');
	assert.equal(liveRows(after).find(r => r.path === 'Archive/one.md').ignored, false);
	assert.equal(liveRows(after).find(r => r.path === 'Daily/two.md').ignored, true);

	// A second call with unchanged settings must be a no-op (same signature).
	const stable = index.getSnapshot();
	assert.equal(stable, after);
});

// Obsidian's Settings -> Files & links -> "Excluded files" list feeds the same IGNORED flag
// as Crucible's own excluded folders, so the palette deranks those paths instead of ignoring
// the setting the way it used to (FileSuggest/FolderSuggest/folderPicker always honored it).
// Deranked, not hidden: the row stays live and reachable by typing its exact name -- which is
// the deliberate difference from SearchManager, where a user-ignored path is not indexed.
test('Obsidian own excluded-files list deranks a palette row without removing it', () => {
	const files = [candidate('Private/journal.md'), candidate('Daily/two.md')];
	const [plugin, opts] = makePlugin(files, [], 10, ['Private/journal.md']);
	const index = new FileOpenIndex(plugin, opts);
	index.markLayoutReady();

	const rows = liveRows(index.getSnapshot());
	assert.deepEqual(rows.map(r => r.path), ['Daily/two.md', 'Private/journal.md'], 'still present, not filtered out');
	assert.equal(rows.find(r => r.path === 'Private/journal.md').ignored, true);
	assert.equal(rows.find(r => r.path === 'Daily/two.md').ignored, false);
});

// The signature has to cover Obsidian's list too. It is edited in Obsidian's own settings,
// which fires no vault event and does not touch plugin.settings, so without it in the
// fingerprint every IGNORED flag would stay stale until something else invalidated them.
test('editing Obsidian own excluded-files list re-flags the snapshot', () => {
	const files = [candidate('Private/journal.md'), candidate('Daily/two.md')];
	const [plugin, opts] = makePlugin(files, [], 10, []);
	const index = new FileOpenIndex(plugin, opts);
	index.markLayoutReady();

	assert.equal(liveRows(index.getSnapshot()).find(r => r.path === 'Private/journal.md').ignored, false);

	const nowIgnored = new Set(['Private/journal.md']);
	plugin.app.metadataCache.isUserIgnored = path => nowIgnored.has(path);
	plugin.app.vault.getConfig = key => (key === 'userIgnoreFilters' ? [...nowIgnored] : undefined);

	assert.equal(liveRows(index.getSnapshot()).find(r => r.path === 'Private/journal.md').ignored, true);
});

// Presence-guarded: vault.getConfig is undocumented, so an Obsidian build without it must
// degrade to the previous signature rather than throw on every getSnapshot().
test('a missing vault.getConfig leaves the exclusion signature usable', () => {
	const files = [candidate('Daily/two.md')];
	const [plugin, opts] = makePlugin(files, [], 10, []);
	delete plugin.app.vault.getConfig;
	const index = new FileOpenIndex(plugin, opts);
	index.markLayoutReady();

	const snapshot = index.getSnapshot();
	assert.deepEqual(liveRows(snapshot).map(r => r.path), ['Daily/two.md']);
	assert.equal(index.getSnapshot(), snapshot, 'signature stays stable across calls');
});

/* -------------------------------------------------------------------------- */
/* recency                                                                    */
/* -------------------------------------------------------------------------- */

test('buildRecencyMap skips index 0 only when it is the active file', () => {
	const map = buildRecencyMap(['Active.md', 'Second.md', 'Third.md'], 'Active.md');
	assert.equal(map.has('Active.md'), false);
	assert.deepEqual([...map.entries()], [['Second.md', 0], ['Third.md', 1]]);
});

test('buildRecencyMap keeps index 0 when it is not the active file', () => {
	const map = buildRecencyMap(['First.md', 'Second.md'], 'SomethingElse.md');
	assert.deepEqual([...map.entries()], [['First.md', 0], ['Second.md', 1]]);
});

test('buildRecencyMap: a since-deleted recent file just yields no entry, not a crash', () => {
	const map = buildRecencyMap(['Gone.md', 'Still-here.md'], undefined);
	assert.equal(map.size, 2); // building the map never checks vault existence -- that's a lookup miss at selection time
	assert.equal(map.get('Gone.md'), 0);
});

test('buildRecencyMap dedupes repeated paths, keeping the first (most recent) rank', () => {
	const map = buildRecencyMap(['A.md', 'B.md', 'A.md'], undefined);
	assert.deepEqual([...map.entries()], [['A.md', 0], ['B.md', 1]]);
});

/* -------------------------------------------------------------------------- */
/* the recency-cannot-cross-a-tier arithmetic, restated concretely            */
/* -------------------------------------------------------------------------- */

test('RECENCY ARITHMETIC: a maximally-recent FUZZY match can never outscore a cold SUBSTR match', () => {
	// Worst case for the clean match: minimum SUBSTR modifier (the clamp taken the wrong way).
	const worstSubstr = TIER_SUBSTR - MODIFIER_CLAMP;
	// Best case for the junk match: maximum FUZZY modifier plus the full recency bonus.
	const bestFuzzyWithRecency = TIER_FUZZY + MODIFIER_CLAMP + RECENCY_MAX;
	assert.equal(worstSubstr, 651);
	assert.equal(bestFuzzyWithRecency, 609);
	assert.ok(worstSubstr > bestFuzzyWithRecency, `${worstSubstr} must exceed ${bestFuzzyWithRecency}`);
});
