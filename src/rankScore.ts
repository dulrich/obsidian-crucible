/**
 * rankScore.ts — Crucible's one shared ranking scorer.
 *
 * ## THE SCORE CONVENTION: HIGHER IS BETTER.
 *
 * Read that again, because getting it backwards is exactly the bug this module
 * exists to make impossible. Obsidian's `prepareFuzzySearch` / `SearchResult.score`
 * direction is undocumented in `obsidian.d.ts`; `(a.score) - (b.score)` therefore
 * *looked* plausible and shipped inverted in `fileOpenRanking.ts`, `suggesters.ts`
 * and `folderPicker.ts` — the palette showed the hundred **worst** matches. There is
 * no injection point for a foreign scorer here on purpose: a test double that summed
 * character positions (lower-is-better) is what certified the inversion.
 *
 * Every consumer sorts **descending** by `score`. `SCORE_HIGHER_IS_BETTER` is exported
 * so a reader never has to guess, and is asserted in `tests/rankScore.test.mjs`.
 *
 * ## The model: tier + bounded modifier
 *
 * A match lands in exactly one **tier** (a coarse "how good is this kind of match"
 * bucket, 100 points apart at the narrowest) and then earns a **modifier** — a fine
 * within-tier adjustment. The modifier is hard-clamped to ±`MODIFIER_CLAMP` (49), and
 * `2 * MODIFIER_CLAMP < TIER_GAP`, so **no combination of modifiers can ever move a
 * candidate across a tier boundary**. That is the load-bearing invariant: a contiguous
 * substring match on a long name always beats a fuzzy match on a short one. The clamp
 * is what makes it provable rather than merely likely — the raw modifier terms below
 * can sum past 100 on their own, and without the clamp the tier model would be a
 * suggestion instead of a guarantee.
 *
 * Tiers, best to worst:
 *   EXACT 1000 — the term IS the basename (with or without its extension)
 *   PREFIX 900 — the basename starts with the term
 *   WORD 800 — the term starts at a word boundary inside the basename
 *   SUBSTR 700 — the term appears contiguously anywhere in the basename
 *   FUZZY 500 — the term is a subsequence of the basename
 *   PATH_SUBSTR 400 — the term appears contiguously in the full path
 *   PATH_FUZZY 250 — the term is a subsequence of the full path
 *   (no match) — rejected, `null`
 *
 * **Basename is checked before path.** That is the entire user-facing behavior change:
 * `log.md` must beat `Legal/Origins.md` for the query `log`.
 *
 * A query containing `/` switches to **path-only** matching (the basename tiers are
 * skipped) — typing `Daily/2026` is a statement about the path, not the name.
 *
 * Multi-term queries (whitespace separated) score as the **mean** of the per-term
 * scores; every term must match or the candidate is rejected. `MOD_ORDERED` rewards
 * terms that match left-to-right without backtracking.
 *
 * ## Admission is monotone, and the narrowing cache depends on it
 *
 * `scoreText` returns `null` **iff** some term is not a subsequence of the lowercased
 * text. Nothing else can reject. That predicate is monotone under query extension
 * (a prefix of a subsequence is a subsequence), which is what lets `fileOpenRanking.ts`
 * keep a narrowing stack of survivors across keystrokes. Scores may move freely between
 * keystrokes; only *admission* has to shrink. Do not add a score-threshold rejection
 * here without also killing that cache.
 *
 * No imports — not even from `./types`. `tests/fileOpenPalette.test.mjs` and
 * `tests/rankScore.test.mjs` bundle this module with esbuild and run it in bare Node;
 * an `obsidian` import anywhere in its reachable graph breaks the whole harness.
 */

/** The one true direction. Sort descending by `score`. */
export const SCORE_HIGHER_IS_BETTER = true;

/** The term is the whole basename, or the basename minus its extension. */
export const TIER_EXACT = 1000;
/** The basename starts with the term. */
export const TIER_PREFIX = 900;
/** The term starts at a word boundary inside the basename. */
export const TIER_WORD = 800;
/** The term appears contiguously somewhere in the basename. */
export const TIER_SUBSTR = 700;
/** The term is a (non-contiguous) subsequence of the basename. */
export const TIER_FUZZY = 500;
/** The term appears contiguously in the full path. */
export const TIER_PATH_SUBSTR = 400;
/** The term is a subsequence of the full path. */
export const TIER_PATH_FUZZY = 250;

/** The narrowest distance between two adjacent tiers. */
export const TIER_GAP = 100;

