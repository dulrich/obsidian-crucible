# Semantic Vector Leg + Opt-In Reranker for Crucible Search

*Recommended model/effort — Claude: Opus/high for WP-1, WP-3, WP-7 and orchestration, Sonnet/medium for WP-2, WP-4, WP-5, WP-6; Codex: Sol/medium-high for WP-1, WP-3, WP-7, orchestration, Terra/medium for the rest.*

## Context

The FTS/BM25 search landed and is confirmed good in use ("snappy and returning
expected-plausible results"). What it structurally cannot do is answer a conceptual query —
find notes about *sustained attention* when you wrote *focused awareness*. The questions on the
table were whether the vault is big enough to justify a vector leg, whether the infrastructure
is already there, and — because this ships publicly — whether a SQLite vector extension should
land now rather than later.

**Answers, measured on this box today rather than assumed:**

| Question | Finding |
|---|---|
| Too early vs vault size? | **No.** 5,453 notes / 52,257 chunks. Brute-force KNN over *every* chunk is **13ms at 384d, 24ms at 768d, 33ms at 1024d** (measured, single-threaded JS, `Float32Array` full scan). |
| Is the infrastructure there? | **The plugin half is genuinely done.** `searchSemanticEnabled`, `searchEmbeddingModel` (a `ProviderModelRef` with a settings picker), `embedQuery()`, `attachEmbeddings()`, `embedTexts()` with sub-batching, and `ProviderManager.embed()` for `ollama` / `openai` / `openai-compatible` / `openrouter` all exist and are wired. `SearchManager.indexFiles` already calls `attachEmbeddings` per flush, with failures degrading to FTS-only. |
| So "just need to do it"? | **Half.** The companion **stores** embeddings and **never reads them**. `chunks.embedding_json` is written by `/v1/chunks/upsert` and referenced by no SELECT anywhere. `body.queryEmbedding` is sent by the client and silently dropped. `mode:'fts'`, `semanticAvailable:false` and `vectorAvailable:false` are hardcoded literals. There is no similarity function in the repo. |
| Does enrich's CPU result transfer? | **No — and this is the trap.** `enrich` measured **301 events/s** for `bge-small-en-v1.5`, but over short texts (a title line + a body line). Re-measured against *realistic 1,118-char vault chunks*: **20.1 chunks/s**, i.e. **~43 min** for a full 52,257-chunk backfill. Same model, same CPU, 15× apart purely on sequence length. |
| Was that a single core? | **No — that was 12 threads**, torch's default here (24 logical / 12 physical). Measured scaling: **1 thread 3.8/s, 4 threads 10.3/s, 12 threads 20.1/s**. Only 5.3× from 1→12, so the box is already near saturation and there is no hidden 12× to recover. This is what argues for a purpose-built inference server rather than sentence-transformers or Ollama — see WP-4. |

Intended outcome: hybrid retrieval — the existing weighted-BM25 and title ranks fused with a
third, vector rank — plus an explicitly-invoked reranker that never touches the type-ahead
path, embeddings served by a fleet-managed service rather than a thing you have to remember to
start, honest capability reporting, correct invalidation when the embedding model changes, and
a backfill path that does not require nuking the index.

## Decisions locked

User-confirmed 2026-07-24:

1. **Retrieval is hybrid; reranking is a deliberate action, not a pipeline stage.** The vector
   rank becomes a third list in the existing RRF fusion, which stays fast enough for type-ahead.
   The reranker is built, but behind an explicit button on the search modal — so per-keystroke
   latency is untouched *and* rerank quality becomes directly observable rather than a thing to
   argue about. The QMD writeup in the vault reports reranking is what produced meaningful score
   spread (0.93 vs 0.55 vs 0.47) where its BM25 bunched everything at 0.88–0.89; Crucible's BM25
   is already column-weighted, title-fused and pooled, so it is probably not in that bunched
   regime — the button is how we find out instead of assuming.
2. **No English-only assumption may be baked in.** Crucible ships publicly; `news-ingestion` is
   internal, so its monolingual choice is not transferable. Note the empirical split: *this*
   vault is **100.0% ASCII** (13 of 52,257 chunks carry any non-Latin script, all incidental — a
   GitHub issue thread, two YouTube channel "about" pages), so multilingual buys this user
   nothing personally. It is a **plugin-defaults** requirement, not a vault requirement, and the
   design consequence is architectural rather than a model pick: the vector leg is
   dimension-agnostic and the model stays a setting.
3. **No SQLite vector extension in v1 — but the backend becomes swappable.** Raised
   specifically because this ships publicly and users can have larger vaults. Worked through
   below; the short version is that `sqlite-vec` is itself brute force, so it buys a constant
   factor rather than a complexity class, at the cost of the companion's most load-bearing
   invariant. The scaling answer is a documented ceiling plus a dependency-free escape hatch.

### Why not `sqlite-vec` now — the actual argument

Measured 33ms at 1024d over 52,257 chunks, extrapolated linearly (the scan is exactly linear):

| chunks | ≈ notes | scan | resident |
|---|---|---|---|
| 52,257 (today) | 5,455 | **33ms** | 0.21 GB |
| 100,000 | 10,400 | 63ms | 0.41 GB |
| 250,000 | 26,100 | **158ms** | 1.02 GB |
| 500,000 | 52,200 | 316ms | 2.05 GB |
| 1,000,000 | 104,400 | 631ms | 4.10 GB |

Three things follow.

- **`sqlite-vec` would not change the shape of that table.** Its `vec0` tables do exhaustive KNN;
  ANN indexing (IVF/HNSW) is roadmap, not shipped. What it buys is SIMD and int8/binary
  quantization — a large *constant* factor, not an asymptotic one. Flagged in Assumptions as
  needing verification before anyone acts on it, but if it holds, adopting it now trades the
  companion's single most emphatic invariant (AGENTS.md: dependency-free, one-file `COPY`, no
  npm install) for a constant we can also get for free.
