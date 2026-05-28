# Ignored IDs for video & blog ingestion

## Context

The Ingestion Dashboard surfaces "Uncaptured posts" and "Uncaptured videos" — items seen
in tracker runs but not yet captured as vault notes. Today the only way to make an unwanted
item stop appearing is to capture it (defeating the purpose) or let it linger in the list
forever. The same items also keep getting re-discovered by the tracker workflows on every run
and can be auto-enqueued for enrichment.

We want a way to explicitly **ignore** a video or blog post so it disappears from the
uncaptured lists, is skipped by the tracker workflows, and is never auto-queued — while
remaining reviewable (and reversible) in two new, default-hidden dashboard views.

**Key architectural insight:** both the trackers and the dashboard's uncaptured scans filter
candidates against a single "seen ID set" (`buildYoutubeSeenIdSet` / `buildBlogsSeenIdSet`).
Auto-enrich sources from the dashboard's uncaptured cache, which is itself filtered by that
set. So **folding ignored IDs into the seen set is the one chokepoint** that satisfies all
three requirements (trackers, dashboard lists, auto-queue) at once.

## Storage: a managed vault note

Single note `_crucible/orchestration/ignored.md` with two body sections holding bare IDs:

```markdown
## Videos
- dQw4w9WgXcQ

## Blogs
- https://example.com/2026/05/some-post
```

- Video IDs are the 11-char `yt-video-id`. Blog IDs are the canonical `postId`
  (`postIdFromUrl(url)`), which is what `RemotePost.postId` already is.
- This path lives under `_crucible/orchestration/`, the existing
  `QUEUE_SCAN_SKIP_PREFIX_*`, so the seen-set builders already skip it during their vault
  scan — no double-counting. We read it explicitly instead.

### New module: `src/orchestration/utils/ignoredIds.ts`

Exports:
- `IGNORED_IDS_NOTE = '_crucible/orchestration/ignored.md'`
- `loadIgnoredVideoIds(app): Promise<Set<string>>` / `loadIgnoredBlogIds(app): Promise<Set<string>>`
  — `cachedRead` the note (return empty set if absent), parse bullet lines under `## Videos` /
  `## Blogs` (same line-walking idiom as `parseIntakeVideos`/`parseIntakePosts`). Canonicalize
  on load for robustness against manual edits: videos run through `extractVideoIdFromUrl` when
  the entry looks like a URL; blogs run through `postIdFromUrl`.
- `addIgnoredVideoId(app, id)` / `addIgnoredBlogId(app, id)` and
  `removeIgnoredVideoId(app, id)` / `removeIgnoredBlogId(app, id)` — read-modify-write the whole
  note (load both sets, mutate, re-serialize deterministically). Use `ensureFolder(app, …)`
  (`src/utils.ts:30`) + `vault.create` when the note is missing, else `vault.modify`. Dedup
  before adding; no-op if already present/absent.

Given low, click-driven write volume, a full serialize round-trip is simpler and safer than
in-place section edits. (`findSectionRange`/`insertIntoSection` in `src/sections.ts` are
available if a lighter touch is preferred, but not required.)

## Seen-set chokepoint

Add an optional seed param to both builders and seed the set with it:

```ts
// youtubeIntake.ts / blogsIntake.ts
export function buildYoutubeSeenIdSet(app: App, diffMode: boolean, seedIds?: Iterable<string>): Set<string> {
    const seen = new Set<string>(seedIds ?? []);
    // …unchanged scan…
}
```

Update every caller (all already in async contexts) to load and pass the ignored set:

- `src/ingestionDashboard.ts:764` (`computeUncapturedVideoRows`) →
  `buildYoutubeSeenIdSet(this.app, false, await loadIgnoredVideoIds(this.app))`
- `src/ingestionDashboard.ts:699` (`renderUncapturedPosts`) → analogous with `loadIgnoredBlogIds`
- `src/orchestration/workflows/YoutubeTrackerWorkflow.ts:62` and `:239` (consolidate) → pass
  `await loadIgnoredVideoIds(app)`
- `src/orchestration/workflows/BlogsTrackerWorkflow.ts:64` and `:252` (consolidate) → pass
  `await loadIgnoredBlogIds(app)`

