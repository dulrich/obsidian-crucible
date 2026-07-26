# Queue Control, Probe-First Model Configuration, and Vault Isolation

*Follow-up plan to `embedding-space-identity-and-runtime-bakeoff.md`. Five work packages, plus a
two-stage restatement of that plan's WP-5, which is held until these are approved.*

*Recommended model/effort — Claude: Opus/high for WP-A, WP-B and WP-E, Sonnet/medium for WP-C and
WP-D; Codex: Sol/medium-high for WP-A, WP-B and WP-E, Terra/medium for the rest.*

## Context

Three things came out of the embedding-space sprint that do not belong in it. Two are features the
user asked for; one is a latent data-loss bug the sprint's exploration surfaced and deliberately
sidestepped rather than fixed.

Each was scoped against the actual code before being costed. Where the scoping contradicted the
premise it was given, the correction is recorded in the work package rather than smoothed over.

## Decisions (resolved, user-confirmed 2026-07-25)

**D1 — Cancellation is designed for real abort, not just queued-job removal.** This is a deliberate
scope expansion, taken because a half-cancel leaves queue management an incoherent story in the
plugin: a UI that can remove a job from a list but not stop the work it represents teaches users
that the button does not mean what it says. Accepted cost: WP-A exists, and it is the largest
package here.

**D2 — A probe never auto-writes model configuration.** Probed values are *surfaced*, applied only
by an explicit **Accept** button, and reversible via a manual reset/override. This keeps
`model.capabilities` user-owned — the field where commit `193975c` just fixed a silent-clobber bug —
while still removing the hand-typing that motivated the feature.

**D2 amendment (decision 4, `plans/sprint-exit-queue-health-and-scrub.md` SE WP-8, user-confirmed
2026-07-25/26): auto-apply on explicit pick; badge + undo; background fetch never writes.** The
original rule conflated two different actions under one gate — a background/lazy catalog fetch
(no user intent expressed yet) and a user explicitly picking a model id from the fetched catalog
(as deliberate an action as clicking Accept once was). The amendment splits them: picking a model
from the catalog via the model-id suggest now calls `acceptCatalogSuggestion` immediately, through
the exact same path the Accept button always used — the per-field "probe-accepted" badge plus its
Reset button is the badge-and-undo affordance, not a new mechanism. The catalog itself also now
auto-fetches lazily the first time a provider's Models section renders when `modelCatalog` is
absent (at most once per provider per session; a manual Fetch models click or Clear cache still
work as before). What D2 continues to forbid, unchanged: a background or lazy fetch (or anything
short of an explicit user pick/Accept) writing to a `ProviderModel`'s
`capabilities`/`embeddingDimensions`/`embeddingVariant`. The **Accept** button remains, for a
hand-typed id that later comes to match a catalog entry.

**D3 — The `SCHEMA_VERSION` / `SEARCH_REQUIRED_SCHEMA_VERSION` pairing rule is honoured.** Both go
to 5. Search is unavailable between the plugin update and the container rebuild; that window is
harmless while the feature is actively being rebuilt, whereas a permanent documented deviation is a
maintenance cost carried forever by every future reader of the rule.

---

## WP-A — Cooperative cancellation through the workflow seam

**~0.8 kSLOC touched, ~230k worker tokens (integration class, includes a re-dispatch buffer),
~25 min wall.** *Model: top (Claude Opus/high; Codex Sol/medium-high) — touches every workflow and
the runner's failure accounting. Execution: Claude subagent.* No dependencies; WP-B consumes it.

**There is no cancellation of any kind today.** `src/orchestration/JobBackend.ts:41-43` states it:
"the abandoned workflow promise keeps running in the background (**no AbortController**)". The only
existing interruption is `runWorkflowWithTimeout` (`:44-60`), a `Promise.race` that makes the
*caller* give up while the workflow runs on.

**The hard constraint, which the design must be honest about: in-flight HTTP requests cannot be
aborted.** Every network call in Crucible goes through Obsidian's `requestUrl`, whose
`RequestUrlParam` has no `signal` field, and there are zero `fetch()` callers in `src/`. Therefore:

- Abort is **cooperative between awaits**, and abort latency is bounded by the longest single
  in-flight request — not by the checkpoint interval.
