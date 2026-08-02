# Plan F — UI polish, audit/reconcile honesty, resolver promotion, root-dox slimming

> **STATUS: COMPLETE (2026-08-01).** Plan registered at `7cef197`. F1 landed on crucible
> master (`0713b13`): shared `.crucible-icon-label-btn` gap primitive, `align-self: center`
> on heading buttons, and the measure-at-mount sticky header (`applyStickyHeaderPadding`
> mirrors the real scroll parent's computed padding onto CSS custom props — one mechanism
> for workspace tab and native modal; rerun packet in `runs/dispatch/wp-f1-report.md`).
> F2 landed in eval-harness (`36c406c`): `local-inference-bench/lib/link-graph.mjs`
> promoted with the `/\.[^./\s]+$/` fix at both resolveLinkpath sites, 6-test suite,
> erratum in `rrlb-arm-2026-08-01/run.md` + validity-memo item 8; archives byte-identical.
> F3 landed (`4ad7464`): audit report gains a per-class `## Repair` section naming exact
> commands, reconcile's early-return gate fixed to `isReconcileTargetClean` (the actual
> source of the "enqueued 0 upserts and 0 deletes" absurdity), honest new-vs-deduped
> Notices, Queue Monitor `Index:`/`De-index:` titles, and the Companion-status pending-jobs
> line. F4 landed (`af3239e`): root AGENTS.md 9,308 → 4,104 words — 26 quirk bodies
> relocated verbatim to `src/`, `src/ingestion/`, `src/settings/` (new, with CLAUDE.md
> symlinks), orchestration, and providers children; zero content loss, line-level
> verified. Test floor 1767/139. Live validation items handed to the user at close
> (F1 tab+modal rerun packet, F3 audit/reconcile/queue-title checks).

Repo of record: **obsidian-crucible** · slug `ui-polish-audit-ux-dox-slim` · WP-F2 lands in
**eval-harness** per its conventions. Months-facet boost explicitly deferred (user choice).

*Recommended model/effort — Claude: Sonnet/medium workers F1–F4, orchestrator (Fable)
closes F5 direct; Codex: Terra/medium workers, Sol/medium orchestrator.*

## Context

Post-sprint live validation (user FEEDBACK) surfaced: a missing gap in the new icon+label
Refresh buttons; section-header buttons vertically misaligned; the DP4 pinned settings
header leaving a transparent band (tab view ~12–15px above the strip, native modal a
tab-strip-sized band); the search audit reporting state with no repair guidance; reconcile
claiming "enqueued" work invisible in the Queue Monitor; root AGENTS.md at ~24.8k tokens
loading into every session; and a known `resolveLinkpath` defect in the eval-harness
measurement lineage. Four investigation agents grounded every item this session.

## Decisions locked (user, this session)

1. Investigate all fronts upfront, then ONE plan for all accepted work (this document).
2. Accepted: UI polish, eval-harness resolver fix, audit/repair honesty, root AGENTS.md
   slimming. Deferred: months-facet boost.
3. User supplied live DevTools numbers for the workspace tab: the scroller
   (`.view-content.crucible-settings-host`) computes **padding 12px 12px 32px 12px** —
   the theme overrides our assumed 16/24px, so compensation must be measured, not
   hardcoded. Modal shows the same class of gap, larger.

## Summary

Four dispatched WPs: (F1) fix the three UI chrome defects, replacing DP4's hardcoded
padding compensation with measure-at-mount CSS custom properties so tab view and native
modal share one mechanism; (F2) promote the fixed `link-graph.mjs` into a shared
`local-inference-bench/lib/` with a regression test and erratum, archives untouched;
(F3) make audit name the exact repair command per discrepancy class and make reconcile's
Notice honest about counts, destinations, and the classes it does NOT repair, plus give
the two search job types real titles in the Queue Monitor; (F4) relocate ~5k words of
root AGENTS.md quirk bodies to nearest-child AGENTS files (three new children), cutting
root to ~9.6k tokens with zero content loss. Orchestrator closes (F5).

## Key Changes

