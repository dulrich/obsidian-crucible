# TN Code Review Remediation — changes 9c5a971 (Jun 16) → 40105b6 (Jul 4)

Review scope: 13 commits, ~9,085 insertions across 90 files. Features landed: user-configurable
Triggers, blog/RSS enrichment + control centers, Source Eval dashboard (~2.6 kSLOC), job lanes
(user/background), auto-localize retry scheduler, `openai-compatible` provider.

All work packages below are **structure-preserving refactors** — behavior must be identical.
Global verification for every WP: `npm test` (all suites green), `npx tsc --noEmit`, eslint clean.
Any WP that moves code must not change runtime semantics; diff review should show moves + import
updates, not logic edits.

Model guideline legend: `small` = fast/cheap model, mostly mechanical; `mid` = standard coding
model, needs local judgment; `large` = strongest model, cross-cutting design or subtle invariants.

Dependency notes are listed per-WP; unlisted WPs are independent and parallelizable.

---

## WP1 — Extract trigger settings UI out of automate.ts  [BLOCKER]

**Problem:** `src/settings/sections/automate.ts` went 662 → 1,371 lines. The entire trigger
editor (~730 lines) — `renderTriggerListSection`, `renderEditTrigger`, `renderTriggerConditions`,
`renderTriggerCommandArgs`, `renderCommandArgSetting`, `newTrigger*`, `describeTrigger*`,
`getTriggerWarning`, `queueableTriggerCommands`, the `TRIGGER_*` / `GUARD_*` label constants —
is a self-contained feature bolted into the captures/chains file.

**Fix:**
1. Create `src/settings/sections/triggers.ts`: move everything trigger-specific there.
   `renderAutomateSettings` keeps its dispatch (`editingTriggerIndex !== -1 → renderEditTrigger`,
   plus `renderTriggerListSection` in the list view) via imports.
2. Create `src/settings/sections/guardConditionFields.ts`: move the shared guard-condition
   field rendering used by BOTH the chain guard editor and trigger conditions —
   `renderGuardConditionFields`, `renderPropertyNameSetting`, `renderValueKindSetting`,
   `renderGuardValueSet`, `renderGuardValueSetting`, `guardValuePlaceholder`, `guardValueKind`,
   `defaultGuardValueKind`, `normalizeGuardConditionForType`, `isPropertyValueCondition`,
   `GUARD_TYPE_LABELS`, `GUARD_VALUE_KIND_LABELS`.
3. automate.ts imports from both; should land back near ~650 lines.

**Acceptance:** automate.ts < 700 lines; no logic changes (pure move + imports); settings UI
behaves identically (chains guard editor and trigger editor both render).

**Size:** ~0.9 kSLOC moved, ~0.05 kSLOC new (imports/exports). **Model/effort:** mid / low —
mechanical extraction, but the extractor must resist "improving" code while moving it.

---

## WP2 — Push blog-specific logic behind FeedSource hooks  [BLOCKER]

**Problem:** `src/orchestration/workflows/FeedTrackerWorkflow.ts` (generic over
`FeedSource<Entry, Item>`) grew two blog-only branches guarded by
`if (this.source.kind === 'blogs')`, each casting `item as unknown as RemotePost`:
1. the post-fetch persistence loop (before the no-new early return), and
2. the digest bullet writer (`buildBlogBulletSuffix` + `persistBlogMetadataIfMissing`).
Feature logic leaking into the shared path; casts defeat the generic contract.

**Fix:** Add optional members to the `FeedSource` interface (`src/orchestration/utils/feedSources.ts`):
- `itemBulletSuffix?(item: Item): string` — returns `''`/undefined for youtube.
- `persistItemMetadata?(plugin: CruciblePlugin, item: Item, entryName: string): Promise<void>`
  — implemented only by `BLOGS_FEED_SOURCE`, wrapping the existing
  `findExistingBlogMetadataNote` / `ensureBlogMetadataNote` skip-if-exists logic (currently
  `persistBlogMetadataIfMissing` in the workflow — move it into the blogs source).
The workflow calls the hooks when present; delete both `kind === 'blogs'` branches and all
`as unknown as RemotePost` casts from the workflow.

**Acceptance:** `FeedTrackerWorkflow.ts` contains no `source.kind` checks and no casts;
`tests/blogsEnrichment.test.mjs` + `tests/feedSeenSet.test.mjs` green.

