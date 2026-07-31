// WP-6: the link-adjacency spider layer. `linkGraph.ts` splits into a pure scoring core
// (`applyLinkBoost`, `LinkGraph`) and a thin app-taking derivation (`buildLinkGraph`), in
// the style of `src/orchestration/utils/blogsIntake.ts` — so `applyLinkBoost` is tested here
// against plain data, and `buildLinkGraph` against a minimal mock `App`, without pulling in
// the real `obsidian` package at runtime (the file only imports it as a type, so no stub
// plugin is required to bundle it).
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const outdir = path.join(tmpdir(), 'obsidian-crucible-link-graph-tests');
const outfile = path.join(outdir, 'linkGraph.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await esbuild.build({
	entryPoints: ['src/search/linkGraph.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'es2020',
	outfile,
	logLevel: 'silent',
});

const {
	LINK_BOOST_RRF_K,
	applyLinkBoost,
	buildLinkGraph,
	citersOf,
} = await import(pathToFileURL(outfile));

function result(resultPath, score) {
	return { chunkId: `${resultPath}#0`, path: resultPath, title: resultPath, snippet: '', score };
}

// Build a `LinkGraph` directly from an edge list — bypasses `buildLinkGraph`/`App` entirely,
// matching what a caller of the pure core (e.g. a future non-Obsidian consumer) would do.
// `citedBy` is populated alongside `adjacency` so this one helper serves both the boost
// tests (which only ever read `adjacency`) and the WP-PF4 `citersOf` tests below.
function graphFromEdges(edges) {
	const adjacency = new Map();
	const citedBy = new Map();
	const add = (a, b) => {
		if (!adjacency.has(a)) adjacency.set(a, new Set());
		adjacency.get(a).add(b);
	};
	const cite = (cited, citer) => {
		if (!citedBy.has(cited)) citedBy.set(cited, new Set());
		citedBy.get(cited).add(citer);
	};
	for (const [a, b] of edges) {
		add(a, b);
		add(b, a);
		cite(b, a); // directed: a cites b
	}
	return { adjacency, citedBy };
}

test('buildLinkGraph includes a frontmatter-only link that resolvedLinks alone misses', () => {
	// resolvedLinks (embeds/body links) carries no edge here — the only path from note.md to
	// target.md is a frontmatter property link (e.g. `cover: [[target]]`). This is exactly
	// the gap documented for the Orphaned Attachments dashboard
	// (src/ingestion/data/orphanedAttachments.ts) — the reason frontmatterLinks has to be
	// unioned in by hand rather than trusting resolvedLinks alone.
	const app = {
		metadataCache: {
			resolvedLinks: {},
			getFileCache: (file) => ({ frontmatterLinks: file.frontmatterLinks ?? [] }),
			getFirstLinkpathDest: (link) => (link === 'target' ? { path: 'target.md' } : null),
		},
		vault: {
			getFiles: () => [
				{ path: 'note.md', frontmatterLinks: [{ link: 'target', key: 'cover', original: '[[target]]' }] },
				{ path: 'target.md', frontmatterLinks: [] },
			],
		},
	};

	const graph = buildLinkGraph(app);
	assert.equal(graph.adjacency.get('note.md')?.has('target.md'), true);
	assert.equal(graph.adjacency.get('target.md')?.has('note.md'), true, 'adjacency is undirected');
});

test('buildLinkGraph unions resolvedLinks and frontmatterLinks targets, both undirected', () => {
	const app = {
		metadataCache: {
			resolvedLinks: { 'a.md': { 'b.md': 1 } },
			getFileCache: (file) => ({ frontmatterLinks: file.frontmatterLinks ?? [] }),
			getFirstLinkpathDest: (link) => (link === 'c' ? { path: 'c.md' } : null),
		},
		vault: {
			getFiles: () => [
				{ path: 'a.md', frontmatterLinks: [{ link: 'c' }] },
				{ path: 'b.md', frontmatterLinks: [] },
				{ path: 'c.md', frontmatterLinks: [] },
			],
		},
	};

	const graph = buildLinkGraph(app);
	assert.equal(graph.adjacency.get('a.md')?.has('b.md'), true, 'resolvedLinks edge present');
	assert.equal(graph.adjacency.get('b.md')?.has('a.md'), true, 'resolvedLinks edge is undirected');
	assert.equal(graph.adjacency.get('a.md')?.has('c.md'), true, 'frontmatter edge present');
	assert.equal(graph.adjacency.get('c.md')?.has('a.md'), true, 'frontmatter edge is undirected');
});

