# Plan I — Search-audit section: per-condition repair actions (merged Summary/Repair table)

Repo: **obsidian-crucible** · slug `search-audit-section-repair-actions` · follows Plan H (closed at `04c8509`) + the image-coverage follow-up (`fa6c3b2`). Born from user validation of the H4 section.

*Recommended model/effort — Claude: Sonnet/medium workers I1–I2, orchestrator (Fable) closes I3 direct; Codex: Terra/medium workers, Sol/medium orchestrator.*

## Context

The user ran the audit through the new dashboard section and compared it against the markdown report note. The report's **Repair** section names a specific action per failure mode — reconcile for missing/stale/orphans, `Search: embed missing vectors` for embedding gaps, `Search: describe vault images` for pending images, `Search: retry failed image descriptions` for failed images (`REPAIR_INSTRUCTIONS`, `src/search/audit.ts:248-255`) — but the dashboard section only wires the reconcile trio. Verdict: "halfway there."

## Decisions locked (user-specified)

- **Merge the report's Summary + Repair sections into one statistics table**: each line = failure mode + count + a wrench action button, or "no action needed" for mtime-only/unindexable. **Action button hidden when count == 0** (explicit user rule — overrides muted-never-absent for the summary table's zero rows; the muted-wrench law still governs the paths-table row actions).
- **Images get their real actions**: pending → describe (the `image_describe_backfill` confirm + enqueue), failed → retry (the prune-choice modal + backfill enqueue). "Images referenced/described" counts are acceptable **only because** the layout becomes a statistics table that shows note counts too — they ride along as one informational row, never as standalone pills.
- **Clickable conditions must also work for images**: clicking an image failure row filters the paths table below to the affected image paths — requires threading per-image path lists through the audit result (today `imageCoverage` is counts-only).
- **"Run audit" lands inline with Refresh** in the section header, matching the other sections' header-button layout.
- The pill filter bar, the standalone image-coverage pill row, and the separate "Repair all" button are **replaced by** the summary table (per-line actions subsume the bulk button; per-class enqueue via `enqueueSearchRepairs` is strictly more precise).

## Summary

Two dispatched WPs + close. (I1) widen the audit seam — `AuditImage`/`imageCoverage` carry image *paths*, and the three non-reconcile repair actions are extracted from their `commands.ts` bodies into exported helpers (byte-identical command behavior, the H3 extraction pattern). (I2) rebuild the section's render around a merged Summary/Repair statistics table with per-row actions and row-click filtering that covers image classes; fix the header button. I2 depends on I1 (same shape as H3→H4).

## Key Changes

**WP-I1 — seam: image paths through the audit result + repair-action extraction.**
*~0.3 kSLOC · ~180k tokens · ~14 min wall · mid (Claude Sonnet/medium; Codex Terra/medium) · Claude: subagent; Codex: subagent*
(a) `src/search/audit.ts` (pure — keep the no-`obsidian`-import graph, `tests/searchAudit.test.mjs` pins it): `AuditImage` gains `path: string`; `SearchAuditResult.imageCoverage` gains `pendingPaths: string[]` and `failedPaths: string[]` (sorted, counts stay derived-identical; `formatAuditReport` output byte-identical). (b) `src/search/auditRun.ts`: `gatherSearchAuditImages` passes `image.path` through (`computeReferencedImagePaths` already returns it — `src/orchestration/utils/imageDescribe.ts:507-522`). (c) Extract three exported action helpers into `auditRun.ts`, moved verbatim from `src/commands.ts`: `enqueueEmbedMissing(plugin)` (from `search-embed-missing`, `commands.ts:541-546` — plain `search_embed_missing` enqueue, `priority:'high', lane:'user'`), `confirmAndQueueImageDescribeBackfill(plugin)` (from `search-describe-vault-images`, `commands.ts:430-450` — the scale-warning `ConfirmModal` + `image_describe_backfill` enqueue, confirm text unchanged), `retryFailedImageDescriptions(plugin)` (from `search-retry-failed-image-descriptions`, `commands.ts:457-471` — `RetryFailedImageDescriptionsModal` choice + `imageDescriptions.pruneFailed` + Notice + backfill enqueue). Rewire the three commands to the helpers; behavior byte-identical (modal text, Notice text, job params). Tests: extend `tests/searchAudit.test.mjs` (paths land in `pendingPaths`/`failedPaths`, counts unchanged, purity barrier green) and the extraction-parity pattern from `tests/searchAuditRunEnqueueRepairs.test.mjs` for the three helpers (confirm declined ⇒ no enqueue; retry choice ⇒ prune + enqueue). Files: `src/search/audit.ts`, `src/search/auditRun.ts`, `src/commands.ts`, tests. NOT in scope: report-note format changes, dashboard code.

