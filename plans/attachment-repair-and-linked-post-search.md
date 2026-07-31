# Attachment-repair correctness + dashboard scan perf + linked-post search (pre-freeze remediation)

*Recommended model/effort — Claude: Sonnet/medium workers for PF1–PF4, orchestrator (Fable)
closes PF5 direct; Codex: Terra/medium workers, Sol/medium orchestrator.*

**Repo plan (canonical): `plans/attachment-repair-and-linked-post-search.md`, registered as
`- "[[attachment-repair-and-linked-post-search]]"` in `INITIATIVE.md` `pending-plans`,
committed docs-only before any source edit. WP prefix `pf`.**

## Context

The sprint goal is a freezable release candidate: fix the observed defect cluster in the
attachment dashboard sections, remove their scan-cost pain, and land the search capability
the X-metadata sprint exposed (finding a conversation note by the content of posts it only
links). Grounding is two Explore reports (2026-07-31, master `1ed9c0c`) against the user's
FEEDBACK observations.

**Attachment findings (all grounded with file:line):**
- **Certain bug, the center of the cluster:** vf-2 made repair *see* managed-attachment
  links (`parseAttachmentRefsFromCache` consumes `cache.links`), but the write path
  `rewriteLocalizedAttachmentRefs` (`src/localizeAttachments.ts:63-74`) still scans the
  embeds-only `MARKDOWN_ATTACHMENT_REF_RE` (`:46` — both alternatives require the leading
  `!`). A link row's repair computes `newRef`, increments `repaired++`, reports success —
  and writes nothing. The row survives every Repair click.
- **Same regex, second victim:** `repointAttachmentFolderPrefix` (`:85-98`) repoints only
  embeds after a folder move, stranding the sibling `[[…_MD5.jpg|Open: …]]` link on the
  dead path — the exact "image renders but its link is listed missing" symptom. The
  localize-direction of the same class explains the missing+orphan pair: a re-home writes
  a fresh `_MD5` copy (orphan) while the link ref it meant to rewrite is dropped (missing).
- **"Non-repairable" is mostly spurious for `_MD5` names:** `resolveLocalAttachmentRepair`
  (`:127-154`) returns `ambiguous` when the same basename exists in >1 folder — but the
  basename IS the content MD5, so same-name managed files are byte-identical and any match
  is a correct target. Localize's copy-don't-steal behavior makes duplicates the *normal*
  state.
- **Orphan false-positives:** `computeOrphanedAttachmentRows` builds the referenced set
  from `resolvedLinks` only (`src/ingestion/data/orphanedAttachments.ts:11-14`), missing
  frontmatter property links — the documented gap (root `AGENTS.md`).
- **Probe decode gap (secondary):** the missing probe passes the raw `ref.link` to
  `getFirstLinkpathDest` (`src/ingestion/data/missingAttachments.ts:54`) without the
  URL-decode/`#|`-strip that the repair path applies — a structural false-positive channel.
- **Perf:** the scan is O(rows × vault paths) synchronous string ops with no basename
  index (`planLocalAttachmentRepair` does up to two full `vaultPaths.filter` passes per
  broken row); rows-compute runs even when the repaint is skipped; both heavy sections are
  re-armed ~1/s by ANY structural vault event; and the dashboard's own `vault.on('create')`
  (`ingestionDashboard.ts:383`) is not layout-ready gated — Obsidian's startup create
  replay storm (the vf-1 class) re-runs the two heaviest scans repeatedly at boot.
  ("Metadata cache materialization" is not a real code path; the visible startup stall is
  the `metadataCacheReady` latch, which is correct behavior.)

**Search findings:** ranking legs are content-only; the only adjacency signal is the
client-side reorder-only link boost (`src/search/linkGraph.ts`, unions `frontmatterLinks`,
needs ≥2 top-10 seeds, ~3 positions). A thread note whose posts exist only as `x-metadata`
links has zero matching chunks, so it is never in the candidate set — the boost cannot
surface it. Metadata roots ARE indexed (only `_crucible` is excluded), which the use case
depends on: the `_x_metadata` note itself matches. `contentHash` includes the frontmatter
block (`src/search/chunker.ts:299-311`), so stamps already move the hash; chunk text
excludes frontmatter (`:313-315`), so stamps never change what matches.

## Decisions locked (user, this session)

1. Plan scope: **defects + perf**, plus **both** search treatments — the index-side
   linked-post facet AND the result-side "cited by" hop.
2. Freeze posture: pushing toward a freezable candidate, not frozen now — the facet's
   synthetic-chunk design (no schema bump, no companion change) is acceptable.
3. Metadata roots stay indexed (the use case depends on it); the earlier
   "exclude metadata roots" idea is dead.

## Summary

