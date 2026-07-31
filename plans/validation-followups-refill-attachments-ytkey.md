# Validation follow-ups — startup refill, attachment repair, YT key surfacing

*Recommended model/effort — Claude: Sonnet/medium for WP-VF-1/2/3 (well-scoped
implementation against pinned file:line specs), orchestrator-direct close; Codex:
gpt-5.6-terra/medium for VF-1/2/3, gpt-5.6-sol/medium close. WP prefix `vf`. All three
implementation WPs dispatch to subagents.*

## Context

Live-validation feedback round 3 (FEEDBACK.md, 2026-07-31), three items, each grounded
by a read-only exploration pass with file:line evidence before this plan was written:

1. **`image_describe_note` queue refills to ~50–105 jobs on every restart.** Root cause
   proven against the live `jobs.sqlite`: Obsidian replays `vault.on('create')` for
   every pre-existing file during startup indexing. Crucible already defends
   `triggers.start()` against exactly that storm (`main.ts:286-292`) and the search
   coordinator gates on readiness (`SearchIndexCoordinator.ts:102-104`), but the
   auto-localize create listener is registered at `onload` unguarded
   (`main.ts:308-310` → `handleFileCreate` `:969-972` → `autoLocalizeScheduler`). Every
   replayed create schedules a localize pass, and the localizer's *already-localized*
   branch (`localizeAttachments.ts:606`) still enqueues one `image_describe_note` per
   note. The enqueue path (`main.ts:418-425`, sole enqueue site) never consults
   `imageDescriptionStore.has()`; the skip lives only at execution
   (`imageDescribe.ts:323-326`), and dedupe is active-only
   (`SqliteJobStore.ts:121-131`) — so every restart mints real queue rows whose `done`
   results read "Described 0 image(s) (N already described)". Same note observed
   re-enqueued ×8 across restarts.
2. **Missing localized attachments section** (r2f-WP2) needs a follow-up. Exploration
   found two real defects beyond the known gaps: the scan counts `cache.embeds` **and**
   `cache.links` (`data/missingAttachments.ts:48`) but `repairNote`'s
   `parseAttachmentRefs` reads only `cache.embeds` (`localizeAttachments.ts:517`) — a
   broken non-embed link can show `repairable: yes` and silently repair nothing; and
   `repairNote`'s `{repaired, unrepairable}` return is discarded by the section
   (`sections/missingAttachments.ts:54`) with no failure reason recorded anywhere.
   `planLocalAttachmentRepair` (`localizeAttachments.ts:92-101`) is exact-basename-only,
   so the ~6 splice-truncated refs are structurally unreachable; there is no bulk
   repair.
3. **YT features fail invisibly without an API key.** `YoutubeChannelEnrichWorkflow.ts:38`
   fails on a missing key without `failureReason`; but the bigger finding is that the
   no-api-key **auto-source latch is unsound**: `disableAutoSource`
   (`DbJobBackend.ts:430` → `Orchestrator.ts:357-359`) mutates a runtime set only, the
   persisted toggle keeps reading ON, and the dashboard re-asserts enable from the
   persisted setting on every mount (`uncapturedVideos.ts:28-32`) — the latch silently
   un-latches on reload. `failureReason` is never persisted (no DB column), so no UI
   can read it off a job row.

## Decisions locked (user, 2026-07-31)

- **Attachments scope**: bug fixes (embeds/links repair asymmetry + repair-outcome
  surfacing) + **Repair all** heading button + **truncated-ref recovery**
  (unique-prefix match). Dead-ref removal for genuinely-deleted files is explicitly
  **out of scope** this sprint — non-repairable rows keep sitting.
- **Remove the no-api-key latch** rather than persist it. This supersedes the rem-R1 /
  tn-review Decisions-locked #2 latch semantics. The load-bearing surface is instead:
  the Ingestion Dashboard and config surfaces show **"Missing API key"** at the enqueue
  and schedule sites, so the user immediately understands why YT features are not
  firing. Keep `failureReason: 'no-api-key'` stamping (typed signal), add it to
  `YoutubeChannelEnrichWorkflow` for consistency.
