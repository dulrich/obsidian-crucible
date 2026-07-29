# obsidian-crucible: queue claim recovery, image-failure taxonomy, dataview refresh, dashboard render

*Recommended model/effort — Claude: Sonnet/medium all impl WPs; Codex: Terra/medium.*

## Context

Live validation of the image-describe hardening sprint surfaced a second feedback batch. All
items are now root-caused with file:line evidence (three parallel investigations + live
vault/queue/store forensics):

1. **14 jobs stranded in `running/`** (13 `search_delete_path`, 1 `image_describe_note`), all
   with `status: queued`, `updated == created`. Root cause: `JobStore.move` re-looks-up the
   file **after** renaming it (`JobStore.ts:173-176`); when the vault index lags mid-churn the
   lookup misses and the guard throws *after* the rename, *before* any rollback — job stays in
   `running/` with stale frontmatter. `search_delete_path` is hit hardest because those jobs
   are minted during rename/delete churn and claimed immediately. Each strand also absorbs
   future delete-jobs for its path (dedup scans `running/`) → silent ghost index rows — and
   the claim throw escapes as an unhandled rejection that kills the drain pass
   (`OrchestrationAutoRunner.ts:281→225→199`). The on-load recovery scan exists
   (`main.ts:268-272`) but is time-gated (10.5 min) and sits behind ~21k sequential
   `listFolder` reads (incl. `done/` = 20,890 files, used only for counts).
2. **1039 permanent `kind:'failed'` image records — ~1030 are transient infra casualties, not
   poison images**: 954 `timed out after 120000ms` (cascade: a timed-out request is abandoned
   client-side but keeps generating server-side; the next image queues behind it and times out
   too — 495 failures in one hour) + 85 `net::ERR_CONNECTION_{REFUSED,RESET}`/`NETWORK_CHANGED`
   (router down → batch failed dozens of images *per second*, writing skip-forever records).
   Plus 7 zero-byte corrupt store JSONs. Skip-forever semantics were designed for poison
   images; infra failures must not earn them.
3. **`dataview:dataview-rebuild-current-view` is the wrong command** — in Dataview v0.5.68 it
   is `activeView.leaf.rebuildView()`: full leaf teardown + async reconstruction. The user's
   "Lint and Refresh" chain fires it fire-and-forget (external step); on a modified pass lint
   *also* fires it → double `rebuildView()`, and `reconcileOpenEditor` (`chains.ts:212-227`)
   `setViewData`s into a half-built view whose buffer is `''` → visible note blank (interface
   glitch, confirmed no data damage). The correct primitive is
   `dataview:dataview-force-refresh-views` / `index.touch()` (revision bump — non-destructive).
   The earlier `modified` gate removed the user's habitual refresh pathway because lint's
   writes are idempotent. Bonus real bug: "Replace Note Contents" capture checks emptiness
   *before* frontmatter stripping (`captures.ts:77` vs `:81`) — a YAML-only model response
   writes an empty body.
4. **Dashboard blink/scroll residual**: all 13 sections share ONE scroller (`view-content`);
   refreshes are concurrent + unserialized, so scroll capture AND restore get clamped when a
   sibling section is mid-rebuild. 12 of 13 tables are uncapped (only queueMonitor passes
   `limit`); every queue event also rebuilds the uncapped full-vault `youtubeWithoutMetadata`
   table outside the min-interval gate; queueMonitor blanks its body *before* awaiting two
   folder scans; seven user paths (sort-header clicks, Ignore buttons, per-section Refresh)
   bypass scroll preservation entirely.
5. **Resolved, no code**: "talking to a genius with thirty years of linux kernel experience"
   is not in the vault in any phrasing variant — search was correct; the source was never
   ingested.

## Decisions locked (user-confirmed)

- Failed-record healing: **auto-prune transient-failure records at backfill start AND add a
  "Retry failed image descriptions" command.**
- OpenRouter **fallback deferred** (failures were self-inflicted); instead, **audit + validate
  OpenRouter as a primary image-description provider** (settings → call → store must work for
  non-local users).

## Work packages

