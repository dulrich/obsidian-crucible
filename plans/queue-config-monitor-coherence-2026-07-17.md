# Queue Configuration / Monitor — resolve the enrichment conflation into one coherent system

## Context

WP-D1/D2 split the Ingestion Dashboard queue UI into a **Queue controls** section
(global Autorun + Run next, Auto-enrich toggle + rate, per-type strip) and a
**Queue monitor** section (an "Enabled" panic switch above the live jobs table).
The repeated rework around metadata enrichment traces to a **system-level
conflation**: three distinct concepts are welded onto one flag and one method.

`settings.ingestionYoutubeAutoEnrichEnabled` today gates **all three** of:
1. the `yt-metadata-on-capture` **event trigger** that auto-enqueues a metadata
   fetch when a captured note gains a `yt-video-id` (`main.ts:344`);
2. the **Uncaptured Videos auto-source** refill that auto-enqueues fetches for
   uncaptured videos (`enrichmentQueue` autoEnabled + autoSource);
3. the **drain/execution** of `youtube_metadata_fetch` jobs, via
   `setAutoEnrichEnabled → setJobTypeAutorun` (`main.ts:563-568`).

(1) and (2) are the same concept — *automatically enqueueing* enrichment jobs. (3)
is a different concept — *executing* whatever is queued, identical to every other
job type's auto-run gate. **Automatically enqueueing a job type must not negate
control over executing it.** Welding them is why "Auto-enrich" behaves
unpredictably and why the queue-control refactor keeps thrashing.

Compounding it, a second master (global **Autorun**, `orchestrationQueueAutorunEnabled`
→ `OrchestrationAutoRunner.enabled`) overlaps Queue monitor's **Enabled** switch
(`orchestrationQueueEnabled`), and for file types the per-type "auto" checkbox reads
*on* while its chip reads *idle* because the per-type flag is only a veto and the
(default-off) global master actually governs (`autorunGate.ts:49-51`).

## The model (root fix)

**Metadata enrichment = two orthogonal controls, named to match:**

- **Auto-enqueue (source)** — automatically *create* `youtube_metadata_fetch` jobs.
  One flag gates both automatic sources: the capture event trigger and the
  Uncaptured Videos auto-source. Home: the **Uncaptured Videos** section header
  (and the existing **Settings → Orchestrate** toggle, re-labelled). Setting
  `ingestionYoutubeAutoEnqueueEnabled`; method `plugin.setEnrichmentAutoEnqueue`.
- **Auto-run (execution/drain)** — whether *queued* `youtube_metadata_fetch` jobs
  execute. Identical to every other type's per-type auto-run gate. Home: the
  **Queue Configuration** per-type strip (youtube stays in the strip). Setting: the
  existing per-type `orchestrationJobTypeControls[...].autoRun`.

Independent by construction: enqueue-on + run-off ⇒ jobs accumulate (visible in the
Monitor, runnable per-job); enqueue-off + run-on ⇒ nothing auto-fed, but manual /
trigger enqueues drain. **Queue-wide `Enabled`** (Queue monitor) is the single
master over all draining. Manual Run / Run-next / per-job Run always bypass gates.

## Decisions (user-confirmed)

- Rename the section **"Queue controls" → "Queue Configuration"** (display title
  only; keep the `queueControls` SectionId).
- **Delete** global Autorun + its `orchestrationQueueAutorunEnabled` flag and the
  runner's `enabled` field. **Enabled** (`orchestrationQueueEnabled`) is the one
  master.
- **Uniform opt-in drain gate:** every type auto-runs only when
  `queueEnabled && per-type autoRun === true`. Unset ⇒ idle. `drainsWithoutAutorun`
  affects only file-drain *readiness*, not the gate. Migration seeds `autoRun: true`
  for file-backed types auto-draining under the old global flag.
- **Decouple enrichment source from drain.** `setAutoEnrichEnabled` (which sets
  the flag + `setJobTypeAutorun` + queue-auto-enable) splits: drain is owned by the
  plain per-type `autoRun` (strip → `setJobTypeAutorun`, no youtube special-case);
  a new `setEnrichmentAutoEnqueue(enabled, autoSource?)` owns source only (the
  enqueue flag + `enrichmentQueue` auto-source enable + autoSource).
- **`youtube_metadata_fetch` stays in the per-type strip** as an execution/drain
  control, uniform with all types. (Reverses an earlier draft that excluded it —
  that hid its execution control and re-created the conflation.)
- **Re-home the Auto-enqueue (source) toggle to the Uncaptured Videos header**
  (+ re-label the Settings toggle). It governs both auto-enqueue sources.
