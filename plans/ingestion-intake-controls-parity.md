# Ingestion intake controls: icon-driven actions, warning-tier Ignore, Ignored-section parity

*Recommended model/effort — Claude: Sonnet/medium workers for IC1–IC2, orchestrator
(Fable) closes IC3 direct; Codex: Terra/medium workers, Sol/medium orchestrator.*

## Context

Live-validation feedback (FEEDBACK.md, confirmed never in any committed plan): the
Uncaptured posts row renders `read | metadata | Ingest | Ignore` as two bare text
anchors + two unclassed `<button>`s across two columns with no gap class, no icons, no
danger/warning treatment on Ignore. Uncaptured videos has the same shape (`watch`,
`Ignore`, `Enrich`). And the Ignored posts/videos sections are a "black hole": bare
IDs/URLs (`renderIgnoredIdCell`) instead of the readable rows the Uncaptured tables
show — because `computeUncaptured*Rows` folds ignored IDs into the *seen set*, ignored
items are excluded from tracker-scan outcomes at the source and their metadata never
reaches the ignored sections.

## Decisions locked (user, 2026-07-31)

1. Icon-driven controls preferred for row actions.
2. **Reversible actions (Ignore/Un-ignore) carry warning-level color, not
   error-danger red** — `mod-warning` stays reserved for destructive controls
   (Cancel/Delete). Warn hue = `var(--text-warning)` (matches `.crucible-pill.is-warn`).
3. Uncaptured **videos** gets the same control update as posts.
4. Ignored videos/posts get **row parity** with the Uncaptured variants.
5. Ignore/Un-ignore stay OUT of `DESTRUCTIVE_ACTIONS` (reversible pair — the deliberate
   exclusion documented in root AGENTS.md stands; this is styling, not confirmation).

## Summary

One shared intake action-cell pattern (per the queue-monitor exemplar + N1 CC-11 action
language): external links keep their label and gain the trailing `external-link` glyph
(CC-11: never icon-only for external destinations); Ingest/Enrich become icon+label
buttons; Ignore/Un-ignore become warning-tier icon buttons (`eye-off`/`eye`) with
tooltip + aria-label. New data computations give the Ignored sections the same readable
columns as their Uncaptured counterparts, degrading to bare-ID rows for items that have
aged out of tracker data.

## Key Changes

**WP-IC1 — shared action-cell pattern + Uncaptured posts/videos conversion.**
*~0.25 kSLOC · ~200k tokens · ~15 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent (~70% saving); Codex: subagent (~50%)*
New `.crucible-intake-action-cell` (nowrap + uniform gap, modeled on
`.crucible-queue-action-cell`, `styles.css:661`) hosting all row actions in ONE column
per section (posts: merge the `action` + `ignore` columns; videos: merge `watch` +
`ignore`; the stateful `Enriched?` column stays separate). New/changed cell helpers in
`src/ingestion/render/cells.ts`: `renderExternalLink` gains the trailing 12px
`external-link` glyph via `setIcon` (label kept, `currentColor`); new
`renderIconLabelButton` (glyph + label, for Ingest `import` / Enrich `sparkles`); new
warning-tier icon-button treatment for `renderIgnoreButton`/`renderUnignoreButton`
(`eye-off`/`eye`, icon-only + `aria-label` + `title`, `color: var(--text-warning)` via
a `.crucible-intake-warn-btn` class — Obsidian semantic vars only, never `--n1-*`).
Fleet icon mapping stays one-concept-one-icon. Behavior (click handlers, echo
suppression, disable-on-click) unchanged. Files: `src/ingestion/sections/uncapturedPosts.ts`,
`src/ingestion/sections/uncapturedVideos.ts`, `src/ingestion/render/cells.ts`,
`styles.css`, tests (structural: warn class + single action column; no `mod-warning`
on ignore). NOT in scope: ignored sections (IC2), queue monitor, confirmations.

**WP-IC2 — Ignored posts/videos row parity.**
*~0.3 kSLOC · ~220k tokens · ~17 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · sequential after IC1 (shared
cells.ts/styles.css)*
New `computeIgnoredPostRows`/`computeIgnoredVideoRows` (new `src/ingestion/data/ignored.ts`,
reusing `feedIntake` scan helpers): build the seen set **without** folding ignored IDs
in, scan tracker runs, keep only outcomes whose ID is in the ignored set, join the same
metadata (posts: blog-metadata note fields via `buildBlogMetadataNoteIndex`; videos:
channel/about + enrichment note) — **degrade to a bare-ID row** when the item no longer
appears in tracker data (aged out), so no ignored entry is ever dropped from the table.
`src/ingestion/sections/ignored.ts` renders the same columns as the Uncaptured
variants (minus Ingest/Enrich) + the readable title/author/date + warning-tier
Un-ignore icon button in the shared action cell. Keep compute-then-paint, signature
skip, `rowKey: id`, section counts. Perf note: these sections now run tracker scans —
same cost class as the Uncaptured sections, already inside the dirty-set flush
machinery. Tests: partition correctness (ignored ∩ tracker), degrade path, and that
Uncaptured outputs are byte-identical to today (the seen-set change must not leak into
`computeUncaptured*Rows`). Files: `src/ingestion/data/ignored.ts` (new),
`src/ingestion/sections/ignored.ts`, `src/ingestion/render/cells.ts` (Un-ignore),
tests. NOT in scope: changing ignore storage format.

**WP-IC3 — docs close (orchestrator-direct).**
*~0.05 kSLOC docs · ~30k tokens · ~5 min wall · top (orchestrator) · Claude: direct
(must-direct: integration/gates/commit duty); Codex: direct (same)*
Root `CLAUDE.md`/`AGENTS.md` UI standards: the intake action-cell pattern + the
warning-tier-vs-mod-warning distinction (reversible = warn hue, destructive = red).
Plan completion note; deregister `pending-plans`; ledger actuals.

## Public Interfaces

None (UI-only; no settings, commands, events, or storage changes).

## Execution

IC1 → IC2 sequential (shared `cells.ts`/`styles.css`), IC3 orchestrator-direct. Worker
worktrees from local master tip; workers never commit; orchestrator reviews diff,
re-runs all six gates verbatim, commits `(subagent ic-N)`, ff-merges from the main
checkout. Ask the user which subagents to spawn before each dispatch.

## Test Plan / Verification

Six gates verbatim per landing (test floor **1638/128**, count only grows). Live
validation: posts/videos rows read as one compact action cell; Ignore/Un-ignore render
warning-hued icons with tooltips; Ignored sections show titles/authors/dates with
bare-ID fallback rows; Un-ignore returns the item to Uncaptured with full data.

## Critical Files

`src/ingestion/render/cells.ts`, `src/ingestion/sections/{uncapturedPosts,uncapturedVideos,ignored}.ts`,
`src/ingestion/data/{uncaptured.ts (reference), ignored.ts (new)}`, `styles.css`, tests.

## Assumptions

- Tracker-run data for ignored items is usually still present (retention permitting);
  the bare-ID degrade covers the rest.
- Lucide names `import`/`sparkles`/`eye-off`/`eye`/`external-link` are available via
  Obsidian's bundled `setIcon` (all standard lucide).

**Total ≈ 0.6 kSLOC, ~450k raw tokens; ~310k Claude-path / ~245k Codex-path
Opus/Sol-equivalent tokens.**
