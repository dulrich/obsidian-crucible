# Embedding-Space Identity + Local Runtime Bake-Off, distilled into a Local Inference Guide

*Recommended model/effort — Claude: Opus/high for WP-2 and WP-4, Sonnet/medium for WP-1, WP-3, WP-5; Codex: Sol/medium-high for WP-2 and WP-4, Terra/medium for the rest.*

## Context

The semantic vector leg shipped and its backfill is 10.4% done (5,449 chunks, `BAAI/bge-m3`
1024d, produced by the Infinity CPU container via ONNX fp32). Two things then happened that this
plan responds to.

**First, a correctness gap surfaced.** Evaluating a GPU route raised the question of what happens
when a *different engine* serves the *same model name* at a *different quantization*. The answer
is that Crucible cannot currently tell, and nothing anywhere errors:

- `SearchChunk.embeddingModel` records the requested model id string only — `bge-m3` — stamped
  from settings at `src/search/SearchManager.ts:495`, never verified against what the server ran.
- `embeddingCoverageSatisfied` (`src/search/SearchManager.ts:337-342`) compares that string for
  equality, so an ONNX-fp32 index and a GGUF-Q4 re-index look identical and **no re-embed fires**.
- The upsert guards are **width-only** (`scripts/search-companion.mjs:898-912`). `bge-m3` is 1024d
  under every quantization, so the guard passes.
- **The vector scan does not filter by model at all.** `selectVectors`
  (`scripts/search-companion.mjs:294-296`) projects `id, path, embedding, embedding_dim` —
  `embedding_model` is not even in the query. Two same-width spaces in one vault load into **one
  matrix** and get cosine-scored against each other, with `stats.model` reporting whichever has
  more rows.

The design comment at `src/search/types.ts:71-73` is not wrong, and this plan keeps its principle:
*"vector-space compatibility is a property of the model weights"*, so moving `bge-m3` between
hosts must **not** force a re-embed. What it missed is that **numeric precision is part of the
weights identity** — fp32 ONNX and Q4 GGUF are not the same weights even though the model *name*
is identical. The fix records an identity that captures what actually determines the vector space;
it does not abandon the principle.

**Second, the GPU question resolved in an unexpected direction.** ROCm is blocked: the newest
published AMD Infinity image is torch `2.5.1+rocm6.2`, whose arch list stops at
`gfx1100`/`gfx942`, and this box is gfx1201 (RX 9070, RDNA4), needing ROCm 6.4+. But **Vulkan is
not blocked** — RADV drives gfx1201 today, and LM Studio is already installed here with six Vulkan
llama.cpp backends and a user-confirmed record of stable inference on this GPU. The hang class
that cost a reboot during this investigation traces to *invalid GPU programs* (an
`HSA_OVERRIDE_GFX_VERSION` masquerade; separately, in-development render passes and shaders), not
to mature inference kernels.

Intended outcome: make two vector spaces impossible to mix silently, establish **by measurement**
whether the local GPU runtimes are actually a different space from the CPU one, and distil the
pathway into a **local embeddings/reranking guide** shipped with the plugin — the deliverable that
outlives this machine, since Crucible ships publicly and every user faces the same runtime choice.

## Decisions locked

User-confirmed 2026-07-25:

1. **Test both runtimes and compare** — LM Studio and ollama, rather than picking one up front.
   LM Studio is the safer prior (installed, Vulkan backends present, proven stable here, already
   supported through the existing `openai-compatible` provider kind). ollama needs
   `OLLAMA_VULKAN=1` on its unit and uses the separate `ollama` kind, but is systemd-managed and
   always-on, and its `/api/tags` self-reports `quantization_level`. Comparing both is what makes
   the guide credible.
2. **F16, not Q8_0 or Q4_K_M.** Embedding models lose measurably more to aggressive quantization
   than chat models do. F16 keeps the comparison honest: a poor result then means "this runtime is
   bad", not "4-bit is bad" — a confound that would make the bake-off uninterpretable.
3. **The deliverable is a user-facing guide**, not just a fix. This trajectory is the pathway
   test; its findings get distilled into plugin documentation.

## Summary

