# Blogs Tracker Orchestration Workflow

## Context

The plugin already ships a YouTube Tracker orchestration workflow that polls channel RSS feeds, diffs against prior runs / vault frontmatter, and writes intake notes summarizing new videos. The user wants a parallel **Blogs Tracker** workflow that follows the same shape but tracks blog posts via RSS feeds. The blog registry note uses a 5-column table (`Name | Link | Method | Tags | Priority`) with an extended priority enum (`high | normal | low | skip | ignore`), where `skip` and `ignore` filter the entry out of the run entirely. Only `Method=RSS` is supported in this iteration; the column exists so other methods (Atom-only quirks, JSON feed, scraping) can be slotted in later without breaking the registry format.

Same toggle semantics as YouTube: a Blogs registry note path, a "Diff against prior runs" toggle, and a "Write empty intake files" toggle. A `blogs_tracker_consolidate` workflow ships alongside the main tracker, mirroring `YoutubeTrackerConsolidateWorkflow`.

## Approach

Clone the YouTube tracker architecture file-for-file. The YouTube code is small, self-contained, and already exposes the right seams (`parseTable`, rate-limited fetch, `buildSeenIdSet`, `writeIntakeNote`). Reuse what's generic; only swap what's blog-specific.

### Reusable utilities (no changes needed)

- `parseTable(content, expectedHeaders)` — `src/orchestration/utils/markdownTable.ts:1` — already case-insensitive, header-driven, returns `Record<string, string>[]`. Works as-is for the 5-column blogs table.
- `rateLimitedAllSettled` — bottom of `src/orchestration/workflows/YoutubeTrackerWorkflow.ts:465`. **Hoist** this into a new shared module `src/orchestration/utils/rateLimit.ts` and import it from both workflows. (One-line move + re-export — avoids cloning a 35-line utility.)
- `ensureFolder`, `updateFrontmatter`, `insertFrontmatterPropertyAfter`, `todayInTz`, `nowTimeInTz` — already general.
- Obsidian `requestUrl` + native `DOMParser` — same RSS-fetch pattern as YouTube.

### New files

