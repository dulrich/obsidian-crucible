# YouTube Ingestion: Ignore-without-metadata, Channel Control Center, Channel Enrichment

## Context

Three related gaps in the YouTube ingestion pipeline:

1. **No way to dismiss a dead capture.** When a video is captured (a vault note gains `yt-video-id`) and the video is later deleted/unavailable, enrichment fails forever and the note sits permanently in the dashboard's "YouTube captures without metadata" backlog with no way to clear it. The existing ignore mechanism (`ignoredIds.ts`) only filters the *uncaptured* discovery list, not this backlog.
2. **No channel-level visibility.** The dashboard shows per-video rows but no per-channel rollup of how many videos are tracked, ingested, or ignored, nor whether a channel is in the tracked registry.
3. **No channel metadata.** Video metadata notes live under `<root>/<channel-slug>/`, but there is no per-channel `about.md` (name, description, stats). The vault knows many channels (from the registry + from video metadata notes) but has no enriched record of them.

Decisions confirmed with the user: Ignore button = *ignore only, keep the note*. Channel enrichment = manual buttons/command **plus** an auto schedule trigger. Channel fetches run **through the orchestrator queue** (paced/deduped like video enrichment).

All paths under `/home/_shared_code/obsidian-crucible`. **First implementation step: copy this plan to `<repo>/plans/` per project convention.**

---

## Feature 1 — "Ignore" button on YouTube captures without metadata

The backlog section is `renderYoutubeNoMetadata` (`src/ingestionDashboard.ts:885`), rows from `computeYoutubeNoMetadataRows` (`src/ingestion/data/uncaptured.ts:132`). The ignore plumbing (`addIgnoredVideoId`, `loadIgnoredVideoIds`) and the dashboard button helper `renderIgnoreButton(td, 'youtube', videoId, ctx, 'ignoredVideos')` (`ingestionDashboard.ts:1107`) already exist and are reused verbatim.

Changes:
- **`src/ingestion/data/uncaptured.ts`** — `computeYoutubeNoMetadataRows` becomes `async` and takes the ignored set: load `await loadIgnoredVideoIds(app)` (or accept it as a param) and `continue` when `ignored.has(videoId)`. This filters dead/ignored captures out of the backlog even though the note stays in the vault. (`loadIgnoredVideoIds` is already imported in this file.)
- **`src/ingestionDashboard.ts`**:
  - `renderYoutubeNoMetadata` (already `async`): `await` the updated compute, and add an Ignore column mirroring `renderUncapturedVideos` (`:863`):
    `{ key: 'ignore', label: '', render: (r, td) => this.renderIgnoreButton(td, 'youtube', r.videoId, ctx, 'ignoredVideos') }`.
  - `renderEnqueueAllMetadataButton` (`:930`) also calls `computeYoutubeNoMetadataRows` — `await` it there too so "Enqueue all" skips ignored captures.

No new types or persistence. The note is left in place; the videoId in the shared ignored-ids note suppresses it from the backlog (and keeps it out of the uncaptured list, which already honors ignored ids).

---

## Feature 2 — Channel Control Center (new dashboard section)

A table section, sorted alphabetically by channel name, with a `show all | tracked | untracked` filter.

### Data: new `src/ingestion/data/channels.ts`
`computeChannelControlRows(app, plugin): Promise<ChannelControlRow[]>` builds the channel universe keyed by **`channelId`** from three sources:
1. **Registry** — `loadConfiguredChannels(app, plugin)` (`feedIntake.ts:243`) → tracked channelIds + names. Marks `tracked: true`.
2. **Tracker intake** — iterate tracker-run files and `parseIntakeVideos(content)` (`feedIntake.ts:280`) to accumulate, per channelId, the set of all discovered videoIds (the "tracked videos" denominator) and channel display names. (Intake only contains registry channels.)
3. **Video metadata notes** — scan `<root>/<channel-slug>/*.md` (root = `orchestrationYoutubeMetadataRoot`, default `_yt_metadata`; skip `about.md`), reading frontmatter `channelId` / `channelTitle` / `videoId` to accumulate ingested videoIds per channel. This discovers **untracked** channels (have notes, not in registry) and supplies the ingested counts.

Then load `await loadIgnoredVideoIds(app)` and, per channelId, compute:
- `knownVideos = union(intakeVideoIds, ingestedVideoIds)`
- `trackedVideos = knownVideos.size`
- `ingestedVideos = ingestedVideoIds.size`
- `ignoredVideos = count(knownVideos ∩ ignored)`
- `tracked = registry.has(channelId)`
- `name = registry name ?? channelTitle ?? intake name ?? channelId`
- `aboutFile` = result of `findExistingChannelAboutNote(app, root, channelId)` (Feature 3) — `TFile | null`

Sort by `name` (locale, case-insensitive).

### Types: `src/ingestion/render/types.ts`
- Add `'channelControl'` to the `SectionId` union.
- Add `interface ChannelControlRow { channelId; name; aboutFile: TFile | null; trackedVideos; ingestedVideos; ignoredVideos; tracked: boolean }`.