/**
 * Modifiers are clamped to ±this. `2 * MODIFIER_CLAMP < TIER_GAP`, so a modifier can
 * reorder candidates *within* a tier and can never move one across a tier boundary.
 */
export const MODIFIER_CLAMP = 49;

/** `+100 * (termLen / regionLen)` — short names that the term nearly fills win. */
export const MOD_COVERAGE = 100;
/** `-2` per character the match starts in from the left of its region... */
export const MOD_START = -2;
/** ...capped here, so a late match in a long name is penalized but not annihilated. */
export const MOD_START_CAP = 20;
/** `+40 * (longestRun / termLen)` — fuzzy tiers only; contiguity is worth something. */
export const MOD_RUN = 40;
/** `-3` per gap in a fuzzy match... */
export const MOD_GAP = -3;
/** ...capped here so the raw modifier stays arithmetically bounded. */
export const MOD_GAP_CAP = 10;
/** `+15` when the user typed capitals and the raw text matches them exactly. */
export const MOD_RAW_CASE = 15;
/** `-2` per path segment... */
export const MOD_DEPTH = -2;
/** ...capped here. */
export const MOD_DEPTH_CAP = 12;
/** `-0.05` per path character... */
export const MOD_PATH_LEN = -0.05;
/** ...capped here. */
export const MOD_PATH_LEN_CAP = 240;
/** `+25` when a multi-term query's terms match left-to-right without backtracking. */
export const MOD_ORDERED = 25;

/*
 * Char-class bitmask. One `&` rejects a candidate before any string is touched.
 *
 * bits 0-25 : 'a'-'z'
 * bit  26   : '0'-'9'
 * bit  27   : '/'
 * bit  28   : '-' or '_'
 * bit  29   : '.'
 * bit  30   : ' ' or tab
 * bit  31   : non-ASCII (>= 0x80)
 *
 * Anything else (ASCII punctuation we do not classify) maps to 0, which is the
 * conservative direction: an unclassified query character simply never rejects.
 */
export const MASK_BIT_DIGIT = 26;
export const MASK_BIT_SLASH = 27;
export const MASK_BIT_DASH = 28;
export const MASK_BIT_DOT = 29;
export const MASK_BIT_SPACE = 30;
export const MASK_BIT_NON_ASCII = 31;

/** The mask bit for a single char code, or 0 when the char is unclassified. */
export function maskBitForCharCode(code: number): number {
	if (code >= 97 && code <= 122) return (1 << (code - 97)) >>> 0;
	if (code >= 65 && code <= 90) return (1 << (code - 65)) >>> 0;
	if (code >= 48 && code <= 57) return (1 << MASK_BIT_DIGIT) >>> 0;
	if (code === 47) return (1 << MASK_BIT_SLASH) >>> 0;
	if (code === 45 || code === 95) return (1 << MASK_BIT_DASH) >>> 0;
	if (code === 46) return (1 << MASK_BIT_DOT) >>> 0;
	if (code === 32 || code === 9) return (1 << MASK_BIT_SPACE) >>> 0;
	if (code > 127) return (1 << MASK_BIT_NON_ASCII) >>> 0;
	return 0;
}

/** Char-class mask over `text[from, to)`. Always unsigned. */
export function computeMaskRange(text: string, from: number, to: number): number {
	let mask = 0;
	for (let i = from; i < to; i++) mask |= maskBitForCharCode(text.charCodeAt(i));
	return mask >>> 0;
}

/** Char-class mask over the whole string. Always unsigned. */
export function computeMask(text: string): number {
	return computeMaskRange(text, 0, text.length);
}

/**
 * The allocation-free prefilter: can `candidateMask` possibly contain every char class
 * the query needs? Both operands are treated as unsigned, so bit 31 behaves.
 */
export function maskAccepts(candidateMask: number, queryMask: number): boolean {
	return ((candidateMask & queryMask) >>> 0) === (queryMask >>> 0);
}

/** One whitespace-separated term of a compiled query. */
export interface CompiledTerm {
	/** The term as the user typed it, case preserved. */
	raw: string;
	/** Lowercased — what every match walk actually compares against. */
	lower: string;
	/** Char-class mask of `lower`. */
	mask: number;
	/** `lower.length`. */
	len: number;
	/** Whether `raw` differs from `lower`, i.e. the user typed capitals. */
	hasUpper: boolean;
}

/** A query compiled once per keystroke and reused across every candidate. */
export interface CompiledQuery {
	/** Trimmed, case preserved. */
	raw: string;
	/** Trimmed and lowercased. */
	lower: string;
	/** Whitespace-separated terms; empty for a blank query. */
	terms: CompiledTerm[];
	/** Union of every term mask. */
	mask: number;
	/** A `/` anywhere switches the scorer to path-only matching. */
	hasSlash: boolean;
	/** No terms — callers should take their own "no query" branch. */
	isEmpty: boolean;
}

