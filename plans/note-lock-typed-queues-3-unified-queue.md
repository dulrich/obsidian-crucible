# Chunk 3 — Unified typed queue (merge enrichment)

Part of [note-lock-typed-queues.md](./note-lock-typed-queues.md).

## Goal
Fold `EnrichmentQueueService` into the orchestration queue as a typed queue, with per-type
config (persistence / parallelism / cooloff / idempotency / auto-source). Reuse
`MinIntervalGate` + the `rateLimitedAllSettled` worker pattern from `utils/rateLimit.ts`.

## Per-type config
`src/orchestration/types.ts` (or a new `jobTypeConfig.ts`):
```
interface JobTypeConfig {
  persistence: 'file' | 'memory';
  maxParallel: number;              // default 1
  minIntervalMs: number;            // per-type cooloff; 0 = none
  idempotentKey?: (params) => string;   // memory types dedupe
  autoSource?: () => Record<string,unknown>[];  // memory types refill
  terminalRetentionMs?: number;     // memory cleanup; default 60_000
}
```
Registry `Map<JobType, JobTypeConfig>` alongside `Orchestrator.workflows`. Register defaults in
`main.ts` next to the existing `orchestrator.register(...)` calls. File types: `{persistence:'file',
maxParallel:1, minIntervalMs:0}`. `youtube_metadata_fetch`: `{persistence:'memory', maxParallel:1,
minIntervalMs: ingestionYoutubeEnrichRateLimitSeconds*1000, idempotentKey: p=>p.videoId,
autoSource: <existing enrichment auto-source>}`.

## Fold `EnrichmentQueueService`
Move its three distinguishing behaviors into the runner's `'memory'` path:
- **Idempotent keying** (skip if key already pending/running) — from `enqueue`/`maybeRefill`.
- **Auto-source refill** — `setAutoSource` + `maybeRefillFromAutoSource` on drain-empty.
- **Terminal cleanup** — `TERMINAL_RETENTION_MS` sweep after each run.
The executor stays `YoutubeMetadataFetchWorkflow` (unchanged). The memory entries hold the same
shape data the dashboard reads.

Keep the dashboard-facing surface (`getSnapshot`, `getPendingCount`, `setAutoSource`,
`setRateLimitSeconds`, `isAutoEnabled`/`setAutoEnabled`) as a **thin adapter** over the unified
queue so `ingestionDashboard.ts` changes minimally. Delete `EnrichmentQueueService.ts` once
parity confirmed; update `main.ts` (`this.enrichmentQueue`) to the adapter.

## Per-type drain
Replace `OrchestrationAutoRunner`'s single serial loop: for each enabled type, run up to
`maxParallel` workers, each awaiting that type's shared `MinIntervalGate` before pulling the
next job (mirror `rateLimitedAllSettled` worker loop). Add a **global concurrency cap** setting
to bound total in-flight jobs across types. File-backed `runNext` stays the per-job executor;
the runner just schedules calls per type.

## Settings
Extend the per-feature settings split (from `tnr 4 of 6`): per-type `maxParallel` + `cooloffSeconds`,
plus a global `orchestrationMaxConcurrent`. Surface in the Crucible settings UI.

## Verify
- `npm run build` + `npm test` green.
- Manual: enqueue several `youtube_metadata_fetch` + a tracker run → enrichment still shows in
  dashboard (snapshot + pending count), respects per-type cooloff, auto-source refill works.
  Grep confirms no dead refs to `EnrichmentQueueService`. Set a type's `maxParallel>1` → multiple
  jobs of that type run concurrently while a global cap bounds the total.
