# Plan D — Intake action language v2 + dashboard/settings validation polish

> **STATUS: COMPLETE (2026-08-01).** All seven WPs landed on master: DP6 `e318c18`
> (AGENTS dox sweep, quirks indexes activated), DP1 `1877d7b` (intake action language
> v2 — `renderIconButton` icon-only cells, Clip=`download`/Skip=`circle-x`, muted-never-
> absent, `Enriched?` column removed, ignored rows un-ignore-then-act), DP2 `2b4db13`
> (header alignment, xPosts default-collapsed, terse control-center descs), DP3
> `c4fe0fe` (queue status pills = real filters with honest retention empty states;
> queue row actions Run=`play`/Details=`info`/Cancel=danger `x`), DP4 `0b66c85`
> (pinned settings tab-strip via `.crucible-settings-sticky-header`; native-modal
> verification is a user rerun item — `runs/dispatch/wp-dp4-report.md`), DP5 `3646ddf`
> (icon-language sweep: Duplicate=`copy-plus`, remove-from-list=`x` vs entity
> `trash`, TOC chevrons, Refresh=`refresh-cw`; fleet icon table in AGENTS.md), DP7
> (this commit — v2 UI-standards language finalized in root AGENTS.md; signalworks-
> design skill pass flagged in `# Blocked on User`). Live validation items listed in
> the sprint close message; assumption "ignored-videos primary action = Enrich"
> shipped as flagged.

*Recommended model/effort — Claude: Sonnet/medium workers DP-1…DP-6, orchestrator
(Fable) closes DP-7 direct; Codex: Terra/medium workers, Sol/medium orchestrator.*

## Context

Live validation passes over the Ingestion dashboard and Settings view (FEEDBACK.md)
found the intake tables an inconsistent mix of text links, muted spans, icon+label and
icon-only buttons; misaligned header controls; an X-posts section that will explode with
registry backfill; queue pills that look like filters but aren't; verbose control-center
prose; an unpinned settings tab strip; and (from the grounding audit) eight icon-language
violations plus AGENTS docs that have drifted from the one-line-hook pattern.

## Decisions locked (user, this session)

1. **Intake rows: uniform icon-only BUTTONS** (user design): read/watch = `external-link`
   icon button; meta = file-note icon (`file-text`); **Ingest renamed "Clip"** =
   `download`; **Ignore renamed "Skip"** = cancel icon (`circle-x`). Same order across
   sections: external → meta → command → skip. Every icon-only control carries
   `aria-label` + `title`.
2. **Muted, not absent, when deactivated** — a disabled action renders in muted
   text/icon color with a `title` explaining why (no body / no metadata note / no ingest
   command configured / no API key).
3. **No separate `Enriched?` column** — videos' metadata-note link folds into the meta
   button; Enrich (`sparkles`) moves into the action cell.
4. **Ignored sections get no Un-ignore control** — the only reason to un-ignore is to
   immediately Clip, so the row shows Clip, which implicitly un-ignores then runs the
   primary action.
5. Queue monitor pills become **real status filters**, restyled as a filter-control
   header for the table, placed below the enable/run/clear control bar.
6. Capture-count facet: **measurement-only this sprint** (see Plan E); no capture-count
   plumbing in crucible.
7. X posts section defaults to collapsed.

## Summary

One WP rebuilds the intake action cells around a single icon-button primitive with the
new Clip/Skip verb set and muted-disabled affordances; small WPs fix header alignment,
default-collapse, control-center prose, the queue filter bar, and the pinned settings
header; an icon-language WP resolves the audit's collisions; a docs WP activates the
quirks-index pattern across child AGENTS files; the close WP amends the two UI-standard
lines this design supersedes.

## Key Changes

**WP-DP1 — intake action language v2 (posts, videos, ignored).**
*~0.45 kSLOC · ~300k tokens · ~23 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent (70% saving); Codex: subagent (~43%)*
New unified `renderIconButton(td, icon, {ariaLabel, title, onClick, disabled})` in
`src/ingestion/render/cells.ts`; ALL row actions become icon-only buttons in the shared
`.crucible-intake-action-cell`, order external → meta → command → skip, identical in
Uncaptured posts, Uncaptured videos, Ignored posts, Ignored videos. Mapping: external =
`external-link` (button opens URL; tooltip carries destination), meta = `file-text`
(in-tool nav to the metadata/blog note), Clip = `download` (replaces Ingest
icon+label), Skip = `circle-x` warn hue (replaces eye-off Ignore; reversible-warn rule
unchanged — still NOT in `DESTRUCTIVE_ACTIONS`). Deactivated actions render muted
(`--text-faint`) + explanatory `title` instead of being absent: Clip when `!hasBody`,
no metadata note, or no configured ingest command (section-level `apiKeyAffordance`
Configure deep-link pattern stays for the settings-fix path); meta when the note doesn't
exist. Videos: drop the `Enriched?` column — meta button carries the enrichment-note
link (muted + `title` "enriching…/queued" for in-flight), Enrich `sparkles` joins the
action cell. Ignored sections: external + meta + Clip only (Clip un-ignores the ID then
runs ingest — posts — or enrich — videos); Un-ignore button and `renderUnignoreButton`
usage removed. Publish Date cells + header get a nowrap class (same td-nowrap pattern
as the action cell; never flex on a td). Update the pinned icon tests
(`tests/ingestionIntakeActionCell.test.mjs` et al.) to the new mapping; new tests:
disabled-muted states, implicit un-ignore-then-clip, Enriched-column removal. Files:
`src/ingestion/render/cells.ts`, `src/ingestion/sections/{uncapturedPosts,
uncapturedVideos,ignored}.ts`, `src/ingestion/data/ignored.ts` (row needs the
primary-action inputs), `styles.css`, tests. NOT in scope: queue monitor, ignore
storage format, other dashboards.