const QUERY_CACHE_MAX = 256;
const queryCache = new Map<string, CompiledQuery>();

/**
 * Compile (and memoize by raw string) a query. Follows the memoization pattern in
 * `src/commandPalette.ts` — a keystroke compiles once, not once per candidate.
 */
export function compileQuery(raw: string): CompiledQuery {
	const hit = queryCache.get(raw);
	if (hit !== undefined) return hit;
	const compiled = compileQueryUncached(raw);
	// Bounded, and a palette session never approaches the bound; a plain clear beats
	// an LRU here because a stale entry is never wrong, only recomputed.
	if (queryCache.size >= QUERY_CACHE_MAX) queryCache.clear();
	queryCache.set(raw, compiled);
	return compiled;
}

function compileQueryUncached(raw: string): CompiledQuery {
	const trimmed = raw.trim();
	const lower = trimmed.toLowerCase();
	const terms: CompiledTerm[] = [];
	let mask = 0;
	if (trimmed.length > 0) {
		for (const part of trimmed.split(/\s+/)) {
			if (part.length === 0) continue;
			const termLower = part.toLowerCase();
			const termMask = computeMask(termLower);
			mask |= termMask;
			terms.push({
				raw: part,
				lower: termLower,
				mask: termMask,
				len: termLower.length,
				hasUpper: part !== termLower,
			});
		}
	}
	return {
		raw: trimmed,
		lower,
		terms,
		mask: mask >>> 0,
		hasSlash: lower.indexOf('/') >= 0,
		isEmpty: terms.length === 0,
	};
}

/** Everything `scoreText` needs beyond the text itself. All optional, all derivable. */
export interface ScoreTextOptions {
	/** Number of `/` in the path. Derived from the text when omitted. */
	depth?: number;
	/** Length of the full path. Derived from the text when omitted. */
	pathLen?: number;
	/**
	 * The original-case text, for the `MOD_RAW_CASE` bonus. Must be index-aligned with
	 * the lowercased text; pass it only when `raw.length === lower.length`.
	 */
	raw?: string;
	/** Precomputed char-class mask of the basename region. Skips a dead-end scan. */
	nameMask?: number;
	/** Precomputed char-class mask of the whole path. */
	pathMask?: number;
}

/** What a scored candidate earned. */
export interface ScoreResult {
	/** Higher is better. Always within `[tier - MODIFIER_CLAMP, tier + MODIFIER_CLAMP]`. */
	score: number;
	/** The *worst* per-term tier — the honest description of how this candidate matched. */
	tier: number;
	/** Absolute index into the text of the earliest term match. Informational. */
	start: number;
}

interface TermMatch {
	tier: number;
	/** Unclamped, un-averaged modifier for this term alone. */
	mod: number;
	/** Absolute index of the first matched character. */
	start: number;
	/** Absolute index one past the last matched character. */
	end: number;
}

/**
 * Score `lower` (a lowercased path) against a compiled query.
 *
 * `nameStart` / `nameLen` describe the basename region inside `lower`; derive them from
 * the **lowercased** string (`lower.lastIndexOf('/') + 1`) so every index in play refers
 * to one coordinate system.
 *
 * Numbers only — no array is allocated on this path. Returns `null` iff some term is not
 * a subsequence of `lower` (see the admission note at the top of the file).
 */
export function scoreText(
	compiled: CompiledQuery,
	lower: string,
	nameStart: number,
	nameLen: number,
	options?: ScoreTextOptions,
): ScoreResult | null {
	const terms = compiled.terms;
	const count = terms.length;
	if (count === 0) return null;

	const opts = options ?? EMPTY_OPTIONS;
	const pathLen = opts.pathLen ?? lower.length;
	const depth = opts.depth ?? countCharCode(lower, 47);
	const raw = opts.raw !== undefined && opts.raw.length === lower.length ? opts.raw : undefined;

	const dot = lower.lastIndexOf('.');
	const stemLen = dot > nameStart ? dot - nameStart : nameLen;

	let tierSum = 0;
	let modSum = 0;
	let worstTier = Number.POSITIVE_INFINITY;
	let earliest = -1;
	let ordered = true;
	let prevEnd = -1;

	for (let i = 0; i < count; i++) {
		const term = terms[i]!;
		const match = matchTerm(compiled, term, lower, nameStart, nameLen, stemLen, pathLen, raw, opts, null);
		if (match === null) return null;
		tierSum += match.tier;
		modSum += match.mod;
		if (match.tier < worstTier) worstTier = match.tier;
		if (earliest < 0 || match.start < earliest) earliest = match.start;
		if (match.start < prevEnd) ordered = false;
		prevEnd = match.end;
	}

	let mod = modSum / count;
	if (count > 1 && ordered) mod += MOD_ORDERED;
	mod += MOD_DEPTH * Math.min(depth, MOD_DEPTH_CAP);
	mod += MOD_PATH_LEN * Math.min(pathLen, MOD_PATH_LEN_CAP);
	if (mod > MODIFIER_CLAMP) mod = MODIFIER_CLAMP;
	else if (mod < -MODIFIER_CLAMP) mod = -MODIFIER_CLAMP;

	return { score: tierSum / count + mod, tier: worstTier, start: earliest < 0 ? 0 : earliest };
}

