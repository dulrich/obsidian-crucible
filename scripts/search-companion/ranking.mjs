import { HttpError } from './http.mjs';

// Query tokenization, FTS query construction, the ranking-mode vocabulary, the title/entity
// scorers and the reciprocal-rank fusion — the pure ranking layer. Split out of the
// single-file companion (WP-rem-R3): nothing here touches the database, which is why the
// ranking tests can import it directly.
//
// The leg *runners* (vector, coverage) and runSearch itself live in `./search.mjs`, because
// those take statements and a db handle. This module is what they fuse with.

const MAX_QUERY_TERMS = 24;

// Reciprocal-rank fusion constant. 60 is the value from the original RRF paper and the one
// every mainstream implementation uses; it flattens the head of each list enough that a
// strong second-list hit can overtake a weak first-list leader without swamping it.
export const RRF_K = 60;
export const RRF_TITLE_WEIGHT = 1.0;
// The vector list joins the fusion on exactly the same footing as the title list: same k,
// same reciprocal-rank shape, weight 1.0. A weight is the knob if one list turns out to
// deserve more say — it is deliberately not a score blend, because bm25 and cosine are not
// commensurable scales but their ranks are.
export const RRF_VECTOR_WEIGHT = 1.0;
// The document-level term-coverage list (rankingMode 'coverage'/'blend+coverage') joins on the
// same footing as the title and vector lists, for the same reason: its scale (a fraction of the
// query's terms) is not commensurable with bm25 or cosine, but its rank is. Weight 1.0 is the
// unbiased starting point the bake-off measures against, not a tuned value.
export const RRF_COVERAGE_WEIGHT = 1.0;
// A path must cover at least this many distinct query terms to enter the coverage list at all.
// One term is not "coverage" — it is what bm25 already ranks, and at vault scale a single common
// term covers thousands of paths, so a floor of 1 would hand the coverage list to noise before
// the poolSize truncation could even see it. Two is the smallest floor that means "these terms
// co-occur in this document", which is the signal the leg exists to add. Consequently the leg is
// inert for one-term queries (where the strict AND already retrieves every covering path).
export const COVERAGE_MIN_TERMS = 2;

