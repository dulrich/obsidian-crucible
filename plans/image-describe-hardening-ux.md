# obsidian-crucible: image-describe hardening + settings/dashboard UX

*Recommended model/effort — Claude: Sonnet/medium for WP-1..3, Sonnet/low for WP-4; Codex:
Terra/medium for WP-1..3, Terra/low for WP-4. WP-5 close is orchestrator-direct.*

## Context

The image-descriptions backfill's first live batch (2026-07-27) surfaced a runaway-generation
defect: `describeImagePass` sends no `max_tokens`, so llama-server runs `n_predict: -1` and a
temperature-0 repetition loop on a dense chart generates to the 32k context ceiling — observed
live twice in the first 100 images (`extraction=597888ms`, and a second stored record at 94k
chars of degenerate JSON), ~10 min at 97% GPU each, with the batch silently stalled (no
timeout anywhere) and the garbage indexed into the owning notes. Healthy records: median
extraction 1.3k chars, max 7.4k — wide separation for a length guard. Extrapolated over the
~4,700-image backfill: ~90 runaways, ~15 wasted hours. A failed image today also fails its
whole 100-image batch job (no per-image isolation; failed file jobs never retry).

Alongside the incident fix, four validation-session UX findings: provider deletion is
unconfirmed (two call sites, destroys the stored API key eagerly); the Agents provider
dropdown lists capability-less providers; the Ingestion dashboard full-rebuilds its DOM
~4×/sec during queue drains (the "flicker"); and batch fan-out jobs claim/display in random
order because `newJobId` is second-granular and same-second ids tie-break on a random suffix.

## Decisions locked (user-confirmed 2026-07-27)

1. Combined plan: hardening + the four UX items (user picked over hardening-only).
2. Caps sized from live data: `max_tokens` **512** narrative / **2048** extraction, sent
   unconditionally (`max_tokens` is universal on chat/completions, unlike `reasoning_effort`).
3. Per-pass timeout **120s**, transcode timeout **30s** — `requestUrl` is not abortable, so
   timeout = abandon-and-move-on; the `max_tokens` cap is what bounds the server side.
4. Per-image failure isolation with durable **`kind:'failed'`** store records: `has()` stays
   true so poison images are skipped on later runs instead of retrying forever; failed records
   emit no chunks and no hash facet.
5. Degenerate-record repair is a **prune sweep at backfill start** (vision records with
   extraction > 20,000 chars are deleted and re-described under the capped pipeline) — this
   self-heals the two existing poison records; no one-off migration.
6. Ordering fix at the root: millisecond + monotonic `newJobId`, plus a `created` tie-break in
   the queue comparator — not a display-only sort patch.
7. Flicker fix is cadence + scroll-preserving re-render, not a virtual-DOM/diffing layer.

## Summary

Five WPs. WP-1 hardens the describe pipeline (caps, timeouts, failure records, prune). WP-2
adds the Delete-Provider confirm (with an in-use summary) and capability-filters the Agents
provider dropdown. WP-3 gates dashboard re-render flicker. WP-4 makes job ids/claim order
FIFO-correct. WP-5 (direct) lands docs/quirks, re-runs the live backfill validation, closes.

## Key Changes

