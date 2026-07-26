# Sprint exit: queue service health, probe-default UX, validity audit, runs/ history scrub

*Recommended model/effort — Claude: Opus/high for WP-2, Sonnet/medium for WP-3–6 and WP-8–11, Fable for WP-1 (user-authorized) and the direct WP-7/WP-12; Codex: Sol/medium-high for WP-2, Terra/medium for the mids, Sol/high for WP-1.*

## Context

The 2026-07-25 sprint (semantic vector leg → embedding-space identity → queue control/model probing → ESI Stage 2 measurements) kept looping because each measurement run exposed defects in the layer under it. The user's decision stands: **build the correct solution now rather than keep building on an unreliable foundation.** This plan is the single exit document: it sequences the decided queue-service-health build, folds in the user's feedback list, explicitly defers everything else, and ends with the history scrub the public-repo defect requires.

**Established state (audited this session, do not re-derive):**
- origin/master == local master (71cae0b) — **everything is pushed**, including all of `runs/` (1.4 MB, 52 commits touch it; `samples/S2-queries.json` contains vault-derived text and is public right now; raw vault-chunk samples were never committed).
- Queue: inbox 52 (all `search_upsert_batch`, drain dead), running 1 (stuck, `status: queued` inside `running/`), failed 2,029 — **2,022 are one companion outage** (`ERR_CONNECTION_REFUSED`), 7 genuine. Those 2,021 upsert_file jobs' files are silently missing from the index.
- Live index healthy: 22,885 embedded of ~52,627 chunks, single clean space `bge-m3`, schema 5, 0 unattributed.
- Prior plans: QCP WP-A–E all landed; ESI plan fully landed (its `pending-plans` entry is stale); vector-leg WP-7 (backfill completion) open; search follow-up plan WP-1–5 all open (plan-only).
- **systemd verdict: no cruft.** The 4804/4805 socket units are git-tracked in `docker/llamacpp-vulkan/systemd/` with `install.sh`, referenced from `context-control/compose.home.yml:544-557`; workloads are fleet containers. Only nuance: activation units live in this repo, not context-control (documented seam, user may relocate later — out of scope). `ollama.service` (system scope) is pre-existing, predates the sprint.
- Queue architecture verdict (design agent, file-grounded): **sound** — service health bolts on at `WorkflowResult` (already has `'deferred'` + `failureReason`), `JobTypeConfig`, and the AutoRunner drain choke point. One latent bug found: `MemoryJobBackend.runEntry` silently marks a `'deferred'` result **done** (memory jobs cannot defer today).

## Decisions locked (user-confirmed 2026-07-25/26)

1. **Correct solution first**: queue service health lands before the backfill/repair is re-run.
2. **Scrub all of `runs/`** (measurements + dispatch briefs) from git history; force push at the END, after the sprint is sorted. **The user runs the push** — the never-push rule stands.
3. **Archive home**: a new tool/folder in `/home/_shared_code/eval-harness` — measurement data becomes blog-post source there; future run artifacts land there, never in this repo.
4. **Probe-default UX**: amend QCP D2 — picking a model from the fetched catalog **auto-applies** probed values (badge + undo = manual fallback); catalog auto-fetches on section render when absent; background fetches still never write.
5. **Audit instead of formal tn-code-review**: one fresh Fable-class agent, read-only, targeted at findings **immediately relevant to closing this sprint**; closure-relevant findings roll into this plan's WPs, broader issues go to a remediation plan doc for a later session (registration left to the user, who routes implementation).
6. Standing: FEEDBACK.md never written/staged; stage by path; subagents never commit; leave the 11.4 GB cache volumes (ask again before deleting); gates scope to the diff.

## Summary

Five phases, strictly ordered: **(0)** targeted audit + probe-semantics fix start immediately; **(1)** the queue-service-health build (registry/breaker → classification → repair tooling) plus the honest-embedding-config fix; **(2)** operational repair — heal the stuck job, requeue the 2,022, finish the backfill, close vector-leg WP-7; **(3)** the UX/docs items from the feedback list (probe-default, rerank affordance, guide setups, validity audit); **(4)** archive export + history scrub + force-push handoff. Everything not listed is explicitly deferred (see Deferred, below) so the sprint has a defined end.

