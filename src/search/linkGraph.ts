import type { App } from 'obsidian';
import { SearchResult } from './types';

// Mirrors `RRF_K` from `scripts/search-companion.mjs` (currently 60). Not imported — that
// script is not part of the plugin bundle (see the Dockerfile/companion quirks in
// AGENTS.md). Reusing the exact functional form of the server's own RRF fusion
// (`weight / (RRF_K + rank)`) keeps this boost on the same footing as the ranks it composes
// with, instead of an intuition-picked additive constant that would obliterate a real score
// band of ~0.009-0.033 with a ~0.00026 gap between adjacent top ranks.
// Exported (not just module-local) so tests can compute the exact displacement bound
// against the value the scoring core actually uses, without hardcoding a second copy.
export const LINK_BOOST_RRF_K = 60;

// Seeds are the top-K search results the boost treats as evidence of relevance.
export const DEFAULT_LINK_BOOST_SEED_COUNT = 10;

// A candidate must be adjacent to at least this many seeds to count as signal. One shared
// link is noise on a densely linked vault; two is deliberate structure. Named constant so
// the threshold isn't a magic `2` buried in the scoring loop.
export const LINK_BOOST_MIN_ADJACENT_SEEDS = 2;

export interface LinkGraph {
	/** path -> set of adjacent paths. Undirected: an edge recorded A->B implies B->A. */
	adjacency: Map<string, Set<string>>;
}

function addDirectedEdge(adjacency: Map<string, Set<string>>, from: string, to: string): void {
	if (from === to) return;
	let set = adjacency.get(from);
	if (!set) {
		set = new Set();
		adjacency.set(from, set);
	}
	set.add(to);
}

// Adjacency is treated as undirected: a link in either direction is evidence two notes are
// related, and the search results being boosted have no inherent "direction" relative to a
// query. No concrete reason to prefer directed edges surfaced during design — say so in
// case a future WP finds one.
function link(adjacency: Map<string, Set<string>>, a: string, b: string): void {
	addDirectedEdge(adjacency, a, b);
	addDirectedEdge(adjacency, b, a);
}

// Extracts an undirected adjacency graph from Obsidian's own metadata cache — no new
// storage, no re-index, no companion schema change. `resolvedLinks` covers embeds and body
// links but NOT frontmatter property links; that is the same documented gap that lets the
// Orphaned Attachments dashboard falsely flag an attachment referenced only from a YAML
// property (`computeOrphanedAttachmentRows` in `src/ingestion/data/orphanedAttachments.ts`).
// So `frontmatterLinks` is unioned in separately here, resolved through
// `getFirstLinkpathDest` so a wikilink lands on a real vault path.
export function buildLinkGraph(app: App): LinkGraph {
	const adjacency = new Map<string, Set<string>>();

	const resolved = app.metadataCache.resolvedLinks;
	for (const source in resolved) {
		const targets = resolved[source];
		if (!targets) continue;
		for (const target in targets) {
			link(adjacency, source, target);
		}
	}

	for (const file of app.vault.getFiles()) {
		const frontmatterLinks = app.metadataCache.getFileCache(file)?.frontmatterLinks;
		if (!frontmatterLinks || frontmatterLinks.length === 0) continue;
		for (const fmLink of frontmatterLinks) {
			const dest = app.metadataCache.getFirstLinkpathDest(fmLink.link, file.path);
			if (dest) link(adjacency, file.path, dest.path);
		}
	}

	return { adjacency };
}

export interface LinkBoostOptions {
	weight: number;
	seedCount?: number;
	minAdjacentSeeds?: number;
}

// Pure scoring core — no App, no TFile, so it's unit-testable without stubbing Obsidian
// (the split WP-4/blogsIntake.ts established: pure core + thin app-taking derivation above).
//
// Seeds = the top `seedCount` entries of `results` (default `DEFAULT_LINK_BOOST_SEED_COUNT`)
// and act only as the evidence pool. A seed is never itself a boost candidate — "do not let
// a seed boost itself" — so a highly-connected seed cannot climb further just by being
// adjacent to other seeds; the boost exists to pull adjacent-but-lower-ranked pages up, not
// to re-rank within the seed set. Only candidates adjacent to >= `minAdjacentSeeds` distinct
// seeds are ranked and boosted at all.
//
// Structurally cannot add or remove a result: this only ever maps scores onto the array it
// was given and re-sorts it — the returned array always has the exact same path set as the
// input. Array.prototype.sort is stable (guaranteed since ES2019/Node 11+), so a zero
// boost — disabled, zero weight, or no qualifying adjacency — leaves the input ordering
// byte-identical.
export function applyLinkBoost(results: SearchResult[], graph: LinkGraph, opts: LinkBoostOptions): SearchResult[] {
	const weight = opts.weight;
	if (results.length === 0 || !weight) return results;

	const seedCount = opts.seedCount ?? DEFAULT_LINK_BOOST_SEED_COUNT;
	const minAdjacentSeeds = opts.minAdjacentSeeds ?? LINK_BOOST_MIN_ADJACENT_SEEDS;

	const seedPaths = results.slice(0, seedCount).map(r => r.path);
	const seedSet = new Set(seedPaths);
	if (seedSet.size === 0) return results;

	// Adjacency strength per candidate: how many distinct seeds it borders. Seeds themselves
	// are skipped entirely — never a candidate, so never boosted by their own adjacency to
	// other seeds.
	const strength = new Map<string, number>();
	for (const result of results) {
		if (seedSet.has(result.path)) continue;
		const neighbors = graph.adjacency.get(result.path);
		if (!neighbors) continue;
		let count = 0;
		for (const seedPath of seedSet) {
			if (neighbors.has(seedPath)) count++;
		}
		if (count > 0) strength.set(result.path, count);
	}

	// Rank only the candidates that clear the threshold: descending by adjacency strength,
	// ties broken by original result order for determinism.
	const boosted = results
		.map((r, index) => ({ path: r.path, index, count: strength.get(r.path) ?? 0 }))
		.filter(c => c.count >= minAdjacentSeeds)
		.sort((a, b) => (b.count - a.count) || (a.index - b.index));

	if (boosted.length === 0) return results;

	const boostByPath = new Map<string, number>();
	boosted.forEach((candidate, i) => {
		const linkRank = i + 1; // 1-based, per the RRF idiom this mirrors
		boostByPath.set(candidate.path, weight / (LINK_BOOST_RRF_K + linkRank));
	});

	const adjusted = results.map(result => {
		const boost = boostByPath.get(result.path);
		if (boost === undefined) return result;
		return {
			...result,
			score: result.score + boost,
			attribution: {
				...result.attribution,
				boosts: { ...result.attribution?.boosts, link: boost },
			},
		};
	});

	return adjusted.slice().sort((a, b) => b.score - a.score);
}