**WP-1 — image-describe hardening: caps, timeouts, failure records, prune.**
*~0.35 kSLOC · ~180k tokens · ~14 min wall · mid (Claude Sonnet/medium; Codex Terra/medium) ·
Claude: subagent (148k vs 360k direct); Codex: subagent (~130k)*
`src/providers/openaiCompatible.ts` `describeImagePass` (:273-306) gains a per-pass
`max_tokens` (512/2048) threaded from `ProviderManager.describeImage` (`src/providers.ts`) —
the pass name already reaches the provider layer as the resolved prompt; thread an options
object instead. New tiny `withTimeout(promise, ms, label)` helper (no shared util exists;
put it in `src/orchestration/utils/imageDescribe.ts` or `src/utils.ts`) wrapping each provider
pass (120s) and `transcodeToPng` (30s). `describeOneImage` failure isolation: catch per image,
write `{ md5, narrative:'', extraction:'', kind:'failed', failure:<truncated reason> }` and
return a new `'failed'` outcome — the loop continues; batch/note workflows report
`failedCount` in job notes and the `Search: describe vault images` ConfirmModal copy mentions
failed-skip semantics. `src/search/imageDescriptionStore.ts`: `kind` union + validation (:34,
:94) gain `'failed'`; add `failure?: string` field (schemaVersion stays 1 — additive);
`combinedDescriptionHash`/`SearchManager.resolveImageDescriptions` must exclude `'failed'`
records (no chunks, no facet movement — check `src/search/SearchManager.ts:485-505` filter);
add `pruneDegenerate(maxExtractionChars)` returning pruned md5s.
`ImageDescribeBackfillWorkflow.run` calls the prune (threshold 20,000) before enumerating
pending, so pruned images re-enter the pending set. Tests: cap presence in request bodies,
timeout → failed record → loop continues, failed records excluded from resolve/facet, prune
round-trip. NOT in scope: retry-failed UI (manual JSON delete or future dashboard surface).
Files: `src/providers/openaiCompatible.ts`, `src/providers.ts`,
`src/orchestration/utils/imageDescribe.ts`, `src/orchestration/workflows/ImageDescribeWorkflow.ts`,
`src/search/imageDescriptionStore.ts`, `src/search/SearchManager.ts` (filter only),
`src/commands.ts` (confirm copy), tests.

**WP-2 — Delete-Provider confirm + capability-aware Agents dropdown.**
*~0.25 kSLOC · ~150k tokens · ~12 min wall · mid (Claude Sonnet/medium; Codex Terra/medium) ·
Claude: subagent (130k vs 300k direct); Codex: subagent (~112k)*
Both `deleteProvider` call sites (`src/settings/sections/ai.ts:85`, `:124`) gate on
`ConfirmModal` (`src/confirmModal.ts:3-24`; exemplar
`src/ingestion/sections/orphanedAttachments.ts:49-54`), `destructive: true`, message a single
`<p>` naming the provider and an **in-use summary**: a per-provider variant of
`searchRefsPointingAt` (`ai.ts:296-303` — its own comment anticipates this follow-up) covering
`searchEmbeddingModel`, `searchRerankModel`, `imageMetadataExtractionModel` (all
`ProviderModelRef`, `types.ts:452-455`), agents' `modelBinding.pinned`/`allow`
(`types.ts:459-460`), and chain steps' `args.model` strings (parse via
`agents.ts:206-216 parseModelRef`). Also remove the provider from `plugin.secretRegistry`
(registered `ai.ts:274`, currently leaked on delete). Agents dropdown (`ai.ts:1050-1084`,
model list `:1090-1108`, allowlist `:1147-1176`): filter to providers with ≥1 chat-capable
model and models to chat-capable, **via `modelHasCapability` (`src/settings/modelCapabilities.ts:25-28`)**
— never raw `capabilities?.includes('chat')`, because `capabilities === undefined` means
chat-only (legacy trap, `types.ts:337-342`). Keep already-saved non-chat selections rendering
with a "(not chat-capable)" note — mirror `describeRerankModel` (`orchestration.ts:145-160`).
Tests: in-use summary collection, capability filter incl. the undefined-legacy case.
Files: `src/settings/sections/ai.ts`, tests. NOT in scope: confirming agent deletion, fixing
the three `orchestration.ts` ref helpers' raw-includes (chat isn't their capability).

