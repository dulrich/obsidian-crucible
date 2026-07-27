# Model settings UX, search performance & quality, inference consolidation

*Recommended model/effort — Claude: Sonnet/medium for WP-1..6 (well-scoped against pinned file:line facts), Opus/medium for WP-7 (design judgment), WP-8/9 direct on the orchestrator (ops); Codex: Terra/medium for WP-1..6, Sol/medium-high for WP-7, Sol direct for WP-8/9. Orchestrator: this session (Fable).*

Repo landing path: `plans/model-ux-search-perf-and-inference-consolidation.md` (register in `INITIATIVE.md` `pending-plans`). The landing commit also annotates `plans/sprint-audit-remediation-2026-07-26.md`: **R1/R2 absorbed here (WP-5), R4 retired** — the systemd socket-activation apparatus it guards was deleted at the 2026-07-26 crucible-inference cutover, so its subject no longer exists.

## Context

Feedback sprint off the user's updated FEEDBACK.md todos (2026-07-26), scoped by interview. In scope: model settings UI polish, the two search investigations (throughput, quality miss), all four Crucible Inference items, and the parked R1/R2 remediations. **Explicitly out of scope (user-deferred):** the search/inference management dashboard (durable home for the embedding-space retag affordance — stays parked with the retag memory as its spec seed); the AGENTS.md quirks audit runs as its **own docs-only pass outside this plan** (dox-pattern hierarchy — root index + child AGENTS.md files — evaluated there; the fleet-level "wire dox into the workflow" gap is context-control scope, surfaced not acted on).

