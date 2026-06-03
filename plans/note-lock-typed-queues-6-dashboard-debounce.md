# Chunk 6 — Dashboard debounce / flashing fix

Part of [note-lock-typed-queues.md](./note-lock-typed-queues.md). Independent of others.

## Goal
Stop the ingestion dashboard from flashing/re-rendering expensive sections on every keystroke.

## Root cause
`ingestionDashboard.ts` `route()` (≈158-186) unconditionally calls
`debouncedUncapturedPosts()`, `debouncedUncapturedVideos()`, `debouncedYoutubeNoMetadata()`,
`debouncedOrphans()` on **every** `metadataCache 'changed'` event — i.e. on every keystroke —
behind only a 150 ms global debounce. Each refresh is a full vault scan + table re-render.

## Changes
1. **Per-section debounce.** Replace the single `DEBOUNCE_MS = 150` with longer debounce for the
   expensive vault-scan sections (uncaptured posts/videos, youtube-without-metadata, orphans) —
   ~750–1500 ms — while keeping cheap/event-driven sections short.
2. **Selective routing.** In `route()`, stop firing the expensive refreshes unconditionally on
   `metadataCache 'changed'`. Gate them on relevance:
   - Always allow on `vault create/delete/rename` (structural changes).
   - On `metadataCache 'changed'`, only refresh the uncaptured/no-metadata sections when the
     **relevant frontmatter** actually changed — `source`, `post-id`, `yt-video-id`,
     `yt-metadata`. (Per project memory: these IDs derive from frontmatter, not the note body, so
     body keystrokes must not trigger them.) Compare against a small cached snapshot of those keys
     per path, or read `metadataCache.getFileCache(file).frontmatter` and skip if the watched keys
     are unchanged since last seen.
   - Orphan refresh: only on attachment create/delete/rename and on notes whose links changed —
     not on every body edit.

## Verify
- `npm run build` green.
- Manual: open the dashboard, type continuously in an unrelated note → no flashing/re-render.
  Add a `yt-video-id`/`source` to a note → relevant section updates. Create/delete/rename a note
  or attachment → corresponding sections update.
