# Queue-First Orchestration: Resource Locks, Per-Note Enrichment, Triggers & Queue Monitor

> On implementation: copy this plan to `obsidian-crucible/plans/` before starting (house rule).

## Context

The `note-lock-typed-queues` refactor landed its mechanics (FIFO `NoteLockManager`, unified
typed queue with file/memory backends, per-type config, enrichment folded in as
`youtube_metadata_fetch`) but kept a command-first shape where the design should be
queue/orchestration-first:

1. The dashboard still renders **two separate queue sections** ("Orchestration queue",
   "Video enrichment queue") instead of one Queue monitor.
2. There is **no trigger subsystem** — auto-enqueue is ad-hoc (enrichment `autoSource`
   wired from inside the dashboard UI, debounced lint/localize hardcoded in `main.ts`).
   An increasing number of workflows will fire on note lifecycle events or schedules,
   gated by guards.
3. **Crucible commands** (`registerCrucibleCommand`, `src/main.ts:219`) assume an active
   editor/file; they have no headless, target-file invocation surface a trigger or queue
   job can call.
4. **YT metadata enrichment fans out**: `ingestYoutubeVideoMetadata` →
   `linkAllNotesForVideoId` (`src/orchestration/utils/youtubeApi.ts:288`) scans the whole
   vault and writes frontmatter on every note matching the videoId, and the queue dedupes
   on `videoId` (`jobTypeConfig.ts:57`) making per-note jobs impossible. It should be one
   job per note: link the metadata note if it exists, call the API only when missing.
   Two per-note jobs sharing a videoId can then race the metadata-note create — which is
   why locks must extend to a second resource type (`yt-video-id`).

**Confirmed (no change needed): lock waiters queue FIFO, never rejected.**
`NoteLockManager.acquire` (`NoteLockManager.ts:52-63`) pushes a `Waiter` when the path is
held; `makeRelease` (`:83-100`) `shift()`s the next waiter on release. New tasks needing a
locked note queue and run in order. Chunk 6 adds an explicit regression test.

