# Lint Calls to YT Video / Blog ID Extraction → Frontmatter

## Goal

Audit every call site that derives a YouTube video ID or a blog post ID from a
URL/text and then writes it into a note's frontmatter. Ensure each call site
delegates to a single canonical extractor. Where logic is inline or duplicated,
extract it into a reusable function in the appropriate utils module.

## Scope

Functions/locations to inventory:

- `src/orchestration/utils/youtube.ts` — `extractVideoIdFromUrl`, `VIDEO_ID_RE`,
  `URL_PATTERNS`.
- `src/orchestration/utils/blogs.ts` — blog ID/slug derivation helpers.
- `src/orchestration/utils/urlCanonicalize.ts` — canonical URL → ID logic.
- `src/orchestration/utils/urlExtract.ts` — URL extraction from note bodies.
- `src/orchestration/workflows/YoutubeTrackerWorkflow.ts` — frontmatter writes.
- `src/orchestration/workflows/BlogsTrackerWorkflow.ts` — frontmatter writes.
- `src/orchestration/workflows/LinkScanWorkflow.ts` — any inline ID parsing.
- `src/lint.ts` — confirm whether existing lint rules already check for
  canonical ID frontmatter values; extend if missing.

## Steps

1. **Inventory** — grep the repo for every place that:
   - assigns to a frontmatter key matching `video_id`, `videoId`,
     `yt_video_id`, `blog_id`, `blogId`, `post_id`, or any canonical-id field
     used by the workflows, and
   - parses a URL with an inline regex for YouTube/blog hosts.
   Produce a table: file:line → frontmatter key → source value → extractor used
   (or `inline`).

2. **Classify** each call site:
   - **Reuses canonical extractor** — no action.
   - **Inline duplicate of an existing extractor** — replace with import.
   - **Inline unique logic** — extract into the matching utils module
     (`youtube.ts` / `blogs.ts` / `urlCanonicalize.ts`) with a focused name and
     a unit-style call from the workflow.

3. **Consolidate** the YouTube regex set. Today `URL_PATTERNS` in `youtube.ts`
   lists `watch?v=`, `youtu.be/`, and `/shorts/`. Confirm all callers route
   through `extractVideoIdFromUrl` rather than re-listing patterns. Add
   `/embed/` and `/live/` forms only if a call site needs them.

4. **Blog ID canonicalization** — verify whether `blogs.ts` exposes a single
   `extractBlogId` (or equivalent) used by both the tracker workflow and any
   capture/lint path. If not, define one keyed on the same canonicalization
   rules as `urlCanonicalize.ts`.

5. **Add lint coverage** in `src/lint.ts` so that:
   - A note whose frontmatter declares a YT/blog canonical-id field but whose
     value does not round-trip through the canonical extractor flags a lint.
   - A note that contains a recognized YT/blog URL in the body but is missing
     the corresponding canonical-id frontmatter flags a lint (warn-level).

6. **Tests / manual verification** — run the existing build (`npm run build`)
   and exercise both trackers on a small fixture vault: confirm the extracted
   IDs land in frontmatter unchanged and that the lint flags planted bad rows.

## Out of scope

- Changing the frontmatter key names themselves.
- Backfilling existing notes (separate migration task).
- Adding new URL hosts beyond YT + the blog sources already tracked.

## Definition of done

- Every frontmatter write of a YT video ID or blog ID goes through one named
  extractor per source type.
- No inline regex for YouTube/blog URLs remains in any workflow file.
- `src/lint.ts` flags drift between body URLs and frontmatter IDs.
- `AGENTS.md` `## Quirks` section gets a one-liner if the canonical extractor
  has a non-obvious gotcha (e.g. Shorts vs. watch URL ID equivalence).
