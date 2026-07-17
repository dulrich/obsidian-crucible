# Dashboard & main.ts Decomposition + Always-Visible Per-Type Queue Controls

*Recommended model/effort — Claude: Sonnet/medium for all three WPs (well-scoped extraction against settled in-repo patterns; D1 is trivial); Codex: Terra/medium for all three.*

## Context

The TN review (`plans/tn-review-remediation-2026-07-17.md`, non-WP observation a) flagged `src/main.ts` and `src/ingestionDashboard.ts` as over the 1k-line boundary and still accreting; WP-R3 arrested the dashboard's growth (1332 → 1304) but main.ts grew to 1382. Both files are past due for the dedicated decomposition plan the review called for. Bundled in per user decision: the Queue Monitor's per-type control strip (WP-R3's `renderQueueTypeControls`) currently renders only for job types with queued/running work, so per-type auto-run vetoes and rate-limit overrides cannot be configured while queues are idle — the user hit exactly this confusion post-WP-R3 ("where did the controls land?").

**First implementation step:** copy this document to `plans/decomposition-dashboard-main-2026-07-17.md` in the repo and add `- "[[decomposition-dashboard-main-2026-07-17]]"` to `pending-plans` in `DEVELOPMENT.md` frontmatter (frontmatter only — the body, including `# Todos`, is user-owned).

## Decisions locked (user-confirmed)

- Both targets bundled into one plan; the queue-controls change rides as a WP inside the decomposition plan.
- Queue-controls layout: a **new default-hidden "Queue controls" section preceding Queue Monitor** holds the detailed controls (global Autorun, Run next, Auto-enrich, rate limit, per-type strip for all registered types); the Queue Monitor card itself keeps only a top-level **panic switch** with copy pointing to the controls section.
- Panic scope: **auto-draining only** — manual Run/Run-next/Enqueue buttons still execute on explicit click (consistent with the manual-bypasses-gate model).
- Panic model: a **new master flag** (`orchestrationQueueEnabled`, default true) added as a gate-predicate input, so the individual Autorun/Auto-enrich/per-type states are preserved underneath and re-enabling restores the exact prior configuration.
- Scope is the two flagged files. Other large files (`localizeAttachments.ts` 866, `settings/sections/orchestration.ts` 833) are out of scope.

## Summary

Three packages: add the default-collapsed Queue controls section (all registered types, all detailed controls) plus the Queue Monitor panic switch backed by a new master gate flag (D1, first so the code moves in D2 carry it); decompose ingestionDashboard.ts's per-section render methods into `src/ingestion/sections/*` modules behind a narrow host seam, completing the data/render split that `src/ingestion/data/*` and `src/ingestion/render/*` already established (D2); extract main.ts's command/capture/picker registration blocks into modules following the existing `src/commands.ts` `registerStaticCommands` exemplar (D3). All three are behavior-preserving; D2 and D3 have disjoint file scopes and can run in parallel after D1.

## Key Changes

**WP-D1 — Queue controls section + panic switch (~0.2 kSLOC touched, ~60k tokens).** (1) **New default-collapsed section "Queue controls" preceding Queue Monitor** — the existing scaffold already supports it (`buildSection(id, title, desc, decorateHeader?, defaultCollapsed = true)`, `src/ingestionDashboard.ts:353`); add a `queueControls` member to `SectionId` (`src/ingestion/render/types.ts`). It hosts everything currently in the Queue Monitor card's control row — global Autorun toggle, Run next, Auto-enrich toggle (with the `setAutoEnrichEnabled` wiring and `enrichToggle` re-sync moving along), enrichment rate limit — plus the per-type strip rendered for **all registered types** (`plugin.orchestrator.jobTypes()`, not `typeCounts.keys()`), so vetoes and per-type rate overrides are configurable while queues are idle (`runType` already no-ops on empty types; the Run button needs no guard). (2) **Queue Monitor keeps only a panic switch** above the jobs table: a "Queue enabled" master toggle with description text pointing to the Queue controls section for specifics. (3) **Master flag**: new setting `orchestrationQueueEnabled: boolean` (default true, no migration — the settings-load default covers absent keys). `AutorunGateInputs` gains `queueEnabled`; `typeAutorunEnabled` returns false when it's off, so `computeShouldDrain` (= predicate + readiness) and every display chip inherit the veto with the display=drain invariant intact. Manual `runType`/`runOnce` are untouched (panic stops auto-draining only). The panic toggle persists the flag and calls `orchestrationAutoRunner.kickAll()` on re-enable. Extend `tests/autorunGate.test.mjs`: panic-off forces the predicate false across all input combos; agreement pin updated for the new input. Files: `src/ingestionDashboard.ts`, `src/ingestion/render/queueTypeControls.ts`, `src/ingestion/render/types.ts`, `src/orchestration/autorunGate.ts`, `src/orchestration/OrchestrationAutoRunner.ts`, `src/types.ts`, `tests/autorunGate.test.mjs`, `styles.css` (panic-switch styling if needed). *Model: mid (Claude Sonnet/medium; Codex Terra/medium — small gate-contract touch, but fully test-pinned). Execution: Claude direct (tiny ≤200k; gate contract kept under orchestrator eyes); Codex direct (tiny ≤200k).*

**WP-D2 — Dashboard section decomposition (~0.65 kSLOC touched, moves-dominant, ~130k tokens).** ingestionDashboard.ts (1304) keeps only lifecycle + registry: `mount`/`unmount`, `registerListeners`, `relevantSignature`, `createSectionHeader`/`buildSection`, the section table, `setSectionCount`/`setSectionMeta`, refresh plumbing. Everything section-specific moves to new modules in `src/ingestion/sections/`, one per section family, each exporting a render function (or factory closure where the section owns state) taking a narrow `DashboardHost` seam declared in `src/ingestion/render/types.ts` — expose only what sections use today (plugin, app, `refresh(id)`, count/meta setters or the existing `SectionContext`, `uncapturedQueueItems`). Suggested modules: `queueMonitor.ts` (panic switch + jobs-table render), `queueControls.ts` (the D1 controls section), `clippings.ts`, `transcripts.ts`, `intake.ts` (blog + YouTube intake incl. the enqueue-intake button trio), `uncapturedPosts.ts`, `uncapturedVideos.ts` (incl. `uncapturedQueueItems` if extractable, else host method), `youtubeWithoutMetadata.ts` (incl. enqueue cells/buttons), `controlCenters.ts` (blog + channel), `orphanedAttachments.ts`, `ignored.ts`. Per-section state moves into the owning module's closure: `uncapturedVideosCache`, `orphanedAttachmentsCache`, `blogFilter`, `channelFilter`. Cross-section DOM helpers (`renderFileLink`, `renderOpenButton`, `renderIgnoreButton`/`renderUnignoreButton`, `renderEnrichedCell`) move to the existing `src/ingestion/render/cells.ts`. Reuse, don't rewrite: `renderTableSection`/`renderSortableTable` and the `src/ingestion/data/*` compute modules stay as-is. Target: ingestionDashboard.ts ≤ ~600 lines, zero behavior change. Files: `src/ingestionDashboard.ts`, `src/ingestion/sections/*` (new), `src/ingestion/render/cells.ts`, `src/ingestion/render/types.ts`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium — mechanical moves against an explicit seam spec). Execution: Claude subagent (130k×0.6 = 78k vs 130k×2 = 260k direct under a Fable orchestrator, 70% saving; ≤200k so direct is defensible); Codex subagent (65k vs 130k, 50% saving).*

