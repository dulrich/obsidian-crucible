# YouTube Data API: per-video metadata fetch

## Context

The existing YouTube Tracker workflow polls RSS feeds for new videos and writes intake notes but never enriches individual notes with detailed metadata. Description, duration, channel info, and view stats are only available via the YouTube Data API v3, which requires an API key and a different call shape.

This change adds a first-class, reusable metadata-fetch primitive plus a direct command to invoke it from the active note. The command derives `yt-video-id` from the active note's frontmatter (already populated by `YoutubeTrackerWorkflow.canonicalizeDetectedIds`), fetches metadata via the YT Data API, writes a standalone metadata note at `<root>/<channelSlug>/<videoId>.md`, and injects `yt-metadata: [[<metadata-note>]]` into the source note's frontmatter immediately after `yt-video-id`. Future workflows (e.g., bulk enrichment, transcript pipelines) can call the same reusable function.

User decisions baked in:

- Channel folder name = slugified registry `name`, looked up by API-returned `channelId`; falls back to slugified API `channelTitle` if the channel isn't registered, then to the channel ID if slugification empties.
- API key stored in `app.secretStorage`, mirroring the AI provider pattern (`src/providers.ts:34,54,59`). Key: `crucible-youtube-data-api-key`.
- If the target metadata note already exists anywhere under `<root>/*/<videoId>.md`, **skip** the API call and just set/refresh the wikilink on the source note. User deletes to force refresh.
- Description goes in the body under `## Description`; all structured fields in YAML frontmatter.

---

## New files

### `src/orchestration/utils/youtubeApi.ts`

Single file holding the API client, secret accessors, slug/path helpers, and note writer. Splitting isn't worth it — one consumer today, all helpers share types and the same error model.

Exports:

- `YOUTUBE_DATA_API_SECRET_KEY = 'crucible-youtube-data-api-key'`
- `loadYoutubeApiKey(app)` / `storeYoutubeApiKey(app, key)` — thin wrappers over `app.secretStorage`, matching the shape of `loadApiKey`/`storeApiKey` in `src/providers.ts:54-62`.
- `interface YoutubeVideoMetadata` — normalized record: `videoId, title, description, duration` (ISO 8601), `durationSeconds` (parsed), `channelId, channelTitle, publishedAt, tags[], categoryId, defaultLanguage, liveBroadcastContent, viewCount, likeCount, commentCount, url`.
- `async fetchYoutubeVideo(apiKey, videoId): Promise<YoutubeVideoMetadata>` — single GET to the Data API. Throws typed errors.
- `buildMetadataNoteBody(meta): string` — pure; YAML frontmatter + `# <title>` + `## Description\n\n<description>`.
- `youtubeMetadataNotePath(root, channelFolder, videoId): string` — `normalizePath(`<root>/<channelFolder>/<videoId>.md`)`.
- `async findExistingMetadataNote(app, root, videoId): Promise<TFile | null>` — walks `<root>/*/<videoId>.md` so the short-circuit works without knowing the channel.
- `async resolveChannelFolder(app, plugin, channelId, channelTitle): Promise<string>` — reads channels registry, looks up by `channelId`, returns `slugify(entry.name)`; falls back to `slugify(channelTitle) || channelId`.
- `async writeYoutubeMetadataNote(app, path, meta): Promise<TFile>` — `ensureFolder` parent, then `app.vault.create(path, body)`.
- `async ingestYoutubeVideoMetadata(plugin, sourceFile, videoId): Promise<IngestResult>` — the reusable entry point (see signature below).

Reuses: `slugify` from `src/utils.ts:52`, `ensureFolder` from `src/utils.ts:5`, `parseChannelsTable` from `src/orchestration/utils/youtube.ts`, `requestUrl` from `obsidian`.

---

## Existing files to modify

### `src/types.ts`

- Add `orchestrationYoutubeMetadataRoot: string` to `CrucibleSettings` (in the youtube_tracker block, ~line 304).
- Add default `orchestrationYoutubeMetadataRoot: '_yt_metadata'` to `DEFAULT_SETTINGS` (~line 401).
- No changes for the API key — it lives in `secretStorage`, not settings.

### `src/main.ts`

- Register one new command in the Orchestrations block (after the existing YT tracker commands at lines 272-283):
  ```ts
  this.registerCrucibleCommand({
    id: 'youtube-fetch-video-metadata',
    name: 'YouTube: fetch video metadata for active note',
    group: 'Orchestrations',
    run: () => this.fetchYoutubeMetadataForActiveNote(),
  });
  ```
