# Search follow-ups: portable space keys, query logging, honest embedding failures, index inspection

*Filename kept as `search-space-key-and-query-logging` because `INITIATIVE.md` `pending-plans`
registers that slug; the scope grew past the name on 2026-07-25.*

*Recommended model/effort — Claude: Sonnet/medium for WP-1 and WP-3, Opus/high for WP-2 and WP-4;
Codex: Terra/medium for WP-1 and WP-3, Sol/medium-high for WP-2 and WP-4.*

## Context

All four work packages come out of ESI WP-5 Stage 2, and every one was found by the user doing
ordinary things rather than by a review.

**WP-1** surfaced when "Fetch Models" was used to configure the local GPU embedder. It populated
the model field with `/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf` — the served id, which
for a llama-server container is a **container-internal mount path**. That string then flows
straight into the vector-space key, because `SearchManager.activeEmbeddingSpaceId()`
(`src/search/SearchManager.ts:365`) builds the space as `activeEmbeddingModelId() + '/' + precision`
and `activeEmbeddingModelId()` (`:349`) returns `settings.searchEmbeddingModel.modelId` verbatim.

Measured 2026-07-25 against the live container: **llama-server ignores the `model` request field
entirely and echoes it back.** `totally-made-up-name` returns a valid 1024-d embedding with
`"model":"totally-made-up-name"` in the response. Two consequences:

- The space key becomes host- and mount-specific. Change the compose mount, or switch to the
  `crucible-embed-gpu` variant that mounts `~/.lmstudio/models`, and the same weights produce a
  different space → a full re-embed of 52,627 chunks for nothing. This is exactly what the design
  comment at `src/search/types.ts:71-73` forbids, and the same category of error as the plan's own
  recorded rule that ollama's `digest` must not be the key.
- **WP-2's "warn once per session when `servedModel` disagrees with the configured id" can never
  fire against llama-server**, because an echo cannot disagree. A guard that structurally cannot
  trip is worth either fixing or documenting as inert.

The workaround in use today is manual: type `bge-m3` instead. It works *because llama-server hosts
one model and ignores the field* — it would be wrong against LM Studio or vLLM, which route on the
id. So the fix cannot simply be "always shorten the id".

**WP-2** comes from arm D1 (`runs/measurements/esi-fr-2026-07-25/arms/D1-fts-vs-vector.md`). D1
could only be run on **four** queries because no recorded set of real vault searches exists — the
one attempt to find them swept monthly `## Observations`, `core/`, and a sibling repo and turned up
exactly one recollection-shaped line in the whole vault. Constructed fill was considered and
rejected: if the same party writes the queries and runs the test, "FTS cannot find this" becomes a
property of the authorship. The user's own conclusion, and it is the right one.

Logging by discipline fails for the obvious reason — you remember to log a query exactly when you
are not in a hurry, which is not when the hard lookups happen. Logging passively does not.

**WP-3 and WP-4 come from a single incident on 2026-07-25, during the E1 run.** A full
`Orchestrate: Search rebuild index` ran for 35 of 55 batches, reporting success on every one, while
producing **zero** embeddings. Diagnosed live:

- Editing a model's id in the provider catalog (`/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf`
  → `bge-m3`) does **not** rewrite the saved `{providerId, modelId}` ref in `searchEmbeddingModel`.
  The ref is matched by `provider.models.find(m => m.id === ref.modelId)`
  (`src/search/SearchManager.ts:639`), so it silently orphans.
- `embedTexts` then throws `Embedding model not found: …` (`:640`) — correctly.
- But `flush()` catches it (`:233`) and, because the rebuild path does **not** set
  `requireEmbeddings` (only the backfill does, `SearchIndexWorkflow.ts:107`), takes the lenient
  branch: `logWarn(…)` and upsert the batch FTS-only. `logWarn` is debug-gated, so it emits nothing.
- The job records `status: done` with `Indexed search batch 35 / 55: 100 files, 275 chunks`.

Observed end state: `/health` reporting `embeddedChunks: 0`, `embeddingModel: null`,
`embeddingSpaces: []` against an index with a healthy FTS side (`total=2162` for `the`). **Every
individual component behaved as designed.** The lenient branch is right for "the embedder is
briefly down" and wrong for "the configured model does not exist", and it cannot tell them apart —
one is transient, the other can never self-heal. That distinction is WP-3.

