# Fix YouTube Seen-Set Pollution

## Summary

- Root cause is likely `buildYoutubeSeenIdSet(app, false)`: it scans broad vault frontmatter and counts any `yt-video-id` as captured.
- `LinkScanWorkflow` writes link-registry records with `type: link-record` and `yt-video-id`, so a vault link-registry scan can make linked-but-uncaptured videos look ingested.
- The new Channel control center uses the same captured set, so its `Ingested` calculation is likely polluted by the same bug.

## Key Changes

- In `src/orchestration/utils/feedIntake.ts`, make feed seen-set scanning exclude non-capture records:
  - Always skip frontmatter `type: link-record`.
  - Preserve the current intake/diff-mode behavior.
  - Add a shared helper for scanner skip roots: link registry root plus the relevant metadata root.
- Extend `buildYoutubeSeenIdSet` to accept `extraSkipPrefixes`, matching the existing `buildBlogsSeenIdSet` shape.
- Update YouTube callers that mean "actual captured vault note":
  - `computeUncapturedVideoRows`: seed ignored IDs, but skip link registry and `_yt_metadata`.
  - `computeChannelControlRows`: build `captured` with the same skip rules.
  - `FeedTrackerWorkflow`: pass link-registry and feed metadata roots into `buildFeedSeenIdSet` so tracker runs are not suppressed by link records either.

## Channel Count Contract

- Keep the current rollup denominator:
  - Tracked channel: videos discovered in tracker intake.
  - Untracked channel: fallback to metadata-note video IDs.
- Compute `ignoredVideos` first, then `ingestedVideos` only for IDs present in real captured notes.
- Do not count link-record notes or metadata/about notes as ingested captures.

## Tests

- Add a focused Node test for `buildYoutubeSeenIdSet`/scanner behavior using existing esbuild test patterns.
- Cover:
  - A normal note with `yt-video-id` counts as seen.
  - A link-record note with the same `yt-video-id` does not count.
  - A note under `_yt_metadata` does not count when passed as a skip root.
  - Ignored seed IDs still suppress uncaptured rows.

## Verification

- Run the mandatory cleanup loop:
  - `npm run lint`
  - `npx tsc -noEmit -skipLibCheck`
  - `node esbuild.config.mjs production`
- Manual rerun packet:
  - Rebuild/reload plugin.
  - Open `Crucible: Ingestion dashboard`.
  - Confirm `Uncaptured videos` returns to the expected nonzero count.
  - Confirm Channel control center no longer treats link-registry-only YouTube URLs as ingested videos.