- The meaningful granularity is **per-item / per-batch**, which is also where it matters: the long
  workflows are loops (`SearchIndexWorkflow` over files, the tracker workflows over feed entries).
- UI copy must not promise instant stopping. "Stopping…" is accurate; "Stopped" is only true once
  the workflow acknowledges.
- Migrating the search companion client to `fetch` (loopback, our own server, real `AbortSignal`)
  would give true mid-request cancellation. **Named as a future option, deliberately out of scope** —
  it changes the transport for the one client with its own dual-timeout design.

Design:

- **Widen the seam, which is currently minimal and clean.** `WorkflowContext` is
  `{ plugin: CruciblePlugin }` (`workflows/Workflow.ts:4-6`) and `Workflow.run(job, ctx)` is a
  two-method interface. Add `signal: AbortSignal` plus a `throwIfAborted()` helper to the context —
  one seam, no change to `run`'s arity.
- **22 registered workflows** across 14 files (`main.ts:171-189`). They do **not** all need
  checkpoints: short single-shot workflows need one check at entry, and only the loop-shaped
  long-runners need per-iteration checks. Classify explicitly rather than mechanically instrumenting
  all 22 — an audit table in the WP report is the deliverable that proves coverage.
- **Cancellation must be a distinct terminal state, not a failure.** `WorkflowResult.status` is
  `'done' | 'failed' | 'deferred'` (`types.ts:56`) with a typed `failureReason`. A cancelled job
  recorded as `failed` will be retried by policy and will pollute failure diagnostics. Either add a
  `'cancelled'` status or a dedicated `failureReason` — the former is cleaner and this WP is where
  the cost is already being paid.
- **Do not let cancellation fight stale-recovery.** `Orchestrator.scan()` (`:135-147`) bounces
  `running → queued` past `staleRunningMsForTimeout`. A cancelled-but-still-settling job must not be
  resurrected by that sweep.
- **Release everything on the abort path.** The note-lock is the one that matters: it is scoped to
  leaf operations and releases when they settle, so an abort must not leave a note greyed out. Test
  this explicitly.

Files: `src/orchestration/workflows/Workflow.ts`, `src/orchestration/types.ts`,
`src/orchestration/{JobBackend,FileJobBackend,MemoryJobBackend,Orchestrator,OrchestrationAutoRunner}.ts`,
and the classified subset of `src/orchestration/workflows/*.ts`; new
`tests/workflowCancellation.test.mjs`.

---

## WP-B — Queue control: cancel/abort/clear, plus Queue Configuration alignment and per-type concurrency

**~0.7 kSLOC touched, ~195k worker tokens, ~19 min wall.** *Model: top (Claude Opus/high; Codex
Sol/medium-high) — concurrent claim guards and a rollback-invariant file move. Execution: Claude
subagent.* Depends on WP-A.

Scope covers the whole Queue Monitor / Queue Configuration surface, since it is open anyway: the
cancel work below, the configuration-grid alignment, and the missing per-type concurrency control.

**Prior art is landed, not pending.** `plans/queue-config-monitor-coherence-2026-07-17.md` shipped;
branch `worktree-queue-config-coherence` (`3b8b267`) is an ancestor of master with nothing
outstanding. It built the two-axis enqueue/run model, the single `orchestrationQueueEnabled` master,
and **per-job Run** end to end (`JobBackend.runJob:26` → `Orchestrator.runJob:97` →
`OrchestrationAutoRunner.runJob:61-69` → `FileJobBackend.claimById:141-154` /
`MemoryJobQueue.claimEntry:157-163`). This WP builds on it and supersedes nothing.

**The gap:** `runJob` is the only per-job action that exists. There is no `cancelJob`, no
`deleteJob`, no clear-all anywhere. The single existing "cancel" is memory-only and one line —
`queueMonitor.ts:247-252` → `MemoryJobQueue.dequeueIfPending:83-89` — handles `pending` only and is
not exposed generically.

- **Mirror `runJob`'s dispatch path exactly**: `cancelJob(key)` / `clearQueued()` onto
  `JobBackend.ts:14-31`, dispatched via `Orchestrator.ts:97-100`, entering through
  `OrchestrationAutoRunner.ts:61-69` so UI actions inherit its disposed/semaphore guards.
