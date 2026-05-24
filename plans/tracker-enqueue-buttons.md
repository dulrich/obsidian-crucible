# Ingestion Dashboard — Tracker Enqueue Buttons + Orchestration Queue Section

## Context

The Ingestion Dashboard surfaces tracker run *history* but offers no in-UI way
to drive the orchestration queue. Today, kicking off a tracker requires two
command-palette steps (enqueue, then "run next" — see `src/main.ts:267,289-321`).
Manual cycling and visibility into the queue are both missing.

We want:

1. **"Enqueue Intake" buttons** on the Blog intake and YouTube intake sections.
   - Click → enqueue `blogs_tracker` / `youtube_tracker` (base tracker only, no
     consolidation). De-bounced: while a matching job is queued or running the
     button reflects that state and rejects re-clicks.
   - States: idle ("Enqueue Intake"), queued ("Queued"), running ("Running…"
     + spinner).
2. **New "Orchestration Queue" section** modeled on the existing
   "Video Enrichment Queue" panel (`ingestionDashboard.ts:197-254`,
   `EnrichmentQueueService.ts`):
   - Persistent **Autorun** toggle: when enabled, the orchestrator drains its
     queue automatically as new jobs arrive.
   - **Run next** button for manual single-step cycling.
   - Table of current queue (queued + running jobs) — type, status, id, created
     time, last error if any.

The existing `tracker-run` event already triggers list refresh for the intake
tables (`ingestionDashboard.ts:162-165`); we will reuse it.

## Approach

### 1. New orchestration event — `orchestration-queue-updated`

In `src/orchestration/events.ts`, add:

```ts
'orchestration-queue-updated': { queued: number; running: number };
```

Emit it from `Orchestrator` (`src/orchestration/Orchestrator.ts`) at three
points:

- After `store.enqueue` succeeds in `enqueue()` (line ~30).
- After the `store.move(... 'running')` call in `runNext()` (line ~49) so UI
  flips from "queued" to "running".
- After the terminal moves to `'done'` / `'failed'` in `runNext()` (lines
  ~81-89) — also before the existing `tracker-run` emit.

Helper `private async emitQueueUpdate()` reads
`store.listFolder('queued')` / `store.listFolder('running')` lengths and emits.
Listing is async (filesystem), so the emit is awaited.

### 2. New `OrchestrationAutoRunner` service

New file `src/orchestration/OrchestrationAutoRunner.ts`, modeled directly on
`EnrichmentQueueService` but much smaller. Owns:

- `private enabled: boolean` — initialized from
  `plugin.settings.orchestrationQueueAutorunEnabled`.
- `private draining: boolean` — reentrancy guard.
- `setEnabled(v: boolean)` — toggles and `kickDrain()`.
- Subscribes to `orchestration-queue-updated` in constructor; on each event,
  `kickDrain()`.
- `kickDrain()` — if `enabled && !draining`, starts an async loop that calls
  `orchestrator.runNext()` until it returns null (queue empty) or `enabled`
  flips off.
- `runOnce()` — public wrapper for the "Run next" button. Calls `runNext()`
  once regardless of `enabled`.
- `dispose()` — unsubscribes.

Instantiated in `main.ts` alongside `enrichmentQueue` (after `orchestrator` is
constructed and workflows are registered) and disposed in `onunload`.

### 3. New setting — `orchestrationQueueAutorunEnabled`

In `src/types.ts`:
- Add field to the settings interface (near
  `ingestionYoutubeAutoEnrichEnabled`, line 322).
- Default `false` in the defaults block (~line 421).

No settings-tab UI for it — the dashboard toggle is the source of truth, same
pattern as the auto-enrich toggle which has no settings-tab entry either.

### 4. Dashboard — new "Orchestration Queue" section

In `src/ingestionDashboard.ts`:

- Add `'orchestrationQueue'` to the `SectionId` union.
- New `buildOrchestrationQueueSection()` modeled on
  `buildEnrichmentQueueSection()` (lines 197-254):
  - Card with header "Orchestration queue" + description.
  - Controls row: an Autorun `<input type="checkbox">` (writes
    `settings.orchestrationQueueAutorunEnabled`, calls
    `plugin.orchestrationAutoRunner.setEnabled(v)`) and a `Run next` button
    that calls `plugin.orchestrationAutoRunner.runOnce()`.
  - Body renders a table of current queue (queued + running) via the existing
    `renderSortableTable` helper. Columns: Type, Status, ID, Created.
- New `renderOrchestrationQueue(body)` reads from `plugin.jobStore`
  (`listFolder('queued')` + `listFolder('running')`).
- Place this section between "YouTube intake" and "Uncaptured posts" so it
  sits near the trackers that feed it. Add to the `refreshAll` ID list and the
  `renderSection` switch.
- Subscribe to `orchestration-queue-updated` in `registerListeners()`:
  - Debounced `refresh('orchestrationQueue')` plus
    `refresh('blogIntake')` / `refresh('youtubeIntake')` button-state refresh
    (see next point).