**WP-I2 — section redesign: merged Summary/Repair table with per-condition actions (depends on I1).**
*~0.45 kSLOC · ~280k tokens · ~22 min wall · mid (Claude Sonnet/medium; Codex Terra/medium) · Claude: subagent (after I1 lands); Codex: subagent (after I1)*
Rewrite `src/ingestion/sections/searchAudit.ts`'s render. **Summary table** (replaces the pill bar + coverage pills + "Repair all" row) mirroring the report's Summary lines: rows missing / orphans / stale / mtime-only / unindexable / embedding gaps / images pending / images failed, plus one informational "images described X / Y referenced" row. Columns: failure mode (label + the report's parenthetical), count, one action cell — wrench (`renderIconButton`, `aria-label` + `title` naming the concrete action) **hidden when count == 0**; mtime-only/unindexable show the text "no action needed" instead. Actions per row: missing/stale → `enqueueSearchRepairs` upserts for that class's full cached list; orphans → orphan half (confirm gate stays inside the helper); embedding gaps → `enqueueEmbedMissing`; images pending → `confirmAndQueueImageDescribeBackfill`; images failed → `retryFailedImageDescriptions`. Every enqueue keeps the honest new/deduped Notice + `resultStale` meta ("stale — re-run audit to refresh"; never auto-re-run). **Row-click filtering**: clicking a row with count > 0 (not the action button) filters the paths table to that class — image classes filter to `pendingPaths`/`failedPaths`; click again returns to the default missing+orphans+stale view; `aria-pressed` on the clickable row. Paths table unchanged in shape; image-class rows get `arrow-right` open (an image path opens fine via `openLinkText`) and a muted wrench titled to the summary-row bulk action. **Header**: "Run audit" gets the `crucible-icon-label-btn` chrome next to Refresh and the section description shortens so the header stays on one line (match `orphanedAttachments`/`xPosts`). Forced-only registration, the never-scan-from-render law, and closure-cached state all unchanged. Tests: rewrite the affected `tests/searchAuditSection.test.mjs` cases — summary-table rows/counts, hidden-at-zero action buttons, "no action needed" cells, per-row action wiring (each helper called with the right targets from the cached full result, never the rendered table), row-click filtering incl. image classes, error/empty states preserved. Files: `src/ingestion/sections/searchAudit.ts`, `src/ingestionDashboard.ts` (description), `styles.css` (only if needed), tests. NOT in scope: retiring the report note or commands, audit compute changes beyond I1, pagination/auto-refresh.

**WP-I3 — close (orchestrator-direct).**
*~0.03 kSLOC docs · ~25k tokens · ~5 min wall · top (orchestrator) · Claude: direct (must-direct: integration/gates/commit duty); Codex: direct (same)*
Completion blockquote; deregister from `pending-plans`; ledger actuals; live-validation checklist to the user.

## Public Interfaces

`SearchAuditResult.imageCoverage` gains `pendingPaths`/`failedPaths` (additive). `AuditImage` gains `path`. Three new exported helpers in `src/search/auditRun.ts`. No settings keys or job types added; the three commands keep their ids/behavior.

## Execution

I1 → land → I2 (consumes the seam) → I3. Worker worktrees branch from local master tip; workers never commit; orchestrator reviews the full diff, re-runs all six gates verbatim, commits `(subagent i-N)`, ff-merges. Ask the user before each dispatch. On approval: plan doc → `plans/search-audit-section-repair-actions.md` + registered in `INITIATIVE.md` `pending-plans` (docs-only commit) before any source edit.

## Test Plan / Verification

Six crucible gates verbatim per landing (test floor **1845/144**, count only grows). Live validation: run the audit from the dashboard — summary table shows every report Summary line with honest counts; zero-count rows show no button; mtime-only/unindexable read "no action needed"; wrench on embedding gaps enqueues `search_embed_missing`; images pending wrench opens the scale-warning confirm then queues the backfill; images failed wrench opens the retry-choice modal; clicking the images-failed row lists the affected image paths in the table below; Run audit sits inline with Refresh in the header.

## Critical Files

`src/search/audit.ts`, `src/search/auditRun.ts`, `src/commands.ts`, `src/ingestion/sections/searchAudit.ts`, `src/ingestionDashboard.ts`, `tests/searchAudit.test.mjs`, `tests/searchAuditRunEnqueueRepairs.test.mjs`, `tests/searchAuditSection.test.mjs`.

## Assumptions

- Per-class wrenches subsume "Repair all" (the reconcile command remains for the one-shot flow); if the user wants both, it's a one-line row addition later.
- The describe/retry actions stay vault-global (the backfill's own granularity) — a per-image describe is deliberately out of scope.
- The report note's format stays unchanged; the new path arrays only feed the dashboard.

**Total ≈ 0.8 kSLOC, ~485k raw tokens; ~405k Claude-path / ~295k Codex-path Opus/Sol-equivalent tokens.**