- **The dependency-free-ness is not incidental.** A loadable extension is a
  platform-and-arch-specific `.so`. Inside the pinned `node:24-slim` image that is tractable;
  for the standalone `npm run search:serve` path — which runs on whatever machine a public
  plugin's user has — it is a portability regression, and `node:sqlite` requires opting into
  `allowExtension` besides.
- **The ceiling is generous and the escape hatch is free.** Type-ahead has a 200ms debounce and
  the companion answers a 3-character query in 27ms today; +33ms is invisible, +158ms is not.
  That puts the interactive ceiling around **250k chunks ≈ 26,000 notes**. Past it, the
  dependency-free move is sharding the scan across `node:worker_threads` over a
  `SharedArrayBuffer` (the matrix is already one flat `Float32Array`), which buys roughly the
  same constant factor as SIMD would; and if RAM becomes binding first — it does, around the
  same point — int8 quantization with a float32 rescore of the top ~1000 cuts residency 4×.

So: **isolate vector search behind a narrow module boundary in WP-1** so the backend is a swap
and not a rewrite, document the ceiling with these numbers so the trigger is measured rather
than vibes, and revisit when a real vault crosses it.

## Summary

The model is already a **user setting** (`searchEmbeddingModel: ProviderModelRef`), so no model
is compiled into Crucible — provided the companion stops assuming a dimension. The vector leg
therefore stores whatever width arrives, records the producing model id alongside it, refuses
to mix widths inside a vault, and reports the active dimension through `/health`. `bge-m3`
(1024d, multilingual, 8192-token context) becomes the *documented* recommendation.

Storage moves from `embedding_json TEXT` to a `BLOB` of little-endian float32 plus
`embedding_dim` and `embedding_model` columns. Size is the smaller reason (JSON is ~2.7× the
bytes); the real one is that a BLOB reads straight into a `Float32Array` with zero parse, while
52,257 `JSON.parse` calls on wake would dominate the first query.

Ranking adds one list to `fuseSearchRows`, which already fuses two. The scan covers the full
matrix, not the FTS candidate pool — reranking FTS candidates by vector similarity cannot
surface a note that shares no keywords, which is the entire point.

Inference moves into the compose fleet beside `crucible-search`, so "semantic is off because
the model server isn't running" cannot become the new version of the manual-`npm`-command
problem. One service shape covers both needs: an OpenAI-compatible `/v1/embeddings` endpoint
Crucible already speaks, plus the `/rerank` endpoint WP-5's reranker targets.

## Key Changes

