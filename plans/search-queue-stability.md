# Vault Search Queue Stability

## Summary

Fix vault search so indexing work is queue-contained, resumable without UI churn,
quiet when the companion service is offline, and subordinate to user-spawned work.
Manual commands use high priority; background search indexing runs in bounded batches
with retry/backoff instead of long monolithic jobs.

## Key Changes

- Extend file-backed orchestration enqueue options with `priority`, and claim jobs in
  `high -> normal -> low` order, preserving FIFO within each priority.
- Promote duplicate queued jobs when a user manually enqueues the same target at a
  higher priority.
- Update direct command-palette enqueue commands, including `Search: reindex active
  note`, to use high priority. Lifecycle search events remain background priority.

## Search Indexing Behavior

- Replace full-vault rebuild's long in-job loop with a producer job that health-checks
  the companion, resets the index, enqueues bounded low-priority `search_upsert_batch`
  jobs for indexable files, and finishes quickly.
- Add `search_upsert_batch` for rebuild chunks, using existing `SearchManager.indexFiles`
  batching so indexing remains efficient while yielding between jobs.
- Remove the unbounded rebuild timeout; search jobs use normal job timeout plus
  request-level companion timeouts.
- Add a search companion availability guard used by rebuild/upsert/delete/batch jobs:
  offline or timed-out companion returns a deferred workflow result, and the file
  backend requeues the job with quiet retry progress and a durable retry time.
- Delay initial file-backed autorun until Obsidian layout is ready plus a short grace
  period, so launch-time Dataview loading does not compete with queued vault indexing.

## Dashboard Rendering

- Cap Queue Monitor DOM rendering to the first 100 sorted rows.
- Keep full counts in the section badge/meta, with text like `showing 100 of 1248`.
- Preserve sorting and cancel behavior for displayed rows.

## Tests

- Unit-test queue ordering and priority promotion.
- Unit-test search offline behavior: upsert/delete/batch return deferred and are
  requeued, not failed.
- Unit-test rebuild producer behavior where practical.
- Verify Queue Monitor limiting through the table helper or isolated row selection.

## Verification

- `node --test tests/*.test.mjs`
- `npm run lint`
- `npx tsc -noEmit -skipLibCheck`
- `node esbuild.config.mjs production`
