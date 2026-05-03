# Orchestrator — Core (Plan 1 of 4)

## Context

Foundation for a vault-native deterministic orchestrator inside the Crucible Obsidian plugin. This plan adds **only** the infrastructure: job model, queue folders, JobStore, Orchestrator class, settings tab, and the two top-level commands (`scan`, `run next`). No workflow logic — the three workflows ship in plans 2/3/4.

Why core-first: every workflow depends on the same job lifecycle (write to `inbox/` → move to `running/` → execute → move to `done/` or `failed/`). Locking down the substrate before any workflow keeps each workflow plan small and reviewable.

## Architecture

Hybrid execution model: workflows are TypeScript classes registered in a dispatch table on `Orchestrator`. Plans 2 and 3 add concrete classes; plan 4 wraps a delegation to `chainManager.executeChain("Refine Transcript")`.

```
Orchestrator
  ├── JobStore (read/write/move job files)
  ├── workflows: Map<JobType, Workflow>
  ├── enqueue(type, params) → writes to inbox/
  ├── runNext() → picks oldest in inbox, moves to running/, dispatches, moves to done/ or failed/
  └── scan() → ensures folders, reports counts, recovers stale running/
```

## Decisions locked in (from approved planning round)

- Folder root: `_crucible/orchestration/` (extends existing `_crucible/` convention; **not** `_system/`).
- Manual execution only in v1. No interval scan, no auto-execute.
- `requiresReview` field is **not** in the v1 type. HITL is handled by the workflow tagging the produced note + a user-built Dataview view.
- New "Orchestrator" settings tab (6th, alongside Configure / Automate / AI / Lint / Commands).
- Timezone is a setting (default `America/Mexico_City`), read at run time.

## Files to add

```
src/orchestration/
  types.ts
  JobStore.ts
  Orchestrator.ts
  workflows/
    Workflow.ts          (interface only — no concrete workflow yet)
  utils/
    dates.ts
    markdownBlocks.ts
```

## Files to modify

- `src/types.ts` — add 4 settings keys + DEFAULT_SETTINGS entries.
- `src/settings.ts` — add `renderOrchestrationSettings()` and a 6th tab in the navigation.
- `src/main.ts` — instantiate `Orchestrator` in `onload()`, register `orchestrator-scan` and `orchestrator-run-next` commands.

## Implementation details

### `src/orchestration/types.ts`

```ts
export type JobStatus = "queued" | "running" | "done" | "failed";

export type JobType =
  | "daily_brief_lite"
  | "youtube_tracker"
  | "transcript_refine";

export interface OrchestrationJob {
  id: string;
  type: JobType;
  status: JobStatus;
  priority: "low" | "normal" | "high";
  created: string;        // ISO 8601
  updated?: string;       // ISO 8601
  inputPaths: string[];
  outputPaths: string[];
  params?: Record<string, unknown>;
  error?: string;
}

export interface WorkflowResult {
  status: "done" | "failed";
  outputPaths?: string[];
  error?: string;
  notes?: string;         // free-form summary appended to the job body on completion
}
```

ID format: `YYYYMMDD-HHmmss-{type}-{rand4}` where `rand4` is 4 lowercase hex chars. Sortable by creation order.

### `src/orchestration/JobStore.ts`

Responsibilities:
- `enqueue(type, params): Promise<OrchestrationJob>` — write a new file to `inbox/`. Body is a minimal Markdown stub including a `## Notes` heading.
- `listInbox(): Promise<OrchestrationJob[]>` — sorted ascending by id.
- `move(job, toStatus): Promise<void>` — physical file move via `app.fileManager.renameFile()`. Status frontmatter updated to match. `updated` set to now.
- `recordError(job, err): Promise<void>` — set `error` in frontmatter, body remains intact.
- `appendNotes(job, lines: string): Promise<void>` — append to the body's `## Notes` section.

Use `updateFrontmatter()` from `frontmatter.ts:14` for safe YAML mutation. Use `app.fileManager.renameFile()` for moves so backlinks update correctly.

Folder paths derived from `settings.orchestrationQueueRoot` + `/inbox` etc.

### `src/orchestration/workflows/Workflow.ts`

Interface only — no concrete implementation in plan 1.

```ts
import { OrchestrationJob, WorkflowResult } from "../types";
import type CruciblePlugin from "../../main";

export interface WorkflowContext {
  plugin: CruciblePlugin;
}

export interface Workflow {
  run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult>;
}
```

### `src/orchestration/Orchestrator.ts`

```ts
class Orchestrator {
  private workflows = new Map<JobType, Workflow>();

  constructor(private plugin: CruciblePlugin, private store: JobStore) {}

  register(type: JobType, workflow: Workflow): void;
  async enqueue(type: JobType, params?: Record<string, unknown>): Promise<OrchestrationJob>;
  async runNext(): Promise<OrchestrationJob | null>;
  async scan(): Promise<{ inbox: number; running: number; done: number; failed: number; recovered: number }>;
}
```

