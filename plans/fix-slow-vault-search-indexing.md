# Fix slow vault search indexing

## Context

The latest commit (`eb8963c`) added an initial SQLite-backed vault search. Rebuilding
the index ("Indexing vault…") takes minutes on a vault where it should take seconds.

Root cause (confirmed by reading the code + measuring the vault):

- The vault has **~2,560 indexable files** (`.md/.qmd/.txt`, excluding `_crucible`).
- `SearchRebuildWorkflow` indexes **one file at a time**
  (`src/orchestration/workflows/SearchIndexWorkflow.ts:18`), and
  `SearchManager.indexFile` issues **one HTTP `requestUrl` POST per file**
  to `/v1/chunks/upsert` (`src/search/SearchManager.ts:47`).
- The companion opens a **separate SQLite `BEGIN/COMMIT` transaction per request**
  (`scripts/search-companion.mjs:104`), with an FTS delete+insert per chunk.

So a rebuild = ~2,560 sequential network round-trips + ~2,560 transactions. At ~40–50ms
each that is ~2 minutes — matching the symptom. Embeddings are **not** the cause:
`searchSemanticEnabled` defaults to `false` (`src/types.ts:512`), so
`attachEmbeddings` early-returns.

Separately, the companion service is **not currently running** (port 8765 closed) —
matching "no configured SQLite afaik". There is no health pre-check before a rebuild,
so a down companion fails confusingly at `resetIndex()` instead of with a clear message.

Intended outcome: a full rebuild completes in seconds by collapsing the per-file
round-trips into a handful of bulk requests, and a missing companion fails fast with an
actionable message (per user choice: **fail fast with instructions**, no auto-start).

## Changes

### 1. Bulk-upsert chunks across many files — `src/search/SearchManager.ts`

The upsert API and companion already accept a `chunks` array; only the workflow needs to
stop sending one file per request.

- Add `buildFileChunks(file: TFile): Promise<SearchChunk[]>` — the read + `buildSearchChunks`
  half of the existing `indexFile`, with no embed/upsert. Reuse the existing guards
  (`isSearchIndexablePath`, `isPathExcluded`) and `buildSearchChunks` from `./chunker`.
- Add `indexFiles(files: TFile[], onProgress?: (files: number, chunks: number) => Promise<void>): Promise<{ files: number; chunks: number }>`:
  - Iterate files, accumulate chunks into a buffer.
  - Flush when the buffer reaches a threshold (`const SEARCH_UPSERT_FLUSH_CHUNKS = 500;`)
    and once more at the end. Each flush: call the existing private `attachEmbeddings`
    (only does work when semantic is enabled) then a single `client().upsertChunks(buffer)`.
  - Call `onProgress` every ~10 files (same cadence as today) so the dashboard still updates.
  - 500 chunks ≈ <1MB, well under the companion's 20MB body cap.
- Keep `indexFile` as-is for single-note reindex (`search_upsert_file`); optionally
  reimplement it as `indexFiles([file])` to avoid duplication.

This turns ~2,560 requests/transactions into ~tens.

### 2. Health pre-check + replace the per-file loop — `src/orchestration/workflows/SearchIndexWorkflow.ts`

In `SearchRebuildWorkflow.run`, before `resetIndex()`:

- `const health = await plugin.searchManager.health().catch(() => null);`
  (the client throws fast on connection-refused — no hang).
- If `!health?.ok`, `new Notice(...)` and
  `return { status: 'failed', error: 'Search companion not reachable at ${searchServiceUrl}. Start it with: npm run search:serve' }`.

Then replace the manual `for (const file…)` loop (lines 18–24) with a single
`plugin.searchManager.indexFiles(indexableFiles, (files, chunks) => progress.update(...))`
call, keeping the existing `SearchJobProgress` message format.

### 3. (Optional) Faster companion writes — `scripts/search-companion.mjs`

Add `PRAGMA synchronous = NORMAL;` next to the existing `PRAGMA journal_mode = WAL;`
(line 19). Safe under WAL and removes an fsync per transaction — small extra win on the
now-fewer, larger transactions.

## Files

- `src/search/SearchManager.ts` — add `buildFileChunks` + `indexFiles`; flush constant.
- `src/orchestration/workflows/SearchIndexWorkflow.ts` — health pre-check; use `indexFiles`.
- `scripts/search-companion.mjs` — optional `PRAGMA synchronous = NORMAL`.

No new settings needed; `searchIndexBatchSize` continues to govern embedding sub-batching
inside `attachEmbeddings`.

## Verification

1. Copy this plan into `obsidian-crucible/plans/` before implementing (repo convention).
2. Build: `npm run build` (or the project's typecheck) — must pass clean.
3. Start the companion: `npm run search:serve` (writes `.crucible/search.sqlite`).
4. In the dev vault, run **Search: rebuild index**. Confirm it now finishes in seconds and
   the progress note reports the same file/chunk counts as before.
5. Sanity-check results: run **Search: vault** for a known term and confirm hits open.
6. Stop the companion and run **Search: rebuild index** again — confirm it fails *fast*
   with the "Start it with: npm run search:serve" message, not a multi-minute stall.
7. Tests: `npm test` — existing `tests/searchChunker.test.mjs` / `searchExclusions.test.mjs`
   still pass (chunk shape is unchanged; batching only changes transport).
