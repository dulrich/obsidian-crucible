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
 */

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

interface Alive {
	c: string;
	/** Next index in `c` available to match the next chosen character. */
	p: number;
}

/**
 * Returns the shortest character sequence (drawn from `target`, preserving its
 * original case) that fuzzy-matches `target` but none of `competitors`, or null
 * if no such sequence exists within `maxLen`.
 */
export function shortestUniqueFuzzyString(
	target: string,
	competitors: string[],
	maxLen = 6,
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
		// Nothing to disambiguate from: a single character already suffices.
		return target[0]!;
	}

	const limit = Math.min(maxLen, tLower.length);
	let budget = 20000; // global node-visit guard against pathological inputs

	// Depth-bounded DFS: returns the chosen indices into `target`, or null.
	const dfs = (startIdx: number, depth: number, alive: Alive[], bound: number): number[] | null => {
		if (alive.length === 0) return [];
		if (depth === bound || budget <= 0) return null;
		for (let j = startIdx; j < tLower.length; j++) {
			budget--;
			if (budget <= 0) return null;
			const ch = tLower[j]!;
			const nextAlive: Alive[] = [];
			for (const a of alive) {
				const idx = a.c.indexOf(ch, a.p);
				if (idx !== -1) nextAlive.push({ c: a.c, p: idx + 1 });
				// idx === -1 -> this competitor can no longer match -> dropped (killed)
			}
			const sub = dfs(j + 1, depth + 1, nextAlive, bound);
			if (sub !== null) return [j, ...sub];
		}
		return null;
	};

	// Iterative deepening guarantees the first hit is the shortest.
	for (let bound = 1; bound <= limit; bound++) {
		const initial: Alive[] = comps.map(c => ({ c, p: 0 }));
		const indices = dfs(0, 0, initial, bound);
		if (indices !== null) return indices.map(i => target[i]!).join('');
		if (budget <= 0) return null;
	}
	return null;
}

// Exposed for reuse/testing.
export { isSubsequence };
