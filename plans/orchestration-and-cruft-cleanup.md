# Orchestration reconciliation + cruft cleanup

> Part 6 of 6 of the architectural cruft sweep. RUN LAST — it touches files the other units restructure.
> Behavior-preserving (or behavior-hardening) only.

## Context

Final pass to reconcile the two parallel queue systems, tighten job-state writes, and remove debug/dead
code left across `src/`. Sequenced last because the earlier units rewrite some of these files.

## Verified items

- **Two queue systems.** `src/orchestration/EnrichmentQueueService.ts` (237) is an in-memory, YouTube-only
  enrichment queue with its own rate limiting and lifecycle (`autoEnabled`, `draining`, `kickDrain`). It
  never touches `JobStore` — it sits beside the `Orchestrator`/`JobStore` vault-backed queue. The two
  unrelated queues are confusing.
- **JobStore atomicity.** `src/orchestration/JobStore.ts` transitions state via read → mutate frontmatter →
  write. A failure mid-flight can leave a job moved-but-not-updated.
- **Debug/dead code.** 15 `console.*` calls across `src/` (commit 4320fcf added localize debug output) plus
  commented-out blocks.
- **`main.ts` `onload`.** ~347 lines (69–416). main.ts is otherwise a healthy command-registration hub
  (`registerCrucibleCommand` / `register(...)`), so this is optional polish, not a god-object fix.

## Tasks

1. **Enrichment queue.** Decide: fold `EnrichmentQueueService` into the `Orchestrator`/`JobStore` model, OR
   — if its in-memory, YT-only nature is intentional — keep it but (a) document the rationale in `AGENTS.md`
   `## Quirks`, and (b) make it share the rate-limit primitive in `src/orchestration/utils/rateLimit.ts`
   instead of a private reimplementation. Do not force a merge that adds coupling; the goal is to remove the
   "why are there two queues" confusion.
2. **JobStore atomicity.** Make the read→mutate→write transition fail safely so a job is never left moved but
   un-updated. Small, targeted change.
3. **Debug/dead code.** Remove the 15 `console.*` calls (especially the localize debug from 4320fcf) or route
   them through one gated `debug()` helper. Delete commented-out blocks.
4. **(Optional) `main.ts onload`.** Split the ~347-line `onload` into the grouped `registerX()` calls it
   already uses elsewhere — only if it doesn't add indirection. Skip if it isn't a clear win.

## Guardrails

- No file over 1000 lines.
- Items 1–2 are behavior-hardening; keep observable behavior the same on the success path.
- Reuse the canonical `rateLimit` util — no new rate-limit reimplementation.

## Verification

- `npm run build` clean; `npm run lint` clean.
- `grep -rn "console\." src/` returns nothing (or only the single gated helper).
- Smoke test: open the ingestion dashboard, run one tracker job and one chain, with no console noise; confirm
  enrichment still drains and jobs reach `done`/`failed` correctly.

## Final sweep checklist (whole project, after all 6 units)

- `wc -l src/**/*.ts` shows **no file over 1000 lines**.
- `npm run build` + `npm run lint` clean.
- Real-vault smoke: settings load + persist, dashboard renders all sections, youtube + blogs tracker jobs
  produce unchanged intake notes, a provider completion succeeds.
- `AGENTS.md` `## Quirks` updated with any non-obvious gotchas surfaced during the sweep.