- **One verb, two mechanisms.** A *queued* job is cancelled by removal; a *running* job is cancelled
  by signalling WP-A's `AbortSignal` and awaiting acknowledgement. The UI should present one Cancel
  action with honest transitional state ("Stopping…"), not two differently-named buttons — WP-A is
  what makes that possible.
- **Take the claim guard, always.** `FileJobBackend.claimed:22` is the only interlock between the UI
  and a live drain. Cancel and clear must claim by id (`claimById:141-154` is the template) rather
  than moving or trashing files out from under a claim.
- **Inherit `JobStore.move`'s rollback invariant** (`:152-188`): a frontmatter-write failure renames
  the file back and rethrows, so a throw means "the job stayed queued", not "cancelled" — the caller
  must not report success.
- **Clear operates on `listFolder`, not on rendered rows.** The monitor caps display at 100
  (`queueMonitor.ts:8`) while a search rebuild enqueues hundreds of job files
  (`SearchIndexWorkflow.ts:40-44`).
- **Batch the change events.** Every mutation emits `orchestration-queue-updated`, which triggers
  both a full `listFolder` re-read (`FileJobBackend.ts:240-243`) and
  `OrchestrationAutoRunner.kickAll()` (`:33`). A per-item loop over a bulk clear would emit N of
  each. One terminal emit.
- **State the auto-refill interaction in the UI copy.** Clearing memory entries — terminal ones
  especially — removes the suppression `MemoryJobQueue.refill:117-124` relies on, so with
  auto-enqueue on the queue repopulates immediately. Either disable the source alongside, or say
  plainly that cleared items may return.
- **UI convention:** the queue monitor is a `renderSortableTable`, *not* the settings List+edit
  pattern — do not convert it. Per-row actions go in the Action cell (`queueMonitor.ts:226-254`),
  queue-wide actions in `.crucible-ingestion-queue-controls` (`:49-64`). Follow the established
  destructive precedent: bulk actions confirm via `ConfirmModal` (`orphanedAttachments.ts:49`),
  single-row actions do not.

### Queue Configuration: control alignment

`renderTypeControl` (`render/queueTypeControls.ts:24-79`) emits a flat inline row — monospace type
name, auto toggle, state chip, rate input — into `.crucible-queue-type-control`, which is
`display: flex; flex-wrap: wrap` (`styles.css:757-765`). Type names run from `chain_run` (9 chars) to
`youtube_channel_enrich_sweep` (28), so every card places its controls at a different x, and above
the `1fr 1fr` breakpoint (`:752-754`) a long name wraps controls to a second line in some cards but
not others.

- Replace the per-card flex flow with **fixed column tracks and a header row** — name (flexible),
  then aligned columns for auto, state, rate and concurrency. Numeric inputs right-justified so the
  digits line up down the column.
- Headers are what make the numeric columns legible; today the units live in per-control `title`
  tooltips and a trailing `s` glyph (`:70`), which is not discoverable.
- Keep the responsive clamp (`max-width: 52rem`, `:747`) and the two-column breakpoint. If a header
  row cannot survive two side-by-side card columns, prefer **one full-width table** over headers
  repeated per column.
- Per CLAUDE.md: no hardcoded pixel widths — use the `.pi-width-*` classes or grid tracks. The
  existing `width: 3.5rem` on the rate input (`:783-785`) should become a track, not a wider literal.

### Queue Configuration: per-type concurrency

**The mechanism exists and is entirely unexposed.** `JobTypeConfig.maxParallel`
(`jobTypeConfig.ts:13`) is honoured per type by the drain loop
(`OrchestrationAutoRunner.ts:127`), bounded by the global `orchestrationMaxConcurrent` semaphore
(`:30`). But `fileJobConfig` hardcodes `maxParallel: 1` (`:36`) for **every** file-backed type,
including all six search types, and only `youtube_metadata_fetch` reads it from a setting
(`:64`, `:143`). Nothing in the UI displays or edits it. Consequence: a 52k-chunk rebuild drains
`search_upsert_batch` strictly one batch at a time with no lever.

