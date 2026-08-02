# Plan E — Tag-boost spike (measure, then ship the winning lever)

> **STATUS: COMPLETE (2026-08-01).** TB1 landed in eval-harness
> (`local-inference-bench/measurements/tag-boost-arm-2026-08-01/`, commit `a58daae`):
> weight 0.005 rescued RC1/RC3 to rank 1 with zero regressions across 52 graded
> queries; RC2 confirmed absent from the pool even at limit 200, so the client-side
> acceptance criterion for RC2 was formally dropped as structural (the server-side
> post-fusion pre-truncation hook in `ranking.mjs` is the documented follow-up lever,
> deliberately not built here); the rerank-replica arm closed v3 Finding 3
> (wrong-document-text ruled out; pool composition survives as the live explanation).
> TB2 landed on crucible master (`9a6b435`): `searchTagBoost{Enabled,Tags,Weight}`
> default off / `["gold"]` / 0.005, applied in `boostSearchResponse` via the pure
> `src/search/tagBoost.ts` leaf, `attribution.boosts.tag`, byte-identical when off.
> TB3 (this commit): findings distilled into `src/search/AGENTS.md`'s tag-boost quirk;
> rerank reaffirmed as a manual action. Live spot-check of the four RC queries with the
> boost enabled remains a user validation item.

Repo: **obsidian-crucible** (plan + implementation) · measurement artifacts in
**eval-harness** · slug `tag-boost-spike`

*Recommended model/effort — Claude: Sonnet/medium workers TB-1/TB-2, orchestrator
(Fable) closes TB-3 direct; Codex: Terra/medium workers, Sol/medium orchestrator.*

## Context

rrlb-arm-v3 (2026-08-01, committed) pinned the motivation: the `#gold`-tagged 271-bugs
note is unreachable by rerank for the keyword-dump query (RC2 absent from the entire
returned top-40 under every arm) — rescue needs a retrieval/fusion-layer lever.
Grounding found the lever nearly free: `SearchResult.metadata.tags` is already on the
wire (chunker → `metadata_json` → client), and `SearchManager.boostSearchResponse`
(src/search/SearchManager.ts:855) is the exact hook where `applyLinkBoost` lives, with
the `searchLinkBoostEnabled`/`Weight` settings pair as the template — no companion
change, no schema bump, no re-index. Open questions the spike must answer with numbers:
(1) does the target even sit in the pre-truncation pool (companion fuses
`poolSize = max(limit*4, 40)` then slices to `limit` — a client-side boost can only
reorder what the client received); (2) what weight rescues RC2 without degrading the
other 54 graded queries; (3) does replicating the LIVE rerank input shape
(`title\nheading\nsnippet` of the displayed top-30 — not pooled chunk text) reproduce
the user's "reranker saves it" observation (run.md Finding 3, open).

## Decisions locked (user, this session)

1. Crucible ships only the tag boost; **capture-count is measured offline, not
   plumbed** (observation-months signal — per-note count of distinct monthly notes
   citing it, already computed by `scanObservationSignals` for source-eval).
2. Measurement precedes implementation (spike shape); TB-2 lands only on a positive
   TB-1 result.

## Key Changes

**WP-TB1 — measurement arm v4 (eval-harness).**
*~0.35 kSLOC · ~280k tokens · ~22 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent (~70% saving); Codex: subagent (~43%)*
New sibling dir under `local-inference-bench/measurements/` extending the
rrlb-arm runner lineage (invoke `../rrlb-arm-2026-08-01/run-arm.mjs` conventions;
`--drop-excluded 1` on every rerank-bearing arm). Arms over fsq-corpus-v3 (58 queries):
(a) **pool-depth probe** — request limit 200, record each target's pre-truncation rank
(answers whether client-side boost can rescue RC2 at the client's actual fetch limit,
which the runner records); (b) **+tag** — flat additive boost on `metadata.tags ∋ gold`
swept over ~4 weights, applied to the fused score then re-truncated; (c) **+months** —
observation-months boost (walk the vault's monthly notes' `# Observations` sections
offline, boost ∝ log(1+months)); (d) **rerank-replica** — rerank with documents =
`title\nheading\nsnippet` of the displayed top-30 (exactly `rerankDocumentText`,
SearchManager.ts:112), graded against RC1/RC3 + the pf-linked-post family to close
run.md Finding 3. Report per-family MRR/hit@k deltas + regression table (non-gold
families must not degrade). Snapshot for target assertion only; searches hit the live
companion — never deploy the companion mid-sweep; no pipes on background runs. Files:
new measurement dir only. NOT in scope: crucible source, companion changes, corpus
changes.

