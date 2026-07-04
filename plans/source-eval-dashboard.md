# Source Eval Dashboard — design plan

> **Design-only deliverable.** Written for an Opus orchestrator to implement directly or hand batches to subagents. Batches 1–4 have explicit boundaries and can be parallelized where noted.
> **Step 0 (repo convention):** copy this plan to `plans/source-eval-dashboard.md` before implementing.

## Context

The Ingestion Dashboard answers "what have I captured / what's pending". Nothing answers **"which sources are worth tracking"** or produces labeled data for a future classifier that tags incoming items **Urgent** / **Important** per blog or YouTube channel. This plan adds a second dashboard, **Source Eval Dashboard**, with two jobs:

1. **Source scorecard** — per-source value metrics from existing vault signals, so add/remove-tracking decisions are data-driven against a reading budget.
2. **Labeling queue** — an embedded-note rating UI that writes 2-axis labels (`eval-importance` 0–5, `eval-urgent`) into capture-note frontmatter, plus a JSONL training-data export restricted to intake-time features.

### Decisions made with the user (2026-07-03)

- **Rating scheme:** 2-axis — numeric importance 0–5 + urgent toggle. Frontmatter keys: `eval-importance`, `eval-urgent`, `eval-tags`, `eval-rated` (date).
- **"Target wordcount for scoping"** = a **reading budget per period** (words/week setting); the scorecard shows each source's output as a share of that budget.
- **Label scope:** v1 rates **captured notes** only, but the schema/export is designed so uncaptured intake items (metadata notes) can be labeled later without migration.
- **Quick-tags:** `gold`, `goldmine`, `revisit`, `reference` (written into the normal `tags:` list so history and new ratings share one vocabulary). Negatives are expressed as importance 0–1, not a slop tag.
- **Tag semantics (user clarified 2026-07-03):** `gold` = high-quality content; `goldmine` = the item contains a significant number of curated links worth exploring. They are *different axes* — goldmine is a discovery/link-richness signal, not a quality signal. Metrics, score weights, and weak labels must keep them separate (see §3 and §5).

## Verified vault & code facts (exploration results)

**Vault data** (the dev `vault/` in-repo is the real working vault):
- 1,674 capture notes under `daily/day/YYYY-MM-DD/<Title>.md`. Frontmatter coverage: `word-count` 1659, `read` (bool) 1583, `author` (wiki-link) 1583, `source` 1582, `post-id` 1580, `published` 1582, `yt-video-id` 605, `yt-metadata` 605 (link to `_yt_metadata/<chan>/<videoId>`).
- Tags in use: `clippings` 1581, `blog` 655, `refined` 443, `transcript` 442, `post` 199, `news` 41, `goldmine` 34, `gold` 27, `3-2-1` 13, `key` 5, `quiz-me` 4, `revisit` 1, `probably-slop` 1. Note `gold` (quality) and `goldmine` (many curated links worth exploring) are distinct axes — e.g. Lenny Rachitsky: 1 gold / 9 goldmine; James Pethokoukis: 0 gold / 9 goldmine; Mark Manson: 7 gold / 0 goldmine.
- Monthly notes `daily/month/YYYY-MM.md` contain a `# Observations` section: top-level bullet = wiki-link to a note, indented bullets = captured quotes. 4 months, 60 distinct notes, 64 links so far.
- Registries: `core/Tracked Blogs.md` (~30 rows: Name, Link, Method, Tags, Priority, Body), `core/Tracked YouTube Channels.md` (~20 rows: Channel, ID, Tags, Priority).
- Ignored IDs: `_crucible/orchestration/ignored.md` (201 video IDs + blog IDs).
- Metadata notes: `_blog_metadata/<blog>/<date>-<slug>.md` → `post-id`, `blog`, `word-count`, `kind`, `has-body`; `_yt_metadata/<chan>/<videoId>.md` → `videoId`, `channelId`, `channelTitle`, `duration_seconds`, `viewCount`, `likeCount`, `publishedAt`.
- Link registry `_crucible/link_registry/*.md`: link-records with `source_notes` (inbound reuse; deferred to Later).

