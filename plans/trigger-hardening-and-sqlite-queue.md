# obsidian-crucible: trigger hardening, feedback fixes, and the SQLite job queue

*Recommended model/effort — Claude: Sonnet/medium for all dispatched WPs except WP-6/WP-8
(Opus/medium); Codex: Terra/medium except WP-6/WP-8 (Sol/medium). WP prefix `thq`.*

## Context

Two events drive this plan. First, the **trigger storm**: a blank default trigger
("Add trigger" persists an armed vault-wide wildcard immediately on click) matched every
created file including the queue's own job notes — job creation → `create` event →
trigger → new `chain_run` job → new job file, a perfect self-feeding loop with dedupe
defeated (empty chainName ⇒ empty key ⇒ dedupe skipped) and a startup amplifier
(`triggers.start()` runs in `onload()`, so Obsidian's create-replay over ~17k existing
job notes re-fires the loop on every reopen). 18k+ jobs bricked Obsidian. Second, the
storm exposed the structural weakness: **every job is a real vault note** — 37,081 job
files vs ~5,456 real notes (7.7x note-count inflation), no pruning exists anywhere,
bulk clear costs 4 vault ops per job, and every job file churns the metadata cache,
triggers, lint scheduling, and the file-open palette.

Also folded in: three live-validation feedback items (danger buttons have no visible
hover; dashboard scroll drifts when an above section changes height; `image_describe_batch`
dies to the generic 600s job timeout after reload — user confirmed the popup text).

All items were root-caused by four read-only investigations; ground truth lives in
`runs/dispatch/thq-trigger-storm-investigation.md`,
`runs/dispatch/thq-feedback-items-investigation.md`, and
`runs/dispatch/thq-queue-db-investigation.md`. Briefs cite them; workers get distilled
facts inline. Do not re-derive any file:line fact recorded there.

## Decisions locked (user-confirmed 2026-07-30)

- **Storage: `node:sqlite` in the plugin data dir** (`pluginDataPath('jobs.sqlite')` via
  `FileSystemAdapter.getBasePath()`), gated on a devtools probe
  (`require('node:process').versions.node` ≥ 23.4 and `!!require('node:sqlite')`) the
  user runs before the queue WPs dispatch. Companion-hosted SQLite is disqualified
  (enqueue must never depend on service availability — `SearchIndexCoordinator.ts:82-100`).
- **One combined plan** — hardening + feedback fixes + queue rewrite, sequenced so the
  hardening lands first.
- **Terminal retention: capped by age, configurable setting** (new
  `orchestrationJobRetentionDays`, default 30; pruned on scan/startup). No import of the
  existing ~20k job files — the old queue folder becomes a frozen archive the user
  deletes on disk.
- **Collapse the memory backend**: `youtube_metadata_fetch` becomes durable in the DB;
  `MemoryJobBackend`/`MemoryJobQueue`/`EnrichmentQueueAdapter` (≈700 lines) are deleted.