- **Follow the rate-override pattern exactly, not the config-getter pattern.** The per-type
  `minIntervalMs` override already lives in `orchestrationJobTypeControls` and is read live by the
  drain loop (`readTypeMinIntervalOverride` / `setJobTypeMinInterval`). Add
  `readTypeMaxParallelOverride` / `setJobTypeMaxParallel` the same way and consult it at
  `OrchestrationAutoRunner.ts:127` before falling back to `getConfig(type).maxParallel`. This is a
  one-line runner change and keeps the `*JobConfig()` factories pure — do **not** thread `plugin`
  into `fileJobConfig` to add a getter, which would change every factory signature.
- **Some types must stay serial, and the UI says so with a pill — not a disabled input.**
  `search_embed_missing` is deliberately single-flight; the comment at `jobTypeConfig.ts:115-117`
  explains that two concurrent fan-outs double the batch count for identical work. Mark such types
  with a `maxParallelFixed` (or equivalent) marker on the `JobTypeConfig`, and render a **`serial`
  pill** in the concurrency column carrying the reason in its tooltip. Do **not** render a
  greyed-out number input: a disabled control with no visible cause reads as a bug or as something
  the user is failing to unlock, and a live-but-ignored input is worse still. The pill states the
  constraint as a property of the job type, which is what it is.
- **Name the real ceiling in the UI copy.** Raising `search_upsert_batch` concurrency issues
  concurrent upserts at a single-threaded companion over SQLite WAL, so returns flatten quickly and
  the global semaphore still caps total in-flight work. Show the effective value (override, config
  default, and the global cap) rather than just the number the user typed.
- At minimum this is **visibility**; editability is the goal, but a read-only effective-concurrency
  column is strictly better than today's silence and is the fallback if the fixed/floor question
  proves contentious.

Files: `src/orchestration/{JobBackend,Orchestrator,FileJobBackend,MemoryJobBackend,MemoryJobQueue,JobStore,OrchestrationAutoRunner,EnrichmentQueueAdapter,autorunGate}.ts`,
`src/orchestration/jobTypeConfig.ts`, `src/types.ts` (the per-type control record),
`src/ingestion/sections/queueMonitor.ts`, `src/ingestion/render/queueTypeControls.ts`, `styles.css`;
tests extend `tests/{jobStoreQueue,memoryJobQueue,orchestratorScan,autorunGate}.test.mjs`.

---

## WP-C — Model catalog probing: the provider layer

**~0.7 kSLOC touched, ~140k worker tokens, ~14 min wall.** *Model: mid (Claude Sonnet/medium; Codex
Terra/medium) — the contract decision is made in D2, leaving mechanical work. Execution: Claude
subagent.* No dependencies; WP-D consumes it.

**The premise checked out, with one cost-saving correction:** `describeModel` describes exactly one
already-known model id and nothing enumerates a list — but **the list endpoints are already fetched
and then discarded**. `openaiCompatible.ts:253` and `:292` and `ollama.ts:110-111` each GET a full
model list and immediately `.find()` one entry. The fetch code, the HTTP-200-with-error-body trap
handling (`isNativeModelsBody:87-91`), and the response typing all exist. This WP largely factors
them into fetch-list + find-one.

What a list actually buys, per kind — the honest table, because it is uneven:

| kind | list? | capability signal | must stay manual |
|---|---|---|---|
| `openai-compatible` | yes, two-tier: LM Studio `/api/v0/models` then `/v1/models` | **best available** — `type` (`llm`/`embeddings`/`vlm`), `arch`, `quantization` | dimensions; cross-encoder disambiguation |
| `openrouter` | yes, no API key needed | **rich and currently 100% unread** — `architecture.input_modalities`, `context_length`, `supported_parameters` | embeddings/rerank (not served) |
| `ollama` | yes (`/api/tags`) | weak; a second `/api/show` gives `capabilities` and real `embedding_length` | image-extraction, rerank |
| `openai` | yes | **ids only** (`id` + `owned_by`) | everything but autocomplete |
| `anthropic`, `google` | endpoints exist, no client code | none today | everything |
| the four CLI kinds | **no** — `requireCapability:189-191` hard-rejects | none | everything, permanently |

- **`listModels?(ctx)` cannot reuse `HttpCallContext` unchanged** — it requires `modelId`
  (`shared.ts:7-11`), and a list probe has none. Add a `modelId`-free context variant rather than
  passing a sentinel.
