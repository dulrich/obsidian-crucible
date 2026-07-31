# Multimodal image → search (design record)

**Status: implemented — see `plans/image-descriptions-search.md` (landed 2026-07-27).** The
description store, chunker emission, job pipeline, and router vision wiring all shipped per
that plan; this document remains the design record behind it. WP-7 of
`plans/model-ux-search-perf-and-inference-consolidation.md` was a bench plus this document.
Everything below that is presented as a measurement was
measured on this box on 2026-07-26 and is archived at
`/home/_shared_code/eval-harness/local-inference-bench/measurements/wp7-multimodal-2026-07-26/`
(`run.md` there is the full record, including the per-image table and the validity notes).

## The problem

The vault holds **5,208 localized `_MD5` attachments** — 4,751 unique raster images by content
hash — and the search index cannot see any of them. They are not incidental decoration: the
corpus is clipped technical blogs, so the images are Epoch AI data briefs, Sebastian Raschka's
architecture figures, benchmark bar charts, and comparison tables. A large fraction of the
*information* in a clipped post is in its figures, and a query like "the post with the chart
showing five hyperscalers at two-thirds of AI compute" retrieves nothing today, because the only
text near that chart is `![](e6e3bc7e…_MD5.png)`.

The proposal: describe each image with a local vision model, and index the resulting **text**
alongside the note that embeds it.

## What was measured

Two models fit or nearly fit this GPU (AMD RX 9070, **16,304 MiB**). The other three candidates
on disk do not, and were skipped rather than benched at partial offload:

| model | weights + mmproj | vs 16,304 MiB | verdict |
|---|---|---|---|
| gemma-4-12B-it Q4_K_M | 7,206 MiB | 44% | fits comfortably |
| gemma-4-26B-A4B-it-QAT Q4_0 | 14,909 MiB | 91% | ran, but spilling 4,716 MiB to host memory |
| gemma-4-31B-it-QAT Q4_0 | 17,979 MiB | 110% | cannot fit |
| Qwen3.6-27B Q4_K_M | 16,669 MiB | 102% | cannot fit |
| Qwen3.6-35B-A3B Q4_K_M | 21,047 MiB | 129% | cannot fit |

Warm, thinking off, 16 decodable vault images, two passes each (a one-paragraph *narrative* and
a structured *extraction*):

| | gemma-4-12B | gemma-4-26B-A4B *(spilling)* |
|---|---|---|
| cold load | 3.04 s | 14.79 s |
| narrative, median | 3,192 ms | 3,996 ms |
| extraction, median | 6,052 ms | 5,530 ms |
| both passes, median | **9,565 ms** | **9,423 ms** |
| prompt tokens per image | 317–335 | 317–335 |

**Quality.** Both models return titles, subtitles, axis labels, axis ranges, series names, tick
values, annotation sentences and diagram component lists essentially verbatim. They separate
sharply on small glyphs. On a bar chart of seven Elo ratings in ~10 px type, the 26B read
**7/7 model names and 7/7 values** exactly; the 12B read 5/7 and 5/7, turning *Gemini 3 Pro
Preview / 1468* into *Gemini 1.5 Pro Preview / 1466* and *Claude Sonnet 4.5 (Thinking) / 1300*
into *Claude Sonnet 4 (Thinking) / 1301*. On an architecture figure the 12B read the embedding
dimension as 5,378 (true 5,376), rendered `RoPE` as `Po1E`, and labelled both feed-forward
insets SiLU when the point of the pair is that one is **GELU** — the 26B got all three right.

Three results that constrain the design more than the latencies do:

1. **WebP is rejected with HTTP 400.** llama.cpp's image loader is `stb_image`, which has no
   WebP or AVIF decoder. WebP is the **largest single format** in this vault: 1,961 of 4,751
   unique raster images, and with AVIF that is **1,998 (42%) undecodable as-is**. Transcoding to
   PNG fixes it completely — the two transcoded samples described perfectly.
2. **gemma-4 is a reasoning model and the default request returns an empty string.** The whole
   token budget goes to `message.reasoning_content` with `content: ""` and
   `finish_reason: "length"`. `reasoning_effort: "none"` turns it off;
   `chat_template_kwargs: {enable_thinking: false}` also works; `{thinking: false}` and
   `reasoning_effort: "low"` **do not**. Leaving it on costs **4.30× wall time / 4.65× tokens**
   and does not fix the numerals — it fixed prose OCR only, so the ceiling is the vision
   encoder's resolution, not the reasoning budget.
