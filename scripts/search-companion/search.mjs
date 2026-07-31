import { COVERAGE_MIN_TERMS, DEFAULT_RANKING_MODE, blendPooledRows, buildFtsQuery, fuseSearchRows, rankingModeFlags } from './ranking.mjs';

// The retrieval statements and the legs that run them: the pooled FTS query, the coverage
// query, the vector leg, the coverage leg, and runSearch — which owns every cooperative
// deadline checkpoint. Split out of the single-file companion (WP-rem-R3).
//
// The three SQL constants are exported so `./statements.mjs` can prepare them once per
// handler instead of per request; the statements themselves are still passed *in* to
// runSearch, so this module stays callable against a bare db handle in tests.

// bm25() takes one weight per column, including the UNINDEXED ones (they never match, so
// their weights are inert but the arity must line up). Unweighted bm25 let a body mention
// outrank a title match; title >> heading >> text is the whole point of the ranking upgrade.
//
// `entities` (schema 7) sits at 8.0: strong evidence, deliberately *below* title. Three reasons,
// and none of them are measured — the bake-off does not cover this column, so the value is chosen
// to be conservative rather than tuned. (1) A note *named* for something answers a query about it
// better than a note merely *authored* by someone of that name, so title must keep the top slot.
// (2) The entity field is a handful of tokens where title is a phrase and text is a page; FTS5's
// bm25 normalizes term frequency against the whole row's length, so a hit in a tiny field already
// scores high before any weight is applied, and matching title's 10.0 would compound that twice.
// (3) The failure mode of too high is worse than too low here: an over-weighted author turns
// every query containing a common first name into that author's back catalogue, whereas an
// under-weighted one still surfaces the note (it is the only leg that matches it at all) just
// further down. Raise it only against a measurement.
const BM25_WEIGHTS = [0, 0, 0, 10.0, 5.0, 1.0, 8.0];

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;

// The fused ranking needs a candidate pool deeper than the requested page: a page whose
// title matches the query can sit well below the top `limit` on raw bm25 and still deserve
// the first slot after fusion.
const SEARCH_POOL_FACTOR = 4;
const SEARCH_POOL_MIN = 40;

// Hydration for a path the vector scan found but the FTS pool never returned. Those rows
// have no bm25 score and no FTS snippet (they did not match), so the snippet is built from
// the chunk text — see makeTextSnippet.
//
// Scoped by `(vault_id, id)`, like every other chunk statement since schema 5. A chunk id is
// only unique *within* a vault, so an id-only lookup here could hydrate another vault's chunk
// into this vault's results — a cross-vault content leak, not merely a wrong snippet.
export const HYDRATE_CHUNK_SQL = 'SELECT id, path, title, heading, text, entities, metadata_json FROM chunks WHERE vault_id = ? AND id = ?';

// One pooled query replaces the old two-query shape (ranked chunks + a second full
// `COUNT(*) MATCH` just for `total`, which doubled FTS work on every search):
//   * `matched` scores raw chunks with weighted bm25;
//   * `pooled` collapses to one row per path via MIN(score_text) — best chunk wins. SQLite
//     guarantees the bare columns (id/heading/snippet/...) come from the row that produced
//     the min when the query has exactly one min()/max() aggregate, so the winning chunk's
//     snippet and heading ride along for free;
//   * COUNT(*) OVER () is evaluated before LIMIT, so `total` is the distinct-path match
//     count without a second MATCH.
// `MATERIALIZED` is load-bearing, not a hint: without it SQLite flattens `matched` into the
// aggregate query and bm25()/snippet() throw "unable to use function bm25 in the requested
// context" — FTS5 auxiliary functions are illegal in an aggregate context.
export const SEARCH_SQL = `
WITH matched AS MATERIALIZED (
  SELECT c.id AS id,
         c.path AS path,
         c.title AS title,
         c.heading AS heading,
         c.entities AS entities,
         c.metadata_json AS metadata_json,
         snippet(chunks_fts, 5, '', '', '...', 18) AS snippet,
         bm25(chunks_fts, ${BM25_WEIGHTS.map(weight => weight.toFixed(1)).join(', ')}) AS score_text
  FROM chunks_fts
  JOIN chunks c ON c.id = chunks_fts.id AND c.vault_id = chunks_fts.vault_id
  WHERE chunks_fts.vault_id = ? AND chunks_fts MATCH ?
),
pooled AS (
  SELECT path,
         id,
         title,
         heading,
         entities,
         metadata_json,
         snippet,
         MIN(score_text) AS score_text,
         COUNT(*) AS pooled_chunks
  FROM matched
  GROUP BY path
)
SELECT id, path, title, heading, entities, metadata_json, snippet, score_text, pooled_chunks,
       COUNT(*) OVER () AS total_paths
FROM pooled
ORDER BY score_text, path
LIMIT ?
`;