- Widen `OptionalHttpCapability` (`providers.ts:33`) and `CLI_UNSUPPORTED_VERB` (`:35-40`); the
  exhaustive map makes the CLI rejection a compile error if forgotten. Leave it that way.
- **Persist the catalog to settings following the currency/geocode precedent**, not a module-level
  cache: `{ fetchedAt, models[] }` on `Provider`, stamped, invalidated only by an explicit
  Clear-cache button (`types.ts:353-361`, `orchestration.ts:692-696`). Model lists change rarely and
  a probe hits a possibly-absent local server.
- **Per D2 the catalog is a separate field from `model.capabilities` and never writes it.** The
  provider layer's job ends at "here is what the server says"; applying it is WP-D's, and only on an
  explicit click.
- **Nothing on any path reports embedding dimensionality via a list endpoint.**
  `embeddingDimensions` can only come from ollama's `/api/show`
  `model_info['<arch>.embedding_length']`, or from actually embedding a probe string. Do not
  fabricate it.
- **Preserve the cross-encoder posture.** `looksLikeCrossEncoder` (`shared.ts:242-244`) is a
  warn-never-block heuristic because the distinction is undecidable from server metadata
  (`:246-259` documents why, with measurement). The catalog may carry the suspicion; it may not act
  on it.

Files: `src/types.ts`, `src/providers/{shared,openaiCompatible,ollama}.ts`, `src/providers.ts`,
optionally `src/providers/{anthropic,google}.ts`; new `tests/providerModelList.test.mjs` mirroring
`tests/providerModelProbe.test.mjs` (which already has a `requestUrl` URL-pattern mock harness at
`:78`).

---

## WP-D — Probe-first provider configuration UI

**~0.65 kSLOC touched, ~120k worker tokens, ~13 min wall.** *Model: mid (Claude Sonnet/medium; Codex
Terra/medium). Execution: Claude subagent.* Depends on WP-C.

Today every model is hand-typed: `ai.ts:356-360` pushes `{id:'', label:'', capabilities:['chat']}`
and the id field (`:278-282`) is bare free text. There is no fetch, refresh, or discovery anywhere in
all 759 lines.

**The D2 interaction model, which is the heart of this WP:**

1. **Fetch** — a button beside "Add model" (`:356`) populates the cached catalog.
2. **Surface** — where a probed value differs from or would fill a field, show it inline as a
   suggestion with its provenance ("LM Studio reports: embeddings, F16"). Never applied on arrival.
3. **Accept** — an explicit button writes the surfaced values into the model row. This is the only
   path by which a probe reaches `model.capabilities`.
4. **Reset / override** — a manual control returns a field to user-entered state and makes clear
   which values are user-set versus probe-accepted.

- **Probe by default, manual as a real fallback.** The model id control becomes an
  `AbstractInputSuggest` over the cached catalog **that still accepts free text**, mirroring
  `CurrencySuggest` (`suggesters.ts:308-358`). Free typing must keep working when the probe is
  empty, unsupported, or the server is down — that is the whole fallback requirement, and it is what
  keeps CLI kinds and `anthropic`/`google` usable.
- Surface probe status and the failure reason inline. A silent empty list is the failure mode to
  avoid: the user needs to know whether the server said "no models" or was unreachable.
- **Await the probe before `tab.display()`.** The pane full-re-renders on every structural change
  (`:359`, `:291`); firing a probe and re-rendering concurrently shows a stale list.
- Respect the `undefined`-vs-`[]` invariant in `modelCapabilities.ts:24-37` — `undefined` means
  "unset, defaults to chat" and `[]` means "user turned everything off". Accept must never collapse
  the two. `tests/modelCapabilities.test.mjs` pins this.
- Add the Clear-cache button per the established precedent, `setWarning()`-styled
  (`orchestration.ts:692-696`).
- Downstream consumers (`modelPicker.ts:52-68`, `settings/shared.ts:65+`, the capability-filtered ref
  builders) read `provider.models` and need **no** change.
- Note for the implementer: `src/main.ts:356` and
  `src/orchestration/workflows/ImageMetadataExtractWorkflow.ts:26` read `capabilities?.includes(...)`
  raw instead of via `modelHasCapability`. Not this WP's job to fix, but do not add a third.