**Grounding facts pinned this session (explorer-verified 2026-07-26; baseline 748 top-level tests across 67 files):**
- Pick path already sets capabilities: `deriveCatalogSuggestion` (`modelCapabilities.ts:281-293`) fills `capabilities`/`embeddingDimensions`/`embeddingVariant`; `acceptCatalogSuggestion` (`:354-370`) is the sole writer; pick and Accept share the path (`ai.ts:429-446`, `:601-605`). The remaining "use should set dims" gap is data, not code: neither OpenRouter's embeddings listing nor local `/v1/models` carries dimensions — the capability-gated Probe dimensions button (`ai.ts:526-552`) is the designed answer.
- Embedding fields are NOT capability-gated today: `Embedding dimensions` (`ai.ts:494-519`) and `Embedding precision (fallback)` (`:554-576`) always render; only the Probe button is gated.
- Inline callouts scattered through the model row editor: search-refs warning `ai.ts:402-408`, long setDescs `:494-496`/`:554-556`, cross-encoder warning `:582-586`, probe-suggestion provenance `:597-605`, plus probe-accepted badges `:461-468`/`:497-504`/`:557-564` (badges stay field-inline — they are field affordances, not callouts).
- describeModel alias-miss: `fallbackModelsDescribeModel` (`openaiCompatible.ts:354-371`) matches `list.find(m => m.id === ctx.modelId)` at `:364`; the JSON parse is a pure type assertion, so `meta.llamaswap.aliases` **survives at runtime** and is merely invisible to `FallbackModelEntry` (`:301-321`). Return narrows to `servedModel`/`precision`(hardcoded undefined)/`fingerprint` at `:366-370`.
- Embed path is strictly sequential: `SearchManager.embedTexts` (`:766-814`) awaits one sub-batch at a time (`:789-812`, sub-batch size `:779` = clamp(searchIndexBatchSize||24, 1..96)); `flush()` (`:321-350`) serializes embed→upsert; `SEARCH_UPSERT_FLUSH_CHUNKS = 500` (`:27`). Companion upsert is already sub-batched per 100 chunks in separate transactions with `yieldEventLoop()` between (`scripts/search-companion.mjs:1236-1343`, rationale comment `:988-1012`) — the "half GPU" suspect is client-side serial round-trips, not SQLite.
- Search quality miss: query "matt pocock lean claude context skills" should surface `daily/day/2026-07-23/How To Kill The Bloat In Claude Code's System Prompt.md` (vault `/home/_shared_code/second-brain/vault`). The note contains pocock/context/skills/bloat but **zero occurrences of "lean"** — prime suspect is AND semantics in the companion's FTS query builder; open question is why the vector leg (full-matrix scan) didn't rescue it.
- R1/R2 line citations in the remediation plan have drifted: only `sweepTerminal()` call site is `MemoryJobBackend.ts:144` (in `runEntry`'s finally — quiet queue never sweeps); synthetic `status: 'running'` at `:164`; the stop claim-window lives in `FileJobBackend.ts:218-243` (claim→`store.move`→`running.begin` at `:275`) and `MemoryJobBackend.ts:53`→`:94`, with `stopJob` in `OrchestrationAutoRunner.ts:125-141`.
- Host facts: `/home/dulrich/.lmstudio/models` = 87G, same filesystem as `/home/_shared_code` (move is one rename); chat/multimodal GGUFs already downloaded — gemma-4-12B-it Q4_K_M (7.4G, cutover-tested), gemma-4-26B-A4B-it-QAT Q4_0 (14.4G + mmproj), gemma-4-31B-it-QAT Q4_0 (17.6G + mmproj), Qwen3.6-27B Q4_K_M (16.5G + mmproj), Qwen3.6-35B-A3B Q4_K_M (21.2G + mmproj), Nemotron-3-Nano-4B (2.8G). Stray harnesses on host: anythingllm + unsloth-studio desktop apps, `~/.ollama` + `/usr/local/bin/ollama`, `lms` CLI, `~/.lmstudio` app data.

## Decisions locked (user-confirmed 2026-07-26)

1. **Sprint scope** per interview: model settings UI polish + describeModel alias fix; indexing throughput investigation; search quality miss; all four inference items; R1+R2. Dashboard deferred; R4 retired; quirks audit separate.
2. **GGUF home: `/home/_shared_code/models`** — preserve the existing `<publisher>/<repo>/<file>.gguf` layout so `config.yaml` model paths are untouched; repoint `CRUCIBLE_GGUF_DIR` / compose default.
3. **Multimodal deliverable: design doc + bench prototype** — no plugin code this sprint; measurement artifacts land in the eval-harness repo per standing rule.
4. Standing: FEEDBACK.md never written/staged; stage by path; subagents never commit; never push/mutate remotes; gates scope to the diff.

## Summary

Four streams, mostly parallel: **(a)** model settings UX — capability-gate the embedding fields, consolidate the scattered callouts, close the alias-miss so precision probes work through llama-swap; **(b)** search — measure and fix the sequential-embed throughput ceiling, then diagnose the multi-term quality miss; **(c)** inference consolidation — GGUF move + compose repoint, chat models into llama-swap, LM Studio/stray-harness retirement, multimodal bench + design; **(d)** R1/R2 remediations. One commit per WP, dispatched workers, orchestrator reviews/gates/commits.

## Key Changes

**WP-1 — Model row editor: capability gating + callout consolidation (~0.35 kSLOC, ~200k tokens, ~15 min wall).**
(1) Gate `Embedding dimensions` and `Embedding precision (fallback)` on `modelHasCapability(model, 'embedding')` (the Probe button already is); rerank toggle stays unconditional. (2) Consolidate the interleaved callouts into one notices block at the bottom of the model row editor: the search-refs warning, cross-encoder warning, and probe-suggestion provenance move there; the long `setDesc` prose on dimensions/precision shrinks to one line each with the detail folded into the block; probe-accepted badges + undo stay field-inline. (3) Verify the pick path end-to-end (capabilities already applied; dims flow when `embeddingLength` known; precision chain quantization→described→id-parse) and add a regression test asserting the pick sets capabilities + variant for a llama-swap-shaped entry. Files: `src/settings/sections/ai.ts`, `src/settings/modelCapabilities.ts` (minor), `styles.css`; tests extend `providerModelConfigUI.test.mjs`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: subagent (~70% saving).* Independent.

**WP-2 — describeModel alias-aware fallback (~0.1 kSLOC, ~80k tokens, ~6 min wall).**
Extend `FallbackModelEntry` with `meta?: { llamaswap?: { aliases?: string[] } }` and make the `:364` find also match alias membership; on an alias hit return the **canonical** id as `servedModel` (server-reported truth, not fabrication — the honest-undefined rule for `precision` stands, but the UI's `precisionFromModelId` fallback may run against the returned `servedModel` where it previously only saw the alias). Regression test: a llama-swap-shaped `/v1/models` payload (canonical id + `meta.llamaswap.aliases`) probed by alias resolves servedModel/fingerprint, and the settings precision chain lands `f16` for `bge-m3` → `bge-m3-f16`. Files: `src/providers/openaiCompatible.ts`, `src/settings/modelCapabilities.ts` or `ai.ts` (fallback-chain touch only if needed); tests extend `providerModelProbe.test.mjs`. *Model: mid (Sonnet/medium; Terra/medium). Execution: subagent (same wave as WP-1; disjoint files).* Independent.

**WP-3 — Indexing throughput: measure, then pipeline the embed path (~0.25 kSLOC, ~180k tokens, ~14 min wall).**
Investigation-first: instrument `indexFiles`/`flush`/`embedTexts` to attribute wall time (embed HTTP round-trips vs chunk prep vs upsert vs cache-barrier waits) over a real backfill slice against the live companion + crucible-inference; write the numbers down. Expected fix per the pinned facts: bounded pipelining — overlap embed of sub-batch N+1 with the in-flight request for N (concurrency 2), and/or overlap a flush's upsert with the next batch's embed — preserving the dimension/space consistency checks (`:802-810`), `withFlushInFlight` semantics, the transient-failure gate, and chunk ordering within a path. STOP at a written diagnosis if measurement shows the bind is elsewhere (companion insertion, provider server) or the fix turns structural (worker threads, provider batching API). Files: `src/search/SearchManager.ts`, possibly `src/search/client.ts`; measurement notes to `/home/_shared_code/eval-harness/local-inference-bench/measurements/` (new sibling dir), never `runs/` here. *Model: mid (Sonnet/high — concurrency touches the availability-gate seam; Terra/medium). Execution: subagent.* Independent; **must land before WP-4** (shared search files).

**WP-4 — Vault search quality: the multi-term miss (~0.15 kSLOC, ~120k tokens, ~9 min wall).**
Diagnose why "matt pocock lean claude context skills" misses the pinned note: reproduce against the live companion; inspect the FTS query builder's term semantics (suspected implicit AND — "lean" has zero hits in the note); check the vector leg (does the note have embeddings? what's its pure-KNN rank for this query? did fusion drop it?), and the reranker stage. Fix the smallest correct thing — likely relaxed multi-term FTS semantics (e.g. OR with rank-preserving weighting) and/or fusion tuning so a strong vector hit survives a zero-FTS match — with a regression test encoding this query shape (a term absent from the target document must not exclude it). STOP at diagnosis if the correct fix is a ranking redesign. Files: `scripts/search-companion.mjs` (query builder), `src/search/*` if fusion-side, tests extend `searchCompanionRanking.test.mjs`/`searchCompanionVector.test.mjs`. *Model: mid (Sonnet/medium; Terra/medium). Execution: subagent.* **After WP-3.**

**WP-5 — Remediations R1+R2: memory-queue sweep + stopJob claim-window (~0.25 kSLOC, ~180k tokens, ~14 min wall).**
As specced in `plans/sprint-audit-remediation-2026-07-26.md` WP-R1/WP-R2, with corrected pins (citations there have drifted): R1 — `sweepTerminal` runs only in `runEntry`'s finally (`MemoryJobBackend.ts:144`), so a quiet queue never expires terminal entries past `terminalRetentionMs` and a lingering `failed` suppresses its auto-source re-seed; sweep on refill or a backend-owned periodic sweep; also make `synthJob`'s hardcoded `status: 'running'` (`:164`) report the entry's real state. R2 — during claim→`running.begin` (`FileJobBackend.ts:218-243`/`:275`, up to ~2s under the cache barrier; memory side `MemoryJobBackend.ts:53`→`:94`) a job is invisible to both listings, so `stopJob` (`OrchestrationAutoRunner.ts:125-141`) answers `'not-found'` for a job that then starts; track in-flight claims so stop answers honestly. One dispatch (both live in the orchestration backends; R2's real scope spans `FileJobBackend.ts` + `MemoryJobBackend.ts`, overlapping R1). Files: `src/orchestration/{MemoryJobQueue,MemoryJobBackend,FileJobBackend,OrchestrationAutoRunner}.ts`; tests extend `memoryJobQueue.test.mjs` + a claim-window test. *Model: mid (Sonnet/medium; Terra/medium). Execution: subagent.* Independent.