One chokepoint fix makes the attachment ref-rewrite machinery form-preserving for links
and embeds alike (repair write path + folder-move repointer); repair ambiguity collapses
for content-hashed names; the orphan scan unions frontmatter links; a per-scan basename
index plus layout-ready event gating removes the scan pain. Search gains synthetic
linked-post chunks (source notes rank on the text of posts they stamp-link, semantic leg
included, invalidation via a contentHash fold) and a "cited by" affordance on
metadata-note results.

## Key Changes

**WP-PF1 — links-aware ref rewrite + repair correctness (chokepoint fix).**
*~0.6 kSLOC · ~280k tokens · ~22 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent (~70% saving); Codex: subagent (~50%)*
- Extend the ref-rewrite chokepoint to non-embed managed-attachment links: either widen
  `MARKDOWN_ATTACHMENT_REF_RE` with non-embed alternatives **filtered to `_MD5` basenames**
  (never rewrite ordinary note links) or add a parallel link-scoped pass —
  `rewriteLocalizedAttachmentRefs` and `repointAttachmentFolderPrefix` both gain link
  coverage, staying idempotent and form-preserving (`formatRef`: a link stays a link with
  its display text). The round-trip test class that vf-2 lacked: link refs through
  `rewriteLocalizedAttachmentRefs` and the repointer, wiki + `%20`-encoded markdown forms.
- `repairNote` must count `repaired` only for refs the rewrite actually landed (re-read
  and verify, or count from the rewrite's own match results) — no more "Repaired 1" on a
  no-op write.
- MD5-ambiguity auto-resolve: in `resolveLocalAttachmentRepair`, when ALL candidate
  matches share an `MD5_NAME_RE` basename, they are byte-identical by the hash convention —
  pick deterministically (expected-folder first, then shortest path, then lexicographic)
  instead of returning `ambiguous`. Non-MD5 basenames keep the ambiguity bail.
- Missing-probe decode: normalize `ref.link` (URL-decode, strip `#`/`|`/angle brackets)
  before `getFirstLinkpathDest` in `computeMissingAttachmentRows`, mirroring
  `managedAttachmentBasename`.
- Orphan scan: union `getFileCache(f).frontmatterLinks` targets into the referenced set in
  `computeOrphanedAttachmentRows`.
Files: `src/localizeAttachments.ts`, `src/ingestion/data/missingAttachments.ts`,
`src/ingestion/data/orphanedAttachments.ts`, tests. NOT in scope: dashboard render/cadence
code, any new UI.

**WP-PF2 — dashboard scan perf + event-cadence hardening.**
*~0.35 kSLOC · ~200k tokens · ~15 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent*
- Per-scan basename→paths index (built once from the vault path snapshot) consumed by the
  repair tiers — collapses `planLocalAttachmentRepair`'s per-row full-vault `filter`
  passes to hash lookups. Thread it through `computeMissingAttachmentRows` without
  changing the pure-function seam (index built inside, or passed as an optional
  precomputed arg the section supplies).
- Layout-ready gate the Ingestion dashboard's vault event listeners (the `vault.on` set at
  `ingestionDashboard.ts:383` area) — the vf-1 create-replay class; follow the
  registration-placement pattern its tests pin.
- Keep the single dirty-set/two-gate flush architecture untouched (rsp law: no per-section
  debounces). Permitted cadence change, if measurement supports it: a coarser
  SCAN debounce for the two attachment scans only, implemented via the existing
  `minIntervalGate` primitives — never a new debounce layer.
- Depends on PF1 (same files) — sequential.
Files: `src/ingestion/data/missingAttachments.ts`, `src/localizeAttachments.ts` (index
consumption), `src/ingestionDashboard.ts`, tests. NOT in scope: keyed-table/renderer
changes.

**WP-PF3 — linked-post search chunks (index-side facet).**
*~0.5 kSLOC · ~250k tokens · ~19 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent*
- At index time, resolve a source note's `x-metadata` (list) and `yt-metadata` (scalar)
  frontmatter wikilinks via `getFirstLinkpathDest`, `cachedRead` each target, and emit one
  **ordinary chunk** per linked post: heading `Linked post: <target title/handle>`, text =
  the metadata note's body prose (frontmatter sliced off, capped length), capped at ~8
  linked chunks per note. Ordinary chunks ⇒ **no schema bump, no companion change**; FTS,
  coverage, and the vector leg (embedding `chunk.text`) all pick them up — the semantic
  leg is what serves the use case.
- Fold the linked targets' identity (paths + their contentHashes or mtimes) into
  `hashSearchContent`'s input for the source note — shipping the feature re-upserts
  already-stamped notes exactly once; metadata notes are immutable snapshots, so ongoing
  invalidation rides the existing stamp-moves-the-hash behavior.
- The indexing path gains an async boundary (chunker input assembly reads linked notes) —
  keep `parseSearchDocument` pure by assembling `{path, title, text}[]` in `SearchManager`
  and passing it in.
- Verification: latency spot-check + a smoke quality check (the change adds chunks, does
  not touch scorers); measurement artifacts go to the eval-harness repo if a full run is
  ever warranted.