Files: `src/settings/sections/ai.ts`, `src/suggesters.ts`, `src/settings/modelCapabilities.ts`,
`styles.css`.

---

## WP-E — Vault isolation for chunk ids

**~0.4 kSLOC touched, ~130k worker tokens, ~13 min wall.** *Model: top (Claude Opus/high; Codex
Sol/medium-high) — a primary-key migration on the live index. Execution: Claude subagent.* No
dependencies.

**Confirmed by reproduction, not inference.** Against an in-memory database running the real
`createSchema` + `createRequestHandler`, one id upserted as vault A then vault B:

```
after B chunks: [{"id":"README.md#0:deadbeef","vault_id":"B", ...}]   <- A's row re-labelled
A state      : {"ok":true,"files":[]}                                 <- A's file vanished
A search     : 0
reset B      : after reset: chunks=0, chunks_fts=0                    <- A's data gone with B's
```

`stableChunkId` (`src/search/chunker.ts:159-161`) omits `vaultId`; the upsert conflicts on `id`
alone and re-labels (`search-companion.mjs:897-914`); the FTS delete has no vault filter (`:921`).
Two further id-keyed statements share the root cause and are part of the fix, not separate bugs:
`HYDRATE_CHUNK_SQL` (`:64`) and the FTS join (`:118`), both safe today only because ids happen to be
globally unique.

**Three findings that change how this should be framed:**

1. **The docs already specify the correct behaviour.** `docs/search-companion.md:72` describes the
   contract as *"A chunks table keyed by `vaultId + chunkId`"* and `:170` advertises that *"multiple
   vaults can share one companion database."* This is an implementation/spec divergence, not a design
   change — and a user who follows the documentation lands directly in the bug.
2. **It is silent and partially self-healing, which makes it worse.** Because `/v1/files/state` *is*
   correctly vault-scoped, vault A's next sweep sees the path missing, re-chunks it, and steals the
   row back. Two vaults on a timer ping-pong the same rows forever — burning re-index and re-embed
   work, each vault intermittently missing the colliding notes, no error anywhere.
3. **The read path is entirely correct.** Every vault-scoped statement in the companion is right;
   the bug is exactly four statements keying on `id` alone. Reset-of-B is itself properly scoped —
   the damage was done at upsert time. Do not "fix" reset.

- **The client-side fix needs no migration and no re-index.** Folding `vaultId` into `stableChunkId`
  leaves old rows unique and reachable (every lookup that matters is by `(vault_id, path)`); they are
  replaced naturally on the next per-path upsert, which is already a full replace (`:1087-1091`).
- **The server-side fix is a lossless table rebuild, not a reindex.** SQLite cannot `ALTER` a primary
  key, so `chunks` is recreated with `PRIMARY KEY (vault_id, id)`, `INSERT ... SELECT` copied,
  dropped, renamed — no row can collide during the copy because ids are currently globally unique —
  then `chunks_fts` is dropped and refilled via the existing `FTS_REFILL_SQL` (`:76-77`).
  `migrateFtsSchema` (`:188-203`) is the direct in-file precedent. **Drop-and-reindex is not required
  and must not be proposed as the only path.**
- **Per D3, bump both `SCHEMA_VERSION` and `SEARCH_REQUIRED_SCHEMA_VERSION` to 5.** Consequence to
  sequence deliberately: between the plugin update and the container rebuild, health reports
  `ok: false` (`client.ts:46`) and search is unavailable — not degraded. The container rebuild is
  therefore part of this WP's landing, not a follow-up, and the WP report must say so.
- **Snapshot before the migration runs against the live index** — `npm run search:snapshot`
  (`VACUUM INTO`, WAL-safe). A restore rehearsal on a scratch container is part of verification: an
  untested backup is not a backup.
- **Test coverage for vault isolation is zero.** Every companion test pins a single constant
  (`VAULT = 'test-vault'` at `searchCompanionRanking.test.mjs:29`, `searchCompanionVector.test.mjs:25`,
  `searchEmbeddingLifecycle.test.mjs:22`). Nothing would have caught this and nothing protects the
  *correct* scoped statements from regressing either. A new `tests/searchVaultIsolation.test.mjs`
  carrying the reproduction above is the deliverable that matters most.
