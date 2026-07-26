# Model catalog UX, local inference service ("local OpenRouter"), urgent remediations

*Recommended model/effort — Claude: Sonnet/medium for all dispatched WPs (well-scoped against pinned facts), WP-6 direct on the orchestrator (ops); Codex: Terra/medium throughout, Sol direct for WP-6. Orchestrator: this session (Fable).*

Repo landing path: `plans/model-catalog-ux-local-inference-and-remediations.md` (register in `INITIATIVE.md` `pending-plans`). The same landing commit annotates `plans/sprint-audit-remediation-2026-07-26.md`: WP-R3/R5/R6 absorbed here (prevents double-execution); R1/R2/R4 remain parked there.

## Context

The sprint-exit sprint closed 2026-07-26 (all 12 WPs landed, history scrubbed). This plan is the follow-up wave: the model-probing UX gaps the user hit while using the landed WP-8 probe-first flow, the decided move off LM Studio as a runtime dependency, and the three urgent remediations from the closure audit.

**User-reported pain points (2026-07-26), each verified against code this session:**
1. **Catalog visibility**: the fetched catalog (343 OpenRouter models) is only reachable via type-ahead in the Model input, hard-capped at `.slice(0, 100)` with no truncation indicator (`src/suggesters.ts:452`), substring-on-id filter only. No browse surface exists; the only other visibility is the "N models found" status line (`formatProbeStatusText`, `ai.ts:596-598`).
2. **OpenRouter missing embedding models**: verified live — `GET /api/v1/models` returns 343 models with **zero** embedding entries (`?category=embeddings` → 400). Embeddings live on a **separate endpoint** `GET /api/v1/embeddings/models` (27 models, incl. `openai/text-embedding-3-small`, `openai/text-embedding-3-large`, `baai/bge-m3`, `qwen/qwen3-embedding-*`), entries carrying `name` (display), `context_length`, and `architecture.output_modalities: ["embeddings"]`. The client never fetches it (`src/providers/openaiCompatible.ts:374-402`), and `inferCapabilities` can never yield `embedding` for OpenRouter (`modelCapabilities.ts:145-155`).
3. **Ugly local model ids**: llama-server reports `/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf`; the id is carried verbatim end-to-end with no aliasing (`suggesters.ts:466-467`, `ai.ts:410`). `ProviderModel.label` exists but nothing auto-fills it.
4. **Local providers get no probed values**: the fallback `GET /models` on llama-server/Infinity returns id-only — no `quantization`, no `embeddingLength` — so WP-8's auto-apply fills nothing for local kinds. Manual fields exist (`ai.ts:443-527`, kind-agnostic) but nothing populates them.
5. **LM Studio as a dependency is awkward** — decided: stand up a dedicated multi-model local service on llama.cpp + llama-swap ("local OpenRouter" concept).

**Additional code facts pinned for the workers (explorer-verified):**
- Auto-apply pick path omits `describedPrecision` (only the re-rendered Accept row applies it) — `ai.ts:424-430` vs `:544-547`. `deriveCatalogSuggestion` fills only capabilities/dims/variant; `contextLength` is display-only by design.
- `ProviderCatalogModel` (`types.ts:344-364`) has **no display-name field**; OpenRouter's `name` is currently dropped.
- Catalog persisted per provider (`Provider.modelCatalog`, `types.ts:392`), sole writer `applyFetchedCatalog` (`modelCapabilities.ts:352-354`); session promise cache in `ProviderManager.listModelsCache`.
- Picker gating via capability ref arrays (`orchestration.ts:71-105` → `buildModelPickerOptions`); `rerank` capability is user-set only, never inferred (deliberate).
- Stale comment at `orchestration.ts:138-143` claims no rerank checkbox exists (it does, `ai.ts:471-476`) — fix in passing.
- OpenRouter `listModels` sends no `OPENROUTER_HEADERS` (only complete/extractImage do); `embed()` for openrouter kind POSTs `/api/v1/embeddings` unbranched and untested.
- Existing tests to extend: `tests/modelCapabilities.test.mjs`, `providerModelList.test.mjs`, `providerModelConfigUI.test.mjs`, `providerModelProbe.test.mjs`. Baseline 672/672.

