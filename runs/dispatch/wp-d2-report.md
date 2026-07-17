# WP-D2 Execution Report — Ingestion dashboard section decomposition

## Summary

`src/ingestionDashboard.ts` shrank from 1362 lines to **384 lines** and now holds only
lifecycle/registry logic: `mount`/`unmount`, `registerListeners`, `relevantSignature`,
`createSectionHeader`/`buildSection`, the sections map, `setSectionCount`/`setSectionMeta`,
and the `refresh`/`refreshAll`/`renderSection` dispatch. Every section's render logic and
per-section state moved into `src/ingestion/sections/*`, rendering against a narrow
`DashboardHost` seam declared in `src/ingestion/render/types.ts`. All four gates pass.
Zero behavior change — same sections, same order, same controls/listeners/debounce
routing, same CSS classes/DOM shape.

## Final module list (line counts)

| File | Lines | Contents |
|---|---:|---|
| `src/ingestionDashboard.ts` | 384 | controller: lifecycle, listeners, registry, dispatch |
| `src/ingestion/render/types.ts` | 157 | `SectionId`, `IntakeKind`, `DashboardHost`, row types (unchanged + additions) |
| `src/ingestion/render/cells.ts` | 150 | shared DOM cell/button helpers (existing 4 + 6 moved) |
| `src/ingestion/sections/queueMonitor.ts` | 228 | panic switch + jobs-table render |
| `src/ingestion/sections/intake.ts` | 133 | blog + YouTube intake tables, enqueue-intake button trio, button state |
| `src/ingestion/sections/controlCenters.ts` | 111 | blog + channel control centers, `blogFilter`/`channelFilter` closures |
| `src/ingestion/sections/queueControls.ts` | 107 | WP-D1's Queue controls section (global + per-type strip) |
| `src/ingestion/sections/youtubeWithoutMetadata.ts` | 92 | captures-without-metadata table, enqueue cells/buttons |
| `src/ingestion/sections/orphanedAttachments.ts` | 91 | orphan table, delete/cleanup-all, `orphanedAttachmentsCache` closure |
| `src/ingestion/sections/uncapturedPosts.ts` | 81 | uncaptured-posts table, ingest button |
| `src/ingestion/sections/uncapturedVideos.ts` | 60 | uncaptured-videos table, `uncapturedVideosCache` closure + `uncapturedQueueItems` |
| `src/ingestion/sections/ignored.ts` | 35 | ignored blogs / videos tables |
| `src/ingestion/sections/transcripts.ts` | 34 | unrefined transcripts table |
| `src/ingestion/sections/clippings.ts` | 29 | unprocessed clippings table |

`wc -l src/ingestionDashboard.ts` → **384** (target ≤ ~600, met with margin).

## `DashboardHost` interface as landed

```ts
// src/ingestion/render/types.ts
export interface DashboardHost {
	readonly plugin: CruciblePlugin;
	readonly app: App;
	readonly container: HTMLElement;
	refresh(id: SectionId): Promise<void>;
	createSectionHeader(
		card: HTMLElement,
		title: string,
		description: string,
		defaultCollapsed: boolean,
	): { heading: HTMLElement; countEl: HTMLElement; metaEl: HTMLElement };
	registerSection(ctx: SectionContext): void;
	setSectionCount(id: SectionId, n: number): void;
	setSectionMeta(id: SectionId, text: string): void;
	uncapturedQueueItems(): EnrichmentQueueItem[];
}
```

`IngestionDashboardUI` builds one `DashboardHost` object literal in its constructor whose
methods delegate to its own (still-private) methods/fields, so the controller's internals
stay encapsulated while the seam stays structurally narrow. Section modules only ever call
`host.*`; the controller, conversely, calls each section module's own exported functions/
factory-returned methods directly (not through the host) — the seam is one-directional,
sections→controller.

### Deviation from the brief's suggested minimal seam

The brief's suggested field list was "the plugin, the app, a `refresh(id)` hook, the
count/meta setters ..., and `uncapturedQueueItems()`". I added three more fields —
`container`, `createSectionHeader`, and `registerSection` — because scope point 2
explicitly names `buildQueueControlsSection`/`renderQueueControls` (and, by the same
pattern, `buildQueueMonitorSection`/`renderQueueMonitor`) as things to move wholesale into
`queueControls.ts`/`queueMonitor.ts`. Both builders construct their own card DOM off
`this.container`, call `this.createSectionHeader(...)`, and register their `ctx` into
`this.sections`. Grepping their bodies confirmed these are the only three additional
touches beyond the brief's minimal list, so the seam widened only as far as that move
required it to.

## Deviations / notable decisions

- **`uncapturedQueueItems` stays a host method, cache moves to the section.** Per the
  brief's own prediction: `uncapturedVideosCache` lives in `uncapturedVideos.ts`'s closure,
  but `uncapturedQueueItems()` is exposed on `DashboardHost` (delegating to the section
  factory instance) because `queueControls.ts` calls it in three places
  (`src/ingestion/sections/queueControls.ts:31,74,101` — initial auto-source enable, the
  Auto-enrich toggle handler, and the per-type-strip callback), and `uncapturedVideos.ts`
  itself calls it once more after each render to refresh the auto-source. Cross-section
  reader confirmed exactly as the brief anticipated.