- Sonnet/medium workers throughout; orchestrator closes direct.

## Summary

Three independent fixes: (1) gate the auto-localize create path on layout-ready (the
same defense triggers and search already have) and add an enqueue-time
`imageDescriptions.has()` gate so a restart mints zero redundant describe jobs; (2) make
the missing-attachments section's Repair honest (links repaired too, outcomes surfaced,
bulk button) and reach the truncated rows via unique-prefix recovery; (3) replace the
unsound no-api-key latch with visible "Missing API key" affordances modeled on the
Search Modal rerank pattern (`SearchModal.ts:94-114`: pure detector + hint span +
`Configure…` → `openSettingsToTab('orchestrator')`).

## Key Changes

**WP-VF-1 — startup create-replay guard + enqueue-time describe gate.**
*~0.15 kSLOC · ~110k tokens · ~9 min wall · mid (Claude Sonnet/medium; Codex
terra/medium) · Claude: subagent (wash, buys review + headroom); Codex: subagent (same)*
Register the auto-localize `vault.on('create')` listener (or gate `handleFileCreate`)
behind `onLayoutReady`, mirroring the `triggers.start()` defense at `main.ts:286-292` —
edit/modify triggers unchanged (only `create` is replayed). Add
`plugin.imageDescriptions.has(imagePath)` to the enqueue gate in
`enqueueImageDescribeForNote` (`main.ts:418-425`) or `shouldEnqueueImageDescribe`
(`imageDescribe.ts:178-187`) so described/failed-record images never mint a job;
execution-time `has()` stays as the second layer. Existing queued dupes drain as no-ops
(no migration). Tests: gate unit tests + a structural pin that the create listener
registration sits inside the layout-ready path. Files: `src/main.ts`,
`src/orchestration/utils/imageDescribe.ts`, `src/autoLocalizeScheduler.ts` (if the gate
lands there), tests.

**WP-VF-2 — missing-attachments repair: correctness, outcomes, Repair all, truncated-ref recovery.**
*~0.35 kSLOC · ~170k tokens · ~13 min wall · mid (Claude Sonnet/medium; Codex
terra/medium) · Claude: subagent (disjoint scope); Codex: subagent (same)*
(a) Fix the embeds/links asymmetry: `parseAttachmentRefs` (`localizeAttachments.ts:512-539`)
also consumes `cache.links` whose decoded basename is `_MD5`-managed, and the repair
write preserves the ref's original form (link stays a link, embed stays an embed —
extend `formatEmbed`/replacement accordingly). (b) Surface outcomes: the section stops
discarding `repairNote`'s return — per-click feedback maps `{repaired, unrepairable}`
into the row context, and the unrepairable debug line gains a reason
(`missing | ambiguous | remote-download-failed`); excluded-note no-op (`:432`) gets an
explicit Notice instead of silence. (c) **Repair all** heading button following the
Orphaned Attachments shape (`ingestionDashboard.ts:161-165`, cached row set, aggregate
Notice, per-note failure counting) — restorative, no destructive confirm. (d) Truncated-ref
recovery in `planLocalAttachmentRepair` (`localizeAttachments.ts:92-101`): when exact
match fails, prefix-match the broken basename against vault `_MD5` basenames — accept
only a **unique** hit with a minimum-length guard (≥ the `_` + 8 hash chars beyond the
name stem; exact threshold derived from `MD5_NAME_RE`), keeping the function pure and
ambiguity → null. Row `repairable` computation and button state follow automatically.
Tests: pure-function tests for the prefix matcher + links-parsing; extend
`tests/missingAttachments.test.mjs`. Files: `src/localizeAttachments.ts`,
`src/ingestion/data/missingAttachments.ts`, `src/ingestion/sections/missingAttachments.ts`,
`src/ingestionDashboard.ts`, tests.