**WP-3 — dashboard re-render gates (anti-flicker).**
*~0.30 kSLOC · ~170k tokens · ~13 min wall · mid (Claude Sonnet/medium; Codex Terra/medium) ·
Claude: subagent (142k vs 340k direct); Codex: subagent (~124k)*
No "flicker gate" abstraction exists (repo grep: one FEEDBACK.md hit; signalworks-design has
none) — this WP creates the repo's pattern. Cause: queue events coalesce at 250ms
(`JobBackend.ts:129`) into a 150ms debounce (`ingestionDashboard.ts:27,:158`) into
`renderQueueMonitor`'s full `body.empty()` teardown (`queueMonitor.ts:236`,
`sortableTable.ts:19`) — a full table rebuild ~4×/sec during drains. Fix: (a) a shared
scroll/focus-preserving re-render helper generalizing the settings idiom
(`settings.ts:83-87` — save `scrollTop`, re-render, restore in rAF) applied to the ingestion
dashboard sections; (b) a min-interval gate (~1s trailing) on the queueMonitor refresh during
event bursts — cadence, not diffing; (c) gate the blind `dataview:dataview-rebuild-current-view`
fire (`src/lint.ts:273-276`) on the lint actually having modified the file. Follow the
existing `relevantSignatures` input-gate precedent (`ingestionDashboard.ts:42-46`) for shape.
Tests: helper unit tests; cadence gate logic (pure part). NOT in scope: keyed row diffing /
virtual DOM, sourceEval dashboard (same shape, separate follow-up if wanted).
Files: `src/ingestionDashboard.ts`, `src/ingestion/render/sortableTable.ts` (or new
`src/ingestion/render/refresh.ts`), `src/ingestion/sections/queueMonitor.ts`, `src/lint.ts`,
tests.

**WP-4 — FIFO-correct job ids and queue ordering.**
*~0.15 kSLOC · ~120k tokens · ~9 min wall · mid-low (Claude Sonnet/low; Codex Terra/low) ·
Claude: subagent (112k vs 240k direct); Codex: subagent (~94k)*
Root cause (pinned): `newJobId` (`src/orchestration/utils/dates.ts:35-46`) is second-granular
+ 4-hex random suffix; a batch fan-out enqueues dozens of jobs in one second, and the queue
comparator (`JobStore.ts:125-130` — lane, priority, then `id.localeCompare`) ties down to the
random suffix, so claim order (= display order; the status sort at `queueMonitor.ts:305-313`
is stable over input order) is random with respect to `batchIndex`. Fix: millisecond +
in-process monotonic counter in `newJobId` (keep the shape/prefix — job ids appear in file
names and dedupe maps; verify no parser assumes the second-granular format), and a
`a.job.created.localeCompare(b.job.created)` tie-break before the id compare in
`JobStore.listFolder`. Also normalize the queueMonitor `created` column: memory rows put a
human-formatted string where file rows put raw ISO (`queueMonitor.ts:263-264,:285`) — store
raw ISO in the row, format at render, so the Created sort compares one format. Tests: id
monotonicity within a tight loop, comparator tie-break, mixed-source created sort.
NOT in scope: `maxParallelFixed` on `image_describe_batch` (per-type override is a feature;
out-of-order *completion* under user-raised parallelism is correct behavior).
Files: `src/orchestration/utils/dates.ts`, `src/orchestration/JobStore.ts`,
`src/ingestion/sections/queueMonitor.ts` (created column), tests.

**WP-5 — close: docs, quirks, live validation, deregister.**
*~0.05 kSLOC · ~40k tokens · ~8 min wall + live validation · n/a (orchestrator-direct) ·
Claude: direct (must-direct: final integration/gates/commit duty + live validation); Codex: direct (same)*
Quirks entries (nearest AGENTS.md): the runaway-generation incident (`max_tokens` absent ⇒
`n_predict:-1` ⇒ context-ceiling generation; caps are a correctness requirement like
`reasoning_effort`) in `src/search/AGENTS.md` or root; the `newJobId` granularity note in
`src/orchestration/AGENTS.md`. Validation with the user (vault, `npm run dev`): re-enable
Image descriptions, run the backfill, confirm the prune deletes the two poison records
(`222273aa…`, `d571e7e…`), watch a batch for capped extraction times (worst legit ≈45s), then
verify a figure query hits the owning note with the figure pill (the original sprint's still
open validation item). Deregister the plan; ledger rows per WP.

