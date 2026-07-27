# Search quality bake-off, entity facet, model identity — follow-up sprint

*Recommended model/effort — Claude: Opus/medium for WP-2/3/4/6, Opus/high for WP-1, Sonnet/medium
for WP-5; Codex: Sol/medium-high for WP-1/2/3/4/6, Terra/medium for WP-5. Orchestrator: this
session (Fable).*

## Context

Follow-up wave from two closed sprints. `plans/model-ux-search-perf-and-inference-consolidation.md`
(closed 2026-07-26) left three directed follow-ups in its Outcome section: the WP-4 ranking fix
(user direction: **implement both candidate directions and pick the winner empirically**), the
frontmatter author/entity facet (an omission — the chunker parses full frontmatter at
`src/search/chunker.ts:84-96` but FTS indexes only path/title/heading/text), and the WP-2
alias-catalog glue. `plans/search-space-key-and-query-logging.md` still holds two open WPs that
move here — portable space keys (its WP-1) and passive query logging (its WP-2) — while its WP-4
(index inspection dashboard) is **deferred for future study** by user decision 2026-07-26; its
WP-3/WP-5 landed via the sprint-exit sprint.

Diagnosis ground truth for the ranking work: `runs/dispatch/wp4-quality-miss-report.md` (+
orchestrator addendum). Per-chunk implicit AND is the root cause; the loose-OR fallback fires only
on zero hits vault-wide (starved at ~5,400 notes); always-OR would regress commit `a9cab90`; the
vector leg does not rescue (real embedding: target rank 54/245, textRank null, vectorRank 70).

## Decisions locked (user-confirmed 2026-07-26)

1. **Both ranking candidates get implemented and measured; the winner lands by evidence**, not
   inspection. Bake-off corpus is **curated now** (~40–60 queries: the pocock miss, D1's four,
   queries synthesized from real note topics); query logging still lands this sprint so real logs
   re-validate the winner later.
2. **Entity facet is ONE mechanism with two sources**: frontmatter fields (this sprint: `author`)
   now; GLiNER2 body-text extraction later (held — GLiNER2 cannot run under crucible-inference:
   encoder + span head, no GGUF/llama.cpp support; when it comes it is a small CPU sibling
   container, ONNX runtime, crucible-search shape). This sprint's schema/design must not need
   rework when that source arrives.
3. **crucible-inference repo split enters as a design-record WP only** — survey, proposal,
   go/no-go recommendation; no code or repo moves this sprint. news-ingestion's separate
   embeddings + GLiNER2 setup is the second proof point and inherits this fleet's llama-swap
   learnings.