Add a distinct **embedding space** identity, kept deliberately *separate* from `embeddingModel`
because the two answer different questions — "is this the same vector space?" versus "which
weights family is this?". The companion stores it, guards against mixing it within a vault exactly
as it already guards width, and — the load-bearing fix — **filters the vector scan by it**.

**Derive the space id by probing the runtime rather than asking the user, where the runtime can
answer.** Verified 2026-07-25 against the live services:

| Runtime | Probe | Quantization | Rerank |
|---|---|---|---|
| **ollama** | `/api/tags`, `/api/show` | **Yes** — `details.quantization_level`, `details.format`, `model_info['general.file_type']`, plus a **`digest`** (sha256 of the weights blob) | No endpoint |
| **LM Studio** | **`/api/v0/models`** (native) — `/v1/models` returns id + `owned_by` only | **Yes** — `quant`, plus `type` (`llm`/`vlm`/`embeddings`), `arch`, `state`, `max_context_length` | **No** — `/v1/rerank` and `/api/v0/rerank` both reject |
| **Infinity** | `/v1/models` | **No** — only `backend` (`optimum`/`torch`) and `capabilities` | **Yes** — native `/rerank`, the only local one |

Two consequences shape the design. First, **the model id string cannot be trusted to carry the
quantization**: LM Studio indexes each model under ~8 aliases, some with `@q4_k_m` and some
without, so the natural thing to configure is a quant-free alias whose underlying file can be
swapped invisibly. Second, **ollama's `digest` must not be the space key** — it is the strongest
identity available, but keying on it would force a full re-embed whenever the same weights move
between hosts, which is precisely what the `src/search/types.ts:71-73` principle forbids.

So: the **key** is portable — `modelId` plus a normalized precision tag (`fp32`, `f16`, `q4_k_m`),
derived from the probe when available and falling back to a user-declared variant for runtimes
like Infinity that cannot self-report. The **fingerprint** (digest, backend, served id) is stored
separately as evidence, for drift detection and diagnosis rather than for matching. Unknown
precision degrades to today's exact behaviour — the bare model id — so nothing existing re-embeds.

**A second, worse hazard surfaced during planning, and it is not about quantization at all.**
LM Studio serves cross-encoder rerankers through `/v1/embeddings` as though they were embedding
models. Verified live:

| Model as LM Studio names it | `type` | Returns |
|---|---|---|
| `text-embedding-bge-reranker-v2-m3` | `embeddings` | **1024-d, L2-norm 1.000000** |
| `text-embedding-bge-reranker-base` | `embeddings` | **768-d, L2-norm 1.000000** |

1024d is exactly `bge-m3`'s width, and 768d is exactly `nomic-embed-text`'s. A cross-encoder's
pooled output is not a sentence embedding — it is not trained for cosine similarity in a shared
space — yet **every guard passes**: the width matches, the vector is already normalized, the id
begins `text-embedding-`, and LM Studio itself reports `type: embeddings`.

Measured on one query against two relevant and two irrelevant documents:

| | `bge-m3` (bi-encoder) | `bge-reranker-v2-m3` as embedder |
|---|---|---|
| relevant | **0.7593** | 0.9896 |
| related | **0.7220** | **0.8477** — ranks *below both irrelevant docs* |
| irrelevant (bread recipe) | 0.3599 | 0.9715 |
| irrelevant (arctic terns) | 0.2418 | 0.9815 |
| **discrimination margin** | **0.3994** | **0.0080** |

Everything bunches at 0.85–0.99 with no usable signal, and the ordering is not merely weak but
partly **inverted** — the genuinely on-topic document scores lower than arctic tern migration. A
user who picks this model indexes the whole vault with vectors that cannot rank, and sees no error
anywhere. This is a *worse* failure than the quantization case and shares its exact shape, which
is what makes the space-identity work worth doing properly rather than minimally.

Structural mitigation already exists: the **Rerank capability flag** keeps a model marked Rerank
out of the embedding picker. But LM Studio's `text-embedding-` prefix actively encourages the
wrong flag, so WP-2 should additionally warn when a model whose metadata or id suggests a
cross-encoder is selected as the embedding model, and WP-5 must document it prominently.

**On Infinity's continued role**, since its inability to report precision is what forces the
fallback to exist at all. The two roles separate cleanly:

- **As the reranker it is currently irreplaceable locally.** Neither LM Studio nor ollama exposes
  a rerank endpoint; without Infinity the only option is WP-5's LLM-as-reranker via `complete()`,
  which is explicitly slower and fuzzier. It stays.
- **As the embedder it is contested, and WP-4 decides it rather than this plan.** It is CPU-only
  here, the slowest path, and the sole reason the manual-variant fallback gets exercised on this
  box. Its one real advantage is fp32 — no quantization loss — which is exactly what WP-1
  measures. If F16 GGUF agrees with fp32 above ~0.999, that advantage is gone.

Note that dropping Infinity as embedder would **not** remove the manual fallback: Crucible ships
publicly and users run vLLM, TEI and plain llama.cpp servers, many of which report no precision
either. The fallback is a public-distribution requirement, not an Infinity workaround — which is
why the design does not depend on which embedder this box ends up using.

Before fixing the default granularity, **measure**. Embed an identical sample through
Infinity/ONNX-fp32, LM Studio/GGUF-F16 and ollama/GGUF-F16, then compute pairwise cosine agreement
and rank overlap. If F16 GGUF and fp32 ONNX agree above 0.999 they are the same space in practice
and the guide can say so with evidence; if they diverge, that is the concrete justification for
the variant tag. Either way the *mechanism* is needed, because Q4 certainly diverges — the
measurement calibrates policy, not existence.

Isolation for the experiment is a **second companion instance on a second database file**, not a
second `vaultId`: exploration found a scratch vaultId would silently destroy the live index
(Assumption 1) — a trap worth knowing independently of this plan.

## Key Changes

**WP-1 — Snapshot the index, then measure cross-runtime vector agreement (~0.25 kSLOC touched, ~150k tokens, ~12 min wall).** Safety first, then the evidence the schema decision rests on. Files: `scripts/search-snapshot.sh` (new), `scripts/embedding-agreement.mjs` (new), `package.json`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude subagent (110k vs 150k, 27% saving); Codex subagent (95k vs 150k, 37%).* No dependencies — start immediately.