## Decisions locked (user-confirmed 2026-07-26)

1. **Catalog browser is inline in the Provider panel** — built into the bottom of the panel where the "N models found" status line lives today. Not a modal, not a separate tab.
2. **Local service: build now, llama.cpp + llama-swap.** LM Studio stays as the model downloader/eval bench only (the `~/.lmstudio/models` mount is unchanged).
3. **Remediations in scope: R5 + R6 + R3** (churn-stranded claims, rebuild confirm gate, provider dead status branches). R1/R2/R4 stay parked.
4. **Id hygiene: auto-alias + keep raw id** — derive a display label (basename, strip extension/quant decoration), raw id remains the wire value. Zero-click, reversible.
5. Standing: FEEDBACK.md never written/staged; stage by path; subagents never commit; never push/mutate remotes; gates scope to the diff.

## Summary

Three streams, mostly parallel: **(a)** plugin-side catalog UX — the inline browser panel, the OpenRouter embeddings leg, the auto-apply/id-hygiene/dimension-probe gap fixes; **(b)** the crucible-inference llama-swap service — container + compose/systemd landing (cross-repo with context-control) + docs + plugin migration notes; **(c)** remediations R5/R6/R3. One commit per WP, dispatched workers, orchestrator reviews/gates/commits.

## Key Changes

**WP-1 — Inline catalog browser panel (~0.45 kSLOC, ~220k tokens, ~17 min wall).**
New `src/settings/modelCatalogBrowser.ts` rendering at the bottom of each provider's panel (replacing the bare `formatProbeStatusText` line, which becomes the browser's header row): filter text input (matches id + display name), capability chip filter (All / Chat / Embedding / Image / Rerank — from catalog inference where known, "untagged" bucket otherwise), paged list (25/page, prev/next, "page X of Y · N models"), rows showing display name + id + summary tokens (`catalogEntrySummaryTokens` reused) and a **Use** button per row that routes through the existing `acceptCatalogSuggestion` pick path (fills the pending/new model row exactly like a type-ahead pick). Type-ahead stays; its 100-cap gains a "+N more — use the browser below" tail row. Collapsed by default (header row = current status text + expand chevron) so the panel doesn't grow for users who never browse. Files: new `src/settings/modelCatalogBrowser.ts`; `src/settings/sections/ai.ts`, `src/settings/modelCapabilities.ts` (filter helper gains name matching), `src/suggesters.ts` (truncation tail), `styles.css`; tests extend `providerModelConfigUI.test.mjs`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: subagent (~70% saving).* Independent, but lands before WP-3 (both touch `ai.ts`).

**WP-2 — OpenRouter embeddings catalog leg (~0.25 kSLOC, ~140k tokens, ~11 min wall).**
For kind `openrouter` only, `listModels` additionally fetches `GET {base}/embeddings/models`, merges into one catalog (id-deduped), and tags merged entries: `architecture.output_modalities` containing `embeddings` → `embedding` capability in `inferCapabilities`; capture `name` into a new `ProviderCatalogModel.displayName?` and `context_length` (both endpoints). Send `OPENROUTER_HEADERS` on list + embed calls. Verify/fix the openrouter `embed()` path against the live API shape (entries confirmed: `pricing.prompt` present, standard OpenAI response expected — worker validates with a mocked shape test, no live key needed). A failed embeddings-listing fetch degrades to the chat-only catalog with the error folded into the probe status line (never blocks the main list). Files: `src/providers/openaiCompatible.ts`, `src/settings/modelCapabilities.ts`, `src/types.ts`; tests extend `providerModelList.test.mjs`, `modelCapabilities.test.mjs`. *Model: mid (Sonnet/medium; Terra/medium). Execution: subagent.* Independent; must land before WP-R3 (same file).