4. Index inspection dashboard: **deferred for future study** (single clean live space; the
   embedding-space retag incident's durable fix remains earmarked for it).
5. Standing: FEEDBACK.md never written/staged; stage by path; subagents never commit; never
   push/mutate remotes; gates scope to the diff.

## Summary

Six work packages in three streams: **(a)** ranking — implement both candidate modes in the
companion behind a per-request flag, then a measured bake-off against a curated corpus with real
embeddings, orchestrator flips the default to the winner at close; **(b)** search surface — the
frontmatter entity facet (GLiNER2-compatible shape) and passive query logging; **(c)** model
identity — portable space keys + the alias-catalog probe glue, plus the crucible-inference split
design record. One commit per WP, dispatched workers, orchestrator reviews/gates/commits.

## Key Changes

**WP-1 — Passive vault-search query logging (~0.5 kSLOC touched, ~260k tokens, ~20 min wall).**
Unchanged scope from `plans/search-space-key-and-query-logging.md` WP-2 (read that section first —
it carries the full spec and the no-abandoned-search-inference rule): log every executed vault
search (query, result count, clicked path/rank when a click happens, timestamp, mode flags) to a
bounded local store; a settings toggle (default on, plainly worded); no network, no vault notes —
plugin data dir. Purpose now sharpened: this is the measurement substrate that re-validates the
WP-3 bake-off winner against real usage. Files: `src/search/SearchModal.ts` (or the modal's actual
home), new `src/search/queryLog.ts`, `src/types.ts`, `src/settings/sections/ai.ts`, new
`tests/searchQueryLog.test.mjs`. *Model: top (Claude Opus/high; Codex Sol/medium-high) —
interactive surface, writes user data. Execution: subagent (dispatch cost 300k vs 40k wash —
clear win).* Independent; lands in wave 1 so accumulation starts immediately.

**WP-2 — Both ranking candidates behind a request flag (~0.4 kSLOC touched, ~250k tokens, ~19 min wall).**
Implement, in `scripts/search-companion.mjs` (stays ONE file), the two directions from the WP-4
report §3 verbatim: **(A) blend-don't-gate** — always run primary AND + loose-OR fallback, union
pooled rows by path (primary wins ties), feed the union to `fuseSearchRows`; **(B) document-level
term coverage as a ranking signal** — strict chunk-level AND stays the candidate gate, add a
per-path "how many query terms appear in ANY of this path's chunks" coverage score as a fourth
RRF-fused rank beside bm25/title/vector. Selectable per-request (`rankingMode:
'current'|'blend'|'coverage'|'blend+coverage'`), **default stays `'current'` until WP-3 decides**
— this WP changes no live behavior. Add the report's specified regression test shape (target with
terms split across chunks + a decoy satisfying strict AND) asserted per mode; no schema change.
Files: `scripts/search-companion.mjs`, `src/search/types.ts` + `client.ts` (flag plumbing only),
tests extend `searchCompanionRanking.test.mjs`. *Model: top (Claude Opus/medium; Codex
Sol/medium-high) — retrieval/ranking semantics, new SQL shapes. Execution: subagent.* Independent;
must land before WP-3 and WP-4 (companion file).

**WP-3 — Ranking bake-off: corpus, harness, winner (~0.3 kSLOC scripts, ~250k tokens, ~19 min wall).**
Build the curated corpus (~40–60 queries with expected-relevant paths: the pocock miss, D1's four
from `esi-fr-2026-07-25`, the "Kill The Bloat" sanity probe, queries synthesized from real vault
topics across lengths 2–6 terms — include common-term floods like bare `claude` to test the
`a9cab90` regression risk). Harness runs all four modes hybrid (real query embeddings via
crucible-inference 4806 `bge-m3` — GPU is free this sprint) against a companion instance running
WP-2's code on a copy of the live DB (never live-writes); metrics: MRR, recall@10/@25, per-query
rank deltas, and an explicit no-regression check on queries the current mode already answers at
rank 1. Report recommends the winner (or `current` if both regress). Artifacts + scripts land in
`/home/_shared_code/eval-harness/local-inference-bench/measurements/` (new sibling dir — standing
rule: never this repo). Files: eval-harness scripts + run doc; zero plugin/companion code. *Model:
top (Claude Opus/medium; Codex Sol/medium-high) — measurement design judgment. Execution:
subagent.* After WP-2; parallel with WP-4/5.

**WP-4 — Frontmatter entity facet, source #1: author (~0.35 kSLOC touched, ~220k tokens, ~17 min wall).**
Design-first inside the WP, with the compatibility constraint from Decision 2 governing: choose
the indexed shape (a dedicated `entities` FTS column + chunk field — expected — vs folding into an
existing indexed column), knowing GLiNER2 body-text entities will later share it (an entity is
`{text, type, source: 'frontmatter'|'model'}`-shaped even if only a flat string lands in FTS now).
Chunker emits the note's `author` (string or list) from the already-parsed frontmatter into every
chunk (or chunk 0 — decide and record); companion indexes it so `matt pocock` matches
`author: Matt Pocock`, weighted like title (a name hit is strong evidence), visible in
`attribution`. Schema bump to 7 with a `user_version`-keyed migration per the 3b pattern
(`migrateFtsRowidPinning` is the exemplar) — pair `SEARCH_REQUIRED_SCHEMA_VERSION`, rebuild the
container image in the same landing (the schema-pairing rule in `src/search/AGENTS.md`). Author
changes must reindex: fold the emitted entity text into `contentHash` (the WP-7 design's rule —
else coverage-skip strands notes). Files: `src/search/chunker.ts`, `src/search/types.ts`,
`scripts/search-companion.mjs`, tests (new `searchEntityFacet.test.mjs` + version-pin bumps).
*Model: top (Claude Opus/medium; Codex Sol/medium-high) — schema + forward-compat design.
Execution: subagent.* After WP-2 (companion file); before the close (its schema bump wants the
same container rebuild the close verifies).