This single change makes ignored items vanish from uncaptured lists, get filtered out of
tracker `newVideos`/`newPosts`, and (because `uncapturedQueueItems()` reads the now-filtered
`uncapturedVideosCache`) never auto-enqueue for enrichment. The "YouTube captures without
metadata" section is intentionally unaffected — it operates on already-captured notes, not
tracker candidates.

## Dashboard UI (`src/ingestionDashboard.ts`)

**Ignore button** — add an `ignore` column next to the existing `read`/`watch` column in the
two uncaptured tables:
- `renderUncapturedPosts` (after the `read` column, ~line 729)
- `renderUncapturedVideos` (after the `watch` column, ~line 753)

New helper `renderIgnoreButton(td, kind, id, ctx)`: on click, `await addIgnored…Id(app, id)`,
then `ctx.refresh()` (row drops out as it's now "seen") and refresh the matching ignored
section. Mirror the disable-during-async pattern used by `renderDeleteButton` / the enqueue
cells.

**Two new sections**, both `defaultCollapsed = true`, placed adjacent to their counterparts:
- `ignoredPosts` — title "Ignored blogs", built right after `uncapturedPosts`
- `ignoredVideos` — title "Ignored videos", built right after `uncapturedVideos`

Wiring for each (follow the existing section conventions):
- Extend the `SectionId` union (lines 31-41).
- `buildSection('ignoredVideos', 'Ignored videos', '…', undefined, true)` etc. The existing
  `createSectionHeader(..., defaultCollapsed=true)` already renders them collapsed (CSS hides
  the body).
- Add both ids to the `refreshAll` array (~line 508) and the `renderSection` switch (~line 530).
- Render via `renderSortableTable`: an ID column (render the bare ID as text; for videos also
  link to `https://www.youtube.com/watch?v=<id>`, for blogs the id is itself a URL → link it)
  plus an action column with an **Un-ignore** button (`removeIgnored…Id` then refresh this
  section + the matching uncaptured section).
- In `registerListeners` `route()` (~line 193): add debounced refreshers for the two new
  sections and trigger them (alongside the uncaptured refreshers) when the changed path is
  `IGNORED_IDS_NOTE`, so manual edits to the note update the views.

## AGENTS.md

Add a `## Quirks` entry: ignored IDs are folded into the seen set (`buildYoutubeSeenIdSet` /
`buildBlogsSeenIdSet` seed param) as the single chokepoint covering trackers + dashboard +
auto-enrich; the `ignored.md` note lives under `_crucible/orchestration/` (the scan-skip
prefix) and is therefore read explicitly via `loadIgnored*Ids`, not picked up by the vault
scan.

## Files to modify

- `src/orchestration/utils/ignoredIds.ts` — **new** module (load/add/remove + note path).
- `src/orchestration/utils/youtubeIntake.ts` — `buildYoutubeSeenIdSet` seed param.
- `src/orchestration/utils/blogsIntake.ts` — `buildBlogsSeenIdSet` seed param.
- `src/orchestration/workflows/YoutubeTrackerWorkflow.ts` — pass ignored set at lines 62, 239.
- `src/orchestration/workflows/BlogsTrackerWorkflow.ts` — pass ignored set at lines 64, 252.
- `src/ingestionDashboard.ts` — ignore button, two new sections, routing.
- `AGENTS.md` — Quirks entry.

(No `types.ts`/settings or migration changes — storage is the vault note, not `data.json`.)

## Verification

Mandatory build loop (per AGENTS.md), all must exit 0:
1. `npm run lint`
2. `npx tsc --noEmit --skipLibCheck`
3. `node esbuild.config.mjs production`

Manual, in Obsidian with the dev build:
1. Open the Ingestion Dashboard. Confirm "Ignored blogs" and "Ignored videos" appear
   collapsed by default; expanding shows empty lists.
2. In "Uncaptured videos", click **Ignore** on a row → row disappears; `_crucible/orchestration/ignored.md`
   gains the id under `## Videos`; the id appears in "Ignored videos". Repeat for a post in
   "Uncaptured posts" → "Ignored blogs".
3. In an ignored view, click **Un-ignore** → entry leaves the note and the item reappears in
   the uncaptured list.
4. With an id ignored, enqueue the youtube/blogs tracker (the "Enqueue intake" button) and the
   consolidate workflow → confirm the ignored id is not re-listed.
5. Enable "Auto enrich from Uncaptured Videos" → confirm an ignored video is never queued.

When implementing, also copy this plan to `<repo>/plans/` before starting (per project
convention).