**WP-1 — Companion vector leg, behind a swappable backend seam (~0.45 kSLOC touched, ~260k tokens, ~20 min wall).** Dimension-agnostic vector storage, an in-memory matrix, brute-force cosine KNN, and a third RRF list. Files: `scripts/search-companion.mjs`, `tests/searchCompanionRanking.test.mjs`, `tests/searchCompanionVector.test.mjs` (new). *Model: top (Claude Opus/high; Codex Sol/medium-high) — ranking semantics plus a schema bump. Execution: Claude subagent (0% saving at equal weight — dispatched per subagent-default, for the diff double-check and orchestrator headroom); Codex subagent (same).*

- **Schema v3.** Replace `embedding_json TEXT` with `embedding BLOB`, `embedding_dim INTEGER`,
  `embedding_model TEXT`. Follow the existing additive `PRAGMA table_info(chunks)` ALTER
  precedent used for `content_hash` (`search-companion.mjs:123-126`) rather than a drop/refill —
  and note there is nothing to preserve anyway: `searchSemanticEnabled` has always defaulted
  false, so **zero embeddings exist in the live index today**. Bump `SCHEMA_VERSION` to 3 and
  `SEARCH_REQUIRED_SCHEMA_VERSION` in `src/search/types.ts` **in the same change** — AGENTS.md
  makes that pairing explicit.
- **The swappable seam is a deliverable, not a nicety.** Vector search lands as a small module
  with a narrow contract — build/drop the index, and `knn(queryVec, k) → [{id, score}]` — with
  the JS brute-force implementation behind it. Nothing outside that module may assume a flat
  array or an in-process scan, so a future `vec0` or worker-sharded backend is a swap.
- **Dimension-agnostic, with a hard consistency rule.** `/v1/chunks/upsert` validates that the
  embedding is a finite-numeric array, records its length and the caller-supplied model id, and
  **rejects a vector whose width disagrees with the vault's established width** with a 4xx (not
  a 5xx — the client turns 5xx into `SearchServiceUnavailableError`, which would read as "the
  container is down"). Mixing two vector spaces silently is the failure mode that produces
  confidently wrong rankings with no error anywhere.
- **In-memory matrix, lazily built, explicitly invalidated.** One `Float32Array` of
  `count × dim` plus parallel id/path arrays. Built on first vector search, dropped on any
  upsert/delete touching the vault. 214MB at 1024d — see WP-4 for the memory limit.
- **Brute-force cosine over the full matrix.** Vectors are stored L2-normalised so cosine is a
  dot product. Deliberately **not** `int8`-quantised at this size: measured *slower* in scalar
  JS (19.6ms vs 12.4ms at 384d) with no SIMD path, and the 4× memory saving is not needed yet —
  it is the documented move once residency binds, not now.
- **Third RRF list.** `fuseSearchRows` (`:249-296`) currently fuses `textRank` + `titleRank` at
  `RRF_K = 60`. Add `vectorRank` on the same footing —
  `1/(k+textRank) + titleWeight/(k+titleRank) + vectorWeight/(k+vectorRank)` — and populate
  `scoreVector`, which `src/search/types.ts:74` and `SearchModal.formatScore` already declare and
  render but nothing sets. Add a vector-rank field to `SearchScoreAttribution`.
- **Honest capability flags.** `mode` becomes `'fts' | 'hybrid'` computed from whether a query
  embedding arrived *and* the vault has vectors; `semanticAvailable` and `/health`'s
  `vectorAvailable` become real, reporting the active dimension and model id.
- **The pooling CTE stays `MATERIALIZED`** — AGENTS.md documents that removing it makes
  `bm25()`/`snippet()` throw. The vector leg is a separate query against the matrix, fused in JS;
  do not push cosine into the FTS SQL.

**WP-2 — Client wiring, attribution, and the type-ahead interaction (~0.3 kSLOC touched, ~180k tokens, ~14 min wall).** Consume the new response fields and keep per-keystroke search honest. Files: `src/search/client.ts`, `src/search/types.ts`, `src/search/SearchManager.ts`, `src/search/SearchModal.ts`, `tests/searchClient.test.mjs`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude subagent (40% saving, 108k vs 180k); Codex subagent (50% saving).* Depends on WP-1.

