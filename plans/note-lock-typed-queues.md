# Orchestration, Typed Queues & Per-Note Locking

## Context

The plugin has grown two parallel async subsystems that don't coordinate:

1. **Orchestration queue** (`src/orchestration/`) — file-backed markdown jobs in
   `inbox/running/done/failed`, 8 typed `JobType`s, drained **serially** by
   `OrchestrationAutoRunner`. It has **no** rate-limit, cooloff, parallelism, or
   per-job timeout (only a 60-min stale-running recovery in `Orchestrator.scan`).
2. **Enrichment queue** (`EnrichmentQueueService`) — a *separate*, in-memory,
   single-purpose (YouTube metadata) queue that idempotently keys by `videoId`
   and *does* have rate-limiting (`MinIntervalGate`), auto-source refill, and
   terminal cleanup.

Meanwhile there is **no note-locking**. The only concurrency guard is a single
global boolean `isMaterializing` (set via `setMaterializing` callbacks, wrapped by
`withMaterializing` in `src/frontmatter.ts`). It exists to suppress *self-triggered*
auto-lint/auto-localize, **not** to serialize commands. Because of this:

- **Localize race** reappears and the **working spinner is missing on auto-localize**
  (auto path calls `localizeNote(file, /*silent*/ true)` in `main.ts:123-127`).
- **YT metadata fails inside chains but works immediately afterward** — the chain
  fetches metadata and writes `yt-metadata` frontmatter while another op writes the
  same note, so `setYtMetadataLink` lands on stale content
  (`orchestration/utils/youtubeApi.ts`).
- **Ingestion dashboard flashes while typing** — `route()` in
  `ingestionDashboard.ts:158-186` unconditionally fires expensive vault-scan
  refreshes on every `metadataCache 'changed'` event, behind only a 150 ms debounce.
- **Transcript Refine** is debounced/triggered directly rather than going through the
  queue.

**Goal:** introduce a **per-note lock** so Crucible commands targeting the same note
queue/block (with the active note grayed out), **merge the enrichment queue into the
orchestration queue** as a typed queue, and add **per-job-type rate-limit / cooloff /
parallelism / timeout**. Localize and chains stay as direct commands that *respect the
lock* (not turned into queue jobs). Delivered as sequenced, independently-shippable
chunks in the existing `tnr N of N` style.

### Decisions (confirmed with user)
- **Lock granularity:** per-note (path-keyed). Different notes run concurrently.
- **Job model:** lock-only for localize/chains; merge enrichment into the typed queue.
- **Persistence:** hybrid per-type — trackers/refine stay file-backed; high-volume
  idempotent `youtube_metadata_fetch` runs in-memory under the same manager/API.
- **Delivery:** chunked.

### Reuse (do not reinvent)
- `MinIntervalGate` + `rateLimitedAllSettled` — `src/orchestration/utils/rateLimit.ts`
  (already the canonical pacing/parallel primitives; used by trackers).
- `withMaterializing(setMaterializing, action)` — `src/frontmatter.ts:5` — the existing
  choke-point to evolve into note-aware locking.
- `IngestionEventBus` — `src/orchestration/events.ts` — add lock + queue events here.
- `ConfirmModal` patterns + `crucible-spinner` CSS class for UI affordances.

> On implementation, copy this plan to `obsidian-crucible/plans/` before starting.

---

## Chunk 1 — Note-lock core (`NoteLockManager`)

**New:** `src/orchestration/NoteLockManager.ts` — a path-keyed async mutex.

```
class NoteLockManager {
  acquire(path, label): Promise<release>   // FIFO wait queue per path
  withLock(path, label, action): Promise<T>
  isLocked(path): boolean
  lockedPaths(): string[]
}
```
- Internally `Map<path, { current: label, waiters: [] }>`. `acquire` resolves when the
  path is free; `release` wakes the next waiter.
