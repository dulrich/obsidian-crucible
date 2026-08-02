# Plan K — YT taken-down tombstones + queue-monitor muted-never-absent

Repo: **obsidian-crucible** · slug `yt-takedown-tombstones-queue-action-alignment` · follows Plan J (closed at `1be7030`). Born from user validation feedback 2026-08-02 (second batch).

*Recommended model/effort — Claude: Sonnet/medium K1, Sonnet/low K2, orchestrator (Fable) closes K3 direct; Codex: Terra/medium K1, Terra/low K2, Sol/medium orchestrator.*

## Context

Two user-reported gaps. (1) **Taken-down YouTube videos** (deleted/private — valid former IDs) sit in the "YouTube captures without metadata" backlog forever, and worse: the API returns 200 + `items: []`, today's code throws a plain untyped `Error` (`youtubeApi.ts:221-224`), the job settles **failed**, and re-minting is unbounded — dedupe spans active rows only (`SqliteJobStore.findActive`, status IN queued/running), so the per-row Enqueue button, **Enqueue all** (skips only in-flight rows), and the `yt-metadata-on-capture` trigger (refires on every `metadata-changed`) each re-enqueue every dead video indefinitely, burning 1 quota unit per attempt. (2) **Queue Monitor running rows misalign**: Run is omitted (not muted) for non-queued rows and Cancel omitted for terminal rows (`queueMonitor.ts:679`, `:707`), so the action cell drops 3 → 2 → 1 children while the CSS is deliberate flow layout (grid was rejected for real reasons, `styles.css:735-745`) — Details and Cancel slide out of their visual columns. This directly violates the root AGENTS.md "Muted, never absent" law, which `:136` explicitly extends to queue monitor rows, and a structural test (`tests/queueMonitorStatusFilter.test.mjs:246`) actively pins the buggy omission.

## Decisions locked (user-confirmed 2026-08-02)

- **Tombstone-on-fetch** for taken-down videos, mirroring the X pipeline precedent — no batch prober, no ignore-based workaround.
- **Snapshot forever**: tombstone = permanent; probe treats it as exists; no refetch ever. Hand-deleting the tombstone note is the manual escape hatch.

## Summary

Two dispatched WPs (disjoint file scopes, one wave) + close. K1 ports the X tombstone mechanics to YouTube: typed `YoutubeVideoUnavailableError` from the zero-items branch, `_unavailable/<videoId>.md` tombstone under the YT metadata root, job settles `done`, breaker untouched. The existing probe/link/backlog machinery needs **zero changes**: `findExistingMetadataNote`'s one-level child-folder scan finds the tombstone, `appendYtMetadataLink` makes `yt-metadata` non-empty, which removes the note from the backlog section AND silences the on-capture trigger — the unbounded re-mint dies as a side effect. K2 restores the "always three children" invariant in the queue action cell using the muted mode `renderIconButton` already implements.

## Key Changes