- `normalizeSearchResponse` already reads `scoreVector` and accepts `mode: 'vector'|'hybrid'`
  (`client.ts:202,210`) — wire the new attribution field through and surface the vector
  contribution in the modal's explain line, which is now its own wrapping row.
- **The type-ahead interaction is the real work here.** Search now costs a provider round-trip to
  embed the query *before* the companion call, on every debounced keystroke, and `embedQuery`
  shows a `Notice` on failure — which would fire repeatedly while typing. Cache the query
  embedding by trimmed query string for the life of the modal, and degrade silently to FTS after
  the first notice.
- Existing tests assert `semanticAvailable: false` (`searchClient.test.mjs:49`,
  `searchCompanionRanking.test.mjs:279`); update them to assert the *computed* value, not a
  literal, so the flag cannot silently regress to hardcoded again.

**WP-3 — Embedding lifecycle: model identity and backfill without a reset (~0.35 kSLOC touched, ~200k tokens, ~15 min wall).** The correctness gaps that make "turn semantic on later" quietly wrong. Files: `src/search/SearchManager.ts`, `src/search/client.ts`, `scripts/search-companion.mjs`, `src/orchestration/workflows/SearchIndexWorkflow.ts`, `tests/searchEmbeddingLifecycle.test.mjs` (new). *Model: top (Claude Opus/high; Codex Sol/medium-high) — silent-wrongness class. Execution: Claude subagent (0% saving at equal weight — dispatched per subagent-default); Codex subagent (same).* Depends on WP-1.

- **The content-hash skip means enabling semantic never backfills.** `indexFiles:124` skips any
  file whose `contentHash` matches what the companion holds — so flipping `searchSemanticEnabled`
  on today leaves every already-indexed file permanently vector-less, with no error. Today the
  only fix is `resetIndex()` + full rebuild.
- Extend `/v1/files/state` to report embedding coverage per path (`hasEmbeddings`, plus the model
  id). It currently returns `path/contentHash/mtime/chunkCount` and has no notion of whether a
  path is embedded — so the client cannot even detect the condition.
- Make the skip condition `contentHash matches **and** embedding coverage matches the active
  model`, so an "embed the gaps" pass re-reads only what it must. Add a
  `Orchestrate: Search embed missing` command that enqueues batches for uncovered paths without
  destroying the FTS index — a 40-minute-to-multi-hour job must be resumable and interruptible,
  not all-or-nothing.
- **Changing the embedding model must invalidate.** Nothing today records which model produced a
  vector, so switching models silently mixes incompatible spaces. With `embedding_model` stored
  per chunk (WP-1), a model change makes coverage stale and the same path repairs it.
- `ProviderEmbeddingResult.dimensions` and `ProviderModel.embeddingDimensions` are both
  computed/configurable and both currently discarded — use them to fail fast before sending 500
  chunks.

**WP-4 — Inference as a fleet service, and the memory budget (~0.15 kSLOC touched, ~130k tokens, ~10 min wall).** Files: `/home/_shared_code/context-control/compose.home.yml`, `docker-compose.yml`, `docs/search-companion.md`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude subagent (40% saving, 78k vs 130k); Codex subagent (50% saving).* **Cross-repo — the context-control edit is a separate commit in a separate repo.** Independent of WP-1…WP-3.

- **Why a fleet service and not `ollama pull`.** Ollama here is already systemd-managed and
  active, so this is not literally the old manual-`npm run search:serve` problem — but the
  failure *pattern* is the one to design out: if the model server is down, `attachEmbeddings`
  catches, logs a debug-gated warning, and indexes FTS-only. A multi-hour backfill could complete
  having produced zero vectors, reporting success. Declaring inference beside `crucible-search`
  with `restart: unless-stopped` and a healthcheck removes the failure mode rather than
  documenting it.
- **One service shape covers both needs.** A text-embeddings-inference-style CPU container
  (HF TEI or Infinity) serves an OpenAI-compatible `POST /v1/embeddings` — which Crucible's
  existing `openai-compatible` provider kind already speaks, so **zero plugin changes** — *and*
  `POST /rerank`, which is exactly WP-5's primary backend. Two instances (one embedder, one
  reranker) since these servers host one model each.