- **Snapshot first.** The database is WAL-mode (`scripts/search-companion.mjs:119`), so a plain
  `cp` silently omits the 29MB WAL and yields a stale or corrupt copy. Use `VACUUM INTO '/tmp/…'`
  inside the container — atomic, consistent, self-contained, compacting, no downtime — then
  `docker cp` it out. Document the restore path, where deleting the stale `-wal`/`-shm` beside the
  restored file is the load-bearing step. Target the **actual** volume:
  `context-control_crucible-search-data` (the fleet project's), not the repo compose file's
  `crucible-search-data`, which does not exist.
- **Then measure.** A standalone script that draws N sample chunks from the real index (so texts
  are representative — ~200 at the measured ~1,118-char mean), embeds them through each configured
  runtime, and reports mean/min pairwise cosine between runtimes for the same text, the
  distribution's tail, and top-k rank overlap for a handful of queries. **Report the minimum, not
  just the mean** — a mean of 0.999 with a 0.94 tail means specific content types diverge, which
  surfaces later as "search got weird for code notes".
- Diagnostic tooling, not plugin code: keep it out of `src/`. The `console.*` ban applies only to
  `src/` outside `src/log.ts`, so `console` is fine here.

**WP-2 — Runtime probe: ask the server what it actually loaded (~0.3 kSLOC touched, ~170k tokens, ~13 min wall).** A provider-layer capability that turns "what is this runtime serving?" into a normalized answer. Files: `src/providers/shared.ts`, `src/providers/openaiCompatible.ts`, `src/providers/ollama.ts`, `src/providers.ts`, `src/types.ts`, `tests/providerModelProbe.test.mjs` (new). *Model: mid (Claude Sonnet/medium; Codex Terra/medium) — a new capability on the established optional-method seam. Execution: Claude subagent (122k vs 170k, 40% saving); Codex subagent (105k vs 170k, 50%).* No dependencies; WP-3 consumes it.

- **Follow the `embed?()` / `rerank?()` precedent exactly** — a new optional method on
  `HttpProviderClient` (`src/providers/shared.ts:12-19`), dispatched through
  `requireCapability` so "not supported" stays a missing-method check. Widen
  `OptionalHttpCapability` and add the `CLI_UNSUPPORTED_VERB` entry; do not invent a parallel
  mechanism.
- Returns a normalized `{ servedModel?, precision?, fingerprint? }`. **`precision` is the
  portable part** (`fp32` | `f16` | `bf16` | `q8_0` | `q4_k_m` | …); `fingerprint` is the
  strongest host-specific identity available and is evidence only.
- **ollama**: `/api/tags` gives `details.quantization_level`, `details.format` and `digest`;
  `/api/show` adds `model_info['general.file_type']`. The codebase currently calls **neither**
  endpoint — only `/api/embed`.
- **openai-compatible**: try LM Studio's native `/api/v0/models` first — verified live to return
  `quant`, `type`, `arch`, `state` and `max_context_length` — and fall back to `/v1/models`, which
  on LM Studio carries only `id` and `owned_by` and is therefore useless for precision. Infinity
  answers `/v1/models` with `backend` but no dtype, so precision comes back `undefined`, which
  must be a clean "unknown" and never a guess.
- **Probe capability by response body, not status code.** LM Studio answers unknown endpoints with
  **HTTP 200** and `{"error":"Unexpected endpoint or method. (POST /x)"}` in the body, so a
  status-code check would report every capability as present. This is how `/v1/rerank` was
  initially mistaken for supported during planning.
- **Warn when a cross-encoder is about to be used as an embedder.** LM Studio reports both
  `text-embedding-bge-reranker-*` models as `type: embeddings`, and they return correctly-shaped,
  correctly-normalized vectors at 1024d/768d — colliding exactly with `bge-m3`/`nomic-embed-text`.
  No structural field distinguishes cross-encoder from bi-encoder, so the check is necessarily a
  heuristic (id or `arch` suggesting a reranker) and must therefore **warn, never block** — but a
  warning is enormously better than the current silence, since the failure is otherwise invisible
  until retrieval quality is inspected by hand.
- **Also stop discarding the response's own `model` field**: the cast at
  `src/providers/openaiCompatible.ts:98` names only `data`, dropping the top-level `model` that
  for LM Studio/Infinity/vLLM identifies the *actually loaded* model; `src/providers/ollama.ts:57`
  drops its echoed `model` the same way. Add `servedModel?` to `ProviderEmbeddingResult` and warn
  **once per session** on disagreement — a warning, not an error, since servers legitimately
  return resolved or dated ids, but silent disagreement is how you get an index you cannot explain.
- Probe results must be **cached per provider+model for the session** — this runs on the indexing
  path and must not add a round-trip per batch.

**WP-3 — Embedding-space identity: store it, guard it, filter the scan by it (~0.45 kSLOC touched, ~260k tokens, ~20 min wall).** The correctness fix. Files: `scripts/search-companion.mjs`, `src/search/types.ts`, `src/search/SearchManager.ts`, `src/search/client.ts`, `src/types.ts`, `src/settings/sections/ai.ts`, `tests/searchEmbeddingSpace.test.mjs` (new). *Model: top (Claude Opus/high; Codex Sol/medium-high) — silent-wrongness class, and it changes a persisted contract. Execution: Claude subagent (280k vs 260k — a 0% saving at equal weight, dispatched per subagent-default for the diff double-check and orchestrator headroom); Codex subagent (same).* Depends on WP-2 for probe-derived precision, and on WP-1's measurement for the default-granularity call.

- **Schema v4** — one additive `ALTER TABLE chunks ADD COLUMN embedding_space TEXT`, following the
  `PRAGMA table_info` precedent at `scripts/search-companion.mjs:145-151`. Bump `SCHEMA_VERSION`
  and `SEARCH_REQUIRED_SCHEMA_VERSION` **together**, per the standing rule.
- **Migrate by backfilling `embedding_space = embedding_model` for existing rows.** This is what
  makes the change free: the 5,449 embedded chunks get a space id identical to today's semantics,
  and with the client's default space also being the bare model id, coverage matches and **nothing
  re-embeds**. This is the "tag in place" requested, and it needs no separate command — one
  `UPDATE … WHERE embedding_space IS NULL AND embedding IS NOT NULL` in the migration.
- **Client-side space id**, in precedence order: WP-2's probed `precision` → a user-declared
  `ProviderModel.embeddingVariant?: string` → nothing. Active space is
  `precision ? modelId + '/' + precision : modelId`. Falling through to the bare model id
  preserves the `src/search/types.ts:71-73` principle — same weights on a different host stays one
  space — and is also what makes the migration free. The manual variant is the **fallback for
  runtimes that cannot self-report** (Infinity), not the primary mechanism; surface it in the
  model row in `src/settings/sections/ai.ts` beside `embeddingDimensions`, labelled as such.
- **Normalize precision before it becomes a key.** `Q4_K_M`, `q4_k_m` and file_type `15` must all
  produce one token, or the same weights served by two runtimes would split into two spaces and
  force a re-embed — the exact failure the portable-key design exists to avoid.
- Store WP-2's `fingerprint` alongside as evidence (not part of the key, not compared for
  coverage), so a mixed or drifted index can be diagnosed after the fact.