**WP-F1 — settings/dashboard chrome fixes (icon-label gap, heading alignment, adaptive sticky header).**
*~0.17 kSLOC · ~180k tokens · ~14 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent (~70% saving); Codex: subagent (~50%)*
(a) New shared `.crucible-icon-label-btn { display:inline-flex; align-items:center;
gap:0.35rem }` in styles.css; apply to `src/ingestionDashboard.ts:488` (Refresh),
`src/settings/sections/orchestrationSearch.ts` `setLabel` (`addClass` once — `empty()`
clears children, not classes), and `src/sourceEvalDashboard.ts:113` (Export JSONL, same
latent bug); drop the leading-space span texts (flex trims them — that's the root cause;
precedents: `.crucible-tab-btn svg margin-right:6px` styles.css:81,
`.crucible-ingestion-queue-toggle gap` :896). Do NOT apply the class to
`.crucible-intake-icon-btn` or queue pill buttons (own box models). (b) Add
`align-self: center` to the five-button heading rule styles.css:658-664 — svg-first
buttons lose their text baseline under the heading's `align-items: baseline`; chevron
(:614) and header toggle (:963) are already centered. (c) Sticky header: replace the
hardcoded `margin:-16px -24px 0; padding:16px 24px 0` with **measure-at-mount** — in
`src/settings.ts` `display()`, find the actual scroll parent (walk `overflowY`
auto|scroll), read its computed padding, set custom props on the wrapper
(`--crucible-sticky-pad-top/right/left`), CSS becomes
`margin: calc(var(--crucible-sticky-pad-top,16px) * -1) …; padding: var(…) var(…) 20px`;
zero `.crucible-tab-hr`'s `margin-bottom` inside the wrapper (scoped, `!important` to
match :86) so the 20px band below the rule is painted (margin-collapse fix — the gap
below). Grounded: live tab-view numbers show scroller padding 12/12/32/12, NOT 16/24;
one mechanism then covers the native modal's `.vertical-tab-content` automatically. Do
NOT use the `padding-bottom + negative bottom margin` variant (z-index paints over
content at scroll-top). The automate step-centering math live-measures `offsetHeight` —
absorbs the change, no edit. Structural pins (`tests/settingsStickyHeaderGuard.test.mjs`
whitespace-exact two-line createDiv sequence + hr-in-wrapper; automate guard forbids
hardcoded px) must stay green — add lines, don't reformat. Deliverable includes a rerun
packet: tab view + native modal steps, plus a modal-scoped DevTools snippet
(`document.querySelectorAll('.crucible-settings-sticky-header')` → pick the `.modal`
descendant) since the user's first modal probe grabbed the tab instance. Files:
`styles.css`, `src/settings.ts`, `src/ingestionDashboard.ts`,
`src/settings/sections/orchestrationSearch.ts`, `src/sourceEvalDashboard.ts`, tests
(structural pin for the measure-at-mount call). NOT in scope: `.crucible-tab-btn`
gap refactor, tab-strip restyling.

**WP-F2 — eval-harness: promote link-graph.mjs to lib/ with the whitespace-extension fix.**
*~0.4 kSLOC (mostly promoted copy) · ~130k tokens · ~10 min wall · mid (Claude
Sonnet/medium; Codex Terra/medium) · Claude: subagent; Codex: subagent · parallel-safe
(different repo)*
New `local-inference-bench/lib/link-graph.mjs`: promoted copy of
`measurements/rrlb-arm-2026-08-01/link-graph.mjs` with `/\.[^./\s]+$/` at BOTH sites
(`hasExt` test :88 AND the fallback strip :91 — months.mjs's `resolveLinkpathObs` models
both), `buildPathIndex` additionally exported (kills future private copies).
`buildPathIndex`'s own unbounded regex for index keys is NOT changed (behavior change to
`buildVaultLinkGraph`); pin current key behavior in the test with a comment. New
`lib/link-graph.test.mjs` (node:test, zero deps, tmpdir vault à la
`boost-parity.test.mjs`): canonical victim title ("…attacker. What this means…")
resolves; real extensions still take the with-ext branch; dotted-spaceless title
behavior pinned as-is. `lib/README.md`: shared lineage code, mutable-with-gates, unlike
frozen `measurements/*`. Archives byte-untouched EXCEPT: `## Erratum (2026-08-01)`
section in `rrlb-arm-2026-08-01/run.md` between `## Deviations` (:183) and `## Gate
tails` (:205) — blast radius = the 7.2%/14.1% unresolved counts, pf-linked-post edge
unaffected (:200-203) — plus a superseded-by pointer on the Files bullet (:251) and one
line in `local-inference-bench/validity-memo.md`. Gates: `node --test
lib/link-graph.test.mjs` + re-run `boost-parity.test.mjs` (11/11 — proves the archive
undisturbed) + file/NUL per touched file. Files: new `lib/` trio, two run.md/memo
edits. NOT in scope: editing archived .mjs files, re-running measurements, crucible.