- Trigger enablement is **validation-gated**: a trigger can be enabled (on creation or
  after edits) only if valid; the editor shows a **match-volume estimate** ("~N notes
  currently in scope") computed with the same exclusion predicate the registry uses.
- Image job fixes: per-type `timeoutMs` (B-4, removes the observed 600s popup class) +
  per-pass timer moved inside the provider limiter (B-1).

## Summary

Three tracks. (A) Trigger hardening: plugin-managed paths excluded at the registry
chokepoints, `triggers.start()` moved to `onLayoutReady`, degenerate actions refused at
the adapter, and a pure validation module gating both Enable toggles with a scope-count
estimate. (B) Feedback fixes: an `--n1-red-hover` token pair in the theme, anchor-delta
scroll restore in the dashboard coordinator, and the two image-timeout fixes. (C) The
queue rewrite: a `SqliteJobStore` + `DbJobBackend` behind the existing `JobBackend`
seam, the six reach-around consumers moved onto the seam, then the file and memory
backends deleted net-negative. Migration is a cutover, not an import.

## Work packages

**WP-1 — trigger registry exclusion + layout-ready start + adapter guards.**
*~0.25 kSLOC · ~180k tokens · ~14 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent (~70% saving); Codex: subagent (~50%)*
`isPluginManagedPath(path)` in `TriggerRegistry` covering `orchestrationQueueRoot` +
`INTERNAL_PLUGIN_FOLDER` ('_crucible'), applied at all three chokepoints:
`waitForConsistentCache` (~`:143`), `onCacheChanged` (~`:160` — the metadata-changed
path bypasses the others), `fireEvent` (~`:193`, backstop for rename). NOT `_blog_metadata`
(legitimate trigger target). Move `triggers.start()` from `main.ts:252` (onload) into
the `onLayoutReady` block at `:268-273`, preserving registration order after the
noteLock rename handler. In `triggerAdapter`: refuse to seed `chain_run` with empty
`chainName` and `command_run` with empty `commandId` (return no job); make an empty
`events` list adapt to nothing instead of silently defaulting to `['create']`.
Tests: extend `tests/triggerRegistryConsistency.test.mjs` (harness stub gains
`orchestrationQueueRoot`; job-note create ⇒ no enqueue; `_crucible` sibling ⇒ no
enqueue; normal note ⇒ enqueue) and `tests/metadataTriggerActions.test.mjs` (chain-kind
seed path, empty-action guards, empty-events). Files: `src/orchestration/TriggerRegistry.ts`,
`src/main.ts`, `src/triggers/triggerAdapter.ts`, tests. NOT in scope: validation UI (WP-2).

**WP-2 — trigger validation module + gated enablement + match-volume estimate.**
*~0.40 kSLOC · ~240k tokens · ~18 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · depends on WP-1 (shared exclusion
predicate)*
New pure `src/triggers/triggerValidation.ts`: `validateTrigger(def, {chains,
hasInternalCommand, knownJobTypes}) => {errors: string[], warnings: string[]}` per the
validity table in the trigger investigation (chain resolvable, command queueable,
workflow type registered = warn, events non-empty, schedule minutes > 0, nonexistent
folder = warn; broad scope + zero conditions = warning surfaced with the estimate).
`newTrigger()` mints `enabled: false`. Both Enable toggles gate on validity: list row
(`triggers.ts:145-148`) and edit form — add a `guard?: () => string | null` option to
`bindToggle` (`src/settings/bind.ts:56-64`); on veto, revert the toggle and show the
reason (`.crucible-setting-warning` block, `addWarningIcon` pattern). Defense-in-depth:
`setUserTriggers` skips invalid defs (logWarn) so hand-edited `data.json` can't arm one.
Match-volume estimate in the edit form: pure estimator over
`app.vault.getMarkdownFiles()` paths using exported `inScope` + the WP-1 exclusion
predicate, rendered as "~N notes currently in scope" (upper bound wording), recomputed
debounced on scope edits; conditions-included refinement NOT in scope. `getTriggerWarning`
becomes a thin caller of the validator. Tests: new `tests/triggerValidation.test.mjs`
(~10 cases incl. the incident trigger verbatim ⇒ invalid), estimator tests, guardEval
empty-conditions pin. Files: `src/triggers/{triggerValidation,triggerAdapter}.ts`,
`src/settings/sections/triggers.ts`, `src/settings/bind.ts`, `src/main.ts`,
`styles.css` (if a new warning style is needed), tests.

**WP-3 — danger-button hover + anchor-based scroll restore.**
*~0.25 kSLOC · ~180k tokens · ~14 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent*
Theme: add `--n1-red-hover` per surround in block 1 (brighter on dark/med
`#fb464c`→~`#ff5f64`, darker on light `#e93147`→~`#c92338`) and map
`--background-modifier-error-hover: var(--n1-red-hover)` in block 2 — no new
`!important`, no specificity change (root cause: Obsidian core ships rest and hover as
the same color; the adapter never diverged them). Dashboard: anchor-delta restore in
`src/ingestion/render/refresh.ts` per fix A-1 — capture `{el, offset}` (first element at/
below viewport top, `offsetTop`-based) at coordinator acquire, restore
`scrollTop = el.offsetTop - offset` when the anchor is still connected, absolute
fallback otherwise (unkeyed sections); plus A-3, cancel the pending restore if the user
scrolled during the window. Keep double-rAF + re-assert + clamp. No reconciler changes.
Tests: `tests/ingestionRefreshGates.test.mjs` FakeElement gains `offsetTop`/`children`;
anchor-restore + user-scroll-cancel cases; existing structural pins stay green.
Files: `theme/theme.css`, `src/ingestion/render/refresh.ts`, tests.

**WP-4 — image job timeouts (B-4 + B-1).**
*~0.15 kSLOC · ~140k tokens · ~11 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent*
B-4: per-type `timeoutMs` on `image_describe_batch` and `image_describe_note` configs
(`jobTypeConfig.ts:160-162`; field exists at `:49`, honored first at `JobBackend.ts:179`),
sized from real budget (batch: images-per-job × 2 passes × pass timeout + slack — cite
the arithmetic in a comment). B-1: per-pass timer moves inside the limiter — optional
`timeoutMs` on `describeImage` armed around `client.describeImagePass`
(`providers.ts:317-319`), outer wraps at `imageDescribe.ts:379-391` dropped/loosened.
Hard constraints: release-on-settle semantics untouched; the literal
`timed out after <n>ms` label preserved (both `TIMEOUT_FAILURE_RE` and
`TRANSIENT_FAILURE_RE` key on it). Tests: extend imageDescribe + a jobTypeConfig
timeout-resolution case. Files: `src/orchestration/jobTypeConfig.ts`,
`src/providers.ts`, `src/orchestration/utils/imageDescribe.ts`, tests.

**WP-5 — SqliteJobStore (schema + storage layer).**
*~0.50 kSLOC · ~280k tokens · ~22 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · PRECONDITION: user devtools probe
green (`node:sqlite` available in Obsidian's renderer)*
New `src/orchestration/db/SqliteJobStore.ts` (+ small `sqlite.ts` open/migrate helper):
DB at `pluginDataPath('jobs.sqlite')` via `FileSystemAdapter.getBasePath()`; lazy
`require('node:sqlite')` behind a capability probe that reports a hard, user-visible
error if unavailable (no silent fallback). Schema: `jobs(id TEXT PK, type, status, lane,
priority, created, params JSON, error, failure_kind, defer_until, progress, output_paths
JSON, partial, notes, claimed_at, settled_at, schema_version)`; indexes for
`(status, lane, priority, created, id)` claim order and `(type, status)` dedupe/existence.
Semantics per the queue investigation §Durability: atomic claim
(`UPDATE … WHERE id=? AND status='queued'` — makes 'Recovered: aborted claim'
unrepresentable), crash-mid-run lease via `claimed_at` + process-instance token (stale
sweep reuses per-type timeout + 30s buffer), dedupe against active jobs with
lane/priority promotion, deferral (`defer_until` skipped by claim + cleared on non-queued
transitions), mint-order claiming (`ORDER BY lane_rank, priority_rank, created, id`,
id opaque), age-based terminal pruning driven by new setting
`orchestrationJobRetentionDays` (default 30, `pi-width-half` numeric in the Orchestrator
tab). Storage shaped as a narrow interface so tests run against `:memory:` (Node 24 in
the test runner has `node:sqlite`). Tests: new `tests/sqliteJobStore.test.mjs` — claim
atomicity, ordering, dedupe+promotion, deferral, retention pruning, lease recovery.
Files: `src/orchestration/db/*` (new), `src/types.ts`, `src/settings/sections/
orchestration.ts`, `src/main.ts` (path plumbing), tests. NOT in scope: the backend
class (WP-6), consumers (WP-7).

**WP-6 — DbJobBackend + queue-event re-plumb.**
*~0.45 kSLOC · ~280k tokens · ~22 min wall · top (Claude Opus/medium; Codex Sol/medium —
evolves the queue-changed event contract consumed across dashboard/autorunner) ·
Claude: subagent; Codex: subagent · depends on WP-5*
`DbJobBackend implements JobBackend` — all 12 members with the pinned semantics:
`cancelJob` stays non-async-observable (`isCancelling` readable synchronously after),
`clearQueued` emits nothing itself, `hasPending` from a cheap count, `drainsWithoutAutorun
= false`. Re-plumb `emitQueueChanged`/`scheduleQueueChanged` from the hard-wired
`JobStore.listFolder` payload to a counts-provider abstraction the backend supplies
(coalescer keyed per provider, 250ms semantics and emit-exactly-once for bulk ops
preserved — pinned by `tests/queueControl.test.mjs:379,798`). Register via the
`Orchestrator.register` ternary → three-way dispatch on `persistence`; new value `'db'`
adopted by all current `'file'` types. Autorun/drain, deferral wake scheduling, and the
failure Notice (`Orchestrate: <id> → failed (…)`) behavior preserved. Tests: a
DbJobBackend suite mirroring `tests/queueControl.test.mjs` shapes against `:memory:`.
Files: `src/orchestration/{DbJobBackend.ts (new),JobBackend.ts,Orchestrator.ts,
jobTypeConfig.ts}`, tests. NOT in scope: consumer rewrites (WP-7), deletions (WP-8).

**WP-7 — consumers onto the seam.**
*~0.50 kSLOC · ~280k tokens · ~22 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · depends on WP-6*
Move every reach-around onto backend-level queries: queue monitor
(`queueMonitor.ts:267-282` — list with LIMIT; rowKey/table behavior unchanged), intake
buttons (`intake.ts:77-91` — existence query), `Orchestrator.scan` (counts via
`COUNT(*)`; recovery collapses to the lease sweep from WP-5), `failedJobRepair`
(one `UPDATE … WHERE` requeue; the yield-every-20 loop deleted), `SearchJobProgress`
(`SearchIndexWorkflow.ts:337-352` → backend `setProgress(jobId, msg)`). Add the job-detail
affordance replacing the lost job-note surface: a per-row action in the queue monitor
that copies/shows the job record (params JSON + notes/error) — modal or clipboard, small.
Tests: extend queue-monitor/intake structural suites; failedJobRepair against `:memory:`.
Files: `src/ingestion/sections/{queueMonitor,intake}.ts`, `src/orchestration/
{Orchestrator,failedJobRepair}.ts`, `src/orchestration/workflows/SearchIndexWorkflow.ts`,
tests. NOT in scope: deleting old backends (WP-8).

**WP-8 — cutover + net-negative deletions (file + memory backends).**
*~0.60 kSLOC, net-negative · ~300k tokens · ~23 min wall · top (Claude Opus/medium;
Codex Sol/medium — a contract-wide deletion sweep; every dangling reference is a
runtime break) · Claude: subagent; Codex: subagent · depends on WP-7*
Flip all job types to `persistence: 'db'`; delete `FileJobBackend`, `JobStore`,
`MemoryJobBackend`, `MemoryJobQueue`, `EnrichmentQueueAdapter` and the
`getMemoryQueue` instanceof escape (`Orchestrator.ts:66`); `youtube_metadata_fetch`
becomes durable (enrichment-queue UI reads move to the backend seam). Startup cutover:
no import — if the old `orchestrationQueueRoot` folder exists and is non-empty, show a
one-time notice naming it as a frozen archive safe to delete on disk; the plugin never
reads it again. Keep (harmless) the dashboard `route()` queue-root guard and the
`_crucible` search exclusion. Sweep for orphaned settings/UI referencing file-queue
concepts (queue root setting stays, repurposed for the archive notice; scan command's
folder counts replaced). Tests: full suite green after deletion is itself the gate;
migrate any test importing deleted modules to the DB equivalents rather than deleting
coverage. Files: `src/orchestration/*` (deletions), `src/ingestion/sections/*`,
`src/settings/sections/orchestration.ts`, `src/main.ts`, tests.

**WP-9 — close (orchestrator-direct).**
*~0.05 kSLOC · ~50k tokens · ~5 min wall · must-direct (integration/gates/commit duty)*
Quirks: trigger path-exclusion + layout-ready start + validation-gated enablement in
root AGENTS.md (+ index hooks); SQLite queue contract (atomic claim, lease sweep,
retention, machine-local DB) in `src/orchestration/AGENTS.md` — supersede the
file-backend entries (JobStore.move rollback, re-homing, aborted-claim); note the
search-index 7.7x inflation quirk resolution in `src/search/AGENTS.md`;
`docs/orchestration.md` update. Ledger rows. Deregister plan. Live validation checklist.

## Public interfaces

- New settings: `orchestrationJobRetentionDays` (number, default 30). Trigger defs
  unchanged on disk; invalid ones are skipped at registration (logWarn), not rewritten.
- `jobTypeConfig.persistence` gains `'db'`; `'file'` and `'memory'` are removed at WP-8.
- `bindToggle` gains optional `guard?: () => string | null`.
- `describeImage` gains optional `timeoutMs`.
- Queue DB at `.obsidian/plugins/obsidian-crucible/jobs.sqlite` — machine-local,
  not synced, disposable-with-loss-of-history.
- No search schema changes; no provider wire changes.

## Execution

Wave 1: **WP-1 ∥ WP-3 ∥ WP-4** (disjoint: triggers/main vs theme/render vs
image/providers) → Wave 2: **WP-2 ∥ WP-5** (disjoint: settings/validation vs new db
dir; WP-5 only after the user's devtools probe is green) → Wave 3: **WP-6** →
Wave 4: **WP-7** → Wave 5: **WP-8** → WP-9 direct. Ask-before-dispatch per wave;
workers never commit; briefs to `runs/dispatch/thq-wp<n>-brief.md` (reports back via
Bash `cp` to the MAIN checkout); worker worktrees branch from local master tip; full
gate loop re-run verbatim per landing; one commit per WP; pause for user compaction at
wave boundaries. The open tn-code-review remediation (WP-R1, WorkflowResult union)
touches the same files as Track C — it rebases after this plan lands; do not interleave.

## Test Plan / Verification

Gates per landing: `npm run lint` · `npx tsc -noEmit -skipLibCheck` · `npm test`
(baseline **1119/93**, count only grows; WP-8 may retire suites only by migrating them) ·
`node esbuild.config.mjs production` · `grep -rna --include='*.ts' "console\." src/`
(only `src/log.ts`) · `file` + `LC_ALL=C grep -caP '\0'` per touched file.

Live validation (with user): (1) Add trigger → row appears disabled; enabling a blank
trigger is refused with a reason; a valid trigger enables and shows "~N notes currently
in scope"; creating a note under `_crucible/` fires nothing. (2) Reload Obsidian with a
populated queue → no job growth. (3) Danger buttons visibly shift on hover in all three
surrounds. (4) Read a lower dashboard section while the queue churns → no viewport
jump. (5) Resume a large image batch after reload → no 600s popup; batch completes or
defers honestly. (6) After cutover: enqueue/clear of hundreds of jobs is instant, no
vault files appear, queue monitor + intake buttons + failed-repair work, retention
prunes terminal jobs past the configured age, and the one-time archive notice names the
old folder.

## Critical Files

`src/orchestration/{TriggerRegistry,JobBackend,Orchestrator,jobTypeConfig,
failedJobRepair}.ts` · `src/orchestration/db/*` (new) · `src/triggers/*` ·
`src/settings/sections/{triggers,orchestration}.ts` · `src/settings/bind.ts` ·
`src/ingestion/render/refresh.ts` · `src/ingestion/sections/{queueMonitor,intake}.ts` ·
`theme/theme.css` · `src/providers.ts` · `src/orchestration/utils/imageDescribe.ts` ·
`src/main.ts`

## Assumptions

- The devtools probe passes (Node ≥ 23.4 with `node:sqlite` in Obsidian's renderer).
  If it fails, STOP after Wave 2's WP-2 and surface — the storage layer is isolated in
  WP-5 precisely so a JSON fallback could replace it without re-planning Tracks A/B.
- Machine-local queue is acceptable (single-device use; the vault-synced queue was
  accidental durability, and arguably a cross-device hazard).
- Losing the ~20k historical job files is acceptable; the user deletes the frozen
  archive on disk themselves.
- `node:sqlite` being experimental is an accepted Electron-upgrade risk; the capability
  probe turns a future breakage into a visible error, not silent data loss.
- The plugin is already desktop-only in fact (`node:async_hooks`); this plan does not
  change `manifest.json`.

**Total ≈ 3.15 kSLOC, ~1930k raw tokens; ~1330k Claude-path / ~1040k Codex-path
Opus/Sol-equivalent tokens.**