3. **Prompt cost is flat in image size** — 317–335 tokens for everything from a 32 KB logo to an
   886 KB poster. Gemma-4 spends a fixed per-image budget regardless of resolution, so
   downscaling before upload saves nothing and costs accuracy on exactly the small text the
   encoder is already straining to read. Do not pre-shrink.

## Decision 1 — model

**Ship against `gemma-4-12B-it Q4_K_M`. Treat `gemma-4-26B-A4B-it-QAT Q4_0` as the upgrade, and
do not put it on this card.**

The 26B is the better describer by a clear margin on the content that motivates the feature, and
it is *not* slower — but it only ran here by spilling 4,716 MiB to host memory and sitting at
99.4% VRAM while the live retrieval service held ~3.1 GiB for `bge-m3`. That is the same shape
as the `llvmpipe` trap in `/home/_shared_code/inference-engine/llama/AGENTS.md`: it starts, passes health, answers
correctly, and is quietly not doing what you think. The tell is arithmetic — a 26B **A4B** MoE
has ~4B active parameters against the 12B's 12B dense, so resident it should decode
*substantially faster*, and instead it managed 53.4 tok/s against the 12B's 51.8. On a ≥24 GB
card the 26B becomes the obvious default and its measured numbers here are a floor.

The 12B's accuracy profile is acceptable **for retrieval specifically**, and the distinction is
the whole point: it gets the title, the axes, the series and the shape of the trend right, which
is what makes a chart findable. It garbles the last significant digit and occasionally a version
number, which would make it unusable as a citation source. That maps onto an existing house
rule from the embedding work — *rank, never assert an absolute value.* A description is a
retrieval surface. Anything that renders a described value back to the user must link the image
and let the user look.

Serving flags, for whenever this reaches the inference-engine router config (`/home/_shared_code/inference-engine/llama/config.yaml`): the vision path
needs `--mmproj` alongside `-m`, and `gemma-4-12B-it-GGUF` does ship one
(`mmproj-gemma-4-12B-it-BF16.gguf`, 167 MiB) — the plan left that open. Every request must carry
`reasoning_effort: "none"`.

## Decision 2 — where the description text lives

This is the load-bearing decision, and one fact settles most of it. From
`scripts/search-companion/endpoints/upsert.mjs` (the `/v1/chunks/upsert` handler):

> The first chunk seen for a `(vaultId, path)` clears every existing row for that path: an
> upsert is a full replace, not a merge.

So **you cannot inject a synthetic image chunk under the owning note's path out of band.** It
survives until the next ordinary re-index of that note — every content edit, and every full
rebuild — and then silently vanishes. Any design that "adds a chunk for the image" without the
chunker itself producing it is a design that decays.

That leaves two honest shapes.

### Rejected: a sidecar note per image

Write `…/e6e3bc7e…_MD5.description.md` next to each attachment, let the normal indexing pipeline
pick it up, no companion changes at all. It is the obvious answer and it is wrong here for three
reasons, the second of which is concrete damage:

1. **It adds thousands of files to the vault.** `src/search/AGENTS.md` already records that the
   orchestration queue's own job files inflated this vault's apparent note count by ~7.7×; 4,751
   more description files (or 1,175, one per note) makes a known problem worse for no benefit.
2. **It breaks the Orphaned Attachments dashboard.** `computeOrphanedAttachmentRows`
   (`src/ingestion/data/orphanedAttachments.ts`) flags any `_MD5` file absent from
   `metadataCache.resolvedLinks`, and `resolvedLinks` covers embeds *and* body links. A sidecar
   that references its image at all — which it must, to be navigable — makes every genuinely
   orphaned attachment look referenced, and the dashboard's cleanup function silently goes to
   zero. Making the sidecar mention the image only as plain text would preserve the dashboard
   and destroy the sidecar's usefulness.
3. **It surfaces the wrong path in results.** A hit would land on the sidecar, not on the post
   the reader wants. Fixing that means deranking or rewriting sidecar hits, which is a second
   mechanism to maintain.

### Recommended: the chunker emits the description chunks

Persist descriptions in a plugin-owned store keyed by **content MD5** (the `_MD5` filename
already *is* that hash — see the deterministic-content-hash quirk), and have `buildSearchChunks`
append one chunk per embedded attachment when it chunks a note. Sketch:

- Store: `_crucible/image-descriptions/` (already under the default search exclusion) or plugin
  data. Keyed by MD5, so the 7.3% of attachments that are duplicate content are described once,
  and re-clipping the same image is free forever.