### Decisions (confirmed with user)
- **YT race fix:** generalize the lock manager to resource-typed keys (`yt-video::<id>`)
  with a fixed acquisition order — *note lock before resource lock* — rather than a
  purely serial queue (the direct command/chain path bypasses the queue, so a serial
  queue alone can't protect it). Type's `maxParallel` stays settings-driven (default 1).
- **Triggers:** code-defined registry this iteration; settings expose per-trigger enable
  toggles only. User-authored triggers later.

### Reuse (do not reinvent)
- `NoteLockManager` + `withOptionalNoteLock` — extend, don't replace; reentrancy via
  `AsyncLocalStorage` already handles nested acquisition.
- `MemoryJobQueue` / `MemoryJobBackend` / `FileJobBackend`, `JobTypeConfig` registry
  (`src/orchestration/jobTypeConfig.ts`) — per-note dedupe is a one-line key change.
- `chainManager.registerInternalCommand` (`src/chains.ts`) — already the headless
  `(args, prev, editor?, targetFile?)` execution surface; the queueable-command job
  reuses it instead of inventing a second registry.
- `findExistingMetadataNote`, `enrichYoutubeMetadataStandalone`, `writeYoutubeMetadataNote`
  (`youtubeApi.ts`) — the per-note flow recomposes these.
- Dashboard: `createSectionHeader`, `renderSortableTable`, `renderTableSection`,
  `SectionContext` (`src/ingestion/render/*`).
- `IngestionEventBus` (`src/orchestration/events.ts`) for any new events.

---

## Chunk 1 — Resource-typed lock keys

`src/orchestration/NoteLockManager.ts`:
- Note locks stay keyed by raw vault path (zero migration for the overlay, dashboard,
  `isLocked` checks in `main.ts:130,143`).
- Add a resource namespace: `resourceLockKey(kind: string, id: string)` →
  `` `${kind}::${id}` `` (`:` is illegal in vault filenames, so no collision), and
  `withResourceLock(kind, id, label, action)` delegating to `withLock` with that key.
- Skip the `note-lock-changed` emit for keys containing `::` (resource locks have no
  editor overlay; keeps dashboard/overlay noise-free). Alternatively emit a separate
  `resource-lock-changed` if the Queue monitor wants to show it — not required now.
- **Ordering rule (deadlock prevention): a holder of a resource lock must never acquire
  a note lock.** All flows acquire note → resource. Document in `AGENTS.md ## Quirks`
  (house rule: non-obvious gotchas go there).

## Chunk 2 — YT metadata: per-note jobs, link-first, fetch-on-miss

`src/orchestration/utils/youtubeApi.ts` — split `ingestYoutubeVideoMetadata`:
- `ensureMetadataNote(plugin, videoId): Promise<{status, metadataPath}>` — runs entirely
  under `withResourceLock('yt-video', videoId, …)`: `findExistingMetadataNote` → return
  if found; else API fetch + `writeYoutubeMetadataNote`. This closes the
  check-then-create race between two jobs sharing a videoId. The existing collision
  check stays as a belt-and-suspenders.
- `linkMetadataToNote(plugin, file, metadataPath)` — the current `setYtMetadataLink`
  (already takes the note lock; reentrant under a chain's lock).
- **Delete `linkAllNotesForVideoId`** (the vault-scan fan-out) and the `fanout` display
  in `YoutubeMetadataFetchWorkflow`. Each note gets its own job instead.
- `enrichYoutubeMetadataStandalone` becomes a thin wrapper over `ensureMetadataNote`.

`src/orchestration/workflows/YoutubeMetadataFetchWorkflow.ts` — per-note path becomes:
```
withLock(targetPath, 'yt-metadata', async () => {        // note lock FIRST
  if frontmatter already has yt-metadata link → done (no API, no write)
  const { metadataPath } = await ensureMetadataNote(videoId)  // resource lock SECOND
  await linkMetadataToNote(file, metadataPath)            // reentrant inline
})
```
Standalone path (no `targetPath`): `ensureMetadataNote` only.

`src/orchestration/jobTypeConfig.ts` — `youtubeMetadataJobConfig.dedupeKey`:
`p.targetPath ? 'note:' + targetPath : 'video:' + videoId`. `display` gains the target
note basename. Memory-queue keying gives one entry per note; standalone (uncaptured
video) entries keep videoId keying.

`src/main.ts` `fetchYoutubeMetadataForActiveNote` (`:771`) — recompose on the same two
functions (link-if-exists, fetch-on-miss, write **this note only**); drop the
`linkedNotes`/duplicate Notice text.

Callers passing `targetPath` already exist (`ingestionDashboard.ts:766,792`,
`EnrichmentQueueAdapter.itemToParams`). `EnrichmentQueueAdapter.metadataInFlightByPath`
keeps working (reads `params.targetPath`); `getEntry(videoId)` used by the uncaptured
"Enriched?" cell still matches standalone entries (key `video:<id>` — update its lookup
to the new key shape).

## Chunk 3 — Trigger registry (note lifecycle + schedule + guards)

New `src/orchestration/TriggerRegistry.ts`:
```ts
interface OrchestrationTrigger {
  id: string;                                   // settings toggle key + log label
  description: string;
  on: { event: 'create' | 'metadata-changed' | 'rename' }
    | { everyMs: () => number };                // schedule (cron-lite interval)
  enabled: () => boolean;                       // reads settings
  guard?: (file: TFile, fm: Record<string, unknown> | undefined) => boolean;
  jobs: (file?: TFile) => Array<{ type: JobType; params?: Record<string, unknown> }>;
}
```
- `TriggerRegistry` subscribes once to vault/metadataCache events (registered via
  `plugin.registerEvent`) and `window.setInterval` for schedules (via
  `plugin.registerInterval`); per-path debounce (~2s) for `metadata-changed`; skips
  while `noteLocks.isLocked(path)` and while `isMaterializing` to avoid self-triggering
  (same pattern as `debouncedLint`, `main.ts:127-137`).
- Fires `orchestrator.enqueue(type, params)` — dedupe keys make repeat fires cheap.
- Instantiate in `onload()` after the orchestrator; expose as `plugin.triggers`.

Founding triggers (registered in `main.ts`):
1. **`yt-metadata-on-capture`** — `metadata-changed` + `create`; guard: frontmatter has
   `yt-video-id` (via `coerceVideoId`) and no `yt-metadata` link (reuse
   `isYtMetadataLinked`, exported from `youtubeApi.ts`); job: per-note
   `youtube_metadata_fetch` with `targetPath`/`videoId`. Enabled by
   `ingestionYoutubeAutoEnrichEnabled`. This replaces "Enqueue all" as the steady-state
   path (the button stays for backfill). Per memory: IDs come from frontmatter only —
   the guard never scans note bodies.
2. **`tracker-schedule`** — `everyMs` from two new settings
   (`orchestrationYoutubeTrackerIntervalMinutes`, `orchestrationBlogsTrackerIntervalMinutes`,
   `0 = off`, default 0); jobs: `youtube_tracker` / `blogs_tracker`. Gated by the
   existing per-workflow enabled flags.

Settings (`src/settings/sections/orchestration.ts`): a "Triggers" group listing
registered triggers with enable toggles + the two interval inputs.

## Chunk 4 — Queueable command surface

- New JobType **`command_run`** (file persistence, `maxParallel 1`, dedupeKey
  `commandId + '|' + targetPath`), workflow `CommandRunWorkflow`: resolves
  `params.commandId` against the chain-internal command registry
  (`chainManager.registerInternalCommand` entries — they already accept `targetFile`
  and run inside reentrant note locks) and invokes with
  `params.args`/`params.targetPath`. Fails cleanly when the id is unknown or the target
  is missing.
- `registerCrucibleCommand` (`src/main.ts:219`): add optional `queueable?: boolean`
  (default: true when a chain-internal twin exists) recorded on `CrucibleCommandEntry`,
  so triggers/the dashboard can tell which commands may be enqueued. No behavior change
  for palette invocation.
- This is the contract for "commands run as the result of a trigger/orchestration
  workflow": triggers enqueue `command_run` jobs instead of calling command bodies, so
  every triggered command gets queue semantics (dedupe, timeout, lock acquisition via
  the internal command's own `withLock`).

## Chunk 5 — Queue monitor (dashboard merge)

`src/ingestionDashboard.ts` (+ `src/ingestion/render/types.ts` SectionId):
- Replace `buildOrchestrationQueueSection` + `buildEnrichmentQueueSection` with one
  **`buildQueueMonitorSection()`** titled "Queue monitor", placed where the
  orchestration section sits today (`mount()` order, `:107`); delete the
  `enrichmentQueue` section id; add `queueMonitor`.
- Controls row keeps all four existing controls: Autorun toggle, "Run next", "Auto
  enrich from Uncaptured Videos" toggle (+ initial autoSource push, `:393-401`), rate
  limit input.
- One unified table over both backends:
  rows = file jobs (`jobStore.listFolder('running'|'queued')`) ∪ memory snapshot
  (`enrichmentQueue.getSnapshot()` + in future any other memory type via
  `orchestrator.getMemoryQueue`). Columns: Status, Type, Target (note link from
  `params.targetPath`, else title/videoId), Created, Error, Action (Cancel for pending
  memory entries via `dequeueIfPending`). Default sort: running first.
- Meta line: per-type pending counts (e.g. `yt-metadata 4 · trackers 1`).
- Listeners: both `orchestration-queue-updated` and `enrichment-queue-updated` route to
  one `debouncedQueueMonitor`; keep the existing extra refreshes
  (`youtubeWithoutMetadata`, intake buttons) intact (`:225-244`).
- Update `refreshAll`/`renderSection` switch and remove `renderEnrichmentQueue`/
  `renderOrchestrationQueue` once parity is confirmed.

## Chunk 6 — Tests & docs

- `tests/noteLock.test.mjs`: add (a) explicit FIFO-order regression test (3 contenders
  on one path run in submission order, none rejected); (b) resource-key tests
  (`withResourceLock` serializes same id, distinct ids concurrent, note→resource nesting
  doesn't deadlock, reentrancy across the nesting).
- New `tests/youtubeMetadataJob.test.mjs` (or extend `memoryJobQueue.test.mjs`): per-note
  dedupe key shape; two jobs same videoId different notes → both enqueue.
- `AGENTS.md ## Quirks`: lock-ordering rule (note before resource; resource holders must
  not take note locks) and the `kind::id` key namespace.

---

## Execution: one-shot vs sub-agent handoff

**Chunks 1–4 one-shot in the main context.** They share evolving contracts (lock key
namespace → consumed by the YT workflow; JobType union + `jobTypeConfig` → consumed by
triggers and `command_run`; trigger registry → enqueues both). Splitting them forces
each sub-agent to re-derive the same orchestration internals, and interface drift
between agents is the main failure mode. This context already holds all of it.

**Hand off two pieces** (after chunks 1–4 build green, both can run in parallel):

1. **Chunk 5 — Queue monitor UI** → sub-agent, **Sonnet, medium effort**. Self-contained
   UI work against stable read surfaces. Prompt to use verbatim:
   > In `/home/_shared_code/obsidian-crucible`, merge the two dashboard queue sections
   > into one "Queue monitor" section. Work only in `src/ingestionDashboard.ts` and
   > `src/ingestion/render/types.ts` (SectionId union). Replace
   > `buildOrchestrationQueueSection()` and `buildEnrichmentQueueSection()` with
   > `buildQueueMonitorSection()` at the current orchestration-section position in
   > `mount()`. Preserve all four controls and their handlers exactly as written today
   > (Autorun toggle, Run next button, auto-enrich toggle including the initial
   > autoSource push at the bottom of the old enrichment builder, rate-limit input).
   > Build one sortable table (use `renderSortableTable`, see
   > `renderOrchestrationQueue` for the pattern) whose rows union
   > `plugin.jobStore.listFolder('running')`/`('queued')` with
   > `plugin.enrichmentQueue.getSnapshot()`; columns Status / Type / Target / Created /
   > Error / Action, where Target is a note link when `params.targetPath` exists (use
   > `renderFileLink`) else title or videoId, and Action is a Cancel button for pending
   > memory entries via `enrichmentQueue.dequeueIfPending`. Meta line: per-type pending
   > counts via `setSectionMeta`. Route both `orchestration-queue-updated` and
   > `enrichment-queue-updated` bus events to one debounced refresh; keep the other
   > refreshes those handlers do today. Update `refreshAll`, `renderSection`, and the
   > SectionId union; delete the two old render/build methods. Do not touch the
   > orchestrator, adapter, or events. Verify with `npm run build`.

2. **Chunk 6 — tests** → sub-agent, **Sonnet, low effort** (or Haiku, medium). Prompt:
   > In `/home/_shared_code/obsidian-crucible`, extend `tests/noteLock.test.mjs`
   > (node:test, .mjs importing the built/ts-transpiled source the same way the existing
   > tests do) with: FIFO ordering for 3 contenders on one path; `withResourceLock`
   > (key `kind::id`) serializing the same id while distinct ids run concurrently;
   > nesting `withLock(path, …)` outside `withResourceLock('yt-video', …)` completes
   > without deadlock; reentrant `withLock` inside that nesting runs inline. Add
   > per-note dedupe-key tests for `youtubeMetadataJobConfig` (targetPath → `note:<path>`,
   > no targetPath → `video:<id>`). Mirror existing test style in that file. Run
   > `npm test` and report results.

Settings copy/AGENTS.md edits stay in the main context (small, and the Quirks wording
matters).

## Critical files

| Concern | File |
| --- | --- |
| Resource locks | `src/orchestration/NoteLockManager.ts` |
| YT per-note flow | `src/orchestration/utils/youtubeApi.ts`, `workflows/YoutubeMetadataFetchWorkflow.ts`, `jobTypeConfig.ts`, `main.ts:771` |
| Triggers (new) | `src/orchestration/TriggerRegistry.ts`, wiring in `main.ts onload`, `src/settings/sections/orchestration.ts` |
| Queueable commands | new `workflows/CommandRunWorkflow.ts`, `types.ts` (JobType), `main.ts:219` (`registerCrucibleCommand`), `src/chains.ts` (internal-command lookup accessor) |
| Queue monitor | `src/ingestionDashboard.ts`, `src/ingestion/render/types.ts` |
| Adapter (key shape) | `src/orchestration/EnrichmentQueueAdapter.ts` |
| Docs | `AGENTS.md ## Quirks`, copy plan to `plans/` |

## Verification

- `npm run build` after each chunk (tsc + esbuild must stay green); `npm test` after
  chunks 1, 2, 6; `npm run lint` before finishing.
- Manual, in the dev vault (reload plugin):
  - **Per-note enrichment:** create two capture notes sharing one `yt-video-id`, enqueue
    both from "YouTube captures without metadata" → two queue entries; exactly **one**
    API fetch (one metadata note created); both notes end with `yt-metadata` linked; no
    other vault notes touched. Re-enqueue a linked note → job completes without an API
    call ("linked existing").
  - **Race/locks:** run an "Ingest as…" chain on a capture while its metadata job is
    queued → the job waits on the note lock and runs after the chain, in order (not
    rejected).
  - **Trigger:** with auto-enrich on, paste a new capture with `yt-video-id` frontmatter
    → a per-note job appears in the Queue monitor without touching the dashboard;
    body-only edits trigger nothing.
  - **Queue monitor:** tracker job + metadata jobs visible in one table with correct
    Status/Type/Target; Cancel works on pending metadata entries; autorun toggle and
    rate-limit input behave as before.
  - **command_run:** enqueue `{commandId: 'crucible:lint-note', targetPath: <note>}` via
    the orchestrator (temporary console/scratch trigger) → note is linted under its lock,
    job lands in done/.