**WP-1 — queue claim-path fix + state-gated recovery.**
*~0.25 kSLOC · ~180k tokens · ~14 min wall · mid (Claude Sonnet/medium; Codex Terra/medium) ·
Claude: subagent (~70% saving); Codex: subagent*
Fix A: `JobStore.move` stops re-deriving the file after rename — Obsidian `TFile`s are live
(rename mutates `file.path` in place; already documented/depended on at
`FileJobBackend.ts:173-189`). Assert `file.path === targetPath` (fall back to lookup only if
needed); any residual failure handling goes inside the existing rollback `try`. Fix B:
state-gated sweep in `Orchestrator.scan()` before the time-based sweep — bounce any `running/`
entry with `job.status === 'queued'` && `!isRunning(...)` straight to `queued` (no time
cutoff; un-updated status is proof the claim aborted). Reuse
`failedJobRepair.requeueServiceFailures`'s shape (per-entry try/catch, `yieldToEventLoop`
every 20, single `emitQueueChanged` + `kickAll`). Also take `done`/`failed`/`cancelled`
counts from `folder.children.length` instead of `listFolder` (removes ~21k main-thread reads
from the recovery path). Fix C: wrap `await this.orchestrator.runNextOfType(type)`
(`OrchestrationAutoRunner.ts:281`) so a claim throw `logError`s and ends one worker instead
of rejecting `drainType`'s `Promise.all` and skipping the redrain. Tests for all three.
Heals the 14 stranded jobs on next reload and un-blocks the ghost delete dedup.
Files: `src/orchestration/JobStore.ts`, `Orchestrator.ts`, `OrchestrationAutoRunner.ts`, tests.
NOT in scope: AGENTS.md quirks (WP-5), leases/heartbeats, status-write-before-move.

**WP-2 — image-describe failure taxonomy, breaker, retry.**
*~0.40 kSLOC · ~200k tokens · ~15 min wall · mid (Claude Sonnet/medium; Codex Terra/medium) ·
Claude: subagent; Codex: subagent*
(a) Classify failures at record-write time: `failureClass: 'transient' | 'permanent'` on
failed records (transient = `withTimeout` labels + `net::ERR_*`; permanent = everything else).
(b) Infra breaker: a connection-class error (`ERR_CONNECTION_REFUSED/RESET`,
`ERR_NETWORK_CHANGED`) writes **no record** and aborts the batch with a clear job-note line;
3 consecutive timeouts likewise aborts (server likely wedged behind abandoned generations) —
remaining images stay pending, job notes say why. (c) Backfill start prunes transient-class
failed records (same shape as `pruneDegenerate`) so the ~1030 casualties re-describe; store
load tolerates + deletes zero-byte/unparseable JSONs (7 exist). Legacy records without
`failureClass` classify by message content. (d) New command "Search: retry failed image
descriptions" (registered via `registerCrucibleCommand` + internal command): clears failed
records (transient-only or all — modal choice), enqueues the backfill. (e) Non-local
provider audit: verify the describe path holds for remote openai-compatible providers
(payload shape, `isLocal`-gated `reasoning_effort` stays gated, `max_tokens` unconditional,
no loopback assumptions) — findings in the report; live OpenRouter smoke test happens at
WP-5 validation with the user. Preserve landed contracts: failed records emit no
chunks/facet; a failure's arrival never moves a note's `contentHash`; `has()` stays true for
skip semantics within a run.
Files: `src/orchestration/utils/imageDescribe.ts`, `src/orchestration/workflows/ImageDescribeWorkflow.ts`,
`src/search/imageDescriptionStore.ts`, `src/search/SearchManager.ts` (only if filter shape
changes), command registration, tests.

