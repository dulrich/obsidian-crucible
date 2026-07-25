# GBrain Evaluation

A standing record of what Crucible took from [GBrain](https://github.com/garrytan/gbrain) and
what it rejected, and why. Written from a web-clipped copy of the GBrain README
(`Garry's Opinionated Agent Brain.md`, ~4.2k words), not the live repo. Claims attributed to
GBrain below are the README's own description of itself — not independently verified against
its code or benchmarks.

## What GBrain is

GBrain is a personal/team "brain" system: a Postgres-backed store of markdown pages with
retrieval and synthesis on top, aimed at AI coding agents.

- **Storage.** Two engines behind one contract: PGLite (Postgres 17 via WASM, zero-config) for
  personal brains up to ~50K pages, or Postgres + pgvector (Supabase or self-hosted) for
  shared/large deployments. The README calls the git-tracked markdown "brain repo" the system of
  record; GBrain syncs it into Postgres, and deletes in git become soft-deletes in the DB.
- **Retrieval.** `gbrain search` does hybrid ranking: vector (HNSW on pgvector) + BM25 keyword +
  reciprocal-rank fusion + source-tier boost + an optional reranker (ZeroEntropy `zerank-2`
  hosted by default, or a local llama.cpp cross-encoder recipe), plus best-chunk-per-page
  pooling, title/alias phrase boosting, and per-query graph signals (adjacency boost,
  cross-source corroboration, session demote). `--explain` prints per-stage attribution: base
  score, every boost that fired, what it multiplied.
- **Synthesis.** `gbrain think` runs the same retrieval, then composes a cited answer with an
  explicit "what the brain doesn't know yet" gap analysis — stale pages, uncited claims,
  contradictions between results. This sits above `search`, not inside it.
- **Graph.** A self-wiring knowledge graph: every page write extracts entity refs and creates
  typed edges (`attended`, `works_at`, `invested_in`, `founded`, `advises`, …) with zero LLM
  calls, enabling multi-hop queries plain vector search can't answer.
- **Everything else.** A BullMQ-shaped, Postgres-native job queue ("Minions") for durable
  subagents and shell jobs; an MCP server exposing 30+ tools over stdio or HTTP with OAuth 2.1;
  43 curated skills routed by a resolver; author-defined "schema packs" (page types, typed links,
  extraction rules); and an overnight "dream cycle" that enriches pages, fixes citations, and
  surfaces contradictions unattended.

GBrain's own reported numbers, on its own BrainBench corpus (240 pages, Opus-generated), not
independently verified here: **P@5 49.1%, R@5 97.9%**, a **+31.4-point P@5 lift** from the
knowledge graph over its graph-disabled variant (and, per the README, a similar-sized lift over
ripgrep-BM25 + vector-only RAG). Full scorecards are claimed to live in a sibling
`gbrain-evals` repo, which this evaluation did not fetch or inspect.

## Verdict: reject the platform

Crucible's vault *is* the system of record, and Obsidian *is* the UI. GBrain's model — a
separate "brain repo," synced into Postgres, with its own MCP server and job queue — asks
Crucible to stand up a second source of truth and re-solve sync between it and the vault.
That's not a small integration cost; it's the core problem GBrain exists to solve, repeated
one layer up.

The overlap with what Crucible already has is close to total, and the seams don't line up:

- **Job queue.** GBrain's Minions (BullMQ-shaped, Postgres-native) duplicates `Orchestrator`
  (`src/orchestration/Orchestrator.ts`) plus its two `JobBackend` implementations —
  `FileJobBackend` (durable, vault-file-backed) and `MemoryJobBackend` (transient, deduped,
  UI-driven) — see `docs/orchestration.md`. Adopting it means running two queues, or migrating
  a vault-native one into a Postgres-native one, for no functional gain.
- **Synthesis.** `gbrain think`'s cited-answer-plus-gap-analysis layer duplicates the
  provider/agent layer (`src/providers.ts`'s `ProviderManager`, `src/agents.ts`'s
  `AgentManager`) — a configurable LLM completion + chain layer already wired into notes.
- **Automation.** The dream cycle and 66-cron-job autonomy duplicate the trigger system
  (`src/triggers/triggerAdapter.ts`), which already turns vault events and schedules into
  enqueued jobs.

None of that is a reason to reject any single GBrain *idea* — several are good and cheap. It's
a reason to reject GBrain as infrastructure: every piece that would actually help already has a
Crucible-native counterpart, and the piece that doesn't (the graph store, the vector engine) is
addressed below on its own terms.

## Adopted: four retrieval ideas

All four land in `scripts/search-companion.mjs` (Crucible's zero-dependency local search
service — see `docs/search-companion.md`) and are scoped as WP-5 of the same plan
(`plans/file-open-palette-remediation.md`). None needs embeddings, Postgres, or an LLM call.

1. **Best-chunk-per-page pooling.** GBrain: "vector retrieval pools the best chunk per page, so a
   page surfaces on its strongest evidence instead of losing to a neighbor on one weak chunk."
   Today `scripts/search-companion.mjs`'s `/v1/search` handler ranks and returns raw FTS5 rows
   straight from `chunks_fts`, ordered by `bm25(chunks_fts)` with no `GROUP BY path` — a page
   with several weak chunks and one strong one can still lose to a page with a single mediocre
   chunk. The legacy pre-container index (`.crucible/search.sqlite`, a partial index covering
   2,527 of the vault's ~42,000 notes) already holds 28,655 chunks over those 2,527 paths — over
   11 chunks per path on average — so the dilution is real even before the first full rebuild,
   not theoretical.
2. **Title/alias phrase boost.** GBrain: queries matching a page's title phrase or a declared
   alias get boosted to the page they name — the companion-side twin of the file-open palette's
   basename-first tiering (this plan's WP-1), same instinct applied to search instead of file
   ranking.
3. **Reciprocal-rank fusion.** GBrain fuses vector and BM25 rankings via RRF. Crucible has no
   vector leg, so the adopted shape is narrower: fuse BM25 with a title/path-name ranking rather
   than hand-tuning one blended score. The wiring is already half-built —
   `SearchModal.formatScore` (`src/search/SearchModal.ts`) already reads and renders a
   `result.scoreRrf` field that nothing currently populates.
4. **Per-stage score attribution.** GBrain's `gbrain search "<query>" --explain` prints base
   score, every boost that fired, and its multiplier. `SearchModal`'s `formatScore` already has a
   display slot for this; the companion's response shape just needs to carry the breakdown.

## Adopted: the graph idea, not the graph store

GBrain's stated +31.4 P@5 lift comes from typed edges extracted on every page write, stored in
its own Postgres tables and traversed via `gbrain graph-query`. Building and maintaining that
store is exactly the kind of second-source-of-truth cost the platform verdict above rejects.

But Obsidian already maintains a link graph, in memory, for free: `metadataCache.resolvedLinks`
(`Record<string, Record<string, number>>`, confirmed in `obsidian.d.ts`) covers embeds and body
links, and `getFileCache(f).frontmatterLinks` covers links declared in frontmatter properties — a
gap `resolvedLinks` alone doesn't close, which is why both are used together. An adjacency boost
can therefore be computed client-side in `SearchManager` (`src/search/SearchManager.ts`) straight
from data already resident in memory: zero new storage, zero re-index, no companion schema
change. That's WP-6 of the same plan — the graph *idea* at a fraction of GBrain's infrastructure
cost, since Obsidian already did the extraction work GBrain's typed-edge writer does on every
`put_page`.

## Out of scope, and why

- **pgvector/PGLite engine swap.** Needs a second system of record. Crucible's companion is
  deliberately dependency-free SQLite (`docs/search-companion.md`); Postgres is a heavier runtime
  dependency than a local-vault plugin should ask for.
- **MCP server + 43 skillpacks.** We already have this: agents (`src/agents.ts`), chains, and
  orchestration workflows already give an AI client structured access to vault operations. A
  second, parallel tool-exposure surface adds nothing.
- **Overnight dream cycle.** We already have this, structurally: the trigger + schedule system
  (`src/triggers/triggerAdapter.ts`, `docs/orchestration.md`) already runs unattended jobs on
  intervals. GBrain's dream cycle does specific enrichment work (citation fixing, contradiction
  detection) Crucible doesn't do today, but the unattended-scheduling *mechanism* isn't something
  we need to import.
- **Schema packs.** Needs a second system of record — page types and typed links defined inside
  GBrain's Postgres schema, not in vault markdown. Nothing in the vault needs structure imposed
  from outside.
- **`gbrain think` synthesis layer.** We already have this, in Crucible's shape: the
  provider/agent layer (`src/providers.ts`, `src/agents.ts`) already does configurable LLM
  synthesis over notes. A cited-answer-plus-gap-analysis mode is a plausible future *agent*, not
  a reason to adopt GBrain's pipeline wholesale.

## Revisit triggers

This verdict is a snapshot, not a permanent ruling. Concretely, it's worth re-reading GBrain if:

- **Semantic search stops being optional.** The companion already accepts and stores embedding
  vectors in its payload but doesn't rank with them (`docs/search-companion.md`: "does not rank
  with vectors yet"). If semantic recall moves from "stored but unused" to an actual requirement,
  GBrain's embedding-provider matrix and its two reranker recipes (hosted ZeroEntropy, local
  llama.cpp cross-encoder) become relevant prior art — not because the platform becomes worth
  adopting, but because the recipes transfer.
- **The vault outgrows FTS5 + a link boost.** No hard row-count threshold to give here — it's a
  qualitative call. The honest signal is ranking quality degrading in practice (relevant notes
  reliably missing from top results despite the adopted boosts), not a count crossing a line.
- **Multi-vault or team sharing becomes a real requirement.** GBrain's thin-client/shared-brain
  topology solves a problem Crucible doesn't have (one vault, one user, one machine or a small
  trusted set). If that changes, its sync and access-control model is worth a second look —
  though so is just running the companion as a shared service, without GBrain's Postgres layer.

None of these are scheduled work. They're the conditions under which this evaluation should be
redone, not a roadmap.