// The document-level term-coverage leg's one statement, run once per query term (rankingMode
// 'coverage'/'blend+coverage' only — it is never prepared-and-run on the default path).
//
// Deliberately NOT the pooled SEARCH_SQL: coverage asks a presence question, not a scoring one,
// so it must not pay for bm25() or snippet() — and because it selects no FTS5 auxiliary
// function it needs neither the MATERIALIZED CTE nor the single-min() aggregate rule that hold
// SEARCH_SQL together. It also takes no LIMIT: a truncated per-term path list would be a
// *wrong* coverage count (silently, and biased by FTS rowid order), not a cheaper one. The
// truncation that bounds the leg happens after counting, on the ranked list.
export const COVERAGE_SQL = 'SELECT id, path FROM chunks_fts WHERE vault_id = ? AND chunks_fts MATCH ?';

// Which embedding space — if any — this request's vector scan may cover.
//
// The rule the whole feature turns on: a query vector may only ever be scored against vectors
// produced in the same space. Two same-width spaces in one vault used to load into one matrix
// and get cosine-scored against each other, with nothing anywhere reporting it.
//
// Returns `{ space, note, skip }`:
//   space  → bind as the scan's filter; null means "no filter needed", which is only ever
//            returned when the vault holds exactly one space (or reports none at all)
//   skip   → answer with keywords alone; `note` says why. Never an error: failing a whole
//            search over a transient model switch is worse than answering without vectors,
//            exactly as the query-width mismatch already decided.
//   note   → also set on the non-skip mixed-index path, because a scan that silently covered
//            only part of the index would be the quiet half of the same bug.
//
// A backend reporting no `spaces` at all (a test double, an older seam implementation) is
// treated as single-space rather than unusable: unknown must not disable semantic search.
export function resolveScanSpace(stats, requested) {
	const spaces = Array.isArray(stats?.spaces) ? stats.spaces.filter(space => typeof space === 'string' && space !== '') : [];
	const unlabelled = Number(stats?.unlabelledCount ?? 0) > 0;
	const distinct = spaces.length + (unlabelled ? 1 : 0);
	const want = typeof requested === 'string' && requested.trim() !== '' ? requested.trim() : null;
	const listed = () => (unlabelled ? [...spaces, '(unattributed)'] : spaces).map(space => `"${space}"`).join(', ');

	if (distinct === 0) return { space: null, note: null, skip: false };

	if (distinct === 1) {
		// Unattributed vectors: legitimate for an index written before this column existed and
		// not yet restarted through the migration. There is no way to prove they share the
		// query's space, so a request that names one degrades rather than assuming.
		if (unlabelled) {
			if (!want) return { space: null, note: null, skip: false };
			return {
				space: null,
				skip: true,
				note: `this vault's vectors carry no embedding-space attribution, so they cannot be matched against a query embedded in "${want}"; semantic ranking skipped until the index is rebuilt`,
			};
		}
		const only = spaces[0];
		if (want && want !== only) {
			return {
				space: null,
				skip: true,
				note: `this vault is indexed in embedding space "${only}" but the query was embedded in "${want}"; semantic ranking skipped`,
			};
		}
		// One space, and either the query agrees or predates the field: scan it all, exactly as
		// before schema 4.
		return { space: null, note: null, skip: false };
	}

	if (!want) {
		return {
			space: null,
			skip: true,
			note: `this vault holds ${distinct} embedding spaces (${listed()}) and the query named none, so no scan can be scored honestly; semantic ranking skipped until the index is rebuilt`,
		};
	}
	if (!spaces.includes(want)) {
		return {
			space: null,
			skip: true,
			note: `this vault holds ${distinct} embedding spaces (${listed()}), none of them "${want}"; semantic ranking skipped`,
		};
	}
	return {
		space: want,
		skip: false,
		note: `this vault holds ${distinct} embedding spaces (${listed()}); semantic ranking covered only "${want}"`,
	};
}