The incident also exposes that there is **no window into the index and no lever short of
`/v1/index/reset`**. `/health` reports five scalars; there is no per-space or per-model breakdown,
no way to see which paths lack vectors, and no way to drop a superseded embedding space without
wiping the vault's index entirely. Two consequences compound over time: a user who switches
embedding models leaves the old space's vectors in the database forever — counted in
`embeddedChunks`, excluded from the scan by schema 4's space filter, never reclaimed — and a
failure like the one above is invisible until someone thinks to query `/health` by hand. That is
WP-4.

## Decisions locked

User-confirmed 2026-07-25:

1. **Both are follow-ups, not report edits.** Changing the ranker or the space key mid-report
   invalidates every number in `runs/measurements/esi-fr-2026-07-25/`.
2. **Query logging is a real feature, not test scaffolding** — it ships to users, so it is
   opt-in, local, and inspectable.
3. **The index-inspection surface belongs on the dashboard**, alongside the existing Orphaned
   Attachments section — same shape (scan for stale artifacts, offer targeted cleanup), same
   precedent for a read-mostly view with a small number of destructive buttons.
4. **Dropping a space's embeddings must not be a reset.** Chunks and FTS rows stay; only vectors
   go. The coverage-aware skip then re-embeds those files on the next pass with no re-chunk
   required — that mechanism already exists and is exactly what makes targeted cleanup safe.

## Key Changes

**WP-1 — Separate the request-model id from the vector-space id (~0.35 kSLOC touched, ~180k tokens, ~14 min wall).** Files: `src/search/SearchManager.ts`, `src/search/types.ts`, `src/types.ts`, `src/settings/sections/ai.ts`, `src/providers/openaiCompatible.ts`, `tests/searchEmbeddingSpace.test.mjs`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: subagent.* No dependencies.

- **Add an explicit, optional space id on the model** — `ProviderModel.embeddingSpaceId?: string`
  beside the existing `embeddingVariant?`. When set it *replaces* the model id in the space key;
  when empty, behaviour is exactly today's. This is the honest fix: the portable identity becomes
  a thing the user states rather than a thing inferred from a string that was never meant to carry
  it. Follow `embeddingVariant`'s precedent for the settings row and its "fallback for runtimes
  that cannot self-report" labelling.
- **Normalize a path-shaped model id when deriving the space** (not when sending the request):
  if the configured id looks like a filesystem path, key on its basename without extension. This
  is a mitigation, not the fix — `bge-m3-f16` and LM Studio's `text-embedding-bge-m3@f16` still
  differ — so it must not be presented as making spaces portable across servers.
- **Fetch Models should not silently make the served id the space key.** Keep populating the
  request field with the served id (that is correct, and required by LM Studio/vLLM), but when the
  served id is path-shaped, prefill `embeddingSpaceId` with the normalized basename and say so in
  the UI. A user who never opens the field gets a portable key by default.
- **Decide the fate of the `servedModel` disagreement warning.** Against llama-server it cannot
  fire. Either drop it, or narrow it to providers whose `/v1/models` actually enumerates (LM
  Studio, vLLM) and document the echo case. Do not leave an inert guard implying coverage.
- Tests: a path-shaped id yields a basename-keyed space; an explicit `embeddingSpaceId` wins over
  both; an empty one reproduces today's key byte-for-byte (the no-re-embed guarantee).

**WP-2 — Passive vault-search logging (~0.5 kSLOC touched, ~260k tokens, ~20 min wall).** Files: `src/search/VaultSearchModal.ts` (or its actual home), `src/search/queryLog.ts` (new), `src/types.ts`, `src/settings/sections/ai.ts`, `tests/searchQueryLog.test.mjs` (new). *Model: top (Claude Opus/high; Codex Sol/medium-high) — it touches an interactive surface and writes user data. Execution: subagent.* Independent of WP-1.

- **Record, per search: the query text, the ranking shown (paths + ranks), the mode
  (fts/hybrid/rerank), and — the load-bearing part — which result the user opened.** Opening
  result #4 instead of #1 is a judgment-free relevance signal. This is implicit relevance
  feedback, which is how production IR systems are evaluated; it is strictly better evidence than
  a preference sitting because it is collected from real intent rather than recalled intent.
- **Opt-in, off by default, and visibly so.** It records what the user searches for; that is
  exactly the kind of thing that must never turn itself on.
- **Write to a managed note or JSONL under the queue root**, and — per the standing rule — make
  sure the path lands under an already-search-excluded prefix. A query log that gets indexed
  becomes the next `FEEDBACK.md`: a note containing every query's terms, which arm D1 measured
  suppressing the FTS fallback vault-wide.
- **No abandoned-search inference.** A search with no click is not a failure — the user may have
  read the snippet and been satisfied. Record the absence, do not label it.