test('a page adjacent to two seeds is boosted; a page adjacent to only one is not', () => {
	const seedPaths = ['s1.md', 's2.md', 's3.md'];
	const graph = graphFromEdges([
		['two.md', 's1.md'],
		['two.md', 's2.md'],
		['one.md', 's1.md'],
	]);
	const results = [
		...seedPaths.map((p, i) => result(p, 1 - i * 0.01)),
		result('two.md', 0.5),
		result('one.md', 0.49),
	];

	const boosted = applyLinkBoost(results, graph, { weight: 0.05, seedCount: 3 });
	const two = boosted.find(r => r.path === 'two.md');
	const one = boosted.find(r => r.path === 'one.md');

	assert.ok(two.attribution?.boosts?.link > 0, 'adjacent to two seeds is boosted');
	assert.equal(one.attribution, undefined, 'adjacent to only one seed carries no attribution at all');
});

test('the boost cannot introduce or remove a result — same path set in, same path set out', () => {
	const results = [result('a.md', 1), result('b.md', 0.9), result('c.md', 0.8), result('d.md', 0.7)];
	const graph = graphFromEdges([
		['d.md', 'a.md'],
		['d.md', 'b.md'],
	]);

	const boosted = applyLinkBoost(results, graph, { weight: 0.05, seedCount: 3 });

	assert.equal(boosted.length, results.length);
	assert.deepEqual(new Set(boosted.map(r => r.path)), new Set(results.map(r => r.path)));
});

test('displacement bound: the arithmetic behind the default boost weight (0.05)', () => {
	// Mirrors DEFAULT_SETTINGS.searchLinkBoostWeight in src/types.ts. Kept as a literal
	// (not imported) so this test independently re-derives the bound rather than trusting
	// the settings default is still what the report claims.
	const DEFAULT_WEIGHT = 0.05;
	const rrf = (rank) => 1 / (LINK_BOOST_RRF_K + rank);
	// The tightest realistic gap between adjacent top ranks: rank 1 vs rank 2 of the
	// companion's own RRF fusion (ignoring the title term, which only widens gaps, never
	// narrows them). ~0.00026 — matches the plan's stated real-world score band.
	const tightestGap = rrf(1) - rrf(2);
	// Best case for a boosted candidate: linkRank === 1 (adjacent to the most seeds).
	const maxBoost = DEFAULT_WEIGHT / (LINK_BOOST_RRF_K + 1);
	const climbPositions = Math.floor(maxBoost / tightestGap);

	assert.equal(climbPositions, 3, 'the exact arithmetic that justifies the chosen default weight');
	assert.ok(climbPositions >= 1, 'the boost is not inert at the default weight');
	assert.ok(climbPositions < 12, 'cannot leapfrog a typical full result list (default searchResultLimit is 12)');
});

test('disabled / zero weight leaves the ordering exactly unchanged', () => {
	const results = [result('a.md', 0.5), result('b.md', 0.4), result('c.md', 0.3)];
	const graph = graphFromEdges([
		['c.md', 'a.md'],
		['c.md', 'b.md'],
	]);

	const boosted = applyLinkBoost(results, graph, { weight: 0 });

	// Identity, not just deep-equal: the zero-weight path returns the same array reference,
	// so ordering is byte-identical by construction, not by coincidence of the sort being
	// a no-op.
	assert.equal(boosted, results);
});

test('a stable sort keeps an inert boost byte-identical even without the weight===0 short-circuit', () => {
	// Same scenario as above but forced through the full scoring path (weight > 0, but no
	// candidate clears the adjacency threshold) — asserts stability on the sort itself, not
	// just the early-return branch.
	const results = [result('a.md', 0.5), result('b.md', 0.5), result('c.md', 0.5)];
	const graph = graphFromEdges([]); // no adjacency at all

	const boosted = applyLinkBoost(results, graph, { weight: 0.05, seedCount: 3 });

	assert.deepEqual(boosted.map(r => r.path), results.map(r => r.path));
});