- The old-schema fixtures at `searchCompanionRanking.test.mjs:234,239` and
  `searchEmbeddingSpace.test.mjs:163,178` are deliberate migration-test inputs — they must keep their
  old primary key and gain a migration assertion, not be updated to the new shape.

---

## ESI WP-5, restated: two stages

Held until the above are approved. The deliverable is no longer a single guide, and the measurement
work is explicitly separated from the writing.

### Stage 1 — Dataset design + the user guide

**~0.3 kSLOC, ~110k worker tokens, ~10 min wall.** *Model: mid. Execution: Claude subagent.*

**Design the full useful dataset first.** Enumerate the questions a practitioner report should
answer, and for each, the measurement that answers it and the protocol that makes it comparable —
before re-running anything. Output is a written measurement protocol, not numbers.

Existing raw material to consolidate: `runs/dispatch/esi-interim-runtime-measurements.md`,
`docker/llamacpp-vulkan/README.md`, the `wp-esi-1/2/3` briefs and reports, the cross-encoder tables
in `plans/embedding-space-identity-and-runtime-bakeoff.md`,
`context-control/references/rdna4-gpu-hang.md`, and `scripts/embedding-agreement.mjs` as the
reproducibility artifact.

Themes the dataset must cover: CPU vs GPU with honest end-to-end factors, not raw-endpoint figures;
LM Studio serving cross-encoders through `/v1/embeddings` at colliding widths with correct L2 norms
and a 0.0080 discrimination margin; quantization's real impact, where mean cosine reads 1.0000
across every arm while top-10 rank overlap falls to 0.8182; the llvmpipe silent-CPU-fallback trap;
and the raw-logits-versus-sigmoid wire-contract split.

**The known contradiction this stage must design around:** two throughput figures exist and they
disagree. `runs/dispatch/esi-interim-runtime-measurements.md` records **50.7 chunks/s (6×)**
embedding and **0.3 s (24×)** rerank; `docker/llamacpp-vulkan/README.md` records **90.0 chunks/s
(10.6×)** and **0.147 s (50×)**. Different measurement contexts — the LM Studio-bundled
`llama-server` versus the containerized build — but neither is reproducible from the other. The
protocol must pin the variables that differ.