const EMPTY_OPTIONS: ScoreTextOptions = {};

/**
 * Highlight ranges for the ≤100 winners — never called in the hot loop.
 *
 * Guarantees Obsidian's undocumented `renderResults` contract: ascending,
 * non-overlapping, and within `[0, text.length]`. Returns `[]` (render plain text)
 * rather than risk drifted indices when lowercasing changes the string length, which
 * a handful of Unicode code points do.
 */
export function buildRanges(compiled: CompiledQuery, text: string, nameStart?: number): [number, number][] {
	if (compiled.isEmpty) return [];
	const lower = text.toLowerCase();
	if (lower.length !== text.length) return [];

	const start = nameStart ?? lower.lastIndexOf('/') + 1;
	const nameLen = lower.length - start;
	const dot = lower.lastIndexOf('.');
	const stemLen = dot > start ? dot - start : nameLen;

	const positions: number[] = [];
	for (const term of compiled.terms) {
		const match = matchTerm(compiled, term, lower, start, nameLen, stemLen, lower.length, undefined, EMPTY_OPTIONS, positions);
		if (match === null) return [];
	}
	if (positions.length === 0) return [];

	positions.sort(compareNumbers);
	const ranges: [number, number][] = [];
	let from = positions[0]!;
	let to = from + 1;
	for (let i = 1; i < positions.length; i++) {
		const pos = positions[i]!;
		if (pos <= to) {
			if (pos === to) to = pos + 1;
			continue;
		}
		ranges.push([from, to]);
		from = pos;
		to = pos + 1;
	}
	ranges.push([from, to]);
	return ranges;
}

/**
 * Convenience wrapper for callers that hold a bare string rather than a columnar
 * snapshot (the settings-tab pickers). Compiles (memoized) and derives every index.
 */
export function scoreCandidateText(query: string, text: string): ScoreResult | null {
	const compiled = compileQuery(query);
	if (compiled.isEmpty) return null;
	return scoreCompiledText(compiled, text);
}

/** `scoreCandidateText` with the query already compiled — score N candidates per keystroke. */
export function scoreCompiledText(compiled: CompiledQuery, text: string): ScoreResult | null {
	if (compiled.isEmpty) return null;
	const lower = text.toLowerCase();
	const nameStart = lower.lastIndexOf('/') + 1;
	return scoreText(compiled, lower, nameStart, lower.length - nameStart, {
		depth: countCharCode(lower, 47),
		pathLen: lower.length,
		raw: text,
	});
}

/** Count occurrences of a char code. Used for path depth. */
export function countCharCode(text: string, code: number): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === code) count++;
	return count;
}

function compareNumbers(a: number, b: number): number {
	return a - b;
}

/**
 * The single source of truth for "how does this term match this text" — shared by the
 * scoring hot loop (`out === null`) and the range builder (`out` collects the matched
 * character indices). Keeping one code path is what stops the highlights from drifting
 * away from the score that produced them.
 */
