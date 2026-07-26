# Sprint-audit remediation — deferrable findings from the 2026-07-26 closure audit

*Recommended model/effort — Claude: Sonnet/medium throughout; Codex: Terra/medium throughout.*

Deliberately **unregistered** in `INITIATIVE.md` (user routes implementation, per the review-plan
convention). Source: the read-only sprint-closure audit (`runs/dispatch/wp-se1-audit-report.md`,
Fable agent, 2026-07-26). The audit's closure-relevant findings F1–F6 and broader items B1, B2 and
B7(a) were absorbed into the active sprint (`plans/sprint-exit-queue-health-and-scrub.md`: F1/F5 →
WP-3, F2/F3/F6/B1/B2/B7a → WP-2, F4 → WP-6) and are **not** repeated here. What remains is real
but deferrable.

## Context

A targeted audit of the queue/orchestration system and the past-day surface (search companion,
providers probing, settings, GPU socket units) found six closure-relevant defects — all folded
into the running sprint — plus the items below, none of which block the sprint. The audit also
produced an explicit checked-and-clean list (JobStore move rollback, cancellation core,
MemoryJobQueue claim atomicity, companion vault isolation and schema-5 migration, coverage-skip
rules, the D2 capability state machine, GPU entrypoint assertions); do not re-audit those
surfaces without cause.

## Key Changes

**WP-R1 — Memory queue hygiene: terminal sweep + honest synthetic status (~0.15 kSLOC, ~100k tokens, ~8 min wall).**
B4: `MemoryJobQueue.sweepTerminal` runs only in `runEntry`'s `finally` (`MemoryJobBackend.ts:117`),
so a quiet queue's terminal entries outlive `terminalRetentionMs` indefinitely, and a lingering
`failed` entry suppresses its auto-source re-seed far past the advertised 60s retention. Add a
sweep-on-refill (or a small periodic sweep owned by the backend). B5: `MemoryJobBackend.enqueue`
returns a synthetic job stamped `status: 'running'` for a pending entry (`:49` via `synthJob`,
`:137`) — callers only truth-test today, but the first caller that renders it inherits a lie;
stamp the real state. Files: `src/orchestration/MemoryJobBackend.ts`, `MemoryJobQueue.ts`, tests.
*Execution: subagent.*

**WP-R2 — `stopJob` claim-window honesty (~0.1 kSLOC, ~80k tokens, ~6 min wall).**
B3: between `claimNext`'s rename and `running.begin` (`OrchestrationAutoRunner.ts:91-98` — a
window that includes `store.move`'s frontmatter write, up to ~2s under the cache barrier), a job
is in neither the queued listing nor the running registry, so `stopJob` reports `'not-found'` for
a job the user then watches start. UI honesty fix only: track claims-in-progress (e.g. a small
claiming-set consulted by `stopJob`) or re-check after the window. Files:
`src/orchestration/OrchestrationAutoRunner.ts`, tests. *Execution: subagent.*

**WP-R3 — Provider clients: retire the dead status branches (~0.25 kSLOC, ~150k tokens, ~12 min wall).**
B6: the provider HTTP clients share the F1 pattern — `response.status !== 200` checks after a
default-throw `requestUrl` (`openaiCompatible.ts:115,138,201,233,306,369`, plus
`anthropic.ts`/`google.ts`/`ollama.ts`). Mostly benign today (probe paths wrap in try/catch), but
the crafted error messages that include response bodies never fire, so a 429/quota body from
OpenRouter surfaces as a bare "Request failed, status 429". Sweep with `throw: false` + explicit
status handling, preserving each client's existing error-type contract. Note: the sprint's WP-8
(visible probe errors) benefits but does not depend on this. Files: `src/providers/*.ts`, tests.
*Execution: subagent.*