**Size:** ~0.12 kSLOC changed. **Model/effort:** mid / medium — small diff but must respect the
generic typing and the "persist before early return" ordering (documented in the code).

---

## WP3 — Consolidate the job-lane model (4 duplicate copies)

**Problem:** `defaultLaneForPriority` is defined in `src/orchestration/FileJobBackend.ts:54`
and `src/orchestration/JobStore.ts:286`; `laneRank` in `FileJobBackend.ts:47` and
`src/orchestration/MemoryJobQueue.ts:191`; `LANE_RANK` record in `JobStore.ts:22`; inline
`options.priority === 'high' ? 'user' : 'background'` in `src/orchestration/MemoryJobBackend.ts:41`.

**Fix:** One canonical home — either `src/orchestration/lanes.ts` or alongside `JobLane` in
`src/orchestration/types.ts`: export `LANE_RANK`, `laneRank`, `defaultLaneForPriority`,
`parseLane`. Update all five call sites. Also in `FileJobBackend.enqueue`, remove the redundant
nested `if (promotesLane || promotesPriority)` inside the block already guarded by that exact
condition (the inner check is always true).

**Acceptance:** single definition of each lane helper repo-wide (grep clean);
`tests/jobStoreQueue.test.mjs`, `tests/memoryJobQueue.test.mjs` green.

**Size:** ~0.08 kSLOC. **Model/effort:** small / low — mechanical.

---

## WP4 — Deduplicate the "control center" dashboard sections

**Problem:** `src/ingestionDashboard.ts` (already >1k lines; 1,106 → 1,331 this period):
`renderBlogControl` and `renderChannelControl` are ~65-line structural twins — identical
all/tracked/untracked filter-button row, identical filter application, six near-identical
columns (name-with-link, total, ingested %, ignored %, uncaptured %, tracked?). The same
filter-button pattern appears a third time in `sourceEvalDashboard.renderScoreFilters`.
The compute side (`src/ingestion/data/blogs.ts` `computeBlogControlRows` vs
`src/ingestion/data/channels.ts` `computeChannelControlRows`) also shares the
agg-map / universe / ignored-ingested-uncaptured partition skeleton.

**Fix (renderer, required):** extract one generic control-center renderer (suggested:
`src/ingestion/render/controlCenter.ts`) parameterized by
`{ rows, filter, onFilterChange, nameColumn, countFields: { total, ingested, ignored, uncaptured },
extraColumns? }`. Both dashboard sections call it; per-section state (`blogFilter`,
`channelFilter`) stays in the controller. Reuse for the eval-dashboard filter row if it falls
out naturally; don't force it.
**Fix (compute, optional stretch):** extract the shared partition-count step
(universe → {ingested, ignored, uncaptured}) into a helper used by both compute functions.
Leave the source-specific scanning loops alone — they differ genuinely.

**Acceptance:** one filter-row/table implementation; both sections render identically
(columns, sort, filter behavior); ingestionDashboard.ts shrinks by ≥100 lines.

**Size:** ~0.25 kSLOC changed. **Model/effort:** mid / medium — parameterization judgment
(what to share vs. leave) matters more than volume.

---

## WP5 — Extract AutoLocalizeScheduler from main.ts

**Problem:** `src/main.ts` (1,182 → 1,367) inlines a ~120-line retry state machine:
`AutoLocalizeState`, `AutoLocalizeSource`, four `AUTO_LOCALIZE_*` constants, and six methods
(`scheduleAutoLocalize`, `scheduleAutoLocalizeState`, `runScheduledAutoLocalize`,
`autoLocalizeSourceEnabled`, `autoLocalizeSourcesEnabled`, `moveAutoLocalizeTimer`,
`clearAutoLocalizeTimers`). The tell: `tests/autoLocalizeScheduler.test.mjs` must esbuild-bundle
**all of main.ts** with a ~40-export Obsidian stub just to reach this logic.

