# WP-D2 Execution Brief — Ingestion dashboard section decomposition

## Mission

You are an implementation worker for the obsidian-crucible Obsidian plugin, working in
the git worktree at `/home/_shared_code/obsidian-crucible-wpd2` on branch `wp-d2-work`
(branched from master at WP-D1). Your work package is **WP-D2** of the committed plan
`plans/decomposition-dashboard-main-2026-07-17.md` — read that plan's WP-D2 section
first, then this brief. You implement, verify, and write a report; you do not commit.

This is a **behavior-preserving decomposition**: `src/ingestionDashboard.ts` (currently
1362 lines) becomes a thin lifecycle/registry controller of ≤ ~600 lines, with every
section's render logic moved to focused modules under `src/ingestion/sections/`.

## Hard constraints — violating any of these voids the work

- **Never commit or push.** Leave all changes uncommitted in the working tree. The
  orchestrator reviews the diff, re-runs gates, and commits.
- **Zero behavior change.** Same sections in the same order, same controls, same
  listeners/debounce routing, same refresh semantics, same CSS classes and DOM shape.
- **Do not touch** `src/main.ts`, `DEVELOPMENT.md`, anything under `plans/`,
  `AGENTS.md`, or any file outside the File scope below. (A sibling worker is
  decomposing `main.ts` in a separate worktree — file scopes must stay disjoint.)
- **No `console.*`** — only `logWarn`/`logError` from `src/log.ts` (grep-enforced:
  `console.` appears only in `src/log.ts`).
- Frontmatter writes go through `updateFrontmatter` in `src/frontmatter.ts`, never raw
  `processFrontMatter` (you should only be moving such code, not writing new).

## Scope of change

1. **`DashboardHost` seam** — declare in `src/ingestion/render/types.ts` a narrow
   interface exposing only what sections actually use today: the plugin, the app, a
   `refresh(id: SectionId)` hook, the count/meta setters (or the existing
   `SectionContext`), and `uncapturedQueueItems()`. Derive it from real usage — grep
   what each render method touches on `this` before deciding; do not speculatively
   widen it.
2. **Section modules** — move each per-section render method (and its private helpers
   used by only that section) into a module in `src/ingestion/sections/`, one per
   section family, each exporting a render function (or a factory closure where the
   section owns state) that takes the host seam. Suggested split: `queueMonitor.ts`
   (panic switch + jobs-table render), `queueControls.ts` (the Queue controls section
   that WP-D1 just added: `buildQueueControlsSection`/`renderQueueControls`),
   `clippings.ts`, `transcripts.ts`, `intake.ts` (blog + YouTube intake incl. the
   enqueue-intake button trio), `uncapturedPosts.ts`, `uncapturedVideos.ts`,
   `youtubeWithoutMetadata.ts`, `controlCenters.ts` (blog + channel),
   `orphanedAttachments.ts`, `ignored.ts` (ignored posts + videos).
3. **Per-section state** moves into the owning module's closure:
   `uncapturedVideosCache`, `orphanedAttachmentsCache`, `blogFilter`, `channelFilter` —
   but **grep for cross-section readers first**; if any state is read by another
   section, leave it on the host and record the counterexample in your report instead
   of forcing the move. Same for `uncapturedQueueItems` (the enrichment auto-source):
   move it into `uncapturedVideos.ts` only if nothing outside that section needs it —
   note the Queue controls section and `mount` both call it today, so it likely stays a
   host method.
4. **Shared DOM helpers** (`renderFileLink`, `renderOpenButton`, `renderIgnoreButton`,
   `renderUnignoreButton`, `renderEnrichedCell`, and any similar cross-section cell
   helpers you find) move to the existing `src/ingestion/render/cells.ts`, following
   its current style.
5. **What stays in `ingestionDashboard.ts`:** `mount`/`unmount`, `registerListeners`,
   `relevantSignature`, `createSectionHeader`/`buildSection`, the sections map,
   `setSectionCount`/`setSectionMeta`, `refresh`/`refreshAll`/`renderSection` dispatch,
   intake-button state plumbing if it is genuinely cross-section (else it moves with
   `intake.ts`).
6. **Reuse, don't rewrite:** `renderTableSection`/`renderSortableTable` and the
   `src/ingestion/data/*` compute modules stay as-is.

**File scope:** `src/ingestionDashboard.ts`, `src/ingestion/sections/*` (new),
`src/ingestion/render/cells.ts`, `src/ingestion/render/types.ts`. Import-line updates
in these files only. Nothing else.

**Explicitly NOT in scope:** `src/main.ts` and everything it registers, the autorun
gate/runner, settings sections, styles.css (the decomposition must not need CSS
changes), any behavior or UX change however small.

## Gates — run all four verbatim; all must pass

- `npm run lint` — baseline clean (eslint + stylelint).
- `npx tsc -noEmit -skipLibCheck` — baseline clean.
- `TMPDIR=$(mktemp -d) npm test` — baseline is **230/230 passing** (the private TMPDIR
  avoids tmp-dir collisions with the sibling worker; one re-run allowed if a failure
  looks environmental, otherwise it is real).
- `node esbuild.config.mjs production` — exits 0.

Also verify: `wc -l src/ingestionDashboard.ts` ≤ ~600, and
`grep -n "renderTableSection\|renderSortableTable" src/ingestionDashboard.ts` shows no
section render logic left behind (dispatch calls into section modules are fine).

## Report-back

Write `runs/dispatch/wp-d2-report.md` (in your worktree) containing: the final module
list with line counts; the `DashboardHost` interface as landed; every deviation from
this brief with reasons (especially any state that could NOT move to a section closure,
with the file:line of the cross-section reader); verbatim tails of all four gates;
anything deferred. Close with: "Orchestrator: review the diff and re-run gates before
commit." Your final message should be a short summary; the report file is the artifact.
