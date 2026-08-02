import { SearchResult } from './types';

// WP-TB2: client-side tag boost, gated on WP-TB1's measured result (weight 0.005 at the live
// limit-40 fetch: RC1 5->1, RC3 3->1, RC4 33->19, zero regressions across 52 graded corpus
// queries — see plans/tag-boost-spike.md). Mirrors the shape of `applyLinkBoost` in
// `linkGraph.ts`: a pure, obsidian-free leaf so it unit-tests without bundling the plugin, and
// a flat additive `score += weight` rather than the RRF idiom the link boost uses — there is no
// per-candidate "rank" to feed an RRF denominator here, just a binary tag match.
//
// Frontmatter tags only: `metadata.tags` is populated by the companion from the note's
// frontmatter `tags` field (see `src/search/AGENTS.md`'s entity-facet quirk for the sibling
// author facet) — an inline body `#gold` is invisible to this boost, same caveat the settings
// row documents.
export interface TagBoostOptions {
	/** Already-normalized (trimmed, `#`-stripped, lowercased) configured tags. Call-site's job. */
	tags: string[];
	weight: number;
}

/** Trim, strip a single leading `#`, lowercase. Applied to both configured tags and result tags. */
export function normalizeTag(tag: string): string {
	return tag.trim().replace(/^#/, '').trim().toLowerCase();
}

/**
 * Settings-save-time normalization for the comma-separated tags text input: split on comma,
 * normalize each entry (see `normalizeTag`), drop empties. Pure and exported so the settings
 * row's `set` callback and its unit test share one implementation — the hot search path never
 * re-normalizes (see `applyTagBoost`'s caller in `SearchManager.ts`).
 */
export function normalizeTagBoostTagsInput(raw: string): string[] {
	return raw.split(',').map(normalizeTag).filter(t => t.length > 0);
}

function resultHasTag(result: SearchResult, tagSet: Set<string>): boolean {
	const tags = result.metadata?.tags;
	if (!Array.isArray(tags) || tags.length === 0) return false;
	for (const tag of tags) {
		if (typeof tag !== 'string') continue;
		if (tagSet.has(normalizeTag(tag))) return true;
	}
	return false;
}

// Structurally cannot add or remove a result: this only ever maps scores onto the array it was
// given and re-sorts it — same law as `applyLinkBoost`. `Array.prototype.sort` is stable, so a
// zero-weight or no-match pass leaves the input ordering byte-identical; callers must still keep
// the structural early-return in `boostSearchResponse` so a zero-weight call never even maps.
export function applyTagBoost(results: SearchResult[], opts: TagBoostOptions): SearchResult[] {
	const weight = opts.weight;
	if (results.length === 0 || !weight || opts.tags.length === 0) return results;

	const tagSet = new Set(opts.tags);
	if (tagSet.size === 0) return results;

	// Per-result match, computed once and reused below. Mirrors `applyLinkBoost`'s early
	// return when nothing qualifies: the common case is most results carry none of the
	// configured tags, and that must cost neither a new array nor a re-sort — not just the
	// weight/tags-empty guards above. Keyed by index (not path) because a note's chunks can
	// share one path with distinct SearchResult objects.
	const matches = results.map(r => resultHasTag(r, tagSet));
	if (!matches.some(Boolean)) return results;

	const adjusted = results.map((result, i) => {
		if (!matches[i]) return result;
		return {
			...result,
			score: result.score + weight,
			attribution: {
				...result.attribution,
				boosts: { ...result.attribution?.boosts, tag: weight },
			},
		};
	});

	return adjusted.slice().sort((a, b) => b.score - a.score);
}