**WP-3 — Auto-apply gaps, auto-alias, dimension probe (~0.35 kSLOC, ~190k tokens, ~15 min wall).**
(1) Pick path passes `describedPrecision` into `deriveCatalogSuggestion` (today only the re-rendered Accept row does — `ai.ts:424-430` vs `:544-547`). (2) Auto-alias: `deriveModelDisplayLabel(id)` — for file-path-shaped ids take basename, strip `.gguf`/quant-suffix decoration → `bge-m3-f16`; on pick, fill `ProviderModel.label` when empty (user edits win; catalog `displayName` from WP-2 preferred when present); suggest rows and the WP-1 browser render label over id. (3) Dimension probe: explicit **Probe dimensions** button next to the Embedding dimensions field (shown when the model has `embedding` capability and dims are empty): one-shot `embed(["probe"])` call, reads vector length, writes dims via the accepted-marker path (badge + Reset like other probed fields). Explicit button, not automatic — a probe can cold-load a local model (seconds to minutes). (4) Precision-from-id: teach `deriveCatalogSuggestion` to parse a trailing `-f16`/`-Q8_0`/`-Q4_K_M`-style token from catalog ids into the precision suggestion (the crucible-inference aliases carry precision in the name; `describeModel` stays honest-undefined) — severable if it grows. (5) Fix the stale rerank comment at `orchestration.ts:138-143`. Files: `src/settings/sections/ai.ts`, `src/settings/modelCapabilities.ts`, `src/suggesters.ts`, `src/settings/sections/orchestration.ts`; tests extend `providerModelProbe.test.mjs`, `providerModelConfigUI.test.mjs`. *Model: mid (Sonnet/medium; Terra/medium). Execution: subagent.* After WP-1 and WP-2 (shares `ai.ts` with 1, `displayName` with 2).

**WP-4 — crucible-inference: llama-swap container + config + smoke script (~0.2 kSLOC docker/yaml/sh, ~150k tokens, ~12 min wall).**
Design settled by the dispatched design report (llama-swap **v243** verified upstream: static Go binary; config `models`/`groups`/`ttl`/`aliases`/`healthCheckTimeout: 120`; proxies `/v1/embeddings`, `/v1/models` aggregation, `/rerank` + `/v1/rerank`; spawns llama-server children in-container, holds the request until healthy, SIGTERMs on ttl). One always-on `crucible-inference` container on **127.0.0.1:4800** (verified free), `restart: unless-stopped` — llama-swap's spawn-on-request + `ttl: 1800` **replaces the entire systemd socket-activation apparatus** (idle cost is a few MB RAM, zero VRAM). Scope: (1) extend `docker/llamacpp-vulkan/Dockerfile` — fetch stage for `llama-swap` pinned by `ARG LLAMA_SWAP_TAG=v243` + SHA256, keep llama.cpp at `b10121` (same inference binary ⇒ no embedding-agreement concern), entrypoint tail `exec llama-server "$@"` → `exec "$@"` with `CMD ["llama-swap", …]` (image stays dual-use during migration), new tag `crucible-llamacpp-vulkan:b10121-swap243`; GPU assertion half untouched. (2) `docker/llamacpp-vulkan/config.yaml` (bind-mounted ro, not baked): `retrieval` group `swap: false, exclusive: false, persistent: false` with `bge-m3-f16` (`--embeddings`) + `bge-reranker-v2-m3-Q8_0` (`--reranking`), both `ttl: 1800`, the `-b/-ub 8192` + no-`--pooling` settings carried verbatim from the compose comments; aliases chosen **after checking the actual stored model ids in the live `data.json`** so the plugin migration is base-URL-only; commented chat-group stub (`swap: true, exclusive: true`). (3) Smoke script (bash or .mjs beside the Dockerfile): `/v1/models` lists aliases; `/v1/embeddings` + `/rerank` answer with the strict shapes; `/api/v0/models` fails fast (404, not hang); ttl unload returns VRAM (`GET /running`); llvmpipe assertion still fatal. Files: `docker/llamacpp-vulkan/{Dockerfile, entrypoint.sh, config.yaml (new), smoke-inference.sh (new), README.md}`. *Model: mid (Sonnet/medium; Codex Terra/medium). Execution: subagent — obsidian-crucible half only; the context-control compose service lands in WP-6 (cross-repo is orchestrator duty).* Independent of WP-1..3.