**WP-5 — Model identity: portable space keys + alias-catalog glue (~0.45 kSLOC touched, ~230k tokens, ~18 min wall).**
Two items, one dispatch (heavy file overlap in `ai.ts`/`openaiCompatible.ts`). (1) Old plan WP-1
unchanged in scope (read it first): separate the request-model id from the vector-space id so a
mount-path or host-specific served id can never become the space key; llama-swap aliasing has
defused the live urgency (the active space is already clean `bge-m3/f16`) so this is the
structural fix, not an emergency — the space-id derivation must survive a provider/base-URL swap
that serves the same weights. (2) The parked alias-catalog gap: `src/settings/sections/ai.ts`
matches probe suggestions by raw id only, so alias-configured rows never render the Accept row —
cache `servedModel` from the describe probe (`describedPrecisionByModel` is the precedent) and
re-match the catalog by canonical id on raw-id miss. Files: `src/search/SearchManager.ts`,
`src/search/types.ts`, `src/types.ts`, `src/settings/sections/ai.ts`,
`src/providers/openaiCompatible.ts`; tests extend `searchEmbeddingSpace.test.mjs`,
`providerModelConfigUI.test.mjs`, `providerModelProbe.test.mjs`. *Model: mid (Claude
Sonnet/medium; Codex Terra/medium) — both halves are pinned-spec implementation. Execution:
subagent.* Independent of WP-2/3/4; after WP-1 (shares `ai.ts`/`src/types.ts`).

**WP-6 — crucible-inference split: design record (~0.25 kSLOC docs, ~200k tokens, ~15 min wall).**
Survey news-ingestion's standalone embeddings + GLiNER2 setup (read its repo: service shape,
model management, how entities are consumed) and this fleet's crucible-inference (llama-swap
config, compose service, smoke, the alias-is-API-surface rule). Produce a design record answering:
does local inference become its own initiative repo (container defs + compose ownership + smoke +
docs) with obsidian-crucible and news-ingestion as consumers, the plugin treating it as an
**optional dependency**? Cover: the repo boundary (what moves out of
`docker/llamacpp-vulkan/` and `context-control/compose.home.yml`), the merged service shape
(llama-swap GPU router + CPU sidecars, where a future GLiNER2 container fits), what news-ingestion
gains from the llama-swap learnings, migration cost, and a go/no-go recommendation. **No code, no
repo moves, no compose edits.** Lands at `docs/local-inference-split.md`. *Model: top (Claude
Opus/medium; Codex Sol/medium-high) — cross-repo architecture judgment. Execution: subagent
(fresh eyes on news-ingestion are a feature).* Independent; any wave.

## Public Interfaces

| Surface | Change |
|---|---|
| Companion `POST /v1/search` | New optional `rankingMode` field; default behavior unchanged until the close flips it |
| Companion schema | v7: entity/author indexed field + migration; `SEARCH_REQUIRED_SCHEMA_VERSION` pairs; container rebuild at landing |
| Chunk shape | Chunker emits frontmatter-derived entity text (author), folded into `contentHash` |
| Query log | New bounded local store in plugin data dir + settings toggle (default on) |
| Space key derivation | Request-model id decoupled from vector-space id (old plan WP-1 contract) |
| Settings UI | Alias-configured model rows regain the probe-suggestion Accept row |
| Docs | `docs/local-inference-split.md` design record (go/no-go, no code) |