**Code to reuse:**
- Dashboard pattern: `src/ingestionDashboardView.ts` (37-line ItemView shell) + `src/ingestionDashboard.ts` (UI controller) + data modules `src/ingestion/data/*` + render helpers `renderTableSection` (`src/ingestion/render/section.ts`), `renderSortableTable` (`src/ingestion/render/sortableTable.ts`), `Column<T>`/`SectionContext` (`src/ingestion/render/types.ts`).
- Per-source rollups: `computeBlogControlRows` (`src/ingestion/data/blogs.ts`), `computeChannelControlRows` (`src/ingestion/data/channels.ts`) — tracked/ingested/ignored/uncaptured counts per source.
- ID plumbing: `loadConfiguredBlogs` / `loadConfiguredChannels`, `buildBlogsSeenIdSet` / `buildYoutubeSeenIdSet`, `feedSeenExtraSkipPrefixes` (`src/orchestration/utils/feedIntake.ts`); `buildBlogCanonHostMap`, `postIdFromUrl` (`src/orchestration/utils/blogs.ts`); `loadIgnoredBlogIds` / `loadIgnoredVideoIds` (`src/orchestration/utils/ignoredIds.ts`).
- Frontmatter writes: `updateFrontmatter(app, file, update)` (`src/frontmatter.ts`) wrapping `processFrontMatter`.
- View registration: `main.ts:186` (`registerView`) and `activateIngestionDashboardView` (`main.ts:1191`) — copy this pattern.
- Settings: sections in `src/settings/sections/`; existing `ingestionReadingWpm: 250`.
- No `MarkdownRenderer` usage yet — the embed view is its first use (`MarkdownRenderer.render(app, md, el, sourcePath, component)`).

## Architecture

New files (mirrors the ingestion split):

```
src/sourceEvalDashboardView.ts          # ItemView shell, view type 'crucible-source-eval-dashboard', icon 'scale'
src/sourceEvalDashboard.ts              # SourceEvalDashboardUI controller (sections, refresh, debounce)
src/sourceEval/types.ts                 # SourceKey, CaptureRecord, SourceEvalRow, EvalLabel, TrainingExample
src/sourceEval/captureIndex.ts          # capture-note → source attribution (core new primitive)
src/sourceEval/signals.ts               # observations scanner, eval-label reader
src/sourceEval/metrics.ts               # pure per-source metric computation (unit-testable)
src/sourceEval/ratingQueue.ts           # labeling-queue selection logic (pure)
src/sourceEval/ratingPanel.ts           # embed view + rating UI component
src/sourceEval/export.ts                # training-data JSONL export
src/settings/sections/sourceEval.ts     # settings section
```

