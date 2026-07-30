# obsidian-crucible: destructive-action confirmations, Lint: all step registry, search latch safety + long-query investigation

*Recommended model/effort — Claude: Sonnet/medium all dispatched WPs; Codex: Terra/medium.
Repo plan lands at `plans/confirmations-lint-steps-search-latch.md`.*

## Context

Post-validation feedback batch from the queue/image/dataview sprint, all three items now
root-caused by parallel investigations:

1. **Deleting a Chain has no confirmation** — and the audit found it is not an isolated
   miss: **26 destructive controls in settings are unconfirmed; the Provider delete
   (`src/settings/sections/ai.ts:124`) is the only one that confirms.** Tier-1 losses are
   hand-authored and unrecoverable (Chain, Capture, Agent, Trigger — each of the last three
   with TWO delete entry points), plus "Clear API key" (`src/settings/shared.ts:109`)
   destroys a Secret Storage secret on one click. Outside settings: the single
   orphaned-attachment delete trashes a real vault file unconfirmed
   (`src/ingestion/sections/orphanedAttachments.ts:76`), and "Lint Vault" / "Localize
   vault" are unconfirmed bulk mutations.
2. **No feature exists (or was ever planned) to show/configure what `Lint: all` runs.**
   The pipeline is 14 steps in `lintFile()` (`src/lint.ts:242`); title-stamp, `word-count`,
   source-ID derivation, and YAML sort are hardcoded with no off switch; steps 4–10 are
   bare lines inside one `updateFrontmatter` callback — no step identity exists to hang a
   UI on. Existing asymmetry bug: blanking `lintModifiedKey` disables that step, blanking
   `lintCreatedKey` does not (`src/lint.ts:288` vs `:290`).
3. **Long search queries time out at 5000ms** — `SEARCH_SERVICE_TIMEOUT_MS`
   (`src/search/client.ts:18`), hardcoded, not configurable. Reproducible with the query
   *"talking to a genius who also has thirty years of linux kernel experience [fable sol]"*
   when results are not cached. Root mechanics: the default `coverage` ranking leg runs one
   FTS scan per term (up to 24; measured +580ms at 9+ terms, common words pay ~800ms
   breadth cost each), and `withTimeout` only races — it never aborts, so the abandoned
   query keeps blocking the single-threaded companion; background probes then time out
   behind it and **three consecutive probe timeouts escalate to the 5-minute offline
   latch** (`src/search/lifecycleGate.ts:139`). One pathological query can take search
   down for 5 minutes.
4. **Ingestion Dashboard → Uncaptured videos → Ignore: flash + re-renders twice**
   (user-confirmed 2026-07-29; scroll position IS now maintained — the WP-4 scroll
   coordinator works). Likely mechanism: the Ignore handler's own `ctx.refresh` plus an
   event-driven dashboard refresh (settings save / `ingestionEvents`) both firing for one
   click — to be confirmed by the WP's investigation step.

## Decisions locked (user-confirmed 2026-07-29)

- Confirmations: **everything destructive confirms by default**, with a new settings
  section (mirroring "Routine notices", `src/settings/sections/orchestration.ts:274-285`)
  where the user can suppress confirmations **globally, per tier, or per action**.
- Lint steps: **visibility + toggles** (full step registry, not read-only list).
- Search: **latch safety + a performance investigation** using the repro query above;
  ranking-quality changes (rarest-first coverage cap) are NOT in this sprint — if the
  investigation confirms the coverage leg dominates, that becomes a follow-up plan with an
  eval-harness quality re-measurement.
- X post enrichment (`references/x-post-metadata-ingestion-findings.md`): **separate plan
  after this sprint.**

## Summary

Three remediation tracks: (A) a destructive-action registry + `confirmDestructive()`
helper wrapping the existing `ConfirmModal`, then a mechanical retrofit of ~30 call
sites; (B) refactor `lintFile()` into an enumerable step registry and render it in the
Lint tab with per-step toggles; (C) investigate the reproducible slow query with real
measurements, then land the latch-safety fixes (companion-side cooperative deadline,
configurable client timeout, escalation guard) that the diagnosis supports.

## Work packages

