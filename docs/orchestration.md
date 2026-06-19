# Orchestration

Crucible's orchestrator runs workflow jobs through a unified queue. Commands and triggers enqueue jobs; the runner drains them with pacing, timeouts, concurrency limits, and note locks.

## Queue Model

There is one orchestrator with multiple backends:

- File-backed jobs are persisted as markdown files under the configured queue root.
- Memory-backed jobs are transient, deduped in memory, and used for short-lived UI-driven work such as YouTube metadata enrichment.

Both backends use the same runner. Global concurrency, per-job timeout, per-type pacing, and autorun settings apply through the orchestrator instead of separate queue loops.

## Workflows

Configured workflows include:

- Daily Brief Lite: fetches FX rates and weather and injects them into today's daily note.
- Transcript Refine: runs an AI chain against a transcript note.
- YouTube Tracker: polls configured YouTube RSS feeds and writes intake notes.
- YouTube Tracker Consolidation: rebuilds missing-video intake from prior tracker runs.
- Blogs Tracker: polls configured RSS feeds and writes intake notes.
- Blogs Tracker Consolidation: rebuilds missing-post intake from prior tracker runs.
- Link Scan: scans vault URLs and builds canonical URL metadata.
- Search indexing jobs: rebuild, sweep, file upsert, batch upsert, and delete-path jobs.
- YouTube metadata fetch: enriches YouTube notes with metadata links.
- Image metadata extract: extracts metadata for localized images.
- Command run jobs: queueable command execution.

## Triggers and Schedules

Code-defined triggers enqueue jobs rather than running work inline:

- `yt-metadata-on-capture`: when a note gains `yt-video-id` and lacks `yt-metadata`, enqueue metadata enrichment.
- `youtube-tracker-schedule`: enqueue YouTube tracker runs on the configured interval.
- `blogs-tracker-schedule`: enqueue blog tracker runs on the configured interval.

Schedule interval `0` means off. Per-trigger enable toggles live in the Orchestrate settings.

## Settings Notes

- Autorun controls whether queued file-backed work drains automatically.
- Routine notices can be controlled per job type.
- Tracker settings include registry note paths, diff mode, write-empty-run behavior, metadata roots, and intervals.
- YouTube metadata enrichment has its own rate limit and max-parallel setting.
- Daily Brief Lite currency and location autocompletes cache into plugin settings and are cleared manually from the settings UI.

For registry table formats, see [Tracked sources](tracked-sources.md).
