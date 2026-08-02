---
review-date: 2026-08-02
review-commit: e94e510736f88b333f4db49975e1702311bf49ba
review-type: tn-code-review
review-model: gpt-5.6-sol
review-harness: codex
review-effort: high
review-scope: "95bfc149c8c32a121e9919c2e0daa4e42d2045ec..e94e510736f88b333f4db49975e1702311bf49ba"
---
# Review — Obsidian Crucible changes since the prior review closeout

The prior review's eligible remediation baseline is `95bfc149c8c32a121e9919c2e0daa4e42d2045ec`.
This review covers the 71 commits through `e94e510736f88b333f4db49975e1702311bf49ba`
(177 files, +18,631/-715 in the net diff). The mandatory read-only comment preflight found
no high-confidence comment/code mismatch. `FEEDBACK.md` content was not accessed; it is outside
the reviewable filesystem contract.

| Tier | Open | Resolved |
|---|---:|---:|
| structural-regressions | 1 | 0 |
| simplification-misses | 2 | 0 |
| spaghetti | 0 | 0 |
| boundary-type-contracts | 0 | 0 |
| file-size | 2 | 0 |
| modularity | 0 | 0 |
| legibility | 0 | 0 |

## Findings

### F1 — Attachment repair pushed `localizeAttachments.ts` through 1,000 lines

**Tier: file-size.** `src/localizeAttachments.ts` grew from 892 to 1,204 lines. The new
repair domain is already a coherent extraction seam: reference parsing/formatting, the
`AttachmentPathIndex`, candidate resolution, and cache-ref parsing occupy roughly lines
70-439, while `AttachmentLocalizer` still owns the Obsidian orchestration at lines 561-1204.
Keeping both in one file is not structurally justified. Move the pure repair/index domain to
a focused module and leave the class as the I/O coordinator; this should put the original file
comfortably back below the threshold without changing behavior.

### F2 — Search preparation pushed `SearchManager.ts` through 1,000 lines

**Tier: file-size.** `src/search/SearchManager.ts` grew from 962 to 1,147 lines. The new
linked-document facet joined the existing image-description facet inside the manager, leaving a
distinct file-preparation subsystem at lines 155-173 and 544-698 (`PreparedSearchFile`, content
read, facet resolution, hash folding, and chunk construction). Extract that subsystem behind a
direct typed function/module while keeping `buildFileChunks` and `auditPrepareFile` as the public
manager entry points. The extracted preparation path should also resolve the independent image
and linked-document facets together rather than serializing the two awaits at lines 547-548.

### F3 — Ignored and uncaptured intake now maintain parallel scan/join pipelines

**Tier: structural-regressions.** `src/ingestion/data/ignored.ts:20-103` explicitly mirrors
`src/ingestion/data/uncaptured.ts:20-115`: both load configuration, build a seen set, scan the
same tracker runs, join the same metadata notes, and construct near-parallel blog/video row
shapes. The only real policy difference is whether ignored IDs are excluded or selected, yet the
implementation duplicates the whole pipeline and makes future field/scan changes a two-file
coordination problem. Build one canonical per-source intake snapshot and partition/project it
into ignored versus uncaptured rows; preserve the bare-ID degraded ignored rows at that boundary.

### F4 — Search-audit condition knowledge is duplicated across report and UI branches

**Tier: simplification-misses.** `src/ingestion/sections/searchAudit.ts` defines parallel
condition unions, order, labels, count rules, summary actions, and row-action rules at lines
41-82, 222-232, 304-407, and 459-501. `src/search/audit.ts:277-317` separately hard-codes the
report's labels/order/repair mapping. The UI comment says these copies ensure the views “never
disagree,” but copying cannot enforce that invariant (the report already combines image coverage
into one bullet while the dashboard expands it into three rows). Introduce one pure typed
condition descriptor owned by the audit domain—key, label, count/path projection, class, and
repair policy—and have both renderers consume it. The dashboard should dispatch on the repair
policy, deleting the repeated key-by-key branches.

### F5 — Frontmatter cache/raw asymmetry is represented as two copies of one path

**Tier: simplification-misses.** `src/frontmatter.ts:65-100` handles the two directions of a
cache/raw frontmatter-block mismatch in separate branches, then lines 155-187 implement two
nearly identical splice-and-verify helpers whose only meaningful difference is the diagnostic
label. Compute the cache/raw block state once, route either mismatch through one
`writeViaContentSpliceAndVerify` helper carrying a reason label, and keep the genuine
both-present stale-offset case on the bounded cache barrier. This deletes branches and duplicate
verification from the repository's most load-bearing write chokepoint.

## Remediation

See `plans/tn-review-2026-08-02-remediation.md`. This review session deliberately does not
implement the plan or register it in `INITIATIVE.md`; the tn-code-review plan-workflow exception
leaves implementation routing to the user.