**WP-5 — Docs + migration notes for the new service (~0.15 kSLOC docs, ~100k tokens, ~8 min wall).**
`docs/local-inference.md`: new recommended end-to-end setup for crucible-inference (one base URL `http://127.0.0.1:4800/v1` for both provider entries — aliases make model ids stable; rerank as the second provider entry same port), demote LM Studio to model-downloader/eval-bench framing, document the alias-is-API-surface rule (append-only), the cold-load-vs-5s-timeout behavior and the `hooks.on_startup.preload` escape hatch, and resolve the 6×/24× (compose) vs 25.7×/34× (docs) speedup discrepancy from the eval-harness archive numbers. Files: `docs/local-inference.md`, `docs/search-companion.md` (if it names 4804/4805). *Model: mid (Sonnet/medium; Terra/medium). Execution: subagent.* After WP-4.

**WP-6 — Fleet cutover (ops, ~40k tokens direct, ~30 min wall mostly machine/user time).**
*must-direct: cross-repo landing + live fleet ops + user coordination.* After WP-4 lands and its image builds: (1) add the `crucible-inference` service to `context-control/compose.home.yml` per the design (port 4800, `mem_limit: 24g` — children share one cgroup, the old 4g would OOM chat spillover; `/dev/dri` + numeric `group_add` reuse; llama-swap `/health` healthcheck = "proxy up"), fix the stale 6×/24× compose comment in the same commit, land per context-control's rules; (2) `hc up crucible-inference`, run the WP-4 smoke script, test the chat-evicts-retrieval interleave explicitly (VRAM oversubscription under RADV is the named untested risk); (3) **user flips the two provider base URLs** in Obsidian settings (4804/4805 → 4800) and confirms search + rerank work; (4) disable the systemd sockets (`systemctl --user disable --now crucible-embed.socket crucible-rerank.socket`), delete `crucible-embed-gpu`/`crucible-rerank-gpu` from compose, delete the five systemd files + `crucible-inference-ctl` + gut `install.sh` in obsidian-crucible, rewrite that dir's README. CPU `cpu-inference` pair stays as fallback. Depends on WP-4.

**WP-R5 — Job claims strand under bulk queue churn (~0.2 kSLOC, ~150k tokens, ~12 min wall).**
As specced in `plans/sprint-audit-remediation-2026-07-26.md` WP-R5: chokepoint fix for the silent frontmatter-drop under 2,000-file churn (observed live 2026-07-26). Worker evaluates the three recorded directions — (a) barrier-timeout fallback to index-spliced `vault.process` write in `updateFrontmatter`, (b) `JobStore.move` verify-and-retry, (c) pause drain during bulk repair — and implements the chokepoint one (a) unless investigation shows (b) strictly safer; investigation-first scoping, stop at a written diagnosis if the fix turns structural. Files: `src/frontmatter.ts`, `src/orchestration/JobStore.ts`, `src/orchestration/failedJobRepair.ts`, tests. *Model: mid (Sonnet/medium; Terra/medium). Execution: subagent.* Independent.