// The vector leg: a scan of the whole matrix, pooled to one score per path, hydrated for
// any path the FTS pool never produced. It is deliberately a separate query fused in JS —
// cosine does not belong inside the FTS SQL, where `MATERIALIZED` and the bm25/snippet
// aggregate rules are already load-bearing.
//
// Degradation is silent-but-reported: a vault with no vectors, or a search with no query
// embedding, simply returns the FTS-only shape. A *mismatched* query embedding sets `note`
// instead, because scoring across two vector spaces is exactly the confidently-wrong
// failure this feature has to avoid, while failing the whole search over it would be worse
// than answering with keywords.
function runVectorLeg(db, options) {
	const outcome = { used: false, available: false, scores: null, rows: [], note: null, dim: null, model: null, space: null };
	const vectors = options.vectors;
	if (!vectors) return outcome;
	const stats = vectors.stats(options.vaultId);
	outcome.dim = stats.dim;
	outcome.model = stats.model;
	outcome.available = stats.count > 0 && Boolean(stats.dim);
	if (!outcome.available) return outcome;

	const queryEmbedding = options.queryEmbedding;
	if (!Array.isArray(queryEmbedding) && !ArrayBuffer.isView(queryEmbedding)) return outcome;
	if (queryEmbedding.length === 0) return outcome;

	// Space before width: a mixed index can hold a space this query has no business scanning at
	// all, and the width it would be compared against is the *scanned* space's, not the vault's.
	const resolved = resolveScanSpace(stats, options.embeddingSpace);
	outcome.space = resolved.space;
	outcome.note = resolved.note;
	if (resolved.skip) return outcome;
	const scanStats = resolved.space ? vectors.stats(options.vaultId, resolved.space) : stats;
	outcome.dim = scanStats.dim;

	if (queryEmbedding.length !== scanStats.dim) {
		outcome.note = `query embedding is ${queryEmbedding.length}-dimensional but this vault is indexed at ${scanStats.dim}; semantic ranking skipped`;
		return outcome;
	}

	let hits;
	try {
		hits = vectors.knn(options.vaultId, queryEmbedding, options.poolSize, resolved.space);
	} catch (e) {
		outcome.note = `${e instanceof Error ? e.message : String(e)}; semantic ranking skipped`;
		return outcome;
	}
	if (hits.length === 0) return outcome;
	outcome.used = true;

	// Pool chunk hits to their best-scoring path, mirroring what the FTS side does with
	// MIN(score_text): one row per path, scored on its strongest chunk.
	const scores = new Map();
	const bestChunk = new Map();
	for (const hit of hits) {
		const previous = scores.get(hit.path);
		if (previous === undefined || hit.score > previous) {
			scores.set(hit.path, hit.score);
			bestChunk.set(hit.path, hit.id);
		}
	}
	outcome.scores = scores;

	const known = options.knownPaths ?? new Set();
	const hydrate = options.hydrate ?? db.prepare(HYDRATE_CHUNK_SQL);
	for (const [path, chunkId] of bestChunk) {
		if (known.has(path)) continue;
		const row = hydrate.get(options.vaultId, chunkId);
		if (!row) continue;
		outcome.rows.push({
			id: row.id,
			path: row.path,
			title: row.title,
			heading: row.heading,
			// Hydrated for attribution parity: a vector-only row still reports which of the
			// query's terms its entity facet accounts for, so "why is this here" reads the same
			// whichever leg produced the row.
			entities: row.entities,
			metadata_json: row.metadata_json,
			snippet: makeTextSnippet(row.text),
			// No bm25 score: this chunk did not match the query text at all. That is the
			// point of the full-matrix scan, not a gap to paper over with a fake rank.
			score_text: null,
			pooled_chunks: 1,
		});
	}
	return outcome;
}

// The FTS side gets its snippet from snippet(chunks_fts, 5, …, 18); a vector-only hit has no
// match to snippet around, so take the head of the chunk at the same token budget.
export function makeTextSnippet(text, tokens = 18) {
	const words = String(text ?? '').split(/\s+/).filter(Boolean);
	if (words.length === 0) return '';
	const head = words.slice(0, tokens).join(' ');
	return words.length > tokens ? `${head}...` : head;
}