- Expect it to be **materially faster than the 20.1 chunks/s** measured through
  sentence-transformers: purpose-built servers use ONNX/candle backends with dynamic batching and
  saturate CPU far better than the 5.3×-at-12-threads scaling measured above. Treat that as the
  hypothesis WP-7's sample run tests, not as a promise.
- **`mem_limit: 512m` is the one hard blocker for the vector leg.** It appears twice —
  `docker-compose.yml:15` and `compose.home.yml:373` (the live container, which builds from this
  repo but is *defined* in context-control). A 214MB matrix plus Node baseline plus SQLite page
  cache does not fit. Raise both to 1g.
- Keep loopback binds. The companion's API is unauthenticated with full index write access, and
  AGENTS.md is explicit that the loopback default is the entire security boundary; new inference
  ports inherit that rule.

**WP-5 — Opt-in reranker: provider seam + modal action (~0.4 kSLOC touched, ~220k tokens, ~17 min wall).** A `rerank?()` provider capability and an explicit button that reorders the current result set, never the type-ahead path. Files: `src/providers/shared.ts`, `src/providers/openaiCompatible.ts`, `src/providers.ts`, `src/types.ts`, `src/search/SearchManager.ts`, `src/search/SearchModal.ts`, `src/settings/sections/orchestration.ts`, `styles.css`, `tests/providerRerank.test.mjs` (new). *Model: mid (Claude Sonnet/medium; Codex Terra/medium) — a new capability on an established seam. Execution: Claude subagent (40% saving, 132k vs 220k); Codex subagent (50% saving).* Depends on WP-2 (modal rendering + generation counter) and WP-4 (a server that answers `/rerank`).

- **Follow the `embed?()` precedent exactly.** `HttpProviderClient` (`src/providers/shared.ts:15-19`)
  already models optional capabilities as optional methods, with `ProviderManager` producing a
  precise "not supported by this provider kind" error (`src/providers.ts:79-92`). Add
  `rerank?(ctx, query, documents): Promise<ProviderRerankResult>` the same way. Do **not** invent
  a parallel dispatch mechanism.
- **Primary backend: `POST {baseUrl}/rerank`** on the `openai-compatible` kind, taking
  `{model, query, documents}` and returning `{results:[{index, relevance_score}]}`. Reuses
  `apiBaseUrl()` and the existing optional-API-key handling, so WP-4's local no-auth server works
  unchanged.
- **Fallback backend: LLM-as-reranker via the existing `complete()` path**, so a provider with no
  `/rerank` endpoint (plain Ollama, which serves `qwen3.5` today) is still testable. Scores
  candidates in one structured call. Slower and fuzzier — label it as such in the UI rather than
  pretending the backends are equivalent.
- **The button is the whole point.** A `Rerank` action enabled once results exist, operating on
  the already-fused top-N (default 30, settable). It must:
  - never fire from the `input` handler — only from the button, so the 200ms debounce and the
    3-character gate are untouched;
  - show a pending state, because this is a multi-hundred-ms to multi-second operation;
  - be discarded by the generation counter if newer typing has replaced the result set;
  - render **before/after position** per row (e.g. `#7 → #2`) plus the reranker's own score, so
    "does reranking actually help this corpus?" is answered by looking. This is the WP's
    acceptance criterion.
- Settings: a reranker `ProviderModelRef` picker mirroring the embedding-model picker
  (`orchestration.ts:271-291`), a top-N control, and an enable toggle defaulting **off** — absent
  a configured reranker the button stays hidden rather than erroring.

**WP-6 — Docs and the recorded decisions (~0.1 kSLOC touched, ~80k tokens, ~6 min wall).** Files: `docs/search-companion.md`, `docs/gbrain-evaluation.md`, `AGENTS.md`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude subagent (40% saving, 48k vs 80k); Codex subagent (50% saving).* Depends on WP-1 and WP-5 for final behaviour.

- `docs/search-companion.md:37` says "does not rank with vectors yet. A future `sqlite-vec`
  implementation should keep the same endpoints" — rewrite it with the measured answer: at this
  corpus size no extension is needed, the ceiling is ~250k chunks, and the escape hatches are
  worker sharding then quantization, in that order.
- `docs/gbrain-evaluation.md:138-143` names "semantic search stops being optional" as its revisit
  trigger; record that it fired, what was adopted (third RRF list, reranker seam) and what still
  is not (pgvector, HNSW, query expansion, the synthesis cycle).
