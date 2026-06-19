# Blog RSS Metadata Enrichment Rework

## Summary

Blog enrichment writes `_blog_metadata` notes as staging/enrichment artifacts, not
final capture artifacts. The Ingestion dashboard's Uncaptured posts list remains
driven by real captured vault notes, while metadata notes enrich each row and provide
the target for a configured ingest command or chain.

Assessment: work against the current unstaged changes, but do not preserve their
current data flow. The parser enrichment and `Body` column work are useful; the
current `blogsApi`, dashboard action model, capture root setting, and "metadata note
counts as captured" behavior need to be replaced.

## Key Changes

- Keep per-feed `Body` config: `auto | full | snippet`.
  - `auto`: only dedicated content elements count as body (`content:encoded` / Atom
    `<content>`).
  - `full`: treat fallback content (`description` / Atom `<summary>`) as full body
    for feeds like `https://simonwillison.net/atom/everything/`.
  - `snippet`: never mark body available.
- Replace blog capture root with blog metadata settings:
  - `orchestrationBlogsMetadataRoot`, default `_blog_metadata`.
  - `orchestrationBlogsIngestCommandId`, selected from queueable/internal Crucible
    commands, typically a chain.
- During blog tracker intake, write or update one metadata note per new post under
  `_blog_metadata/<blog-folder>/...`.
  - Metadata-only note when no trusted body exists.
  - Metadata plus Markdown body note when `hasBody === true`.
  - No separate `_crucible/orchestration/blogs/bodies` staging path; the metadata note
    is the staging artifact.
- Blog metadata notes carry `source`, `post-id`, `blog`, `authors`, `published`,
  `word-count`, `categories`, `kind`, `has-body`, `fetched_at`, and
  `source_command`.

## Dashboard Behavior

- Uncaptured posts must ignore `_blog_metadata/**` and `_crucible/**` system notes
  when deciding whether a post is captured. Only user-facing vault notes with matching
  `post-id` / `source` remove a row.
- Each Uncaptured post row uses the metadata note to show type, words, author, and body
  availability.
- The metadata UI is a link to the metadata file, not a button that creates/captures
  anything.
- `read` remains an external link to the blog URL.
- Rows with `has-body: true` show an `Ingest` button. Clicking it runs the configured
  command/chain against the metadata note as the target file via the internal command
  path, not `app.commands.executeCommandById`.
- Rows without body do not show `Ingest`; they still show `read`, metadata link, and
  ignore.
- After ingest, refresh the section. The row disappears only if the configured command
  created or moved a real captured note outside excluded system roots with matching
  `post-id` / `source`.

## Current Diff Handling

- Keep/adapt:
  - RSS/Atom parser enrichment fields.
  - Optional `Body` registry column and settings copy.
  - Tests for body-mode parsing and Simon-style Atom `<summary>` via `Body=full`.
- Replace/remove:
  - `orchestrationBlogsCaptureRoot`.
  - `ingestBlogPost` as "write final captured note".
  - Metadata/dashboard buttons that create captured notes.
  - Logic/comments/tests saying metadata notes should drop rows from Uncaptured.
  - Separate staged body files under `_crucible/orchestration/blogs/bodies`.

## Test Plan

- Parser tests: `auto`, `full`, `snippet`; Atom `<summary>` only counts as body in
  `full`.
- Metadata-note tests: intake creates/updates `_blog_metadata` notes with and without
  body.
- Seen-set tests: `_blog_metadata/**` and `_crucible/**` notes with `post-id` do not
  count as captured; normal vault notes do.
- Dashboard tests or focused mocks: body rows show `read`, metadata link, `Ingest`;
  no-body rows show `read`, metadata link, no `Ingest`.
- Command test: `Ingest` invokes the configured internal command with the metadata note
  as `targetFile`.
- Final cleanup loop: `npm run lint`, `npx tsc -noEmit -skipLibCheck`,
  `node esbuild.config.mjs production`, all exit 0.