test('a seed does not boost itself, even when adjacent to two other seeds', () => {
	// s1 is linked to s2 and s3, both seeds. If a seed's own adjacency to other seeds
	// counted as evidence, s1 would qualify (2 seed neighbors) despite being a seed itself.
	const graph = graphFromEdges([
		['s1.md', 's2.md'],
		['s1.md', 's3.md'],
	]);
	const results = [result('s1.md', 1), result('s2.md', 0.9), result('s3.md', 0.8)];

	const boosted = applyLinkBoost(results, graph, { weight: 0.05, seedCount: 3 });
	const s1 = boosted.find(r => r.path === 's1.md');

	assert.equal(s1.attribution, undefined, 'a seed is never itself a boost candidate');
});

test('attribution.boosts.link is populated for boosted rows and absent for unboosted rows', () => {
	const seedPaths = ['s1.md', 's2.md', 's3.md'];
	const graph = graphFromEdges([
		['boosted.md', 's1.md'],
		['boosted.md', 's2.md'],
	]);
	const results = [
		...seedPaths.map((p, i) => result(p, 1 - i * 0.01)),
		result('boosted.md', 0.5),
		result('untouched.md', 0.49),
	];

	const boosted = applyLinkBoost(results, graph, { weight: 0.05, seedCount: 3 });
	const boostedRow = boosted.find(r => r.path === 'boosted.md');
	const untouchedRow = boosted.find(r => r.path === 'untouched.md');
	const seedRow = boosted.find(r => r.path === 's1.md');

	assert.equal(typeof boostedRow.attribution.boosts.link, 'number');
	assert.ok(boostedRow.attribution.boosts.link > 0);
	assert.equal(untouchedRow.attribution, undefined);
	assert.equal(seedRow.attribution, undefined, 'seeds never receive attribution.boosts.link');
});

test('pre-existing attribution fields survive the boost being layered on', () => {
	const graph = graphFromEdges([
		['boosted.md', 's1.md'],
		['boosted.md', 's2.md'],
	]);
	const results = [
		result('s1.md', 1),
		result('s2.md', 0.9),
		result('s3.md', 0.8),
		{ ...result('boosted.md', 0.5), attribution: { base: 0.5, textRank: 4, boosts: { titleBoost: 0.01 } } },
	];

	const boosted = applyLinkBoost(results, graph, { weight: 0.05, seedCount: 3 });
	const row = boosted.find(r => r.path === 'boosted.md');

	assert.equal(row.attribution.base, 0.5);
	assert.equal(row.attribution.textRank, 4);
	assert.equal(row.attribution.boosts.titleBoost, 0.01);
	assert.ok(row.attribution.boosts.link > 0);
});

// WP-PF4: `citersOf` is the directed reverse lookup that powers the "cited by" hop on
// metadata-note search results — the set of notes that link TO a given path.

test('citersOf: a body-link citer is found', () => {
	const app = {
		metadataCache: {
			resolvedLinks: { 'thread.md': { '_x_metadata/handle/1.md': 1 } },
			getFileCache: () => ({ frontmatterLinks: [] }),
			getFirstLinkpathDest: () => null,
		},
		vault: {
			getFiles: () => [{ path: 'thread.md' }, { path: '_x_metadata/handle/1.md' }],
		},
	};
	const graph = buildLinkGraph(app);
	assert.deepEqual(citersOf(graph, '_x_metadata/handle/1.md'), ['thread.md']);
});

test('citersOf: a frontmatter-link citer is found (x-metadata list entry)', () => {
	const app = {
		metadataCache: {
			resolvedLinks: {},
			getFileCache: (file) => ({ frontmatterLinks: file.frontmatterLinks ?? [] }),
			getFirstLinkpathDest: (link) => (link === 'post' ? { path: '_x_metadata/handle/1.md' } : null),
		},
		vault: {
			getFiles: () => [
				{ path: 'thread.md', frontmatterLinks: [{ link: 'post', key: 'x-metadata.0', original: '[[post]]' }] },
				{ path: '_x_metadata/handle/1.md', frontmatterLinks: [] },
			],
		},
	};
	const graph = buildLinkGraph(app);
	assert.deepEqual(citersOf(graph, '_x_metadata/handle/1.md'), ['thread.md']);
});