- Deliverable for the report: a command that exports the log as an S2-shaped query file
  (`{id, text, source, targetPaths}`), with `targetPaths` seeded from what was actually opened.
  That closes the loop — D1 re-runs on real queries with real targets and no authorship bias.

**WP-3 — A broken embedding configuration must fail loudly (~0.3 kSLOC touched, ~170k tokens, ~13 min wall).** Files: `src/search/SearchManager.ts`, `src/settings/sections/ai.ts`, `src/types.ts`, `tests/searchEmbeddingConfig.test.mjs` (new). *Model: mid (Claude Sonnet/medium; Codex Terra/medium) — the diagnosis is already done and the fix is narrow. Execution: subagent.* Independent of WP-1, WP-2 and WP-4.

- **Separate "cannot embed right now" from "cannot ever embed with this configuration."** The
  `flush()` catch at `src/search/SearchManager.ts:233` currently treats both as the same lenient
  case. A missing provider or a model id absent from the catalog is a **configuration** error: it
  will not resolve itself on the next batch, on the next restart, or ever. Route those to a
  `Notice` (following `embedQuery`'s once-per-session precedent at `:620-623`) and to a job-visible
  failure, while a transport error, timeout or 5xx keeps today's FTS-only degradation.
- **Do not simply set `requireEmbeddings: true` on the rebuild path.** That would make a rebuild
  abort on a transient embedder blip, which is the failure mode the lenient branch exists to
  prevent, and would trade a silent wrong result for a fragile one. The distinction is the error's
  *class*, not the caller's strictness.
- **The backfill's existing guard is in the right place and checks the wrong predicate — fix that
  first.** `SearchEmbedMissingWorkflow` already refuses to run when semantic search is off or no
  model is configured (`SearchIndexWorkflow.ts:92-95`), which is exactly the right instinct. But it
  tests `activeEmbeddingModelId()`, which only asserts the id string is **non-empty**
  (`SearchManager.ts:349-353`). The 2026-07-25 ref was non-empty and simply did not resolve against
  the provider catalog, so the guard passed. Make it *resolve* the ref rather than measure the
  string; this is the cheapest and highest-value change in the WP.
- **Validate the ref where it is chosen, not only where it is used.** Add a resolve helper
  (`providerId` + `modelId` → model, or a typed "orphaned" result) and use it in the search
  settings section to render an inline warning when `searchEmbeddingModel` or `searchRerankModel`
  points at a model no longer in its provider's catalog. The user hit this by *renaming* a catalog
  entry; the clear-then-repick workflow fixed it, but nothing said it needed fixing.
- **Audit the other consumers of `{providerId, modelId}` refs.** Agents and chains hold the same
  shape and presumably orphan the same way. Report what is affected even if the fix is scoped to
  search; a silent-orphan class that spans surfaces should be recorded as such.
- Tests: an orphaned embedding ref surfaces an error rather than upserting FTS-only chunks; a
  transport failure still degrades to FTS-only and does **not** fail the job; the once-per-session
  notice does not fire per batch.

**WP-4 — Search index inspection and targeted maintenance (~0.7 kSLOC touched, ~320k tokens, ~25 min wall).** Files: `scripts/search-companion.mjs`, `src/search/client.ts`, `src/search/types.ts`, `src/ingestionDashboard.ts`, `styles.css`, `tests/searchIndexStats.test.mjs` (new). *Model: top (Claude Opus/high; Codex Sol/medium-high) — it adds destructive operations to a persisted store and must get vault scoping right. Execution: subagent.* Best after WP-1 (space ids become portable, so a space breakdown is worth displaying) but not blocked by it.

- **A stats endpoint that answers "what is actually in there."** Per vault: chunk and path counts,
  a breakdown by `embedding_space` and `embedding_model` with counts and coverage, chunks with no
  vector, `unattributedEmbeddedChunks` (already reported by `/health` and currently unexplained
  anywhere), and database size. This is the view that would have made today's incident obvious in
  one glance instead of 35 batches.
- **Every statement keys on `vault_id`** — see the schema-5 quirk in `AGENTS.md`. An aggregate or
  delete that omits the vault filter reports or destroys another vault's data, and that exact class
  of bug has already shipped once here in four separate statements. This is the single highest-risk
  part of the WP.
- **Targeted deletes, each narrower than reset**: drop all vectors for a named `embedding_space`
  (chunks and FTS survive; the coverage-aware skip re-embeds on the next pass), and drop chunks for
  paths that no longer exist in the vault. Both are per-vault. Reset stays as the blunt instrument.
- **A dashboard section** modelled on Orphaned Attachments (`src/ingestionDashboard.ts`): the
  breakdown as a table, a coverage indicator, and the cleanup buttons — destructive ones carrying
  `mod-warning` and routed through `ConfirmModal`, with a `gap` in the action cell per the UI
  standards. Pills follow the fleet taxonomy: coverage is a **status** pill, a space's chunk count
  at rest is **neutral** — a count is not an alarm.
- **Surface embedding *coverage*, not a zero-vector alarm.** An earlier draft of this WP specified
  "warn when the vault has chunks but zero vectors", and the 2026-07-25 run proves that condition
  is the wrong one: the index went from 0% to 34% covered the moment the fixed batches started
  landing, so a zero-vector alarm would have fallen silent while two-thirds of the vault stayed
  permanently unembedded. The displayed figure must be `embedded / total` per vault, computed
  server-side (`COUNT(*) WHERE embedding IS NULL`), with the remedy named inline — `Search: embed
  missing vectors`, which repairs exactly this without a reset.
- **Distinguish transient incompleteness from settled incompleteness.** Coverage is legitimately
  below 100% during any rebuild or backfill, so alarming on it directly would fire on every normal
  run and train the user to ignore it. Show coverage always; reserve any *warning* treatment for a
  gap that persists with no search jobs in flight. The queue view already owns work-in-progress —
  this section owns what the index contains.
- **Do not live-poll the companion during indexing.** The same run showed 17 health-probe timeouts,
  clustered immediately before each ~500-chunk flush: `node:sqlite`'s `DatabaseSync` is
  synchronous, so a bulk upsert blocks the single-threaded server and no request is answered until
  it completes. A stats panel that polls on a timer will both time out and add load precisely when
  the index is busiest. Fetch on open and on explicit refresh.
- Do **not** add a rebuild-progress view here. That is the queue's job and it already has one; this
  section describes the index's contents, not the work in flight.
- Tests: stats aggregate correctly with two vaults in one database and never cross the boundary
  (extend `tests/searchVaultIsolation.test.mjs`'s two-vault fixture — it is the only one that
  writes distinct vault ids); dropping a space leaves chunk and FTS rows intact and coverage
  correctly reports those files as needing embeddings; dropping one vault's space leaves the
  other's untouched.

**WP-5 — A busy companion must not read as a dead one (~0.25 kSLOC touched, ~150k tokens, ~12 min wall).** Files: `src/search/lifecycleGate.ts`, `src/search/client.ts`, `scripts/search-companion.mjs`, `tests/searchLifecycleGate.test.mjs`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium) — narrow, and the diagnosis is complete. Execution: subagent.* Independent of the others; **highest priority of the five**, because it makes long indexing runs self-suppressing.