- At chunk time, `buildSearchChunks` reads the note's embedded attachment refs, looks up each
  MD5, and appends chunks with the owning note's `path`, a heading like
  `Image: <original filename>`, and the description text. `stableChunkId` already keys on
  `(vaultId, path, ordinal, heading)`, so the ids are deterministic and the full-replace upsert
  becomes *correct* rather than hazardous — it regenerates exactly what it deleted.
- **`contentHash` must fold in the descriptions' own hash.** This is the one non-obvious
  requirement and it is the same trap `embeddingCoverageSatisfied` was written to close: the
  skip condition in `SearchManager.indexFiles` is "content hash matches **and** coverage is
  satisfied", so a description arriving for an unchanged note would leave that note permanently
  skipped and permanently description-less, with no error anywhere. Fold the description hashes
  into the note's index-time content hash and describing an image *is* a content change, which
  re-indexes the note through the ordinary path.

What this buys: no new vault files, no companion schema change, no
`SEARCH_REQUIRED_SCHEMA_VERSION` bump, hits attributed to the note the reader wants, the
orphan dashboard untouched, and deleting the description store degrades cleanly to today's
behaviour on the next rebuild.

Store the two passes as **two chunks** (narrative, extraction) rather than one concatenation.
They have different shapes — the narrative is one dense paragraph, the extraction can run to
875 tokens of transcribed table — and bm25 and the vector leg both score per chunk, so a focused
narrative chunk competes properly against ordinary prose chunks instead of being diluted.

## Decision 3 — where the work is scheduled

**A file-backed queue job, batched by note, not a Localize post-pass and not the memory queue.**

*Not a Localize post-pass.* `localizeNote` holds the note lock for the entire async operation
(deliberately — see the re-read-before-write quirk) and already runs for seconds to tens of
seconds on downloads. Adding a median **19 s** of VLM work per note (p90 ≈ 94 s at 10 images,
worst case ≈ 11 min at 71) inside that lock would gray the editor for minutes and stall every
"Ingest as …" chain that calls localize as a step. A description is also not needed for the note
to be *correct*, which is the bar for work that belongs inside the lock.

*Not the memory queue.* `MemoryJobBackend` exists for transient, UI-scoped work — it forgets
terminal entries after `terminalRetentionMs` and does not survive a restart. The backfill here is
**12.4 hours** across 4,751 images and must be resumable across Obsidian restarts, which is the
definition of the durable, file-backed path.

*But not one job per image either.* The file queue is exactly what inflated this vault by 37,081
job files; 4,751 more is the same mistake at a smaller scale. Follow the `SearchIndexWorkflow`
precedent instead — it batches a full rebuild into jobs of `SEARCH_REBUILD_BATCH_FILES = 100`
paths. Here:

- **Backfill:** one job per batch of ~100 images → ~48 jobs for the whole vault.
- **Incremental:** one job per note, dedupe key `note:<path>`, matching
  `youtube_metadata_fetch`'s per-note keying.
- **Cross-note dedup** happens inside the job, not in the dedupe key: two notes embedding the
  same image both enqueue, and the second finds the MD5 already described. Serialize the
  check-then-describe under a resource lock `image::<md5>`, exactly as `yt-video::<id>`
  serializes `ensureMetadataNote`. The note→resource acquisition ordering is respected trivially
  here, because **this job takes no note lock at all** — it writes to the description store, not
  to the note. That is a real advantage of Decision 2 over any frontmatter-writing variant: no
  lock contention, no interaction with the debounced auto-lint/auto-localize handlers, and no
  `updateFrontmatter` write barrier to reason about.
- Because nothing in the vault changes, the job must explicitly ask `SearchManager` to re-index
  the notes embedding the newly described image; the folded content hash then makes that
  re-index do real work.
- Emit an `ingestionEvents` signal (`image-described`) when a batch lands. Every ingestion path
  in this plugin is expected to emit its matching event so the dashboard's live refresh routing
  keeps working; a new one that stays silent is a bug by house rule.

### Transcoding

42% of the corpus needs it, and it needs **no dependency**. Crucible runs in Obsidian's Electron
renderer, which decodes WebP and AVIF natively: `createImageBitmap(blob)` into an
`OffscreenCanvas`, then `convertToBlob({ type: 'image/png' })`. Do it in memory at request time.
Do **not** write a transcoded copy into the vault — it would be a second file for the same
content, outside the `_MD5` naming convention, and therefore invisible to the orphan scan and to
re-localize idempotence.

The 74 SVGs are a separate and much cheaper case: an SVG is text, so its `<title>`, `<desc>` and
`<text>` content can be extracted and indexed directly with no model at all. Worth doing, not
worth conflating with this.