**Fix:** create `src/autoLocalizeScheduler.ts` exporting an `AutoLocalizeScheduler` class with
injected dependencies:
```ts
{ resolveFile(path): TFile-like | null; isLocked(path): boolean; isMaterializing(): boolean;
  sourceEnabled(source: 'create' | 'edit'): boolean; localize(file): Promise<void>; }
```
Public surface: `schedule(file, source)`, `handleRename(oldPath, newPath)`,
`handleDelete(path)`, `dispose()`. main.ts constructs it in `onload` and forwards vault events
(~10 lines). Rewrite `tests/autoLocalizeScheduler.test.mjs` as a direct unit test of the class
(fake timers or short real delays; no esbuild bundling of main.ts, no Obsidian mega-stub).
Preserve exact timing/retry semantics: create=2500ms, edit=3000ms, retry=1000ms, max-age=15s,
retry only while size==0 / locked / materializing, rename re-keys, delete clears.

**Acceptance:** main.ts has no `autoLocalize*` members beyond construction/wiring; new unit
test covers create/edit debounce, retry-until-max-age, rename re-key, delete cancel, disabled
sources; old bundling test removed.

**Size:** ~0.15 kSLOC moved + ~0.15 kSLOC test rewrite. **Model/effort:** large / medium —
timer state machine + test redesign; subtle invariants (source-set union, max-age anchor at
first schedule, path re-keying) must survive the move exactly.

---

## WP6 — Consolidate duplicated shape/format helpers

**Problem (all copies added or third-copied this period):**
- `walkMarkdown` ×5: `src/orchestration/utils/blogsApi.ts`, `src/ingestion/data/blogs.ts`,
  `src/sourceEval/captureIndex.ts`, `src/sourceEval/signals.ts`, `src/sourceEval/export.ts`
- `yamlString` ×3: `src/orchestration/utils/youtubeApi.ts:523`, `blogsApi.ts:37`,
  `imageMetadata.ts:187`
- `stringProp` ×3 (`ingestion/data/blogs.ts`, `sourceEval/captureIndex.ts`, `sourceEval/export.ts`);
  `numberProp` ×2 (`captureIndex.ts`, `export.ts`); `dateProp`/`firstString` singletons that
  belong with them
- `normalizeTag` fresh copies in `sourceEval/{metrics,export,ratingPanel}.ts` and
  `triggers/guardEval.ts` (pre-existing copies in `frontmatter.ts`, `search/chunker.ts`)
- `ratio` / `countWithPct` / `formatPct` duplicated between `ingestionDashboard.ts` and
  `sourceEvalDashboard.ts`
- weeks-per-month constant `365.2425 / 12 / 7` in both `sourceEvalDashboard.weeklyBudget()` and
  `sourceEval/metrics.ts` `budgetShare()`