### Render: `src/ingestionDashboard.ts`
Follow the standard section recipe (the recon-confirmed five touch points): add a `buildSection('channelControl', 'Channel control center', …, decorateHeader)` call in `mount()`, a `case 'channelControl'` in `renderSection`, include the id in `refreshAll()`, and add `private async renderChannelControl(body, ctx)`.

- **Filter control**: store `private channelFilter: 'all' | 'tracked' | 'untracked' = 'all'` on the UI class. In `renderChannelControl`, build a small controls row using the `crucible-ingestion-queue-controls` pattern from `buildQueueMonitorSection` (`:358`) — three buttons (or a dropdown) that set `this.channelFilter` and call `ctx.refresh()`. Filter rows before passing to `renderTableSection` (so the header count reflects the filtered set).
- **Columns** via `renderTableSection<ChannelControlRow>`:
  - `Channel` — if `aboutFile`, `this.renderFileLink(td, aboutFile, r.name)` (`:1034`); else `renderChannelLink(td, r.channelId, r.name)` (links to youtube.com/channel). Sort key `r.name.toLowerCase()`.
  - `Tracked videos` — `td.setText(String(r.trackedVideos))`.
  - `Ingested` — `${r.ingestedVideos} (${pct(ingested/tracked)}%)`; sort by ratio.
  - `Ignored` — `${r.ignoredVideos} (${pct(ignored/tracked)}%)`; sort by ratio.
  - `Tracked?` — yes/no (or `setIcon` check); sort by boolean.
  - `Enrich` — per-channel button that enqueues channel enrichment (Feature 3, `force: true` so it re-fetches an existing `about.md`).
- **Header action** (`decorateHeader`): an "Enrich all" button mirroring `renderEnqueueAllMetadataButton` (`:930`) that enqueues the channel-enrich **sweep** job (Feature 3).

---

## Feature 3 — Channel metadata enrichment (`about.md`) via Data API, queue + schedule

### API client + note writer: `src/orchestration/utils/youtubeApi.ts`
Mirror the existing video pattern (`fetchYoutubeVideo` / `buildMetadataNoteBody` / `writeYoutubeMetadataNote` / `ensureMetadataNote` / `findExistingMetadataNote`). Reuse `loadYoutubeApiKey` (Secret Storage), `requestUrl`, `resolveChannelFolder`, `slugify`, `ensureFolder`, `yamlString`.
- `interface YoutubeChannelMetadata { channelId; title; description; customUrl; publishedAt; country; thumbnailUrl; subscriberCount; videoCount; viewCount; url }`.
- `fetchYoutubeChannel(apiKey, channelId)` — `GET https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,brandingSettings&id=<id>&key=<key>`, same 403/404/non-200 handling as `fetchYoutubeVideo`.
- `youtubeChannelAboutNotePath(root, slug)` → `<root>/<slug>/about.md`.
- `findExistingChannelAboutNote(app, root, channelId)` — scan each `<root>/<slug>/about.md` and match frontmatter `channelId` (parallels `findExistingMetadataNote`). Returns `TFile | null`.
- `buildChannelAboutNoteBody(meta)` — YAML frontmatter (`channelId`, `title`, `url`, `customUrl`, `publishedAt`, `country`, `subscriberCount`, `videoCount`, `viewCount`, `description`, **`fetched_at: new Date().toISOString()`**, `source_command`) + `# {title}` / `## Description`. The `fetched_at` stamp is the cache record (per the "cache slow-changing external API data" / "persist when seen, don't re-fetch" conventions) — staleness is read from the note itself; no separate settings cache and thus no extra Clear-cache button needed (a per-channel **Enrich** force-overwrite is the equivalent refresh).
- `ensureChannelAboutNote(plugin, channelId, opts: { force?: boolean; maxAgeMs?: number })` — under `withResourceLock('yt-channel', channelId, …)`: find existing `about.md`; if present and **not** `force` and `fetched_at` within `maxAgeMs`, return `exists`; otherwise `fetchYoutubeChannel`, resolve folder via `resolveChannelFolder(app, plugin, channelId, meta.title)`, `ensureFolder`, and `app.vault.create`/`modify` the `about.md`. Returns an `IngestResult`-shaped union.

### Workflows (orchestrator)
- **`src/orchestration/workflows/YoutubeChannelEnrichWorkflow.ts`** — per-channel. Params `{ channelId, force?, channelTitle? }`; calls `ensureChannelAboutNote`.
- **`src/orchestration/workflows/YoutubeChannelEnrichSweepWorkflow.ts`** — coordinator. Enumerates known channels via `computeChannelControlRows` (or a lighter shared helper), and for each channel that is missing/stale (unless `force`) enqueues a `youtube_channel_enrich` job. Used by the dashboard "Enrich all" header button and by the schedule trigger (which can only emit static job seeds).

Register both in `main.ts` near the other `this.orchestrator.register(...)` calls (~145–160). Add `youtubeChannelEnrichJobConfig(plugin)` in `src/orchestration/jobTypeConfig.ts` mirroring `youtubeMetadataJobConfig` (`:121`) — reuse `orchestrationYoutubeMetadataMaxParallel` and `ingestionYoutubeEnrichRateLimitSeconds` for `maxParallel`/`minIntervalMs`, with a `dedupeKey` on `channelId`.