**Probe-semantics scope below implemented by `plans/sprint-exit-queue-health-and-scrub.md` WP-3** (typed `refused`/`timeout`/`server-error` cause, gate-level 3-consecutive-timeout hysteresis, a dedicated background probe timeout, flush-window probe suppression, honest offline copy, and a chunked companion upsert that keeps `/health` responsive). The circuit-breaker tail that followed this section moved to that plan's WP-2 — see the note below in place of it.

Observed 2026-07-25, immediately after the E1 run: the whole queue reported `Search companion not
reachable at http://127.0.0.1:4801` while the container had **7 hours uptime, 0 restarts, no OOM,
three clean log lines, and answered `/health` instantly**.

- **The probe path treats a timeout as a confirmed outage, and it is not one.** `probe()`
  (`src/search/lifecycleGate.ts:78-92`) does `await healthCheck().catch(() => null)` and, on
  anything other than `ok === true`, calls `markOffline(health?.message ?? null)` — the **5-minute**
  `SEARCH_OFFLINE_CACHE_MS` latch. `client.health()` (`:38-39`) uses the 5s interactive timeout.
  The companion is single-threaded and `node:sqlite`'s `DatabaseSync` is synchronous, so a
  ~500-chunk flush blocks it well past 5s. The E1 trace caught this 17 times, each timeout landing
  immediately before a +500 counter jump.
- **The existing fix stopped one step short.** `markTransientFailure` was introduced for
  *mid-operation* failures (`SearchManager.ts:182`) with the rule "keep `markOffline` for
  probe-confirmed outages only." The unexamined premise is that a failed probe confirms an outage.
  **A timeout confirms nothing** — distinguish *no answer within the deadline* (transient; the
  server may simply be busy with our own work) from *actively refused / connection error* (a real
  outage). Only the latter earns the 5-minute latch.
- **Never latch while our own indexing is in flight.** The plugin knows whether search jobs are
  running; a probe timeout during that window is the expected consequence of the work, not evidence
  against it.