**WP-6 — Chat models into crucible-inference (~0.1 kSLOC config/sh/docs, ~80k tokens, ~6 min wall).**
Populate the chat group in `docker/llamacpp-vulkan/config.yaml` (currently a commented stub, `swap: true, exclusive: true`): gemma-4-12B-it Q4_K_M (cutover-tested) plus whichever of the downloaded candidates **fit VRAM — verify the GPU's actual VRAM first** and record the fit math per model in the config comments (gemma-4-26B-A4B Q4_0 at 14.4G is the likely second; 27B/31B/35B likely exceed a 16G card fully-offloaded); stable aliases (append-only API surface), sensible ttl, `--jinja`-style flags as llama.cpp requires per model. Extend `smoke-inference.sh` with a chat completion check per configured chat model (reasoning models spend tokens on `reasoning_content` — use max_tokens ≥128 per the cutover lesson). Document the plugin-side provider row(s) in `docs/local-inference.md`. Orchestrator reloads the live service and runs the smoke at review. Files: `docker/llamacpp-vulkan/{config.yaml, smoke-inference.sh, README.md}`, `docs/local-inference.md`. *Model: mid (Sonnet/medium; Terra/medium). Execution: subagent.* Independent (model paths unchanged by WP-8's move — layout preserved).

**WP-7 — Multimodal image→search: bench + design doc (~0.3 kSLOC scripts+docs, ~250k tokens, ~19 min wall).**
Candidates are already on disk with `mmproj` projectors (gemma-4-26B-A4B/31B QAT, Qwen3.6-27B/35B-A3B). Bench: one-off `llama-server --mmproj` runs using the existing `crucible-llamacpp-vulkan` image (never the live config), against a sample of real vault images — charts especially (the localized `_MD5` attachments are the corpus) — measuring description latency + qualitative fidelity (does it read chart axes/values?); artifacts + scripts land in `/home/_shared_code/eval-harness/local-inference-bench/measurements/` (standing rule: never this repo). Design doc (`docs/` or `plans/` seed): the image → narrative description + content extraction → search-index pipeline — where it hooks (localize post-pass vs a memory-queue enrichment job), chunk shape (description chunks linked to the owning note), embedding-space implications, cost model at measured throughput. No plugin code. *Model: top (Claude Opus/medium — pipeline design judgment; Codex Sol/medium-high). Execution: subagent (~50% saving; eval-harness repo, fully disjoint).* Independent.