- **Naming, to end UI↔implementation divergence:**
  `ingestionYoutubeAutoEnrichEnabled` → `ingestionYoutubeAutoEnqueueEnabled`;
  `setAutoEnrichEnabled` → `setEnrichmentAutoEnqueue`; the source-refill methods
  `EnrichmentQueueAdapter`/`MemoryJobQueue` `setAutoEnabled`/`isAutoEnabled`/
  `autoEnabled` → `setAutoSourceEnabled`/`isAutoSourceEnabled`/`autoSourceEnabled`.
  Migrations copy values; no behavior change from the renames themselves.
- **Move Run next** to the Queue monitor control row. **Per-job Run** on each queued
  Monitor row (file + memory), via a new claim-by-id primitive.
- **Drop the "Per-type:" label**; give strip rows a width-responsive **50 % / 100 %**
  card layout, clamped (≤ 2 across) on wide displays.

## Key Changes

### 1. Gate contract — `src/orchestration/autorunGate.ts`
- `AutorunGateInputs`: drop `globalAutorunEnabled`. `typeAutorunEnabled` becomes
  `queueEnabled && typeAutorun === true` (panic-off returns false first).
  `computeShouldDrain` = `typeAutorunEnabled(inputs) && (drainsWithoutAutorun || fileDrainReady)`.
- Update the module header comment to the uniform-opt-in rule. Rename the
  `migrateJobTypeControls` param `autoEnrichEnabled` → `autoEnqueueEnabled`
  (cosmetic; still seeds the youtube per-type drain flag from the old combined flag).

### 2. Runner — `src/orchestration/OrchestrationAutoRunner.ts`
- Remove `enabled`, `setEnabled`, `isEnabled`, and the constructor init from
  `orchestrationQueueAutorunEnabled` (`queueControls.ts:55` is the only `setEnabled`
  caller and is being deleted; `isEnabled` has no callers). `shouldDrain` drops the
  `globalAutorunEnabled` argument.
- Add `runJob(type, key)` — the manual lane for one job (§10).

### 3. Settings + migrations — `src/types.ts`, `src/main.ts`
- Remove `orchestrationQueueAutorunEnabled` (interface `:425`, default `:592`).
- Rename setting `ingestionYoutubeAutoEnrichEnabled` → `ingestionYoutubeAutoEnqueueEnabled`
  (interface `:484`, default `:635`).
- **Migrations (one-shot, in settings load / after orchestrator setup):**
  (a) if legacy `orchestrationQueueAutorunEnabled === true`, seed `autoRun: true`
  for every file-backed type (`!drainsWithoutAutorun`) lacking an explicit flag,
  then delete the key; (b) copy legacy `ingestionYoutubeAutoEnrichEnabled` →
  `ingestionYoutubeAutoEnqueueEnabled`, delete the old key. The existing
  `migrateJobTypeControls` seeding of the youtube per-type drain flag from that same
  legacy value is unchanged (it preserves drain-on for existing enrich users), so
  read the legacy value before deleting it.

### 4. Decouple source vs drain — `src/main.ts`, `src/ingestion/render/queueTypeControls.ts`
- `main.ts`: replace `setAutoEnrichEnabled(enabled, autoSource?)` with
  `setEnrichmentAutoEnqueue(enabled, autoSource?)` that sets
  `ingestionYoutubeAutoEnqueueEnabled` + `enrichmentQueue.setAutoSourceEnabled(enabled)`
  + (`enabled && autoSource`) `setAutoSource`. It **no longer touches**
  `setJobTypeAutorun` — drain is the strip's job now.
- `main.ts:344`: the `yt-metadata-on-capture` trigger `enabled` predicate reads the
  renamed `ingestionYoutubeAutoEnqueueEnabled` (it *is* an auto-enqueue source).
- `queueTypeControls.ts`: delete the `applyTypeAutorun` special-case
  (`type === 'youtube_metadata_fetch' → setAutoEnrichEnabled`, `:90-93`); every type,
  youtube included, drives its drain via `plugin.setJobTypeAutorun(type, enabled)`.

### 5. Rename sweep (source-refill naming) — adapter / queue / backend
- `src/orchestration/EnrichmentQueueAdapter.ts`: `setAutoEnabled`/`isAutoEnabled`
  → `setAutoSourceEnabled`/`isAutoSourceEnabled` (delegates unchanged).
- `src/orchestration/MemoryJobQueue.ts`: `autoEnabled` field + `setAutoEnabled`/
  `isAutoEnabled` → `autoSourceEnabled` + `setAutoSourceEnabled`/`isAutoSourceEnabled`;
  `refill` guard reads the renamed field.
- `src/orchestration/MemoryJobBackend.ts:65`: the no-api-key safety
  `this.queue.setAutoEnabled(false)` → `setAutoSourceEnabled(false)` (correctly a
  *source* disable — it stops auto-enqueuing, not draining).
