# Crucible: Trigger — user-configurable if-this-then-that

## Context

The plugin already has a **trigger engine** — `src/orchestration/TriggerRegistry.ts` with the
`OrchestrationTrigger` contract. It handles `create` / `rename` / `metadata-changed` events plus
interval schedules, debounces metadata bursts, gates on `isMaterializing` / note-locks, and only ever
*enqueues* jobs (so triggered work inherits queue dedupe / pacing / timeout / locks). But it is
**code-defined**: only three "founding" triggers exist (`yt-metadata-on-capture`,
`youtube-tracker-schedule`, `blogs-tracker-schedule`), and settings expose only on/off toggles.

Separately, the "if" and "then" halves already exist: *if* = `OrchestrationTrigger.guard` +
`GuardCondition` (`has-tag` / `has-property` / `property-equals`); *then* = `Chain` /
chain-internal commands / `Workflow`s.

**Goal:** make the trigger engine user-configurable so users can author if-this-then-that rules whose
action is a **Chain or a workflow**. Triggers = *when/if*, Chains = *what*; they compose (a trigger
does not become a chain). This is why "extend Chains" feels wrong — schedule triggers and
lint-on-save don't map onto a chain.

**Driving use case:** on note create in `Clippings/`, if the note has a `yt-video-id`, run
Chain "Ingest as transcript"; then if word-count < 6k, refine the transcript (Gemma 4).

### Decisions (confirmed with user)
- **Architecture:** layer a user-configurable feature over the existing `TriggerRegistry` engine.
- **Migration:** selective — route lint-on-save, localize-on-create/edit, folder-template
  materialize, and auto-yt-metadata through triggers; leave infra (search index, ToC, dashboard
  refresh, note-lock rename) hardwired.
- **Action:** a trigger runs a named **Chain** *or* enqueues a built-in **workflow**.
- **Conditions:** reuse `GuardCondition`, extend with **folder scope** + **numeric** comparisons
  (`property < / > N`, `word-count < / > N`).

---

## Phase 1 — Core mechanism (lands the Clippings case)

### 1. Data model — `src/types.ts`
Add user-facing trigger types and a settings array (mirrors how `chains: Chain[]` is stored):

```ts
export type TriggerEvent = 'create' | 'modify' | 'rename' | 'metadata-changed';

export interface TriggerScope {
  folder?: string;              // path prefix, e.g. "Clippings"
  includeSubfolders?: boolean;  // default true
}

// Extend the existing GuardConditionType (also used by chain guard steps)
export type GuardConditionType =
  | 'has-tag' | 'not-has-tag'
  | 'has-property' | 'not-has-property' | 'property-equals'
  | 'property-lt' | 'property-gt'        // numeric, frontmatter-sourced
  | 'word-count-lt' | 'word-count-gt';   // numeric, content-sourced (async)

export type TriggerAction =
  | { kind: 'chain'; chainName: string }
  | { kind: 'workflow'; jobType: JobType; params?: Record<string, string> };

export interface TriggerDef {
  id: string;                       // stable, generated on create
  name: string;                     // user label
  enabled: boolean;
  on: { event: TriggerEvent } | { everyMinutes: number };
  scope?: TriggerScope;
  conditions: GuardCondition[];     // reuse GuardCondition shape
  conditionMode?: 'all' | 'any';    // default 'all' (AND)
  action: TriggerAction;
}
```
- Add `triggers: TriggerDef[]` to `CrucibleSettings` + `DEFAULT_SETTINGS = []` (`src/types.ts`).
- `migrateSettings()` (`main.ts:474`) seeds `triggers` to `[]` if absent.

### 2. New action: run a chain via the queue — `src/orchestration/workflows/ChainRunWorkflow.ts`
- New job type `chain_run` (extend `JobType` in `src/orchestration/types.ts`; add a
  `JobTypeConfig` in `jobTypeConfig.ts`: `persistence: 'file'`, dedupe key `chainName + targetPath`).
