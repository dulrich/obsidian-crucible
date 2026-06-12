/**
 * "Shortest unique fuzzy string" for the Crucible command palette.
 *
 * Obsidian's fuzzy search matches a query against a name iff the query is a
 * case-insensitive *subsequence* of the name. So "the query surfaces only this
 * command" reduces to: the query is a subsequence of the target name but of NO
 * other (competitor) command name in the launched set.
 *
 * Finding the globally shortest distinguishing subsequence over an arbitrary set
 * is NP-hard, so we cap the length and use iterative deepening (shortest first)
 * with a global node budget to keep the UI responsive.
 *
 * Among equal-length candidates we prefer ones drawn from the *leaf* of the
 * command name. Names are colon-segmented ("Crucible: Chain: Ingest as fanfic");
 * characters in earlier (prefix) segments and deeper inside a word carry a tie
 * weight, and we pick the minimum-weight candidate at the shortest length.
 */

/** Tunable knobs for hint generation. */
export interface HintOptions {
	/** Length cap. Primary ordering key: shortest wins. */
	maxLen: number;
	/** Charset filter applied to candidate characters of the target. */
	allowedChar: (ch: string) => boolean;
	/** Tie cost per chosen char, multiplied by its segment depth from the leaf. */
	prefixPenalty: number;
	/** Tie cost per chosen char, multiplied by its offset from its word start. */
	positionBias: number;
}

export const DEFAULT_HINT_OPTIONS: HintOptions = {
	maxLen: 6,
	allowedChar: () => true,
	prefixPenalty: 1,
	positionBias: 0,
};

/** True if `q` is a subsequence of `c` (both assumed already lower-cased). */
function isSubsequence(q: string, c: string): boolean {
	let p = 0;
	for (let i = 0; i < q.length; i++) {
		const idx = c.indexOf(q[i]!, p);
		if (idx === -1) return false;
		p = idx + 1;
	}
	return true;
}

/**
 * Per-character tie weight for the lower-cased target. Earlier colon-segments
 * (prefixes) cost more, as do characters further from the start of their word.
 */
function charWeights(tLower: string, opts: HintOptions): number[] {
	// Colon-segments, leaf last. segmentDepthFromLeaf: leaf = 0, each earlier +1.
	const segments = tLower.split(': ');
	const depthOf: number[] = [];
	const last = segments.length - 1;
	let cursor = 0;
	segments.forEach((seg, i) => {
		const depth = last - i;
		for (let k = 0; k < seg.length; k++) depthOf[cursor + k] = depth;
		cursor += seg.length;
		// Account for the ": " separator that join would reinsert (except after last).
		if (i < last) {
			depthOf[cursor] = depth;     // ':'
			depthOf[cursor + 1] = depth; // ' '
			cursor += 2;
		}
	});

	const weights: number[] = new Array<number>(tLower.length);
	let offset = 0;
	for (let i = 0; i < tLower.length; i++) {
		const ch = tLower[i]!;
		// A word boundary resets the within-word offset.
		if (/[a-z0-9]/.test(ch)) {
			weights[i] = opts.prefixPenalty * (depthOf[i] ?? 0) + opts.positionBias * offset;
			offset++;
		} else {
			weights[i] = opts.prefixPenalty * (depthOf[i] ?? 0);
			offset = 0;
		}
	}
	return weights;
}

/** A chosen candidate: indices into the target plus its accumulated tie weight. */
interface Candidate {
	indices: number[];
	weight: number;
}

/**
 * Shared iterative-deepening search. `accept(indices)` decides whether a chosen
 * set of target indices is a valid hint (unique, or top-match). Returns the
 * shortest accepted candidate, breaking ties by minimum weight, or null.
 */