Also in this stage: `docs/local-inference.md` (written for Crucible users generally, leading with
the cross-encoder trap, cross-linking `docker/llamacpp-vulkan/README.md` rather than duplicating it),
plus updates to `docs/search-companion.md` and `AGENTS.md` (vector-backend seam now
`stats(vaultId?, space?)` / `knn(vaultId, queryVector, k, space?)`; schema 5; the space filter; the
two-level vault→space cache; and WP-E's vault-qualified chunk id).

### Stage 2 — Clean re-measurement under a single protocol

**~0.15 kSLOC, ~130k worker tokens, ~20 min wall plus run time.** *Model: top. Execution:
orchestrator-**direct** — live GPU/CPU services, GPU-risk judgment, and results the user needs to see
with their own eyes, exactly as ESI WP-4 was.* Depends on Stage 1's protocol.

Execute the Stage 1 protocol end to end in one sitting, on one machine state, with every arm's
configuration recorded alongside its numbers. This is what turns a sequence of opportunistic
measurements taken across a messy trajectory into a dataset that can be published and defended.
Supersede the two contradictory throughput tables with one measured under stated conditions.

GPU-risk protocol as before: unsaved work closed; on a wedge, recover via `systemctl restart lightdm`
over SSH or SysRq `S`-`U`-`B` rather than a hard power cycle, and capture
`/sys/class/drm/card1/device/devcoredump/data` **before** rebooting — it is in-memory only.

---

## Execution

```
WP-A (abort seam) ──► WP-B (queue control UI)
WP-C (probe layer) ──► WP-D (probe UI)
WP-E (vault isolation)  [independent]
                                    └──► ESI WP-5 Stage 1 (dataset design + guide) ──► Stage 2 (re-measure)
```

WP-A→B and WP-C→D are the only hard dependencies; WP-E is independent of everything. WP-A is the
critical path for the user's blocked queue work and goes first. WP-E wants a snapshot taken before
its migration runs, and its container rebuild is part of its own landing.

Subagents never commit; the orchestrator reviews each diff, re-runs gates verbatim, commits per WP,
and lands on local master unpushed.

## Test Plan / Verification

Gates after every WP, sequential, never backgrounded, prefixed with
`export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"`:

```bash
npm run lint
npx tsc -noEmit -skipLibCheck
npm test                          # baseline 435/435
node esbuild.config.mjs production
grep -rna "console\." src/        # only src/log.ts; the -a is load-bearing
file <every edited file>          # a raw NUL has shipped twice here
```

Tests that must exist:

1. **A cancelled running workflow stops at its next checkpoint** and reports a cancelled terminal
   state, not a failure.
2. **Cancellation releases the note lock** — no note is left greyed out after an abort.
3. **A cancelled job is not resurrected** by `Orchestrator.scan()`'s stale-running sweep.
4. **A workflow with no cooperative checkpoint still terminates cleanly** — abort must degrade, not
   hang.
5. **Cancel a queued file job** moves it out of `queued` and does not run it.
6. **Cancel loses the race safely** — a job already claimed by the drain is not double-handled, and
   the UI is told what happened.
7. **`JobStore.move` rollback is honoured** — a frontmatter-write failure leaves the job queued and
   the caller reports failure, not success.
8. **Clear-all emits one change event**, not one per job, and operates beyond the 100-row display cap.
9. **A per-type concurrency override is honoured by the drain loop** — the runner reads it live,
   falling back to the type's configured `maxParallel`.
10. **A serial-pinned type refuses a concurrency override** (`search_embed_missing`), rather than
    accepting a value it will not honour, and is surfaced as a `serial` pill rather than a disabled
    input.
11. **The global `orchestrationMaxConcurrent` cap still bounds the sum** when several types each
    have a raised per-type concurrency.
12. **Auto-apply on explicit pick; badge + undo; background fetch never writes** (D2 as amended
    by SE WP-8) — an explicit catalog pick applies `model.capabilities` immediately (via the same
    path Accept always used, including the `undefined`-vs-`[]` distinction), a background or lazy
    fetch never does, and the per-field probe-accepted badge plus Reset is the undo affordance.
13. **Accept then Reset restores user-entered state** and the row reports which values are
    probe-derived.
14. **A probe failure leaves manual entry fully functional** — the id field still accepts free text.
15. **The catalog is cached to settings and only cleared explicitly** — a second render does not
    re-fetch.
16. **CLI provider kinds reject `listModels`** through `requireCapability`.
17. **Vault isolation** — the reproduction above, asserting vault A survives B's upsert *and* B's
    reset.
18. **The PK migration is lossless** — a schema-4 fixture with populated chunks migrates with every
    row and its FTS entry intact.
19. **A pre-existing single-vault index is unaffected** by the migration — no re-index triggered,
    coverage still satisfied.

Manual verification: cancel a live long-running search rebuild and confirm it stops within one batch;
clear a queue holding a rebuild's worth of job files; probe against LM Studio, ollama and Infinity,
confirming Infinity degrades to manual cleanly; a restore-from-snapshot rehearsal before WP-E's
migration touches the live index; and confirmation that search returns after the container rebuild.

## Assumptions

1. **Obsidian's `requestUrl` cannot be aborted** (no `signal` in `RequestUrlParam`, zero `fetch()`
   callers in `src/`). Cancellation is cooperative and bounded by the longest in-flight request. If
   this changes, or the search client moves to `fetch`, true mid-request cancellation becomes
   available for that client only.
2. **Cross-encoder vs bi-encoder cannot be determined from server metadata.** The heuristic warns; it
   must never gate, and Accept must never silently set `rerank` over `embedding` or vice versa.
3. **Chunk ids are currently globally unique**, which is what makes WP-E's table rebuild lossless. If
   that stops being true before the migration runs, the copy step needs a conflict strategy.
4. **The live index holds one vault.** WP-E fixes a latent bug; it is not repairing existing damage.
   If two vault IDs have ever been indexed against this companion, assess damage before migrating.
5. **Search is expected to be unavailable** between WP-E's plugin update and its container rebuild.
   Accepted per D3.

**Total ≈ 3.25 kSLOC and ~815k worker tokens for WP-A…E, plus ~0.45 kSLOC and ~240k for WP-5's two
stages — ≈ 3.7 kSLOC, ~1.06M worker tokens, before orchestrator review overhead.**