test('citersOf: a path with no citers returns an empty array', () => {
	const graph = graphFromEdges([['a.md', 'b.md']]);
	assert.deepEqual(citersOf(graph, 'unrelated.md'), []);
});

test('citersOf: direction correctness — A links to B does not make B a citer of A, nor does it make A a citer of A\'s own citers', () => {
	// a.md -> b.md -> c.md (chain, each link one-directional in the source data).
	const app = {
		metadataCache: {
			resolvedLinks: {
				'a.md': { 'b.md': 1 },
				'b.md': { 'c.md': 1 },
			},
			getFileCache: () => ({ frontmatterLinks: [] }),
			getFirstLinkpathDest: () => null,
		},
		vault: { getFiles: () => [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }] },
	};
	const graph = buildLinkGraph(app);
	// b is cited by a; a has no citers (nothing links to a).
	assert.deepEqual(citersOf(graph, 'b.md'), ['a.md']);
	assert.deepEqual(citersOf(graph, 'a.md'), []);
	// c is cited by b only — a is two hops away and must not appear as a citer of c.
	assert.deepEqual(citersOf(graph, 'c.md'), ['b.md']);
});

test('citersOf: multiple citers sort deterministically for display truncation', () => {
	const app = {
		metadataCache: {
			resolvedLinks: {
				'zeta.md': { 'target.md': 1 },
				'alpha.md': { 'target.md': 1 },
				'mu.md': { 'target.md': 1 },
			},
			getFileCache: () => ({ frontmatterLinks: [] }),
			getFirstLinkpathDest: () => null,
		},
		vault: { getFiles: () => [{ path: 'zeta.md' }, { path: 'alpha.md' }, { path: 'mu.md' }, { path: 'target.md' }] },
	};
	const graph = buildLinkGraph(app);
	assert.deepEqual(citersOf(graph, 'target.md'), ['alpha.md', 'mu.md', 'zeta.md']);
});

// WP-PF4 boost regression: `buildLinkGraph` changed shape (added `citedBy` alongside
// `adjacency`) to support `citersOf`. `applyLinkBoost` must still read only `adjacency`
// and produce byte-identical output on a fixture graph built through the real
// `buildLinkGraph`/App path — not just the hand-built `graphFromEdges` helper the tests
// above already exercise.
test('boost regression: applyLinkBoost output through buildLinkGraph is unchanged by the citedBy addition', () => {
	const app = {
		metadataCache: {
			resolvedLinks: {
				'two.md': { 's1.md': 1, 's2.md': 1 },
				'one.md': { 's1.md': 1 },
			},
			getFileCache: () => ({ frontmatterLinks: [] }),
			getFirstLinkpathDest: () => null,
		},
		vault: {
			getFiles: () => [{ path: 'two.md' }, { path: 'one.md' }, { path: 's1.md' }, { path: 's2.md' }, { path: 's3.md' }],
		},
	};
	const graph = buildLinkGraph(app);
	assert.ok(graph.citedBy instanceof Map, 'the new field is present');

	const results = [
		result('s1.md', 1),
		result('s2.md', 0.99),
		result('s3.md', 0.98),
		result('two.md', 0.5),
		result('one.md', 0.49),
	];
	const boosted = applyLinkBoost(results, graph, { weight: 0.05, seedCount: 3 });
	const two = boosted.find(r => r.path === 'two.md');
	const one = boosted.find(r => r.path === 'one.md');

	assert.ok(two.attribution?.boosts?.link > 0, 'two.md (adjacent to two seeds) is still boosted');
	assert.equal(one.attribution, undefined, 'one.md (adjacent to only one seed) still carries no attribution');
	assert.equal(two.attribution.boosts.link, 0.05 / (LINK_BOOST_RRF_K + 1), 'exact boost value is unchanged');
});
