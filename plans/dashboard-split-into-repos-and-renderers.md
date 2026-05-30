# Dashboard split into data repositories + reusable renderers

> Part 1 of 6 of the architectural cruft sweep. Independent — can run standalone.
> Behavior-preserving refactor only. No feature or settings-schema changes.
>
> **Cross-unit coupling:** this unit imports `listYoutubeIntakeRuns` / `listBlogsIntakeRuns` and the
> `YoutubeIntakeRunStat` / `BlogsIntakeRunStat` types from the intake utils. The Feed-tracker unit
> (`feed-tracker-generic-collapse.md`) collapses those utils into `feedIntake.ts` but is instructed to
> keep those export names stable, so order between the two units doesn't matter — at worst the
> Feed-tracker unit updates two import lines here.

## Context

`src/ingestionDashboard.ts` is **1369 lines** in a single `IngestionDashboardUI` class. Every
`render*` method mixes data acquisition (vault scans, orphan computation, in-flight maps,
metadata-cache reads, word-count/wpm parsing) with DOM building. ~15 sections each repeat the
same scaffold: clear body → query rows → set count/meta → empty-state check → init sort context →
`renderSortableTable<T>(...)`. `renderEnrichmentQueue` (~line 1049) bypasses `renderSortableTable`
and hand-builds a `<table>`, an inconsistency. There are 43 `createEl` calls. This is a
render-ball-of-mud with no separation between view and data.

Goal: pull data queries out of the view, lift the repeated render scaffold + table into reusable
helpers, and leave `ingestionDashboard.ts` as a thin controller well under 1000 lines.

## Verified current shape (read these before starting)

- `src/ingestionDashboard.ts` — the class. Key methods (line numbers approximate, re-read):
  - Row/view interfaces near top: `SortState` (61), `UncapturedVideoRow` (66), `YoutubeNoMetadataRow`
    (77), `UncapturedPostRow` (84), `OrphanRow` (93), `SectionContext` (101), `Column<T>` (112).
  - Section renderers: `renderOrchestrationQueue` (492), `renderSection` (552),
    `renderUnprocessedClippings` (570), `renderUnrefinedTranscripts` (603), `renderBlogIntake` (676),
    `renderYoutubeIntake` (699), `renderUncapturedPosts` (721), `renderUncapturedVideos` (760),
    `renderYoutubeNoMetadata` (838), `renderOrphanedAttachments` (949), `renderEnrichmentQueue` (1049).
  - Shared view helper: `renderSortableTable` (~1087).
  - Button/cell helpers: `renderEnqueueIntakeButton`, `renderEnqueueMetadataCell`,
    `renderEnqueueAllMetadataButton`, `renderDeleteButton`, `renderCleanupAllButton`, `renderFileLink`.
- `src/ingestionDashboardView.ts` (37 lines) — the Obsidian `ItemView` wrapper; leave it.
- Reuse existing intake-run queries: `listYoutubeIntakeRuns` / `listBlogsIntakeRuns` from
  `src/orchestration/utils/youtubeIntake.ts` / `blogsIntake.ts` for the intake sections (do not
  re-derive them here).

## Target structure

```
src/ingestion/
  data/                       # pure queries, NO DOM, signature (app, settings, ...) => Row[]
    orphanedAttachments.ts    # orphan computation -> OrphanRow[]
    uncaptured.ts             # UncapturedVideoRow[], UncapturedPostRow[], YoutubeNoMetadataRow[]
    transcripts.ts            # unrefined-transcript folder walk + wpm/word-count parsing
    clippings.ts              # unprocessed clippings rows
  render/                     # DOM only, NO vault access
    sortableTable.ts          # renderSortableTable<T>, Column<T>, SortState
    section.ts                # the repeated header/refresh/empty-state scaffold (one helper)
    types.ts                  # SectionContext + row interfaces shared by data + render
src/ingestionDashboard.ts     # thin controller: per section -> call a data fn then a render helper
```

## Steps

1. Move the row interfaces + `SortState`, `SectionContext`, `Column<T>` into `src/ingestion/render/types.ts`
   (and re-export from `sortableTable.ts` if convenient). Update imports.
2. For each section, extract its data-gathering body into a pure function under `src/ingestion/data/`.
   Keep them DOM-free — they return typed row arrays. Move the transcript folder walk + wpm/word-count
   logic and the orphan computation here.
3. Lift `renderSortableTable` + `Column<T>` into `src/ingestion/render/sortableTable.ts`.
4. Extract the repeated section scaffold (clear body → set count/meta → empty-state → sort init → table)
   into one helper in `src/ingestion/render/section.ts`. Replace all ~15 inline scaffolds with it.
5. Rewrite `renderEnrichmentQueue` to build rows + call `renderSortableTable` like every other section;
   delete the hand-rolled `<table>` block.
6. Reduce `ingestionDashboard.ts` to lifecycle + listeners + per-section `data → render` wiring. Confirm
   it is well under 1000 lines and each new file is small and single-purpose.

## Guardrails

- No file over 1000 lines after this unit.
- Pure data functions contain zero `createEl`; render helpers contain zero vault access.
- Reuse `listYoutubeIntakeRuns`/`listBlogsIntakeRuns` — do not fork new intake-run scanners.

## Verification

- `npm run build` (tsc -noEmit + esbuild) clean; `npm run lint` clean.
- In a real vault (use the `run`/`verify` skill): open the Ingestion Dashboard view and confirm every
  section renders, sorts by each sortable column, refreshes, and that enqueue / delete / cleanup buttons
  still work. Confirm the enrichment queue still live-updates as jobs drain.