## Public Interfaces

| Surface | Change |
|---|---|
| `ImageDescriptionRecord.kind` | `+ 'failed'`; new optional `failure` field (schemaVersion stays 1) |
| Store API | `+ pruneDegenerate(maxExtractionChars)` |
| `describeImagePass` / `describeImage` | per-pass `max_tokens` (512/2048) in an options arg |
| Chunk/facet contract | `kind:'failed'` records emit no chunks and no `image-desc` facet |
| `newJobId` | millisecond + monotonic; same textual shape |
| Queue claim order | `created` tie-break before id compare |
| Settings UX | Delete Provider confirms with in-use summary; Agents dropdowns chat-capability-filtered |

## Execution

```
wave 1 (parallel):  WP-1 hardening · WP-2 settings UX · WP-4 job ids   (disjoint file scopes)
wave 2:             WP-3 dashboard gates   (touches queueMonitor.ts after WP-4 lands)
close (direct):     WP-5 docs + live validation + deregister
```

Ask-before-dispatch stands per wave. Workers in worktrees off local master tip; workers never
commit; orchestrator reviews, re-runs gates verbatim, commits per WP, ff-merges. Pause for
user compaction at WP boundaries. Remind the user to run `npm run dev` at implementation start.

## Test Plan / Verification

Per WP landing, the full cleanup loop: `npm run lint`; `npx tsc -noEmit -skipLibCheck`;
`npm test` (baseline **892 tests / 74 files** — count only grows); `node esbuild.config.mjs
production`; `grep -rna --include='*.ts' "console\." src/` → only `src/log.ts`; `file` +
`LC_ALL=C grep -caP '\0'` (exit 1 = PASS) per touched file; NUL discipline (`'\0'` escape
only). WP-specific assertions listed per WP above. WP-5's live validation is the end-to-end
proof: capped pass times, poison records pruned and cleanly re-described, figure query lands.

## Critical Files

`src/providers/openaiCompatible.ts:273-306`; `src/orchestration/utils/imageDescribe.ts`
(loop :100-127, `describeOneImage` :131-199); `src/search/imageDescriptionStore.ts` (:34, :94);
`src/search/SearchManager.ts:485-505`; `src/orchestration/workflows/ImageDescribeWorkflow.ts`;
`src/settings/sections/ai.ts` (:85, :107-118, :124, :296-303, :1029-1176);
`src/settings/modelCapabilities.ts:25-28`; `src/confirmModal.ts`;
`src/ingestionDashboard.ts` (:27-46, :147-249); `src/ingestion/sections/queueMonitor.ts`
(:236, :262-289, :305-313, :358-363); `src/ingestion/render/sortableTable.ts:19`;
`src/orchestration/utils/dates.ts:35-46`; `src/orchestration/JobStore.ts:125-130`;
`src/lint.ts:273-276`.

## Assumptions

1. `max_tokens` is accepted by every provider kind on chat/completions (universal field) —
   unlike `reasoning_effort` it needs no `isLocal` gate.
2. A timed-out `requestUrl` cannot be aborted; the abandoned response is discarded and the
   `max_tokens` cap bounds the server-side cost. Acceptable: worst case one capped generation
   (~45s) completes into the void.
3. The 20k-char prune threshold cleanly separates degenerate (76k/94k observed) from healthy
   (≤7.4k observed) on this corpus; it is a constant, adjustable at WP-5 validation.
4. Failed records persisting until manually cleared is acceptable for now (no retry UI).
5. `newJobId`'s textual shape change (ms + counter) breaks no parser — WP-4 verifies by grep
   before changing.

**Total ≈ 1.1 kSLOC, ~660k raw tokens; ~612k Claude-path / ~504k Codex-path Opus/Sol-equivalent
tokens** (model-cost.mjs: WP-1..4 dispatched to Sonnet at 148k/130k/142k/112k, WP-5 direct on
Fable at weight 2.0).