**WP-D3 — main.ts registration decomposition (~0.55 kSLOC touched, moves-dominant, ~110k tokens).** Follow the `src/commands.ts` `registerStaticCommands(plugin)` exemplar — its docstring already names main.ts "a thin lifecycle/registration hub". Extract, each as a module of functions taking `plugin`:
- `src/internalCommands.ts` — `registerInternalCommands` (main.ts:849–1045) plus its private helpers (`upsertActiveFileTags`, `upsertActiveFileProperty`, `targetFrontmatter`, `ignoreYoutubeVideoCommand`, `watchYoutubeVideoCommand`).
- `src/moveFileCommands.ts` — `registerMoveFileCommands` + `openMoveFileFolderPicker` + `moveFileToFolder` (593–717).
- `src/captureCommands.ts` — `registerCaptures` + `resolveCaptureValue`/`resolveCaptureContext` + `promptForCaptureValue` + `openCaptureDialog`, and the file-tail `PromptModal` class (1359–1382) if `promptForText` moves with it (keep a thin `plugin.promptForText` delegate if external callers exist).
- `src/periodPickers.ts` — `openDayPicker`/`openWeekPicker`/`openMonthPicker`, `openPeriodPicker`, `materializePeriodFromString`, `handlePeriodFileCreate`.
Externally-called public methods (grep before moving — e.g. `fetchYoutubeMetadataForActiveNote`, `promptForText`) keep thin delegating methods on the plugin so call sites don't churn; everything must still route through `registerCrucibleCommand` (AGENTS.md command-registration quirk). Target: main.ts ≤ ~950 lines, zero behavior change. Files: `src/main.ts`, the four new modules, import updates at any external call sites the grep finds. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude subagent (110k×0.6 = 66k vs 110k×2 = 220k direct, 70% saving; ≤200k so direct is defensible); Codex subagent (55k vs 110k, 50% saving).*