function searchShortest(
	tLower: string,
	opts: HintOptions,
	accept: (indices: number[]) => boolean,
): number[] | null {
	const weights = charWeights(tLower, opts);
	const limit = Math.min(opts.maxLen, tLower.length);
	let budget = 20000; // global node-visit guard against pathological inputs

	// Depth-bounded DFS collecting the minimum-weight accepted candidate at exactly `bound`.
	const dfs = (startIdx: number, chosen: number[], bound: number, best: Candidate | null): Candidate | null => {
		if (chosen.length === bound) {
			if (!accept(chosen)) return best;
			const weight = chosen.reduce((sum, i) => sum + (weights[i] ?? 0), 0);
			if (best === null || weight < best.weight) return { indices: chosen.slice(), weight };
			return best;
		}
		for (let j = startIdx; j < tLower.length; j++) {
			if (budget <= 0) return best;
			budget--;
			if (!opts.allowedChar(tLower[j]!)) continue;
			chosen.push(j);
			best = dfs(j + 1, chosen, bound, best);
			chosen.pop();
		}
		return best;
	};

	for (let bound = 1; bound <= limit; bound++) {
		const best = dfs(0, [], bound, null);
		if (best !== null) return best.indices;
		if (budget <= 0) return null;
	}
	return null;
}

/** Lower-cased string drawn from the target at the given indices. */
function render(tLower: string, indices: number[]): string {
	return indices.map(i => tLower[i]!).join('');
}

/**
 * Returns the shortest lower-cased character sequence (drawn from `target`,
 * restricted to `opts.allowedChar`) that fuzzy-matches `target` but none of
 * `competitors`, or null if no such sequence exists within `opts.maxLen`.
 */
export function shortestUniqueFuzzyString(
	target: string,
	competitors: string[],
	opts: HintOptions = DEFAULT_HINT_OPTIONS,
): string | null {
	const tLower = target.toLowerCase();
	if (tLower.length === 0) return null;

	// Dedupe and lower-case competitors. (The caller passes every OTHER command's
	// name; a same-named sibling must remain so it forces a null below.)
	const comps: string[] = [];
	const seen = new Set<string>();
	for (const raw of competitors) {
		const c = raw.toLowerCase();
		if (seen.has(c)) continue;
		seen.add(c);
		// If a competitor contains the whole target as a subsequence, every
		// subsequence of the target also matches it — no unique string can exist.
		if (isSubsequence(tLower, c)) return null;
		comps.push(c);
	}

	if (comps.length === 0) {
		// Nothing to disambiguate from: the shortest allowed single character suffices.
		const firstAllowed = [...tLower].find(opts.allowedChar);
		return firstAllowed ?? null;
	}

	// A candidate is unique iff it is a subsequence of NO competitor.
	const accept = (indices: number[]): boolean => {
		const q = render(tLower, indices);
		return comps.every(c => !isSubsequence(q, c));
	};

	const indices = searchShortest(tLower, opts, accept);
	return indices === null ? null : render(tLower, indices);
}

/**
 * Fallback when no unique string exists: the shortest lower-cased string for
 * which `target` is the strict top fuzzy match — i.e. it scores higher than
 * every competitor under the injected `scoreText` (Obsidian's real scorer at
 * runtime). Returns null if none qualifies within `opts.maxLen`.
 */
export function shortestTopMatchFuzzyString(
	target: string,
	competitors: string[],
	opts: HintOptions,
	scoreText: (query: string, text: string) => number | null,
): string | null {
	const tLower = target.toLowerCase();
	if (tLower.length === 0) return null;

	const comps: string[] = [];
	const seen = new Set<string>();
	for (const raw of competitors) {
		const c = raw.toLowerCase();
		if (seen.has(c)) continue;
		seen.add(c);
		comps.push(c);
	}

	const accept = (indices: number[]): boolean => {
		const q = render(tLower, indices);
		const own = scoreText(q, target);
		if (own === null) return false;
		for (const c of comps) {
			const s = scoreText(q, c);
			if (s !== null && s >= own) return false;
		}
		return true;
	};

	const indices = searchShortest(tLower, opts, accept);
	return indices === null ? null : render(tLower, indices);
}

// Exposed for reuse/testing.
export { isSubsequence };