- Update remaining callers: `uncapturedVideos.ts:44`, `queueControls.ts:102`
  (`isAutoEnabled` → `isAutoSourceEnabled`).

### 6. Queue Configuration section — `src/ingestion/sections/queueControls.ts`
- Rename header/title/description to **"Queue Configuration"** ("Per-type auto-run
  and rate limits."); keep the `queueControls` id.
- `renderQueueControls` reduces to the per-type strip only: delete the global
  Autorun toggle + Run-next, the Auto-enrich toggle, and the enrich-rate line. The
  `onAutorunChanged` callback simplifies to a plain re-render.
- The build-time initial-enable (`:37-39`) becomes source-only and moves to the
  Uncaptured Videos setup (§8): "if `ingestionYoutubeAutoEnqueueEnabled`, call
  `setEnrichmentAutoEnqueue(true, uncapturedQueueItems)`."

### 7. Per-type strip — `src/ingestion/render/queueTypeControls.ts`
- **Keep all registered types (youtube included).** Delete the `'Per-type:'` label.
- Uniform semantics: `toggle.checked = typeAutorun() === true`; chip uses
  `typeAutorunEnabled({ queueEnabled, typeAutorun })`. One chip `title`: "Auto-runs
  when this toggle and the queue's Enabled switch are both on."
- **Drop the per-type `Run`** (moves to per-job in the Monitor, §10).
- Restructure each row from an inline `<span>` into a card `<div>` (name / auto /
  chip / rate).

### 8. Auto-enqueue home — `src/ingestionDashboard.ts`, `src/ingestion/sections/uncapturedVideos.ts`, `src/settings/sections/orchestration.ts`
- `ingestionDashboard.ts`: the `uncapturedVideos` `buildSection` (~`:101`) passes a
  `decorateHeader` (like intake at `:88-89`) rendering an **Auto-enqueue** checkbox.
  Reads `settings.ingestionYoutubeAutoEnqueueEnabled`; on change calls
  `plugin.setEnrichmentAutoEnqueue(checked, () => this.uncapturedVideosSection.uncapturedQueueItems())`.
- `uncapturedVideos.ts`: `isAutoEnabled()` → `isAutoSourceEnabled()` (`:44`); host the
  moved initial-enable. The auto-source re-assert on render is otherwise unchanged.
- `orchestration.ts:465-471`: re-label the existing Settings toggle to **Auto-enqueue
  enrichment** and wire it to `setEnrichmentAutoEnqueue`. (It and the Uncaptured
  Videos toggle write the same flag and stay in sync on re-render — flag to the user
  if they'd rather keep only the in-context one.)

### 9. Queue monitor — `src/ingestion/sections/queueMonitor.ts`
- Add **Run next** to the control row beside Enabled (`runOnce()`; always active).
- Update the panic-hint copy to point at "Queue Configuration".
- **Per-job Run** in the Action column: every `queued` row (file + memory) gets a
  `Run` calling `orchestrationAutoRunner.runJob(row.type, row.key)`. Disable on
  click; `ran` ⇒ refresh, `empty` ⇒ re-enable. Memory `queued` rows keep `Cancel`
  alongside. Running rows get no Run.

### 10. Per-job run primitive (orchestration core)
A "run THIS job" path parallel to the next-of-type drain, reusing the claim guards
so it can't double-run a job a drain is already executing.
- `src/orchestration/JobBackend.ts`: add `runJob(id): Promise<RunOutcome>`.
- `src/orchestration/FileJobBackend.ts`: `runJob(id)` = claim-by-id variant of
  `claimNext` (`:105`) — match `e.job.id === id && !claimed`, add to `claimed`,
  move to `running`, execute via the same worker path; `empty` if not found/claimed.
- `src/orchestration/MemoryJobBackend.ts`/`MemoryJobQueue.ts`: `runJob(key)` — claim
  the specific `pending` entry, mark running, execute via the same
  `runWorkflowWithTimeout` path; `empty` if missing/not pending.
- `src/orchestration/Orchestrator.ts`: `runJob(type, id)` → `backends.get(type)?.runJob(id)`.
- Runner `runJob(type, key)` (§2): acquire the global semaphore, `await
  orchestrator.runJob(...)`, release; bypasses the gate, no per-type pacing.

### 11. Styles — `styles.css`
- `.crucible-queue-type-controls` wrap-flex → grid: `1fr` (narrow) → `1fr 1fr` at a
  `min-width` breakpoint (~640px), ≤ 2 columns, `max-width` on the container so wide
  displays don't sprawl. `.crucible-queue-type-control` becomes a full-width flex
  card. Remove the now-unused `.crucible-queue-type-controls-label` rule.

### 12. Gate tests — `tests/autorunGate.test.mjs`
Rewrite `computeShouldDrain`/`typeAutorunEnabled` for the uniform model
(`autoRun===true` × `queueEnabled` × readiness drains; unset/false idle; panic-off
vetoes all; agreement pin over `queueEnabled × drainsWithoutAutorun × typeAutorun`,
no `globalAutorunEnabled`). Keep `readType*`/`setTypeControl`/`migrateJobTypeControls`
(rename the seed arg). Add, where unit-testable: the file-seed migration, and that
`runJob(id)` won't double-run a job a drain already claimed (else cover in smoke).

## Execution

**First step:** copy to `plans/queue-config-monitor-coherence-2026-07-17.md` and
register it in `DEVELOPMENT.md` frontmatter `pending-plans` (frontmatter only).

Order — the contract/decouple first, then the UI reads it:
- **Track A — contract + decouple + rename + migrations** (§1–5): the semantic core.
  The rename sweep is mechanical but wide; the source/drain decouple (§4) is the
  behaviour-defining change. Test-pinned; keep under orchestrator review. ~0.35 kSLOC.
- **Track B — dashboard re-home + per-job primitive + styles** (§6–11): §10 (claim-
  by-id) is the one non-mechanical piece (concurrency-guard reuse); the rest is
  relocation/CSS. ~0.5 kSLOC.

*Recommended model/effort — Claude: Sonnet/medium for the mechanical rename sweep
and §6–9/§11 UI moves; Opus/medium for §4 (decouple) and §10 (claim-by-id
concurrency). Codex: Terra/medium throughout. Both tracks direct-defensible (≤200k
raw); §4 and §10 warrant the orchestrator's own eyes. ~1.6 kSLOC total incl. tests.*

## Critical Files
Contract/runner/settings: `src/orchestration/autorunGate.ts`,
`src/orchestration/OrchestrationAutoRunner.ts`, `src/types.ts`, `src/main.ts`.
Enrichment decouple/rename: `src/orchestration/EnrichmentQueueAdapter.ts`,
`src/orchestration/MemoryJobQueue.ts`, `src/orchestration/MemoryJobBackend.ts`,
`src/settings/sections/orchestration.ts`.
Per-job primitive: `src/orchestration/JobBackend.ts`,
`src/orchestration/FileJobBackend.ts`, `src/orchestration/Orchestrator.ts`.
Dashboard: `src/ingestion/sections/queueControls.ts`,
`src/ingestion/render/queueTypeControls.ts`, `src/ingestionDashboard.ts`,
`src/ingestion/sections/uncapturedVideos.ts`,
`src/ingestion/sections/queueMonitor.ts`, `styles.css`.
Tests: `tests/autorunGate.test.mjs`.

## Verification
- **Gates** (tests-lint skill): `npm run lint`, `npx tsc --noEmit --skipLibCheck`,
  `npm test`, `node esbuild.config.mjs production`. Grep confirms no
  `AutoEnrich`/`setAutoEnabled`/`orchestrationQueueAutorunEnabled` references remain.
- **Manual smoke** (reload, open Ingestion Dashboard):
  - **Queue Configuration** shows only the per-type card grid — **including a
    `youtube_metadata_fetch` row** — no global Autorun / Run next / Auto-enrich /
    enrich-rate line, no "Per-type:" label, no per-type Run. Cards go 1-up → 2-up on
    resize, clamped.
  - **Source vs drain are independent:** in Uncaptured Videos, turn **Auto-enqueue
    ON** and the youtube row's **auto OFF** ⇒ uncaptured videos enqueue metadata jobs
    that *sit* in the Monitor (not draining); flip the youtube row **auto ON** ⇒ they
    drain and the "Enriched?" column ticks over. Conversely Auto-enqueue OFF + auto
    ON ⇒ nothing auto-enqueues, but a captures-without-metadata **Enqueue** (or the
    capture trigger) drains automatically.
  - Every type's Auto checkbox and chip **agree**; default unchecked ⇒ "idle".
  - **Queue monitor**: **Enabled** + **Run next** above the table. Enabled off ⇒ all
    chips idle, nothing auto-drains; **per-job Run** on a queued row runs that one
    job (file + memory), others sit; a running job shows no Run; Run on a job a drain
    just claimed no-ops (no double-run). Enabled back on ⇒ prior config resumes.
  - **Migrations:** saved data with `orchestrationQueueAutorunEnabled: true` loads
    file types with Auto **on**; `ingestionYoutubeAutoEnrichEnabled` is copied to
    `ingestionYoutubeAutoEnqueueEnabled` and both legacy keys are gone after one load;
    a prior enrich user keeps both auto-enqueue and youtube-drain on.