**Fix:** canonical homes, then delete copies:
- `walkMarkdown` + `yamlString` → `src/utils.ts` (or a tiny `src/vaultWalk.ts` / `src/yaml.ts`
  if utils.ts is crowded — implementer's call, one home each).
- Frontmatter coercers (`stringProp`, `numberProp`, `dateProp`, `firstString`, `stringList`) →
  one shared module (suggested `src/frontmatterValues.ts`).
- `normalizeTag`: adopt the `triggers/guardEval.ts` semantics (`#`-strip) as canonical where
  behavior matches; note `sourceEval` copies also lowercase — keep a `normalizeTagLower` or
  parameterize; do NOT silently change comparison semantics anywhere.
- `formatPct` / `countWithPct` / `ratio` → `src/ingestion/render/format.ts`.
- Budget math: keep only in `sourceEval/metrics.ts`; export a `weeklyBudgetWords(settings)`
  helper the dashboard calls.

**Acceptance:** grep shows one definition per helper (modulo the documented tag-case split);
all suites green — especially `sourceEvalMetrics`, `sourceEvalExport`, `sourceEvalCaptureIndex`,
`blogsEnrichment`.

**Size:** ~0.3 kSLOC across ~12 files. **Model/effort:** mid / medium — wide but shallow;
the only trap is helpers with same name / slightly different semantics (tag case, trim rules).
The implementer must diff each copy before unifying.

---

## WP7 — Remove Pick-then-cast false boundaries in sourceEval

**Problem:** `src/sourceEval/export.ts` accepts `plugin: Pick<CruciblePlugin, 'settings'>` then
casts `plugin as CruciblePlugin` four times (lines ~127–130, ~309) to call
`loadConfiguredBlogs` / `loadConfiguredChannels` / `computeBlogControlRows` /
`computeChannelControlRows`. `src/sourceEval/captureIndex.ts` declares
`CaptureIndexPluginLike` then casts it away at line 32 for the same reason.

**Fix (pick one, apply consistently):**
- (a) Widen: functions take `CruciblePlugin`; delete the Pick types and every cast. Simplest.
- (b) Narrow honestly: change `loadConfiguredBlogs`/`loadConfiguredChannels` (and the two
  control-row compute functions) to accept the minimal `{ settings: ... }` interface they use,
  and thread it through. Only worth it if tests currently rely on passing fake plugins — check
  `tests/sourceEvalExport.test.mjs` / `sourceEvalCaptureIndex.test.mjs` first; if they construct
  minimal plugin objects, (b) is the right call.

**Acceptance:** zero `as CruciblePlugin` casts in `src/sourceEval/`; tests green without new casts.

**Size:** ~0.1 kSLOC. **Model/effort:** mid / low-medium — type plumbing; direction (a vs b)
determined by what the existing tests pass in.

---

## WP8 — Narrow the sortable-table context type (kill `asSectionContext`)

**Problem:** `src/ingestion/render/section.ts` / `sortableTable.ts` only use `ctx.sort` and
`ctx.refresh`, but the parameter type is the full ingestion `SectionContext` (including
`id: SectionId`, an ingestion-dashboard-specific union, plus `title`/`description`/`countEl`/
`metaEl`). `src/sourceEvalDashboard.ts:553` therefore bridges with
`ctx as unknown as SectionContext`.

**Fix:** in `src/ingestion/render/types.ts` add
`interface TableStateContext { sort: SortState | null; refresh: () => Promise<void> | void; }`;
`SectionContext extends TableStateContext`. Change `renderTableSection` / `renderSortableTable`
params to `TableStateContext`. Delete `asSectionContext` and the cast; sourceEval's own section
context satisfies the type structurally.

**Acceptance:** no `as unknown as SectionContext` anywhere; both dashboards compile and sort.

**Size:** ~0.05 kSLOC. **Model/effort:** small / low.

---

## WP9 — Remove magic `channelId` → youtube-channel value-kind inference

**Problem:** `src/settings/sections/automate.ts` (`guardValueKind` / `defaultGuardValueKind`):
when a guard condition's property name is exactly `channelId`, the value kind is silently
inferred/persisted as `youtube-channel`. Hidden data-shape assumption; the UI already has an
explicit "Value type" dropdown.

**Fix:** delete the inference from the read path (`guardValueKind` returns
`condition.valueKind ?? 'text'`). Acceptable UX nicety: when the user *types* `channelId` into
the property field and no kind is set yet, preselect the dropdown to `youtube-channel` as a UI
default that still writes through the normal dropdown flow (the existing
`renderPropertyNameSetting` refresh hook). No persisted state may be derived from the property
name at load time. Migration concern: any existing saved conditions relying on the inference —
if `defaultGuardValueKind` ever persisted `valueKind`, saved data is fine; verify, and if bare
`channelId` conditions exist without `valueKind`, they degrade to a text input (acceptable).

**Acceptance:** grep shows no `'channelId'` literal in automate/guardConditionFields code except
placeholder text; guard evaluation unaffected (`tests/guardEval.test.mjs` green — evaluation
never used valueKind).

**Size:** ~0.03 kSLOC. **Model/effort:** small / low. Depends on WP1 landing first (same code
moves to `guardConditionFields.ts`) — sequence after WP1 or fold into it.

---

## WP10 — Index metadata notes once per run (kill O(rows × vault) scans)

**Problem:** `findExistingBlogMetadataNote` (`src/orchestration/utils/blogsApi.ts`) walks the
entire blog-metadata tree per call — called per fetched item per tracker run
(`FeedTrackerWorkflow.persistBlogMetadataIfMissing`) and per row in
`computeUncapturedPostRows` (`src/ingestion/data/uncaptured.ts`). Same shape for
`findExistingMetadataNote` (per video) in `computeUncapturedVideoRows`. With a large backlog
this is quadratic in vault size.

**Fix:** add index builders next to the finders (pattern already exists —
`buildYtMetadataFrontmatterMap` in `src/sourceEval/export.ts`):
`buildBlogMetadataNoteIndex(app, root): Map<postId, TFile>` (single walk; keep the
disk-read fallback for cache-missed just-created files ONLY inside the write path's
existence check, where correctness needs it). Callers that loop build the index once and look
up; `ensureBlogMetadataNote`'s under-lock single check can stay as-is (it's one call per write
and its lock semantics depend on a fresh check). Same treatment for the video metadata finder
in the uncaptured-rows loop.