**WP-DP2 — section header/layout polish.**
*~0.12 kSLOC · ~120k tokens · ~9 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · after DP1 (shared styles.css)*
(a) Refresh/Auto-enqueue vertical alignment: the header flex is `align-items: baseline`
and the toggle label's first flex item is a checkbox whose baseline is its bottom edge —
fix via `align-self: center` on `.crucible-ingestion-header-toggle` (the existing
`-section-toggle` precedent) or switch the header row to center alignment with an
explicit title baseline group. (b) `xPosts` section registers `defaultCollapsed: true`.
(c) Control-center prose tightened: channel desc → "Per-status video counts per
channel." style (blog counterpart likewise); the shorter desc plus alignment fix keeps
Refresh + Enrich-all on the main header line. Files: `src/ingestionDashboard.ts`,
`src/ingestion/sections/controlCenters.ts`, `styles.css`, tests where descs are pinned.
NOT in scope: persisting collapse state, skipping compute for collapsed sections.

**WP-DP3 — queue monitor status filter bar.**
*~0.3 kSLOC · ~220k tokens · ~17 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · after DP2 (shared styles.css +
queueMonitor.ts)*
The queue-stats pill row moves below the enable/run/clear control bar and becomes the
table's filter control: clicking a status pill filters the job table to that bucket
(default view stays queued+running); selecting `done`/`failed`/`cancelled` fetches that
bucket via the queue's list-by-status API (worker verifies `listJobs(status)` coverage;
if a bucket is retention-purged, the empty state says so). Active filter shows a
selected state (`is-contrast`/`mod-cta` treatment); clicking the active pill clears the
filter. Service-health pill row is untouched. Same WP converts the queue row/section
text actions to the fleet icon language (row scope icon-only per CC-11: Run = `play`,
Cancel = danger `x`, Details = `info`; section scope icon+label) since it is rebuilding
this section anyway — `job-cancel` confirm/suppression semantics unchanged. Files:
`src/ingestion/sections/queueMonitor.ts`, `styles.css`, tests (filter state, fetch
routing, icon pins). NOT in scope: job retention changes, new queue APIs beyond
list-by-status.

**WP-DP4 — pinned settings header.**
*~0.1 kSLOC · ~100k tokens · ~8 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · after DP3 (shared styles.css)*
Wrap `.crucible-tab-nav` + `.crucible-tab-hr` in a sticky header (`position: sticky;
top: 0`, `background: var(--background-primary)`, z-index — copy the source-eval
scorecard `th` precedent), with the padding compensation for the workspace-tab host's
16px padding-top (sticky parks at the padding-box edge otherwise). Certain to work in
the workspace-tab host (`.crucible-settings-host` IS the scroller); the native settings
modal is the live-test item — ship behind the same markup and deliver a rerun packet
(exact UI steps + expected result) for the user's modal check rather than guessing at
Obsidian's `.vertical-tab-content` ancestors. Adjust the two scroll consumers: the
automate step-centering math subtracts the header height; `refreshDisplay`'s scrollTop
save/restore is re-verified. Files: `src/settings.ts`, `styles.css`,
`src/settings/sections/automate.ts`. NOT in scope: restyling the tab strip.

**WP-DP5 — icon-language consistency fixes.**
*~0.25 kSLOC · ~180k tokens · ~14 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · after DP4 (shared styles.css)*
Resolve the audit's collisions to one-concept-one-icon: Duplicate → `copy-plus`
(everywhere: triggers, agents, automate), freeing `copy` exclusively for copy-path
(SearchModal); remove-value-from-list → `x` plain icon button, `trash`(-2) reserved for
delete-the-entity (guardConditionFields et al.); TOC collapse pair aligns to
`chevron-right`/`chevron-down`; Refresh unified as `refresh-cw` (dashboard section
headers get icon+label "Refresh" at panel scope, matching source-eval's icon
treatment; orchestrationSearch settings row likewise). "Open note" stays: anchor for
inline links, `arrow-right` at row scope. Output artifact: the fleet icon-mapping
table (icon → concept) added to root AGENTS.md UI standards (final text reviewed at
DP-7). Files: `src/settings/sections/{triggers,aiAgents,aiProviders,automate,
commands,guardConditionFields,orchestrationSearch}.ts`, `src/search/SearchModal.ts`,
`src/toc.ts`, `src/ingestionDashboard.ts`, tests. NOT in scope: queueMonitor (DP3),
intake cells (DP1), settings icon-only convention change (documented as-is).