**WP-VF-3 — YT "Missing API key" surfacing + latch removal.**
*~0.30 kSLOC · ~150k tokens · ~12 min wall · mid (Claude Sonnet/medium; Codex
terra/medium) · Claude: subagent (disjoint scope); Codex: subagent (same)*
(a) Remove the no-api-key latch: delete the `failureReason === 'no-api-key'` →
`disableAutoSource` branch in `DbJobBackend.failEntry` (`DbJobBackend.ts:430`); keep
`disableAutoSource` itself (other callers/tests may exist — verify), update affected
tests. (b) Stamp `failureReason: 'no-api-key'` in `YoutubeChannelEnrichWorkflow.ts:38`
(copy the `YoutubeMetadataFetchWorkflow.ts:107` shape). (c) Affordances, modeled on the
rerank pattern (`SearchModal.ts:94-114` + `tests/searchRerankAffordance.test.mjs`
style): a pure sync detector using
`plugin.secretRegistry.isRegistered(YOUTUBE_DATA_API_SECRET_KEY)`
(`orchestrationWorkflows.ts:286` precedent), and a shared hint+`Configure…` renderer
(deep link `openSettingsToTab('orchestrator')`; hint copy names the path "Orchestrate →
YouTube tracker" since the deep link is tab-level only). Applied at the enqueue/schedule
sites: channel control-center per-row Enrich/Re-enrich + "Enrich all"
(`controlCenters.ts:96-133` — buttons disabled, hint beside, Configure separate because
a disabled button swallows clicks), the Uncaptured videos auto-enqueue surface
(`uncapturedVideos.ts:23-32` skips assertion + section hint when key missing), and the
"Auto-enqueue YouTube metadata" settings toggle (`orchestrationIngestion.ts:38-49`
gains a warning row when the key is missing). `FeedTrackerWorkflow` behavior otherwise
unchanged. Tests: rerank-affordance-style (pure detector cases + structural pins).
Files: `src/orchestration/DbJobBackend.ts`,
`src/orchestration/workflows/YoutubeChannelEnrichWorkflow.ts`,
`src/ingestion/sections/controlCenters.ts`, `src/ingestion/sections/uncapturedVideos.ts`,
`src/settings/sections/orchestrationIngestion.ts`, shared affordance module, `styles.css`,
tests.

**WP-VF-4 — close (orchestrator-direct).**
*~0.05 kSLOC · ~60k tokens · ~5 min wall · top (orchestrator) · Claude: direct
(must-direct: integration/gates/commit duty); Codex: direct (same)*
Docs + quirk deltas: update `src/orchestration/AGENTS.md`'s tracker clause (the
"latches the type's auto-source off" language dies with the latch) and the root quirks
the WPs touch; ledger actuals; deregister the plan; live validation (restart Obsidian →
zero `image_describe_note` refill; missing-attachments section repairs a truncated row
and reports outcomes; with no API key the control center shows Missing API key +
Configure).

## Public Interfaces

- `planLocalAttachmentRepair` gains prefix-recovery semantics (still pure, still
  null-on-ambiguity); `parseAttachmentRefs` includes managed `cache.links`.
- `shouldEnqueueImageDescribe` (or the enqueue wrapper) gains a described-check
  dependency.
- New shared "missing API key" detector + affordance renderer (settings/ingestion
  shared module).
- `WorkflowFailureReason` unchanged; `DbJobBackend` no longer latches on it.

## Execution

Wave 1: VF-1 ∥ VF-2 ∥ VF-3 (disjoint file scopes — VF-1 touches `main.ts` and
`imageDescribe.ts`, VF-2 owns `localizeAttachments.ts` + missing-attachments
data/section, VF-3 owns YT workflows + control centers + orchestrationIngestion; no
overlap) → VF-4 direct. Ask-before-dispatch per fleet rule; workers never commit; one
commit per WP; six gates verbatim per landing (floor **1351/107**, count only grows).