## Public Interfaces

None external. Internal seams only: the new `DashboardHost` interface (D2) and plugin-taking registration functions (D3). Settings shape, command IDs, job types, and queue semantics unchanged.

## Execution

- **Order:** WP-D1 first (tiny; lands before D2 moves the call site so the move carries the change), then WP-D2 and WP-D3 — disjoint file scopes, parallelizable.
- **Per Hard Rule 1, confirm with the user which subagents to spawn before dispatching D2/D3.** Subagents never commit; the orchestrator reviews each diff, re-runs gates verbatim, commits per-WP.
- Both D2 and D3 are also direct-defensible (≤200k raw) if the orchestrator prefers zero dispatch overhead.

## Test Plan / Verification

- Gates every WP (tests-lint skill): `npm run lint`, `npx tsc -noEmit -skipLibCheck`, `npm test` (baseline 228/228), `node esbuild.config.mjs production`.
- WP-D1: reload plugin, open Ingestion Dashboard with an empty queue → a collapsed "Queue controls" section precedes Queue Monitor; expanding it shows the four global controls plus every registered type's row (auto toggle, chip, rate input, Run); toggling a veto/override persists across reload. Queue Monitor shows only the panic switch (pointing at Queue controls) above the table. Panic off → every chip reads idle, nothing auto-drains (enqueue a job and watch it sit), manual Run still executes it; panic back on → prior Autorun/Auto-enrich/per-type configuration resumes unchanged.
- WP-D2: `wc -l src/ingestionDashboard.ts` ≤ ~600; dashboard smoke — every section renders, sort/filter/ignore/enqueue/cleanup buttons behave identically; `grep` confirms no section render logic remains in ingestionDashboard.ts.
- WP-D3: `wc -l src/main.ts` ≤ ~950; command palette shows the same command set (Internal/Materialize/Move/Captures groups); move-file, capture, period-picker, ignore/watch-video commands run identically; `grep registerCrucibleCommand` confirms all extracted commands still route through it.

## Critical Files

`src/ingestionDashboard.ts`, `src/ingestion/render/queueTypeControls.ts`, `src/ingestion/render/types.ts`, `src/ingestion/render/cells.ts`, `src/ingestion/sections/*` (new), `src/orchestration/autorunGate.ts`, `src/orchestration/OrchestrationAutoRunner.ts`, `src/types.ts` (D1/D2); `src/main.ts`, `src/commands.ts` (exemplar, unchanged), `src/internalCommands.ts` + 3 sibling new modules (D3).

## Assumptions

- No DOM-level tests exist for the dashboard or command registration; gates + manual smoke are the verification, matching current repo practice.
- The `commands.ts` docstring's rationale for keeping dynamic command sets on the plugin class ("depend on per-config state") does not block extraction — the extracted functions take `plugin` and read the same state; the docstring gets updated to match.
- Per-section state (`uncapturedVideosCache`, filters) has no cross-section readers; the executor verifies by grep before moving each into its section closure, and surfaces any counterexample instead of forcing the move.
- Weighted-path arithmetic computed by hand from `references/model-costs.json` (sonnet 0.6, terra 0.5) because no MCP/skill execution surface for `scripts/model-cost.mjs` was available in the planning session — flagged to the user as a tooling gap.

**Total ≈ 1.4 kSLOC (moves-dominant, near-net-neutral), ~300k raw tokens; ~180k Claude-path / ~150k Codex-path Opus/Sol-equivalent tokens.**