- Add private method `fetchYoutubeMetadataForActiveNote()`:
  1. Resolve active file via `this.app.workspace.getActiveViewOfType(MarkdownView)?.file`.
  2. Read `yt-video-id` from `app.metadataCache.getFileCache(file)?.frontmatter` (coerce: `String(value).trim()`; if array, take `[0]`).
  3. Call `ingestYoutubeVideoMetadata(this, file, videoId)`.
  4. Surface every status (success, exists, no-video-id, no-api-key) and thrown errors via `new Notice(...)`.

### `src/settings.ts`

Inside `renderEditYoutubeTrackerWorkflow` (lines 2247-2282), append two rows after the existing three Settings. `FolderSuggest` is already imported (`src/settings.ts:4`).

- **Metadata root folder** — mirror the existing "Channels note" row, but use `FolderSuggest` (folder, not file). Bound to `orchestrationYoutubeMetadataRoot`, placeholder `_yt_metadata`, empty input defaults back to `_yt_metadata`.
- **YouTube Data API key** — copy the AI provider API key pattern verbatim from `src/settings.ts:1189-1200`:
  - `inputEl.type = 'password'`
  - No `setValue` (never pre-fill — security)
  - `onChange` writes via `storeYoutubeApiKey(this.app, v)`
  - Desc: "Stored securely in Obsidian Secret Storage. Required for the per-video metadata fetch command."

Import `storeYoutubeApiKey` from `./orchestration/utils/youtubeApi`.

---

## Reusable function signature

```ts
type IngestResult =
  | { status: 'created';     metadataPath: string; createdNew: true;  linkUpdated: boolean }
  | { status: 'exists';      metadataPath: string; createdNew: false; linkUpdated: boolean }
  | { status: 'no-video-id'; metadataPath: null }
  | { status: 'no-api-key';  metadataPath: null };

export async function ingestYoutubeVideoMetadata(
  plugin: CruciblePlugin,
  sourceFile: TFile,
  videoId: string,
): Promise<IngestResult>;
```

Behavior:

1. **Existence short-circuit:** call `findExistingMetadataNote(app, root, videoId)`. If hit, use its path verbatim — no API call, no key check.
2. Otherwise load the API key; if missing return `{ status: 'no-api-key' }`.
3. `fetchYoutubeVideo(...)` → `resolveChannelFolder(...)` → `writeYoutubeMetadataNote(...)`.
4. In all path-producing branches, update source-note frontmatter once:
   ```ts
   await updateFrontmatter(plugin.app, sourceFile, fm => {
     insertFrontmatterPropertyAfter(fm, 'yt-video-id', 'yt-metadata', `[[${stripMdExt(path)}]]`);
   });
   ```
   `insertFrontmatterPropertyAfter` (`src/frontmatter.ts:37`) replaces in place if `yt-metadata` exists, inserts after `yt-video-id` otherwise, and appends if the anchor is missing.
5. API errors throw; status outcomes (missing FM, missing key) return cleanly so callers decide UX.

---

## YouTube Data API v3 call

- `GET https://www.googleapis.com/youtube/v3/videos`
- Query: `part=snippet,contentDetails,statistics,status` + `id=<videoId>` + `key=<apiKey>` (+ optional `fields=` filter to reduce payload).
- Transport: `requestUrl({ url, method: 'GET', throw: false })` — same wrapper used by `fetchChannelFeed` (`src/orchestration/utils/youtube.ts:65`).
- Empty `items[]` → treat as 404 ("video not found").
- Errors thrown with a `YouTube Data API:` prefix for grep-ability — quota exceeded, forbidden (403), not found (404 / empty items), and a generic non-200 fallback.
- `contentDetails.duration` kept raw in YAML; `durationSeconds` derived from a tiny inline regex `/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/` (no dep needed; fall back to `null`).
- `statistics.{viewCount,likeCount,commentCount}` arrive as strings — coerce via `Number()`; `NaN` → `null`.

---

## Metadata note schema

```yaml
---
videoId: dQw4w9WgXcQ
title: "<verbatim>"
url: https://www.youtube.com/watch?v=dQw4w9WgXcQ
channelId: UCxxxx...
channelTitle: "<verbatim>"
publishedAt: 2009-10-25T06:57:33Z
duration: PT3M33S
duration_seconds: 213
categoryId: "10"
defaultLanguage: null
liveBroadcastContent: none
tags: []                          # omit key entirely if empty
viewCount: 1500000000
likeCount: 17000000
commentCount: 2000000
fetched_at: 2026-05-23T12:34:56Z
source_command: youtube-fetch-video-metadata
---

# <title>

## Description

<description verbatim, preserve newlines>
```