- **`embeddingCoverageSatisfied` compares the space**, not the model id, keeping today's three
  fail-closed rules (partial coverage is not coverage; unknown is uncovered; semantic-off removes
  coverage from the condition entirely).
- **Extend the vault-wide upsert guard** from width-only to width-and-space, mirroring
  `selectVaultEmbeddingDim` (`scripts/search-companion.mjs:747`) and throwing the same
  `HttpError(400)` — a 4xx, never a 5xx, because the client turns any 5xx into
  `SearchServiceUnavailableError` and would send the user to restart a healthy container.
- **Filter the vector scan by space — the fix with teeth.** `selectVectors` must project and
  filter `embedding_space`, and `/v1/search` must carry the querying space alongside
  `queryEmbedding`. A vault holding more than one space degrades to FTS with an explanatory
  `outcome.note`, exactly as the query-width mismatch does at `scripts/search-companion.mjs:609-620`
  — never a hard failure of the request.
- Report distinct spaces in `/health`, so a mixed index is visible rather than inferred.

**WP-4 — Runtime bake-off: LM Studio and ollama on Vulkan vs Infinity on CPU (~0.05 kSLOC touched, ~120k tokens, ~9 min wall + run time).** Files: operational; verification only. *Model: top (Claude Opus/high; Codex Sol/medium-high). Execution: Claude **direct** — `must-direct:` live runtimes, GPU-risk judgment, and results needing the user's own eyes on retrieval quality; Codex **direct** (same).* Depends on WP-1 (snapshot + harness) and WP-3 (so the spaces cannot mix).

- **Snapshot before anything else.** WP-1's `VACUUM INTO` copy is the rollback.
- Isolate with a **second companion instance** — same image, `CRUCIBLE_SEARCH_DB=/data/search-b.sqlite`,
  a second port — **not** a second `vaultId` (Assumption 1). The live index is never written by the
  experiment.
- LM Studio: download `bge-m3` GGUF **F16** (the library currently holds only
  `text-embedding-nomic-embed-text-v1.5` at Q4_K_M, which is neither the model nor the precision
  under test), server already running on `127.0.0.1:1234`; add an `openai-compatible` provider at
  `http://127.0.0.1:1234/v1` — the `/v1` is required because the client appends `/embeddings`.
  Confirm via `/api/v0/models` that it reports `type: embeddings` and `quant: F16` once loaded.
- ollama: `OLLAMA_VULKAN=1` on the unit, `ollama pull bge-m3`, verify `quantization_level` via
  `/api/tags`, add an `ollama`-kind provider.
- Measure per runtime: chunks/s at request-batch 96 on realistic ~1,118-char chunks (CPU baseline
  is **5.8 chunks/s**, ~2.3h for the full 52k-chunk vault), VRAM via `rocm-smi`, and agreement
  against WP-1's fp32 baseline.
- **Judge quality on the user's own conceptual queries** — the ones BM25 fails — not synthetic
  ones, and use the Rerank button on the same queries. A run that reorders nothing is a valid and
  useful answer.
- **GPU-risk protocol**: unsaved work closed; if the desktop wedges, recover via
  `systemctl restart lightdm` over SSH or SysRq `S`-`U`-`B` (mask is 176) rather than a hard power
  cycle, and capture `/sys/class/drm/card1/device/devcoredump/data` **before** rebooting — it is
  in-memory only. Detail in `context-control/references/rdna4-gpu-hang.md`.

