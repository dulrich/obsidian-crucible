# Thermo-Nuclear Review Remediation — 2026-08-02

*Recommended model/effort — Claude: Opus 5/high as orchestrator, with workers as tagged;
Codex: gpt-5.6-sol/high as orchestrator, with workers as tagged. The two canonical write/hash
seams require top-tier reasoning; the declarative UI/data consolidations are mid-tier work once
their contracts are pinned by this plan.*

## Context

The 2026-08-02 thermo-nuclear review audited the effective prior-review baseline
`95bfc149c8c32a121e9919c2e0daa4e42d2045ec` through
`e94e510736f88b333f4db49975e1702311bf49ba`. It found five maintainability blockers: two
production files crossed 1,000 lines, ignored intake duplicated the uncaptured scan/join
pipeline, search-audit condition knowledge was copied across layers, and the canonical
frontmatter write path grew two copies of the same cache/raw mismatch recovery.

This is a remediation plan for a later orchestrator session. It does not authorize behavior
changes, schema changes, migration cleanup, remote mutations, or implementation in the review
session that produced it.

## Decisions locked

- Preserve every current user-observable behavior and wire/storage contract.
- Keep frontmatter writes routed through `updateFrontmatter`; no call site may bypass it.
- Keep `SearchManager.buildFileChunks` and `SearchManager.auditPrepareFile` as public entry points
  so audit and indexing continue to share the exact hash/chunker path.
- Keep ignored rows available even when tracker retention has aged out their metadata; the
  canonical intake snapshot must retain the existing bare-ID degradation.
- Keep the audit report pure and the dashboard forced-trigger-only. A shared condition model may
  describe policy, but must not import DOM, Obsidian UI, commands, or orchestration runtime code.
- Do not register this remediation plan in `INITIATIVE.md`; the tn-code-review exception leaves
  that decision to the user.

## Summary

Extract the two newly overgrown domain seams, then replace duplicated state descriptions with
canonical typed models. Each implementation package preserves its current public entry points
and lands with focused regression coverage. A final direct closeout reruns the repository's full
gates, confirms the two threshold files are below 1,000 lines, updates the review counts to zero,
and records the eligible remediation baseline.

## Key Changes

**WP-R1 — Extract the attachment-repair core.**
*~0.9 kSLOC touched, net-negative · ~190k tokens · ~15 min wall · top (Claude Opus 5/high;
Codex gpt-5.6-sol/high) · Claude: subagent (same-tier; accept the ~20k normalized premium for an
independent review of the attachment rewrite invariants); Codex: subagent (same-tier; accept the
~20k premium for the same invariant review)*
Move reference parsing/formatting, `AttachmentPathIndex`, local candidate resolution, and
cache-ref parsing out of `localizeAttachments.ts` into a focused pure repair module. Keep
`AttachmentLocalizer` as the vault/download/write coordinator and preserve every exported symbol
needed by ingestion/tests through deliberate imports or re-exports. Files:
`src/localizeAttachments.ts`, new `src/attachmentRepair.ts` (or an equally focused name),
`src/ingestion/data/missingAttachments.ts`, and attachment repair tests.

Review record: `reviews/2026-08-02-tn-code-review.md`.

Findings: F1 (`file-size`).

Record delta: `file-size Open -1 / Resolved +1`.

Verification:

- `node --test tests/localizeAttachments.edge.test.mjs tests/missingAttachments.test.mjs tests/orphanedAttachments.test.mjs tests/autoLocalizeScheduler.test.mjs tests/autoLocalizeCreateReplayGuard.test.mjs`
- Confirm `src/localizeAttachments.ts` is below 1,000 physical lines.

**WP-R2 — Extract search file preparation.**
*~0.9 kSLOC touched, net-negative · ~210k tokens · ~16 min wall · top (Claude Opus 5/high;
Codex gpt-5.6-sol/high) · Claude: subagent (same-tier; accept the ~20k normalized premium for
independent review of content-hash and chunk identity); Codex: subagent (same-tier; accept the
~20k premium for the same hash-contract review)*
Create a focused search file-preparation module that owns `PreparedSearchFile`, content reads,
image-description and linked-document facet resolution, deterministic facet folding, and chunk
construction. Resolve the independent facet sources together, retain byte-identical hash/chunk
results, and leave the manager's public build/audit methods as thin entry points into this
subsystem. Files: `src/search/SearchManager.ts`, new `src/search/filePreparation.ts` (or an
equally focused name), `src/search/chunker.ts` only if type ownership requires it, and search
hash/linked-post tests.