- New AGENTS.md quirk covering: the dimension-agnostic contract and why; the measured KNN and
  backfill numbers including the 12-thread caveat and the 15× sequence-length gap that makes
  `enrich`'s 301/s non-transferable; why `int8` is not used *yet*; and why the scan is
  full-corpus rather than pool-reranking (the one mistake that passes every other test).
- Document `bge-m3` as the recommended default (1024d, multilingual, 8192-token context — our
  1,800-char chunks never truncate), with `nomic-embed-text` (768d) and `bge-small-en-v1.5`
  (384d) as cheaper monolingual options.

**WP-7 — Sample bake-off, then the backfill run (~0.05 kSLOC touched, ~120k tokens, ~9 min wall + hours of index run).** Files: operational; verification only. *Model: top (Claude Opus/high; Codex Sol/medium-high). Execution: Claude **direct** — `must-direct:` final integration, gates and commit duty, and the run must be driven from live Obsidian and observed there; Codex **direct** (same).* Depends on WP-1…WP-6.

- **Embed a bounded sample first (~500 notes), not the whole vault.** `bge-m3` is ~568M
  parameters against `bge-small`'s 33M — roughly 14× the encoder compute — so the measured
  20.1 chunks/s could fall to low single digits, turning ~43 min into most of a working day.
  WP-4's inference server may claw much of that back. **Both directions are estimates**; the
  sample converts them into a number before an overnight job is committed to.
- Judge the sample on real conceptual queries the user writes — the ones BM25 currently fails —
  and use the rerank button on those same queries to decide whether reranking earns its latency.
  If neither visibly improves recall, that is the signal to stop, and it is cheaper to learn at
  500 notes than at 5,453.
- Then run the full pass via `Orchestrate: Search embed missing`, watch the queue drain, and
  verify: chunks-with-embeddings == chunks total, one distinct `embedding_dim`, one distinct
  `embedding_model`, `/health` reporting `vectorAvailable: true` with the right dimension, and a
  hybrid query returning `mode: 'hybrid'` with a populated `scoreVector`.
- **Remind the user to run `npm run dev`** before UI work begins, and stop it before the gates.

## Public Interfaces

| Surface | Change |
|---|---|
| `chunks.embedding_json TEXT` | **Replaced** by `embedding BLOB` + `embedding_dim INTEGER` + `embedding_model TEXT` |
| `SCHEMA_VERSION` / `SEARCH_REQUIRED_SCHEMA_VERSION` | 2 → **3**, bumped together |
| `POST /v1/chunks/upsert` | Validates embedding width + numerics; **4xx** on a width conflict within a vault |
| `POST /v1/search` | `queryEmbedding` is now **read**; `mode` becomes computed `'fts'\|'hybrid'`; `scoreVector` populated; attribution gains a vector rank |
| `POST /v1/files/state` | Adds embedding coverage (`hasEmbeddings`, `embeddingModel`) per path |
| `GET /health` | `vectorAvailable` becomes real; adds active `embeddingDim` / `embeddingModel` |
| `HttpProviderClient.rerank?()` | **New** optional capability mirroring `embed?()`; `openai-compatible` hits `POST {baseUrl}/rerank`, others fall back to `complete()` |
| `searchRerankEnabled` / `searchRerankModel` / `searchRerankTopN` | **New** settings; enabled defaults **false** |
| `Orchestrate: Search embed missing` | **New** command — backfills vectors without resetting the FTS index |
| compose fleet | **New** `crucible-embed` + `crucible-rerank` services, loopback-bound; `crucible-search` `mem_limit` 512m → **1g** |

No breaking changes to stored plugin settings. `searchSemanticEnabled` stays default-**false**;
turning it on is a deliberate act with a backfill cost attached.

## Execution

```
WP-1 (companion vector leg) ──┬──► WP-2 (client wiring) ──┬──► WP-5 (reranker + button) ──┐
                              └──► WP-3 (embedding lifecycle) ──────────────────────────────┤
WP-4 (fleet inference + memory) ───────────────────────────┘                                ├──► WP-7 (bake-off + backfill, direct, last)
WP-6 (docs) ────────────────────────────────────────────────────────────────────────────────┘
```

- **WP-1 is the shared core and must land green before WP-2 or WP-3 start** — both consume its
  response shape and schema.
