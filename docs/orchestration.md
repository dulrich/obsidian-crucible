# Orchestration

Crucible's orchestrator runs workflow jobs through a unified queue. Commands and triggers enqueue jobs; the runner drains them with pacing, timeouts, concurrency limits, and note locks.

## Queue Model

There is one orchestrator with one durable backend: every job is a row in the plugin's
own SQLite database (`jobs.sqlite` in the plugin data directory), never a vault file.
Jobs survive restarts, claims are atomic, and a crashed run is recovered automatically
on the next startup scan.

- Repeat enqueues that resolve to the same target collapse onto the existing active job
  (promoting its priority when the new request is more urgent).
- Finished jobs (done / failed / cancelled) are pruned by age via the **Job retention
  (days)** setting (default 30; blank or 0 keeps them forever).
- The queue monitor's per-row **Details** button shows a job's params, error, progress
  and notes, with copy-to-clipboard — the replacement for opening a job note.

Global concurrency, per-job timeout, per-type pacing, and autorun settings apply
through the orchestrator instead of separate queue loops.

**Upgrading from the markdown queue:** the old queue folder (default
`_crucible/orchestration/queue`) is now a frozen archive. Nothing reads or writes it,
and a one-time notice tells you it is safe to delete on disk. The plugin never deletes
it for you.

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

## Triggers (user-defined)

New triggers are created **disabled** and can only be enabled once they validate (a
resolvable chain or command, at least one event, a positive schedule interval). The
editor shows the refusal reason and a live "~N notes currently in scope" estimate so a
too-broad trigger is visible before it is armed. Files the plugin manages itself (the
`_crucible` tree, including the archived queue folder) never fire triggers.

## Settings Notes

- Autorun controls whether queued work drains automatically.
- Job retention (days) bounds how long finished jobs are kept in the database.
- Routine notices can be controlled per job type.
- Tracker settings include registry note paths, diff mode, write-empty-run behavior, metadata roots, and intervals.
- YouTube metadata enrichment has its own rate limit and max-parallel setting.
- Daily Brief Lite currency and location autocompletes cache into plugin settings and are cleared manually from the settings UI.

For registry table formats, see [Tracked sources](tracked-sources.md).