**WP-F3 — search audit/reconcile honesty + repair guidance.**
*~0.3 kSLOC · ~200k tokens · ~15 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · after F1 (shared
orchestrationSearch.ts)*
Constraints from `src/search/AGENTS.md:97` (hard): audit stays read-only; reconcile
mutates ONLY via existing `search_upsert_file`/`search_delete_path`; no new job type.
(a) `formatAuditReport` (`src/search/audit.ts:131-149`, pure, test-pinned) + the audit
Notice (`src/commands.ts:622-626`): per non-zero class, name the exact repair command —
missing/stale → "Search: reconcile index"; orphans → same (also fixes the stale advice
at `src/search/AGENTS.md:68` still routing exclusion leftovers to a full rebuild);
embeddingGaps → "Search: embed missing vectors"; imageCoverage.pending → "Search:
describe vault images"; .failed → "Search: retry failed image descriptions". (b)
Reconcile Notice (`src/commands.ts:672`): report NEW vs deduped counts (enqueue returns
the existing job on dedupe hit — count them separately), say where the work went
("Queue Monitor — most settle in seconds; see the done filter"), and name the classes
it did NOT touch when they're non-zero (embedding gaps / images) instead of the current
"enqueued 0 upserts and 0 deletes" absurdity. (c) `jobTitle`
(`src/ingestion/sections/queueMonitor.ts:205-223`): add cases for `search_upsert_file`
("Index: <basename>") and `search_delete_path` ("De-index: <basename>"); Target cell
falls back to the payload path when the file no longer resolves (deleted paths
currently print raw job ids). (d) Companion status panel
(`src/settings/sections/orchestrationSearch.ts:105-140`): one pending-count line via
`Orchestrator.countJobs(type, ['queued','running'])` for the two types, refreshed with
the existing Refresh button. Tests: extend `tests/searchAudit.test.mjs` (report names
commands per class), jobTitle cases, Notice-text pins where cheap. Files:
`src/search/audit.ts`, `src/commands.ts`, `src/ingestion/sections/queueMonitor.ts`,
`src/settings/sections/orchestrationSearch.ts`, `src/search/AGENTS.md` (:68 advice
line only), tests. NOT in scope: completion tracking/progress events, new job types,
auto-refreshing `_crucible/search-audit.md` after reconcile (needs completion hooks —
documented as the known limitation in the report note's remediation text instead).

**WP-F4 — root AGENTS.md slimming: relocate quirk bodies to nearest children (docs).**
*~0.6 kSLOC docs, content-preserving moves · ~260k tokens · ~20 min wall · mid (Claude
Sonnet/medium; Codex Terra/medium) · Claude: subagent (orchestrator word-level-diffs
for zero content loss); Codex: subagent · after F3 (F3 edits src/search/AGENTS.md;
avoid churn)*
Per the relocation inventory (this session): move 24 of 29 root quirk bodies —
15 → NEW `src/AGENTS.md` (flat root-level modules: lint/localize/chains/renames/
dataview/agents, 2,568 words), 3 → NEW `src/ingestion/AGENTS.md` (derived-ID keys,
orphaned attachments, render pipeline; 734 w), 2 → NEW `src/settings/AGENTS.md`
(destructive-actions framework, renderer split; 419 w), 4 → existing
`src/orchestration/AGENTS.md` (note-lock family, edit-trigger gating; 755 w), 2 →
existing `src/providers/AGENTS.md` (max_tokens, providerModelContract; 462 w). Root
KEEPS five cross-cutting quirks: NUL/console gate block, frontmatter write barrier,
create-replay, skills location, eval-harness artifact policy. Second lever INCLUDED:
the settings-chrome half of UI & UX Standards (Grouped Cards, Inset Dividers, Widths,
Centering, Tabs, Fuzzy Search, List+edit — ~450 w) → `src/settings/AGENTS.md`; the
icon-mapping table, pill taxonomy, and destructive/reversible law STAY root (fleet
design law). Mechanics: bodies move VERBATIM (zero content loss — orchestrator diffs
word-level); root's Quirks index compacts the 26 "in this file" hooks into grouped
child pointers matching the DP6 style; each new child gets its own Quirks index +
`CLAUDE.md → AGENTS.md` symlink (required or sessions won't load it); root's area
table gains three rows and lines 15-17 ("everything cross-cutting stays in this file")
are rewritten — they'd contradict the move; re-point the ~6 test/script comments citing
"root AGENTS.md" for moved quirks (`tests/xDiscoverPostLinksRegistration.test.mjs:9`,
`tests/orphanedAttachments.test.mjs:4`, `tests/providerModelProbe.test.mjs:98`,
`scripts/embedding-agreement.mjs:7`, `scripts/embedding-quality.mjs:6` + sweep).
Projected root: 9,308 → ~3,600 words (~24.8k → ~9.6k tokens, −61%). Gates: comment
edits touch tests/scripts → run the FULL six-gate loop, not the docs carve-out. Files:
root `AGENTS.md`, 3 new + 2 existing child AGENTS.md, 3 symlinks, ~6 comment
re-points. NOT in scope: rewriting any quirk's content, moving source files,
GEMINI.md, adding a size CI gate (note as candidate follow-up).

**WP-F5 — close (orchestrator-direct).**
*~0.05 kSLOC docs · ~30k tokens · ~5 min wall · top (orchestrator) · Claude: direct
(must-direct: integration/gates/commit duty); Codex: direct (same)*
Plan completion blockquote; deregister from `pending-plans`; ledger actuals per WP;
surface the F1 rerun packet (tab + modal) in the close message.

## Public Interfaces

None. No settings keys, commands, job types, or storage changes — Notice/report text,
CSS custom properties (self-set at mount), queue row titles, and docs moves only.

## Execution

F1 → F3 sequential (both touch `orchestrationSearch.ts`); F4 after F3 (both touch
`src/search/AGENTS.md`); F2 parallel-safe at any point (different repo). Worker
worktrees branch from local master tip; workers never commit; orchestrator reviews
diff, re-runs all gates verbatim, commits `(subagent f-N)`, ff-merges. Ask the user
which subagents to spawn before each dispatch. On approval: plan doc written to
`obsidian-crucible/plans/ui-polish-audit-ux-dox-slim.md` + registered in
`INITIATIVE.md` `pending-plans` (docs-only commit) before any source edit.

## Test Plan / Verification

Crucible six gates verbatim per landing (test floor **1747/138**, count only grows).
eval-harness: the two `node --test` runs + file/NUL. Live validation: Refresh buttons
show a real gap and align with text-only neighbors and the Auto-enqueue toggle; the
settings tab strip pins with NO transparent band above or below in the workspace tab;
native modal re-checked via the rerun packet (measure-at-mount should cover it — the
scoped snippet verifies); audit Notice/report name a repair command per dirty class;
reconcile Notice reports new/deduped counts and untouched classes; queue rows for
search jobs show honest titles; root AGENTS.md ≈ ⅓ size with every quirk reachable
via its child index.

## Critical Files

crucible: `styles.css`, `src/settings.ts`, `src/search/audit.ts`, `src/commands.ts`,
`src/ingestion/sections/queueMonitor.ts`, `src/settings/sections/orchestrationSearch.ts`,
root + child `AGENTS.md`. eval-harness: `local-inference-bench/lib/*` (new),
`measurements/rrlb-arm-2026-08-01/run.md`, `validity-memo.md`.

## Assumptions

- Measure-at-mount reads the modal's `.vertical-tab-content` padding correctly at
  display() time (it's the scroll parent there); the rerun packet is the check, and a
  fallback default of 16px/24px keeps today's behavior where measurement fails.
- `Orchestrator.countJobs` is cheap enough to call on panel render (it's a COUNT query
  on jobs.sqlite; the panel renders on demand only).
- Moving quirk bodies does not change their authority: fleet Rule 0 (nearest child
  wins) already governs; root hooks keep discovery intact.

**Total ≈ 1.5 kSLOC, ~800k raw tokens; ~560k Claude-path / ~435k Codex-path
Opus/Sol-equivalent tokens.**