**WP-8 — GGUF consolidation + compose repoint (ops, ~30k tokens direct, ~20 min wall mostly machine time).**
*must-direct: live host ops + cross-repo landing.* (1) `mkdir /home/_shared_code/models`; move the model tree out of `~/.lmstudio/models` preserving the `<publisher>/<repo>` layout (same filesystem — instant rename); ownership/permissions check for the container's ro mount. (2) Repoint the mount: compose default `${CRUCIBLE_GGUF_DIR:-...}` → `/home/_shared_code/models` in `context-control/compose.home.yml`, landed per that repo's rules. (3) Recreate crucible-inference, run the WP-6 smoke (or the existing one if WP-6 hasn't landed), confirm embeddings/rerank/chat answer. Depends on nothing; do before WP-9 (frees `~/.lmstudio` for retirement).

**WP-9 — LM Studio uninstall + stray-harness audit (ops, ~20k tokens direct, ~20 min wall, user present).**
*must-direct: destructive host ops, per-item user confirmation.* Inventory pinned: LM Studio (`~/.lmstudio` app data + `lms` CLI), anythingllm desktop, unsloth-studio desktop, ollama (`/usr/local/bin/ollama` + `~/.ollama` — check for models inside before deciding). Walk the list with the user, remove what they confirm, verify nothing in the fleet references the removed pieces (compose greps). After WP-8.

## Public Interfaces

| Surface | Change |
|---|---|
| Model row editor | Embedding dims/precision fields capability-gated; callouts consolidated into one bottom notices block |
| `describeModel` (openai-compatible fallback) | Alias-aware: llama-swap `meta.llamaswap.aliases` match; `servedModel` = canonical id |
| Search indexing | Embed sub-batches pipelined (bounded concurrency) — throughput up, semantics unchanged |
| `/v1/search` FTS semantics | Multi-term queries no longer hard-AND (exact shape per WP-4 diagnosis) |
| Memory queue | Terminal sweep no longer requires a running job; synthetic job status honest |
| `stopJob` | Answers honestly during the claim window |
| Fleet | GGUF home `/home/_shared_code/models` (compose default repointed); crucible-inference gains a chat group with stable aliases; LM Studio/stray harnesses retired |

## Execution

Planning session becomes orchestrator (skill default). Ask-before-dispatch stands per wave.

```
wave 1 (parallel, disjoint):  WP-1 (ai.ts/styles) · WP-2 (providers) · WP-3 (search perf) · WP-5 (orchestration) · WP-7 (eval-harness)
wave 2:                        WP-4 (after 3) · WP-6 (docker config/docs)
ops (user present):            WP-8 → WP-9 (any time after wave 1 dispatch; WP-8 before WP-9)
```

One commit per WP; orchestrator reviews diff, re-runs gates verbatim, lands on local master unpushed. The context-control compose commit (WP-8) lands per that repo's rules. WP-7's artifacts commit in eval-harness per its rules; its design doc lands here.

## Test Plan / Verification

Gates per repo standard after every code WP: `npm run lint`; `npx tsc -noEmit -skipLibCheck`; `npm test` (baseline **748/748**); `node esbuild.config.mjs production`; `grep -rna "console\." src/` (only `src/log.ts`); `file` + NUL sweep (`LC_ALL=C grep -caP '\0'`, exit 1 = PASS) on every touched file. nvm prefix required. Docs/config-only WPs: file/NUL only; WP-6 additionally live smoke at review.

Load-bearing new assertions: embedding fields hidden without the capability and shown with it; consolidated notices block renders each warning exactly once; alias-probe resolves canonical servedModel + precision chain lands f16; throughput fix preserves dimension/space checks + per-path chunk ordering under concurrency (test with a mock provider); WP-4's "absent term must not exclude" regression; R1 quiet-queue sweep + honest synth status; R2 stop-during-claim honesty.

## Critical Files

`src/settings/sections/ai.ts`; `src/settings/modelCapabilities.ts`; `src/providers/openaiCompatible.ts`; `src/search/SearchManager.ts`; `scripts/search-companion.mjs`; `src/orchestration/{MemoryJobQueue,MemoryJobBackend,FileJobBackend,OrchestrationAutoRunner}.ts`; `docker/llamacpp-vulkan/{config.yaml,smoke-inference.sh}`; `context-control/compose.home.yml`; `docs/local-inference.md`.

## Assumptions

1. The "half GPU" bind is client-side serial embed round-trips (pinned: no concurrency anywhere in `embedTexts`); WP-3 measures before fixing and stops at diagnosis if wrong.
2. The quality miss is FTS AND semantics ("lean" absent from the target note) compounded by fusion not rescuing a zero-FTS strong-vector hit; WP-4 verifies both halves before touching either.
3. GPU VRAM bounds which chat models fit; WP-6 verifies the actual number rather than assuming 16G.
4. llama-swap chat group `exclusive: true` semantics as verified at cutover (chat evicts retrieval; retrieval reloads without evicting chat).
5. `~/.ollama` may contain models worth auditing before deletion; WP-9 checks with the user per item.
6. R1/R2 scope as re-pinned this session (the remediation plan's citations drifted; the corrected pins above govern).

**Total ≈ 1.55 kSLOC, ~1.14M raw tokens; ~1.13M Claude-path / ~0.95M Codex-path Opus/Sol-equivalent tokens** (model-cost.mjs: 7 dispatched WPs — six to Sonnet/Terra, WP-7 to Opus/Sol — with per-dispatch overhead; WP-8/9 direct on the orchestrator).

---

## Outcome (sprint close, 2026-07-26)

All nine WPs closed. Landed commits (obsidian-crucible unless noted):

- **WP-1** model row editor — landed (wave 1).
- **WP-2** alias-aware describeModel — landed c34b357. **Parked gap → follow-up wave:** the
  probe-suggestion path in `src/settings/sections/ai.ts` matches the catalog by raw id only, so
  alias-configured rows never render the Accept row. Fix: cache `servedModel` from the describe
  probe (`describedPrecisionByModel` is the precedent) and re-match by canonical id (~30–60 SLOC
  + `providerModelConfigUI.test.mjs`).
- **WP-3** throughput — stop-at-diagnosis; superseded by **WP-3b** (landed 1642b5b): rowid-keyed
  `chunks_fts`, schema 6, live DB migrated lossless (53,019 chunks).
- **WP-4** quality miss — stop-at-diagnosis, empirically completed post-hoc: per-chunk implicit
  AND is the root cause; the loose-OR fallback (zero-hit-gated) starves at vault scale; the
  vector leg does NOT rescue (real embedding: target rank 54/245, textRank null, vectorRank 70).
  Report + addendum: `runs/dispatch/wp4-quality-miss-report.md`. **Follow-up direction (user,
  2026-07-26): implement BOTH candidate directions and pick the winner empirically.** Same wave
  adds the frontmatter **author/entity facet**: the chunker already parses full frontmatter
  (`src/search/chunker.ts:84-96`) but FTS indexes only path/title/heading/text, so
  `author: Matt Pocock` is unsearchable — an omission, not a build. Design the facet as ONE
  entity mechanism with two sources (frontmatter now; GLiNER2 body-text extraction later — held
  for a later pass, must stay compatible). GLiNER2 cannot be a crucible-inference alias
  (encoder + span head, no GGUF/llama.cpp support); when it comes, it is a small CPU sibling
  container (ONNX runtime, crucible-search shape), per the WP-7 enrichment template.
- **WP-5** R1+R2 remediations — landed (wave 1).
- **WP-6** chat models — landed 5cd33f4; live smoke all-green (gemma-4-12b + nemotron-4b,
  evict/reload interleave exercised).
- **WP-7** multimodal bench + design — landed 108cc85 (+ eval-harness b784394). gemma-4-12B
  ships for image→text descriptions; implementation is a future sprint.
- **WP-8** GGUF consolidation — done. **Actual home is `/home/_shared_models`** (user-created
  sibling of `_shared_code`, superseding this plan's `/home/_shared_code/models`); 87G moved,
  compose default repointed (context-control 6523ffc), container recreated, full smoke green
  on the new mount.
- **WP-9** retirement walk — done (user-executed root ops, verified): LM Studio package +
  `~/.lmstudio` + `lms`, ollama (service/binary/store/user — its two models were redundant:
  bge-m3 duplicate, qwen3.5 superseded by the Qwen3.6 quants; the Jul 25 pull was the ESI
  bench arm), AnythingLLM launcher, unsloth-studio. Remaining crumb: `groupdel ollama` after
  removing `dulrich` from the group.

**Follow-up agenda beyond the next wave** (user, 2026-07-26): evaluate splitting
crucible-inference into its own initiative repo with the plugin depending on it optionally —
news-ingestion runs a separate embeddings + GLiNER2 setup, giving two proof points that could
merge (and news-ingestion inherits this sprint's llama-swap learnings).