## Key Changes

**WP-1 — Targeted sprint-closure audit (~0 kSLOC, read-only, ~200k tokens, ~15 min wall).** Fresh agent audits the queue/orchestration system plus the past-day surface (companion vector code, providers probing, settings ai.ts, socket/docker scripts) for defects that would undermine THIS sprint's closure — mis-classified error paths, drain/wake races beyond the three known, vault-isolation edges, resource leaks. Output: findings report; orchestrator folds closure-relevant items into WP-2–7 briefs, writes broader items to `plans/sprint-audit-remediation-2026-07-26.md` (unregistered — user routes it). *Model: frontier (Claude Fable — user-authorized; Codex Sol/high). Execution: fresh subagent both paths (fresh eyes are the point; a fork shares my priors).* No dependencies; runs in parallel with WP-3.

**WP-2 — Service-health registry, breaker, drain integration (~0.9 kSLOC incl. tests, ~350k tokens, ~27 min wall).** New `src/orchestration/serviceHealth.ts`: `ServiceHealthRegistry` with hysteresis (3 consecutive failures opens; `refused` counts double; any success closes), exponential open window (30s→10min cap; 429 `retryAfterMs` overrides), half-open single-flight probe token (the first claimed job IS the probe), `onTransition` + `tick()`; in-memory only (persisting breaker state risks wedging a healthy service after reload). `RunOutcome` gains `'blocked'` — a service-level deferral must stop the type's drain, killing the 40-jobs/s claim-defer-rewrite sweep. `JobTypeConfig.services?: ServiceId[]`. AutoRunner checks `servicesHealthyFor(type)` before claiming, subscribes to transitions in its constructor (cannot be absent from its own subscription), and adds a 60s `tick()` + `kickAll()` backstop interval — retiring the single-replaceable-timer / optional-chained-kick recovery hazard. Fixes the found `MemoryJobBackend` bug via `MemoryJobQueue.releaseToPending(key)` so memory jobs can defer. Manual `runJob`/`runType` deliberately bypass the breaker (a click is intent, and a manual probe). Files: new `serviceHealth.ts`; `types.ts`, `JobBackend.ts`, `jobTypeConfig.ts`, `Orchestrator.ts`, `OrchestrationAutoRunner.ts`, `FileJobBackend.ts`, `MemoryJobBackend.ts`, `MemoryJobQueue.ts`, `main.ts`; new `tests/serviceHealth.test.mjs`, `tests/drainBreaker.test.mjs`. *Model: top (Claude Opus/high; Codex Sol/medium-high) — cross-cutting core with concurrency semantics. Execution: subagent both paths (calc: 50% saving, dispatch ≥ wash).* Depends only on WP-1's findings review (brief-level, not code).

**WP-3 — Probe semantics: the search WP-5 residue (~0.3 kSLOC, ~160k tokens, ~12 min wall).** All search-local: typed `kind` (`refused|timeout|server-error`) on `SearchServiceUnavailableError` at the client choke point; `probe()` latches 5-min offline only on `refused`/HTTP-error — a timeout is transient with gate-level hysteresis; dedicated background health-probe timeout (~15s; interactive 5s stays UI-only); never probe/latch while our own bulk indexing is in flight (SearchManager flush-window flag — a timeout in that window is inconclusive by construction); `markOffline(null)` stops rendering "go start the container"; companion `/health` must not queue behind a flush (`scripts/search-companion.mjs`). Amend `plans/search-space-key-and-query-logging.md` WP-5 in the same commit: the circuit-breaker tail moves to this plan's WP-2 (reference it), the probe-semantics piece is this WP. Files: `src/search/lifecycleGate.ts`, `client.ts`, `types.ts`, `SearchManager.ts`, `scripts/search-companion.mjs`, `tests/searchLifecycleGate.test.mjs`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium) — diagnosis complete. Execution: subagent (70% saving).* Independent; must land before WP-4 (which consumes the error `kind`).