Review record: `reviews/2026-08-02-tn-code-review.md`.

Findings: F2 (`file-size`).

Record delta: `file-size Open -1 / Resolved +1`.

Verification:

- `node --test tests/searchManagerHash.test.mjs tests/searchLinkedPostChunks.test.mjs`
- Confirm `src/search/SearchManager.ts` is below 1,000 physical lines.
- Pin byte-identical content hashes, chunk IDs/order, empty/tombstone behavior, and the eight-link cap.

**WP-R3 — Canonicalize the search-audit condition model.**
*~1.0 kSLOC touched, net-negative · ~160k tokens · ~12 min wall · mid (Claude Sonnet 5/medium;
Codex gpt-5.6-terra/medium) · Claude: subagent (~36k Opus/Sol-equivalent saving after dispatch
overhead); Codex: subagent (~50k saving after overhead)*
Define one pure, typed audit-condition descriptor in the search audit domain. It must own the
stable key, canonical label, path/image category, count/path projection, default-view membership,
and repair policy without importing UI/runtime dependencies. Generate the report summary and the
dashboard summary rows from that model; reduce UI repair handling to a policy dispatcher and
derive disabled row-action guidance from the same policy. Files: `src/search/audit.ts` (or a new
dependency-free `src/search/auditConditions.ts`), `src/ingestion/sections/searchAudit.ts`, and
search-audit report/dashboard tests.

Review record: `reviews/2026-08-02-tn-code-review.md`.

Findings: F4 (`simplification-misses`).

Record delta: `simplification-misses Open -1 / Resolved +1`.

Verification:

- `node --test tests/searchAudit.test.mjs tests/searchAuditSection.test.mjs tests/searchAuditRunActionHelpers.test.mjs tests/searchAuditRunEnqueueRepairs.test.mjs`
- Add a parity test proving report and dashboard order/labels/count projections come from the one
  descriptor set, including the three image-coverage presentations.

**WP-R4 — Build one canonical intake snapshot per feed source.**
*~0.8 kSLOC touched, net-negative · ~180k tokens · ~14 min wall · mid (Claude Sonnet 5/medium;
Codex gpt-5.6-terra/medium) · Claude: subagent (~44k Opus/Sol-equivalent saving after dispatch
overhead); Codex: subagent (~60k saving after overhead)*
Replace the mirrored ignored/uncaptured blog and YouTube scan/join functions with one canonical
snapshot per source. Partition or project the snapshot into the existing public row shapes using
an explicit ignored-state policy; do not introduce a generic callback framework that hides the
two concrete feed schemas. Preserve metadata precedence, seen-set behavior, row order, and bare-ID
degradation. Files: `src/ingestion/data/uncaptured.ts`, `src/ingestion/data/ignored.ts`, ingestion
row types only if a shared internal base is useful, and intake-row tests.

Review record: `reviews/2026-08-02-tn-code-review.md`.

Findings: F3 (`structural-regressions`).

Record delta: `structural-regressions Open -1 / Resolved +1`.

Verification:

- `node --test tests/ingestionIgnoredRows.test.mjs tests/ingestionIntakeActionCell.test.mjs`
- Add a scan-count seam proving one source snapshot supplies both ignored and uncaptured
  projections in a shared dashboard pass, without changing either public result.

**WP-R5 — Collapse frontmatter cache/raw mismatch recovery.**
*~0.5 kSLOC touched, net-negative · ~120k tokens · ~9 min wall · top (Claude Opus 5/high;
Codex gpt-5.6-sol/high) · Claude: subagent (same-tier; accept the ~20k normalized premium for
independent review of the canonical write barrier); Codex: subagent (same-tier; accept the ~20k
premium for the same write-integrity review)*
Read/cache the frontmatter-block presence state once, classify either asymmetric mismatch through
one branch, and route both to one content-splice-and-verify helper carrying an explicit diagnostic
reason. Preserve the both-present stale-offset wait, timeout/write/verify/repair sequence,
non-cancelling watchdog behavior, BOM/newline handling, and index-based splicing. Files:
`src/frontmatter.ts`, `tests/frontmatterBarrier.test.mjs`, and `tests/lintFolderHardening.test.mjs`
only if its structural guards need updating.

Review record: `reviews/2026-08-02-tn-code-review.md`.

