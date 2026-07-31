# YouTube Data API tracker swap + round-2 dashboard follow-ups

*Recommended model/effort — Claude: Sonnet/medium for all dispatched WPs; Codex:
Terra/medium. WP prefix `r2f`. Orchestrator closes direct (WP-4).*

## Context

Live-validation feedback round 2 (2026-07-30), after the thq sprint closed. Three items
survived triage (a fourth — the queue-monitor split-row glitch — was a one-class CSS fix
landed directly as `8c13cda`):

1. **YouTube RSS is dead server-side.** Every channel feed
   (`https://www.youtube.com/feeds/videos.xml?channel_id=…`) returns HTTP 404 with
   Google's generic 404 page — verified from this machine against three known-active
   channels, and widely reported (FreshRSS #8808, n8n community, Google support threads)
   as ongoing degradation/abandonment of open syndication since ~May 2026. The
   `youtube_tracker` job has failed with "All 15 channel feeds failed to fetch" since
   2026-07-29. The Data API key is already configured and used by metadata enrichment.
2. **Missing localized attachments audit.** The inverse of the Orphaned Attachments
   scan: notes referencing `*_MD5.*` files that don't exist. A raw-text set-diff found
   13 referenced-but-missing basenames — ~7 full 32-hex (genuinely deleted files) and
   ~6 truncated hashes (`30`, `37`, `41`, `42`, `d`, `62f1c7a18aac3`, `f9bbc66d52d85` —
   the historical splice-corruption class, likely repairable by the existing repair
   machinery). User chose a permanent dashboard section over a one-off report.
3. **Service-health breaker pill lingers.** Cancelling the sole queued `youtube_tracker`
   retry removed the only job that could ever serve as the half-open probe, so the
   YOUTUBE-RSS pill sat open → half-open forever (breaker is in-memory; reload is the
   only reset). User chose hide-when-idle semantics: the pill renders only while
   queued/running jobs of a type declaring that service exist; breaker state (backoff
   memory) is preserved.

Ground truth for every file:line below was pinned by three read-only Explore passes this
session; briefs cite this plan, workers do not re-derive.

## Decisions locked (user-confirmed 2026-07-30)

- Tracker fetch swaps to the Data API (`playlistItems.list`); RSS is retired, not kept
  as a fallback (endpoint is 404, not flaky).
- Missing-attachment audit ships as a dashboard section ("Missing localized
  attachments"), not a repair-command extension or one-off report.
- Breaker pill: hide-when-idle. No reset-on-cancel, no dismiss affordance.

## Summary

Three independent, small work packages plus an orchestrator close. The tracker swap
replaces one function behind an existing seam (`YOUTUBE_FEED_SOURCE.fetchFeed`) and
re-labels the tracker's service id to `youtube-api`; the audit section is a fourth
scan-class dashboard table cloned from the Orphaned Attachments pattern; the pill fix is
a pure predicate plus one extra event subscription.

## Key Changes

**WP-r2f-1 — youtube_tracker fetch → Data API playlistItems.list.**
*~0.30 kSLOC · ~180k tokens · ~14 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent (dispatch 148k vs direct 360k); Codex: subagent (110k
vs 180k)*
Scope: new `fetchChannelUploads(plugin, channelId)` (in
`src/orchestration/utils/youtubeApi.ts`, beside the existing client): derive the uploads
playlist id by string-swapping the registry's canonical `UC` prefix to `UU` (every
registry row is guaranteed `UC…` — `parseChannelsTable` drops others,
`src/orchestration/utils/youtube.ts:54` — so **no `channels.list` resolution call is
needed**; 1 quota unit per channel per poll), then GET
`playlistItems?part=snippet,contentDetails&playlistId=UU…&maxResults=15&key=…` through
the existing `requestYoutubeApi` (`youtubeApi.ts:76-112` — full 429/quota-403/5xx
classification for free). Map items → the existing `RemoteVideo` contract
(`youtube.ts:11-17`, five non-optional strings): `videoId` from
`contentDetails.videoId ?? snippet.resourceId.videoId` (validated by the existing
11-char regex), `title` (default `'(untitled)'`), `publishedAt` from
`contentDetails.videoPublishedAt ?? snippet.publishedAt ?? ''`, `channelName` from
`snippet.channelTitle`, `url` synthesized `https://www.youtube.com/watch?v=<id>` —
the `watch?v=` shape is load-bearing for consolidation's bullet round-trip
(`feedSources.ts:285-300`). Extract the item→RemoteVideo mapping as an exported pure
function for tests. Swap point: `YOUTUBE_FEED_SOURCE.fetchFeed`
(`src/orchestration/utils/feedSources.ts:108`); `FeedSource.fetchFeed` gains the plugin
as an argument (call site `FeedTrackerWorkflow.ts:87-92` passes `ctx.plugin`; the blogs
source ignores it) so the fetch can read the API key via
`loadYoutubeApiKey` (`youtubeApi.ts:114`). Missing/empty key ⇒ throw a plain actionable
Error ("YouTube Data API key not configured…") — a config gap is a per-run failure, not
service unhealth. Service id: `youtubeTrackerJobConfig` services →
`[SERVICE_YOUTUBE_API]` (`src/orchestration/jobTypeConfig.ts:160`) and the all-failed
defer branch (`FeedTrackerWorkflow.ts:143-151`) reports `service: 'youtube-api'`; when
the settled errors include a `YoutubeApiUnavailableError`, use its `kind`/`retryAfterMs`
instead of the hardcoded `server-error`/30s. Delete `fetchChannelFeed`/`parseRssFeed`
(`youtube.ts:73-109`) and `SERVICE_YOUTUBE_RSS` (`serviceHealth.ts:44`); update the
`all-channel-feeds-failed` repair-rule rationale prose (`failedJobRepair.ts:66-71` —
regex unchanged, message literal is preserved). NOT in scope: Shorts filtering (uploads
playlist `UU…` includes Shorts, matching RSS behavior — a `UULF` opt-out is a future
setting), pagination (maxResults=15 matches RSS's 15-entry pages; the seen-set absorbs
gaps), consolidation (never fetches — `FeedTrackerWorkflow.ts:336-379`). Tests:
`tests/feedTrackerServiceHealth.test.mjs` updates its `'youtube-rss'` pins to
`'youtube-api'`; new pure-function tests for the uploads-id derivation and the
playlistItems→RemoteVideo mapping (missing videoId, missing published, untitled);
`tests/failedJobRepair.test.mjs` literals unchanged. Files:
`src/orchestration/utils/youtubeApi.ts`, `youtube.ts`, `feedSources.ts`,
`src/orchestration/workflows/FeedTrackerWorkflow.ts`, `src/orchestration/jobTypeConfig.ts`,
`src/orchestration/serviceHealth.ts`, `src/orchestration/failedJobRepair.ts`, tests.

**WP-r2f-2 — "Missing localized attachments" dashboard section.**
*~0.35 kSLOC · ~220k tokens · ~17 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent (172k vs 440k); Codex: subagent (130k vs 220k)*
Scope: inverse of Orphaned Attachments — one row per broken `*_MD5.*` ref. Data helper
`computeMissingAttachmentRows(app)` in new `src/ingestion/data/missingAttachments.ts`:
walk `getMarkdownFiles()`, read `getFileCache(f)?.embeds ?? []` (+ `links` for
non-embed refs), keep refs whose decoded basename matches `MD5_NAME_RE`
(`src/localizeAttachments.ts:14`) and where
`metadataCache.getFirstLinkpathDest(link, f.path)` is not a `TFile` — the exact
brokenness predicate `repairNote` itself uses (`localizeAttachments.ts:427`). Row type
`MissingRefRow { note: TFile; link: string; repairable: boolean }` in
`src/ingestion/render/types.ts` (~:178, beside `OrphanRow`); `repairable` via the pure
`planLocalAttachmentRepair(link, expectedFolder, vaultPaths)`
(`localizeAttachments.ts:92-102`) with `expectedFolder` from
`attachmentFolderForNote` (`:806`). Section
`src/ingestion/sections/missingAttachments.ts` cloned from
`sections/orphanedAttachments.ts`: same `metadataCacheReady` waiting-state gate
(`orphanedAttachments.ts:28-34`), `shouldRepaint`/`computeRowSignature`,
`renderTableSection` with `rowKey: r => r.note.path + '→' + r.link`; columns Note
(`renderFileLink`), Broken ref, Repairable (neutral pill `is-muted` yes/no — not a
status hue; a broken ref's alarm is the row itself), and a per-row **Repair** button
(enabled only when repairable) calling
`plugin.attachmentLocalizer.repairNote(row.note)` then `ctx.refresh()` — repair is
restorative, not destructive: no `confirmDestructive`, no `mod-warning`. Wiring
(every site pinned): `SectionId` union (`render/types.ts:22`), `SCAN_SECTIONS`
(`ingestionDashboard.ts:67-69`), import/field/constructor
(`:24`/`:94`/`:116` area), `buildSection` in `mount()` (after orphanedAttachments,
`:158-164`), `refreshAll` ids (`:473-488`), `renderSection` switch (`:500-515`),
`route()` markDirty beside every `orphanedAttachments` site (structural branch `:304`,
links-changed meta branch `:331`), and the one-shot `'resolved'` listener
(`:341-346`) marks both sections. Structural test:
`tests/ingestionTableCapAndGating.test.mjs:254-270` **must** gain
`'missingAttachments'` in its SCAN list (the partition test fails otherwise — that
failure is the checklist); new unit tests for the row-computation predicate (factor the
per-ref decision — decode, basename, MD5 match, dest-missing — as a pure function over
plain inputs). NOT in scope: bulk repair-all button (per-row only, 13 known rows),
frontmatter-only refs (`frontmatterLinks` — same accepted gap as the orphan scan,
`data/orphanedAttachments.ts`), auto-repair. Files: new `data/missingAttachments.ts`,
new `sections/missingAttachments.ts`, `render/types.ts`, `src/ingestionDashboard.ts`,
`src/localizeAttachments.ts` (only if a helper needs exporting),
`tests/ingestionTableCapAndGating.test.mjs`, new test file, `docs/` dashboard note.

**WP-r2f-3 — breaker pill hide-when-idle.**
*~0.15 kSLOC · ~120k tokens · ~9 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent (112k vs 240k); Codex: subagent (80k vs 120k)*
Scope: a pill renders only while at least one queued/running job of a type declaring
its service exists; breaker state is untouched (backoff memory preserved — pill
reappears if work returns while still open). Both halves exist:
`Orchestrator.typesDependingOn(service)` (`Orchestrator.ts:418`) and synchronous
`hasPending(type)` (`Orchestrator.ts:534-536` → one indexed
`countByTypeAndStatus(type, ['queued','running'])`,
`db/SqliteJobStore.ts:104-115`). Export a pure predicate from
`src/ingestion/sections/queueMonitor.ts` —
`shouldRenderServicePill(snapshot, hasActiveWork: boolean): boolean` (false whenever
`!hasActiveWork`, regardless of state; otherwise the existing state→pill mapping in
`serviceHealthPill`, `queueMonitor.ts:56-66`, decides) — and apply it in
`renderServiceHealthPills` (`:79-87`) with `hasActiveWork =
typesDependingOn(s.service).some(t => orchestrator.hasPending(t))`. The re-render gap:
queue events never reach the health row (`healthRow` is built once at `:261` and only
the `onTransition` subscription at `:263` repaints it), so hiding-on-last-settle needs a
second subscription — `bus.on('orchestration-queue-updated', () =>
renderServiceHealthPills(host, healthRow))` registered beside `:263` with its own
`host.registerDisposer`. Update the contract comment at `:48-54`. Tests: new unit
coverage for the exported predicate (open+active ⇒ render; open+idle ⇒ hidden;
closed+lastKind+active ⇒ muted pill; closed+no-lastKind ⇒ never) — pure-function style
per the existing `queueMonitorJobDetail.test.mjs` precedent; a structural pin that
`renderServiceHealthPills` has both subscriptions with disposers. NOT in scope: any
serviceHealth.ts state-machine change, countdown timers, per-pill dismiss. Files:
`src/ingestion/sections/queueMonitor.ts`, tests.

**WP-r2f-4 — close (orchestrator-direct).**
*~0.05 kSLOC · ~50k tokens · ~5 min wall · must-direct (integration/gates/commit duty)*
Docs (`docs/orchestration.md` workflow list — YouTube Tracker line says Data API;
tracked-sources doc if it mentions RSS), quirk deltas (orchestration AGENTS.md quirk
index lines touching "youtube-rss"/RSS), ledger actuals rows, remove this plan from
`pending-plans`, live validation with the user (tracker run succeeds against the API;
missing-attachments section shows the 13 known rows and repairs the truncated ones;
cancelled-job pill disappears).

## Public Interfaces

- `FeedSource.fetchFeed(entry, plugin)` — gains the plugin argument (internal seam,
  two implementors).
- `youtubeTrackerJobConfig().services` becomes `['youtube-api']`;
  `SERVICE_YOUTUBE_RSS` deleted. The tracker and metadata enrichment now share one
  breaker — intentional: one upstream, one breaker.
- New exports: `fetchChannelUploads` + playlistItems mapping fn (`youtubeApi.ts`),
  `computeMissingAttachmentRows`, `shouldRenderServicePill`.
- New `SectionId` member `'missingAttachments'` (SCAN class).

## Execution

Wave 1: **WP-1 ∥ WP-2 ∥ WP-3** (disjoint file scopes — WP-1 orchestration/utils +
workflows; WP-2 ingestion/data + sections + dashboard; WP-3 queueMonitor.ts only; the
single shared file risk is none: WP-2 touches `sections/`, WP-3 touches
`sections/queueMonitor.ts` — disjoint files). Then WP-4 direct. Ask-before-dispatch;
workers never commit; briefs to `runs/dispatch/r2f-wp<n>-brief.md`; worktrees branch
from local master tip; one commit per WP; full gate loop verbatim per landing
(baseline **1262/103**, count only grows); pause for user compaction at WP boundaries
if context demands.

## Test Plan / Verification

Gates per landing: `npm run lint` · `npx tsc -noEmit -skipLibCheck` · `npm test` ·
`node esbuild.config.mjs production` · `grep -rna --include='*.ts' "console\." src/`
(only `src/log.ts`) · `file` + `LC_ALL=C grep -caP '\0'` per touched file. Live
validation (WP-4, with user): run `youtube_tracker` manually → intake note written,
no "channel feeds failed"; dashboard shows Missing localized attachments with the 13
known rows, Repair fixes a truncated-hash ref; with the queue empty of youtube jobs,
no youtube pill renders even while the breaker is open.

## Critical Files

`src/orchestration/utils/youtubeApi.ts` · `src/orchestration/utils/feedSources.ts` ·
`src/orchestration/workflows/FeedTrackerWorkflow.ts` · `src/orchestration/jobTypeConfig.ts`
· `src/ingestion/data/orphanedAttachments.ts` (pattern) · `src/ingestionDashboard.ts` ·
`src/ingestion/sections/queueMonitor.ts` · `src/localizeAttachments.ts` ·
`tests/ingestionTableCapAndGating.test.mjs` · `tests/feedTrackerServiceHealth.test.mjs`

## Assumptions

- The Data API key currently stored works for `playlistItems.list` (same key class as
  the working `videos.list` calls; no extra API enablement expected). If the first live
  run 403s on API-not-enabled, that's a user console action, not a code change.
- Uploads-playlist ids are always `UU` + channel-id suffix (documented YouTube
  invariant; the registry guarantees `UC…` inputs).
- 15-per-poll page depth is sufficient (matches RSS behavior; consolidation +
  seen-set absorb any misses).
- Quota headroom is ample: 15 channels × 96 polls/day ≈ 1,440 units vs 10k default.

**Total ≈ 0.85 kSLOC, ~570k raw tokens; ~532k Claude-path / ~370k Codex-path
Opus/Sol-equivalent tokens.**