**Acceptance:** no per-row full-tree walks in `FeedTrackerWorkflow` or
`computeUncaptured{Post,Video}Rows`; `ensureBlogMetadataNote`'s locked fresh-check preserved;
`tests/blogsEnrichment.test.mjs` green.

**Size:** ~0.15 kSLOC. **Model/effort:** large / medium — the freshness/lock interaction is the
one place a naive cache introduces a real race (index staleness vs. the resource-locked write
path must be reasoned about explicitly).

---

## WP11 — Drop the `CommandArgSchema[] | ChainCommandOptions` union

**Problem:** `ChainManager.registerInternalCommand(id, fn, schemaOrOptions?)` accepts either a
bare schema array (legacy) or the new options object. All call sites are in-repo; the union is
transitional churn that muddies the contract.

**Fix:** migrate remaining array-form call sites (mostly in `src/main.ts` `register(...)` calls)
to `{ schema: [...] }`; change the signature to `options?: ChainCommandOptions`; remove the
`Array.isArray` branch.

**Acceptance:** signature takes only `ChainCommandOptions`; `tests/chainCycle.test.mjs` +
`tests/metadataTriggerActions.test.mjs` green.

**Size:** ~0.1 kSLOC, ~15–30 call sites. **Model/effort:** small / low — mechanical.

---

## WP12 — DECISION (not implementation): bullet-comment metadata round-trip

`buildBlogBulletSuffix` / `parseBlogBulletMeta` (`src/orchestration/utils/blogs.ts`) URL-encode
enrichment into an HTML comment on each digest bullet. Since every fetched post now also gets a
persisted metadata note — and `computeUncapturedPostRows` already prefers metadata-note fields,
falling back to the comment — the comment channel is arguably redundant going forward. Deleting
it would remove an encode/parse pair and a versioned wire format from digests. Costs: legacy
digests written before metadata persistence lose enrichment on re-parse; metadata notes can be
deleted by the user. **Owner call needed before scheduling any work.** If approved: remove
suffix emission + parse fallback, ~0.1 kSLOC deletion, small/low.

---

## Orchestration summary

| WP | Title | Size (kSLOC) | Model / effort | Depends on |
|----|-------|--------------|----------------|------------|
| 1  | Extract triggers settings UI | 0.9 (move) | mid / low | — |
| 2  | FeedSource hooks for blog logic | 0.12 | mid / medium | — |
| 3  | Lane model consolidation | 0.08 | small / low | — |
| 4  | Control-center dedupe | 0.25 | mid / medium | — |
| 5  | AutoLocalizeScheduler extraction | 0.3 (incl. test) | large / medium | — |
| 6  | Helper consolidation | 0.3 | mid / medium | best after 1, 2 |
| 7  | sourceEval Pick/cast cleanup | 0.1 | mid / low-medium | — |
| 8  | Table context narrowing | 0.05 | small / low | — |
| 9  | Magic channelId removal | 0.03 | small / low | after/with 1 |
| 10 | Metadata-note index | 0.15 | large / medium | after 2 |
| 11 | registerInternalCommand union | 0.1 | small / low | — |
| 12 | Bullet-comment decision | — (0.1 if approved) | owner decision | — |

Parallel-safe batches: {1}, {2, 3, 5, 7, 8, 11} in parallel, then {4, 6, 9, 10}.
WPs 1, 4, 5, 6 all touch large files — avoid running two of them concurrently against
`ingestionDashboard.ts` or `automate.ts`.

## Positives to preserve (do not "fix")

- `triggers/guardEval.ts` unification of chain-guard and trigger-condition semantics.
- Founding/user trigger split in `TriggerRegistry` with the `triggerAdapter` boundary.
- Thin workflows (`ChainRunWorkflow`, `YoutubeChannelEnrich*`), sweep chunking with documented
  rationale.
- Presence-based (never length-based) blog body detection and its comments.
- `openai-compatible` provider folding fixed vendor URLs into one `apiBaseUrl`.
