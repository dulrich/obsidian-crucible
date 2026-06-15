# Search Index Queue Stability

## Summary
- Prevent startup/indexing-phase noise from creating thousands of automatic `search_upsert_file` jobs.
- Recover durable `running/` search jobs automatically after restart instead of leaving them stuck until a manual scan.
- Treat the search companion as optional: automatic lifecycle indexing skips while it is offline; explicit search commands still queue work.

## Key Changes
- Add a search lifecycle gate in `src/main.ts`: automatic create/modify/rename/delete search jobs only start after workspace layout is ready and the first `metadataCache.on('resolved')` fires.
- Change `enqueueSearchUpsert` to distinguish automatic vs manual callers:
  - Automatic lifecycle calls obey startup readiness and cached companion availability.
  - Manual commands like `Search: reindex active note` bypass those gates and keep existing explicit behavior.
- Add cached companion availability for automatic indexing:
  - Share one in-flight health check.
  - Cache online for 30s.
  - Cache offline for 5min.
  - While offline, skip automatic lifecycle upserts and log via `logWarn('search', ...)` only.
  - Missed offline automatic updates are intentionally recovered by `Search: rebuild index`.
- Run an automatic startup queue scan after plugin load/layout readiness.
- Update `Orchestrator.scan()` to accept a silent/no-notice option for startup scans.
- Replace the fixed one-hour stale-running cutoff with `effective job timeout + 30s`; if timeout is disabled, keep the one-hour backstop.
- Keep explicit rebuild/search workflow jobs durable and unchanged except for benefiting from startup stale recovery.

## Interfaces
- `CruciblePlugin.enqueueSearchUpsert(file, priority?, options?)` gains an internal options object, e.g. `{ source: 'auto' | 'manual' }`.
- `Orchestrator.scan(options?)` gains an internal option such as `{ notify?: boolean }`, defaulting to current notice behavior.
- No new settings UI is required for this fix.

## Test Plan
- Add unit coverage for startup search gating:
  - Auto lifecycle upsert before first metadata `resolved` does not enqueue.
  - Auto lifecycle upsert after readiness enqueues.
  - Manual active-note reindex bypasses readiness.
- Add unit coverage for offline companion behavior:
  - Auto upsert skips when health fails.
  - Repeated auto upserts reuse the offline cache and do not enqueue.
  - Manual upsert still queues.
- Add/adjust orchestration tests:
  - Startup scan can run silently.
  - Running jobs older than `timeout + 30s` are moved back to queued.
  - Timeout-disabled jobs still use the one-hour stale backstop.
- Run the mandatory cleanup loop:
  - `npm run lint`
  - `npx tsc -noEmit -skipLibCheck`
  - `node esbuild.config.mjs production`

## Assumptions
- Obsidian's "Indexing vault..." is not directly wired to Crucible search; the storm is handled by suppressing lifecycle search events until Obsidian's initial metadata resolution completes.
- Because the companion is often offline, automatic offline edits may not be individually queued; `Search: rebuild index` is the intended catch-up path.
- At implementation start, remind the user to run `npm run dev` in a separate terminal for Obsidian hot reload, but do not start it automatically.