**WP-4 — Workflow error classification (~0.5 kSLOC, ~220k tokens, ~17 min wall).** `WorkflowResult.serviceUnhealthy?: { service, kind, reason }` (only with `status: 'deferred'`; a service-level failure NEVER returns `'failed'`). SearchIndexWorkflow deferrals name `search-companion`/`search-embedder`. New `YoutubeApiUnavailableError { kind, retryAfterMs? }` in `utils/youtubeApi.ts` for network/5xx/429/403-quota (quota → long retryAfter); 404-video, 403-bad-key (existing `'no-api-key'`), malformed JSON stay job-level. `FeedTrackerWorkflow`'s all-feeds-failed branch → deferred + `youtube-rss` (blogs feeds span arbitrary hosts — explicitly out of scope). LLM-backed workflows get the `llm:<providerId>` service id seam but classification lands later. Workflows never call the registry — backends report from the result, keeping workflow tests registry-free. Files: `SearchIndexWorkflow.ts`, `utils/youtubeApi.ts`, `YoutubeMetadataFetchWorkflow.ts`, `YoutubeChannelEnrich*.ts`, `FeedTrackerWorkflow.ts` + test extensions. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: subagent.* Depends on WP-2 + WP-3.

**WP-5 — Retroactive repair + visibility (~0.4 kSLOC, ~200k tokens, ~15 min wall).** New `src/orchestration/failedJobRepair.ts`: `classifyFailedJob` against a conservative pattern table (`ERR_CONNECTION_REFUSED`, companion unreachable/5xx, YT quota/5xx, `All \d+ channel feeds failed`) — the 7 genuine failures match nothing; `requeueServiceFailures({ dryRun })` moves matches back to `queued/`, clears `fm.error` (new `JobStore.clearError`), yields every ~20 moves, ONE `emitQueueChanged` + `kickAll` at the end. Command `Orchestrate: Requeue service-outage failures` through `ConfirmModal` with dry-run breakdown; queue-monitor gains service-health pills (`registry.snapshot()`; status pill when open/half-open, neutral when closed — fleet pill taxonomy) and the requeue button. Forward-looking: `failEntry` stamps `fm.failureKind: 'service'` so future sweeps don't need string patterns. Files: new `failedJobRepair.ts`; `JobStore.ts`, `main.ts`, queue-monitor section, `FileJobBackend.ts`; new `tests/failedJobRepair.test.mjs`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium) — destructive-ish bulk op but well-specified. Execution: subagent.* Depends on WP-2 only (parallel with WP-4).

**WP-6 — A broken embedding configuration must fail loudly (~0.3 kSLOC, ~170k tokens, ~13 min wall).** The search plan's WP-3, unchanged in scope, pulled into this sprint because it blocks a trustworthy backfill: an orphaned `{providerId, modelId}` ref currently passes `activeEmbeddingModelId()` and silently degrades every rebuild batch to FTS-only (35 of 55 batches reported `done` with zero embeddings). Resolve the ref at config time, fail the batch (not the vault) at index time, surface in settings. Files per that plan: `src/search/SearchManager.ts`, `src/settings/sections/ai.ts`, `src/types.ts`, new `tests/searchEmbeddingConfig.test.mjs`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: subagent.* Independent; must land before WP-7.

**WP-7 — Operational repair and backfill completion (ops, ~30k tokens direct, ~60 min wall mostly machine time).** Orchestrator-direct, after WP-2–6 are green and committed: (1) `Orchestrate: Scan queue` to re-home the stuck `running/` job; (2) dry-run then execute the requeue of the 2,022; triage the 7 genuine failures (2 video-not-found stay failed; the youtube_tracker all-feeds-failed one requeues; inspect the rest); (3) resume the rebuild/backfill to completion (~29,700 chunks; expect ~24 chunks/s fresh, ~11–12 on coverage-skip repair passes; watch with the index-rate monitor — a probe-timeout latch recurring here means WP-3 failed its purpose); (4) verify coverage: embedded == corpus chunk total, one space, then close vector-leg **WP-7** and de-register `[[semantic-vector-leg-and-reranker]]`. *must-direct: live vault ops + user-visible state; no code.* Depends on WP-2–6.