1. **`src/orchestration/utils/blogs.ts`** — mirrors `utils/youtube.ts`:
   - `BlogEntry { name, link, method: 'rss', tags: string[], priority: 'high'|'normal'|'low' }` (the loader drops `skip`/`ignore` rows, so downstream types stay narrow).
   - `RemotePost { postId, title, publishedAt, blogName, url }` — `postId` is the dedup key: `<guid>` from the RSS item, falling back to the post `<link>` if guid is missing or marked non-permalink.
   - `parseBlogsTable(content)` — calls `parseTable(content, ['Name', 'Link', 'Method', 'Tags', 'Priority'])`. Rules:
     - Lowercase the `Method` cell; only `rss` is accepted in this iteration. Other values cause the row to be skipped (logged via the workflow's failure path so the user sees it).
     - Lowercase the `Priority` cell; `skip` or `ignore` → row dropped silently (these are user-controlled "off switches", not failures).
     - Unknown priority strings fall back to `normal` (same forgiving behavior as YouTube).
   - `EXAMPLE_BLOGS_TABLE` constant — used to seed the registry note if missing.
   - `fetchBlogFeed(link)` — `requestUrl({ url: link, method: 'GET', throw: false })`, then `parseRssOrAtom(xml, fallbackBlogName)`.
   - `parseRssOrAtom(xml, fallbackBlogName)` — handles both RSS 2.0 (`<item>`, `<guid>`, `<link>`, `<pubDate>`) and Atom (`<entry>`, `<id>`, `<link href>`, `<published>`). Returns `RemotePost[]`. Throws on `<parsererror>`.
   - `postIdFromUrl(url)` — best-effort canonicalization (strip fragment, strip common tracking params: `utm_*`, `gclid`, `fbclid`). Used only when synthesizing an id from a link fallback, **not** when comparing to a guid-provided id.

2. **`src/orchestration/workflows/BlogsTrackerWorkflow.ts`** — mirrors `YoutubeTrackerWorkflow.ts`:
   - Constants: `INTAKE_ROOT = '_crucible/orchestration/blogs/new-posts'`, `TRACKER_GENERATED_BY = 'orchestrator/blogs_tracker'`, `CONSOLIDATE_GENERATED_BY = 'orchestrator/blogs_tracker_consolidate'`, same `FEED_FETCH_CONCURRENCY = 4`, `FEED_FETCH_MIN_INTERVAL_MS = 250`.
   - `BlogsTrackerWorkflow.run()` — same control flow as YouTube: read registry → `parseBlogsTable` → if empty, write empty intake (only when `WriteEmptyRuns` is on, else early-return done) → build seen-ids → fetch all feeds via `rateLimitedAllSettled` → filter fresh posts → write intake.
   - `buildSeenIdSet(plugin, diffMode)` — scans markdown files (skipping `_crucible/orchestration/` unless inside the blogs intake prefix when diffMode). Pulls ids from frontmatter properties:
     - `blog-post-id` (canonical, written by the workflow)
     - `source` (URL-mode — extracts post id via `postIdFromUrl`, matching YouTube's pattern of accepting source URLs in user notes)
     - `post_ids` (array, only when diffMode and file is inside `INTAKE_ROOT`)
   - `canonicalizeDetectedIds(plugin)` — backport pattern from YouTube: if a vault note has `source:` but no `blog-post-id:`, insert one. Bounded by the same `QUEUE_SCAN_SKIP_PREFIX` exclusion.
   - `writeIntakeNote(plugin, outcomes, totalNew, generatedBy)` — same frontmatter shape, swapping `channels_*`/`video_ids` → `blogs_*`/`post_ids`. **Priority ordering applied here:** sort `outcomes` by `priority` (`high` → `normal` → `low`) before rendering, keeping per-blog sections intact. Within each blog section, posts stay in feed order (newest-first from RSS).
   - `BlogsTrackerConsolidateWorkflow extends BlogsTrackerWorkflow` — same pattern as `YoutubeTrackerConsolidateWorkflow`: re-scans prior tracker intake runs, surfaces posts whose ids are not present anywhere in the vault, writes a consolidation intake.
   - `parseIntakeBlogs(content)` and `parseBlogHeading(line)` mirror YouTube's `parseIntakeVideos`/`parseChannelHeading`. The blog heading regex: `/^##\s+(.+)\s+\((https?:\/\/[^)]+)\)\s*$/` (blog name + feed URL in parens).

### Edits to existing files

1. **`src/types.ts`** — add four settings keys next to the YouTube block (`src/types.ts:257`):
   ```ts
   // Workflow: blogs_tracker
   orchestrationBlogsTrackerEnabled: boolean;
   orchestrationBlogsNote: string;
   orchestrationBlogsTrackerDiffMode: boolean;
   orchestrationBlogsTrackerWriteEmptyRuns: boolean;
   ```
   And add defaults at `src/types.ts:321` mirroring YouTube's defaults (enabled `true`, note path `_system/blogs/Blogs.md`, diff `true`, write-empty `false`).

2. **`src/main.ts`**:
   - Import `BlogsTrackerWorkflow`, `BlogsTrackerConsolidateWorkflow` from `./orchestration/workflows/BlogsTrackerWorkflow` (next to the existing YouTube import at `src/main.ts:19`).
   - Register both workflows next to YouTube's registrations at `src/main.ts:68-69`.
   - Register two `registerCrucibleCommand` entries near `src/main.ts:218-228`:
     - `orchestrator-enqueue-blogs-tracker` → `name: 'Orchestrate: enqueue Blogs tracker'`, `group: 'Orchestrations'`, `run: () => this.orchestrator.enqueue('blogs_tracker')`.
     - `orchestrator-enqueue-blogs-tracker-consolidation` → analogous.

3. **`src/orchestration/types.ts`** — extend the `JobType` union with `'blogs_tracker'` and `'blogs_tracker_consolidate'`. (The YouTube types live here; the file should already export the union as a literal-union — extend it; do not introduce a separate type.)

4. **`src/settings.ts`** — two additions:
   - Add a workflow entry in `getWorkflows()` near `src/settings.ts:1829` mirroring the YouTube tracker entry:
     ```ts
     {
       id: 'blogs_tracker',
       name: 'Blogs Tracker',
       description: 'Poll configured blog RSS feeds for new posts and create intake notes.',
       enabledKey: 'orchestrationBlogsTrackerEnabled',
       render: (el) => this.renderEditBlogsTrackerWorkflow(el),
     }
     ```
   - Add `renderEditBlogsTrackerWorkflow(containerEl)` mirroring `renderEditYoutubeTrackerWorkflow` at `src/settings.ts:2086`. Three settings rows:
     - **Blogs note** — `Setting().addSearch()` with `FileSuggest`, default `_system/blogs/Blogs.md`.
     - **Diff against prior runs** — toggle bound to `orchestrationBlogsTrackerDiffMode`.
     - **Write empty intake files** — toggle bound to `orchestrationBlogsTrackerWriteEmptyRuns`.

5. **`src/orchestration/Orchestrator.ts`** — if the orchestrator has an explicit enabled-check map (`isWorkflowEnabled`) keyed by `JobType`, add the `blogs_tracker` cases there too. Search for the YouTube cases first; mirror them.

### Quirks to honor (from `AGENTS.md`)

- Commands must go through `this.registerCrucibleCommand`, never `this.addCommand`. Settings UI reads from `plugin.commandRegistry`.
- New command group entries are unnecessary here — `'Orchestrations'` group already exists.
- Use the standard `FileSuggest` from `src/suggesters.ts` for the Blogs note path input.
- Setting rows must live inside the existing `.crucible-settings-group` containers used by the YouTube renderer — match the surrounding markup exactly.

## Critical files to read before implementing

- `src/orchestration/workflows/YoutubeTrackerWorkflow.ts` — full reference implementation.
- `src/orchestration/utils/youtube.ts` — feed-fetch + table-parse reference.
- `src/settings.ts:2086-2125` — exact YouTube settings panel markup to mirror.
- `src/main.ts:60-80,210-235` — registration site for both workflow and commands.
- `src/orchestration/types.ts` — to confirm `JobType` shape before extending.

## Verification

1. **Build cleanly** (per `AGENTS.md` cleanup loop):
   ```
   npm run lint
   npx tsc -noEmit -skipLibCheck
   node esbuild.config.mjs production
   ```
   All three must exit 0.

2. **Registry seeding** — with `orchestrationBlogsNote` pointing at a non-existent path, enqueue the Blogs tracker once. Confirm it creates the example registry note with the 5-column table and returns a `failed` result instructing the user to add blogs.

3. **Happy-path RSS** — populate the registry with two real RSS feeds (suggest: a high-priority and a low-priority entry). Enqueue. Confirm:
   - Intake file written to `_crucible/orchestration/blogs/new-posts/<date>T<time>.md`.
   - High-priority blog section appears above low-priority section.
   - Frontmatter includes `post_ids:` with one id per new post and `generated_by: orchestrator/blogs_tracker`.

4. **Priority filtering** — set one row's Priority to `ignore`, another to `skip`. Re-enqueue. Confirm those blogs do not appear in the intake and are not fetched (network-wise: optional check via dev-tools network panel).

5. **Diff against prior runs** — re-enqueue without changing the registry. With `WriteEmptyRuns=false`, expect "No new posts; intake file not written." With `WriteEmptyRuns=true`, expect an empty intake file.

6. **Consolidation** — enqueue `blogs_tracker_consolidate`. With no prior tracker runs: returns done with "No regular Blogs tracker intake runs found." With prior runs whose posts have all been processed into vault notes carrying `blog-post-id`: returns done with "no missing posts" message. With prior posts not yet ingested: writes a consolidated intake.

7. **UI smoke test** — open Settings → Orchestrations → Blogs Tracker. Confirm all three controls render, persist on toggle, and the Blogs-note search has file autocomplete.

## Plan file location note

Per repo memory, after approval this plan should be copied to `/home/_shared_code/obsidian-crucible/plans/blogs-tracker-orchestration.md` before implementation begins.
