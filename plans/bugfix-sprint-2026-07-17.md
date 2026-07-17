# Bugfix Sprint — Secret Visibility, Queue Monitor Controls, Localize Exclusion, News-Chain Lint

*Recommended model/effort — Claude: Opus/high for WP-2 & WP-4 (shared drain contract; note-lock semantics), Sonnet/medium for WP-1 & WP-3; Codex: Sol/medium-high for WP-2 & WP-4, Terra/medium for WP-1 & WP-3.*

## Context

Diagnosing the YouTube-enrichment outage (see `plans/diagnose-youtube-enrichment-silent-failure.md`) surfaced a class of latent problems worth a focused sprint:

- **Secrets vanished silently.** An Obsidian update ~2026-07-07 wiped `app.secretStorage` (confirmed empty via `listSecrets()` — every key gone, incl. OpenRouter), and nothing in the plugin noticed. The plugin should track which secrets it stored and warn when they disappear out from under it.
- **The enrichment queue drains with both "Auto…" toggles off.** Memory-backed job types set `drainsWithoutAutorun = true`, so enrichment drains regardless of Autorun; Auto-enrich only stops the auto-source *refill*. To a user who turned both off, continued draining reads as a bug — and it revives a dropped dev item: per-job-type Queue Monitor controls (auto-run, run-next, rate-limit).
- Two pre-existing defects ride along: a Localize exclusion gap (can't lint-but-not-localize a folder of external images) with a broken Excluded-folders settings UI, and the "Ingest as News" chain consistently failing its lint step after the move step.

## Decisions locked (user-confirmed)

- **Queue semantics (WP-2):** each "Auto"-named toggle must actually stop the work it names; turning both off must idle the queue. Scope expands to the dropped **per-job-type Queue Monitor controls** (per-type auto-run, run-next, rate-limit). Manual/on-demand runs still allowed.
- **Localize (WP-1):** ship the **per-folder localize exclusion** + **fix the Excluded-folders settings UI** (add column headers; stop the toggle sets breaking onto a separate row from the folder name). The "embed external images as inline data URI" idea is **research-only** this sprint — determine whether data-URI image embeds are viable in Obsidian/OFM (and the edit-mode UX cost) and **document the answer**; do not implement.
- **Secrets (WP-3):** plugin-side registry of stored secret keys + reconcile-and-warn when a stored key is missing.

## Summary

Four independent WPs. WP-3 and WP-1 are cleanly isolatable (secret registry; exclusion scope + settings UI). WP-2 touches the drain contract and the Queue Monitor UI. WP-4 is an investigation-first fix in the note-lock / chain path. WP-4 (and the semantic core of WP-2) stay orchestrator-direct because they touch shared concurrency contracts; WP-1 and WP-3 can hand off to a cheaper capable worker.

## Key Changes

**WP-1 — Localize exclusion scope + Excluded-folders UI fix + data-URI feasibility note (~0.5 kSLOC, ~180k tokens).** Add a third `ExclusionScope` `'localize'` to `ExcludedFolder` (`{folder, lint, search, localize}`); honor it in `AttachmentLocalizer` (folder/vault/per-note paths) and in the `AutoLocalizeScheduler` via a new `localizeExcluded(path)` dep gate wired from `main.ts`; extend `defaultExcludedFolders`/`dedupeExcludedFolders`/`migrateExcludedFolders` and add a settings migration defaulting existing rows to `localize:false`. Rework the Excluded-folders table in `settings/sections/lint.ts`: add a header row and lay folder-name + the (now three) toggles out as aligned columns instead of the current header-less, wrapping layout. Separately, **research + document** (append to this plan or a short `plans/` note) whether inline `data:` image URIs render in Obsidian/OFM reading+edit modes and the UX tradeoff — no implementation. Files: `src/types.ts`, `src/exclusions.ts`, `src/localizeAttachments.ts`, `src/autoLocalizeScheduler.ts`, `src/main.ts`, `src/settings/sections/lint.ts`, tests. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude subagent (isolated scope; 180k×0.6 = 108k vs 180k direct = 40% saving); Codex subagent (90k vs 180k, 50% saving).*

**WP-2 — Queue Monitor per-job-type controls + drain-respects-toggle (~0.65 kSLOC, ~260k tokens).** Introduce per-job-type control state (persisted, e.g. `orchestrationJobTypeControls[type] = { autoRun, minIntervalMsOverride }`) surfaced in the Ingestion Dashboard's Queue Monitor: an auto-run toggle, a "Run next" button, and an editable rate-limit per type. Fix the semantics so memory/enrichment types **do not drain when their auto-run is off**: `OrchestrationAutoRunner.shouldDrain` must consult the per-type auto-run state rather than the blanket `drainsWithoutAutorun`, and the dashboard must stop kicking `setAutoSource`/`refill`/`kickDrainType` on render when the type is off (`ingestionDashboard.ts` render path was the drain trigger seen in the outage stack). Default the enrichment type's auto-run from the existing Auto-enrich toggle so today's users see the intuitive "off = idle" behavior; on-demand [Enrich]/Run-next still enqueue+run. Files: `src/orchestration/OrchestrationAutoRunner.ts`, `src/orchestration/Orchestrator.ts` + `JobBackend`/`MemoryJobBackend` (per-type gate), `src/orchestration/jobTypeConfig.ts`, `src/ingestionDashboard.ts`, `src/types.ts` (settings), tests. *Model: top (Claude Opus/high — drain-contract + concurrency semantics; Codex Sol/medium-high). Execution: Claude direct (must-direct: shared drain contract, integration + gates); Codex direct (must-direct: same).* 

**WP-3 — Secret store visibility (the class-of-problem fix) (~0.5 kSLOC, ~170k tokens).** A plugin-side registry of stored secret keys (persist a non-secret list in `data.json`, updated on every `setSecret`/clear in `youtubeApi.ts` and `providers.ts`). On startup (and Ingestion-dashboard open), reconcile the registry ∪ config-derived expectations (YouTube key when enrichment is enabled; `crucible-provider-<id>-key` for each configured provider that has models) against `app.secretStorage.listSecrets()`; when a stored/expected key is missing while its integration is enabled, surface a `Notice` and a settings/dashboard indicator ("YouTube Data API key missing — re-enter in Settings"). Turns a silent, cross-integration credential-loss into an immediate signal. Files: new `src/secretRegistry.ts`, `src/orchestration/utils/youtubeApi.ts`, `src/providers.ts`, `src/main.ts` (startup reconcile), a surface in `src/settings/sections/*` or `ingestionDashboard.ts`, tests. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude subagent (isolated; 102k vs 170k, 40% saving); Codex subagent (85k vs 170k, 50% saving).*

**WP-4 — "Ingest as News" chain lint failure (~0.35 kSLOC, ~160k tokens).** Reproduce and root-cause the final `lint-note` step failing after `move-current-file-to-daily-folder`. Two concrete leads: (a) `moveFileToFolder` returns `null` on an existing-target/already-in-folder collision → `wrapMoveResult(null)` = `false` → chain **stops before lint** (`keepGoing:false`); (b) the move renames under `noteLocks.withLock(path,'move-file')` and calls `handleRename(old,new)` mid-lock (nested inside the chain's `withOptionalNoteLock` + the command's `withOptionalNoteLock`), risking a stranded/re-keyed lock so the subsequent same-note `lint` blocks/times out (the note-lock-follows-rename hazard). Confirm which, fix, and add a regression test covering move→lint on one note. Files: `src/main.ts` (`moveFileToFolder`), `src/chains.ts`, `src/orchestration/NoteLockManager.ts`, `src/lint.ts`, tests. *Model: top (Claude Opus/high — note-lock semantics are load-bearing and shared; Codex Sol/medium-high). Execution: Claude direct (must-direct: shared note-lock contract, subtle concurrency); Codex direct (must-direct: same).*

## Public Interfaces

- `ExclusionScope` gains `'localize'`; `ExcludedFolder` gains `localize: boolean` (settings migration required).
- New settings: per-job-type controls map (WP-2); stored-secret registry list (WP-3). Both additive with migrations defaulting to current behavior.
- No changes to the YouTube metadata schema, `data.json` chain format, or ignored-ID formats.

## Execution

- **Order:** WP-3 and WP-1 first (independent, subagent-friendly, no shared-contract risk). WP-2 and WP-4 orchestrator-direct, sequentially (both touch shared concurrency contracts; keep the core green before any parallel handoff).
- **Parallelism:** WP-1 and WP-3 may run in parallel subagents once `master` is green; they share no files. WP-2/WP-4 do not parallelize with each other cleanly (both reason about locks/drain) — run direct, one at a time.
- **Per Hard Rule 1, confirm with the user which subagents to spawn before dispatching WP-1/WP-3.** Subagents never commit; the orchestrator reviews the diff, re-runs gates, commits per-WP.

## Test Plan / Verification

- Gates (every WP, via the project's prescribed commands): `npm run lint`, `npx tsc -noEmit -skipLibCheck`, `npm test` (185 baseline must stay green), `node esbuild.config.mjs production`.
- WP-1: unit-test exclusion matching for `localize`; drive a folder marked localize-excluded — confirm lint still writes frontmatter but the localizer and auto-localize scheduler skip it; visually verify the Excluded-folders table has aligned headers/columns.
- WP-2: with a type's auto-run off, confirm the queue does **not** drain on dashboard render or on a settings change, while "Run next" still executes one job; toggle on and confirm draining resumes.
- WP-3: unit-test reconcile (stored key present/absent); simulate an empty `listSecrets()` and confirm the warning fires for enabled integrations only; re-enter a key and confirm the warning clears.
- WP-4: add a chain test running `move → lint` on one note and asserting the note is linted at its new path with no lock timeout; manually run the "Ingest as News" chain end-to-end.

## Critical Files

`src/exclusions.ts`, `src/localizeAttachments.ts`, `src/autoLocalizeScheduler.ts`, `src/settings/sections/lint.ts` (WP-1); `src/orchestration/OrchestrationAutoRunner.ts`, `src/orchestration/MemoryJobBackend.ts`, `src/ingestionDashboard.ts` (WP-2); `src/orchestration/utils/youtubeApi.ts`, `src/providers.ts`, new `src/secretRegistry.ts`, `src/main.ts` (WP-3); `src/main.ts` (`moveFileToFolder`), `src/chains.ts`, `src/orchestration/NoteLockManager.ts` (WP-4).

## Assumptions

- `app.secretStorage.listSecrets()` exists and returns stored keys (probed working 2026-07-17, sync). If a future Obsidian version drops it, WP-3 falls back to per-key `getSecret` probes of the registry.
- WP-4's root cause is one of the two identified leads; if reproduction shows a third cause, the fix scope holds (same files) but sizing may shift.
- Per-type Queue Monitor controls are additive to the existing Autorun/Auto-enrich toggles, not a replacement — existing toggles remain as the master/default source for their types.

**Total ≈ 2.0 kSLOC, ~770k raw tokens; ~630k Claude-path / ~595k Codex-path Opus/Sol-equivalent tokens.**