## Execution

This session orchestrates (already the standing orchestrator). Ask-before-dispatch stands per wave.

```
wave 1 (parallel, disjoint):  WP-1 (query logging) · WP-2 (ranking modes) · WP-6 (split record)
wave 2 (parallel):            WP-3 (bake-off, after 2) · WP-4 (entity facet, after 2) · WP-5 (model identity, after 1)
close (direct):               flip default rankingMode to the WP-3 winner (small commit, full gates,
                              regression test re-asserted on the winner); rebuild + recreate the
                              companion container (WP-4's schema 7); verify live migration lossless;
                              annotate + deregister both plans (see below); ledger rows per WP
```

Plan bookkeeping at landing of THIS plan doc: register `"[[search-quality-bakeoff-entity-facet-and-model-identity]]"`
in `INITIATIVE.md` `pending-plans`; annotate `plans/search-space-key-and-query-logging.md` (WP-3
implemented by sprint-exit WP-6 `df5f656`; WP-1/WP-2 moved here; WP-4 deferred for future study)
and remove it from `pending-plans` — its disposition is complete. This plan deregisters at sprint
close.

## Test Plan / Verification

Gates per repo standard after every code WP: `npm run lint`; `npx tsc -noEmit -skipLibCheck`;
`npm test` (baseline **766/766** — grows with new suites); `node esbuild.config.mjs production`;
`grep -rna --include='*.ts' "console\." src/` (only `src/log.ts`); `file` + NUL sweep
(`LC_ALL=C grep -caP '\0'`, exit 1 = PASS) on every touched file — the in-band-separator warning
stands: any sentinel/delimiter is written as the two-character `\0` escape, never a pasted control
byte. nvm prefix required. WP-3/WP-6 are measurement/docs: file/NUL only in this repo.

Load-bearing new assertions: split-terms target + strict-AND decoy reachable per ranking mode;
`'current'` mode byte-identical results pre/post WP-2 (no accidental behavior change); bake-off
no-regression check on rank-1 queries; author facet matches `author:` case-insensitively and
appears in attribution; schema 6→7 migration lossless on a copied live DB; author edit changes
`contentHash` (reindex not stranded); space key stable across a base-URL swap serving identical
weights; alias row renders Accept; query log records click rank and truncates at its bound.

## Critical Files

`scripts/search-companion.mjs`; `src/search/{chunker.ts, types.ts, client.ts, SearchManager.ts,
SearchModal.ts, queryLog.ts (new)}`; `src/settings/sections/ai.ts`;
`src/providers/openaiCompatible.ts`; `src/types.ts`;
`/home/_shared_code/eval-harness/local-inference-bench/measurements/` (bake-off artifacts);
`docs/local-inference-split.md` (new); `plans/search-space-key-and-query-logging.md` (annotations).

## Assumptions

1. The WP-4 report's two candidate specs (§3) are implementable as described; if either turns
   structural mid-WP-2, that half stops at a written finding and the bake-off runs on the modes
   that exist.
2. A curated 40–60-query corpus is decision-grade for picking between the modes; real logged
   queries (WP-1) re-validate later, and a reversal then is a config flip, not a rebuild.
3. GLiNER2 compatibility is a shape constraint on WP-4, not a build: nothing this sprint runs a
   model for entities.
4. news-ingestion's repo is readable at planning depth by the WP-6 worker; its GLiNER2/embeddings
   setup is the second proof point, not a merge target this sprint.
5. GPU/4806 is unreserved for WP-3's embedding calls (no concurrent benchmark this sprint).
6. Old-plan WP-4 (index inspection dashboard) stays deferred; nothing here depends on it.

**Total ≈ 2.25 kSLOC, ~1.45M raw tokens; ~1.60M Claude-path / ~1.46M Codex-path Opus/Sol-equivalent
tokens** (model-cost.mjs: six dispatched WPs — five to Opus/Sol, WP-5 to Sonnet/Terra — with
per-dispatch overhead; close direct on the orchestrator).