**WP-DP6 — AGENTS dox sweep: activate the quirks-index pattern (docs-only).**
*~0.3 kSLOC docs, content-preserving · ~200k tokens · ~15 min wall · mid (Claude
Sonnet/medium; Codex Terra/medium) · Claude: subagent (orchestrator reviews for zero
content loss); Codex: subagent · parallel-safe (docs only)*
(a) Add a one-line-hook Quirks index to `src/search/AGENTS.md` (20 bullets) and
`src/orchestration/AGENTS.md` (21) — same contract as root's ("where to walk, not what
to do"); give `src/providers/AGENTS.md` its three hooks as headings; split
`theme/AGENTS.md`'s single 787-word bullet into its five named rules. (b) Root
`AGENTS.md`: collapse the 276/203-word `src/search`/`src/orchestration` pointer
run-ons to single-line pointers at their child indexes; tighten the four quirk-length
UI-standards bullets into hook + short body. Rule: restructuring only — no quirk
deleted, no fact dropped; the orchestrator diffs word-level for content loss. Gates:
docs-only (file + NUL checks). Files: root `AGENTS.md`, `src/{search,orchestration,
providers}/AGENTS.md`, `theme/AGENTS.md`. NOT in scope: rewriting quirk content,
GEMINI.md, worktree copies.

**WP-DP7 — standards amendments + close (orchestrator-direct).**
*~0.05 kSLOC docs · ~30k tokens · ~5 min wall · top (orchestrator) · Claude: direct
(must-direct: integration/gates/commit duty + contract-file edits); Codex: direct
(same)*
Amend root AGENTS.md UI standards to the v2 intake language: CC-11 adaptation for
dense-table row scope (all-button icon-only cells; the external glyph stays mandatory
as the icon itself; aria+title required), replace the "stateful cells stay their own
column" exemplar with the muted-state-button rule, record the Clip/Skip verb + icon
mapping. Note for the user: the canonical N1 spec in the `signalworks-design` skill
(context-control repo) is NOT edited here — flagged in `# Blocked on User` for the
design-agent pass. Plan completion note; deregister `pending-plans`; ledger actuals per
WP.

## Public Interfaces

None (UI-only; no settings keys, commands, events, or storage changes — the queue
filter is view-state only).

## Execution

DP1 → DP2 → DP3 → DP4 → DP5 sequential (all touch `styles.css`; DP3 also shares
`queueMonitor.ts` scope); DP6 parallel-safe at any point; DP7 orchestrator-direct
close. Worker worktrees from local master tip; workers never commit; orchestrator
reviews diff, re-runs all six gates verbatim, commits `(subagent dp-N)`, ff-merges from
the main checkout. Ask the user which subagents to spawn before each dispatch.

## Test Plan / Verification

Six gates verbatim per landing (test floor **1686/133**, count only grows; DP6 is
docs-only → file/NUL checks). Live validation: intake rows read as four uniform icon
buttons in identical order with tooltips; disabled Clip is muted with an explanation;
videos table has no Enriched? column; ignored rows Clip-and-return to Uncaptured;
publish dates never wrap; Refresh/Auto-enqueue sit on one line; X posts starts
collapsed; queue pills filter the table; settings tab strip stays pinned while
scrolling (workspace tab), modal via rerun packet.

## Critical Files

`src/ingestion/render/cells.ts`, `src/ingestion/sections/{uncapturedPosts,
uncapturedVideos,ignored,queueMonitor,controlCenters}.ts`, `src/ingestionDashboard.ts`,
`src/settings.ts`, `styles.css`, root + child `AGENTS.md`, tests.

## Assumptions

- Ignored-videos' primary action is Enrich (the video analogue of Clip); flagged for
  user confirmation at DP1 review if it looks wrong live.
- The queue backend can list `done`/`failed`/`cancelled` jobs (retention permitting);
  worker verifies before wiring, degrades to an honest empty state.
- Lucide `circle-x`, `download`, `file-text`, `copy-plus`, `info`, `play` all ship with
  Obsidian's `setIcon`.
- External-link buttons open via `window.open`; losing anchor middle-click affordance
  is accepted for row scope (tooltip carries the destination).

**Total ≈ 1.6 kSLOC, ~1150k raw tokens; ~972k Claude-path / ~710k Codex-path
Opus/Sol-equivalent tokens.**