**WP-1 — Lint: all step registry + visibility/toggles.**
*~0.45 kSLOC · ~220k tokens · ~17 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent (~40% saving); Codex: subagent (~50%)*
Refactor `lintFile()` (`src/lint.ts:242-332`) into an enumerable step list: a
`LINT_STEPS` registry with `{ id, label, kind: 'frontmatter' | 'content' | 'structural',
settingsGate?, run }`. Frontmatter mutator steps (current lines 284–294) stay sub-steps
executed inside the SINGLE `updateFrontmatter` callback — the registry enumerates them,
it must not split the write (the write-barrier quirk depends on one chokepoint call).
New settings: `lintStepEnabled: Record<string, boolean>` (absent = enabled; defaults
preserve current behavior exactly) gating the four currently hardcoded steps —
title-stamp, `word-count`, `deriveSourceIdProperties`, `sortFrontmatterProperties`. Fix
the `lintCreatedKey` guard asymmetry (blank key disables the step, matching
`lintModifiedKey` at `src/lint.ts:290`). Lint tab (`src/settings/sections/lint.ts`) gains
a "Lint: all pipeline" group listing every step in fire order: toggle for gated steps,
static muted row for structural ones (read/diff/dataview-refresh/notice), each row naming
the existing setting that configures it where one exists. `Lint: localize attachments`
stays OUT of the pipeline (documented rule) — the panel may note its exclusion in prose.
Tests: registry order/enable semantics, created-key guard, defaults-preserve-behavior.
Files: `src/lint.ts`, `src/types.ts`, `src/settings/sections/lint.ts`, tests.
NOT in scope: changing any step's behavior; docs updates (WP-6).

**WP-2 — search long-query performance investigation (investigation-only).**
*~0.05 kSLOC · ~150k tokens · ~12 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent*
Investigation-first, hard stop condition: **no production code changes; deliverable is a
written diagnosis + measured numbers.** Repro: run the exact query *"talking to a genius
who also has thirty years of linux kernel experience [fable sol]"* (~13 terms) against
the live loopback companion, cold and warm. Instrument `scripts/search-companion.mjs`
with throwaway per-leg timing (primary FTS clause, coverage leg per-term, vector leg incl.
lazy matrix-rebuild state, pooling CTE) and capture: total `/v1/search` wall time, per-term
coverage scan times, whether the "not cached (?)" effect is the vector matrix rebuild,
SQLite page cache, or something else. Also measure the query-embed time separately
(client-side, outside the 5s window) to explain perceived-vs-timeout latency. Artifacts
land in the eval-harness repo (`/home/_shared_code/eval-harness/local-inference-bench/
measurements/`), NEVER in this repo (`runs/` is scrubbed+gitignored). Report: where the
5s goes, whether the companion-side deadline in WP-5 needs coverage-leg checkpoints or
whole-request bounds, recommended `searchQueryTimeoutMs` default, and a go/no-go on the
rarest-first coverage cap as a follow-up plan.
Files: throwaway instrumentation only (reverted); report + eval-harness artifacts.

**WP-3 — destructive-action confirmation framework.**
*~0.35 kSLOC · ~180k tokens · ~14 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent*
New `src/settings/destructiveActions.ts`: a static registry of every destructive action
(`{ id, label, tier: 'critical' | 'high' | 'medium' | 'low', group }`, ~30 entries from
the audit table) and `confirmDestructive(app, settings, actionId, { message, impact? }):
Promise<boolean>` — resolves suppression per-action → per-tier → global (all absent =
confirm), then shows the existing `ConfirmModal` (`src/confirmModal.ts:16-29`,
`destructive: true`). Settings: `destructiveConfirmGlobal: boolean` (default true),
`destructiveConfirmTier: Record<tier, boolean>`, `destructiveConfirmAction:
Record<string, boolean>` (absent = inherit). New "Destructive action confirmations"
settings section on the **Configure** tab mirroring the Routine-notices pattern
(`orchestration.ts:274-285`): global toggle, per-tier toggles, then per-action toggles
grouped by tier with `.crucible-row-divider` separators. Deliberately excluded from the
registry as non-destructive: the three "Clear cache" buttons (rebuildable by design) and
Ignore/Unignore (reversible paired buttons). Per-row job Cancel registers with
default-suppressed (preserves the documented `queueMonitor.ts:159-162` policy) but can be
turned on. Tests: resolution precedence, defaults.
Files: `src/settings/destructiveActions.ts` (new), `src/types.ts`,
`src/settings/sections/configure.ts`, tests.
NOT in scope: touching any existing delete handler (WP-4).