Frontmatter assembled as a string (same approach as `YoutubeTrackerWorkflow.ts:199-216`) because we create the file via `app.vault.create`, not `processFrontMatter`.

---

## Edge cases

| Case | Behavior |
|---|---|
| No active markdown view / file | `Notice('No active note')`, return. |
| Active note has no `yt-video-id` (non-string / empty) | `Notice('Active note has no yt-video-id in frontmatter')`; status `no-video-id`. |
| API key missing in `secretStorage` | `Notice('YouTube Data API key not set — configure it in Settings → Orchestrator → YouTube Tracker')`; status `no-api-key`. |
| API 403 / 404 / quota | Error bubbles; `Notice('YouTube fetch failed: <message>')`. |
| Channel not in registry | Silently slugify the API `channelTitle`; file still written. |
| Metadata file already exists (any channel folder under `<root>`) | Skip API call entirely; still set/refresh wikilink. Notice: `Metadata already exists; linked.` |
| `<root>` folder doesn't exist | `ensureFolder` creates it. |
| `slugify(channelTitle)` returns empty (emoji-only name) | Fall back to `channelId`. |
| `videoId` from FM has whitespace / is an array | Coerce via `String(...).trim()` or `[0]`. |
| `yt-metadata` already points to a different path | `insertFrontmatterPropertyAfter` overwrites — desired. |
| `app.secretStorage` undefined (mobile) | `loadYoutubeApiKey` returns `''` → "no API key" path. |

---

## Critical files

- `src/orchestration/utils/youtubeApi.ts` — **NEW**; client, secrets, writer, `ingestYoutubeVideoMetadata`.
- `src/main.ts` — register command + private handler.
- `src/settings.ts` — extend `renderEditYoutubeTrackerWorkflow` with two new rows (metadata root, API key).
- `src/types.ts` — add `orchestrationYoutubeMetadataRoot` field + default.
- `src/frontmatter.ts` — **no changes**; reuse `updateFrontmatter` + `insertFrontmatterPropertyAfter`.
- `src/utils.ts` — **no changes**; reuse `slugify`, `ensureFolder`.
- `src/orchestration/utils/youtube.ts` — **no changes**; reuse `parseChannelsTable`.

---

## Verification

Pre-implementation: copy this plan to `/home/_shared_code/obsidian-crucible/plans/yt-data-api-metadata-fetch.md` (per CLAUDE/AGENTS guidance).

**Manual end-to-end in Obsidian:**

1. Settings → Orchestrator → Workflows → YouTube Tracker → paste a real Data API key into the new password row; reload Obsidian and confirm the field comes up empty (not pre-filled).
2. Confirm `_system/youtube/Channels.md` has a row whose `ID` matches the channel of the test video. Also prepare a video from an *unregistered* channel for fallback testing.
3. Open a note containing `yt-video-id: dQw4w9WgXcQ` in frontmatter.
4. Run command: `YouTube: fetch video metadata for active note`.
5. Verify:
   - File created at `_yt_metadata/<channel-slug>/dQw4w9WgXcQ.md` with the schema above.
   - Source note frontmatter has `yt-metadata: [[_yt_metadata/<channel-slug>/dQw4w9WgXcQ]]` immediately after `yt-video-id`.
   - Outgoing-links panel shows the new link.
6. Re-run on the same note → `Metadata already exists; linked` notice; no new file; no API call burned.
7. Edge sweep:
   - Note without `yt-video-id` → "no yt-video-id" notice.
   - API key cleared → "API key not set" notice.
   - Garbage video ID → "video not found" notice.
   - Unregistered channel → file lands under `_yt_metadata/<slugified-channelTitle>/`.

**Mandatory cleanup loop (AGENTS.md lines 25-33), sequentially, not backgrounded:**

1. `npm run lint`
2. `npx tsc -noEmit -skipLibCheck`
3. `node esbuild.config.mjs production`
4. All three exit 0; `main.js` updated.

After verification, consider adding a `## Quirks` entry to `AGENTS.md` if the Data API call surfaces non-obvious behavior (per the user's memory rule on documenting quirks).
