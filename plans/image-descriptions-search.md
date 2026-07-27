# obsidian-crucible: image descriptions → search (implement `docs/multimodal-image-search.md`)

> **Committed copy:** `plans/image-descriptions-search.md` — lands before implementation and
> registers in `INITIATIVE.md` `pending-plans` as `- "[[image-descriptions-search]]"`;
> deregisters in the closing commit.

*Recommended model/effort — Claude: Opus/medium for WP-2, Sonnet/medium for WP-1/WP-3; Codex:
Sol/medium-high for WP-2, Terra/medium for WP-1/WP-3. WP-4 + close are orchestrator-direct
(this session, Fable).*

## Context

The vault holds 5,208 localized `_MD5` attachments (4,751 unique by content MD5) that search
cannot see — clipped technical posts whose information lives in charts and figures. The settled
design record **`docs/multimodal-image-search.md` is the contract** for this sprint (read it
first): describe each image with local `gemma-4-12b` (two passes: narrative + structured
extraction), persist descriptions in a plugin-owned store keyed by content MD5, and have the
**chunker emit description chunks** under the owning note's path so the companion's
full-replace upsert regenerates them instead of decaying them. Embedding is unchanged
(descriptions embed via `bge-m3` like prose; no schema bump, no new space, no CLIP, no OCR;
hits are notes).

**Discovery that reshapes the plan:** a sidecar-based pipeline already shipped (baf90ce,
2026-06-15, default-off) — `image_metadata_extract` file job + provider `extractImage` vision
call + `abc_MD5.md` sidecar notes beside each image, indexed by search as ordinary notes. That
storage shape is exactly what the design record's Decision 2 rejects (hits land on the sidecar,
not the owning post). User decision: **repurpose the scaffolding, migrate/delete sidecars.**

## Decisions locked (user-confirmed 2026-07-27)

1. **Two HTTP requests per image** (narrative, extraction) — exactly as benched; no
   answer-splitting parser. Each response maps 1:1 onto its chunk.
2. **No per-note image cap** — the job holds no note lock; a 71-image note just occupies a
   queue slot ~11 min.
3. **Figure-match indicator derived from the `Image: ` heading prefix** — zero companion/schema
   change; the results UI detects the prefix.
4. **SVG text-extraction ships in-sprint** as a small piece of the pipeline (74 SVGs; extract
   `<title>/<desc>/<text>`, no model call).
5. **Legacy sidecar pipeline: repurpose + migrate.** Keep job-type/settings/provider
   scaffolding; retarget to the new store; one-time import of any existing `*_MD5.md` sidecars
   (user likely has none — feature was never enabled), then trash them.
6. Settled by the design record, not re-litigated: model = gemma-4-12B Q4_K_M (26B is the
   upgrade, not on this card); `reasoning_effort:"none"` per request is a **correctness**
   requirement; description hashes **must** fold into the note's `contentHash` (else
   coverage-skip leaves notes permanently description-less); file-backed queue, backfill
   batched ~100 images, incremental keyed `note:<path>`, cross-note dedup via resource lock
   `image::<md5>`, **no note lock**; WebP/AVIF (42%) transcoded in-renderer
   (`createImageBitmap` → `OffscreenCanvas` → PNG), never written to the vault; descriptions
   cached by content hash — model upgrades don't invalidate; emit `image-described` per batch.
7. Transcode throughput (the doc's last open question): instrumented in WP-3 (per-image
   transcode+describe ms, debug-gated), read from the **first live batch at landing** before
   the full backfill is unleashed; batch size stays a constant (default 100, the
   `SEARCH_REBUILD_BATCH_FILES` precedent) that can be adjusted then.

## Summary

Four WPs. WP-1 builds the leaf utilities: the MD5-keyed description store (query-log storage
pattern, plugin data dir), the two-pass provider call, the in-renderer transcoder, the SVG text
extractor. WP-2 threads descriptions through the chunker and folds their hash into
`contentHash` (the load-bearing, trap-laden seam), plus the heading-derived figure indicator.
WP-3 replaces the sidecar workflow with note-keyed incremental + batched backfill jobs,
migrates legacy sidecars, and rewires settings/commands. WP-4 (direct) wires `--mmproj` into
the live router, smokes vision end-to-end, and lands the validation recipe.

## Key Changes