**WP-4 — retrofit all destructive call sites through `confirmDestructive`.**
*~0.45 kSLOC · ~200k tokens · ~15 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · depends on WP-3*
Route every audited site through the helper (~5 lines each; all handlers already async).
Structural work items: extract `deleteCapture()` (`automate.ts:80` + `:639`) and
`deleteTrigger()` (`triggers.ts:145` + `:465`) helpers mirroring `deleteProvider()`
(`ai.ts:115-142`) so both entry points share one confirm; Agent already funnels through
`deleteAgent()` (`ai.ts:904`). Migrate the existing Provider confirm onto the framework
(keep its "in use by" impact summary via the helper's `impact` param). Cover: Chain
(`automate.ts:172`), chain step (`automate.ts:291` — the misclick-geometry one), chain
variable, Capture ×2, Agent ×2, Trigger ×2, trigger guard condition + value row, Clear
API key (`shared.ts:109` — one mount covers all provider keys + YouTube), provider model
entry, lint excluded folder, folder template row, pinned folder, Shortcut, pinned
command, palette list entry, constrained-binding model, FX pair, weather location,
model-ref Clear ×3, single orphaned-attachment delete
(`ingestion/sections/orphanedAttachments.ts:76`), job row Cancel
(`queueMonitor.ts:454`, default-suppressed), and confirm-gate "Lint Vault"
(`lint.ts:21`) + "Localize vault" (`localize.ts:109`) bulk mutations. Bulk actions that
already confirm (cleanup-all, clear-queue, reset-index, clear-query-log) migrate to the
framework only if trivial; otherwise leave and note.
Files: `src/settings/sections/{automate,ai,triggers,configure,commands,orchestration,
lint,localize,guardConditionFields}.ts`, `src/settings/shared.ts`,
`src/ingestion/sections/orphanedAttachments.ts`, `src/ingestion/sections/queueMonitor.ts`,
tests (structural sweep: every registry id has a call site).

**WP-5 — search latch safety + timeout hardening.**
*~0.30 kSLOC · ~180k tokens · ~14 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · depends on WP-2 findings*
(a) **Companion-side cooperative deadline** on `/v1/search`: the server is
single-threaded with synchronous `DatabaseSync`, so the bound is cooperative — elapsed
checks between coverage-leg term scans (`search-companion.mjs:1323-1354`) and around the
vector leg; on budget exceed return a well-formed degraded response (results so far +
`degraded: true`) rather than blocking until completion. This removes the
abandoned-query-blocks-server vector entirely. (b) **Client timeout configurable**: new
`searchQueryTimeoutMs` setting (default per WP-2's recommendation, floor 3s, rendered in
the Search settings block `orchestration.ts:289-410`), threaded through
`SearchServiceClient.search()`. The two-timeout law in `src/search/AGENTS.md:34` stands —
interactive and indexing budgets stay separate constants; this adds a knob to one, never
collapses them. (c) **Escalation guard**: probe-timeout escalation to `markOffline`
(`lifecycleGate.ts:139-142`) must not latch 5-min-offline off the back of one slow
interactive query — with (a) in place the blocking vector is gone; add a regression test
simulating a slow search + concurrent probes asserting no offline latch. (d) Timed-out
searches get a `logWarn` breadcrumb including elapsed + term count. Any trivial fix WP-2
proved (e.g. an obvious redundant scan) may land here; the rarest-first coverage cap does
NOT — follow-up plan.
Files: `scripts/search-companion.mjs`, `src/search/client.ts`,
`src/search/lifecycleGate.ts`, `src/search/SearchManager.ts`, `src/search/types.ts`,
`src/settings/sections/orchestration.ts`, tests.

**WP-6 — dashboard Ignore double-render fix.**
*~0.10 kSLOC · ~90k tokens · ~7 min wall · mid (Claude Sonnet/medium; Codex Terra/medium)
· Claude: subagent; Codex: subagent*
Investigate-then-fix, small scope: clicking Ignore in Uncaptured videos flashes and
re-renders the section twice (scroll preservation itself works). Trace the two render
triggers — the Ignore handler (`src/ingestion/render/cells.ts:98-124`) awaits its own
`ctx.refresh`, and the underlying state write (settings save → seen-set / ingestion event)
independently drives a gated dashboard refresh — then coalesce so one click yields one
render (e.g. suppress the event-driven refresh for the section that just self-refreshed,
or drop the handler's own refresh and let the event path own it; pick whichever preserves
the minIntervalGate semantics). Do NOT re-wrap `ctx.refresh` (it is already the
scroll-preserving wrapper) and do not touch the scroll coordinator. Test: one Ignore
click → exactly one render of the section.
Files: `src/ingestion/render/cells.ts`, `src/ingestionDashboard.ts`, touched
`src/ingestion/sections/*.ts` only, tests.

**WP-7 — close (orchestrator-direct).**
*~0.05 kSLOC · ~50k tokens · ~5 min wall · must-direct (integration/gates/commit duty)*
Quirks: destructive-confirm framework rule ("new destructive control ⇒ register an action
id + route through `confirmDestructive`; never bare ConfirmModal in settings") in root
AGENTS.md; lint step registry note (steps enumerable, frontmatter sub-steps stay inside
one `updateFrontmatter` call); search AGENTS.md updates (cooperative deadline, timeout
knob, escalation guard) with re-measured numbers from WP-2; one-click-one-render rule for
dashboard action cells if WP-6 reveals a generalizable pattern. Docs:
`docs/lint-and-localize.md` step table; search-companion timeout note. Fixture
housekeeping from the X findings doc is NOT here (separate plan). Ledger rows. Deregister
plan. Live validation with user.

## Public interfaces

- New settings keys: `lintStepEnabled: Record<string, boolean>`,
  `destructiveConfirmGlobal: boolean`, `destructiveConfirmTier: Record<string, boolean>`,
  `destructiveConfirmAction: Record<string, boolean>`, `searchQueryTimeoutMs: number`.
- New module: `src/settings/destructiveActions.ts` (registry + `confirmDestructive`).
- Companion `/v1/search` response may carry `degraded: true` (additive, client tolerates
  absence).
- No wire/schema changes to the search index; no ranking changes.

## Execution

Wave 1: **WP-1 ∥ WP-2 ∥ WP-6** (disjoint: lint files vs search measurement vs ingestion
render) → Wave 2: **WP-3 ∥ WP-5** (disjoint: settings framework vs search impl; WP-5
consumes WP-2's report) → Wave 3: **WP-4** (retrofit; touches many settings files, lands
after WP-1/WP-3 settle) → WP-7 direct. Ask-before-dispatch per wave; workers never commit; briefs to
`runs/dispatch/`; worker worktrees branch from local master tip; full gate loop re-run
verbatim per landing (baseline **1002/85**, count only grows); one commit per WP; pause
for user compaction at wave boundaries.

## Test Plan / Verification

Gates per landing: `npm run lint` · `npx tsc -noEmit -skipLibCheck` · `npm test`
(≥1002/85) · `node esbuild.config.mjs production` · `grep -rna --include='*.ts'
"console\." src/` (only `src/log.ts`) · `file` + `LC_ALL=C grep -caP '\0'` per touched
file.

Live validation (WP-6, with user): (1) delete a throwaway Chain/Capture/Agent/Trigger →
confirm modal appears from BOTH entry points; suppress per-action → no modal; global off
→ nothing confirms. (2) Clear API key prompts. (3) Lint tab shows the pipeline in fire
order; toggling word-count off and running `Lint: all` leaves `word-count` untouched;
blanking created-key now disables that step. (4) The repro query returns without a 5s
timeout (or degrades gracefully); killing the companion mid-query does not latch search
offline for 5 minutes; probes recover it promptly. (5) `searchQueryTimeoutMs` visible in
Search settings. (6) Uncaptured videos → Ignore: one render, no flash, scroll stable.

## Critical Files

`src/lint.ts` · `src/settings/sections/lint.ts` · `src/settings/destructiveActions.ts`
(new) · `src/confirmModal.ts` (read-only exemplar) · `src/settings/sections/automate.ts` ·
`src/settings/sections/ai.ts` · `src/settings/shared.ts` · `scripts/search-companion.mjs` ·
`src/search/client.ts` · `src/search/lifecycleGate.ts` · `src/types.ts`

## Assumptions

- Defaults preserve current behavior everywhere: all lint steps enabled, all confirmations
  on (except job-row Cancel, default-suppressed per the documented queueMonitor policy).
- The cooperative deadline returning a degraded partial result is acceptable UX for a
  pathological query (alternative — hard 503 — loses the results already ranked).
- WP-2's numbers may adjust the `searchQueryTimeoutMs` default; the plan does not
  pre-commit a value.
- Rarest-first coverage cap and X post enrichment are follow-up plans, not this sprint.

**Total ≈ 1.75 kSLOC, ~1070k raw tokens; ~682k Claude-path / ~580k Codex-path
Opus/Sol-equivalent tokens.**