### 5. Dashboard — "Enqueue Intake" buttons on the two tracker sections

Extend `buildSection(id, title, description, decorateHeader?)` in
`ingestionDashboard.ts:173-195` with an optional `decorateHeader` callback that
runs after the Refresh button is created. Two-section opt-in keeps the other
section call sites untouched.

For `blogIntake` and `youtubeIntake`, pass a callback that creates a button and
wires it through a new helper `renderEnqueueIntakeButton(heading, kind)` where
`kind` is `'blog' | 'youtube'`. The helper:

- Maps `kind → JobType` (`'blog' → 'blogs_tracker'`, `'youtube' → 'youtube_tracker'`).
- Holds a reference to the button element on the UI class
  (`private intakeButtons: Map<'blog' | 'youtube', HTMLButtonElement>`) so the
  `orchestration-queue-updated` listener can refresh state.
- State refresh (`async refreshIntakeButton(kind)`): reads
  `jobStore.listFolder('queued')` + `listFolder('running')`, finds a job
  matching the JobType, then sets one of three visual states:
  - **idle** — text "Enqueue Intake", enabled, no spinner.
  - **queued** — text "Queued", `disabled = true`.
  - **running** — spinner element + "Running…", `disabled = true`,
    `aria-busy = "true"`.
- Click handler: `await plugin.orchestrator.enqueue(jobType)`. The orchestrator
  already shows a Notice on disabled-settings and returns null; no extra
  handling needed. The queue event flow updates the button automatically.

Initial state on `mount()` is computed by calling `refreshIntakeButton` after
the sections are built.

### 6. CSS — `styles.css`

Add to the ingestion dashboard block (around lines 461-539):

- `.crucible-ingestion-enqueue-intake` — sibling spacing/sizing matching
  `.crucible-ingestion-refresh`.
- `.crucible-ingestion-enqueue-intake[aria-busy="true"]` and `:disabled` —
  reduced opacity, `cursor: not-allowed`.
- `.crucible-spinner` — small `inline-block` element using a CSS
  `@keyframes crucible-spin` border-rotation animation. Reusable.
- `.crucible-ingestion-queue-controls` is already defined and can be reused
  for the Orchestration Queue controls.

No image assets, no Lucide icons.

## Files to modify

| File | Change |
|------|--------|
| `src/orchestration/events.ts` | Add `'orchestration-queue-updated'` to union + payload interface. |
| `src/orchestration/Orchestrator.ts` | Add `emitQueueUpdate()`; await it after `enqueue`, after move-to-running, and after terminal moves in `runNext`. |
| `src/orchestration/OrchestrationAutoRunner.ts` | **New file.** Auto-drain service + manual `runOnce()` (~60 LOC). |
| `src/types.ts` | Add `orchestrationQueueAutorunEnabled: boolean` to settings interface + defaults. |
| `src/main.ts` | Instantiate `orchestrationAutoRunner` after orchestrator setup; dispose in `onunload`. |
| `src/ingestionDashboard.ts` | New `orchestrationQueue` section + render; extend `buildSection` with `decorateHeader`; add `renderEnqueueIntakeButton` and `intakeButtons` map; subscribe to queue updates; refresh button state. |
| `styles.css` | New `.crucible-ingestion-enqueue-intake`, `.crucible-spinner`, `@keyframes crucible-spin`. |

No changes to tracker workflow files or `JobStore`.

## Verification

1. Build the plugin and reload Obsidian.
2. Open the Ingestion Dashboard view.
3. **Section visibility**: confirm the new "Orchestration queue" section
   appears between "YouTube intake" and "Uncaptured posts" with Autorun
   checkbox + Run next button.
4. **Blog Enqueue Intake — autorun OFF**:
   - Click "Enqueue Intake" on Blog intake.
   - Button flips to "Queued"; orchestration queue table shows the queued
     `blogs_tracker` row.
   - Click "Run next" in the orchestration queue section.
   - Button flips to "Running…" with spinner; row moves to running.
   - On completion: button returns to "Enqueue Intake"; Blog intake table
     gains a new row; orchestration queue table empties.
5. **YouTube Enqueue Intake — autorun ON**:
   - Toggle Autorun on. Click "Enqueue Intake" on YouTube intake. Run
     proceeds without clicking "Run next". Button cycles
     idle → queued → running → idle. YouTube intake row appears.
6. **De-bouncing**: while a run is queued or running, the matching Enqueue
   Intake button is disabled and re-clicks do nothing. Confirm via UI and dev
   console (no extra jobs enqueued).
7. **Disabled-workflow path**: in settings, disable Blogs tracker. Click
   "Enqueue Intake" on Blog intake. Notice appears, button stays idle, no row
   added to the orchestration queue.
8. **Persistence**: toggle Autorun on, restart Obsidian, confirm Autorun stays
   on after reload.
9. **Failure path**: temporarily break a feed source. Click Enqueue → run.
   Button returns to idle on failure; orchestration queue clears the row; Blog
   intake row reflects the failed run.