// The document-level term-coverage leg (rankingMode 'coverage'/'blend+coverage'): how many of
// the query's terms appear in ANY chunk of a given path, regardless of whether any single chunk
// holds them all. It is the WP-4 diagnosis' candidate 2 — the root cause there is that FTS5's
// implicit AND is per *chunk*, so a note whose terms are legitimately present but scattered
// across its own headings can never satisfy a multi-term AND, and at vault scale the loose-OR
// rescue is starved because some unrelated document coincidentally does.
//
// Structurally this is the vector leg's twin, and deliberately so: a separate retrieval whose
// ranking joins the fusion, contributing hydrated rows for paths the FTS pool never returned
// (`score_text: null` — they did not match the FTS clause, and inventing a bm25 rank for them
// would be a lie). It therefore changes nothing about what qualifies for the *bm25* candidate
// pool; the strict AND stays exactly the query it was.
//
// Cost shape, since this is the leg's only real risk: one FTS MATCH per query term, presence-
// only (no bm25/snippet), so it is cheaper per term than a search but scales with how much of
// the index each term matches — the same variable that governs search latency generally (see
// src/search/AGENTS.md). That is measured by the bake-off, not guessed at here.
function runCoverageLeg(db, options) {
	const outcome = { used: false, scores: null, rows: [], degraded: false };
	const terms = Array.isArray(options.terms) ? options.terms : [];
	const expanded = Array.isArray(options.expanded) ? options.expanded : [];
	// Fewer than two terms cannot express co-occurrence, and a one-term query's strict AND is
	// that single term — the FTS pool already holds every path this leg could name.
	if (terms.length < COVERAGE_MIN_TERMS || expanded.length !== terms.length) return outcome;

	const statement = options.statement ?? db.prepare(COVERAGE_SQL);
	// WP-5: the deadline this leg's own comment already called out as the real cost risk (up to
	// MAX_QUERY_TERMS FTS scans, measured +580ms at 9+ terms) — checked BETWEEN term scans, never
	// inside one. `now`/`deadlineAt` default to a real clock / no deadline so every pre-WP-5 call
	// site (every existing test, every plugin request today) is unaffected.
	const now = options.now ?? Date.now;
	const deadlineAt = options.deadlineAt ?? Infinity;
	// Distinct terms per path, and per chunk: the path count is the coverage score, the chunk
	// count picks which chunk to hydrate for a path the FTS pool never returned (the one that
	// covers the most of the query is the one worth showing the user).
	const pathTerms = new Map();
	const chunkTerms = new Map();
	const chunkPath = new Map();
	for (const expression of expanded) {
		// Stopping early still returns real, if partial, coverage: every term already scanned
		// stays in pathTerms/chunkTerms, so a path's score (count / terms.length, computed below)
		// can only be an UNDERcount of its true coverage, never an overcount — safe in the
		// direction that matters for an additive, never-authoritative fourth RRF leg.
		if (now() >= deadlineAt) {
			outcome.degraded = true;
			break;
		}
		// A path/chunk can appear many times for one term; the Sets make the count distinct-by-
		// term rather than by-hit, which is what "how many of the query's terms" means.
		const seenPaths = new Set();
		const seenChunks = new Set();
		for (const row of statement.all(options.vaultId, expression)) {
			if (!seenPaths.has(row.path)) {
				seenPaths.add(row.path);
				pathTerms.set(row.path, (pathTerms.get(row.path) ?? 0) + 1);
			}
			if (!seenChunks.has(row.id)) {
				seenChunks.add(row.id);
				chunkTerms.set(row.id, (chunkTerms.get(row.id) ?? 0) + 1);
				chunkPath.set(row.id, row.path);
			}
		}
	}
	if (pathTerms.size === 0) return outcome;

	const scores = new Map();
	for (const [path, count] of pathTerms) {
		if (count < COVERAGE_MIN_TERMS) continue;
		scores.set(path, count / terms.length);
	}
	if (scores.size === 0) return outcome;
	outcome.used = true;

	// Truncate the *ranked* list, never the per-term path lists: counting first and cutting
	// afterwards is what keeps every surviving coverage score exact.
	const ranked = [...scores.entries()]
		.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.slice(0, Math.max(0, options.poolSize ?? scores.size));
	outcome.scores = new Map(ranked);

	// Best-covering chunk per path, for the paths that need hydrating.
	const bestChunk = new Map();
	for (const [chunkId, count] of chunkTerms) {
		const path = chunkPath.get(chunkId);
		const previous = bestChunk.get(path);
		if (previous === undefined || count > previous.count) bestChunk.set(path, { id: chunkId, count });
	}

	const known = options.knownPaths ?? new Set();
	const hydrate = options.hydrate ?? db.prepare(HYDRATE_CHUNK_SQL);
	for (const [path] of ranked) {
		if (known.has(path)) continue;
		const best = bestChunk.get(path);
		if (!best) continue;
		const row = hydrate.get(options.vaultId, best.id);
		if (!row) continue;
		outcome.rows.push({
			id: row.id,
			path: row.path,
			title: row.title,
			heading: row.heading,
			// Same attribution parity as the vector leg's hydrated rows.
			entities: row.entities,
			metadata_json: row.metadata_json,
			snippet: makeTextSnippet(row.text),
			score_text: null,
			pooled_chunks: 1,
		});
	}
	return outcome;
}