### Dashboard wiring
Per-channel "Enrich" and header "Enrich all" buttons enqueue via `this.plugin.orchestrator.enqueue('youtube_channel_enrich', { channelId, force: true }, …)` and `('youtube_channel_enrich_sweep', {}, …)` respectively, following the `renderEnqueueMetadataCell` / `renderEnqueueAllMetadataButton` button-disable + `Notice` + `ctx.refresh()` idiom.

### Settings (`src/types.ts` + `DEFAULT_SETTINGS` + `src/settings/sections/orchestration.ts`)
Add to `CrucibleSettings` (near the other `orchestrationYoutube*` keys ~412–444) with defaults:
- `orchestrationYoutubeChannelEnrichEnabled: boolean` (default `false`) — gates the schedule trigger.
- `orchestrationYoutubeChannelEnrichIntervalMinutes: number` (default `0` = off).
- `orchestrationYoutubeChannelEnrichMaxAgeDays: number` (default `30`) — staleness TTL; scheduled/sweep runs skip `about.md` younger than this (`maxAgeMs = days * 86_400_000`). Per-channel "Enrich" passes `force: true`.

Render these in `renderEditYoutubeTrackerWorkflow` (`src/settings/sections/orchestration.ts:672`) using `bindToggle` / `bindText`, alongside the existing tracker interval + metadata-root controls.

### Founding schedule trigger (`src/main.ts` `registerFoundingTriggers`, `:394`)
Add, mirroring `youtube-tracker-schedule` (`:409`):
```ts
this.triggers.register({
  id: 'youtube-channel-enrich-schedule',
  description: 'Refresh stale YouTube channel about.md notes on a fixed interval (0 minutes = off).',
  on: { everyMs: () => Math.max(0, this.settings.orchestrationYoutubeChannelEnrichIntervalMinutes) * 60_000 },
  enabled: () => this.settings.orchestrationYoutubeChannelEnrichEnabled,
  jobs: () => [{ type: 'youtube_channel_enrich_sweep' }],
});
```

---

## Critical files

| Concern | File |
|---|---|
| Backlog filter + new Ignore col data | `src/ingestion/data/uncaptured.ts` |
| New channel rollup data | `src/ingestion/data/channels.ts` (new) |
| Channel API client, `about.md` writer, find/ensure | `src/orchestration/utils/youtubeApi.ts` |
| Per-channel + sweep workflows | `src/orchestration/workflows/YoutubeChannelEnrich*.ts` (new) |
| Job config | `src/orchestration/jobTypeConfig.ts` |
| Section id + row type | `src/ingestion/render/types.ts` |
| Section render + buttons + filter | `src/ingestionDashboard.ts` |
| Settings keys/defaults + UI | `src/types.ts`, `src/settings/sections/orchestration.ts` |
| Workflow + trigger registration | `src/main.ts` |

Reused as-is: `renderIgnoreButton`, `renderFileLink`, `renderEnqueueAllMetadataButton`, `renderTableSection`, `renderChannelLink`, `loadConfiguredChannels`, `parseIntakeVideos`, `loadIgnoredVideoIds`/`addIgnoredVideoId`, `resolveChannelFolder`, `slugify`, `ensureFolder`, `yamlString`, the `crucible-ingestion-queue-controls` controls pattern.

---

## Verification

1. **Build/typecheck**: `npm run build` (or the project's tsc/esbuild script) — no type errors; confirm `SectionId` and new settings keys compile.
2. **Ignore button**: in the test vault, create a note with `yt-video-id` and no `yt-metadata` → it appears in "captures without metadata". Click **Ignore** → row disappears, note still exists on disk, videoId added to `_crucible/orchestration/ignored.md`. Refresh dashboard → still hidden; "Enqueue all" no longer targets it.
3. **Channel control center**: open the Ingestion dashboard. Verify the section lists channels alphabetically with tracked/ingested/ignored counts and ratios, a correct `Tracked?` flag, and that `show all | tracked | untracked` filters the rows and the header count. Channel name links to `about.md` once it exists, else to youtube.com/channel.
4. **Channel enrichment (queue)**: set the YouTube Data API key. Click a per-channel **Enrich** → a `youtube_channel_enrich` job runs in the Queue monitor and `<root>/<slug>/about.md` is created with frontmatter (title, description, stats, `fetched_at`). Click again → re-fetches (force) and overwrites. Click **Enrich all** → sweep enqueues per-channel jobs for missing/stale channels only.
5. **Schedule + staleness**: enable `orchestrationYoutubeChannelEnrichEnabled` with a 1-minute interval; confirm the sweep fires (~1 min after load) and **skips** channels whose `about.md` `fetched_at` is within `maxAgeDays`. Set interval back to 0 to disable.
6. **Quota/error path**: with a bad/empty API key, confirm enrichment surfaces a clear Notice (forbidden/quota/not-found) and writes nothing — same handling as `fetchYoutubeVideo`.