**WP-8 — Probe-first becomes the default (D2 amendment) (~0.35 kSLOC, ~180k tokens, ~14 min wall).** Per the gap analysis: (1) auto-apply `deriveCatalogSuggestion` in `ProviderModelSuggest.onChoose` (ai.ts:315) so picking a catalog model prefills capabilities/precision — existing probe-accepted badge + undo is the fallback; (2) lazy `listModels` on section render when `modelCatalog` absent (await before `tab.display()`); (3) broaden `inferCapabilities` to read `inputModalities`/`supportedParameters` (OpenRouter image → `image-extraction`) and route `describeModel().precision` into an `embeddingVariant` suggestion so non-LM-Studio kinds get non-empty suggestions; parse LM Studio `max_context_length`; (4) promote the cross-encoder warning off debug-gated `logWarn` to a visible settings warning/Notice. Amend QCP plan D2 + acceptance criterion 12 in the same commit ("auto-apply on explicit pick; background fetch never writes"). Files: `src/settings/sections/ai.ts`, `src/settings/modelCapabilities.ts`, `src/suggesters.ts`, `src/providers/openaiCompatible.ts`, `src/providers/ollama.ts`, `src/providers/shared.ts`, QCP plan doc. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: subagent.* Independent.

**WP-9 — Rerank button affordance (~0.15 kSLOC, ~90k tokens, ~7 min wall).** Render the rerank control disabled (not hidden) when unconfigured, reusing the existing dead guard copy in `SearchManager.rerank()`; clicking opens Crucible settings on the right sub-tab — add an optional initial-tab param to `CrucibleSettingTab` (`activeTab` is private/hardcoded today; scroll-host plumbing exists at settings.ts:57-66). Files: `src/search/SearchModal.ts`, `src/settings.ts`, `src/main.ts`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: subagent.* Independent, lowest priority of the code WPs.

**WP-10 — Guide: concrete plugin-user setups (~0.2 kSLOC docs, ~110k tokens, ~8 min wall).** Extend `docs/local-inference.md` with copy-paste setups for plugin users: LM Studio (openai-compatible, `/v1` suffix), Infinity CPU containers (compose), the in-repo llamacpp-vulkan container + socket activation (`docker/llamacpp-vulkan/`), ollama — each with its measured gotchas already recorded in AGENTS.md/the guide. Publishing prebuilt images is explicitly NOT decided here (defer; note the option). *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: subagent.* Independent; docs-only gates.

**WP-11 — Findings validity audit (~0.1 kSLOC scripts, ~150k tokens, ~12 min wall).** Answers "are the data/findings even valid?" with evidence: recompute every published headline in `docs/local-inference.md` + the AGENTS.md measurement quirks directly from the `runs/measurements/esi-fr-2026-07-25/` artifacts; classify each claim ground-truthed (n≥50 / 61-article set) vs single-sample vs superseded; flag the known holes (paired raw-endpoint E1 arm never ran, so the plugin/raw ratio is unverified; D1 rerank mode unmeasured; E1 ran with GPU background consumers). Output: validity memo shipped WITH the archive (WP-12), plus corrections to docs if any number fails to reproduce. *Model: mid (Claude Sonnet/medium; Codex Terra/medium) — arithmetic against artifacts, no judgment calls. Execution: subagent.* Must complete before WP-12 exports/scrubs.