- Emit `note-lock-changed { path, locked, label }` on the event bus on every
  acquire/release (drives Chunk 2's overlay and dashboard).
- Instantiate in `main.ts onload()` (alongside `jobStore`/`orchestrator`), expose as
  `plugin.noteLocks`.

**Wire the lock (the choke-points that mutate a single note):**
- `localizeAttachments.ts` → wrap `localizeNote` body in `noteLocks.withLock(file.path, 'localize', …)`.
- `chains.ts` → wrap `executeChain` in `withLock(targetFile.path, 'chain:'+chain.name, …)` when a `targetFile` exists.
- `lint.ts` → the four `withMaterializing` sites become `withLock` (keep `isMaterializing` for self-trigger suppression — see below).
- `orchestration/utils/youtubeApi.ts` → wrap `setYtMetadataLink` / the `ingestYoutubeVideoMetadata` write phase in `withLock(sourceFile.path, …)`. **Fixes the YT-in-chains race.**

**Keep `isMaterializing` for what it actually does** — suppressing the plugin's *own*
writes from re-triggering `debouncedLint`/`debouncedLocalize` (`main.ts:115,124`). The
note-lock is a *separate* concern (serialize commands). Evolve `withMaterializing` so it
can optionally also take a lock; commands that mutate a note do **both**: set
materializing (suppress self-events) **and** hold the note-lock (serialize peers).

**Fixes in this chunk:** localize re-appeared race; YT-metadata-in-chains race;
foundation for blocking UI.

---

## Chunk 2 — Working-spinner & locked-note overlay

**New:** a small `EditorLockOverlay` controller (in `ingestionDashboardView.ts`'s
sibling area or a new `src/noteLockOverlay.ts`) registered in `main.ts`.

- Subscribe to `note-lock-changed`. When the locked `path` equals the active
  `MarkdownView`'s `file.path`, mount a `.crucible-note-locked` overlay div over the
  editor content: dimmed background, centered `crucible-spinner` + label
  (“Localizing…”, “Running chain…”), `pointer-events` blocking edits. Remove on unlock
  or active-leaf change to an unlocked note.
- Re-evaluate on `active-leaf-change` so switching INTO a locked note shows the overlay
  and switching away hides it (overlay only ever shown on the active/visible note).
- Add styles to the plugin stylesheet (reuse existing `crucible-spinner`).

**Fix “spinner missing on auto-localize”:** the overlay is driven by the *lock*, not by
the `silent` flag, so auto-localize (silent Notice) now still shows the working overlay.
Keep `localizeNote(file, true)` suppressing the *Notice* toast spam, but UI feedback
comes from the overlay.

---

## Chunk 3 — Unified typed queue (merge enrichment)

**Add per-type config.** New `JobTypeConfig` consumed by the runner:
```
interface JobTypeConfig {
  persistence: 'file' | 'memory';   // file = current md-folder jobs; memory = enrichment-style
  maxParallel: number;              // per-type worker count (default 1)
  minIntervalMs: number;            // per-type cooloff via MinIntervalGate
  idempotentKey?: (job) => string;  // memory types dedupe (e.g. videoId)
  autoSource?: () => params[];      // memory types refill (enrichment auto-source)
}
```
Define a registry `Map<JobType, JobTypeConfig>` next to the existing
`Orchestrator.workflows` map. Defaults: file types `maxParallel:1`; `youtube_metadata_fetch`
→ `persistence:'memory'`, `idempotentKey: videoId`, `minIntervalMs` from
`ingestionYoutubeEnrichRateLimitSeconds`, `autoSource` from the existing enrichment
auto-source.

**Fold `EnrichmentQueueService` into the unified runner.** Move its three distinguishing
behaviors into the `'memory'` persistence path of the runner:
idempotent keying, `autoSource`/`maybeRefillFromAutoSource`, and
`TERMINAL_RETENTION_MS` cleanup. The actual work stays in the existing
`YoutubeMetadataFetchWorkflow` (executor unchanged). Keep the public surface the
dashboard uses (`getSnapshot`, `getPendingCount`, `setAutoSource`, `setRateLimitSeconds`)
as a thin adapter over the unified queue so `ingestionDashboard.ts` needs minimal change.
Delete `EnrichmentQueueService` once parity is confirmed.

**Per-type drain.** Replace `OrchestrationAutoRunner`'s single serial `while` loop with a
per-type drain: for each enabled type, run up to `maxParallel` workers, each gated by the
type's `MinIntervalGate` (mirror `rateLimitedAllSettled`). Keep a global concurrency cap
setting to bound total in-flight jobs.

**Settings:** add per-type `maxParallel` / `cooloffSeconds` (extend the existing
`orchestration*Enabled` family in the settings split landed by `tnr 4 of 6`). Surface in
the Crucible settings UI.

---

## Chunk 4 — Autorun timeout & stale recovery

- Wrap each `workflow.run(...)` in `Orchestrator.runNext` with a per-type **timeout**
  (`Promise.race` against a configurable `autorunTimeoutMs`, default e.g. 10 min). On
  timeout → `setError('timed out')`, move to `failed`, release any held note-lock.
- Lower/replace the hard-coded `STALE_RUNNING_MS = 60*60*1000` recovery
  (`Orchestrator.ts:8`) so it cooperates with the new timeout rather than being the only
  safety net.
- Ensure every job that grabbed a note-lock releases it on done/failed/timeout (finally).

---

## Chunk 5 — Transcript Refine through the queue

- Audit how `transcript_refine` is currently invoked (it has a workflow:
  `workflows/TranscriptRefinerWorkflow.ts`, registered in `main.ts:87`, but the trigger
  appears to be a debounced direct call). Route it **only** through
  `orchestrator.enqueue('transcript_refine', { inputPath })`, deduped by input path so
  rapid edits collapse to a single queued job (the debounce concern moves into the queue,
  not a UI timer).
- The job acquires the note-lock for the transcript file (Chunk 1), so refine can't race
  localize/lint on the same note.

---

## Chunk 6 — Dashboard debounce / flashing fix

In `ingestionDashboard.ts` `registerListeners()`/`route()` (lines 140-208):
- Raise debounce for **expensive vault-scan** sections (uncaptured posts/videos,
  youtube-without-metadata, orphans) to ~750–1500 ms; keep cheap/event-driven sections
  short. Consider per-section `DEBOUNCE_MS`.
- Make `route()` **selective**: stop calling `debouncedUncapturedPosts/Videos`,
  `debouncedYoutubeNoMetadata`, `debouncedOrphans` *unconditionally* on every
  `metadataCache 'changed'`. Only run them when the change is relevant — e.g. gate on
  create/delete/rename and on frontmatter keys that actually matter (`source`,
  `post-id`, `yt-video-id`, `yt-metadata`) rather than on body keystrokes. (Per memory:
  these IDs come from frontmatter, not the body — so body edits should not refresh them.)
- Net effect: typing in a note no longer triggers a cascade of full-section re-renders.

---

## Critical files

| Concern | File |
| --- | --- |
| Lock manager (new) | `src/orchestration/NoteLockManager.ts` |
| Lock seam / self-trigger guard | `src/frontmatter.ts` (`withMaterializing`), `src/main.ts` (`onload`, debounced lint/localize) |
| Lock wiring | `src/localizeAttachments.ts`, `src/chains.ts`, `src/lint.ts`, `src/orchestration/utils/youtubeApi.ts` |
| Overlay (new) | `src/noteLockOverlay.ts` + plugin stylesheet |
| Unified queue / per-type config | `src/orchestration/Orchestrator.ts`, `OrchestrationAutoRunner.ts`, `types.ts`, fold `EnrichmentQueueService.ts` |
| Pacing/parallel primitive (reuse) | `src/orchestration/utils/rateLimit.ts` |
| Timeout | `src/orchestration/Orchestrator.ts` |
| Transcript refine trigger | `src/orchestration/workflows/TranscriptRefinerWorkflow.ts`, trigger site in `main.ts` |
| Dashboard debounce | `src/ingestionDashboard.ts` |
| Events | `src/orchestration/events.ts` (add `note-lock-changed`) |
| Settings | the `tnr 4 of 6` settings split + Crucible settings UI |

---

## Verification

Build/types: `npm run build` (or the project's tsc/esbuild script) after each chunk —
must stay green.

Manual, in an Obsidian dev vault (reload plugin per chunk):
- **Lock + overlay (1,2):** trigger localize on a large note with remote images; the
  active note grays out with a spinner; editing is blocked; overlay clears on completion.
  Trigger auto-localize via edit → overlay now appears (previously no spinner). Run a
  chain on a note while localize runs on it → second op queues, doesn't interleave writes.
- **YT-in-chains (1):** run the chain that fetches YT metadata on a fresh capture →
  `yt-metadata` link is set on the **first** run (no longer “works only immediately
  afterward”). Confirm metadata note created and linked.
- **Queue merge (3):** enqueue several youtube_metadata_fetch + a tracker run; confirm
  enrichment items still appear in the dashboard (snapshot/pending count intact), respect
  the per-type cooloff, and auto-source refill still works. Confirm `EnrichmentQueueService`
  removal left no dead refs.
- **Parallelism/timeout (3,4):** set a type's `maxParallel` > 1 and a short
  `autorunTimeoutMs`; enqueue a deliberately slow/failing job → it lands in `failed` with
  a timeout error and its note-lock is released.
- **Transcript refine (5):** rapidly edit a transcript → exactly one queued refine job
  (deduped), runs once, holds the note-lock.
- **Dashboard flashing (6):** open the ingestion dashboard, type continuously in an
  unrelated note → no section flashing/re-render; relevant sections still update on
  create/delete/rename and on `source`/`yt-video-id` frontmatter changes.

Tests: run the existing suite (`npm test` if present) after Chunks 3–4; add unit
coverage for `NoteLockManager` (FIFO ordering, concurrent same-path serialization,
different-path concurrency).