Findings: F5 (`simplification-misses`).

Record delta: `simplification-misses Open -1 / Resolved +1`.

Verification:

- `node --test tests/frontmatterBarrier.test.mjs tests/lintFolderHardening.test.mjs`
- Pin both mismatch directions, stale-offset timeout recovery, post-splice verification failure,
  watchdog settlement, BOM preservation, and empty-block handling.

**WP-R6 — Gated review closeout.**
*~0.1 kSLOC touched · ~420k tokens · ~32 min wall · top (Claude Opus 5/high; Codex
gpt-5.6-sol/high) · Claude: direct (must-direct: final integration review, verbatim gates, record
closeout, and commit duty); Codex: direct (must-direct: the same final integration and landing
duty)*
After WP-R1 through WP-R5 have landed and their declared record deltas have been applied, inspect
the combined diff, run every repository gate below sequentially, and confirm both formerly
over-threshold files are below 1,000 lines. Once every Open count in the review record is zero,
record the gated remediation closeout SHA as `remediation-commit`; never set it earlier. Files:
`reviews/2026-08-02-tn-code-review.md` plus any mechanically necessary plan closeout note.

Review record: `reviews/2026-08-02-tn-code-review.md`.

Findings: no new finding; verifies the integrated resolution of F1-F5.

Record delta: no count delta; assert all seven tier rows have `Open: 0`, then add
`remediation-commit` with the gated closeout SHA.

Verification: run the full Test Plan / Verification section verbatim and require every command to
exit 0. Confirm the test count has not dropped below the baseline observed when orchestration
starts.

## Public Interfaces

- No user-facing command, setting, job payload, persisted row, companion endpoint, frontmatter
  key, or search schema changes are intended.
- Existing public entry points remain stable: `AttachmentLocalizer`,
  `SearchManager.buildFileChunks`, `SearchManager.auditPrepareFile`,
  `computeUncaptured*Rows`, `computeIgnored*Rows`, `formatAuditReport`, and
  `updateFrontmatter`.
- New shared types/modules are internal source boundaries. Avoid re-export barrels unless an
  existing import contract requires one.

## Execution

WP-R1 through WP-R5 are behavior-preserving packages with coherent file scopes and should be
dispatched after the user chooses the implementation agents. With four available slots, run at
most three workers concurrently; a practical first wave is WP-R1/WP-R2/WP-R3, followed by
WP-R4/WP-R5. They have no semantic dependency, but the orchestrator must review and land each
worker diff separately, apply that WP's declared review-record delta in the same commit, and never
allow a worker to commit. WP-R6 is direct and runs only after all five remediation commits land.

## Test Plan / Verification

Run targeted tests listed under each WP while developing. Before every landing commit, follow the
nearest `AGENTS.md` and the repository's prescribed gate policy. At final closeout run this full
sequence sequentially:

1. `npm run lint`
2. `npx tsc -noEmit -skipLibCheck`
3. `npm test`
4. `node esbuild.config.mjs production`
5. `grep -rna --include='*.ts' "console\." src/` and confirm only `src/log.ts` matches.
6. For every created/touched text file, run `file <path>` and
   `LC_ALL=C grep -caP '\0' <path>`; require text classification and grep exit 1.
7. `git diff --check` and a final `git status --short` scoped review.

The historical 949-test figure in the root contract predates this review range; record the actual
test count at orchestration start and reject any remediation-induced drop.

## Critical Files

- `reviews/2026-08-02-tn-code-review.md`
- `src/localizeAttachments.ts`
- `src/search/SearchManager.ts`
- `src/search/audit.ts`
- `src/ingestion/sections/searchAudit.ts`
- `src/ingestion/data/uncaptured.ts`
- `src/ingestion/data/ignored.ts`
- `src/frontmatter.ts`

## Assumptions

- Current tests accurately pin behavior; remediation adds structural/parity tests where a current
  test only pins output text indirectly.
- The prior review's `remediation-commit` remains immutable provenance and is used only as this
  review's starting baseline.
- No content from `FEEDBACK.md` is needed to execute these behavior-preserving packages.
- The later orchestrator will use the commit skill, will not push, and will ask the user which
  implementation workers to dispatch before spawning them.

**Total ≈ 4.2 kSLOC, ~1,280k raw tokens; ~1,160k Claude-path / ~1,130k Codex-path
Opus/Sol-equivalent tokens.**