- **A null reason must not produce "go start the container."** That string sends a user to restart
  a healthy service — already recorded as a hazard in `AGENTS.md`, and it happened again here
  because `markOffline(null)` is exactly the null-reason path.
- **Consider the server side too**: the flush holds the event loop for seconds at a time. Either
  chunk the transaction so the loop breathes, or serve `/health` in a way that cannot queue behind
  a write. This is the root cause; the client change is the guard.
- Tests: a timed-out probe does **not** latch for 5 minutes; a connection-refused probe does; a
  probe timeout while indexing is in flight leaves availability unchanged; the deferral message
  never falls back to the container-restart text when the true cause is a timeout.

**Circuit breaker (registry, drain integration, retry wake-up) moved to `plans/sprint-exit-queue-health-and-scrub.md` WP-2** — the finding still stands (no breaker meant an unavailable dependency swept the entire queue at full speed, ~40 jobs/second, and the designed per-job `retryAfterMs` retry never fired because nothing observed it elapsing), but the fix is a cross-cutting service-health registry shared by every job type, not a search-local change; see that plan's WP-2 for the full mechanics and test list.

## Public Interfaces

| Surface | Change |
|---|---|
| `ProviderModel.embeddingSpaceId?` | **New** optional setting; empty preserves today's key exactly |
| `searchQueryLogEnabled` | **New** setting, default **false** |
| `searchQueryLogPath` | **New**; must sit under a search-excluded prefix |
| `Search: export query log as query set` | **New** command |
| `GET /v1/index/stats` | **New**; per-vault chunk/path counts, breakdown by space and model, coverage |
| `POST /v1/embeddings/drop` | **New**; drops vectors for one `embeddingSpace` in one vault, keeps chunks + FTS |
| `POST /v1/chunks/prune` | **New**; drops chunks for paths absent from the vault, one vault only |
| `GET /health` | Warns when a vault holds chunks but zero vectors while semantic search is on |

No forced re-embed from any WP: WP-1's default path reproduces the current key byte-for-byte, and
WP-4's drops are opt-in and explicitly user-triggered. **No schema bump** — schema 5 already carries
every column WP-4 reads.

## Test Plan / Verification

Gates per the repo standard (`npm run lint`, `npx tsc -noEmit -skipLibCheck`, `npm test` — baseline
**520/520**, `node esbuild.config.mjs production`, `grep -rna "console\." src/` matching only
`src/log.ts`, and `file` on every edited file — a raw NUL has now shipped **three** times).

1. Empty `embeddingSpaceId` produces a key identical to the current one — the no-re-embed proof.
2. A path-shaped model id keys on its basename, and the request still sends the full id.
3. Query log is inert when disabled: no file created, no writes.
4. The log path is rejected at save time if it is not search-excluded.
5. Exported query sets validate against `dseries-judge.mjs prepare`'s schema.
6. An orphaned model ref fails the indexing job; a transport error does not (WP-3's whole point).
7. Stats and every delete are vault-scoped — asserted against a two-vault fixture, not a one-vault
   one, per the schema-5 lesson that every companion test but one pins a single constant.
8. Dropping a space leaves chunks and FTS rows intact, and those files then report coverage
   unsatisfied.

## Assumptions

1. **llama-server ignoring the `model` field is verified, not assumed** (2026-07-25, both the
   embedder on 4804 and the reranker on 4805; rerank additionally answers on `/rerank`,
   `/v1/rerank` and `/reranking`). It is a property of that server, not of the
   `openai-compatible` kind — LM Studio and vLLM route on the id.
2. **The query log will be small.** Interactive searches are human-paced; this is not the
   orchestration queue and needs no rotation scheme on day one.
3. WP-2's value is realized weeks later, not on landing. It should ship early precisely because
   its output accrues with time.
4. **The orphaned-ref failure is reproduced, not inferred** (2026-07-25). Observed live: a catalog
   entry renamed to `bge-m3` while `searchEmbeddingModel.modelId` still held the `.gguf` path; 35
   of 55 rebuild batches completed `status: done` with zero embeddings; `/health` reporting
   `embeddedChunks: 0` against a healthy FTS side. Re-picking the model through the settings
   clear-then-pick workflow rewrote both refs correctly.
5. **Whether agents and chains orphan the same way is unverified.** They hold the same
   `{providerId, modelId}` shape, so it is likely, but WP-3 should confirm before claiming it.
6. **WP-4's stats are read-mostly and can be computed on demand.** The counts come from indexed
   columns over tens of thousands of rows; no cache, no materialized view, no background job on day
   one. Revisit only if a measurement says otherwise.
