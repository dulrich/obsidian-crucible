# Search index audit, reconcile, and health surfacing

*Recommended model/effort — Claude: Sonnet/medium workers for SA1–SA2, orchestrator
(Fable) closes SA3 direct; Codex: Terra/medium workers, Sol/medium orchestrator.*

## Context

Audit of the search-state surfaces (2026-07-31, Explore-grounded) found that the only
trustworthy "validate everything" operation today is the destructive full rebuild.
Specific gaps: (1) **no audit readout** — nothing compares vault indexable count vs
indexed count, and the companion has **no endpoint that lists indexed paths**
(`/v1/files/state` only echoes paths you ask about), so orphan detection is
structurally impossible client-side; (2) **offline deletions leak chunks forever**
(no vault event fires; no reconcile exists; exclusion changes never retro-purge);
(3) **offline edits/creates are never caught up** (the startup create-replay is
dropped by the readiness gate; `mtime` is stored but never compared); (4) the
companion's rich `/health` payload (embeddedChunks, embeddingSpaces, unattributed,
model, dim) is **discarded by `normalizeHealth`**, so `Search: check service health`
can only say "ok (version)" and a mixed embedding space is invisible; (5) image-
description coverage is only reported by *launching* the vision backfill.

## Decisions locked (user, 2026-07-31)

1. All four audit axes in scope: notes indexed, images described, deletions purged,
   edits picked up.
2. Read-only audit and mutating reconcile are **separate commands** (audit never
   surprises; reconcile enqueues work through existing job types only).

## Summary

Give the companion one additive read endpoint that lists a vault's indexed paths with
per-path state; build a read-only `Search: audit index` command that cross-references
vault ↔ index ↔ image-description store and writes a report; a `Search: reconcile
index` command that enqueues the fixes through existing job types (upsert for
missing/stale, delete-path for orphans); and surface the full `/health` payload in the
health command and the Search settings panel (mixed-space warning included).

## Key Changes

**WP-SA1 — companion: `/v1/paths` endpoint.**
*~0.2 kSLOC · ~180k tokens · ~14 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent (~70% saving); Codex: subagent (~50%)*
New `POST /v1/paths` (`scripts/search-companion/endpoints/paths.mjs` + dispatch entry):
body `{vaultId}` → `{paths: [{path, mtime, contentHash, chunkCount, embeddedCount}],
totals: {paths, chunks, embeddedChunks}}`. Additive — no schema bump, no change to
existing routes. Respect the cooperative deadline shape used by other endpoints.
Tests: companion-level (`tests/searchCompanion*.test.mjs` conventions). **Any grep
over `scripts/search-companion*` uses `-a`; sentinels use the two-character `'\0'`
escape.** Deploy reaches the container only via `home-compose up crucible-search`
(image bakes scripts/ — bare restart runs stale code). Files:
`scripts/search-companion/endpoints/paths.mjs` (new), `dispatch.mjs`, facade export,
tests. NOT in scope: client, purge logic, /health changes.

**WP-SA2 — client: audit + reconcile commands, health surfacing.**
*~0.4 kSLOC · ~280k tokens · ~22 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent · sequential after SA1 (consumes the
endpoint)*
- `SearchLocalClient.listPaths()` + types; widen `normalizeHealth`/`SearchHealth` to
  carry the full payload; `search-health` Notice reports version, schema,
  embeddedChunks, model, and flags mixed `embeddingSpaces`.
- **`Search: audit index`** (read-only, `mutating: false`, registered via
  `registerCrucibleCommand`, group Search): compares `listIndexableFiles()` vs
  `/v1/paths` → missing (in vault, not indexed), orphans (indexed, not in vault —
  includes now-excluded paths), stale (vault `mtime` > indexed `mtime`), embedding
  gaps (`embeddedCount < chunkCount`); plus image-description coverage
  (`computeReferencedImagePaths` vs `imageDescriptions.has`, including failed-record
  count) **without launching a vision run**. Writes a dated report note (the
  `_crucible/debug.md` pattern) + a summary Notice.
- **`Search: reconcile index`**: same computation, then enqueues `search_upsert_file`
  for missing/stale and `search_delete_path` for orphans — existing job types only.
  Registers a new `DESTRUCTIVE_ACTIONS` id (`search-reconcile-orphans`, medium tier)
  and routes the orphan-deletion half through `confirmDestructive` (never a bare
  ConfirmModal).
- Settings (Orchestrator → Search): a small read-only status block rendering the
  widened health (counts, model, spaces; mixed-space warning uses the
  `.crucible-setting-warning` treatment).
Files: `src/search/client.ts`, `src/search/types.ts`, `src/commands.ts`,
`src/search/audit.ts` (new, pure compute separated from command wiring per the
rem-R4 rule), `src/settings/sections/orchestrationSearch.ts`,
`src/settings/destructiveActions.ts`, tests. NOT in scope: automatic/startup
reconcile, making the audit a dashboard section, vacuum/compaction.

**WP-SA3 — docs close (orchestrator-direct).**
*~0.05 kSLOC docs · ~30k tokens · ~5 min wall · top (orchestrator) · Claude: direct
(must-direct: integration/gates/commit duty); Codex: direct (same)*
`src/search/AGENTS.md` quirk entries (paths endpoint additive; audit read-only vs
reconcile enqueues; offline-deletion leak now has a non-destructive remedy); root
quirks-index line; `docs/search-companion.md` endpoint doc; companion deploy
(`home-compose up crucible-search`); plan completion note; deregister; ledger.

## Public Interfaces

- Companion: new `POST /v1/paths` (additive; no schema version bump).
- Two new commands (`search-audit-index`, `search-reconcile-index`); one new
  `DESTRUCTIVE_ACTIONS` id.
- `SearchHealth` gains optional fields (additive).

## Execution

SA1 → SA2 sequential, SA3 orchestrator-direct. Worker worktrees from local master tip;
workers never commit; orchestrator reviews diff, re-runs all six gates verbatim,
commits `(subagent sa-N)`, ff-merges from the main checkout. Companion deploy + live
verification at SA3. Ask the user which subagents to spawn before each dispatch.

## Test Plan / Verification

Six gates verbatim per landing (floor 1638/128, count only grows). Acceptance: audit
on a healthy vault reports zero missing/orphans and correct image coverage; deleting a
note offline (file removed outside Obsidian, index untouched) → audit reports 1
orphan → reconcile purges it; editing offline → audit reports 1 stale → reconcile
re-upserts; `search-health` shows counts and flags a mixed space (unit-fixture).
Live: run audit against the real vault (64,523-chunk index) and eyeball the report.

## Critical Files

`scripts/search-companion/{endpoints/paths.mjs,dispatch.mjs}`, `src/search/{client.ts,
types.ts,audit.ts}`, `src/commands.ts`, `src/settings/sections/orchestrationSearch.ts`,
`src/settings/destructiveActions.ts`, tests.

## Assumptions

- `mtime` staleness (cheap) is the audit tier; content-hash verification stays inside
  the existing upsert skip logic (an mtime false-positive merely enqueues an upsert
  that no-ops on hash match).
- Startup auto-reconcile is a possible follow-up once the manual command proves out —
  deliberately not in this plan.

**Total ≈ 0.65 kSLOC, ~490k raw tokens; ~334k Claude-path / ~265k Codex-path
Opus/Sol-equivalent tokens.**