**WP-K1 — YouTube taken-down tombstones (X-pipeline port).**
*~0.35 kSLOC · ~220k tokens · ~17 min wall · mid (Claude Sonnet/medium; Codex Terra/medium) · Claude: subagent (70% saving); Codex: subagent (50%)* — high-fidelity port of an existing in-repo exemplar; the semantics are already settled by the X precedent.
(a) `YoutubeVideoUnavailableError` in `src/orchestration/utils/youtubeApi.ts` beside `YoutubeApiUnavailableError` (`:23`), modeled on `XPostUnavailableError` (`src/orchestration/utils/xApi.ts:27-43` — carries `reason: 'deleted-or-private'`, doc: never opens the breaker); thrown from the zero-items branch (`youtubeApi.ts:221-224`) and the 404 branch (`:123-125`). (b) Tombstone materialization inside `ensureMetadataNote` (`youtubeApi.ts:424-454`), try/catch around `fetchYoutubeVideo` at `:440` mirroring `xApi.ts:266-287`: `<root>/_unavailable/<videoId>.md`, collision-checked, frontmatter-only body modeled on `buildXTombstoneNoteBody` (`xApi.ts:223-234`): `yt-video-id`, `url` (canonical watch URL), `state: unavailable`, `unavailable-reason`, `fetched_at`, `source_command`. **No `channelId`** — `IngestResult` gains its own `{status: 'tombstoned'; metadataPath}` variant (`created` requires `channelId`, `youtubeApi.ts:176-180`; construct-don't-spread per the `WorkflowResult` union rule). (c) `ingestYoutubeVideoMetadata` links the tombstone like any metadata note (it already links whenever `result.metadataPath` is truthy, `:487-491`) → backlog exit + trigger silence for free. (d) `YoutubeMetadataFetchWorkflow` maps `tombstoned` → `done` with an X-style notes line (`XMetadataFetchWorkflow.ts:109-117` wording as template); channel chaining untouched (already `created`-only). `maybeChainChannelEnrich` and referenced-video mode both flow through unchanged. (e) **sourceEval guard**: `parseYtMetadataChannelFromLink` (`src/sourceEval/captureIndex.ts:75-83`) would attribute channel `"_unavailable"` for a note whose `yt-metadata[0]` is a tombstone — return null for the `_unavailable` segment so the fallback declines instead of minting a phantom channel. (f) Docs: new quirk in `src/orchestration/AGENTS.md` (YT tombstone = done, never the breaker — the X rule's sibling; snapshot semantics; hand-delete escape hatch) + **fix the stale sentence at `src/orchestration/AGENTS.md:83`** ("captures without metadata section is intentionally unaffected" by ignore-seeding — false since r-4, `uncaptured.ts:29,:36` consults `loadIgnoredVideoIds`) + refresh the `failedJobRepair.ts:60-65` rationale comment (the "not found" failure text disappears from failed jobs). (g) Tests: zero-items → typed error; tombstone created once, collision returns `tombstoned`; job settles `done`, breaker never opens (no `serviceUnhealthy`); `yt-metadata` linked and note leaves `computeYoutubeNoMetadataRows`; capture trigger guard goes quiet; channel-chain NOT fired on tombstone; `parseYtMetadataChannelFromLink` `_unavailable` guard; referenced-video mode tombstones identically. Files: `src/orchestration/utils/youtubeApi.ts`, `src/orchestration/workflows/YoutubeMetadataFetchWorkflow.ts`, `src/sourceEval/captureIndex.ts`, `src/orchestration/failedJobRepair.ts` (comment), `src/orchestration/AGENTS.md`, tests. NOT in scope: batch `videos.list` prober, re-probe affordance, dashboard tombstone listing (the X-posts-style state pill — the section row simply disappears, which is the point), ignored-IDs mechanics.

**WP-K2 — queue-monitor action cell: muted, never absent.**
*~0.06 kSLOC · ~90k tokens · ~7 min wall · mid-low (Claude Sonnet/low; Codex Terra/low) · Claude: subagent (70% saving); Codex: subagent (50%)* — small, but rewrites a structural pin and touches the shared cell all queue rows ride.
(a) `src/ingestion/sections/queueMonitor.ts:679` — add the `else`: muted `play` (`disabled: true`, `ariaLabel: 'Run'`, status-specific title: running → "already running", terminal → "finished jobs aren't re-run from the queue"). (b) `:707-709` — drop the guard, always call `renderCancelAction`; widen its `status` param (`:736`) to the full row-status union with an early muted-`x` branch for terminal statuses **before** the `isCancelling` check at `:741`; terminal Cancel skips `mod-warning` (nothing destructive on offer — one-line comment, since `:753-762` explains why the live one carries it). (c) Rewrite the `:669-673` comment (it documents the behavior being removed). (d) NO CSS changes — flow layout at `styles.css:735-745` is load-bearing (grid broke row painting in live validation 2026-07-30); restoring the 3-children invariant fixes alignment for free. (e) Tests: **replace the omission-pinning structural test** (`tests/queueMonitorStatusFilter.test.mjs:246-255`) with the inverse — all three actions render at every status, Run/Cancel `disabled: true` where inapplicable — plus a behavioral DOM assertion (3 children for each of queued/running/done). The primitive (`renderIconButton`, `src/ingestion/render/cells.ts:83-97`) already never wires clicks on `disabled` — zero changes there; muted exemplar with explanatory title: `searchAudit.ts:404`. Files: `src/ingestion/sections/queueMonitor.ts`, `tests/queueMonitorStatusFilter.test.mjs`. NOT in scope: `cells.ts`, `styles.css`, other dashboards' action cells.

**WP-K3 — close (orchestrator-direct).**
*~0.02 kSLOC docs · ~20k tokens · ~5 min wall · top (orchestrator) · Claude: direct (must-direct: integration/gates/commit duty); Codex: direct (same)*
Combined diff review; full gates on merged master; completion blockquote; deregister from `pending-plans`; ledger actuals; live-validation checklist to the user.