// Keep `.`, `/`, `:`, `@`, `-`, `_` and `'` so path- and handle-shaped queries survive, and
// use Unicode property escapes for the rest: the old `[a-z0-9_@./:-]+` class silently
// dropped every non-ASCII character, so an accented or CJK query tokenized to nothing.
const QUERY_TERM_RE = /[\p{L}\p{N}_@./:'-]+/gu;
const TERM_EDGE_PUNCTUATION_RE = /^[./:'-]+|[./:'-]+$/g;

export function tokenizeQuery(query) {
	const raw = String(query ?? '').toLowerCase().match(QUERY_TERM_RE) ?? [];
	const terms = [];
	for (const candidate of raw) {
		const term = candidate.replace(TERM_EDGE_PUNCTUATION_RE, '');
		if (!term || terms.includes(term)) continue;
		terms.push(term);
		if (terms.length >= MAX_QUERY_TERMS) break;
	}
	return terms;
}

function quoteFts(value) {
	return `"${String(value).replace(/"/g, '""')}"`;
}

// Query construction, in priority order:
//   * the whole query as a quoted phrase — a document that contains the literal phrase
//     matches this clause *and* the AND clause, so bm25 counts it twice and it floats up;
//   * AND of every term, so one common term no longer drags in the whole vault (the old
//     form was a pure OR of unique terms);
//   * `term*` prefix expansion on the trailing term, so a partial word still matches while
//     the user is still typing. `"foo"*` widens `"foo"`, it never narrows it.
// `fallback` is the loose OR form, used only when the AND form returns nothing — a query
// that matches nothing is worse than a loose one. Terms stay `""`-escaped and capped at 24
// because an FTS5 syntax error surfaces as a 500.
//
// `expanded` is the per-term FTS5 expression list the two clauses are assembled from (the
// trailing term already prefix-expanded). It is exported on the result so the coverage leg
// can ask "does THIS one term appear anywhere in this path" using exactly the same notion of
// a term the primary clause uses — a second, subtly different quoting/expansion rule would
// make coverage disagree with bm25 about what matched.
export function buildFtsQuery(query) {
	const terms = tokenizeQuery(query);
	if (terms.length === 0) {
		const literal = quoteFts(String(query ?? '').trim());
		return { terms, phrase: literal, primary: literal, fallback: literal, expanded: [] };
	}
	const quoted = terms.map(quoteFts);
	const phrase = quoteFts(terms.join(' '));
	const expanded = quoted.slice(0, -1).concat(`${quoted[quoted.length - 1]}*`);
	return {
		terms,
		phrase,
		primary: `(${phrase}) OR (${expanded.join(' AND ')})`,
		fallback: `(${expanded.join(' OR ')})`,
		expanded,
	};
}

// Ranking modes (`rankingMode` on POST /v1/search). Two candidate directions from the WP-4
// diagnosis, selectable per request so a bake-off could measure them against each other before
// either became the default.
//
//   current         the pre-bake-off ranking: strict AND primary, loose-OR only as a zero-hit rescue
//   blend           always run the loose-OR fallback too and union its pooled rows in
//   coverage        add a document-level term-coverage leg as a fourth RRF rank
//   blend+coverage  both
//
// The two are orthogonal on purpose — blend widens the *bm25 candidate pool*, coverage adds a
// *separate retrieval leg* (structurally the vector leg's twin) without touching the FTS
// clause at all — so the four modes form a clean 2x2 for the bake-off.
//
// **The default is `'coverage'`, by measurement, not inspection** (eval-harness
// `measurements/fsq-bakeoff-2026-07-26/run.md`; 46 graded queries against a copy of the live
// index): the only mode that improved every headline metric with zero rank-1 losses — MRR +15%,
// R@25 +26%, 8 targets rescued / 0 lost, sign test p = 0.00052, +3–14ms p50 on realistic 1–4
// term queries. The entire win is the split-terms family (terms present in a note but never
// co-occurring in one chunk — the per-chunk implicit AND root cause). `blend` measured
// net-negative on its own (MRR −13%, every severe rank-1 displacement in the sweep, 5.4x
// latency at 5–8 terms) — do not promote it to default; it remains a per-request option.
// `'current'` remains selectable per request as the pre-flip baseline.
export const RANKING_MODES = Object.freeze(['current', 'blend', 'coverage', 'blend+coverage']);
export const DEFAULT_RANKING_MODE = 'coverage';

// An unrecognized mode is a 400, not a silent degrade to the default. A typo in a bake-off
// harness that quietly measured the default four times would be indistinguishable from a real
// null result, which is the one failure this flag exists to avoid. Absent/empty is not a typo —
// that is every existing client, and it means the default.
export function parseRankingMode(value) {
	if (value === undefined || value === null || value === '') return DEFAULT_RANKING_MODE;
	const mode = String(value).trim().toLowerCase();
	if (!RANKING_MODES.includes(mode)) {
		throw new HttpError(400, `unknown rankingMode "${String(value)}"; expected one of ${RANKING_MODES.join(', ')}`);
	}
	return mode;
}

export function rankingModeFlags(mode) {
	const resolved = RANKING_MODES.includes(mode) ? mode : DEFAULT_RANKING_MODE;
	return {
		mode: resolved,
		blend: resolved === 'blend' || resolved === 'blend+coverage',
		coverage: resolved === 'coverage' || resolved === 'blend+coverage',
	};
}

function normalizeForMatch(value) {
	return String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function baseName(path) {
	const tail = String(path ?? '').split('/').pop() ?? '';
	const dot = tail.lastIndexOf('.');
	return dot > 0 ? tail.slice(0, dot) : tail;
}

// The companion-side twin of the palette's basename-first tiering: how strongly does this
// page's *name* answer the query, independent of how often the body mentions it. Returned
// as 0..1, higher is better; 0 means "no title/path signal" and keeps the page out of the
// title ranking entirely so the fusion boost stays a boost.
export function titleMatchScore(terms, row = {}) {
	if (!Array.isArray(terms) || terms.length === 0) return 0;
	const phrase = normalizeForMatch(terms.join(' '));
	if (!phrase) return 0;
	const title = normalizeForMatch(row.title);
	const base = normalizeForMatch(baseName(row.path));
	const path = normalizeForMatch(row.path);
	if (title === phrase || base === phrase) return 1;
	if (title.startsWith(phrase) || base.startsWith(phrase)) return 0.85;
	if (title.includes(phrase) || base.includes(phrase)) return 0.7;
	const inTitle = terms.filter(term => title.includes(normalizeForMatch(term))).length / terms.length;
	const inPath = terms.filter(term => path.includes(normalizeForMatch(term))).length / terms.length;
	const partial = inTitle * 0.5 + inPath * 0.2;
	return partial > 0 ? Math.min(partial, 0.65) : 0;
}

// Which of the query's terms this row's entity facet accounts for — the reason an entity hit is
// *visible* rather than merely effective.
//
// Without it the facet is invisible in the response: an author match raises the row's bm25 (the
// `entities` column carries weight 8.0) and nothing anywhere says why, so a result that looks
// unrelated to every word on the page is indistinguishable from a ranking bug. The rest of
// `attribution` exists for exactly that reason and this is its entity-facet entry.
//
// Returns `null` — not `[]` — for a row whose entity text is empty, so the attribution keys are
// omitted entirely rather than asserting "this row has entities, none matched". `[]` is that
// second, different statement and is reported as such. This is the same "omitted, not 0" rule
// `scoreVector` and the coverage keys follow.
//
// Matching is whole-word-or-prefix against the normalized entity text, which mirrors what the
// FTS clause actually did: every term is a whole word except the trailing one, which
// buildFtsQuery prefix-expands as `term*`. Applying the prefix rule to every term slightly
// over-reports a non-trailing partial (`mat` would credit `Matt`); the alternative under-reports
// the trailing term on every type-ahead query, which is the common case.
export function matchedEntityTerms(terms, entitiesText) {
	const normalized = normalizeForMatch(entitiesText);
	if (!normalized) return null;
	// Leading-space padding turns one `includes` into "starts at a word boundary", which is both
	// the whole-word and the prefix test at once — and it keeps working for a term that
	// normalizes to more than one word (`bge-m3/f16`-shaped tokens do).
	const haystack = ` ${normalized}`;
	const hits = [];
	for (const term of Array.isArray(terms) ? terms : []) {
		const needle = normalizeForMatch(term);
		if (!needle || hits.includes(term)) continue;
		if (haystack.includes(` ${needle}`)) hits.push(term);
	}
	return hits;
}

// Reciprocal-rank fusion over three rankings of the same candidate set: the weighted bm25
// order (already the row order coming out of SQL), the title/path-match order, and the
// cosine order from the vector scan. Fusing ranks rather than hand-tuning one score is the
// point — the three scales are not commensurable, but their ranks are. A row missing from a
// list simply contributes 0 from it, which is how a keyword-only hit and a vector-only hit
// coexist in one ordering.
//
// `vectorRows` carries rows the vector scan found that FTS never returned; their `textRank`
// is 0 (absent from the bm25 list) rather than a made-up large rank. `coverageRows` is the
// exact same arrangement for the optional document-level term-coverage leg, which is why the
// two share `makeEntry` rather than growing a second row shape.
//
// The coverage list is opt-in (`rankingMode`): with `coverageScores` absent, nothing about
// this function's output changes — not the ordering, and not the payload, since the two
// coverage attribution keys are then never written at all. That is the same "omitted, not 0"
// rule `scoreVector` already follows.
//
// Sign convention: bm25 is negative/lower-is-better inside SQL and is negated here, so
// every score the client sees (`score`, `scoreText`, `scoreRrf`, `attribution.base`) is
// positive and higher-is-better. Cosine (`scoreVector`) is already higher-is-better, and so
// is coverage (a 0..1 fraction of the query's terms found anywhere in the document).
export function fuseSearchRows(rows, options = {}) {
	const terms = options.terms ?? [];
	const k = options.k ?? RRF_K;
	const titleWeight = options.titleWeight ?? RRF_TITLE_WEIGHT;
	const vectorWeight = options.vectorWeight ?? RRF_VECTOR_WEIGHT;
	const coverageWeight = options.coverageWeight ?? RRF_COVERAGE_WEIGHT;
	const vectorScores = options.vectorScores ?? null;
	const vectorRows = options.vectorRows ?? [];
	const coverageScores = options.coverageScores ?? null;
	const coverageRows = options.coverageRows ?? [];
	const limit = options.limit ?? (rows.length + vectorRows.length + coverageRows.length);

	const makeEntry = (row, textRank) => ({
		row,
		base: -Number(row.score_text ?? 0),
		titleBoost: titleMatchScore(terms, row),
		// Attribution only — the entity facet's effect on ranking is already inside `score_text`
		// (it is an indexed bm25 column, not a separate leg), so nothing here feeds the fusion.
		// Reporting it is the point: see matchedEntityTerms.
		entityTerms: matchedEntityTerms(terms, row.entities),
		textRank,
		titleRank: 0,
		vectorRank: 0,
		coverageRank: 0,
		vectorScore: vectorScores?.has(row.path) ? vectorScores.get(row.path) : null,
		coverageScore: coverageScores?.has(row.path) ? coverageScores.get(row.path) : null,
		rrf: 0,
	});
	// Tie-breaks fall back to bm25 order; an entry absent from that list sorts last among
	// ties rather than first, which a bare `textRank` of 0 would do.
	const textOrder = entry => entry.textRank || Number.MAX_SAFE_INTEGER;

	const entries = rows.map((row, index) => makeEntry(row, index + 1));
	for (const row of vectorRows) entries.push(makeEntry(row, 0));
	for (const row of coverageRows) entries.push(makeEntry(row, 0));

	const titled = entries
		.filter(entry => entry.titleBoost > 0)
		.sort((a, b) => (b.titleBoost - a.titleBoost) || (textOrder(a) - textOrder(b)));
	titled.forEach((entry, index) => { entry.titleRank = index + 1; });

	const vectored = entries
		.filter(entry => entry.vectorScore !== null)
		.sort((a, b) => (b.vectorScore - a.vectorScore) || (textOrder(a) - textOrder(b)));
	vectored.forEach((entry, index) => { entry.vectorRank = index + 1; });

	// Coverage ties are common by construction (every path covering 3 of 5 terms scores the
	// same), so the bm25 tie-break carries real weight here: among equally-covering paths the
	// one the strict AND already liked stays ahead, and coverage-only paths sort behind them
	// in the order the leg produced.
	const covered = entries
		.filter(entry => entry.coverageScore !== null)
		.sort((a, b) => (b.coverageScore - a.coverageScore) || (textOrder(a) - textOrder(b)));
	covered.forEach((entry, index) => { entry.coverageRank = index + 1; });

	for (const entry of entries) {
		entry.rrf = (entry.textRank ? 1 / (k + entry.textRank) : 0)
			+ (entry.titleRank ? titleWeight / (k + entry.titleRank) : 0)
			+ (entry.vectorRank ? vectorWeight / (k + entry.vectorRank) : 0)
			+ (entry.coverageRank ? coverageWeight / (k + entry.coverageRank) : 0);
	}
	entries.sort((a, b) => (b.rrf - a.rrf) || (textOrder(a) - textOrder(b)));

	return entries.slice(0, Math.max(0, limit)).map(entry => {
		// Per-stage attribution: the base score, every boost that fired, and the fused
		// value, so ranking is tunable by observation instead of guesswork. `boosts` is the
		// open slot for client-side stages (link adjacency, recency) to record themselves.
		const attribution = {
			base: entry.base,
			textRank: entry.textRank || null,
			titleRank: entry.titleRank || null,
			titleBoost: entry.titleBoost,
			vectorRank: entry.vectorRank || null,
			rrf: entry.rrf,
			pooledChunks: Number(entry.row.pooled_chunks ?? 1),
		};
		// Appended only for a row that actually carries an entity facet, so a vault with no
		// `author:` frontmatter anywhere gets the same object, key for key, it got before schema
		// 7 — the same rule the coverage keys below follow. An empty array is a real answer
		// ("this note names entities, none of them answered your query"), not a missing one.
		if (entry.entityTerms) attribution.entityTerms = entry.entityTerms;
		// Appended only when the coverage leg actually ran, so a default-mode response is the
		// same object, with the same keys in the same order, that it was before this existed.
		if (coverageScores) {
			attribution.coverageRank = entry.coverageRank || null;
			attribution.coverageScore = entry.coverageScore;
		}
		return {
			chunkId: entry.row.id,
			path: entry.row.path,
			title: entry.row.title,
			heading: entry.row.heading,
			snippet: entry.row.snippet,
			score: entry.rrf,
			scoreText: entry.base,
			// Omitted (not 0) when this row never entered the vector list, so an FTS-only
			// response is exactly the payload it was before the vector leg existed.
			scoreVector: entry.vectorScore === null ? undefined : entry.vectorScore,
			scoreRrf: entry.rrf,
			metadata: safeJson(entry.row.metadata_json),
			attribution,
		};
	});
}

// Union the loose-OR fallback's pooled rows into the primary AND's, for rankingMode 'blend'.
//
// A path present in both keeps the *primary* row: its bm25 reflects a real strict match, and
// the two scores are not comparable anyway (different MATCH expressions mean different term
// sets and different IDF), which is also why the fallback-only rows are appended in their own
// bm25 order rather than merge-sorted into the primary's. `fuseSearchRows` reads position as
// textRank, so appending is exactly the statement "every strict-AND match outranks every
// loose-OR-only one on the text leg" — the blend widens recall without demoting the rows the
// current mode already trusts.
export function blendPooledRows(primaryRows, fallbackRows) {
	const seen = new Set(primaryRows.map(row => row.path));
	const added = [];
	for (const row of fallbackRows) {
		if (seen.has(row.path)) continue;
		seen.add(row.path);
		added.push(row);
	}
	return { rows: added.length > 0 ? primaryRows.concat(added) : primaryRows, added: added.length };
}

function safeJson(value) {
	try {
		return JSON.parse(String(value || '{}'));
	} catch {
		return {};
	}
}