function matchTerm(
	compiled: CompiledQuery,
	term: CompiledTerm,
	lower: string,
	nameStart: number,
	nameLen: number,
	stemLen: number,
	pathLen: number,
	raw: string | undefined,
	opts: ScoreTextOptions,
	out: number[] | null,
): TermMatch | null {
	const needle = term.lower;
	const len = term.len;
	if (len === 0) return null;

	if (!compiled.hasSlash && nameLen > 0) {
		const nameMask = opts.nameMask;
		if (nameMask === undefined || maskAccepts(nameMask, term.mask)) {
			const nameEnd = nameStart + nameLen;

			if (len <= nameLen && lower.startsWith(needle, nameStart)) {
				const tier = len === nameLen || len === stemLen ? TIER_EXACT : TIER_PREFIX;
				return contiguousMatch(tier, nameStart, len, nameStart, nameLen, raw, term, out);
			}

			let idx = lower.indexOf(needle, nameStart);
			let first = -1;
			let word = -1;
			while (idx >= 0 && idx + len <= nameEnd) {
				if (first < 0) first = idx;
				if (isWordBoundary(lower, idx, nameStart)) { word = idx; break; }
				idx = lower.indexOf(needle, idx + 1);
			}
			if (word >= 0) return contiguousMatch(TIER_WORD, word, len, nameStart, nameLen, raw, term, out);
			if (first >= 0) return contiguousMatch(TIER_SUBSTR, first, len, nameStart, nameLen, raw, term, out);

			const nameFuzzy = fuzzyWalk(lower, nameStart, nameEnd, needle, out);
			if (nameFuzzy !== null) return fuzzyMatch(TIER_FUZZY, nameFuzzy, len, nameStart, nameLen, term);
		}
	}

	const pathMask = opts.pathMask;
	if (pathMask !== undefined && !maskAccepts(pathMask, term.mask)) return null;

	const pathIdx = lower.indexOf(needle);
	if (pathIdx >= 0) return contiguousMatch(TIER_PATH_SUBSTR, pathIdx, len, 0, pathLen, raw, term, out);

	const pathFuzzy = fuzzyWalk(lower, 0, lower.length, needle, out);
	if (pathFuzzy !== null) return fuzzyMatch(TIER_PATH_FUZZY, pathFuzzy, len, 0, pathLen, term);
	return null;
}

function contiguousMatch(
	tier: number,
	start: number,
	len: number,
	regionStart: number,
	regionLen: number,
	raw: string | undefined,
	term: CompiledTerm,
	out: number[] | null,
): TermMatch {
	const offset = start - regionStart;
	let mod = MOD_COVERAGE * (len / (regionLen > 0 ? regionLen : 1));
	mod += MOD_START * Math.min(offset, MOD_START_CAP);
	if (raw !== undefined && term.hasUpper && raw.substring(start, start + len) === term.raw) mod += MOD_RAW_CASE;
	if (out !== null) for (let i = 0; i < len; i++) out.push(start + i);
	return { tier, mod, start, end: start + len };
}

interface FuzzyWalk {
	start: number;
	end: number;
	longest: number;
	gaps: number;
}

function fuzzyMatch(
	tier: number,
	walk: FuzzyWalk,
	len: number,
	regionStart: number,
	regionLen: number,
	term: CompiledTerm,
): TermMatch {
	const offset = walk.start - regionStart;
	let mod = MOD_COVERAGE * (len / (regionLen > 0 ? regionLen : 1));
	mod += MOD_START * Math.min(offset, MOD_START_CAP);
	mod += MOD_RUN * (walk.longest / (term.len > 0 ? term.len : 1));
	mod += MOD_GAP * Math.min(walk.gaps, MOD_GAP_CAP);
	return { tier, mod, start: walk.start, end: walk.end };
}

/**
 * Greedy leftmost subsequence walk over `lower[from, to)`. `charCodeAt` only — no
 * allocation, no regex, no split. When `out` is non-null the matched indices are
 * appended (range building only).
 */
function fuzzyWalk(lower: string, from: number, to: number, needle: string, out: number[] | null): FuzzyWalk | null {
	const len = needle.length;
	if (len === 0) return null;
	let ti = 0;
	let start = -1;
	let prev = -1;
	let run = 0;
	let longest = 0;
	let gaps = 0;
	const mark: number[] | null = out === null ? null : [];
	for (let i = from; i < to; i++) {
		if (lower.charCodeAt(i) !== needle.charCodeAt(ti)) continue;
		if (start < 0) start = i;
		if (prev === i - 1) {
			run++;
		} else {
			if (prev >= 0) gaps++;
			run = 1;
		}
		if (run > longest) longest = run;
		prev = i;
		if (mark !== null) mark.push(i);
		ti++;
		if (ti === len) {
			if (out !== null && mark !== null) for (const pos of mark) out.push(pos);
			return { start, end: i + 1, longest, gaps };
		}
	}
	return null;
}

function isWordBoundary(lower: string, index: number, regionStart: number): boolean {
	if (index <= regionStart) return true;
	const code = lower.charCodeAt(index - 1);
	return code === 45 // -
		|| code === 95 // _
		|| code === 32 // space
		|| code === 9 // tab
		|| code === 46 // .
		|| code === 47 // /
		|| code === 40 // (
		|| code === 91 // [
		|| code === 44; // ,
}
