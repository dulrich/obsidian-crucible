# WP-D3 Execution Brief — main.ts registration decomposition

## Mission

You are an implementation worker for the obsidian-crucible Obsidian plugin, working in
the git worktree at `/home/_shared_code/obsidian-crucible-wpd3` on branch `wp-d3-work`
(branched from master at WP-D1). Your work package is **WP-D3** of the committed plan
`plans/decomposition-dashboard-main-2026-07-17.md` — read that plan's WP-D3 section
first, then this brief. You implement, verify, and write a report; you do not commit.

This is a **behavior-preserving decomposition**: `src/main.ts` (currently 1382 lines)
becomes a thin lifecycle/registration hub of ≤ ~950 lines. The exemplar is
`src/commands.ts` — `registerStaticCommands(plugin)` — whose docstring already names
main.ts as that hub. Follow its pattern: modules of functions taking `plugin`.

## Hard constraints — violating any of these voids the work

- **Never commit or push.** Leave all changes uncommitted in the working tree. The
  orchestrator reviews the diff, re-runs gates, and commits.
- **Zero behavior change.** Same command IDs, same palette groups, same modals, same
  settings reads/writes, same event registrations in the same lifecycle order.
- **Every extracted command must still route through `registerCrucibleCommand`** —
  this is the AGENTS.md command-registration quirk; direct `addCommand` calls are a
  regression.
- **Do not touch** `src/ingestionDashboard.ts`, anything under `src/ingestion/`,
  `DEVELOPMENT.md`, anything under `plans/`, `AGENTS.md`, or any file outside the File
  scope below. (A sibling worker is decomposing the dashboard in a separate worktree —
  file scopes must stay disjoint.)
- **No `console.*`** — only `logWarn`/`logError` from `src/log.ts` (grep-enforced:
  `console.` appears only in `src/log.ts`).
- Frontmatter writes go through `updateFrontmatter` in `src/frontmatter.ts`, never raw
  `processFrontMatter` (you should only be moving such code, not writing new).

## Scope of change

Line anchors below are from a recent audit and may have drifted a few lines — re-grep
before cutting. Extract, each as a module of functions taking `plugin`:

1. **`src/internalCommands.ts`** — `registerInternalCommands` (~main.ts:849–1045) plus
   its private helpers used only there (`upsertActiveFileTags`,
   `upsertActiveFileProperty`, `targetFrontmatter`, `ignoreYoutubeVideoCommand`,
   `watchYoutubeVideoCommand`).
2. **`src/moveFileCommands.ts`** — `registerMoveFileCommands` +
   `openMoveFileFolderPicker` + `moveFileToFolder` (~593–717).
3. **`src/captureCommands.ts`** — `registerCaptures` + `resolveCaptureValue` /
   `resolveCaptureContext` + `promptForCaptureValue` + `openCaptureDialog`, and the
   file-tail `PromptModal` class (~1359–1382) if `promptForText` moves with it.
4. **`src/periodPickers.ts`** — `openDayPicker` / `openWeekPicker` / `openMonthPicker`,
   `openPeriodPicker`, `materializePeriodFromString`, `handlePeriodFileCreate`.

**Grep for external callers before moving any public method** (at minimum
`fetchYoutubeMetadataForActiveNote` and `promptForText`; sweep every method you move):
any plugin method called from outside main.ts keeps a thin delegating method on the
plugin class so call sites don't churn. Delegates are one-liners calling the extracted
function.

**File scope:** `src/main.ts`, the four new modules above, plus import-line updates at
any external call sites your grep finds. `src/commands.ts` is the exemplar and stays
unchanged except its docstring if it references something you moved.

**Explicitly NOT in scope:** the ingestion dashboard and `src/ingestion/*`, the
autorun gate/runner internals (main.ts wiring of them stays where it is unless it is
part of a block named above), settings sections, any behavior change however small.

## Gates — run all four verbatim; all must pass

- `npm run lint` — baseline clean (eslint + stylelint).
- `npx tsc -noEmit -skipLibCheck` — baseline clean.
- `TMPDIR=$(mktemp -d) npm test` — baseline is **230/230 passing** (the private TMPDIR
  avoids tmp-dir collisions with the sibling worker; one re-run allowed if a failure
  looks environmental, otherwise it is real).
- `node esbuild.config.mjs production` — exits 0.

Also verify: `wc -l src/main.ts` ≤ ~950, and
`grep -c registerCrucibleCommand src/internalCommands.ts src/moveFileCommands.ts src/captureCommands.ts src/commands.ts`
confirms every extracted command still routes through it.

## Report-back

Write `runs/dispatch/wp-d3-report.md` (in your worktree) containing: the final module
list with line counts; every kept plugin delegate and the external caller (file:line)
that justifies it; every deviation from this brief with reasons; verbatim tails of all
four gates; anything deferred. Close with: "Orchestrator: review the diff and re-run
gates before commit." Your final message should be a short summary; the report file is
the artifact.