**WP-1 — description store + provider two-pass + transcode + SVG extract (~0.45 kSLOC, ~180k
tokens, ~14 min wall).**
New `src/search/imageDescriptionStore.ts` following the `SearchQueryLog` pattern
(`src/search/queryLog.ts:104-109` — injectable storage seam over `vault.adapter`, unit-testable
without a vault): records at `pluginDataPath('image-descriptions/<md5>.json')`
(`CruciblePlugin.pluginDataPath`, `src/main.ts:614` — outside the note tree, invisible to the
indexer by construction; avoids the doc's "thousands of vault files" harm). Record:
`{ md5, narrative, extraction, kind: 'vision'|'svg-text'|'imported', providerId, modelId,
describedAt, schemaVersion, descriptionHash }`. API: `get/has/put/listMd5s` + an in-memory
md5→descriptionHash index loaded lazily so per-note chunk prep never walks disk. Provider
layer: `describeImagePass(provider, modelId, bytes, mimeType, prompt)` in
`src/providers/openaiCompatible.ts` beside `extractImage` (`:227-260` — content-part arrays
already exist there), body carries `reasoning_effort: 'none'` when `isLocal(provider)`
(`:31`); two prompt constants (narrative, extraction) per the benched passes; manager wrapper
in `src/providers.ts` gated on the existing `image-extraction` capability. Transcoder
`src/search/imageTranscode.ts`: pure `needsTranscode(ext)` decision + thin renderer-only
`transcodeToPng(bytes, mime)` (`createImageBitmap` → `OffscreenCanvas.convertToBlob`) — keep
the canvas call isolated so tests cover the decision, not the DOM. Pure `extractSvgText(svg)`
for `<title>/<desc>/<text>`. Tests beside `tests/imageMetadata.test.mjs` shape: store
round-trip on a stub storage, hash stability, SVG extractor, request-shape assertions.
*Model: mid (Claude Sonnet/medium; Codex Terra/medium) — well-scoped leaf modules against
named exemplars. Execution: subagent (dispatch 148k vs 360k direct Claude; 130k Codex).*

**WP-2 — chunker emission + contentHash fold + figure indicator (~0.35 kSLOC, ~170k tokens,
~13 min wall).**
The cross-cutting search-contract seam. `src/search/chunker.ts` stays **pure** (constraint at
`:50-56` — the standalone-bundle test harness depends on it): `BuildChunksInput` (`:38`) gains
optional `imageDescriptions?: { filename: string; narrative: string; extraction: string }[]`;
`buildSearchChunks` (`:68`) appends **two chunks per image** after the prose sections —
headings `Image: <filename>` (narrative) and `Image: <filename> (text)` (extraction) — through
the same monotonic ordinal, so `stableChunkId` (`:293`) stays deterministic and the companion's
full-replace upsert regenerates exactly what it deletes. `hashSearchContent` (`:196`) gains an
extra-facet parameter folding `image-desc:<combined descriptionHash>` alongside the existing
entity fold — **both** at the `SearchManager.prepareFile` call site (`SearchManager.ts:428-436`)
and in the chunker's `:72` fallback recompute, or ids and skip-hashes drift. Caller side:
`buildPreparedFileChunks` (`SearchManager.ts:438-451`) resolves the note's embeds via
`metadataCache` (pattern: `parseAttachmentRefs`, `src/localizeAttachments.ts:491-503`) →
`localizedImageInfo` (`src/orchestration/utils/imageMetadata.ts:24`) → store lookups, threads
them into input. Results UI: detect the `Image: ` heading prefix on the matched chunk and
render a small figure indicator ("matched a figure") — locate the search-results
snippet/heading renderer, no score change, no schema change. Tests:
`tests/searchChunker.test.mjs` (chunk emission, ordinal/ID determinism);
`tests/searchEntityFacet.test.mjs:161-210` is the exact template for "a description arriving
for an unchanged note re-indexes it"; `tests/searchManagerHash.test.mjs:97,115` pattern for
skip/no-skip. *Model: top (Claude Opus/medium; Codex Sol/medium-high) — the
permanently-skipped-note trap and chunk-identity semantics justify the tier. Execution:
subagent (210k vs 340k direct; same both paths).* After WP-1 (store API + hash helper).

**WP-3 — queue retarget, backfill, sidecar migration, settings/commands (~0.55 kSLOC, ~220k
tokens, ~17 min wall).**
Replace the sidecar workflow (exemplars: `ImageMetadataExtractWorkflow.ts`,
`SearchIndexWorkflow.ts:39-63,149-200`, `tests/youtubeMetadataJob.test.mjs`):
- **`image_describe_note`** (file-backed, dedupe `note:<path>` per
  `youtubeMetadataDedupeKey`, `jobTypeConfig.ts:90-97`): resolve the note's embedded `_MD5`
  images → for each unique MD5, under `withResourceLock('image', md5, …)`
  (`NoteLockManager.ts:120`; `yt-video` exemplar `utils/youtubeApi.ts:299`): skip if
  `store.has(md5)`, SVG → `extractSvgText`, WebP/AVIF → transcode, else raw bytes → two
  describe passes → `store.put`. Then `searchManager.indexFiles([note])` (the folded hash makes
  it do real work) and emit `image-described`. **Takes no note lock** — it writes the store,
  not the note.
- **`image_describe_backfill`** (+ **`image_describe_batch`**, dedupe
  `image-describe:<backfillId>:<i>`): first a legacy sweep — vault files matching `*_MD5.md`
  markdown with `image-metadata-schema` frontmatter → import Description/Extracted-text via the
  existing `extractMetadataSections` (`utils/imageMetadata.ts:154`) → `store.put`
  (`kind:'imported'`) → `fileManager.trashFile`; then enumerate referenced unique MD5s (invert
  `computeOrphanedAttachmentRows`'s referenced-set walk,
  `src/ingestion/data/orphanedAttachments.ts:9-21`), batch `IMAGE_DESCRIBE_BATCH_IMAGES = 100`,
  enqueue batches (`priority 'low'`, lane `'background'`); each batch re-indexes the affected
  notes and emits `image-described`. Per-image transcode/describe timings logged (debug-gated)
  and rolled into job notes — read at landing before the full backfill runs.
- **Wiring:** `JobType` union (`orchestration/types.ts`), config factories
  (`jobTypeConfig.ts`), register (`main.ts:212` area), drain gate reusing
  `s.imageMetadataExtractionEnabled` (`FileJobBackend.ts:482`), queue-monitor labels
  (`ingestion/sections/queueMonitor.ts:96`), autorun list
  (`settings/sections/orchestration.ts:173-176`), event names `image-described` in **both**
  `IngestionEventName` and `IngestionEventPayloads` (`orchestration/events.ts:4-21`). Localize
  hook (`main.ts:163,369`) flips from per-image to per-note enqueue. Settings keep their
  **existing keys** (`imageMetadataExtractionEnabled`, `imageMetadataExtractionModel` — no
  data.json migration), UI relabeled "Image descriptions" in the Orchestrate tab
  (`orchestration.ts:426-450`). New command `Search: describe vault images` via
  `registerCrucibleCommand` + `ConfirmModal` (pattern `src/commands.ts:419-432`). Remove the
  now-dead sidecar write/reuse helpers and the old `image_metadata_extract` type — **pin down
  what `Orchestrator`/`scan()` does with an on-disk job file of an unregistered type first**;
  if hazardous, keep the type registered as a tombstone that forwards to the new note job.
Tests: workflow behavior (skip-described, resource-lock serialization, SVG path), dedupe keys,
legacy import round-trip, localize-hook gating. *Model: mid (Claude Sonnet/medium; Codex
Terra/medium) — strong in-repo exemplars for every part. Execution: subagent (172k vs 440k
direct Claude; 150k Codex).* After WP-1; **parallel with WP-2** (disjoint scopes:
`orchestration/*`+settings vs `search/*`; WP-3 only *calls* `searchManager.indexFiles`).

**WP-4 — router vision wiring + landing validation + close (direct; ~0.15 kSLOC config/docs,
~70k tokens, ~10 min + live validation).**
*must-direct: live-service mutation + final integration/gates/commit duty.* In
`inference-engine`: append `--mmproj /models/lmstudio-community/gemma-4-12B-it-GGUF/mmproj-gemma-4-12B-it-BF16.gguf`
to the `gemma-4-12B-it-Q4_K_M` block in `llama/config.yaml` (file exists on disk, 167 MiB,
beside the weights; registry is bind-mounted → config-append + container restart), restart,
smoke: full `smoke-inference.sh` re-run **plus** a vision request (base64 test image,
`reasoning_effort:"none"`, assert non-empty `content`) — the exclusive-swap chat group must
still serve both chat aliases. Crucible docs: flip `docs/multimodal-image-search.md`'s status
line to point at this plan; note the vision alias in `docs/local-inference.md`'s router table.
**Validation recipe (user's vault, at landing):** `npm run dev` running; enable Image
descriptions + pick `gemma-4-12b` on the 4811 provider (marked `image-extraction` capable);
run `Search: describe vault images`; read the first batch's transcode/describe timings; verify
a known figure query (e.g. the hyperscalers chart) now hits the owning note with the figure
indicator; then let the ~12.6h backfill run unattended. Close: remove `pending-plans` link,
ledger actuals rows per WP.

## Public Interfaces

| Surface | Change |
|---|---|
| Description store | `pluginDataPath('image-descriptions/<md5>.json')`, `kind: vision\|svg-text\|imported`, schemaVersion 1 |
| `BuildChunksInput` | `+ imageDescriptions?` (optional — chunker stays pure; absent = today's behavior) |
| `hashSearchContent` | extra-facet param folding the combined description hash (entity-fold precedent) |
| Chunk headings | `Image: <filename>` / `Image: <filename> (text)` — the heading prefix IS the figure-flag contract |
| `JobType` | `image_describe_note`, `image_describe_backfill`, `image_describe_batch` replace `image_metadata_extract` |
| Events | `+ image-described` (name + payload) |
| Provider | `describeImagePass(...)` beside `extractImage`; `reasoning_effort:'none'` on local providers |
| Settings | existing keys kept, UI relabeled "Image descriptions"; new command `Search: describe vault images` |
| Companion / schema | **unchanged** — no `SEARCH_REQUIRED_SCHEMA_VERSION` bump, no new embedding space |
| inference-engine | `gemma-4-12b` gains `--mmproj` (vision); aliases/ports unchanged |

## Execution

```
WP-1 (subagent):        store + provider passes + transcode + SVG   ← both later WPs consume it
wave 2 (parallel):      WP-2 chunker/hash/UI (subagent) · WP-3 queue/backfill/migration (subagent)
WP-4 + close (direct):  router mmproj + smoke + docs + validation recipe + deregister + ledger
```

Ask-before-dispatch stands at each wave. Workers in worktrees off local master tip; workers
never commit; orchestrator reviews each diff, re-runs gates verbatim, commits per WP
(`subagent wp-N` style), ff-merges. All live mutations (router config, restart, smoke, the
user-vault validation) are orchestrator-at-landing in WP-4. Remind the user to run
`npm run dev` at implementation start. Pause for user compaction at WP boundaries.

## Test Plan / Verification

Per WP landing, the full cleanup loop: `npm run lint`; `npx tsc -noEmit -skipLibCheck`;
`npm test` (baseline **748 tests / 67 files** — count only grows); `node esbuild.config.mjs
production`; `grep -rna --include='*.ts' "console\." src/` → only `src/log.ts`; `file` +
`LC_ALL=C grep -caP '\0'` (exit 1 = PASS) on every touched file; NUL discipline (`'\0'`
two-char escape only — three prior incidents, all in-band sentinels/separators).
- WP-1: store round-trip + hash stability; SVG extractor cases; request-shape tests assert
  `reasoning_effort` presence for local providers and both prompt bodies.
- WP-2: chunk determinism (same input → same ids), description arrival re-indexes an unchanged
  note (entity-facet template), unchanged note *without* new descriptions still skips.
- WP-3: skip-if-described under `image::<md5>` lock; legacy sidecar import round-trip;
  dedupe-key shapes; localize-hook enqueues once per note and never when disabled.
- WP-4: `smoke-inference.sh` green post-restart; vision smoke returns non-empty content; live
  first-batch timings recorded; figure query resolves to the owning note in the user's vault.

## Critical Files

`src/search/chunker.ts` (purity law `:50-56`; `hashSearchContent :196`; `stableChunkId :293`);
`src/search/SearchManager.ts:364-451` (prepareFile / coverage-skip `:378`);
new `src/search/imageDescriptionStore.ts` (pattern `src/search/queryLog.ts`);
`src/providers/openaiCompatible.ts:227-260`; `src/orchestration/utils/imageMetadata.ts`;
`src/orchestration/workflows/{ImageMetadataExtractWorkflow,SearchIndexWorkflow}.ts`;
`src/orchestration/{types,jobTypeConfig,events}.ts`; `src/main.ts:154-215,369,607-620`;
`src/settings/sections/orchestration.ts:426-450`; `src/ingestion/data/orphanedAttachments.ts`;
`inference-engine/llama/config.yaml`; `docs/multimodal-image-search.md` (the contract).

## Assumptions

1. **Store home = plugin data dir**, not `_crucible/` — excluded from indexing by construction
   (query-log precedent) and adds zero vault files. Consequence: descriptions don't ride vault
   sync; they are regenerable (12.6h) and an export/import can be a later follow-up if wanted.
2. `reasoning_effort:'none'` is sent only when `isLocal(provider)` — a remote vision provider
   might reject the unknown field; local llama.cpp requires it.
3. Removing the `image_metadata_extract` job type is safe because the feature shipped
   default-off; WP-3 verifies unregistered-type handling on disk-resident jobs and falls back
   to a tombstone registration if needed.
4. The mmproj addition doesn't perturb the router's exclusive-swap chat group (smoke re-run
   proves it); gemma-4-26B stays off this card per the design record.
5. Transcode throughput is expected to be ms-scale against the 9.5s model time; the first live
   batch measurement at landing is the check, and `IMAGE_DESCRIBE_BATCH_IMAGES` is the knob if
   it isn't.
6. No image results, no CLIP, no OCR path, no re-describe on model change — non-goals per the
   design record.

**Total ≈ 1.5 kSLOC, ~640k raw tokens; ~670k Claude-path / ~630k Codex-path Opus/Sol-equivalent
tokens** (model-cost.mjs: WP-4 + close direct on Fable at weight 2.0; WP-1 dispatched at 148k,
WP-2 at 210k, WP-3 at 172k Claude / 130k, 210k, 150k Codex).