**WP-3 — dataview refresh done right + editor-blank guards.**
*~0.20 kSLOC · ~140k tokens · ~11 min wall · mid (Claude Sonnet/medium; Codex Terra/medium) ·
Claude: subagent; Codex: subagent*
(a) Internal `dataview-refresh` chain command (`registerInternalCommands`, `mutating: false`,
no note lock): guarded `app.plugins.plugins.dataview.index.touch()` (typed via the
guarded-augmentation precedent in `src/types.ts:65-95`), falling back to
`executeCommandById('dataview:dataview-force-refresh-views')`; **never** `rebuild-current-view`
/ `rebuildView()`. A bare `workspace.trigger('dataview:refresh-views')` is a no-op without
the revision bump — don't use it. (b) `lint.ts:285-296`: replace the `modified`-gated
`rebuild-current-view` fire with an **unconditional** force-refresh when the note contains
dataview/dataviewjs blocks (non-destructive → no flicker; restores the "run Lint: all to
refresh tables" pathway). (c) `reconcileOpenEditor` guard: never `setViewData` into a view
reporting `''` while disk is non-empty (mid-load view). (d) `captures.ts`: move the
empty-content guard *after* frontmatter stripping so `writeMode: 'replace'` can never write
an empty body. Tests incl. a regression update to `tests/lintModifiedSignal.test.mjs`.
User's "Lint and Refresh" chain then becomes `lint-note → crucible:dataview-refresh`
(their edit; noted at validation).
Files: `src/lint.ts`, `src/internalCommands.ts`, `src/chains.ts`, `src/captures.ts`,
`src/types.ts`, tests.

**WP-4 — dashboard render/scroll fix set.**
*~0.35 kSLOC · ~190k tokens · ~15 min wall · mid (Claude Sonnet/medium; Codex Terra/medium) ·
Claude: subagent; Codex: subagent*
Five small fixes from the investigation, one WP (shared file scope): (#1) default row cap
(~200) in `renderTableSection` via the existing `limit` option + "showing 200 of N" line
(pattern at `queueMonitor.ts:297`); (#5) make `SectionContext.refresh` itself the
scroll-preserving wrapped function so all seven bypassing call sites (sort headers, Ignore
buttons, per-section Refresh, control-center filters) are covered; (#2) own `minIntervalGate`
for `youtubeWithoutMetadata` + move the two `refreshIntakeButton` folder-scans inside the
gated queueMonitor refresh; (#4) `queueMonitor.ts:236`: stop emptying the body before the
`listFolder` awaits — build detached / empty just before table render; (#3) dashboard-level
scroll coordinator in `refresh.ts`: capture scrollTop when in-flight count goes 0→1, restore
once at 0 after a **double** rAF, re-assert if readback mismatches (fixes both capture-time
and restore-time clamps on the shared scroller). Fix the test model: `FakeElement.scrollTop`
must clamp against `scrollHeight - clientHeight` so the clamp class is testable.
NOT in scope: keyed row reuse / virtual DOM; sourceEval dashboard.
Files: `src/ingestion/render/refresh.ts`, `render/section.ts`, `render/sortableTable.ts`,
`render/cells.ts`, `src/ingestion/sections/*.ts` (touched sections only),
`src/ingestionDashboard.ts`, `tests/ingestionRefreshGates.test.mjs`.

**WP-5 — close (orchestrator-direct).**
*~0.05 kSLOC · ~50k tokens · ~5 min wall · must-direct (integration/gates/commit duty)*
Quirks: JobStore.move post-rename lookup (+ correct the two wrong claims in
`src/orchestration/AGENTS.md`: the re-home quirk says no auto-scan on load but `main.ts:271`
has one; the move-rollback quirk must note the rollback never covered the disappeared-guard);
wrong-dataview-command + rebuildView-races-setViewData; transient-vs-permanent failure
taxonomy. Ledger rows. Live validation with the user (below). Deregister plan.

## Execution

Wave 1: **WP-1 ∥ WP-2** (operational blockers; disjoint file scopes) → Wave 2: **WP-3 ∥ WP-4**
(UX; disjoint) → WP-5 direct. Ask-before-dispatch per wave; workers never commit; briefs to
`runs/dispatch/`; full gate loop (baseline **949/79**, count only grows) re-run verbatim per
landing; one commit per WP; worker worktrees branch from local master tip.

## Test Plan / Verification

Gates per landing: `npm run lint` · `npx tsc -noEmit -skipLibCheck` · `npm test` (≥949/79) ·
`node esbuild.config.mjs production` · console.* sweep (only `src/log.ts`) · `file` + NUL
check per touched file.

Live validation (WP-5, with user): (1) reload plugin → the 14 stranded jobs requeue and
drain; `running/` empties. (2) Backfill run: job note reports transient-prune count (~1030),
pass times bounded, no failure bursts; genuinely-failed images report as `permanent`.
(3) Kill llama router mid-batch → batch aborts with infra message, **no** new failed records.
(4) "Retry failed image descriptions" command works. (5) OpenRouter configured as
image-description provider: single-note describe → record stored (settings → call → store
for non-local users). (6) Chain `lint-note → crucible:dataview-refresh` refreshes tables, no
blank, on unmodified notes too. (7) Dashboard: long tables cap at 200 with count line;
sort-click preserves scroll; queue drain shows no blank queueMonitor and stable scroll.

## Critical Files

`src/orchestration/JobStore.ts` · `Orchestrator.ts` · `OrchestrationAutoRunner.ts` ·
`orchestration/utils/imageDescribe.ts` · `workflows/ImageDescribeWorkflow.ts` ·
`src/search/imageDescriptionStore.ts` · `src/lint.ts` · `src/chains.ts` · `src/captures.ts` ·
`src/internalCommands.ts` · `src/ingestion/render/refresh.ts` · `src/ingestionDashboard.ts`

## Assumptions

- The 14 stranded jobs are healed by the WP-1 sweep on reload — no manual queue surgery.
- Deleting transient-failed + zero-byte store records is safe: they re-enter pending and
  re-describe (same contract as `pruneDegenerate`).
- Dataview presence is guarded everywhere; absence of dataview = silent no-op.
- OpenRouter fallback-on-failure stays deferred to a future plan if post-fix batches still
  show real per-image failures.

**Total ≈ 1.25 kSLOC, ~760k raw tokens; ~686k Claude-path / ~485k Codex-path
Opus/Sol-equivalent tokens.**