## Public Interfaces

`IngestResult` (youtubeApi.ts) gains a `tombstoned` variant. New error class `YoutubeVideoUnavailableError`. New vault artifact class: `<yt-metadata-root>/_unavailable/<videoId>.md` (`state: unavailable`). No settings, no job types, no wire changes. Queue monitor DOM: action cell now always has three buttons.

## Execution

One wave: K1 ∥ K2 (fully disjoint file scopes). K3 close. Worker worktrees branch from local master tip (`1be7030` or later); workers never commit; orchestrator reviews the full diff, re-runs all six gates verbatim, commits `(subagent k-N)`, ff-merges. Ask the user before the dispatch wave. On approval: plan doc → `plans/yt-takedown-tombstones-queue-action-alignment.md` + registered in `INITIATIVE.md` `pending-plans` (docs-only commit) before any source edit.

## Test Plan / Verification

Six crucible gates verbatim per landing (floor **1975 tests / 153 files**, count only grows). Live validation: click "Enqueue all" on the captures-without-metadata backlog — dead videos each cost one API call, materialize `_unavailable/<id>.md`, settle `done`, and their rows disappear from the section permanently (no re-mint on later clicks or note edits); the breaker stays closed throughout; queue monitor running rows show muted Run + live Details/Cancel in stable columns, terminal rows show muted Run + Details + muted Cancel.

## Critical Files

`src/orchestration/utils/youtubeApi.ts`, `src/orchestration/workflows/YoutubeMetadataFetchWorkflow.ts`, `src/sourceEval/captureIndex.ts`, `src/ingestion/sections/queueMonitor.ts`, `tests/queueMonitorStatusFilter.test.mjs`, `src/orchestration/AGENTS.md`.

## Assumptions

- A 200 + `items: []` response is the sole live not-found shape (the HTTP-404 branch is dead in practice but gets the typed error too, for symmetry).
- Tombstoning the note's own primary video (entry [0] of `yt-metadata` becomes the tombstone link) is acceptable: the channel map skips it (no `channelId`), and the K1 guard stops the `"_unavailable"` phantom-channel fallback.
- Terminal-row Cancel renders muted without `mod-warning`; the destructive styling stays exclusive to a live Cancel.
- The user's third feedback item (full validation of new captures pending, "so far so good") needs no action; the `note_link_enrich` on-clip trigger stays deferred until that validation closes.

**Total ≈ 0.43 kSLOC, ~330k raw tokens; ~286k Claude-path / ~231k Codex-path Opus/Sol-equivalent tokens.**

---

> **CLOSED 2026-08-02.** Both WPs landed on master:
> - `5a9ab0b` WP-K2 (subagent k-2): queue action cell renders all three buttons at every status — muted Run for running/terminal (status-specific titles), muted terminal Cancel without `mod-warning`, `renderCancelAction` widened to the full `JobStatus` union with the terminal branch ahead of the `isCancelling` check; the omission-pinning structural test replaced with three inverse pins. Zero deviations.
> - `fe0bad4` WP-K1 (subagent k-1): `YoutubeVideoUnavailableError` from the zero-items (live) and 404 (dead-in-practice) branches; `<yt-root>/_unavailable/<videoId>.md` tombstone (frontmatter-only, X-exemplar shape); `IngestResult` gains `tombstoned`; workflow settles `done` with "Video unavailable — tombstoned/already tombstoned" wording, breaker never opens, channel chain never fires; tombstone links onto `yt-metadata` through the unchanged call site — backlog exit + on-capture-trigger silence for free; `parseYtMetadataChannelFromLink` declines `_unavailable`; stale AGENTS.md:83 ignore-seeding sentence fixed; `failedJobRepair` rationale refreshed. **Accepted deviations:** `internalCommands.ts` gained the tsc-forced `tombstoned` case (exhaustive switch); the typed 404 covers all three `requestYoutubeApi` callers (verified no behavior change for channel/uploads paths); the "already tombstoned" `exists` sub-case added for X parity.
> - WP-K3 (orchestrator-direct): this closeout.
>
> Gates at close: 1993 tests / 154 files, 0 failures (floor was 1975/153); lint, tsc, production build, console sweep, NUL sweep all clean on merged master. Ledger rows k-1/k-2 recorded. Deferred by design: batch `videos.list` prober, tombstone re-probe/TTL affordance, dashboard tombstone listing.