- **`blogFilter`/`channelFilter`** — grepped for readers outside `renderBlogControl`/
  `renderChannelControl` respectively; none found. Both moved into `controlCenters.ts`'s
  closure (one module, two independent `let` bindings, since the brief groups blog+channel
  control centers into a single file).
- **`orphanedAttachmentsCache`** — grepped; only read by `renderOrphanedAttachments` (write)
  and `renderCleanupAllButton`/`renderDeleteButton` (read), all within
  `orphanedAttachments.ts`. Moved into that module's closure with no counterexample.
- **`intakeButtons` Map** — moved into `intake.ts`'s closure via a `createIntakeSection(host)`
  factory. `mount()` and `registerListeners()` (which stay in the controller) call the
  factory's exposed `renderEnqueueIntakeButton`/`refreshIntakeButton`/`clear` methods
  directly through the controller's own `this.intake` field, not through `DashboardHost`
  (the host seam is sections→controller only; the controller already owns a direct
  reference to every section factory it instantiates).
- **Dead code preserved as-is.** The `renderSection` switch's `case 'queueMonitor'` branch
  was already unreachable before this change — `buildQueueMonitorSection` wires
  `ctx.refresh` directly to `renderQueueMonitor(...)`, bypassing the switch entirely, and
  `queueControls` never had a switch case at all for the same reason. I preserved this
  exactly (now delegating to the imported `renderQueueMonitor`) rather than pruning it,
  since removing dead code wasn't in scope and doing so risked a behavior assumption I
  couldn't fully verify was safe.
- **`renderFileLink`/`renderOpenButton`/`renderEnrichedCell`/`renderIgnoreButton`/
  `renderUnignoreButton`** moved to `src/ingestion/render/cells.ts` per the brief's explicit
  list. `renderFileLink` and `renderOpenButton` now take an `app: App` parameter (cells.ts's
  existing functions are stateless/vault-agnostic; these two need `app.workspace.openLinkText`).
  `renderIgnoreButton`/`renderUnignoreButton` take `app: App` plus an `onIgnored`/`onUnignored`
  callback (replacing the original's direct `this.refresh(otherSectionId)` call) so cells.ts
  stays decoupled from the `SectionId`-keyed registry.
- **Environment fix (not a file-scope change):** `.stylelintrc.json` is gitignored and was
  present in the main worktree (`/home/_shared_code/obsidian-crucible`) but absent from this
  `git worktree`-created checkout, so `npm run lint` failed with a stylelint
  `ConfigurationError` before any of my changes. I copied the file in
  (`cp /home/_shared_code/obsidian-crucible/.stylelintrc.json .`) to make the lint gate
  runnable; it's gitignored so it does not appear in `git status` and is not part of any
  diff. Flagging this in case the sibling `wp-d3-work` worktree has the same gap.

## Gate results (verbatim tails)

### `npm run lint`
```
> obsidian-crucible@1.0.0 lint
> eslint . && stylelint "**/*.css"

(exit 0, no findings)
```

### `npx tsc -noEmit -skipLibCheck`
```
(no output — clean)
```

### `TMPDIR=$(mktemp -d) npm test`
```
✔ targetPath present → key is note:<targetPath> (0.491051ms)
✔ no targetPath, videoId present → key is video:<videoId> (0.111113ms)
✔ empty params → empty string (no dedupe key) (0.064033ms)
✔ two params with same videoId but different targetPaths produce different keys (per-note jobs both enqueue) (0.080435ms)
ℹ tests 230
ℹ suites 0
ℹ pass 230
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 217.043286
```

### `node esbuild.config.mjs production`
```
(no output, exit 0)
```

### Verification greps
```
$ wc -l src/ingestionDashboard.ts
384 src/ingestionDashboard.ts

$ grep -n "renderTableSection\|renderSortableTable" src/ingestionDashboard.ts
(no matches — no section render logic left behind)

$ grep -rn "console\." src --include=*.ts | grep -v "^src/log.ts"
(no matches)
```

## File scope compliance

Only files inside the brief's declared scope were touched:
`src/ingestionDashboard.ts`, `src/ingestion/render/cells.ts`, `src/ingestion/render/types.ts`
(modified), plus 12 new files under `src/ingestion/sections/`. `src/main.ts`,
`DEVELOPMENT.md`, `plans/`, `AGENTS.md`, and `styles.css` are untouched
(`git status --porcelain` confirms — only the files above plus this report and the
pre-existing `runs/dispatch/wp-d2-brief.md` show as changed/untracked).

## Deferred / not done

Nothing deferred. All scope items from the brief were completed.

---

Orchestrator: review the diff and re-run gates before commit.