- **WP-4 can start immediately, in parallel with WP-1** — different repos, no code dependency —
  and it must land before WP-5 can be exercised against a real `/rerank`.
- **WP-2 and WP-3 have disjoint file scopes** apart from `SearchManager.ts` and `client.ts`;
  WP-3 owns the lifecycle/coverage functions, WP-2 the search/modal path. Check region overlap
  before dispatching in parallel, or serialise WP-3 after WP-2.
- **WP-5 must follow WP-2**, not run beside it — both edit `SearchModal.ts`, and WP-5's
  before/after rendering builds on WP-2's attribution row and generation counter.
- **WP-7 is orchestrator-direct and last.** Subagents never commit; the orchestrator reviews each
  diff, re-runs the gates verbatim, and commits per WP.
- **The context-control compose edit is a second repo's commit** and must not be bundled into a
  Crucible commit.

## Test Plan / Verification

**Gates (mandatory Full Cleanup Loop — run sequentially, never backgrounded, after every WP):**

```bash
npm run lint                     # ESLint + Stylelint, zero errors
npx tsc -noEmit -skipLibCheck    # zero TypeScript errors
npm test                         # baseline is 344/344 before this plan
node esbuild.config.mjs production
grep -rna "console\." src/       # must match ONLY src/log.ts  (-a is load-bearing)
```

**Unit tests that must exist:**

1. **Cosine correctness** — a hand-computed similarity for 3 short vectors, asserted exactly.
   Catches a transposed index or a normalisation slip, which otherwise degrade silently.
2. **Full-scan, not pool-rerank** — a chunk with *zero* keyword overlap but a near-identical
   vector must appear in results. This is the single test that proves the feature works at all;
   a pool-reranking implementation passes every other test and fails only this one.
3. **Dimension conflict is rejected** — a 768d vector into a 384d vault returns 4xx, specifically
   **not** 5xx (a 5xx is indistinguishable from a down container client-side).
4. **RRF three-list fusion** — with known text and vector ranks, the fused order matches
   hand-computed `1/(k+r)` arithmetic. Assert in a test, not in prose.
5. **Vector absence degrades, never fails** — a vault with no embeddings, and a search with no
   `queryEmbedding`, both return `mode: 'fts'` and the exact pre-change ordering.
6. **BLOB round-trip** — write a `Float32Array`, read it back bit-identical, including a negative
   and a denormal.
7. **Coverage detection** — `/v1/files/state` reports a path indexed-but-unembedded, and the skip
   logic re-indexes it while leaving fully-covered paths alone.
8. **Model change invalidates** — same content hash, different `embedding_model`, must not be
   skipped.
9. **`semanticAvailable` / `mode` are computed** — asserted from state, not against a literal.
10. **Rerank is never on the type-ahead path** — assert the `input` handler cannot reach the
    rerank call, and that a rerank resolving after a newer search is discarded by the generation
    counter. This guards the whole "preserve type-ahead" premise.
11. **Rerank response mapping** — a `/rerank` payload with out-of-order `index` values reorders
    the right documents; a provider without `rerank()` routes to the `complete()` fallback; a
    provider with neither yields the precise unsupported-capability error rather than a crash.

**Manual verification in Obsidian:**