- `run(job, ctx)` looks up the chain by `params.chainName` and calls
  `plugin.chainManager.executeChain(chain, undefined, targetFile)` — **reuse the exact lookup pattern
  already in `TranscriptRefinerWorkflow.ts:34`** (`settings.chains.find(c => c.name === …)`).
- Register in `main.ts onload()` alongside the other `orchestrator.register(...)` calls (lines 144-158).
- Chain execution already takes the note lock and respects `mutating`, so no extra locking here.

### 3. Generalize the engine — `src/orchestration/TriggerRegistry.ts`
- Add `'modify'` to the event union; in `start()` register a **debounced** `vault.on('modify')`
  (reuse the `pendingPaths` + `METADATA_DEBOUNCE_MS` coalescing already used for metadata).
- Add `setUserTriggers(defs: TriggerDef[])`: rebuild the user-trigger slice of the registry from
  settings (keep code-defined founding triggers separate so they aren't dropped). Called at startup
  and on settings save — mirror `registerChains()`.
- Adapter `triggerDefToOrchestrationTrigger(def, plugin)` mapping:
  - `on.event` → `{ event }`; `on.everyMinutes` → `{ everyMs: () => max(0, min)*60000 }`.
  - `enabled: () => def.enabled`.
  - `guard(file, fm)`: folder-scope prefix check + evaluate `conditions` (AND/any) against `fm`/tags.
    Numeric `property-lt/gt` read `fm[property]`. **`word-count-*` is NOT evaluated here** (needs
    async content read) — see note below.
  - `jobs(file)`: for `kind:'chain'` → seed `chain_run` `{ chainName, targetPath: file.path }`;
    for `kind:'workflow'` → seed `{ type: jobType, params }`.
- The existing `fireEvent` gate (`isMaterializing() || noteLocks.isLocked`) and debounce stay as-is.

**Word-count gate placement:** because word count requires an async `cachedRead`, the `< 6k` stage
lives as a **chain guard step inside the "Ingest as transcript" chain**, not on the trigger. To
support it:
- Extend `ChainManager.evaluateGuard` (`chains.ts:264`) to be **async** and handle the new numeric
  types; for `word-count-*` read `await app.vault.cachedRead(file)` and count words. `runChainSteps`
  already `await`s `executeStep`, so making the guard async is a localized change.
- The settings step-editor for guard steps (`automate.ts` ~line 290) gains the numeric condition
  types + a numeric `value` input.

### 4. Wiring — `src/main.ts`
- `registerTriggers()` (new, mirrors `registerChains()` at `main.ts:1086`): call
  `this.triggers.setUserTriggers(this.settings.triggers)`. Invoke in `onload()` after
  `registerChains()` and from `saveSettings()`/the settings UI after edits.
- Optional but recommended for testing: per-trigger **"Trigger: &lt;name&gt;"** palette command that fires
  the action on the active file (bypassing the event). Register via `registerCrucibleCommand(...)`
  (AGENTS.md Quirk 127 — never `addCommand` directly), new group `'Triggers'` added to
  `CrucibleCommandGroup` (main.ts:48) and `GROUP_ORDER` (`settings/sections/commands.ts:108`).

### 5. Settings UI — `src/settings/sections/automate.ts`
Add a **Triggers** section next to Chains (reuse the chains list/editor structure
`renderChainListSection` / `renderEditChain`, and the `bind.ts` helpers):
- List: add / duplicate / delete triggers; enable toggle per trigger.
- Editor: name, event-or-schedule selector, folder scope (folder picker + include-subfolders),
  conditions editor (condition-type dropdown reusing the chain guard UI + tag/property/value/numeric
  inputs, AND/any mode), and an action picker (Chain dropdown from `settings.chains` **or** workflow
  dropdown from registered job types).
- After any edit call `tab.plugin.registerTriggers()` (parallels the `registerChains()` re-register).

### 6. Verification (Phase 1)
1. `npm run build` / lint per AGENTS.md "Full Cleanup Loop".
2. Author Chain "Ingest as transcript": `[ingest step] → [guard: word-count-lt 6000] → [refine step
   (Gemma 4) / run Refine chain]`. (Chain stops before refine when word-count ≥ 6000.)
3. Author Trigger: on `create`, scope `Clippings/`, condition `has-property yt-video-id`,
   action → Chain "Ingest as transcript".
4. Create a note in `Clippings/` with `yt-video-id` in frontmatter; confirm `chain_run` enqueues,
   ingest runs, and refine runs only when word-count < 6k. Verify a note **without** `yt-video-id` or
   **outside** `Clippings/` does not fire.
5. Confirm no duplicate fires (queue dedupe) and that firing is suppressed while the note lock is
   held.

---

## Phase 2 — Selective migration (after Phase 1 is verified)

Route existing event-driven note behaviors through triggers, preserving each feature's existing
toggle as the trigger's enable state. Migrate **one at a time**, each behind its own commit, watching
for regressions. Per-feature notes:

- **auto-yt-metadata** (`yt-metadata-on-capture`): already a founding trigger — leave as-is or
  re-express as a seeded default `TriggerDef`. Lowest risk; do first as the migration template.
- **lint-on-save** (`main.ts:200-221`, toggle `lintOnSave`): needs the new `modify` event. Nuance —
  the inline path only lints the **active editor's** file; the trigger path is file-based and routes
  through the queue (`command_run` → `lint-note`). Confirm the active-file constraint is acceptable
  or add it as a condition.
- **localize-on-create/edit** (`main.ts:293-365`, toggles `localizeAttachmentsTriggerOnCreate/Edit`):
  has a retry state machine (waits for `file.stat.size>0` + lock release). Preserve via the queue's
  pacing/retry or keep the retry wrapper in the localize workflow. Validate timing carefully.
- **folder-template materialize** (`handleFileCreate`, `main.ts:1175+`): users expect the template
  **immediately** on create; a queued job may feel laggy. Either keep inline or give it a fast lane.
  Flag and decide during migration.

Infra stays hardwired (do **not** migrate): search indexing (`SearchIndexCoordinator`), ToC refresh,
dashboard refresh (`ingestionDashboard.ts`), note-lock rename migration (`main.ts:167`).

---

## Conventions to honor (from AGENTS.md)
- Register commands only via `registerCrucibleCommand` (Quirk 127).
- A note-mutating command used as a chain step must be a chain-internal command (Quirk 144) — chains
  already satisfy this; `chain_run` runs through `ChainManager`.
- `console.*` banned in `src/`; use `logWarn` / `logError` from `src/log.ts` (Quirk 142).
- Wrap plugin-driven writes in `isMaterializing` + note lock (handled by chain execution).
- Add the new job to the **unified queue** with a `JobTypeConfig`; do not add a parallel drain loop
  (Quirks 140/147).
- On approval, copy this plan to `<repo>/plans/<descriptive-name>.md` before implementing.

## Critical files
- `src/orchestration/TriggerRegistry.ts` — engine generalization (`modify` event, `setUserTriggers`,
  adapter).
- `src/orchestration/workflows/ChainRunWorkflow.ts` — new; reuse `TranscriptRefinerWorkflow.ts:34`
  chain-lookup pattern.
- `src/orchestration/types.ts`, `src/orchestration/jobTypeConfig.ts` — `chain_run` job type/config.
- `src/types.ts` — `TriggerDef` / `TriggerScope` / `TriggerAction`, extended `GuardConditionType`,
  `triggers: TriggerDef[]` setting.
- `src/chains.ts` — async `evaluateGuard` + numeric / word-count guard types.
- `src/main.ts` — `registerTriggers()`, `chain_run` registration, optional `Triggers` command group.
- `src/settings/sections/automate.ts` — Triggers list + editor; numeric guard inputs.
