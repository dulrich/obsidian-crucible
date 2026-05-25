# Ingestion Dashboard: "YouTube captures without metadata" view

## Context

The Ingestion Dashboard surfaces capture-pipeline backlogs. Today there is no view for
notes that were captured with a `yt-video-id` in frontmatter but never had their YouTube
metadata fetched (no `yt-metadata` wikilink). Those notes are effectively "half-ingested" —
the user has to find them by hand and run the command **Crucible: YouTube: fetch video
metadata for active note** one note at a time.

This adds a dashboard section that lists exactly those notes and lets the user enqueue the
metadata fetch — per row, or all at once. The fetch must do the same work as that command:
`ingestYoutubeVideoMetadata(plugin, sourceFile, videoId)` (fetches via the YouTube Data API,
creates/locates the metadata note, and writes the `yt-metadata: [[…]]` link back onto the
source note — `src/orchestration/utils/youtubeApi.ts:232`).

Because that command runs inline and there is no per-note job type for it, and because
"Enqueue all" could fire many API calls at once, the buttons will enqueue **real
orchestration jobs** (decision confirmed with user). Jobs appear in the existing
"Orchestration queue" section and drain sequentially via *Run next* / *Autorun*.

## Approach

### 1. New orchestration job type + workflow

**`src/orchestration/types.ts`** — add `'youtube_metadata_fetch'` to the `JobType` union.
No settings toggle needed: `Orchestrator.isWorkflowEnabled` (`Orchestrator.ts:143`) returns
`true` by default for unlisted types.

**`src/orchestration/workflows/YoutubeMetadataFetchWorkflow.ts`** — new file, modeled on
`TranscriptRefinerWorkflow.ts` (the existing per-note workflow keyed on a path param):
- Read `params.targetPath`; resolve to a `TFile` (fail if missing).
- Read `params.videoId`; fall back to coercing `yt-video-id` from the note's frontmatter.
- Call `ingestYoutubeVideoMetadata(plugin, file, videoId)` (import from `../utils/youtubeApi`).
- Map the `IngestResult` to `WorkflowResult`: `created`/`exists` → `{ status: 'done',
  outputPaths: [metadataPath] }`; `no-video-id` / `no-api-key` → `{ status: 'failed', error }`.

**`src/main.ts`** — register it alongside the others (near line 84):
`this.orchestrator.register('youtube_metadata_fetch', new YoutubeMetadataFetchWorkflow());`
plus the import.

**`src/orchestration/utils/youtubeApi.ts`** — export a small `coerceVideoId(value: unknown):
string` helper (same logic as the private one in `main.ts:1159`) so both the workflow and
the dashboard read `yt-video-id` consistently. (Do not import from `main.ts` — risks a
circular import.)

### 2. Dashboard section (`src/ingestionDashboard.ts`)

Follow the existing section conventions exactly (header + `renderSortableTable` + per-row
button), patterned on the "Uncaptured videos" section.

- **SectionId**: add `'youtubeWithoutMetadata'` to the `SectionId` union (line 31) and to the
  `refreshAll()` id list (line 488).
- **Row type**: `interface YoutubeNoMetadataRow { file: TFile; title: string; created: number;
  videoId: string; }`.
- **mount()**: register near the other YouTube sections (after `uncapturedVideos`, line 133):
  `this.buildSection('youtubeWithoutMetadata', 'YouTube captures without metadata', 'Vault
  notes with a yt-video-id in frontmatter but no yt-metadata link yet.', (heading) =>
  this.renderEnqueueAllMetadataButton(heading));`
- **Dispatcher**: add a `case 'youtubeWithoutMetadata'` to `renderSection` (line 508).
- **compute method** `computeYoutubeNoMetadataRows(): YoutubeNoMetadataRow[]`:
  iterate `this.app.vault.getMarkdownFiles()`, read `metadataCache.getFileCache(file)?.
  frontmatter`; include the note when `coerceVideoId(fm['yt-video-id'])` is non-empty **and**
  `yt-metadata` is not linked (missing / empty string / empty array). Create date =
  `Date.parse(fm['created'])` falling back to `file.stat.ctime` (same pattern as
  `renderUnrefinedTranscripts`, line 593). Keying on the `yt-video-id` frontmatter field
  matches the command's own behavior (`main.ts:968`).
- **render method** `renderYoutubeNoMetadata(body, ctx)`:
  - Before building the table, read the job store once (`store.listFolder('queued'|'running')`,
    as `renderOrchestrationQueue` does) and build a `Map<targetPath, 'queued'|'running'>` for
    jobs of type `youtube_metadata_fetch` (from `job.params.targetPath`). Used to show in-flight
    state instead of a button.
  - Default sort `{ column: 'created', direction: 'asc' }` (oldest backlog first).
  - Columns: **Title** → `renderFileLink(td, r.file)`; **Create Date** → `formatDate(r.created)`;
    action column → per-row enqueue button (or "queued"/"running" text if in the in-flight map).
  - Per-row button: on click, `orchestrator.enqueue('youtube_metadata_fetch', { targetPath:
    r.file.path, videoId: r.videoId })`; on a non-null result, disable + relabel "Queued".
- **header button** `renderEnqueueAllMetadataButton(heading)`: "Enqueue all"; on click, enqueue
  one job per computed row not already in-flight, then `new Notice` with the count and refresh
  the section.

### 3. Live refresh wiring (`registerListeners`, line 163)

- Add `const debouncedYoutubeNoMetadata = debounce(() => void this.refresh('youtubeWithoutMetadata'), DEBOUNCE_MS, true);`
- In the always-run tail of `route()` (line 193, next to `debouncedUncapturedVideos()`), call
  `debouncedYoutubeNoMetadata()` so adding `yt-video-id` or the workflow writing `yt-metadata`
  refreshes the list (both fire `metadataCache 'changed'` on the source note).
- In the `orchestration-queue-updated` bus handler (line 213), also call
  `debouncedYoutubeNoMetadata()` so per-row buttons flip to/from "queued"/"running" as jobs
  enqueue and complete.

## Files

- `src/orchestration/types.ts` — add job type
- `src/orchestration/workflows/YoutubeMetadataFetchWorkflow.ts` — **new**
- `src/orchestration/utils/youtubeApi.ts` — export `coerceVideoId`
- `src/main.ts` — register workflow
- `src/ingestionDashboard.ts` — section, row type, compute/render/buttons, dispatcher, listeners

## Verification

1. `npm run build` (or the repo's tsc/lint task) — must compile with no type errors.
2. In a test vault, create two notes: one with `yt-video-id` and no `yt-metadata`, one with
   both. Open the Ingestion Dashboard → the new section lists only the first; the count chip
   shows `(1)`.
3. Click the row's enqueue button → a `youtube_metadata_fetch` job appears in the
   "Orchestration queue" section and the row's action shows "queued"/"running".
4. Click **Run next** (or enable Autorun) → after it completes, the note gets a
   `yt-metadata: [[…]]` link and the row drops out of the section automatically.
5. Add a fresh `yt-video-id`-only note → it appears without a manual refresh (live wiring).
6. Click **Enqueue all** with several pending notes → one job per note is enqueued; confirm
   they drain sequentially (no burst of simultaneous YouTube API calls).
7. Confirm equivalence to the command: running **Crucible: YouTube: fetch video metadata for
   active note** on one of these notes produces the same `yt-metadata` link the job does.
