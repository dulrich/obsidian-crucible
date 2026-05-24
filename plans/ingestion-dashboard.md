# Ingestion Dashboard

## Context

The plugin already tracks ingestion across several pipelines (Web Clipper output, transcripts, blog tracker, YouTube tracker, YouTube metadata enrichment) but each surface lives in a separate consolidation file or DataviewJS block. There is no single live view that answers "what's queued, what's stale, what still needs attention?" — and there is no way to drive YouTube metadata enrichment incrementally from the consolidation output.

This change adds a dedicated Obsidian tab — the **Ingestion Dashboard** — that surfaces all of these as live, sortable, dataview-style tables, plus an opt-in enrichment queue that drains uncaptured videos through the YouTube Data API at a configurable rate. The dashboard subscribes to vault and orchestrator events so it stays current while open.

## High-level shape

- One new `ItemView` (`IngestionDashboardView`) registered like `CrucibleSettingsView` in `src/main.ts:84`.
- A single command (`open-ingestion-dashboard`) in the `'Other'` group, registered via `registerCrucibleCommand` (per `AGENTS.md:125`).
- View renders a stack of collapsible "section cards" — one per table — using native DOM (`createEl`) and the existing `.crucible-settings-group` / `.pi-width-*` styles. No Dataview API dependency.
- A small typed event emitter (`src/orchestration/events.ts`) plus Obsidian-native listeners drive incremental refresh while the view is visible.
- The enrichment queue is owned by a singleton service so it survives the view being closed/reopened.

## Sections (in order)

1. **Unprocessed Clippings** — files directly under the configured Clipper inbox folder. Columns: Title (file link), Captured (mtime), Size (KB), [open]. Sort default: oldest first.
2. **Unrefined Transcripts** — mirrors the user's current DataviewJS exactly: scope to `dailyFolder` (default `daily/day`), require `#transcript`, exclude `#refined`, sort by `created`/`ctime` ascending. Columns: Title, Tags (minus `clippings`/`using`), Words (`word-count` fm), Est. Read (`words / reading_wpm`), Created, Read? (`read` fm checkmark).
3. **Blog Intake** — one row per intake note under `_crucible/orchestration/blogs/new-posts/` whose `generated_by` is `orchestrator/blogs_tracker`. Columns: Run At, Blogs Total, Blogs With New, Posts Total, Blogs Failed, Rows Skipped, [open intake].
4. **YouTube Intake** — same shape for `_crucible/orchestration/youtube/new-videos/` with `orchestrator/youtube_tracker`. Columns: Run At, Channels Total, Channels With New, Videos Total, Channels Failed, [open intake].
5. **Uncaptured Posts** — replicates `BlogsTrackerConsolidateWorkflow` output live. Columns: Author/Blog, Title, Publish Date, [read](url). Sortable by any column.
6. **Video Enrichment Queue** — control panel + live queue list. Auto-enrich toggle (`Auto enrich metadata based on "Uncaptured Videos" sorting`) plus rate-limit number input (default 2 seconds). Queue rows: Title, Channel, Status (pending/running/done/failed), [cancel].
7. **Uncaptured Videos** — replicates `YoutubeTrackerConsolidateWorkflow` output live. Columns: Creator (link to channel), Title, Publish Date, Duration (from enriched metadata if available, else blank), [watch](url), Enriched? — renders as `[[metadata-note]]` wikilink when `_yt_metadata/<channel>/<videoId>.md` exists, `queued` when in queue, or an **Enrich** button otherwise. Sortable.

## Files to create

- `src/ingestionDashboardView.ts` — `ItemView` subclass. Mirror `src/settingsView.ts` exactly: `getViewType`, `getDisplayText`, `getIcon`, `onOpen` (instantiate UI, register listeners), `onClose` (unsubscribe, dispose). Export `INGESTION_DASHBOARD_VIEW_TYPE = 'crucible-ingestion-dashboard'`.
- `src/ingestionDashboard.ts` — `IngestionDashboardUI` class. Owns the rendered DOM, per-section state (sort column/direction, expanded/collapsed), and a debounced `refresh(section?)` that re-reads only the affected section's data. Renders sortable tables via DOM helpers.
- `src/orchestration/events.ts` — tiny typed bus. Events: `clipping-captured`, `transcript-refined`, `tracker-run` (`{kind: 'blog'|'youtube', runFile}`), `metadata-enriched` (`{videoId, file}`), `enrichment-queue-updated`. Exports a single shared instance attached to the plugin (`plugin.ingestionEvents`).
- `src/orchestration/EnrichmentQueueService.ts` — singleton owning queue state, draining loop, and rate limiting (reuses `rateLimitedAllSettled` from `src/orchestration/utils/rateLimit.ts`). Exposes `enqueue(videoId)`, `dequeue(videoId)`, `getState()`, plus `setAutoDrainFromUncaptured(getUncapturedFn)` so the dashboard can hand it the current sorted uncaptured list. Emits `metadata-enriched` and `enrichment-queue-updated` after each item.

## Files to modify

- `src/main.ts`
  - Register the new view alongside `CRUCIBLE_SETTINGS_VIEW_TYPE` (line 84).
  - Add `activateIngestionDashboardView()` mirroring `activateSettingsView()` (around lines 1000-1007).
  - Register `open-ingestion-dashboard` via `registerCrucibleCommand` in a new `'Ingestion'` group (extend `CrucibleCommandGroup` union near line 28).
  - Instantiate `plugin.ingestionEvents` and `plugin.enrichmentQueue` in `onload`; dispose in `onunload`.
  - Wire workflow finish hooks to emit `tracker-run` and `metadata-enriched` (BlogsTrackerWorkflow, YoutubeTrackerWorkflow, the YouTube metadata fetch command).