**WP-5 — The local embeddings & reranking guide (~0.2 kSLOC touched, ~110k tokens, ~8 min wall).** The distilled deliverable. Files: `docs/local-inference.md` (new), `docs/search-companion.md`, `AGENTS.md`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude subagent (86k vs 110k, 22% saving); Codex subagent (75k vs 110k, 32%).* Depends on WP-4's measured results.

- Written for **Crucible users generally**, not this machine: the runtime choice, provider-kind
  mapping, and quantization hazard are universal; the gfx1201 specifics are one worked example.
- Cover four routes with real trade-offs: **Infinity in Docker** (fleet-managed, always-on, CPU),
  **LM Studio** (`openai-compatible`, GPU via Vulkan/ROCm/Metal, GUI-managed), **ollama** (systemd,
  `ollama` kind, needs `OLLAMA_VULKAN=1` for AMD Vulkan), and **hosted APIs**.
- **Lead with the cross-encoder trap**, because it is the one that silently destroys retrieval
  while looking correct: LM Studio lists `text-embedding-bge-reranker-*` as `type: embeddings`,
  they return properly-normalized vectors at 1024d/768d colliding with `bge-m3`/`nomic-embed-text`,
  and the measured discrimination margin is **0.0080 versus 0.3994** for a real bi-encoder, with
  the on-topic document ranking below both irrelevant ones. State plainly: **a reranker is not an
  embedding model**, mark it Rerank rather than Embedding, and rerankers only work through a
  server that exposes a real `/rerank` endpoint.
