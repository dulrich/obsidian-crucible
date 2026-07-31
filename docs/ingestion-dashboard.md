# Ingestion Dashboard

Open the dashboard with `Open ingestion dashboard`. It is a live workspace view for capture and ingestion pipelines. It refreshes from vault events, metadata changes, and Crucible ingestion events.

## Sections

| Section | What it shows |
|---|---|
| Unprocessed clippings | Markdown files directly under the configured clipper inbox folder. |
| Unrefined transcripts | Notes tagged `#transcript` that are not tagged `#refined`. |
| Blog intake | Blog tracker runs, newest first. |
| YouTube intake | YouTube tracker runs, newest first. |
| Queue monitor | Active and recent orchestration jobs. |
| Uncaptured posts | Blog posts seen in tracker runs but not yet captured as vault notes. |
| Ignored blogs | Blog post IDs you chose to ignore. |
| Uncaptured videos | YouTube videos seen in tracker runs but not yet captured as vault notes. |
| Ignored videos | YouTube video IDs you chose to ignore. |
| YouTube captures without metadata | Notes with `yt-video-id` but no `yt-metadata` link. |
| Orphaned attachments | Localized `_MD5.ext` media files with no resolved back-reference from any note. |
| Missing localized attachments | Notes whose `_MD5.ext` embeds or links point at a file that no longer exists. |

## Actions

- Blog and YouTube intake sections can enqueue tracker runs.
- Uncaptured post/video rows can be ignored so they no longer appear as uncaptured.
- Ignored post/video rows can be unignored.
- YouTube metadata rows can enqueue metadata enrichment.
- Orphaned attachment rows can be cleaned up individually or in bulk after confirmation.
- Missing localized attachment rows can be repaired individually when a safe repair target is found; repair is restorative (no confirmation prompt).

## Important Behavior

Ignored IDs affect tracker and dashboard results. Ignored videos are skipped by the tracker, the uncaptured list, and auto-enrichment.

YouTube metadata enrichment requires a `yt-video-id` frontmatter value and no existing `yt-metadata` link. It runs through the memory-backed queue with rate limiting and emits dashboard refresh events when metadata is written.

Orphaned attachment detection looks for localized media files whose filename matches the `_MD5.ext` convention. It checks Obsidian resolved links from note bodies. Attachments referenced only from YAML properties may not count as referenced.

Missing localized attachments is the inverse scan: it walks each note's embeds and links, keeps the ones whose target looks like a managed `_MD5.ext` attachment, and flags any that no longer resolve to a file. A row's Repair button is enabled only when a safe target can be found (same rules as `Lint: repair attachment links`); frontmatter-only refs are out of scope, same as orphaned attachments.

The dashboard uses longer debouncing for vault-wide scans so typing in notes does not constantly rebuild expensive sections.
