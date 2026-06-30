# Blog Control Center for Ingestion Dashboard

## Summary

Add a new "Blog control center" dashboard section that mirrors the YouTube Channel control center as a per-blog rollup: filterable by all/tracked/untracked, sorted by blog name, and showing total known posts, ingested posts, ignored posts, uncaptured posts, and tracked status.

## Key Changes

- Add internal dashboard types:
  - Add `'blogControl'` to `SectionId`.
  - Add `BlogControlRow` with `blogKey`, `name`, `link`, `trackedPosts`, `ingestedPosts`, `ignoredPosts`, `uncapturedPosts`, and `tracked`.
- Add a new data module, likely `src/ingestion/data/blogs.ts`, with `computeBlogControlRows(app, plugin)`.
  - Seed rows from `loadConfiguredBlogs`; key by `BLOGS_FEED_SOURCE.entryKey` (`entry.link`).
  - Scan blog tracker intake files under `INTAKE_ROOT_BLOGS` using `parseIntakePosts` to collect discovered `postId`s per blog.
  - Scan `blogMetadataRoot(plugin)` for metadata notes with `post-id`, `blog`, and `source` to surface metadata-only/untracked blogs.
  - Use `buildBlogsSeenIdSet` with configured canon host rules and feed skip prefixes to count final captured notes as "Ingested"; do not count `_blog_metadata` notes as ingested.
  - Use `loadIgnoredBlogIds` for ignored counts.
- Wire the section into `src/ingestionDashboard.ts`.
  - Add `private blogFilter: 'all' | 'tracked' | 'untracked' = 'all'`.
  - Add `buildSection('blogControl', 'Blog control center', ...)` near the existing blog sections.
  - Add `blogControl` to `refreshAll()` and the render switch.
  - Add `renderBlogControl(body, ctx)` using the same controls/table pattern as `renderChannelControl`.
  - Columns: Blog, Posts, Ingested, Ignored, Uncaptured, Tracked?
  - Blog column links to the configured blog link when available; metadata-only rows fall back to the first known source URL or plain text if no URL exists.
- Refresh routing:
  - Refresh `blogControl` when blog intake files, ignored IDs, blog metadata root files, or structurally relevant vault changes occur.
  - Keep this scoped to dashboard data/rendering only: no new blog workflow, no per-blog tracker targeting, no bulk ingest action.

## Test Plan

- Add focused unit coverage for `computeBlogControlRows`.
  - Registry blog with tracker posts produces tracked row and correct denominator.
  - Captured post frontmatter increments ingested, while `_blog_metadata/**` does not.
  - Ignored post IDs increment ignored and reduce uncaptured.
  - Metadata-only blog appears as untracked.
  - Canon host rules are applied consistently with existing blog seen-set behavior.
- Run the mandatory cleanup loop:
  - `npm run lint`
  - `npx tsc -noEmit -skipLibCheck`
  - `node esbuild.config.mjs production`
  - Confirm all exit with code 0.

## Assumptions

- "Similar section for blogs" means dashboard visibility/control parity with YouTube's rollup section, not new blog ingestion workflow behavior.
- The section should use existing blog tracker, metadata-note, ignored-ID, and seen-set utilities rather than adding a parallel queue or targeted tracker mode.
- No new user settings are needed.
