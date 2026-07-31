# TN-review remediation — contracts made real, monoliths decomposed

*Recommended model/effort — Claude: Opus/high for WP-R1/R2/R3 (shared-contract and
companion work), Sonnet/medium for WP-R4; Codex: gpt-5.6-sol/high for R1–R3,
gpt-5.6-terra/medium for R4. WP prefix `rem`. All four WPs dispatch to subagents.*

## Context

Executes the remediation contract from `reviews/2026-07-29-tn-code-review.md` (review of
`b764f26`, gpt-5.6-sol/high, read-only). **That review is the canonical findings record —
read it first**; this plan carries only the validation deltas and execution corrections
discovered when the findings were re-verified against master `f63e6b9` on 2026-07-31.

**Validation verdict: all four findings hold on current master.**

- **F1** (WorkflowResult optional-field bag) — valid in substance; the imperative
  settlement ladder survived the thq SQLite cutover into `DbJobBackend.ts:294-308`
  (incl. the `'Workflow returned failed status'` fallback), and `applyCancellation`
  (`cancellation.ts:197`) still spreads one variant into another and erases fields.
- **F2** (AgentModelBinding + duplicate parser) — valid verbatim: `src/types.ts:463-472`,
  private `parseModelRef` in `src/agents.ts`, documented duplicate in
  `src/settings/providerRefs.ts:20-26`. None of these files changed since the review.
- **F3** (companion monolith) — valid verbatim: `scripts/search-companion.mjs` is 2,319
  lines, byte-for-byte the reviewed anchors (`createSchema` now at :320).
- **F4** (settings knot) — valid, slightly worse: `ai.ts` 1,299 (unchanged),
  `orchestration.ts` grew 1,037 → 1,048 (thq queue UI); `providerModelConfigUI.test.mjs`
  still reads `src/` source text.

## Decisions locked

All five "Decisions locked" bullets in the review stand unchanged (behavior-preserving;
1,000-line rule by decomposition not barrels; explicit typed ports, no frameworks/DSLs;
companion stays a dependency-free executable facade). Plus, from this session's
validation:

1. **WP-R1 file list is corrected**: `FileJobBackend`/`MemoryJobBackend` were deleted in
   thq-wp8 (`0c342e2`, post-review). Settlement lives in **`DbJobBackend`** alone; the
   backend seam is `JobBackend.ts`. One backend to migrate, not two.
2. **WP-R1 rider — delete the message-literal hazard**: `WorkflowFailureReason:
   'no-api-key'` already exists in `orchestration/types.ts`. The r2f-wp1
   missing-key branch in `FeedTrackerWorkflow` currently matches the key-error **message
   text** (`/YouTube Data API key not configured/`) against a literal that must be kept
   in sync with `fetchChannelUploads`. The union migration converts that branch to
   `failureReason: 'no-api-key'` and deletes the regex coupling.