## Embedding-space implications — there are none, and that is the point

**The described text is embedded by the normal text embedding model** (`searchEmbeddingModel`,
`bge-m3` today), through the same `SearchChunk.embedding` path as every other chunk, into the
same `embedding_space`. The vision model is a **text producer**, not an embedder. Concretely:

- No new vector space, so no change to `embeddingSpaceId`, no partitioning of the vector matrix,
  and no interaction with the vault-wide width-and-space upsert guard.
- No `SCHEMA_VERSION` / `SEARCH_REQUIRED_SCHEMA_VERSION` bump and no companion rebuild.
- The coverage-aware skip keeps working unchanged: description chunks are chunks, they get
  embedded like chunks, and `hasEmbeddings` stays a per-path all-or-nothing predicate.
- Switching embedding models re-embeds description chunks exactly as it re-embeds prose chunks,
  and does **not** require re-describing anything — the expensive artefact (the description) is
  model-independent text.

This is the single strongest argument for the whole design over the alternative below.

## Non-goals

**No CLIP-style image embeddings.** Rejected on four independent grounds, any one of which is
sufficient:

1. **It is a second vector space, by definition** — which is precisely what `embedding_space`
   was built to *prevent* sharing a matrix. Today that mechanism is a conservative fail-closed
   guard on a single-space vault; supporting an image space means promoting it into a real
   multi-space partition, with a second matrix, a second scan, and a query-time decision about
   how to fuse two incomparable score distributions.
2. **The vector leg is a brute-force full scan** with a measured interactive ceiling around
   250k chunks. Adding an image matrix spends that budget twice.
3. **It cannot answer the query that motivates this.** CLIP-class embeddings encode gist, not
   glyphs. "The chart showing hyperscalers at two-thirds of global AI compute" is answerable
   because a VLM *read the title and the axis*; the measured fact that gemma-4-26B reads `1468`
   off a 10-pixel bar label is exactly the capability an image embedder does not have.
4. It needs another model, another capability flag, another picker entry, and another
   multi-hour backfill — all to produce a worse answer.

**No OCR-only path** (tesseract or similar). It adds a native dependency to a plugin that has
deliberately kept `node:sqlite`-only discipline in its companion, and on charts it returns
floating label text with none of the structure — "1468", "Elo Rating", "Gemini" as unrelated
strings — which is strictly worse for retrieval than a sentence saying what the chart shows.

**No image search results.** A hit is a *note*, always. The description chunk exists so the note
becomes findable through its figures; surfacing the image itself as a result row is a different
feature with a different UI and is not in scope.

**No re-describing on model change.** Descriptions are cached by image content hash, not by
describing model. Upgrading 12B → 26B does not invalidate them; if a re-describe is ever wanted,
it is an explicit "rebuild descriptions" command, not an automatic consequence.

## Cost model

Over the 4,751 unique raster attachments (content-hash dedup applied — it saves 7.3%), at the
measured medians:

| pass | gemma-4-12B | gemma-4-26B-A4B |
|---|---|---|
| narrative only | 3,192 ms → **4.2 h** | 3,996 ms → **5.3 h** |
| narrative + extraction | 9,565 ms → **12.6 h** | 9,423 ms → **12.4 h** |

Steady state, per newly clipped note (p50 = 2 images, p90 = 10, max 71): **~19 s** for both
passes, ~94 s at p90, ~11 min worst case. Narrative-only halves that.

Recommendation: **run both passes.** A 12.6 h one-time backfill on a queue that already runs
unattended for hours is not the constraint, and the extraction pass is what makes a chart
findable by its *values* rather than only by its title. Transcoding's cost is not included above
and is not expected to matter (in-renderer canvas decode of a ~150 KB WebP), but it has not been
measured and should be before the backfill is sized.

Leaving thinking on would multiply every figure above by ~4.3, turning the backfill into
~2.2 days. That is what makes `reasoning_effort: "none"` a correctness requirement rather than a
tuning knob.

## Open questions for the implementation sprint

- Do the two passes merge into one request? Untested here — measured separately so their costs
  are attributable. A single request asking for a paragraph followed by structured content would
  save one image encode per image (~317 prompt tokens and one prefill) at the cost of a longer,
  harder-to-chunk answer.
- What is the per-note cap? A 71-image note is ~11 minutes of queue time; a cap with a "describe
  the rest" action may be better than describing all of them.
- Should description chunks carry a flag the ranker can see, so a description hit can be
  presented differently ("matched a figure in this note") without changing its score?
- Transcoding throughput in the renderer, measured, before the backfill batch size is chosen.