Reuse `src/ingestion/render/*` helpers as-is; extend `SectionContext`/`Column` generics only if a signature forces it (they're already generic — expect no changes).

### 1. Capture index (`src/sourceEval/captureIndex.ts`)

The one primitive nothing else provides: **capture note → source attribution**.

```ts
type SourceKey = `blog:${string}` | `youtube:${string}`;   // blogKey / channelId
interface CaptureRecord {
  file: TFile;
  source: SourceKey | null;        // null = unattributed (rendered under "(unattributed)")
  wordCount: number | null;
  read: boolean;
  tags: string[];                  // via getAllTags, '#' stripped
  created: number; published: number | null;
  isTranscript: boolean; isRefined: boolean;
  label: EvalLabel | null;         // parsed eval-* frontmatter
}
```

Walk `settings.dailyFolder` (same walk pattern as `computeUnrefinedTranscriptRows` in `src/ingestion/data/transcripts.ts`, minus the tag filter). Attribution, per memory rule *frontmatter only, never scan body*:
- `yt-video-id` present → resolve `channelId` by locating the video's metadata note under `orchestrationYoutubeMetadataRoot` (build one videoId→channelId map per refresh by walking `_yt_metadata`, exactly like `computeChannelControlRows` does). Fallback: parse channel folder from the `yt-metadata` link path.
- else `post-id`/`source` present → `postIdFromUrl(source, { hostRules })` with `buildBlogCanonHostMap(configuredBlogs)`, then match to a blogKey the same way `computeBlogControlRows` builds its name/host maps. Extract that key-resolution logic from `blogs.ts` into a small shared helper rather than duplicating (e.g. export `normalizeBlogName`/`metadataBlogKey` or a `resolveBlogKey(fm, hostRules, registry)` from a shared module).
- neither → `source: null`.

### 2. Signals (`src/sourceEval/signals.ts`)

- **Observations scan:** for each note in `settings.monthlyFolder`, slice the `# Observations` heading section (use `app.metadataCache.getFileCache().headings` to find section bounds, then read the file), collect top-level wiki-link targets + count of indented quote bullets per link. Resolve links via `app.metadataCache.getFirstLinkpathDest`. Output: `Map<notePath, { months: number; quotes: number }>`.
- **Label reader:** parse `eval-importance` (number 0–5), `eval-urgent` (bool), `eval-rated` (string date) from frontmatter into `EvalLabel`.

### 3. Metrics (`src/sourceEval/metrics.ts`) — pure functions, no `App`

Input: `CaptureRecord[]`, control rows (for funnel counts), observations map, settings. Output per source:

```ts
interface SourceEvalRow {
  source: SourceKey; name: string; type: 'blog' | 'youtube'; tracked: boolean;
  captures: number;                    // capture notes attributed
  ingestRate: number | null;           // ingested/(ingested+ignored) from control rows; null if no decisions
  uncaptured: number;                  // backlog from control rows
  readRate: number | null;             // read:true / captures
  refinedRate: number | null;          // refined / transcript captures (yt only)
  goldRate: number;                    // gold-tagged / captures (quality signal only)
  goldmineCount: number;               // goldmine-tagged captures (link-richness/discovery — separate axis, not quality)
  obsCount: number; obsQuotes: number; // from Observations
  wordsPerWeek: number;                // captured words over lookback window, per week
  budgetShare: number | null;          // wordsPerWeek / budget setting
  valueDensity: number | null;         // (goldCount + obsCount) per 10k captured words
  score: number;                       // composite, recency-decayed
  labeled: number; labeledPct: number; // eval-label coverage
}
```

**Composite score** (make weights a single exported const so they're tunable): each capture contributes `w_read·read + w_gold·gold + w_goldmine·goldmine + w_obs·min(quotes,3) + w_deep·(3-2-1|key|quiz-me) + w_label·(importance/5) + w_urgent·urgent`, decayed by `exp(-ln2·ageDays/halfLifeDays)` (half-life setting, default 90d); source score = sum / recency-decayed capture count, blended with ingest rate. Suggested starting weights: read 1, gold 3, goldmine 1 (discovery value — deliberately low; it measures link-richness, not content quality), obs 2 (+1/quote up to 3), deep 2, label importance 0–3, urgent +1. Document in code that weights are provisional until the classifier exists.

### 4. Dashboard UI (`src/sourceEvalDashboard.ts`)

Follow `IngestionDashboardUI` structure (sections map, `buildSection`, debounced metadata-cache refresh with the same relevant-signature guard idea; SCAN_DEBOUNCE 1000ms is fine for everything here). Sections:

1. **Source scorecard** — sortable table (default sort: score desc). Filter buttons all|tracked|untracked|blogs|youtube. Columns: Source (link), Type, Tracked?, Captures, Ingest %, Read %, Gold, Goldmine, Obs, Words/wk, Budget %, Density, Score, Labeled %. Header meta line: total words/wk vs budget (e.g. "41k of 60k words/wk budget"). Reuse `renderTableSection`/`renderSortableTable`/`countWithPct`.
2. **Labeling queue** — selector row: scope dropdown (`Recent — all` | `Blog: <name>` | `Channel: <name>`, populated from scorecard rows) + "unlabeled only" toggle (default on). Below it the **rating panel** (`ratingPanel.ts`):
   - Note title (internal link, click opens note) + source/date/word-count meta line.
   - Embedded preview: `MarkdownRenderer.render` of the note body (strip frontmatter) into a max-height scrollable div; pass the dashboard `Component` for lifecycle.
   - Rating controls: importance buttons `0…5`, `Urgent` toggle, quick-tag toggles `gold` `goldmine` `revisit` `reference`, `Save & next`, `Skip`.
   - Save writes via `updateFrontmatter`: `eval-importance`, `eval-urgent` (only when true, else delete key), `eval-rated: YYYY-MM-DD`, and merges quick-tags into `tags`. Then advances to next queue item. Pre-populate controls from existing labels when re-rating.
   - Queue order (`ratingQueue.ts`, pure): unlabeled first, newest `created` first, within selected scope.
3. **Label coverage** — small table per source: labeled/captures, mean importance, % urgent — doubles as training-set balance check.

### 5. Training-data export (`src/sourceEval/export.ts`)

Command `Crucible: Export source eval training data` + button on the dashboard. Writes `_crucible/source_eval/training-YYYY-MM-DD.jsonl` (folder configurable). One line per **labeled** capture:

```json
{"id":"<post-id|yt-video-id>","source_type":"blog|youtube","source_key":"...","source_name":"...",
 "source_tags":["#substack"],"source_priority":"normal",
 "title":"...","description":"...","author":"...","published":"...","word_count":5548,"duration_seconds":null,
 "label":{"importance":4,"urgent":true,"tags":["gold"]},"label_source":"human","rated":"2026-07-03"}
```

- **Features are intake-time only** (what the future classifier sees before capture): title, description, author/channel, registry Tags/Priority, word-count/duration, published. Never note-body text, `read`, or Observations — those leak post-hoc signal.
- `source_tags`/`source_priority` come from the registry tables (already parsed by `loadConfiguredBlogs`/`loadConfiguredChannels` — confirm the parsed entry exposes tags/priority; if not, extend the feed-source row parser, it reads the same markdown tables).
- **Weak labels** (optional flag on the export button, `label_source:"weak"`): bootstrap negatives/positives from existing signals — ignored intake IDs → importance 0; `probably-slop` → 0; `gold` → 4; Observations-linked → min 4. `goldmine` does **not** map to importance (it signals link-richness, not quality) — it is carried through as `"goldmine"` in `label.tags` so the classifier can learn it as a separate target. Human rows always win on conflict. This turns the 201 ignored videos into the negative class for free.
- Schema note for later: uncaptured intake items export identically with `label_source:"human"` once metadata-note labeling lands (labels would live on `_blog_metadata`/`_yt_metadata` notes) — no shape change needed.

### 6. Settings (`src/settings/sections/sourceEval.ts` + `types.ts` + `settings.ts` defaults)

```
sourceEvalEnabled: boolean (true)
sourceEvalReadingBudgetWords: number (default 50000)
sourceEvalBudgetPeriod: 'week' | 'month' (default 'week')
sourceEvalRecencyHalfLifeDays: number (default 90)
sourceEvalLookbackDays: number (default 180)      // window for words/wk + score
sourceEvalExportFolder: string (default '_crucible/source_eval')
```

Register in the settings view alongside existing sections; follow any existing section file (e.g. `automate.ts`) for the bind pattern.

### 7. Registration (`src/main.ts`)

Mirror the ingestion dashboard exactly: import + `registerView(SOURCE_EVAL_DASHBOARD_VIEW_TYPE, ...)` next to line 186, an `activateSourceEvalDashboardView()` next to `activateIngestionDashboardView` (main.ts:1191), and a command `Crucible: Open Source Eval Dashboard`. Add styles to `styles.css` under a `crucible-source-eval-` class prefix.

## Implementation batches (orchestrator handoff)

Each batch compiles/tests independently; ✅ = parallelizable pair.

- **Batch 1 — data core** (`types.ts`, `captureIndex.ts`, `signals.ts`, the shared blog-key helper extraction from `src/ingestion/data/blogs.ts`). Tests: `tests/sourceEvalCaptureIndex.test.mjs`.
- **Batch 2 — metrics + queue (pure)** (`metrics.ts`, `ratingQueue.ts`) — depends on Batch 1 types only. ✅ with Batch 3. Tests: `tests/sourceEvalMetrics.test.mjs` (funnel/read/gold/obs rates, decay, budget share; empty-source and division-by-zero cases).
- **Batch 3 — settings + registration** (settings section, defaults, view shell, main.ts wiring, empty UI mount). ✅ with Batch 2.
- **Batch 4 — dashboard UI** (`sourceEvalDashboard.ts`, `ratingPanel.ts`, styles) — depends on 1–3. Frontmatter-write behavior test via mocked `updateFrontmatter` if practical; otherwise manual.
- **Batch 5 — export** (`export.ts`, command, weak labels). Tests: `tests/sourceEvalExport.test.mjs` (feature restriction — assert no body/read fields; weak-label precedence).

Test convention: node test runner, esbuild-bundle the TS entry to a temp `.mjs` and import (see `tests/guardEval.test.mjs` header for the exact pattern); Obsidian API shims faked as in existing tests (`tests/blogControl.test.mjs` likely has the app/vault fake to copy).

## Verification

1. `npm run lint` && `npm run build` (tsc -noEmit + esbuild production) && `npm test` — all exit 0.
2. Manual, in the dev vault: open *Source Eval Dashboard* via command palette →
   - Scorecard lists ~50 sources; Simon Willison / Lenny / Mark Manson rows show plausible numbers (Mark Manson: 70 captures, 7 gold; Lenny: 65% read rate, 7.5k avg words — cross-check against the exploration numbers above).
   - Budget meta line reflects the words/wk setting; changing the setting refreshes it.
   - Labeling queue: pick `Channel: Mark Manson`, rate one note (importance 4, urgent, +revisit) → confirm frontmatter gains `eval-importance: 4`, `eval-urgent: true`, `eval-rated: <today>`, `revisit` in tags; queue advances; scorecard Labeled % ticks up; re-selecting the note pre-populates controls.
   - Rated note does not reappear with "unlabeled only" on.
   - Export with weak labels → JSONL exists, ignored videos appear as importance-0 weak rows, human row wins over weak for the note just rated, no `read`/body fields present.
3. Regression: Ingestion Dashboard still opens and refreshes (shared render helpers untouched or generic-compatible).

## Later (explicitly out of scope for v1)

- Labeling uncaptured intake items from metadata notes (schema already supports it).
- Link-registry inbound-reuse metric (`source_notes` counts).
- The classifier itself + Urgent/Important auto-tagging trigger at intake time — this plan only produces its training data.
- Surfacing per-source score back into the Tracked Blogs/Channels Priority column.