Files: `src/search/chunker.ts`, `src/search/SearchManager.ts`, tests. NOT in scope:
`scripts/search-companion*` (must not change), schema version files, ranking weights.

**WP-PF4 — "cited by" hop on metadata-note results.**
*~0.2 kSLOC · ~150k tokens · ~12 min wall · mid (Claude Sonnet/medium; Codex
Terra/medium) · Claude: subagent; Codex: subagent*
- When a search result's path sits under a metadata root (`_x_metadata` / `_yt_metadata` /
  `_blog_metadata`, read from settings), render its citing source notes as a compact
  "cited by [[note]]" line on the result card. Reverse lookup must cover frontmatter
  links — reuse/extend the `buildLinkGraph` machinery (`src/search/linkGraph.ts`), which
  already unions `frontmatterLinks`; never a per-result vault scan.
- Design system: Obsidian semantic vars, neutral treatment (a fact, not an alert).
- Runs after PF3 lands (same area review context; file overlap expected in the results
  renderer only).
Files: the search results renderer (locate: `src/search/` view/results module),
`src/search/linkGraph.ts` (reverse index accessor), `styles.css` (minimal), tests.

**WP-PF5 — docs close (orchestrator-direct).**
*~0.05 kSLOC docs · ~30k tokens · ~5 min wall · top (orchestrator) · Claude: direct
(must-direct: integration/gates/commit duty); Codex: direct (same)*
- Quirks: root `AGENTS.md` — the ref-rewrite chokepoint now covers links (retire the
  embed-only caveats in the folder-move quirks); MD5-name ambiguity is resolvable by
  content-identity; orphan scan unions frontmatterLinks (close the documented gap).
  `src/search/AGENTS.md` — linked-post chunks (ordinary-chunk design, hash fold,
  immutable-snapshot invalidation, cap). Quirks-index lines.
- Plan completion note; deregister `pending-plans`; ledger actuals; live-validation
  checklist (repair a link row and verify the write landed; re-scan after; boot-time
  dashboard behavior; the "genius author sysadmin" query finds the thread).

## Public Interfaces

- No new settings, commands, job types, or events.
- `hashSearchContent` input changes for notes carrying `x-metadata`/`yt-metadata`
  (one-time re-upsert wave for stamped notes; no schema bump).
- Search results render a "cited by" line for metadata-root hits.
- Repair semantics change: MD5-identical multi-match auto-resolves; links get rewritten.

## Execution

Wave 1: PF1 ∥ PF3 (disjoint: attachments vs search). Wave 2: PF2 (after PF1, same files)
∥ PF4 (after PF3). PF5 orchestrator-direct. One worker worktree per WP branched from local
master tip; workers never commit; orchestrator copies the report out first, reviews the
full diff, re-runs all six gates verbatim, commits `(subagent pf-N)`, ff-merges **from the
main checkout**, removes worktree then branch. Ask the user which subagents to spawn
before each wave. Token bands include the ~1.5× calibration pad (validated across xm-1…4:
101–112% of estimate).

## Test Plan / Verification

Six gates verbatim per landing: `npm run lint`; `npx tsc -noEmit -skipLibCheck`;
`npm test` (floor **1522/121**, count only grows); `node esbuild.config.mjs production`;
`grep -rna --include='*.ts' "console\." src/` → only `src/log.ts`; per touched file
`file` + `LC_ALL=C grep -caP '\0'` exits 1. Acceptance: a link-only broken ref
round-trips through repair and the write lands on disk; a folder move repoints links and
embeds alike; an MD5-duplicate basename repairs instead of reporting non-repairable; a
frontmatter-only referenced attachment is not listed orphaned; missing/orphaned scan cost
drops measurably (spot-time before/after); a semantic query matching only a linked post's
text returns the source thread note; a metadata-note hit shows its citing notes. Live
validation via `npm run dev` hot-reload; checklist in PF5.

## Critical Files

`src/localizeAttachments.ts`, `src/ingestion/data/{missingAttachments,orphanedAttachments}.ts`,
`src/ingestionDashboard.ts`, `src/search/{chunker,SearchManager,linkGraph}.ts`, the search
results renderer, tests.

## Assumptions

- The `_MD5` basename ⇒ byte-identical rule holds for all `MD5_NAME_RE`-matching managed
  files (it is the documented hash convention); hand-renamed collisions are out of scope.
- Metadata notes remain immutable snapshots (no refresh command yet), so linked-chunk
  invalidation needs no watcher beyond the hash fold.
- The user's slow-scan observation is the O(rows × paths) cost + cadence, not the
  `metadataCacheReady` startup latch (which is correct and stays).
- Result-card real estate exists for a one-line "cited by" without layout work.

**Total ≈ 1.7 kSLOC, ~910k raw tokens; ~586k Claude-path / ~475k Codex-path
Opus/Sol-equivalent tokens.**
