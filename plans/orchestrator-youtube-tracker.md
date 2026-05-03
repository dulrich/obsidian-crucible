# Orchestrator — YouTube Subscription Tracker (Plan 3 of 4)

## Context

Track new videos from a user-maintained list of YouTube channels by polling each channel's RSS feed and writing a daily intake note listing only previously-unseen videos. No YouTube Data API. No LLM. No per-video note creation.

**Depends on:** Plan 1 (core).

## Key design choices (locked in via planning Q&A)

- **Channel registry is a markdown table in a vault note**, not YAML. Path is configurable (`settings.orchestrationYoutubeChannelsNote`, default `_system/youtube/Channels.md`).
- **Dedupe scope is frontmatter-only** in v1. We read `youtube-id` and `source` from each note's cached frontmatter. Body content is intentionally **not** scanned. A future "Recommended/Linked Content" worker can scrape body URLs out-of-band.
- Intake notes go to `_crucible/orchestration/youtube/new-videos/YYYY-MM-DD.md`.

## Channel registry format

```md
| Channel | ID | Tags | Priority |
|---------|----|------|----------|
| Some Name | UCxxxxxxxxxxxxxxxxxxxxxx | ai, research | normal |
| Another | UCyyyyyyyyyyyyyyyyyyyyy |  | high |
```

Parser rules:
- Locate the line whose first non-pipe column trims to `Channel` (case-insensitive). The next line must be a delimiter row (`|---|---|---|---|`); skip it.
- Each subsequent row whose first cell is non-empty is a channel. A blank first cell or a non-table line ends parsing.
- `Channel` cell → `name` (string).
- `ID` cell → `channelId` (must start with `UC`; else skip with a warning in job notes).
- `Tags` cell → split on comma, trim, drop empties → `string[]`.
- `Priority` cell → lowercase, must be `low|normal|high`; else `normal`.

If the configured registry note doesn't exist on first enqueue, create it with the example skeleton above (containing one comment row directing the user to add channels) and **fail the job** with a guiding error: `"Created registry at ${path}. Add channels and re-enqueue."`.

## Files to add

```
src/orchestration/workflows/YoutubeTrackerWorkflow.ts
src/orchestration/utils/youtube.ts
src/orchestration/utils/markdownTable.ts
```

## Files to modify

- `src/main.ts` — register workflow + add `orchestrator-enqueue-youtube-tracker` command.

## Implementation details

### `src/orchestration/utils/markdownTable.ts`

```ts
export function parseTable<T extends string>(
  content: string,
  expectedHeaders: readonly T[],
): Array<Record<T, string>>;
```

Returns rows keyed by the header names exactly as supplied. Header matching is case-insensitive. If the table isn't found, returns `[]`. Caller validates and converts cell strings into typed fields.

### `src/orchestration/utils/youtube.ts`

```ts
export interface ChannelEntry {
  name: string;
  channelId: string;
  tags: string[];
  priority: "low" | "normal" | "high";
}

export interface RemoteVideo {
  videoId: string;
  title: string;
  publishedAt: string;     // ISO
  channelName: string;     // from <author><name>
  url: string;             // https://www.youtube.com/watch?v=VIDEO_ID
}

export function extractVideoIdFromUrl(url: string): string | null;
// matches /watch?v=ID, youtu.be/ID, /shorts/ID; ID is exactly 11 chars from [A-Za-z0-9_-]

export function parseChannelsTable(content: string): ChannelEntry[];

export async function fetchChannelFeed(channelId: string): Promise<RemoteVideo[]>;
// requestUrl GET https://www.youtube.com/feeds/videos.xml?channel_id=...
// Parse via DOMParser('text/xml'); pull all <entry>; extract <yt:videoId>, <title>, <published>, <author><name>.
```

For the RSS XML namespaces: use `getElementsByTagName("yt:videoId")` — Obsidian's renderer DOMParser preserves namespaced tag names as-is when given XML mime type.

### `src/orchestration/workflows/YoutubeTrackerWorkflow.ts`

```ts
export class YoutubeTrackerWorkflow implements Workflow {
  async run(job: OrchestrationJob, ctx: WorkflowContext): Promise<WorkflowResult>;
}
```

Steps:

1. **Load channels.**
   - `regPath = plugin.settings.orchestrationYoutubeChannelsNote`
   - If missing → create example skeleton at that path; fail job with guiding error.
   - Else read + parse via `parseChannelsTable()`. If parse yields 0 channels, succeed with an empty intake note (no remote calls).

