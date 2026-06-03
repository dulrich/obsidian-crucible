# Chunk 4 — Autorun timeout & stale recovery

Part of [note-lock-typed-queues.md](./note-lock-typed-queues.md). Depends on Chunk 3.

## Goal
A per-job execution timeout so a hung workflow fails fast and releases resources, instead of
relying solely on the 60-min stale-running recovery.

## Timeout in `Orchestrator.runNext`
Wrap `await workflow.run(moved.job, ctx)` in `Promise.race` against a configurable
`autorunTimeoutMs` (default ~10 min; overridable per-type via `JobTypeConfig`). On timeout:
- `store.setError(file, 'timed out after Nm')`, move job → `failed`, emit queue update.
- The losing `workflow.run` promise keeps running in the background but its result is ignored —
  document this caveat (no AbortController in current workflows; acceptable for now).

## Note-lock release on terminal
Any job that acquired a note-lock (Chunk 1) must release it in a `finally` regardless of
done/failed/timeout. Audit workflow entry points that hold locks; ensure release is tied to the
job lifecycle, not the workflow's internal `try`.

## Stale recovery cooperation
`STALE_RUNNING_MS` (`Orchestrator.ts:8`) becomes the **backstop** for jobs that slipped the
timeout (e.g. plugin reload mid-run). Lower it or leave as a long safety net; ensure the two
mechanisms don't double-fail a job.

## Settings
`orchestrationAutorunTimeoutSeconds` (global default) + optional per-type override.

## Verify
- `npm run build` + `npm test` green.
- Manual: set a short `autorunTimeoutSeconds`, enqueue a deliberately slow/failing job → lands
  in `failed` with a timeout error; any held note-lock is released (overlay clears, peers proceed).