export function runSearch(db, options) {
	const vaultId = options.vaultId;
	const limit = clampLimit(options.limit);
	const statement = options.statement ?? db.prepare(SEARCH_SQL);
	const built = buildFtsQuery(options.query);
	const poolSize = Math.max(limit * SEARCH_POOL_FACTOR, SEARCH_POOL_MIN);
	const ranking = rankingModeFlags(options.rankingMode ?? DEFAULT_RANKING_MODE);
	// WP-5 cooperative deadline. `now`/`deadlineAt` default to a real clock / no deadline
	// (Infinity), so every call site that does not opt in — every existing test, and any future
	// caller that omits `deadlineAt` — runs exactly the pre-WP-5 code path and can never produce
	// a `degraded` response. A request that finishes inside budget is therefore byte-identical to
	// before this change; only a request that is genuinely over budget at a checkpoint changes
	// shape at all.
	const now = options.now ?? Date.now;
	const deadlineAt = options.deadlineAt ?? Infinity;
	let degraded = false;
	const overBudget = () => now() >= deadlineAt;

	let match = built.primary;
	let matchFallback = null;
	let fallbackUsed = false;
	let blendedTotal = null;
	// WP-3 pre-flight checkpoint: every checkpoint below this line assumes the primary scan
	// already ran and only bounds what happens *after* it — so a request that arrives already
	// over budget (queued behind one or more upsert sub-batches before the handler even got to
	// run) still paid for the scan itself. Check first and skip it entirely when already doomed;
	// the rescue/vector/coverage checkpoints further down all call overBudget() on their own and
	// see the same expired deadline, so they fall out with no special-casing beyond this.
	let rows;
	if (overBudget()) {
		degraded = true;
		rows = [];
	} else {
		rows = statement.all(vaultId, match, poolSize);
	}
	// `fallbackUsed` reports what actually contributed to this response, and that reading is
	// the same in both branches — it just cannot be observed the same way. Under 'current' the
	// loose-OR only ever runs *instead of* the primary (which returned nothing), so "it ran" and
	// "it contributed" are the same event and the flag keeps its exact historical assignment,
	// true even in the degenerate case where the rescue itself also matched nothing. Under
	// 'blend' both queries always run, so "it ran" would be true on every multi-term search and
	// carry no information; the flag therefore reports whether the loose-OR contributed any path
	// the strict AND had not already found.
	// The two-term floor is not cosmetic: with one term the AND clause *is* that term, so the
	// loose-OR form matches exactly the same set and blending it in can only cost a second full
	// FTS scan for zero added paths — and a one- or two-character prefix query is the most
	// expensive scan the companion runs (see src/search/AGENTS.md's latency table).
	if (ranking.blend && built.terms.length >= 2 && built.fallback !== built.primary) {
		// WP-5 checkpoint: the blend fallback is a second full bm25/snippet/pooled scan, exactly
		// as expensive as the zero-hit rescue below. `blend` is not the default mode, but a
		// caller that explicitly asked for it still gets the same budget protection.
		if (overBudget()) {
			degraded = true;
		} else {
			matchFallback = built.fallback;
			const fallbackRows = statement.all(vaultId, matchFallback, poolSize);
			const blended = blendPooledRows(rows, fallbackRows);
			rows = blended.rows;
			fallbackUsed = blended.added > 0;
			// The loose-OR match set is a strict superset of the primary's (a document matching
			// the phrase, or every term in one chunk, matches the OR of those terms too), so the
			// OR's own distinct-path count is exactly the blended candidate total — no double
			// counting.
			if (fallbackRows.length > 0) blendedTotal = Number(fallbackRows[0].total_paths ?? fallbackRows.length);
		}
	} else if (rows.length === 0 && built.fallback !== built.primary) {
		// WP-5 checkpoint, and the load-bearing one: WP-2 measured the zero-hit loose-OR rescue
		// as ~65% of a pathological query's total server-side cost (~435-454ms of ~674-800ms). It
		// is one monolithic prepared statement — there is no internal checkpoint to add inside
		// it — so the only place to bound it is the gate immediately before running it at all. On
		// budget exceed, skip the rescue and return exactly what the strict-AND primary produced
		// (here, zero rows), marked degraded rather than blocking to completion regardless of how
		// much of the budget the primary clause and any queuing ahead of this request already
		// spent.
		if (overBudget()) {
			degraded = true;
		} else {
			match = built.fallback;
			fallbackUsed = true;
			rows = statement.all(vaultId, match, poolSize);
		}
	}

	// WP-5 checkpoint around the vector leg: normally 13-33ms (a KNN scan), but a matrix rebuild
	// mid-backfill measures up to ~800ms (src/search/AGENTS.md). Skipped entirely over budget
	// rather than degrading it internally — like the rescue, it is not worth a partial-scan
	// checkpoint on its own, and a search missing its semantic leg is exactly the existing
	// FTS-only degrade path (`vector.available: false`), not a new failure shape.
	let vector = { used: false, available: false, scores: null, rows: [], note: null, dim: null, model: null, space: null };
	if (overBudget()) {
		degraded = true;
	} else {
		vector = runVectorLeg(db, {
			vaultId,
			vectors: options.vectors,
			queryEmbedding: options.queryEmbedding,
			embeddingSpace: options.embeddingSpace,
			poolSize,
			hydrate: options.hydrate,
			knownPaths: new Set(rows.map(row => row.path)),
		});
	}

	let coverage = { used: false, scores: null, rows: [], degraded: false };
	if (ranking.coverage) {
		if (overBudget()) {
			degraded = true;
		} else {
			coverage = runCoverageLeg(db, {
				vaultId,
				terms: built.terms,
				expanded: built.expanded,
				poolSize,
				statement: options.coverageStatement,
				hydrate: options.hydrate,
				// Both already-present sets, so one path never enters the fusion twice.
				knownPaths: new Set([...rows.map(row => row.path), ...vector.rows.map(row => row.path)]),
				now,
				deadlineAt,
			});
			if (coverage.degraded) degraded = true;
		}
	}

	// `total` stays the distinct-path FTS match count plus the paths only the vector scan
	// found. A vector-only path that FTS would also have matched *beyond* the pool is
	// counted twice; that only nudges the "N more" hint, and the alternative is a second
	// MATCH per search, which is exactly the cost the pooled CTE was built to remove. The
	// coverage leg's extra paths are counted on exactly the same terms.
	const ftsTotal = blendedTotal ?? (rows.length > 0 ? Number(rows[0].total_paths ?? rows.length) : 0);
	const total = ftsTotal + vector.rows.length + coverage.rows.length;
	const results = fuseSearchRows(rows, {
		terms: built.terms,
		limit,
		vectorScores: vector.scores,
		vectorRows: vector.rows,
		coverageScores: coverage.scores,
		coverageRows: coverage.rows,
	});
	return {
		match,
		matchFallback,
		rankingMode: ranking.mode,
		terms: built.terms,
		fallbackUsed,
		coverageUsed: coverage.used,
		total,
		results,
		vectorUsed: vector.used,
		semanticAvailable: vector.available,
		embeddingDim: vector.dim,
		embeddingModel: vector.model,
		embeddingSpace: vector.space,
		note: vector.note,
		degraded,
	};
}

function clampLimit(value) {
	const limit = Number(value ?? DEFAULT_LIMIT);
	if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
	return Math.max(1, Math.min(Math.floor(limit), MAX_LIMIT));
}