2. **Build seen-ID set from frontmatter.**
   ```ts
   const seen = new Set<string>();
   const queueRoot = plugin.settings.orchestrationQueueRoot;       // skip queue files
   const youtubeRoot = "_crucible/orchestration/youtube";          // skip our own intake notes
   for (const file of app.vault.getMarkdownFiles()) {
     if (file.path.startsWith(queueRoot)) continue;
     if (file.path.startsWith(youtubeRoot)) continue;
     const fm = app.metadataCache.getFileCache(file)?.frontmatter;
     if (!fm) continue;
     // youtube-id property: string or string[]
     const yid = fm["youtube-id"];
     if (typeof yid === "string") seen.add(yid);
     else if (Array.isArray(yid)) yid.forEach(v => typeof v === "string" && seen.add(v));
     // source property: only if it's a YouTube URL
     const src = fm["source"];
     if (typeof src === "string") {
       const id = extractVideoIdFromUrl(src);
       if (id) seen.add(id);
     } else if (Array.isArray(src)) {
       for (const s of src) {
         if (typeof s === "string") {
           const id = extractVideoIdFromUrl(s);
           if (id) seen.add(id);
         }
       }
     }
   }
   ```

3. **Fetch RSS in parallel.** `Promise.allSettled(channels.map(c => fetchChannelFeed(c.channelId)))`.
   - Per-channel failure is recorded but does not abort the run.

4. **Diff.** For each channel's videos, filter out IDs already in `seen`. Group remaining by channel.

5. **Write intake note.**
   - Path: `_crucible/orchestration/youtube/new-videos/${todayInTz(tz)}.md`.
   - If the file already exists (re-run on same day), overwrite (do not merge — this is the latest snapshot).
   - Frontmatter:
     ```yaml
     date: 2026-05-02
     generated_by: orchestrator/youtube_tracker
     channels_total: 5
     channels_with_new: 2
     videos_total: 7
     channels_failed: 1
     ```
   - Body groups per channel:
     ```md
     ## Channel Name (UCxxx)
     - **Video Title** — published 2026-05-01 — https://www.youtube.com/watch?v=VIDEO_ID
     ```
   - If a channel had a fetch error, list under a final `## Failed channels` section with the error message.

6. **Return WorkflowResult** with `outputPaths: [intakeNotePath]` and `notes` summarizing counts. If every channel's fetch failed, return `failed`; else `done`.

## main.ts wiring

```ts
import { YoutubeTrackerWorkflow } from "./orchestration/workflows/YoutubeTrackerWorkflow";

this.orchestrator.register("youtube_tracker", new YoutubeTrackerWorkflow());

this.addCommand({
  id: "orchestrator-enqueue-youtube-tracker",
  name: "Orchestrator: Enqueue YouTube tracker",
  callback: () => void this.orchestrator.enqueue("youtube_tracker"),
});
```

## Verification

1. `npm run build` — clean.
2. **First run with no registry:**
   - Set `orchestrationYoutubeChannelsNote` to a fresh path.
   - Enqueue + run → registry note created with skeleton; job fails with the guiding message.
3. **Two channels happy path:**
   - Add two real channel rows (use known active channels with recent uploads).
   - Run → intake note appears at `_crucible/orchestration/youtube/new-videos/YYYY-MM-DD.md` listing recent videos grouped by channel.
4. **Frontmatter dedupe — `youtube-id`:**
   - Pick one video ID from the intake note. Add a new note anywhere in the vault with frontmatter `youtube-id: <id>`.
   - Wait for `metadataCache` to refresh (or trigger by opening the file).
   - Re-run → that video no longer appears.
5. **Frontmatter dedupe — `source`:**
   - Add a note with frontmatter `source: https://youtu.be/<id>`.
   - Re-run → that video no longer appears.
6. **Body-only references are NOT deduped (intentional):**
   - Add a note containing the line `Watch: https://www.youtube.com/watch?v=<id>` in the body, with no matching frontmatter.
   - Re-run → that video **still appears** in the intake. This is the documented v1 behavior.
7. **Channel fetch failure:**
   - Add a row with an obviously bogus `UC` ID.
   - Run → job ends `done`; intake note has a `## Failed channels` section; valid channels still produce results.
8. **Empty registry:**
   - Clear all data rows.
   - Run → intake note written with `videos_total: 0` and an empty body.
9. **Same-day re-run:**
   - Run twice within a minute. Confirm the intake note is overwritten (latest wins) rather than appended.

## Out of scope (deferred)

- Per-video note generation.
- Body-content scanning for video IDs (handled by a separate "Recommended/Linked Content" worker later).
- Tag/priority filtering of which channels to fetch.
- Quotas, rate limiting, exponential backoff (RSS is unauthenticated and lightweight; YouTube's tolerance is generous for personal use).
- Channel discovery from user input (e.g., resolving handles `@channelname` to UC IDs).
