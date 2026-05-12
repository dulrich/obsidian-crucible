# YouTube Tracker Consolidation Task

## Summary

Add a queued orchestrator workflow and command that scans regular YouTube Tracker intake runs, deduplicates videos across those runs, subtracts videos already represented in the current vault, and writes one consolidated intake note in `_crucible/orchestration/youtube/new-videos`.

## Implementation Changes

- Add a `youtube_tracker_consolidate` job type registered beside the existing YouTube tracker.
- Add the command `Orchestrate: enqueue YouTube tracker consolidation`.
- Gate the workflow with the existing YouTube Tracker enabled setting.
- Scan only regular tracker intake files with `generated_by: orchestrator/youtube_tracker`; ignore prior consolidation outputs.
- Parse channel sections and video bullets from intake files, dedupe by video ID, and preserve the first-seen channel grouping/order.
- Compare against the current vault using the existing tracker logic for `yt-video-id` and YouTube IDs in `source`, excluding orchestration artifacts.
- Write the consolidated output using the same intake note format, with `generated_by: orchestrator/youtube_tracker_consolidate`.

## Test Plan

- Run `npm run lint`.
- Run `npx tsc -noEmit -skipLibCheck`.
- Run `node esbuild.config.mjs production`.
- In Obsidian, enqueue the consolidation task, run next, and confirm it writes only videos from regular tracker runs that still do not have vault notes.

## Assumptions

- Previous consolidation outputs are not source runs.
- The task does not fetch YouTube RSS; it consolidates from existing intake notes only.
- If nothing is missing, the workflow finishes without writing an empty consolidated intake.