- `src/types.ts` — extend `CrucibleSettings` and `DEFAULT_SETTINGS` (line 321) with:
  - `ingestionClipperInboxFolder: string` (default `_clippings/inbox`)
  - `ingestionYoutubeEnrichRateLimitSeconds: number` (default `2`)
  - `ingestionYoutubeAutoEnrichEnabled: boolean` (default `false`)
  - `ingestionReadingWpm: number` (default `250`) — used by Unrefined Transcripts est-read column; matches the user's `_custom/Settings.reading_wpm` semantics without forcing a vault-file dependency.
- `src/settings.ts` — add an **Ingestion** subsection (or extend an existing group) exposing the four new settings. Follow the existing `Setting` builder pattern.
- `src/orchestration/workflows/BlogsTrackerConsolidateWorkflow.ts` and `.../YoutubeTrackerConsolidateWorkflow.ts` — **refactor only**: extract `buildSeenIdSet`, `scanRegularTrackerRuns`, `parseIntakeVideos`/`parseIntakePosts` into exported pure functions that take `(app, settings)` and return data. Workflows then become thin wrappers that also write the markdown consolidation note. The dashboard imports the pure functions directly. No behavioral change for the existing workflows.
- `src/orchestration/utils/youtubeApi.ts` — export a helper `findEnrichmentNote(app, settings, videoId)` that returns the `TFile | null` at `_yt_metadata/<channel-slug>/<videoId>.md` so the Uncaptured Videos table can render `[[metadata]]` vs the Enrich button. (Channel-slug resolution already exists in this file; expose it.)

## Reused utilities (do not re-implement)

- `parseChannelsTable` / `parseBlogsTable` — registry parsing.
- `postIdFromUrl` (`src/orchestration/utils/blogs.ts:186`) and `extractVideoIdFromUrl` (`src/orchestration/utils/youtube.ts:27`) for ID canonicalization in sort/equality.
- `rateLimitedAllSettled` (`src/orchestration/utils/rateLimit.ts`) for the enrichment drain loop.
- `fetchYoutubeVideoMetadata` + `buildMetadataNoteBody` from `src/orchestration/utils/youtubeApi.ts` for enrichment work.
- `app.metadataCache.getFileCache(file)?.frontmatter` reads everywhere — never re-parse files.
- `getFrontmatterTags`, `parseTagList`, `updateFrontmatter` from `src/frontmatter.ts` for tag/frontmatter checks.

## Live updates

The view registers all of these on `onOpen` and removes them on `onClose`:

- `app.metadataCache.on('changed', file => debouncedRefreshForPath(file.path))` — routes to the affected sections based on path prefix.
- `app.vault.on('create' | 'delete' | 'rename', ...)` — same router.
- `plugin.ingestionEvents.on(...)` for `tracker-run`, `metadata-enriched`, `enrichment-queue-updated`.

Refreshes are debounced (~150ms) per section, never global. While the view is hidden/closed nothing is subscribed.

## Quirks to honor (per `AGENTS.md`)

- Use `registerCrucibleCommand`, not `addCommand`, so the new command is toggleable.
- `yt-video-id` and `post-id` lookups are taken from **frontmatter only** (see existing convention enforced in `src/lint.ts:21-40`); never scan note bodies.
- Update the `## Quirks` section of `AGENTS.md` with: (a) the new event bus is the source of truth for "ingestion happened" — workflows must emit on finish, (b) Uncaptured tables and the enrichment service consume *exported pure functions* from the consolidation workflows; keep them in sync if the consolidation algorithm changes.
- Copy this plan file to `<repo>/plans/ingestion-dashboard.md` before starting implementation.

## Verification

1. **Build & open**: `npm run build` → reload Obsidian → run command `Crucible: Open ingestion dashboard` → dashboard opens in a new tab and renders all seven sections without errors.
2. **Unprocessed Clippings**: drop a markdown file into the configured inbox folder → row appears within ~150ms without manual refresh.
3. **Unrefined Transcripts**: take a note in `daily/day/` tagged `#transcript`, confirm it appears; add `#refined` → row disappears on next metadata-cache tick. Numbers match the existing DataviewJS block for the same scope.
4. **Tracker intake sections**: run `orchestrator/blogs_tracker` and `orchestrator/youtube_tracker` jobs → a new row appears in the matching Intake section with the right counts; `tracker-run` event fires.
5. **Uncaptured Posts / Videos**: counts and rows match the output of `BlogsTrackerConsolidateWorkflow` / `YoutubeTrackerConsolidateWorkflow` for the same vault state (run the workflow, diff the resulting consolidation note against the dashboard list).
6. **Enrichment queue (manual)**: click **Enrich** on an uncaptured video → row flips to `queued`, then the metadata note is created at `_yt_metadata/<channel-slug>/<videoId>.md`, then the cell flips to `[[metadata]]`. Re-clicking is a no-op.
7. **Enrichment queue (auto)**: toggle auto-enrich → queue drains the Uncaptured Videos list in current sort order, respecting the rate limit (verify minimum 2s gap between requests via timestamps in the metadata notes or logs).
8. **Sort persistence**: change sort column on Uncaptured Posts; close and reopen the view; sort state restored (per-view, not persisted across plugin reloads — kept in `IngestionDashboardUI` instance).
9. **No leaks**: open and close the dashboard repeatedly while editing notes — only one set of listeners is active at a time (`app.metadataCache.eventRefs` count returns to baseline).
10. **Existing consolidation still works**: re-run both consolidate workflows after the refactor and diff their output against a pre-refactor capture — must be identical.