**WP-12 — Archive export + history scrub + force-push handoff (~0 kSLOC repo code, ~100k tokens direct, ~30 min wall).** *must-direct: destructive history rewrite + cross-repo landing + user coordination.* (1) Create the eval-harness tool dir (proposed `eval-harness/local-inference-bench/` — user may rename): full `runs/` working-tree export + untracked `E1-plugin-pass.json` + WP-11's validity memo + a README naming the blog-post intent; commit in eval-harness by its own rules (stage by path; its FEEDBACK.md is user-owned). (2) In obsidian-crucible: `git bundle create` full backup; set aside the dirty FEEDBACK.md (stash-apply procedure per commit skill — filter-repo needs a clean tree); `git filter-repo --path runs/ --invert-paths --force`; restore FEEDBACK.md byte-identical; verify (no `runs/` anywhere in history, tree diff vs pre-scrub HEAD empty outside runs/, commit count sane); re-add the origin remote (filter-repo strips it); add `.gitignore` entry `runs/` + an AGENTS.md line "measurement artifacts land in eval-harness, never this repo"; commit. (3) Hand the user the exact command: `git push --force-with-lease origin master` — **the user runs it**; note GitHub may retain cached blob views of the old SHAs (S2-queries held vault-derived text) — contacting GitHub support to gc is the user's call. Depends on WP-11 and on every other WP being landed (this is the last act of the sprint).

## Execution

```
WP-1 (audit, Fable) ──┐  findings fold into briefs
WP-3 (probe semantics)─┼─► WP-2 (registry/breaker) ──► WP-4 (classification) ─┐
                       │                    └────────► WP-5 (repair+pills) ───┼─► WP-7 (ops repair,
WP-6 (loud embed cfg) ─┘                                                      │    direct)
WP-8 / WP-9 / WP-10 / WP-11  (independent, any time, parallel)  ──────────────┤
                                                              WP-11 ─► WP-12 (scrub, direct, LAST)
```

- One commit per WP, orchestrator reviews diff + re-runs gates verbatim, lands on local master unpushed. Pause for user compaction at WP boundaries per orchestration skill.
- Ask-before-dispatch stands for each subagent wave (wave 1: WP-1 + WP-3 + WP-6; wave 2: WP-2; wave 3: WP-4 + WP-5 + the independents).
- WP-12 runs only when the user says the sprint is sorted.

## Deferred / killed (explicit, so the loop ends)

- Search plan **WP-1** (portable space keys), **WP-2** (query logging), **WP-4** (index inspection dashboard) — stay registered in the search plan; not this sprint. (WP-4 loses urgency: the live index is a single clean space; repair is via WP-6/WP-7.)
- ESI leftover arms: paired raw-endpoint E1, D1 rerank mode, B2/B5/A4, ollama `OLLAMA_VULKAN=1` — optional blog work, recorded in the WP-11 memo; not sprint work.
- CPU embedder/reranker container cleanup + the 11.4 GB cache volumes — post-sprint, context-control session, **ask before deleting**.
- `context-control/compose.home.yml:450` stale "6x/24x" speedup claim — fix in that post-sprint context-control session.
- systemd unit relocation to context-control — user decision, documented seam, no action.
- Publishing prebuilt inference container images — noted as an option in WP-10, not decided.
- G20 hosted-API baseline — still requires explicit user consent; untouched.

## Public Interfaces