- Record the traps this trajectory actually hit, each of which cost real time: the engine-flag
  asymmetry (`optimum` needs published ONNX weights; `bge-reranker-v2-m3` ships PyTorch only);
  base-URL asymmetry (embedder needs `/v1`, Infinity's reranker does not);
  `torch.cuda.is_available()` returning `True` on an image with no matching arch, so a bad GPU
  config passes its healthcheck and dies on first use; request-batch size worth **2.3×**
  throughput (24 → 96, capped at 96 in `SearchManager.ts:547`); and the
  same-name-different-quantization vector-space hazard with its concrete symptom.
- State the measured numbers so nobody re-derives them, and cross-link the GPU hang reference
  rather than duplicating it.

## Public Interfaces

| Surface | Change |
|---|---|
| `chunks.embedding_space TEXT` | **New** column; migration backfills from `embedding_model` |
| `SCHEMA_VERSION` / `SEARCH_REQUIRED_SCHEMA_VERSION` | 3 → **4**, bumped together |
| `POST /v1/chunks/upsert` | Accepts per-chunk `embeddingSpace`; vault guard now width **and** space, 4xx on conflict |
| `POST /v1/search` | Accepts `embeddingSpace`; scan filters by it; mixed-space vault degrades to `mode: 'fts'` with a note |
| `POST /v1/files/state` | Reports `embeddingSpace` per path, under the same fail-closed conjunction as `embeddingModel` |
| `GET /health` | Reports distinct embedding spaces present |
| `HttpProviderClient.describeModel?()` | **New** optional capability, mirroring `embed?()`/`rerank?()`; returns `{servedModel?, precision?, fingerprint?}` |
| `ProviderEmbeddingResult.servedModel?` | **New**; evidence only, never the key |
| `ProviderModel.embeddingVariant?` | **New** optional setting — the fallback for runtimes that cannot self-report; empty preserves today's behaviour exactly |
| `npm run search:snapshot` | **New** — `VACUUM INTO` backup of the live index |

No breaking change to stored plugin settings, and **no forced re-embed**: a runtime that reports
no precision and a model with no declared variant yield a space id identical to the current model
id, which the migration also writes to every existing row.

## Execution

```
WP-1 (snapshot + agreement harness) ──┐
                                      ├──► WP-4 (bake-off, direct) ──► WP-5 (the guide)
WP-2 (runtime probe) ──► WP-3 (embedding-space identity) ──┘
```

- **WP-1 and WP-2 start together** — disjoint file scopes (scripts/ vs src/providers/), no
  interaction. The snapshot is the safety net for everything after it, and WP-1's agreement
  numbers inform WP-3's default granularity.
- **WP-3 follows WP-2**, which supplies the probed `precision` it keys on. WP-3 must still handle
  `precision === undefined` cleanly, since Infinity will always return it that way.
- **WP-4 is orchestrator-direct and must follow WP-3**, so the experiment physically cannot
  contaminate the live vector space.
- **WP-5 last** — it documents measured results, not intentions.
- Subagents never commit; the orchestrator reviews each diff, re-runs gates verbatim, commits per
  WP, and lands on local master unpushed.

## Test Plan / Verification

**Gates (sequential, never backgrounded, after every WP).** `node`/`npm` come from nvm, which is
**not** loaded in a non-interactive shell — prefix with
`export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"`:

```bash
npm run lint                     # ESLint + Stylelint, zero errors
npx tsc -noEmit -skipLibCheck    # zero TypeScript errors
npm test                         # baseline is 390/390
node esbuild.config.mjs production
grep -rna "console\." src/       # must match ONLY src/log.ts  (-a is load-bearing)
file <every edited file>         # must report plain text; a raw NUL has shipped twice here
```

**Unit tests that must exist:**

1. **Migration is a no-op for coverage** — a schema-3 database with populated `embedding_model`
   and NULL `embedding_space`, migrated, reports coverage satisfied against the default space id.
   This is the test proving the change costs no re-embed.
2. **Same model, different variant, is not covered** — identical content hash and model id,
   different `embedding_space`, must re-embed.
3. **Mixed spaces are refused at upsert with 4xx, not 5xx** — asserted on the status code
   specifically, since a 5xx reads client-side as "container down".
4. **The scan filters by space** — a vault seeded with two same-width spaces returns only the
   querying space's chunks. Seed both at 1024d, or the width guard masks what is under test.
5. **Mixed-space vault degrades rather than fails** — `mode: 'fts'` plus a note, request still 200.
6. **`servedModel` disagreement warns once and does not throw.**
7. **Agreement-harness arithmetic** — hand-computed cosine for known vectors, asserted exactly.
8. **Precision normalization collapses equivalent spellings** — `Q4_K_M`, `q4_k_m` and GGUF
   `file_type: 15` must yield one token. Without this, two runtimes serving identical weights
   split into two spaces and force a pointless full re-embed.
9. **A runtime reporting no precision degrades to the bare model id**, not to a literal
   `"undefined"` in the key. This is the Infinity path and therefore the live one.
10. **The probe is cached, not per-batch** — assert the probe endpoint is hit once across many
    embed calls for one provider+model.

**Manual verification:**

- `/health` reports one space before the experiment, and the experiment's space only on the second
  instance.
- The live index is unchanged across the bake-off (compare `embeddedChunks` and a checksum of the
  snapshot).
- Restore-from-snapshot works on a scratch container — an untested backup is not a backup.
- Search quality on the user's own conceptual queries is unchanged after WP-3 lands: it is an
  identity/plumbing change and must not alter ranking.
- Probe output is sane against all three live runtimes: ollama reports `q4_k_m`-style precision
  plus a digest, LM Studio reports its `quant.name`, and Infinity reports `undefined` precision
  with a `backend` fingerprint rather than a guess.

## Critical Files

| Path | Role |
|---|---|
| `scripts/search-companion.mjs` | `createSchema` (`:117-154`), `SCHEMA_VERSION` (`:21`), `prepareChunkEmbedding` (`:262-273`), upsert guards (`:898-912`), `selectStateByPath` (`:753-779`), `createVectorBackend` (`:293-421`) — note `selectVectors` (`:294-296`) omits `embedding_model` entirely |
| `src/search/SearchManager.ts` | `activeEmbeddingModelId` (`:312-325`), `embeddingCoverageSatisfied` (`:327-342`), `attachEmbeddings` (`:472-499`), `embedTexts` (`:542-574`), skip condition (`:237`) |
| `src/search/types.ts` | `SearchChunk.embeddingModel` + the load-bearing design comment (`:66-74`), `SearchFileState`, `SEARCH_REQUIRED_SCHEMA_VERSION` (`:86`) |
| `src/search/client.ts` | `upsertChunks` (`:53-59`), `normalizeFileStates` (`:218-241`) |
| `src/providers/shared.ts` | `HttpProviderClient` (`:12-19`) — the optional-capability seam `describeModel?()` must follow |
| `src/providers.ts` | `requireCapability` (`:116-131`), `OptionalHttpCapability`, `CLI_UNSUPPORTED_VERB` — widen for the new capability |
| `src/providers/openaiCompatible.ts` | `embed()` (`:86-105`) — discarded top-level `model` at `:98`; `apiBaseUrl` (`:37`) |
| `src/providers/ollama.ts` | `embed()` (`:45-67`) — discarded echoed `model` at `:57`; note `/api/tags` and `/api/show` are never called today |
| `src/search/chunker.ts` | `stableChunkId` (`:159-161`) — the vaultId-collision hazard |
| `context-control/references/rdna4-gpu-hang.md` | GPU hang signature, triggers, recovery paths |

## Assumptions

1. **A second `vaultId` is NOT safe isolation, and this is a latent data-destroying bug
   independent of this plan.** `stableChunkId` (`src/search/chunker.ts:159-161`) hashes
   `path`/`ordinal`/`heading` with **no vaultId**, while the upsert does
   `ON CONFLICT(id) DO UPDATE SET vault_id = excluded.vault_id`
   (`scripts/search-companion.mjs:731-746`) and the FTS delete is by id with no vault filter
   (`:749`). Indexing the same notes under a second vaultId therefore **re-labels the first
   vault's rows one by one**, and a later `reset` of the second deletes what was the first's data
   — silently. This plan sidesteps it with a second database file. Fixing it properly
   (vault-qualify the chunk id, scope the FTS delete) is a **separate follow-up WP**: it changes
   every chunk id and forces a full FTS reindex, so it must not ride along here.
2. **F16 GGUF may or may not be a different vector space from fp32 ONNX.** WP-1 measures rather
   than assumes. Q4 is assumed to diverge materially; that assumption is why F16 was chosen for the
   bake-off, not something the bake-off tests.
3. **The configured model id cannot be trusted to encode quantization — verified, not assumed.**
   LM Studio's local index registers each model under ~8 `autoIdentifiers`, some carrying the
   quant (`nvidia/nemotron-3-nano-4b@q4_k_m`) and some not (`nvidia/nemotron-3-nano-4b`). The
   quant-free alias is the natural thing to configure, and the file beneath it can be swapped for a
   different quantization with no change to the configured string. This is *why* WP-2 probes rather
   than parsing the id.
4. **LM Studio's `/api/v0/models` is verified live** and returns `quant`, `type`, `arch`, `state`,
   `compatibility_type` and `max_context_length`; `/v1/models` returns only `id` and `owned_by`.
   WP-2 must still handle the native endpoint being absent (older builds, other servers) and fall
   back gracefully. Its `/v1/embeddings` **does** echo a top-level `model`, verified — but it
   echoes the *requested alias*, so `servedModel` confirms which alias answered, not which
   quantization ran. Precision must still come from `/api/v0/models`. `usage` is zeroed and
   carries no information.
5. **Infinity exposes no precision at all** — verified live: `/v1/models` returns `id`, `backend`
   (`optimum`/`torch`), `capabilities` and queue stats, and nothing about dtype. Its precision is a
   property of the deployment, which is why the manual `embeddingVariant` fallback has to exist.
6. **Infinity is the only local reranker** — verified: LM Studio rejects `/v1/rerank`,
   `/api/v0/rerank` and `/api/v0/reranking`, and ollama has no rerank endpoint. So Infinity's role
   as reranker is not contested by this plan even if WP-4 replaces it as the embedder.
7. **Vulkan inference is materially safer than the hang-triggering workloads.** The user's
   evidence is specific: LM Studio Vulkan inference has never wedged this GPU, while
   *in-development* render passes and shaders have — i.e. the hazard is invalid GPU programs, not
   Vulkan compute as such. Treated as strong but not absolute: WP-4 keeps the recovery protocol to
   hand.
8. **The measured CPU baseline is 5.8 chunks/s at request-batch 96** (2.3× the batch-24 rate),
   giving ~2.3h for a full 52,257-chunk backfill. GPU throughput is unmeasured.
9. **The live volume is `context-control_crucible-search-data`** — the fleet project's, not the
   repo compose file's `crucible-search-data`, which does not exist. A snapshot or restore command
   targeting the wrong one silently does nothing useful.

**Total ≈ 1.25 kSLOC, ~810k raw tokens; ~718k Claude-path / ~675k Codex-path Opus/Sol-equivalent tokens.**