3. **Test floor is 1299 tests / 105 files** (review's 949/79 is stale). Count only grows;
   re-count at each landing (`ls tests/*.test.mjs | wc -l` + the `npm test` summary).
4. Review line anchors in `src/settings/sections/orchestration.ts` may have drifted
   (thq touched it); WP-R4's worker re-derives anchors rather than trusting the review's.

## Summary

Make the contracts already described in comments real: two discriminated unions (workflow
outcomes; provider/model bindings) delete defensive branching and invalid persisted
states; the 2,319-line companion splits into focused zero-dependency modules behind the
existing executable facade; the two 1,000+-line settings files split into renderer
modules with pure, importable state transitions replacing source-text test assertions.

## Key Changes

**WP-rem-R1 — Make workflow outcomes a real state model.**
*~1.6 kSLOC touched, net-negative · ~200k tokens · ~15 min wall · top (Claude Opus/high;
Codex gpt-5.6-sol/high) · Claude: subagent (same-tier handoff, independent contract
review + orchestrator headroom); Codex: subagent (same)*
Replace `WorkflowResult` (`src/orchestration/types.ts:85-105`) with a discriminated
union; migrate all ~12 producer workflows (~76 construction sites; heaviest:
SearchIndexWorkflow 18, ImageDescribeWorkflow 12, FeedTrackerWorkflow 11); make
`DbJobBackend` settlement an exhaustive switch with `assertNever`; construct cancelled
results cleanly in `applyCancellation`/`cancelledResultFor` instead of spread-and-erase.
Rider: FeedTrackerWorkflow missing-key branch → `failureReason: 'no-api-key'`, regex
deleted. Files: `src/orchestration/{types,JobBackend,DbJobBackend,cancellation}.ts`,
`src/orchestration/workflows/*.ts`, cancellation/service-health/backend tests.

**WP-rem-R2 — Canonicalize provider/model contracts.**
*~1.2 kSLOC touched, net-negative · ~170k tokens · ~13 min wall · top (Claude Opus/high;
Codex gpt-5.6-sol/high) · Claude: subagent (independent persistence-migration review);
Codex: subagent (same)*
New Obsidian-free contract module: `ProviderModelRef`, parse/format helpers, a
discriminated `AgentModelBinding` union, one total+conservative `normalizeAgentBinding(raw)`
persistence boundary (legacy/stale/partial JSON shapes normalize losslessly). Settings
replace the whole variant on mode change; both private parser copies
(`agents.ts` `parseModelRef`, `providerRefs.ts` `parseChainStepModelRef`) deleted in
favor of the shared one. Files: `src/types.ts`, new pure contract module,
`src/{agents,modelPicker,main}.ts`, `src/settings/{providerRefs,sections/ai}.ts`,
migration/provider-ref/agent tests.

**WP-rem-R3 — Decompose the search companion behind a stable facade.**
*~2.7 kSLOC touched, net-negative target · ~230k tokens · ~18 min wall · top (Claude
Opus/high; Codex gpt-5.6-sol/high) · Claude: subagent (independent transaction/deadline
review; keeps the largest diff out of the orchestrator); Codex: subagent (same)*
Extract schema/migrations (`:320`), vector backend (`:729`), ranking legs + `runSearch`
(`:1087`), endpoint handlers (`:1756`), and startup (`:2230`) into
`scripts/search-companion/*.mjs`; `scripts/search-companion.mjs` stays the small
executable + compatibility re-export facade; serial route ladder → small explicit
method/path dispatcher preserving route-level transaction and deadline ownership.
No implementation file over 1,000 lines. Files: `scripts/search-companion.mjs`, new
`scripts/search-companion/*.mjs`, `tests/searchCompanion*.test.mjs`,
`tests/search{EmbeddingSpace,EntityFacet,VaultIsolation}.test.mjs`.

**WP-rem-R4 — Split settings rendering and expose executable state seams.**
*~2.8 kSLOC touched, net-negative target · ~180k tokens · ~14 min wall · mid (Claude
Sonnet/medium; Codex gpt-5.6-terra/medium) · Claude: subagent (~59% normalized saving);
Codex: subagent (~39% saving) · **starts only after R2 lands***
Split AI and Orchestrator settings by owned panel; extract catalog/probe, binding, and
row-state transitions into dependency-free functions; replace source-text assertions
with behavioral imports. Neither file over 1,000 lines; no renderer over ~150 lines
without documented reason. Files: `src/settings/sections/{ai,orchestration}.ts`, new
renderer/state modules, `tests/providerModelConfigUI.test.mjs` + affected UI tests.

## Public Interfaces

Per the review: `WorkflowResult` and `AgentModelBinding` change internally to
discriminated unions with stable observable behavior and lossless data migration;
companion HTTP paths/payloads/schema version/CLI/loopback and facade exports stable;
settings tab ids, labels, navigation, persisted keys stable.

## Execution

Wave 1: **R1 ∥ R2 ∥ R3** (disjoint file scopes) after grounded briefs
(`runs/dispatch/rem-r{1..4}-brief.md`, authored 2026-07-31). **R4 only after R2 lands**
(its brief gets a post-R2 addendum pinning the final binding contract module/paths).
Ask-before-dispatch per fleet rule; workers never commit; orchestrator reviews each
diff, re-runs gates verbatim, commits one per WP; ledger actuals at each close;
compaction pause at WP boundaries.

## Test Plan / Verification

Six gates verbatim per landing: `npm run lint`; `npx tsc -noEmit -skipLibCheck`;
`npm test` (floor **1299/105**, count only grows); `node esbuild.config.mjs production`;
`grep -rna --include='*.ts' "console\." src/` → only `src/log.ts`; `file` + `LC_ALL=C
grep -caP '\0'` on every touched/created file. R3 must exercise the real HTTP handler
against in-memory SQLite, not only pure helpers. R4 must replace, not supplement, the
source-text assertions it obsoletes.

## Critical Files

`src/orchestration/{types,JobBackend,DbJobBackend,cancellation}.ts` ·
`src/orchestration/workflows/*.ts` · `src/types.ts` · `src/agents.ts` ·
`src/settings/providerRefs.ts` · `src/settings/sections/{ai,orchestration}.ts` ·
`scripts/search-companion.mjs` · `src/search/AGENTS.md` · `src/orchestration/AGENTS.md`

## Assumptions

The review's four assumptions stand (current behavior authoritative; legacy bindings may
be arbitrarily stale; companion decomposition adds no runtime dependency; UI regressions
follow the rerun-packet protocol). Additionally: the r2f contracts (Data API tracker,
missing-attachments section, hide-when-idle pills, `f63e6b9` shared-attachment copy
semantics) are settled behavior that R1/R4 must preserve.

**Total ≈ 8.3 kSLOC, ~780k raw tokens; ~788k Claude-path / ~730k Codex-path
Opus/Sol-equivalent tokens.**

---

## Completed 2026-07-31

All four WPs landed on master by the orchestrator (all subagent-produced, gates re-run
verbatim per landing): `723cfbd` (rem-R2, binding contract), `ddcf4ff` (rem-R1,
WorkflowResult union + typed no-api-key), `83d463e` (rem-R3, companion decomposition),
`10e6bba` (rem-R4, settings decomposition). Test floor 1299/105 → **1351/107**. Quirk
entries recorded in root `AGENTS.md` (contract leaf, settings split) and
`src/orchestration/AGENTS.md` (construct-never-spread union).

**Parked for the user:** `YoutubeChannelEnrichWorkflow.ts:38` fails on a missing API key
*without* stamping `failureReason: 'no-api-key'`, while `YoutubeMetadataFetchWorkflow.ts:107`
stamps it. Aligning them would make a missing key latch the channel-enrich auto-source
off (the R1 semantics) — behavior change, user decides.