`runNext()`:
1. Pull oldest job from inbox via `JobStore.listInbox()`.
2. If none, show Notice "Orchestrator: nothing to run" and return null.
3. Move to `running/`, set status `running`.
4. Resolve workflow for `job.type`. If not registered → fail immediately with `"No workflow registered for type X"`.
5. `await workflow.run(job, { plugin })`.
6. On success → move to `done/`, status `done`, append `result.notes` to body.
7. On thrown error → move to `failed/`, status `failed`, record error.
8. Show Notice with outcome.

`scan()`:
1. Ensure `inbox/`, `running/`, `done/`, `failed/` all exist (create as needed via `ensureFolder()` from `utils.ts`).
2. Count files in each.
3. **Stale recovery**: any file in `running/` with `updated` older than 1 hour → move back to `inbox/`, status `queued`. Increment `recovered`.
4. Add `_crucible/orchestration/queue` to `lintIgnoredFolders` if not already present, then `saveSettings()`.
5. Show Notice with counts (e.g., `Orchestrator: inbox 3, running 0, done 12, failed 1`).

### `src/orchestration/utils/dates.ts`

```ts
export function todayInTz(tz: string): string;       // "YYYY-MM-DD"
export function nowIso(): string;                     // ISO 8601 with offset
export function newJobId(type: string): string;       // sortable id
```

`todayInTz` uses `Intl.DateTimeFormat('en-CA', { timeZone: tz })` which gives `YYYY-MM-DD` directly.

### `src/orchestration/utils/markdownBlocks.ts`

```ts
export function replaceMarkedBlock(
  content: string,
  markerKey: string,         // e.g. "daily-brief-lite"
  body: string,
  fallbackHeading?: string,  // appended at end if markers missing
): string;
```

Markers are `<!-- orchestration:KEY:start -->` / `<!-- orchestration:KEY:end -->`. If both present, replace between them. If absent and `fallbackHeading` provided, append `\n\n## ${fallbackHeading}\n\n<!-- orchestration:KEY:start -->\n${body}\n<!-- orchestration:KEY:end -->\n` to the end. If absent and no fallback, return content unchanged.

This is used by plan 2; ship it in core because the test-table in this plan can exercise it.

## Settings additions

In `src/types.ts`:

```ts
interface CrucibleSettings {
  // ...existing...
  orchestrationEnabled: boolean;             // default: true
  orchestrationQueueRoot: string;            // default: "_crucible/orchestration/queue"
  orchestrationTimezone: string;             // default: "America/Mexico_City"
  orchestrationYoutubeChannelsNote: string;  // default: "_system/youtube/Channels.md"
}
```

`DEFAULT_SETTINGS` updated accordingly.

In `src/settings.ts`:

- Add `"Orchestrator"` to the tab list.
- New method `renderOrchestrationSettings(containerEl)`:
  - Toggle: `Enabled` (when off, scan/runNext show a clear "orchestrator disabled" Notice).
  - Text: `Queue folder root` (default shown).
  - Text: `Timezone` (free-text IANA name; render warning if `Intl.DateTimeFormat` rejects it).
  - File suggest: `YouTube channels note` (uses existing `FileSuggest` from `suggesters.ts`).

## main.ts wiring

In `onload()` after `chainManager` is created:

```ts
this.jobStore = new JobStore(this.app, this.settings, this);
this.orchestrator = new Orchestrator(this, this.jobStore);
// workflows registered by their respective plans

this.addCommand({
  id: "orchestrator-scan",
  name: "Orchestrator: Scan",
  callback: () => void this.orchestrator.scan(),
});

this.addCommand({
  id: "orchestrator-run-next",
  name: "Orchestrator: Run next",
  callback: () => void this.orchestrator.runNext(),
});
```

## Verification

1. `npm run build` — clean, zero TS errors. (Strict null checks + `noUncheckedIndexedAccess` are enabled; account for them.)
2. Open Obsidian with the plugin reloaded. Open command palette.
3. Run `Crucible: Orchestrator: Scan` on a fresh vault:
   - Folders `_crucible/orchestration/queue/{inbox,running,done,failed}` are created.
   - Notice shows `inbox 0, running 0, done 0, failed 0`.
   - `lintIgnoredFolders` now contains `_crucible/orchestration/queue`.
4. Run `Crucible: Orchestrator: Run next` with empty inbox → Notice "nothing to run". No errors.
5. Manually drop a malformed job into `inbox/` (no `type` field) → `Run next` moves it to `failed/` with the error in frontmatter.
6. Manually create a file in `running/` with `updated` set to 2 hours ago → `Scan` moves it back to `inbox/` and reports `recovered: 1`.
7. Open Settings → Orchestrator tab. All four fields render. Changing the timezone to invalid string shows the warning.
8. No regressions: open Configure, Automate, AI, Lint, Commands tabs — all still render.

## Out of scope (deferred to later plans)

- Workflow implementations (plans 2/3/4).
- A `run all` command.
- Auto-detection of `transcript_status: raw` notes in `scan()`.
- HITL review folder or workflow.
- Monthly archival of `done/` and `failed/`.