**WP-TB2 — crucible client-side tag boost (gated on TB1 positive).**
*~0.25 kSLOC · ~200k tokens · ~15 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · strictly after TB1*
Settings triple mirroring the link-boost pattern: `searchTagBoostEnabled` (default
false until proven live), `searchTagBoostTags` (default `["gold"]`),
`searchTagBoostWeight` (default = TB1's winning weight). Applied inside
`boostSearchResponse` off `result.metadata.tags` (frontmatter tags only — documented),
recorded as `attribution.boosts.tag`, structurally add/remove-nothing like link boost.
Settings UI rows beside the link-boost pair (`orchestrationSearch.ts`); tests: boost
math, gate-off byte-identical response, attribution presence, tags normalization.
STOP condition: if TB1 shows the RC2 target absent from the client-visible pool even
at the raised limit, the fix is the server-side hook (post-fusion pre-truncation,
`ranking.mjs:279-287`) — that is a written diagnosis + follow-up plan, not scope
creep here. Files: `src/search/SearchManager.ts`, `src/search/types.ts`,
`src/types.ts`, `src/settings/sections/orchestrationSearch.ts`, tests. NOT in scope:
server-side boost, rerank defaults/gating changes, capture-count plumbing.

**WP-TB3 — findings + close (orchestrator-direct).**
*~0.05 kSLOC docs · ~30k tokens · ~5 min wall · top (orchestrator) · Claude: direct
(must-direct: integration/gates/commit duty); Codex: direct (same)*
TB1 run.md findings distilled into `src/search/AGENTS.md` (tag-boost quirk line;
Finding-3 resolution recorded either way); reaffirm rerank stays a manual action (v3
measured it net-negative as a default — any auto-rerank needs a query-shape gate,
deliberately not built); plan completion note; deregister; ledger actuals.

## Public Interfaces

- Three new settings keys (additive, default-off gate).
- `attribution.boosts.tag` (additive; `boosts` is the declared open slot).

## Execution

TB1 dispatched first (needs live companion 4801 + router 4811 + vault; parallel-safe
with all Plan D WPs — different repo). TB2 dispatched only after the orchestrator
reads TB1's run.md and the user confirms the go/no-go. TB3 direct. eval-harness
landing commits per its conventions (gates scope to the diff).

## Test Plan / Verification

TB1: runner asserts all targets exist in the snapshot; all arms complete 58/58;
run.md shows the RC1–RC4 table, pool-depth finding, weight sweep, months arm, and
rerank-replica verdict. TB2: six gates verbatim (floor 1686/133); acceptance = RC2
target enters the displayed top-N live with the boost on and default-off leaves
behavior byte-identical. Live spot-check: run the four RC queries in the modal with
the boost enabled.

## Critical Files

eval-harness: new measurement dir. crucible: `src/search/SearchManager.ts`,
`src/search/linkGraph.ts` (pattern reference), `src/settings/sections/
orchestrationSearch.ts`, `src/search/AGENTS.md`, tests.

## Assumptions

- `/v1/search` responses carry `metadata.tags` for all indexed notes (grounded: chunker
  attaches it per chunk; older index rows predating the metadata field would read as
  untagged — TB1 records how many results lack metadata).
- Inline-body `#gold` (not in frontmatter) is invisible to the boost — accepted;
  documented in TB3.
- Observation-months data is derivable offline from the vault's monthly notes without
  crucible code.

**Total ≈ 0.65 kSLOC, ~510k raw tokens; ~428k Claude-path / ~310k Codex-path
Opus/Sol-equivalent tokens.**
