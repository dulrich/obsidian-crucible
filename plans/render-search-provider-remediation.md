# obsidian-crucible: dashboard render coalescing, search sentAt deadline + backfill throttle, provider-level serialization

*Recommended model/effort — Claude: Sonnet/medium all dispatched WPs; Codex: Terra/medium.
Repo plan lands at `plans/render-search-provider-remediation.md` (WP prefix `rsp`).*

## Context

Live-validation feedback batch from the clsl sprint, all items root-caused by three parallel
read-only investigations (reports in `runs/dispatch/feedback-{dashboard-render,
search-first-run,image-timeout}-investigation.md` — briefs cite them; workers get the
distilled facts inline):

1. **Image-describe timeouts are self-inflicted concurrency, not the inference engine.**
   All 1192 batch requests returned HTTP 200; the 7 "timeouts" completed at 121–136s,
   2–16s after the plugin's 120s timer quit. A solo vision pass costs 6.3s; at in-flight
   depth 4–5 (orchestrationMaxConcurrent=5 on a 4-slot single-GPU llama-server) latency
   is ~30s avg and the tail crosses 120s. Zero timeouts at depth 0–1. Poison images and
   swap ping-pong ruled out as causes. No restart needed. **User decision: the lever is
   per-provider serialization** — local gemma must serialize every consumer
   (image_describe_batch AND capture-driven image_describe_note AND
   image_metadata_extract), while cloud endpoints (OpenRouter etc.) keep concurrency.
   A queue-level maxParallel pin is NOT the fix (wrong layer; doesn't cover captures).
2. **Search first-run 4s timeout = companion queue wait in front of `deadlineAt`.**
   The embed happens before the client timer starts (cold model load adds felt latency
   but cannot cause the timeout). The companion stamps `deadlineAt` at handler run time
   (`search-companion.mjs:2021`, after `await readJson`), so a request queued ~3.4s
   behind a backfill sub-batch burns the client's 4s while the companion finishes
   "in-budget" — `degraded: true` can never fire for this mode. This is exactly the
   WP-5 residual risk flagged at `search-companion.mjs:100-105`. Bonus finding:
   `vectors.invalidate` fires after EVERY 100-chunk sub-batch (`:2000-2007`), so
   mid-backfill every search pays a ~800ms full matrix rebuild (~117MB Float32Array at
   28.7k chunks).
3. **Dashboard flashing/jumps are event-routing gaps, not the rebuild architecture.**
   (a) Ignore double-render: 9874cef's echo-suppress works, but `route()` falls through
   to the generic metadata branch (`ingestionDashboard.ts:248-261`) whose `!prev`
   first-sighting check re-schedules the same section ~1s later, ungated. (b) Queue
   churn: job files are vault notes under `_crucible/orchestration/queue`; `route()` has
   no queue-root exclusion, so every enqueue/claim/settle/clear fires 5 full-vault-scan
   refreshes ("Clear queued" of N jobs = 2N×5). (c) The flash itself: sections blank to
   "Scanning…" BEFORE awaiting the scan (`uncapturedVideos.ts:32-34`); queueMonitor
   already solved this (`queueMonitor.ts:242-246`) and the fix was never propagated.
   Verdict: patch path + contained keyed reconciler; full retained/virtual-DOM rework
   is NOT warranted and would not fix the routing defects.
4. Chain edit-form delete button: already landed direct (b1dc7ff), out of scope here.

## Decisions locked (user-confirmed 2026-07-29)

- **Dashboard: everything** — P1–P4 core fixes + P5/P6 polish + the keyed row reconciler
  as its own WP. No virtual-DOM rework.
- **Image: per-provider serialization lever** (default serial for local providers, cloud
  providers unaffected), plus downscale-before-transcode and confirming
  image_metadata_extract rides the same limiter. Separate axis from queue maxParallel.
- **Search: sentAt-based deadline + degraded UX + backfill throttle** (option F) — the
  full stack, not just the wire fix.
- **Matrix cache: invalidate once per flush**, not per sub-batch.

## Summary

Three remediation tracks, six dispatched WPs + direct close. (A) A per-provider
concurrency limiter in ProviderManager serializing completion-class requests against
local backends, plus image downscaling. (B) Search: budget clock starts at client send
time so queued requests degrade fast instead of timing out; companion backfill yields to
interactive traffic; matrix invalidation moves to end-of-flush; modal surfaces partials
honestly. (C) Dashboard: route() filters queue-root noise and first-sighting false
positives, sections compute-then-paint, renders coalesce through one dirty-set flush,
then sortable tables get keyed row reconciliation.

## Work packages

**WP-1 — provider-level request serialization + image describe extras.**
*~0.45 kSLOC · ~220k tokens · ~17 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent (~70% saving); Codex: subagent (~50%)*
New per-provider concurrency limiter in `ProviderManager` (`src/providers.ts`): a
promise-queue/semaphore keyed by provider id, gating **completion-class** calls only
(chat/completions incl. vision passes) — embeddings and rerank are explicitly exempt
(different models/latency class; serializing search embeds behind a 2-min vision call
would be a regression). New provider field `maxConcurrentRequests?: number` (absent =
default); default resolves to **1 for local providers** (reuse the existing `isLocal`
detection that gates `reasoning_effort`) and **unlimited for cloud**. Settings UI: a
"Max concurrent requests" numeric field in the provider editor (`src/settings/sections/
ai.ts`, blank = default, desc naming the local-serial default). **Load-bearing detail:
the slot is released when the underlying `requestUrl` promise settles, NOT when a
`withTimeout` race abandons it** — an abandoned-but-in-flight request must keep holding
the slot, or the pile-up amplifier the investigation measured (abandoned request keeps
the GPU busy while the next image dispatches) reappears through the limiter itself.
Verify `image_describe_note` (captures) and `image_metadata_extract` flow through
`ProviderManager` and therefore inherit the limiter; note any path that bypasses it.
Second part: downscale before transcode in `transcodeToPng`
(`src/orchestration/utils/imageDescribe.ts`) — cap the long edge (constant ~1568px,
preserve aspect, only shrink never grow) so photos stop inflating to ~25MB PNGs.
Tests: limiter ordering/exemption/release-on-settle semantics, local-default resolution,
downscale dimensions. Files: `src/providers.ts`, `src/providers/*`, `src/types.ts`,
`src/settings/sections/ai.ts`, `src/orchestration/utils/imageDescribe.ts`, tests.
NOT in scope: queue-level maxParallel changes; swap-group changes in inference-engine;
touching the 120s withTimeout values.

**WP-2 — dashboard render fixes P1–P4.**
*~0.25 kSLOC · ~180k tokens · ~14 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent*
P1: top of `route()` (`src/ingestionDashboard.ts:198`) early-return for any path under
`orchestrationQueueRoot` (+ JobStore sibling folders) — no dashboard section reads job
files. P2: fix the `!prev` first-sighting semantics at `:251`/`:258` and make the
generic metadata/structural branches consult the echo suppression (or eagerly seed the
signature in the `IGNORED_IDS_NOTE` block) so the Ignore write cannot leak a second
render — cover the `vault.create` first-ignore case too (`ignoredIds.ts:181`). P3:
compute-then-paint in `uncapturedVideos.ts:32-34`, `uncapturedPosts.ts:21-23`,
`controlCenters.ts:25-28,50-53` — rows first, then `body.empty()` + build, mirroring
`queueMonitor.ts:242-246`. P4: `setIntakeButtonState` (`intake.ts:32-33,82`) caches last
state and early-returns when unchanged. Tests extend `tests/ingestionRefreshGates.test.mjs`
and `tests/ingestionTableCapAndGating.test.mjs` (structural assertions — they can't
import `obsidian`). Files: `src/ingestionDashboard.ts`, `src/ingestion/sections/
{uncapturedVideos,uncapturedPosts,controlCenters,intake}.ts`, tests.
NOT in scope: debounce consolidation (WP-5), row signatures (WP-5), reconciler (WP-6),
scroll coordinator changes.

**WP-3 — search deadline from sentAt + degraded UX.**
*~0.30 kSLOC · ~200k tokens · ~15 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent*
(a) Companion: capture `receivedAt` as the FIRST statement of the request handler
(before `await readJson`); client adds `sentAt` to the `/v1/search` payload
(`client.ts:130`); companion computes `deadlineAt = clamp(sentAt) + budget` with skew
guard (clamp `sentAt` into `[receivedAt - budget, receivedAt]`, fall back to
`receivedAt` when outside) — additive and back-compatible both directions, same as
`budgetMs`. A request that queued ~3.4s then arrives over budget, skips the
rescue/vector/coverage legs, and returns `degraded: true` partials fast — reaching the
machinery the clsl sprint built. Also gate the primary FTS scan (`search-companion.mjs:1489`)
behind the first `overBudget()` check so a doomed request stops paying it. (b) Client:
`embedMs` measured around `embedQuery` and included in the timeout breadcrumb so
cold-embed latency is triageable. (c) Modal UX: `SearchModal`/`formatSearchStatus`
surface `degraded` distinctly — "partial results — indexing in progress, retry in a
moment" — instead of leaving it indistinguishable from full results or failure. Do NOT
move the embed inside the timeout; do NOT raise the 4000 default; the two-timeout law
stands. Tests: real-HTTP companion harness for the sentAt/skew paths + normalize/UI
unit tests. Files: `scripts/search-companion.mjs`, `src/search/client.ts`,
`src/search/SearchManager.ts`, `src/search/SearchModal.ts`, tests.

**WP-4 — companion backfill throttle + once-per-flush matrix invalidation.**
*~0.25 kSLOC · ~180k tokens · ~14 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · depends on WP-3 (same file —
sequenced, not parallel)*
(a) Interactive-priority yield: after serving a `/v1/search`, the flush loop defers its
next sub-batch for a short window (e.g. ~1500ms, constant with rationale) so a user
mid-session gets gaps instead of back-to-back 3.4s stalls; a search arriving mid-flush
still waits at most one sub-batch. Keep total flush throughput sane — the deferral is
per-search, not cumulative starvation (cap the total added delay per flush). (b) Move
`vectors.invalidate(vault)` from per-sub-batch (`search-companion.mjs:2000-2007`) to
once per completed flush, per touched vault. Explicit trade-off to encode in a comment:
new chunks become vector-searchable only at flush end — acceptable; the matrix must
still invalidate before first use after the flush completes. `statsCache` follows the
same schedule. Tests: real-HTTP harness asserting (1) a search during a flush is served
between sub-batches and the next sub-batch defers, (2) matrix rebuild count across a
multi-sub-batch flush is 1, not N. Files: `scripts/search-companion.mjs`, tests.

**WP-5 — dashboard coalescing P5+P6.**
*~0.25 kSLOC · ~180k tokens · ~14 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · depends on WP-2*
P5: row-model signature in `render/section.ts` — hash the computed rows (+ extra inputs
like `inFlight` badges); skip all DOM work when identical to the section's last render
(kills youtubeWithoutMetadata's full rebuild when nothing changed). P6: replace the ~10
independent trailing debounces in `ingestionDashboard.ts:165-194` with one dirty-
`Set<SectionId>` flushed on a single coordinated pass (rAF/short interval), preserving
the `minIntervalGate` cadence semantics documented at `:174-180` — a burst of events
produces exactly one pass, and the scroll coordinator captures/restores once for the
whole batch. Tests: dirty-set coalescing (one flush per burst), signature skip, cadence
gate preserved. Files: `src/ingestionDashboard.ts`, `src/ingestion/render/
{section,refresh}.ts`, tests.
NOT in scope: keyed reconciliation (WP-6).

**WP-6 — keyed row reconciler for sortable tables.**
*~0.40 kSLOC · ~250k tokens · ~19 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · depends on WP-5*
Extend the table options (`src/ingestion/render/types.ts:74-80`) with
`rowKey: (row: T) => string`; `renderSortableTable` (`render/sortableTable.ts`) keeps a
`Map<string, HTMLTableRowElement>` per table, reuses matching `<tr>` (reorder via
`insertBefore`), creates only new keys, removes departed ones; cell renderers become
idempotent (`render(row, td)` clears/updates its own cell). Add one-line `rowKey`
declarations per section (natural keys: vault path / video id / job id). Where a real
key exists, prefer it over the focus-fingerprint heuristic (`refresh.ts:142-189`) for
focus restore — but do NOT delete the fingerprint or the scroll coordinator; they remain
the fallback for unkeyed content. Tests: reconciliation reuse/removal/reorder on a
stubbed DOM (follow the existing bundling pattern in `tests/ingestionRefreshGates.test.mjs`).
Files: `src/ingestion/render/{sortableTable,types,section,cells}.ts`,
`src/ingestion/sections/*.ts` (rowKey lines), tests.

**WP-7 — close (orchestrator-direct).**
*~0.05 kSLOC · ~50k tokens · ~5 min wall · must-direct (integration/gates/commit duty)*
Quirks: provider concurrency lever (completion-class only, release-on-settle, local
default 1) in `src/providers/AGENTS.md` + root index hook; route() queue-root exclusion
+ one-flush-one-render rule in root AGENTS.md; `src/search/AGENTS.md` update (sentAt
deadline, backfill yield, once-per-flush invalidation — supersedes the "queuing not
fixed" caveat in the existing cooperative-deadline entry). Docs: `docs/search-companion.md`
timeout section update; `docs/local-inference.md` note on serial local vision if apt.
Ledger rows. Deregister plan. Live validation checklist with user.

## Public interfaces

- New provider field `maxConcurrentRequests?: number` (settings-persisted, UI in
  provider editor).
- `/v1/search` request gains optional `sentAt: number` (epoch ms) — additive,
  back-compatible both directions.
- New table option `rowKey` in the ingestion render layer (internal seam).
- No search index schema changes; no ranking changes; no queue wire changes.

## Execution

Wave 1: **WP-1 ∥ WP-2 ∥ WP-3** (disjoint: providers/image vs ingestion vs search) →
Wave 2: **WP-4 ∥ WP-5** (disjoint: companion script vs ingestion render; WP-4 sequenced
after WP-3's companion edits land) → Wave 3: **WP-6** → WP-7 direct. Ask-before-dispatch
per wave; workers never commit; briefs to `runs/dispatch/` (reports back via Bash `cp`
to the MAIN checkout — Write refuses cross-worktree); worker worktrees branch from local
master tip; full gate loop re-run verbatim per landing (baseline **1049/90**, count only
grows); one commit per WP; pause for user compaction at wave boundaries.

## Test Plan / Verification

Gates per landing: `npm run lint` · `npx tsc -noEmit -skipLibCheck` · `npm test`
(≥1049/90) · `node esbuild.config.mjs production` · `grep -rna --include='*.ts'
"console\." src/` (only `src/log.ts`) · `file` + `LC_ALL=C grep -caP '\0'` per touched
file.

Live validation (with user, `npm run dev` + Reload Plugin): (1) rerun an image batch —
zero transient timeout failures; router log shows depth ≤1 per provider on local gemma;
a capture-driven describe during a batch queues behind it rather than stacking. (2) The
repro query during an active backfill returns fast partials (`degraded` notice in the
modal) instead of a 4s timeout; searches between flushes are full-quality. (3) Uncaptured
videos → Ignore: exactly one render, no flash. (4) Queue churn (enqueue/clear during a
drain): no dashboard jumps; queue monitor rows update without whole-table flicker.
(5) Provider editor shows Max concurrent requests; cloud provider unaffected.

## Critical Files

`src/providers.ts` · `src/settings/sections/ai.ts` · `src/orchestration/utils/
imageDescribe.ts` · `src/ingestionDashboard.ts` · `src/ingestion/render/
{section,sortableTable,refresh,types}.ts` · `src/ingestion/sections/*.ts` ·
`scripts/search-companion.mjs` · `src/search/{client,SearchManager,SearchModal}.ts`

## Assumptions

- The existing `isLocal` provider detection is reliable enough to drive the serial
  default; a user can always override per provider.
- Serializing completion-class requests on local providers is acceptable throughput-wise
  (measured: serial = 6.3s/pass vs 30.7s avg at depth 4 — serial loses little aggregate
  throughput on one GPU and removes the timeout tail entirely).
- End-of-flush vector visibility for new chunks is acceptable (coverage-aware skip
  already tolerates partial embedding coverage).
- The keyed reconciler keeps the scroll coordinator and focus fingerprint as fallbacks;
  no behavior change for unkeyed content.

**Total ≈ 1.95 kSLOC, ~1260k raw tokens; ~870k Claude-path / ~675k Codex-path
Opus/Sol-equivalent tokens.**