- A conceptual query with no keyword overlap ("what did I write about staying focused under
  pressure") returns notes BM25 alone misses; the explain line shows the vector rank contributing.
- Type-ahead still feels immediate with semantic on — the query-embedding hop must not
  reintroduce the lag the 3-character gate was built to avoid.
- A pure keyword query (`crucible`) returns the same top results as today: adding a vector list
  must not *degrade* the ranking just confirmed as good.
- **Rerank button**: results reorder, each row shows its before/after position, and typing again
  while a rerank is in flight discards it cleanly rather than reordering the new results.
- Stopping the embed container degrades to FTS with one notice, not a notice per keystroke — and
  a backfill started against a stopped embedder **refuses to run** rather than silently producing
  FTS-only chunks.
- `/health` reports the real dimension and model.

## Critical Files

| Path | Role |
|---|---|
| `scripts/search-companion.mjs` | Schema (`:106-121`), `SCHEMA_VERSION` (`:21`), search SQL (`:70-100`), `runSearch` (`:298-317`), `fuseSearchRows` (`:249-296`, two-list today), `/v1/search` (`:456-476`, drops `queryEmbedding`), `/v1/chunks/upsert` (`:411-455`), `/health` (`:361`) |
| `src/search/SearchManager.ts` | `embedQuery` (`:291-302`), `attachEmbeddings` (`:278-289`), `embedTexts` (`:304-316`), the flush hook (`:102-112`), the hash skip (`:124`) |
| `src/search/types.ts` | `SearchChunk.embedding` (`:32`), `SEARCH_REQUIRED_SCHEMA_VERSION` (`:40`), `SearchHealth.vectorAvailable` (`:46`), `SearchScoreAttribution` (`:54-62`, no vector field), `SearchResult.scoreVector` (`:74`, never set) |
| `src/search/client.ts` | `search()` body (`:79-85`), `normalizeSearchResponse` (`:186-215`), the two timeouts (`:18`, `:30`) |
| `src/providers/shared.ts` | `HttpProviderClient` (`:15-19`) — the optional-capability seam `rerank?()` must follow |
| `src/providers/{openaiCompatible,ollama}.ts` | The only two `embed()` implementations (`:85-104`, `:45-67`); `apiBaseUrl` (`:36-43`) |
| `src/search/SearchModal.ts` | Result rendering, the explain row, and the `searchGeneration` counter the rerank action must respect |
| `src/orchestration/workflows/SearchIndexWorkflow.ts` | `SEARCH_REBUILD_BATCH_FILES = 100` (`:26`), rebuild/upsert workflows, the 30s deferral |
| `docker-compose.yml` + `context-control/compose.home.yml` | `mem_limit: 512m` at `:15` and `:373`; where the inference services land |

## Assumptions

1. ~~**`sqlite-vec`'s `vec0` is exhaustive KNN, not ANN.**~~ **VERIFIED 2026-07-24, upstream.**
   sqlite-vec is at `0.1.10-alpha.4` and `vec0` is brute-force only; upstream's own docs say it
   "slows down on large datasets (>1M with large dimensions)". ANN is tracked in
   [asg017/sqlite-vec#25](https://github.com/asg017/sqlite-vec/issues/25) and **not released**.
   So the deferral argument holds as written. **Revisit trigger:** upstream states a first
   DiskANN release is "coming very soon" — when it ships, the calculus changes (ANN *is* a
   complexity-class change) and the extension belongs back on the table, weighed against the
   dependency-free invariant. Until then this decision stands on measurement, not preference.
2. **The interactive ceiling is ~250k chunks (~26k notes)**, from linear extrapolation of a
   measured 33ms at 52,257. Linear is the right model for a full scan, but it has not been
   measured at scale.
3. **The dimension-agnostic contract is what satisfies "no English-only assumption."** The model
   is already a user setting; the risk was the *companion* assuming a width.
4. **`bge-m3` throughput is extrapolated, not measured** (~14× `bge-small`'s encoder compute by
   parameter count), and WP-4's inference server may claw much of that back. Both directions are
   guesses until WP-7's sample run.
5. **TEI/Infinity serve both `/v1/embeddings` (OpenAI-compatible) and `/rerank` from one CPU
   image, and support `bge-m3`.** Unverified here — no image was pulled. If it does not hold, the
   fallback is Ollama for embeddings plus WP-5's `complete()` reranker, which is why that
   fallback exists from day one rather than as a later addition.
6. **`POST /rerank` with `{model, query, documents}` → `{results:[{index, relevance_score}]}`** is
   a de-facto convention, not a standard, and is unverified against a live server here.
7. **L2-normalised vectors** so cosine is a dot product. Both provider clients return whatever
   the model produced; normalisation must be asserted or applied companion-side, not trusted.
8. **The in-memory matrix is rebuilt, not incrementally patched, on upsert.** Simpler and
   correct; if a full rebuild proves slow *during* an active backfill the fallback is incremental
   append — deliberately not built up front.
9. **`_resources/` is already absent from the index** (0 chunks), so the excluded-files change
   committed earlier needs no rebuild to purge anything — verified, not assumed.

**Total ≈ 1.75 kSLOC, ~1,190k raw tokens; ~734k Claude-path / ~615k Codex-path Opus/Sol-equivalent tokens.**