**WP-R4 — Socket-activation timeout interaction: document and guard (~0.1 kSLOC, ~70k tokens, ~5 min wall).**
B7(b): a post-idle first request to the GPU services pays up to ~120s inside `ExecStartPre`; fine
under the default 600s job timeout, but a user-lowered `orchestrationAutorunTimeoutSeconds` below
~150s turns every post-idle first embed batch into a **failed** (not deferred) job. Guard: warn in
the settings UI below a floor (or clamp with copy), and document the interaction in
`docs/local-inference.md`. Minor rider: `crucible-inference-ctl`'s `docker logs --tail 40
"$service"` assumes container name == compose service name — verify `container_name` is pinned in
`context-control/compose.home.yml` or derive the name. Files: settings section for orchestration
timeouts, `docs/local-inference.md`, `docker/llamacpp-vulkan/crucible-inference-ctl`.
*Execution: subagent.*

**WP-R5 — Job claims strand under bulk queue churn: make the claim write crash-consistent (~0.2 kSLOC, ~150k tokens, ~12 min wall).**
Observed live during SE WP-7 ops (2026-07-26, ~18:04:45–18:05:09Z): while `requeueServiceFailures`
moved 2,022 jobs (each a rename + frontmatter rewrite), six concurrent runner claims stranded with
the exact known silent-drop signature — file renamed into `running/` but frontmatter still carrying
the *source* bucket's `status: queued` and `updated` stamps. Root cause is the recurrence class,
not a new bug: `JobStore.move` routes through `updateFrontmatter`, whose stale-cache write barrier
waits a bounded ~2s for `metadataCache` to settle — a 2,000-file churn burst keeps the cache stale
far longer than that, the barrier writes anyway, and the claim's `status`/`updated` mutation is
dropped against a stale `frontmatterPosition`. The strays are recoverable (`Orchestrate: scan
queue` stale-running recovery bounces them), so severity is hygiene-not-loss, but every future bulk
move op re-mints them. Fix directions to evaluate (chokepoint, not per-call): (a) in
`updateFrontmatter`, when the barrier times out, fall back to an index-spliced `vault.process`
write (never `String.replace`) instead of a `processFrontMatter` against a known-stale position;
(b) or have `JobStore.move` verify `status` landed via raw re-read and retry once after cache
settle; (c) or pause the auto-runner drain while a bulk repair flow is mid-move (the repair op
already owns "one emitQueueChanged at the end" semantics). Files: `src/frontmatter.ts`,
`src/orchestration/JobStore.ts`, `src/orchestration/failedJobRepair.ts`, tests. *Execution:
subagent.*

**WP-R6 — Destructive index rebuild needs a confirm gate (~0.05 kSLOC, ~60k tokens, ~5 min wall).**
Observed live during SE WP-7 ops: `Search: rebuild index` (`search-rebuild-index` in
`src/commands.ts`) enqueues `search_rebuild`, whose workflow calls `resetIndex()` — dropping the
entire FTS + vector index — with no confirmation, no mention of the reset in the command name, and
no hint that the non-destructive repair (`SearchEmbedMissingWorkflow`, which exists precisely so a
backfill "must never call resetIndex()") is the right tool for coverage repair. A user (or an
orchestrator) reaching for "verify/repair the index" gets a full ~15-minute re-embed instead of a
no-op sweep. Fix: route the command through `ConfirmModal` (the fleet pattern for destructive bulk
ops, per the orphaned-attachments precedent) with copy naming the reset and pointing at the
backfill alternative; consider renaming to "Search: reset and rebuild index". Files:
`src/commands.ts`, possibly `src/confirmModal.ts` copy, tests. *Execution: subagent.*

## Verification

Repo gates per `AGENTS.md` (lint, tsc, `npm test`, production build, the `console.` grep with
`-a`, `file` on edited files). Per-WP test additions named above.

**Total ≈ 0.85 kSLOC, ~610k raw tokens; ~420k Claude-path / ~355k Codex-path Opus/Sol-equivalent tokens.**