| Surface | Change |
|---|---|
| `WorkflowResult.serviceUnhealthy?` | New optional `{ service, kind, reason }`; only with `'deferred'` |
| `RunOutcome` | Gains `'blocked'` (dependency unhealthy → stop the type's drain) |
| `JobTypeConfig.services?` | New `ServiceId[]` dependency declaration |
| `ServiceHealthRegistry` | New (`src/orchestration/serviceHealth.ts`), in-memory, plugin-owned |
| `MemoryJobQueue.releaseToPending` | New running→pending transition (fixes deferred-means-done) |
| `SearchServiceUnavailableError.kind` | New `'refused' \| 'timeout' \| 'server-error'` |
| Command `Orchestrate: Requeue service-outage failures` | New, ConfirmModal + dry-run |
| `JobStore.clearError` / `fm.failureKind` | New helper + failed-job stamp |
| `CrucibleSettingTab` initial-tab param | New (rerank deep-link) |
| QCP plan D2 | Amended: auto-apply on explicit pick |
| Repo history | `runs/` removed; `.gitignore` + AGENTS.md note; force push by user |

## Test Plan / Verification

Gates per repo standard after every code WP (sequential, never backgrounded): `npm run lint`; `npx tsc -noEmit -skipLibCheck`; `npm test` (baseline **520/520**); `node esbuild.config.mjs production`; `grep -rna "console\." src/` (only `src/log.ts`; `-a` load-bearing); `file` on every edited file (three raw-NUL shippings). nvm prefix: `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"`.

Load-bearing new tests: breaker opens after ≤3 service deferrals and **zero** jobs land in `failed/`; open breaker → zero claims in a drain pass; a pending queue with no further enqueues drains after recovery via transition kick AND via the 60s interval alone; `'blocked'` ends the type worker; memory entry released to pending, never `markDone`; repair pattern table matches all outage signatures and none of the 7 genuine ones; dry-run mutates nothing; orphaned embedding ref fails loudly at batch level; probe timeout during an in-flight flush latches nothing.

WP-7 end-state check: `/health` embedded == corpus total, one space, queue inbox/failed drained of the cohort. WP-12 check: `git log --all -- runs/` empty; tree identical outside `runs/`; origin re-added; user holds the push command.

## Critical Files

`src/orchestration/{serviceHealth.ts (new), types.ts, JobBackend.ts, jobTypeConfig.ts, Orchestrator.ts, OrchestrationAutoRunner.ts, FileJobBackend.ts, MemoryJobBackend.ts, MemoryJobQueue.ts, JobStore.ts, failedJobRepair.ts (new)}`; `src/orchestration/workflows/SearchIndexWorkflow.ts`, `utils/youtubeApi.ts`, `FeedTrackerWorkflow.ts`; `src/search/{lifecycleGate.ts, client.ts, SearchManager.ts, SearchModal.ts}`; `scripts/search-companion.mjs`; `src/settings/{sections/ai.ts, modelCapabilities.ts}`, `src/suggesters.ts`, `src/settings.ts`; `docs/local-inference.md`; `plans/{search-space-key-and-query-logging.md, queue-control-model-probing-vault-isolation.md}`; `runs/` (exported then scrubbed).

## Assumptions

1. `git filter-repo` is installed or installable (`pipx install git-filter-repo`); it strips the origin remote (re-add) and requires `--force` on a non-fresh clone. Full `git bundle` backup precedes it.
2. Old SHAs remain fetchable on GitHub until gc; if the S2-queries exposure matters beyond removal-from-history, GitHub support contact is the user's call (noted in WP-12 handoff).
3. eval-harness is private (self-hosted gitolite remotes); the archive tool-dir name `local-inference-bench` is a proposal, user may rename at WP-12.
4. Blogs feed failures keep today's behavior (no single service identity); LLM provider classification (`llm:<providerId>`) is seam-only this sprint.
5. Breaker state is deliberately not persisted; a reload during an outage costs ≤3 deferrals, zero failures.
6. The harness scripts (`scripts/dseries-*.mjs`, `embedding-quality.mjs`, `index-rate-monitor.mjs`) stay in this repo — they're referenced by npm scripts/AGENTS.md and contain no measurement data. Only `runs/` data moves.
7. Vector-leg WP-7 closes inside this plan's WP-7; `[[semantic-vector-leg-and-reranker]]` de-registers there. The search plan stays registered for its deferred residue.

**Total ≈ 3.1 kSLOC, ~1.96M raw tokens; ~2.2M Claude-path / ~1.5M Codex-path Opus/Sol-equivalent tokens** (model-cost.mjs: WP-2 dispatch-to-Opus 390k; mid-WP wave dispatch-to-Sonnet ≈1.09M incl. per-dispatch overhead; WP-1 Fable worker 440k; direct WP-7+WP-12 ≈260k).