## Test Plan / Verification

Per landing: `npm run lint`; `npx tsc -noEmit -skipLibCheck`; `npm test` (≥1351/107,
0 fail); `node esbuild.config.mjs production`; `grep -rna --include='*.ts' "console\."
src/` → only `src/log.ts`; per touched file `file` + NUL grep. Live validation per
WP-VF-4.

## Critical Files

`src/main.ts` (create listener + enqueue gate), `src/autoLocalizeScheduler.ts`,
`src/orchestration/utils/imageDescribe.ts`, `src/localizeAttachments.ts`,
`src/ingestion/{data,sections}/missingAttachments.ts`, `src/ingestionDashboard.ts`,
`src/orchestration/DbJobBackend.ts`,
`src/orchestration/workflows/YoutubeChannelEnrichWorkflow.ts`,
`src/ingestion/sections/controlCenters.ts`, `src/ingestion/sections/uncapturedVideos.ts`,
`src/settings/sections/orchestrationIngestion.ts`.

## Assumptions

- The startup create-replay sweep was never intentional behavior; gating it changes no
  wanted localize outcome (`localizeAttachmentsTriggerOnCreate` means "localize newly
  created notes", which post-layout-ready creates still are).
- Removing the latch is safe because the only registered auto-source
  (`youtube_metadata_fetch`) becomes visibly gated by the affordances instead; a run
  with a missing key still fails plainly (no `serviceUnhealthy`, breaker untouched).
- Prefix recovery is acceptable at unique-hit-only strictness; if none of the ~6
  truncated rows resolve uniquely, they remain non-repairable (dead-ref removal is a
  later sprint).
- `has()` treating `kind:'failed'` records as "described" at enqueue time is the
  desired poison-skip semantics (matches execution-time behavior).

**Total ≈ 0.85 kSLOC, ~490k raw tokens; ~498k Claude-path / ~335k Codex-path
Opus/Sol-equivalent tokens.**

---

## Completion note (2026-07-31)

All four WPs landed on master; plan closed and deregistered from `pending-plans`.

- **WP-VF-1** → `59aeb56` — auto-localize create listener registered inside
  `onLayoutReady` (mirrors the `triggers.start()` replay defense);
  `isImageAlreadyDescribed` enqueue gate + `ensureLoaded()` warm-up kick.
- **WP-VF-3** → `dd3e43c` — no-api-key auto-source latch removed;
  `YoutubeChannelEnrichWorkflow` stamps `failureReason: 'no-api-key'`; shared
  `src/ingestion/render/apiKeyAffordance.ts` applied at the channel control center,
  Uncaptured videos, and the auto-enqueue settings toggle.
- **WP-VF-2** → `16647f1` — links-aware `parseAttachmentRefsFromCache` + shape-preserving
  `formatRef`; outcome surfacing (excluded-note Notice, per-ref failure reasons,
  scope-honest row Notice); Repair-all heading button (per-note dedupe, failure
  tolerance, aggregate Notice); `resolveLocalAttachmentRepair` unique-prefix tier
  (`PREFIX_REPAIR_MIN_STEM_LENGTH = 8`, ~32 bits of hash entropy).
- **WP-VF-4** → docs close (this commit) — stale latch language corrected in
  `src/orchestration/AGENTS.md`; create-replay quirk + repair-tier amendments in root
  `AGENTS.md`.

Test baseline moved 1351/107 → **1390/109** (+39 tests, +2 files); every WP's gates
green first pass; all three workers Sonnet on fresh worktrees, clean rebases, ff-merges.

**Note:** the "Pinned facts" / Context sections above describe the *pre-change* tree
(including the now-removed `DbJobBackend.failEntry` latch) — they are the historical
grounding record, not current documentation. Current contracts live in the AGENTS.md
files.