**WP-R6 — Confirm gate on destructive index rebuild (~0.05 kSLOC, ~60k tokens, ~5 min wall).**
As specced in remediation WP-R6: route `search-rebuild-index` through `ConfirmModal` with copy naming the reset and pointing at the non-destructive embed-missing backfill; rename to "Search: reset and rebuild index". Files: `src/commands.ts`, tests. *Model: mid (Sonnet/medium; Terra/medium — mechanical but user-facing copy). Execution: subagent (merge into WP-R5's dispatch wave).* Independent.

**WP-R3 — Provider clients: retire dead status branches (~0.25 kSLOC, ~150k tokens, ~12 min wall).**
As specced in remediation WP-R3: sweep the `response.status !== 200` checks that never fire (default-throw `requestUrl`) with `throw: false` + explicit status handling so 429/quota bodies surface; preserves each client's error-type contract. Files: `src/providers/*.ts`, tests. *Model: mid (Sonnet/medium; Terra/medium). Execution: subagent.* **After WP-2** (both rewrite `openaiCompatible.ts` request paths).

## Public Interfaces

| Surface | Change |
|---|---|
| `ProviderCatalogModel.displayName?` | New — OpenRouter `name`, shown in browser/suggest/pickers |
| OpenRouter catalog | Now merges `GET /api/v1/embeddings/models`; embedding capability inferred from `output_modalities` |
| `ProviderModel.label` | Auto-filled on pick (empty-only) via `deriveModelDisplayLabel` |
| Settings UI | Inline catalog browser panel per provider (filter, capability chips, paging, Use) |
| "Probe dimensions" button | New per-model control; one-shot embed call → dims via accepted-marker path |
| Command `search-rebuild-index` | ConfirmModal + rename "Search: reset and rebuild index" |
| `updateFrontmatter` / `JobStore.move` | Churn-crash-consistent claim writes (direction per WP-R5 investigation) |
| Fleet | New `crucible-inference` (llama-swap v243) on 127.0.0.1:4800, always-on; systemd sockets + 4804/4805 GPU services retired at WP-6 cutover; config aliases are append-only API surface |

## Execution

Planning session becomes orchestrator (skill default). Ask-before-dispatch stands per wave.

```
wave 1 (parallel, disjoint):  WP-1 (settings UI) · WP-2 (providers) · WP-R5+R6 (queue/commands, one wave) · WP-4 (container)
wave 2:                        WP-3 (after 1+2) · WP-R3 (after 2) · WP-5 (after 4)
then:                          WP-6 (cutover, direct, after 4+5, user present for the settings flip)
```

One commit per WP; orchestrator reviews diff, re-runs gates verbatim, lands on local master unpushed. The context-control compose commit (WP-6) lands per that repo's rules.

## Test Plan / Verification

Gates per repo standard after every code WP: `npm run lint`; `npx tsc -noEmit -skipLibCheck`; `npm test` (baseline **672/672**); `node esbuild.config.mjs production`; `grep -rna "console\." src/` (only `src/log.ts`); `file` on every edited file (NUL history). nvm prefix required.

Load-bearing new assertions: browser paging math + capability filter + Use routes through `acceptCatalogSuggestion`; OpenRouter merge dedupes + tags embedding capability + degrades gracefully on embeddings-listing failure; pick applies describedPrecision; `deriveModelDisplayLabel` on the live ugly id → `bge-m3-f16`; dims probe writes via accepted-marker; R5 churn test (bulk move + concurrent claim, zero stranded); R6 confirm gate; R3 status branches reachable. WP-4: container starts, `/v1/models` lists aliases, `/v1/embeddings` + `/rerank` answer against the co-resident group, GPU assertion still fatal on llvmpipe-only.

## Critical Files

`src/settings/{sections/ai.ts, modelCapabilities.ts, modelCatalogBrowser.ts (new)}`; `src/suggesters.ts`; `src/providers/{openaiCompatible.ts, shared.ts}`; `src/types.ts`; `src/frontmatter.ts`; `src/orchestration/JobStore.ts`; `src/commands.ts`; `docker/llamacpp-vulkan/**` (+ new llama-swap assets); `context-control/compose.home.yml`; `docs/local-inference.md`.

## Assumptions

1. OpenRouter's `/api/v1/embeddings/models` shape as probed live 2026-07-26 (27 models; `name`, `context_length`, `output_modalities` present; no dimensions field — dims stay probe-or-manual).
2. llama-swap facts verified from upstream README/wiki/releases 2026-07-26 (v243; config keys; `/rerank` + `/v1/rerank` + `/v1/models` routing; ≥v242 required for the TTL-deadlock fix). Still assumed, smoke-tested in WP-4: `/api/v0/models` 404s fast; ttl unload returns VRAM fully; chat-evicts-retrieval interleave is safe under RADV (tested at WP-6 before the old services are deleted).
3. The dimension-probe embed call is acceptable UX as an explicit button (may cold-load a model).
4. R5 direction (a) unless the worker's investigation says otherwise; stop-at-diagnosis applies.
5. eval-harness archive holds the measurement ground truth for WP-5's speedup-number reconciliation.
6. llama-swap config aliases will be matched to the live `data.json` stored model ids at WP-4 authoring so the WP-6 plugin migration is base-URL-only.

**Total ≈ 2.0 kSLOC, ~1.23M raw tokens; ~1.1M Claude-path / ~0.8M Codex-path Opus/Sol-equivalent tokens** (model-cost.mjs: 8 dispatched WPs to Sonnet/Terra with per-dispatch overhead, WP-6 direct on the orchestrator).
