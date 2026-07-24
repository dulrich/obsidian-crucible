# File-Open Palette Remediation + Search Ranking Upgrade

*Recommended model/effort — Claude: Opus/high for WP-1, WP-5 and orchestration, Sonnet/medium for WP-2 … WP-4, WP-6, WP-8; Codex: Sol/medium-high for WP-1, WP-5, orchestration, Terra/medium for the rest.*

## Context

Four items on the evaluation todo, investigated against the live code and the live vault:

| Todo | Finding |
|---|---|
| open-file palette is painfully slow | Confirmed. `getSuggestions` runs **five full O(N) passes plus N `prepareFuzzySearch` calls per keystroke** over a **47,310-file / 42,000-markdown** vault, with zero caching and zero debounce. Obsidian's own `obsidian.d.ts:4850` warns `prepareFuzzySearch` "may be an issue if you are running the search for more than a few thousand times." |
| ranking worse than the built-in | Confirmed, and it is a **bug, not a tuning gap**. `src/fileOpenRanking.ts:93` sorts `(a.score) - (b.score)` — *ascending* — against Obsidian's higher-is-better `SearchResult.score`. The palette shows the **worst** matches first, then `FILE_OPEN_LIMIT = 100` truncates away the best ones. The unit test misses it because the injected test scorer (`tests/fileOpenPalette.test.mjs:38-49`) sums character positions, i.e. *lower* is better — the double certified the inverted convention. Same inversion exists at `src/suggesters.ts:34` (`FileSuggest`/`FolderSuggest`, the mandated control for every file-path input in settings) and `src/folderPicker.ts:49`. |
| file types should be checkboxes | Confirmed gap. Two unrelated lists exist: `crucibleFileOpenPaletteExtensions` (free-text field, `settings/sections/commands.ts:196-204`) and a hardcoded, unconfigurable `SEARCH_EXTENSIONS = {md, qmd, txt}` (`src/search/chunker.ts:5`). No canonical Obsidian-readable extension catalog exists anywhere in the repo. |
| evaluate GBrain | Done — see `## GBrain evaluation` below. Verdict: reject the platform, adopt four retrieval ideas that need no new infrastructure. |

**Two things the investigation ruled out.** First, the palette **never touches the search companion** — it is pure `vault.getFiles()` in-memory work (`src/fileOpenPalette.ts:33`). The un-run re-index on the new container is therefore *orthogonal* to both palette complaints; fixing one will not fix the other. Second, SQLite is not the bottleneck anywhere: a `MATCH` against the 28,655-chunk legacy index returns in **3 ms**.

**But the re-index is its own problem.** The container volume holds a 4 KB empty DB; the legacy local index (`.crucible/search.sqlite`, 199 MB) covers only **2,527 of ~42,000** notes, all with `mtime ≥ 2026-06-06` — a full sweep has never completed. Kicking one off today enqueues **1,680 job files** in a single synchronous loop (`SEARCH_REBUILD_BATCH_FILES = 25`, `SearchIndexWorkflow.ts:8`), at `maxParallel: 1`. That needs raising before the first real rebuild, or the queue folder takes ~5,000 vault ops to drain.

Intended outcome: a palette that is faster and better-ranked than Obsidian's built-in while keeping its one genuine value-add (Crucible excluded-folder derank/hide), checkbox-driven file-type config on both axes, a materially better companion ranking, and a completed first full index on the containerized companion.

## Decisions locked

User-confirmed 2026-07-24:

1. **Ranking model:** basename-first composite (exact > prefix > contiguous substring > fuzzy, path as penalized fallback) **with** a recency boost from `workspace.getLastOpenFiles()`.
2. **File types:** two independent checkbox sets — one for what the palette will open, one for what the search indexer will ingest.
3. **GBrain:** written evaluation memo **plus** the cheap ranking wins **plus** the link-adjacency spider layer.
4. **Execution:** this session lands the plan, then orchestrates it.

## Summary

Replace the palette's per-keystroke full-vault rescan with a plugin-level snapshot maintained incrementally off vault events, and replace `prepareFuzzySearch` with a hand-rolled composite scorer whose direction is a documented, test-asserted constant. Per keystroke the hot loop becomes a char-class bitmask prefilter → `indexOf` on the basename → subsequence walk, over a *narrowing stack* that makes backspace O(survivors), feeding a bounded top-100 min-heap instead of a full sort. Target **p95 ≤ 8 ms, p99 ≤ 16 ms** at 47,310 candidates, synchronously — no debounce, because the fast path is ~1 ms and async `getSuggestions` ordering under overlapping promises is undocumented.

The same scorer is shared with `FileSystemSuggest` and `folderPicker`, fixing the identical inversion in the settings tab. A canonical Obsidian-readable extension catalog drives two checkbox grids. On the companion, four GBrain-inspired changes (bm25 column weights, AND-first + prefix-expanded query construction, best-chunk-per-path pooling, RRF fusion with a title-phrase rank) plus a client-side link-adjacency boost built from `metadataCache.resolvedLinks` — no new store, no embeddings, no schema migration beyond an FTS5 `prefix=` index.

## GBrain evaluation

*Written up in full as WP-8; the verdict is recorded here because WP-5/WP-6 build on it.*

**Reject the platform.** GBrain is a Postgres/PGLite + pgvector system of record with its own brain repo, schema packs, MCP server, 43 skills, a BullMQ-shaped job queue, and an LLM synthesis layer. Crucible's vault *is* the system of record and Obsidian *is* the UI; adopting GBrain means running a second source of truth and re-solving sync. Crucible already has its own job queue (`Orchestrator` + two `JobBackend`s), its own provider/agent layer for synthesis, and its own triggers. The overlap is nearly total and the seams do not line up.

**Adopt four retrieval ideas** — each is a small, self-contained change to `scripts/search-companion.mjs` or `SearchManager`, and none needs embeddings, Postgres, or an LLM:

1. **Best-chunk-per-page pooling** — "vector retrieval pools the best chunk per page, so a page surfaces on its strongest evidence instead of losing to a neighbor on one weak chunk." Crucible has 28,655 chunks over 2,527 paths and currently ranks raw chunks; a `GROUP BY path` taking the max score fixes a real dilution problem.
2. **Title/alias phrase boost** — "queries that match a page's title phrase or a declared alias get boosted to the page they name." This is the companion-side twin of the palette's basename-first tiering, and directly serves the user's "favor short/continuous substring" instinct.
3. **Reciprocal-rank fusion** — fuse the bm25 ranking with a title/path-match ranking rather than trying to hand-tune one score. `SearchModal.formatScore` already renders a `scoreRrf` field that nothing populates.
4. **Per-stage score attribution (`--explain`)** — base score, every boost that fired, what it multiplied. `SearchModal` already has the display slot.

**Adopt the graph idea, not the graph store.** GBrain's +31.4 P@5 lift comes from typed edges extracted on every page write. Obsidian *already maintains that graph* — `metadataCache.resolvedLinks` and `getFileCache(f).frontmatterLinks`. An adjacency boost can be computed client-side in `SearchManager` from data already in memory: zero new storage, zero re-index, no companion schema change. That is the "link spider layer" at ~1% of GBrain's cost.

**Explicitly out of scope:** pgvector/PGLite engine swap, MCP server + skillpacks, the overnight dream cycle, schema packs, and the `gbrain think` synthesis layer.

## Key Changes

**WP-1 — Palette scorer + selection core (~0.9 kSLOC touched, ~350k tokens, ~27 min wall).** New pure `src/rankScore.ts` (compiled query, char-class bitmask, tiered composite scorer, match-range builder) and a rewrite of `src/fileOpenRanking.ts` (snapshot type + builder + delta application, narrowing stack, top-K heap selection). Both stay free of any `obsidian` import so the esbuild-bundling test harness keeps working. Files: `src/rankScore.ts` (new), `src/fileOpenRanking.ts`, `tests/rankScore.test.mjs` (new), `tests/fileOpenPalette.test.mjs`. *Model: top (Claude Opus/high; Codex Sol/medium-high). Execution: Claude subagent (0% saving at equal weight — dispatched anyway per subagent-default, for the diff double-check and orchestrator headroom); Codex subagent (same).*

- **Delete the `scorePath` injection point.** It is what allowed the test double to certify the inverted convention. Export `SCORE_HIGHER_IS_BETTER = true` and document the convention at the top of `rankScore.ts`.
- **Composite score**, best tier per term, basename checked before path: EXACT 1000 / PREFIX 900 / WORD-boundary 800 / SUBSTR 700 / FUZZY 500 / PATH_SUBSTR 400 / PATH_FUZZY 250 / reject. Modifiers: `+100·(termLen/nameLen)` coverage, `−2·min(matchStart,20)`, `+40·(longestRun/termLen)` and `−3·gapCount` on fuzzy tiers only, `+15` raw-case-exact, `−2·depth`, `−0.05·pathLen`, recency (capped, see WP-2), and `−5000` when `ignoredFolderMode === 'derank' && ignored`. Multi-term = mean of per-term scores, `+25` if terms match left-to-right without backtracking. A query containing `/` switches to path-only matching.
- **The 100-point tier gap is a load-bearing invariant** — every modifier is bounded well under it, so a substring match on a long name always beats a fuzzy match on a short name. Assert it arithmetically in a test.
- **Snapshot** is columnar for the hot fields: `lower: string[]`, `nameStart: Int32Array`, `nameLen/pathLen: Uint16Array`, `depth: Uint8Array`, `extId: Uint16Array` (interned), `maskPath/maskName: Uint32Array`, `flags: Uint8Array` (IGNORED, TOMBSTONE), `mtime: Float64Array`, `byLower: Map<string,number>`, `exclusionSig: string`. ~7 MB steady state at 47k rows, replacing ~30 MB/s of allocation churn while typing.
- **The bitmask is the main win:** bits 0–25 = `a`–`z`, 26 = digits, 27–30 = `/`, `-`/`_`, `.`, space, 31 = non-ASCII. `(maskPath[i] & queryMask) === queryMask` is one integer AND; 47k of them is ~0.2 ms and rejects almost everything for a 3+ distinct-letter query before any string is touched.
- **Narrowing stack** (`{query, ids: Int32Array, count}[]`, depth ≤ 8, root frame implicit): pop while `!newQuery.startsWith(top.query)`, scan the survivors, push if the query extended and survivors < size/2. Backspace becomes O(survivors). **Soundness requires a monotone admission predicate** — "every whitespace-separated term is a subsequence of the lowercased path." Scores may change freely between keystrokes; only *admission* must be monotone. Non-prefix edits (paste, mid-string edit, IME commit) fall back to the root frame, which is the mask-prefiltered ~5–10 ms path, not a cliff.
- **Top-K min-heap of 100** over parallel `Int32Array`/`Float64Array`; once full, `score <= scores[0]` is a single-float reject taken by >99% of the corpus. Drain and run one precise `Array.sort` on the 100 winners with the full comparator. The derank group is folded into the heap key (`−5000`) so ignored rows can never interleave. This removes the `path.split('/')` calls currently made **inside** the comparator.
- **Empty query** currently returns the alphabetically shortest paths, which is useless — order it recency → `mtime` desc → depth.
- **Match ranges** are materialized for the ≤100 winners only, never in the hot loop. `SearchResult` is an interface, so a structurally identical local `FileOpenMatch { score, matches: [number,number][] }` satisfies `renderResults` with no `obsidian` import.

**WP-2 — Palette index lifecycle + UI wiring (~0.45 kSLOC touched, ~180k tokens, ~14 min wall).** New `src/fileOpenIndex.ts` (chunked build, delta queue, invalidation), thin rewrite of `src/fileOpenPalette.ts`, compiled exclusions, `main.ts` wiring, and the missing CSS. Files: `src/fileOpenIndex.ts` (new), `src/fileOpenPalette.ts`, `src/exclusions.ts`, `src/main.ts`, `styles.css`, `tests/exclusions.test.mjs`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude subagent (40% saving, 128k vs 180k); Codex subagent (39% saving).* Depends on WP-1.

- Modeled on the existing `SearchIndexCoordinator` house pattern: instantiated in `main.ts`, fed by the same `vault.on('create'/'delete'/'rename')` forwards (~lines 226/260/268), built in the existing `onLayoutReady` block (~line 213), disposed via `this.register(...)`.
- **Build lazily and chunked** — 4,000 rows per `setTimeout(…, 0)` slice, ~12 slices × ~8 ms, no dropped frame. `onOpen()` would be a visible 60–120 ms hitch on every hotkey press. **Ignore deltas until layout-ready** — Obsidian fires `create` for every file during initial load.
- **Deltas apply lazily at `getSnapshot()`** (i.e. modal open), not eagerly; `add` appends, `del` sets a tombstone, compact past 10% tombstones. If the queue exceeds `max(2000, size × 0.05)` — a bulk sync or import — discard it and schedule a full chunked rebuild.
- **Exclusion invalidation without touching every `saveSettings()` caller:** `getSnapshot()` compares a cheap `exclusionSig` against the snapshot's, and on mismatch re-runs only the `flags` pass (~2 ms). Add `compileExclusions(settings, scope): string[]` + `isPathExcludedCompiled(prefixes, path)` to `src/exclusions.ts` and reimplement `isPathExcluded` on top of them so `tests/exclusions.test.mjs` passes unchanged. `SearchIndexCoordinator` can reuse the compiled form.
- **Extension filter does not invalidate the snapshot** — it is an `extId` set-membership test at query time.
- **Recency**: read `workspace.getLastOpenFiles()` once in `onOpen()` into a `Map<string, number>`; `bonus = 60 · (1 − rank/count)`. **The 60 cap is the design** — it is below the 100-point tier gap, so recency reorders *within* a tier but can never promote a fuzzy junk match above a clean substring match. Skip index 0 when it equals `workspace.getActiveFile()?.path`.
- Set `this.limit = FILE_OPEN_LIMIT` (`SuggestModal.limit` is public and already slices) instead of maintaining a second cap.
- **Wrap `renderResults` in try/catch** falling back to `setText(item.path)` — the `matches` invariants (ascending, non-overlapping, in-bounds) are undocumented; a highlight is cosmetic, a modal that throws mid-render is not.
- `styles.css` has **no rules at all** for `.crucible-file-open-palette` / `.crucible-file-open-ignored`, so the derank affordance is currently invisible. Add them.
- Instrument with `performance.now()` around the selector, logging only when a keystroke exceeds 16 ms, through the gated `logWarn` channel in `src/log.ts` (`console.*` is banned outside that file).

**WP-3 — Fix the same inversion in the settings-tab pickers (~0.15 kSLOC touched, ~90k tokens, ~7 min wall).** `FileSystemSuggest.getSuggestions` and `folderPicker` sort worst-first against real Obsidian scores; `FileSuggest` is the mandated control for *every* file-path input in the settings tab, so it currently shows the 100 worst matches out of 42k files. Files: `src/suggesters.ts`, `src/folderPicker.ts`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude subagent (40% saving, 74k vs 90k); Codex subagent (39% saving).* Depends on WP-1.

- Adopt the shared `rankScore.ts` scorer — same short/contiguous-favoring behavior, one explicit score convention across the codebase, three fewer `prepareFuzzySearch` call sites.
- Memoize `getItems()` per instance (currently `getAllLoadedFiles()` + filter over 47k **per keystroke**) and the compiled query; use top-K. `renderSuggestion` (`suggesters.ts:52-53`) re-runs `prepareFuzzySearch` per row — reuse the memoized match.
- `folderPicker.ts:41-45` calls `fuzzySearch` **twice per item**; collapse to one call plus an offset, and precompute depth outside the comparator.
- **Do not** share the snapshot with the suggesters in this pass — they are folder-vs-file, `TAbstractFile`-typed, and filter on `metadataCache.isUserIgnored`; coupling them to a snapshot gated behind `crucibleFileOpenPaletteEnabled` would be backwards. Memoization alone removes the N-scan.
- `CommandSuggest`/`TagSuggest`/`YoutubeChannelSuggest`/`CurrencySuggest` in the same file already sort descending — leave them; they are the evidence this was a slip, not a convention.

**WP-4 — File-type checkbox grids, two independent sets (~0.5 kSLOC touched, ~200k tokens, ~15 min wall).** A canonical extension catalog plus two checkbox UIs and a settings-driven indexer list. Files: `src/fileTypes.ts` (new), `src/settings/sections/commands.ts`, `src/settings/sections/orchestration.ts`, `src/search/chunker.ts`, `src/types.ts`, `tests/fileTypes.test.mjs` (new). *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude subagent (40% saving, 140k vs 200k); Codex subagent (39% saving).* Depends on WP-1 (shares `fileOpenRanking.ts`'s extension exports — do not run in parallel with it).

- **Catalog** grouped by category — Markdown (`md`), Canvas (`canvas`), Base (`base`), PDF (`pdf`), Images (`png jpg jpeg gif bmp svg webp avif`), Audio (`mp3 wav m4a 3gp flac ogg oga opus`), Video (`mp4 webm ogv mov mkv`), Text (`txt qmd`). Prefer deriving from Obsidian's `app.viewRegistry.typeByExtension` when present — **undocumented internal**, so presence-guard it exactly the way `src/surround.ts` guards `vault.getConfig`/`setConfig` and `SecretRegistry` guards `app.secretStorage` — and fall back to the static catalog. Union in any extension actually present in the vault so nothing becomes unreachable.
- **Set A — palette openable types.** Replaces the free-text `bindText` at `settings/sections/commands.ts:196-204`. Keep `crucibleFileOpenPaletteExtensions: string[]` and its "empty = all" semantics so existing configs migrate untouched; `parseExtensionFilter`/`formatExtensionFilter` stay exported for the migration path and their tests.
- **Set B — search-indexable types.** New `searchIndexExtensions: string[]` defaulting to `['md','qmd','txt']` (today's hardcoded `SEARCH_EXTENSIONS`, so behavior is unchanged on upgrade). `isSearchIndexablePath` becomes settings-driven; every caller (`SearchManager.prepareFile`/`deletePath`/`listIndexableFiles`, `SearchIndexCoordinator`, the two upsert workflows, `commands.ts:412`) reads the same source. Restrict the offered checkboxes to text-extractable types — indexing a `.webp` into FTS5 is meaningless.
- **Changing set B invalidates the index.** Surface a warning in the settings row and note that a rebuild is required; do not auto-trigger one.
- Fix `chunker.ts`'s `path.split('.').pop()`, which returns the whole path for a dotless name — use the `dot > 0` form already correct in `fileOpenRanking.ts:116-120`.

**WP-5 — Companion ranking upgrade (~0.5 kSLOC touched, ~250k tokens, ~19 min wall).** The four adopted GBrain retrieval ideas, in the zero-dependency companion. Files: `scripts/search-companion.mjs`, `src/search/client.ts`, `src/search/types.ts`, `src/search/SearchModal.ts`, `tests/searchCompanionRanking.test.mjs` (new). *Model: top (Claude Opus/high — ranking semantics with a schema bump; Codex Sol/medium-high). Execution: Claude subagent (0% saving at equal weight — dispatched per subagent-default); Codex subagent (same).* Independent of WP-1…WP-4; can run in parallel.

- **Query construction** (`search-companion.mjs:261-266`) is pure `OR` today — one common term matches everything, no phrase, no prefix, and the `[a-z0-9_@./:-]+` class silently drops non-ASCII. Replace with: quoted-phrase clause for the whole query, `AND` of all terms, `OR` fallback when `AND` returns nothing, and `term*` prefix expansion on the trailing term so partial words match. Widen the character class to keep non-ASCII.
- **bm25 column weights** — `bm25(chunks_fts, 0,0,0, 10.0, 5.0, 1.0)` (title ≫ heading ≫ text). Currently unweighted, so a body mention outranks a title match. No schema change.
- **Best-chunk-per-path pooling** — `GROUP BY path` taking the best score, so a page surfaces on its strongest chunk. Return the winning chunk's snippet/heading.
- **RRF fusion** — fuse the bm25 rank with a title/path-match rank; populate the `scoreRrf` field `SearchModal.formatScore` already renders but nothing sets.
- **Drop the duplicate `COUNT(*) MATCH`** at `:198-202`, which doubles FTS work on every search — use a window function in the main query or return `hasMore`.
- **Add FTS5 `prefix='2 3'`** to make `term*` cheap. This is a schema change: bump `schemaVersion` past 1 in `/health`, and have the client surface "index rebuild required" rather than silently serving a stale index. Coordinate with WP-7, which runs the rebuild anyway.
- Keep `mode`/`semanticAvailable` honest — this WP adds no vectors.
- **Per-stage attribution** in the response (base bm25, each boost, the fused value) so ranking is tunable by observation rather than guesswork.

**WP-6 — Link-adjacency spider layer (~0.35 kSLOC touched, ~160k tokens, ~12 min wall).** The GBrain graph idea on Obsidian's existing graph. Files: `src/search/linkGraph.ts` (new), `src/search/SearchManager.ts`, `src/types.ts`, `src/settings/sections/orchestration.ts`, `tests/linkGraph.test.mjs` (new). *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude subagent (40% saving, 116k vs 160k); Codex subagent (39% saving).* Depends on WP-5.

- Build adjacency from `metadataCache.resolvedLinks` **and** `getFileCache(f).frontmatterLinks` — note the precedent that `resolvedLinks` alone misses frontmatter property links, which is exactly the gap that can falsely flag orphaned attachments in the ingestion dashboard.
- Applied **client-side in `SearchManager.search`**, after the companion returns: take the top-K results as seeds, boost pages adjacent to two or more seeds. Client-side is the whole point — no companion schema change, no edge table, no re-index, and the graph is already in memory.
- Bounded like recency: the boost reorders within a result set, never promotes an unmatched page into it. Expose weight + on/off in settings; default **on** at a conservative weight.
- Feed the boost into WP-5's attribution output so its effect is observable.
- Keep `linkGraph.ts` a pure `(app, ...)`-taking module in the style of `utils/blogsIntake.ts` so it is callable outside a `WorkflowContext` and unit-testable.

**WP-7 — Rebuild throughput + first full index (~0.1 kSLOC touched, ~140k tokens, ~11 min wall + ~30 min index run).** Files: `src/orchestration/workflows/SearchIndexWorkflow.ts`, plus operational verification. *Model: top (Claude Opus/high; Codex Sol/medium-high). Execution: Claude **direct** — `must-direct:` this is the final integration + gates + commit duty, and the rebuild itself must be triggered from the user's live Obsidian and observed there; Codex **direct** (same reason).* Depends on WP-4 (indexer extension set) and WP-5 (schema bump).

- Raise `SEARCH_REBUILD_BATCH_FILES` from 25 to ~250 — 42,000 files currently means **1,680 job markdown files created in one synchronous loop** at `maxParallel: 1`, ~5,000 vault ops to drain. 250 gives ~168 jobs.
- Yield between enqueues so the rebuild kickoff does not block the UI thread.
- Then run `Orchestrate: Search rebuild index` against the container, watch the queue drain, and verify chunk/path counts in the container DB.
- **Note for the operator:** the legacy `.crucible/search.sqlite` (199 MB, 2,527 paths, all `mtime ≥ 2026-06-06`) is a partial index from the pre-container era. The container's named volume starts empty. Nothing needs migrating — the rebuild is authoritative.

**WP-8 — GBrain evaluation memo (~0.2 kSLOC, ~120k tokens, ~9 min wall).** Write up the `## GBrain evaluation` verdict above as a standing document: what GBrain is, why the platform is rejected, the four adopted retrieval ideas with their landing sites, the graph idea and why Obsidian's own metadata cache supersedes GBrain's edge store, and what stays out of scope. Files: `docs/gbrain-evaluation.md` (new), `docs/index.md`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: Claude subagent (40% saving, 92k vs 120k); Codex subagent (39% saving).* Independent — can run in parallel from the start.

## Public Interfaces

| Surface | Change |
|---|---|
| `searchIndexExtensions: string[]` | **New** setting, default `['md','qmd','txt']` (= today's hardcoded behavior) |
| `crucibleFileOpenPaletteExtensions` | Unchanged type/semantics; UI becomes checkboxes |
| `searchLinkBoostEnabled` / `searchLinkBoostWeight` | **New** settings for WP-6 |
| `isSearchIndexablePath(path)` | Becomes settings-driven; all seven call sites follow |
| `compileExclusions(settings, scope)` / `isPathExcludedCompiled(prefixes, path)` | **New** exports; `isPathExcluded` reimplemented on them, behavior identical |
| `rankScore.ts` | **New** pure module; exports `SCORE_HIGHER_IS_BETTER = true` as the documented convention |
| `rankFileOpenItems({ scorePath })` | **Removed** injection point — the scorer moves into the pure module |
| `GET /health` | `schemaVersion` bumped past 1 (FTS5 `prefix=` index) |
| `POST /v1/search` response | Adds per-stage score attribution; `scoreRrf` now populated |

No breaking changes to stored settings; the two new extension settings default to current behavior.

## Execution

Three tracks, dispatched per the orchestration skill. Subagents never commit — the orchestrator reviews each diff, re-runs the gates verbatim, and commits per WP.

```
Track A (palette):    WP-1 ──▶ WP-2 ──▶ WP-3
                        └────▶ WP-4
Track C (search):     WP-5 ──▶ WP-6
Track D (docs):       WP-8
                                        └──▶ WP-7 (direct, last)
```

- **WP-1, WP-5, WP-8 start in parallel.** WP-8 is pure prose and independent; WP-5 touches only the companion + search client.
- **WP-4 must not run concurrently with WP-1** — both touch `fileOpenRanking.ts` (WP-1 rewrites it, WP-4 depends on its extension exports).
- **WP-2 and WP-3 both depend on WP-1's scorer** and may run in parallel with each other once it lands.
- **WP-7 is last and orchestrator-direct** — it needs WP-4's indexer extension set and WP-5's schema bump, and the rebuild must be driven from live Obsidian.
- **Remind the user to run `npm run dev`** in a separate terminal before palette work begins, per the repo's hot-reload convention, and stop it before the full cleanup loop.

## Test Plan / Verification

**Gates (the repo's mandatory Full Cleanup Loop — run sequentially, not backgrounded, after every WP):**

```bash
npm run lint                    # ESLint + Stylelint, zero errors
npx tsc -noEmit -skipLibCheck   # zero TypeScript errors
node --test tests/              # unit suite
node esbuild.config.mjs production
grep -rn "console\." src/       # must match only src/log.ts
```

**Unit tests that specifically must exist** — the current suite is what hid the inversion, so these are the point:

1. **Sort direction, stated bluntly.** Two candidates, one scoring strictly higher; assert it comes first. Name it so a future reader cannot miss the convention.
2. **Tier ordering table.** Query `log` over `[log.md, logbook.md, daily-log.md, catalogue.md, Legal/Origins.md]` → assert exact index order. Under the *current* code this list comes out backwards; this is the test that would have caught the production bug.
3. **Narrowing equivalence (property test).** For a random corpus and query, `select(query)` cold must deep-equal `select(query)` reached by feeding every prefix through the narrowing stack **including a backspace sequence**. The highest-value new test — it is the safety net for the whole cache.
4. **Admission monotonicity.** No candidate admitted for `q + c` was rejected for `q`.
5. **Tier-gap invariant.** Max modifier sum < 100, asserted arithmetically, so tuning cannot silently break the ordering model.
6. **Recency cannot cross a tier.** Max-recency fuzzy match never outranks a zero-recency substring match.
7. **Match-range invariants.** Ascending, non-overlapping, in-bounds; ranged substrings reconstruct the query characters in order.
8. **Snapshot delta equivalence.** Add/rename/delete deltas produce a snapshot field-by-field identical to a fresh full build — catches incremental-index drift, the nastiest bug class in this design.
9. **Derank with real scores.** An ignored path with a perfect score sorts below a non-ignored path with a terrible score. This test passes today for the wrong reason (both scores inverted); with real scores it becomes meaningful.
10. **Length normalization / depth tiebreak.** `log.md` beats `logistics-planning-document.md`; same basename at two depths → shallower first.
11. **Companion ranking** (WP-5): title match outranks body match for the same term; `AND` beats the old `OR` on a two-term query; prefix expansion matches a partial word; pooling returns one row per path.

**Manual verification in Obsidian** (the repo requires a UI rerun packet rather than speculation for UI-observable behavior):

- Palette perf: open on the 42k-file vault, type `crucible` character by character, then backspace to `c`. With `window.__CRUCIBLE_DEBUG__ = true`, **no keystroke should log a >16 ms warning**. Subjectively: no caret lag.
- Palette ranking: query `crucible` → exact basename first, then prefix, then contiguous substring, then recently-opened, then fuzzy last. Query `Daily/2026` → path-mode matching. Empty query → most-recently-opened files.
- Derank: a file under a `search`-excluded folder shows below all normal matches with the "Excluded from search" affordance now **visibly styled**.
- Settings pickers: type into any file-path input; best matches must be at the top (this is the regression that shipped).
- Checkboxes: uncheck Images in the palette set → image files disappear from results. Toggle an indexer type → the rebuild-required warning appears.
- Companion: `Search vault` on a term appearing in one note's title and many notes' bodies → the title note ranks first; the status line shows the fused score breakdown.
- Link boost: search a term matching several notes, one of which is linked from two other hits → it moves up, and the attribution shows the adjacency contribution.
- **WP-7 end-to-end:** run `Orchestrate: Search rebuild index`, watch the queue drain to zero with no failed jobs, then verify the container DB has ~42,000 distinct paths (`docker exec crucible-search node -e "…"` against `/data/search.sqlite`) — up from the 2,527 in the legacy local index.

## Critical Files

| Path | Role |
|---|---|
| `src/fileOpenRanking.ts` | The inverted sort (`:93`), the unconditional 47k `exactPaths` Set (`:40`), the `split('/')`-in-comparator (`:94-97`) |
| `src/fileOpenPalette.ts` | `getSuggestions` (`:28-45`) — the per-keystroke full rescan |
| `src/rankScore.ts` | **New** — the shared scorer and the one documented score convention |
| `src/fileOpenIndex.ts` | **New** — snapshot lifecycle; model on `src/search/SearchIndexCoordinator.ts` |
| `src/exclusions.ts` | `isPathExcluded` (`:14-21`) re-normalizes every folder row on every one of 47k calls |
| `src/suggesters.ts` / `src/folderPicker.ts` | Same inversion at `:34` and `:49`; `getItems()` re-runs per keystroke |
| `src/search/chunker.ts` | Hardcoded `SEARCH_EXTENSIONS` (`:5`); the dotless-path `split('.')` bug |
| `src/settings/sections/commands.ts` | Free-text extension field (`:196-204`) → checkbox grid |
| `scripts/search-companion.mjs` | `buildFtsQuery` pure-OR (`:261-266`), unweighted `bm25`, duplicate `COUNT` (`:198-202`) |
| `src/search/SearchManager.ts` | Where the link-adjacency boost lands |
| `src/orchestration/workflows/SearchIndexWorkflow.ts` | `SEARCH_REBUILD_BATCH_FILES = 25` (`:8`) |
| `src/commandPalette.ts` | The **correct** memoization pattern (`:32-39`) to generalize |
| `tests/fileOpenPalette.test.mjs` | The test double (`:38-49`) that certified the inverted convention |

## Assumptions

1. **Obsidian's `SearchResult.score` is higher-is-better.** Its own `sortSearchResults` sorts descending, and four call sites in `src/suggesters.ts` already sort that way while three sort the other. WP-1 removes the dependency entirely by hand-rolling the scorer, so the fix does not rest on this assumption — but the *diagnosis* does. **Confirm visually on the first WP-3 rerun.**
2. **`renderResults`'s `matches` invariants** (ascending, non-overlapping, in-bounds) are undocumented. Mitigated by an invariant test plus a try/catch fallback to plain text.
3. **`app.viewRegistry.typeByExtension` is an undocumented internal** and absent from `obsidian.d.ts`. Presence-guarded with a static catalog fallback, per the `vault.getConfig` precedent in `src/surround.ts`.
4. **`SuggestModal` calls `getSuggestions` synchronously per input event** — observed, not documented. The design only requires it to be *fast*, so this is not load-bearing. Async `getSuggestions` is deliberately avoided: render ordering under overlapping in-flight promises is undocumented.
5. **The 1-character query is the perf worst case** (~5–10 ms) because the bitmask cannot discriminate on one letter. If measurement busts the budget on the target machine, the escape hatch is a first-character posting list (`Map<charCode, Int32Array>` built with the snapshot) — still synchronous, still deterministic. **Not** a debounce.
6. **The V8 string-identity optimization** (`toLowerCase`/`replace` returning the same reference when nothing changes) is a memory assumption only; correctness is unaffected if it does not hold.
7. **Nothing needs migrating from the legacy 199 MB index.** It covers 6% of the vault and the container volume starts empty; the WP-7 rebuild is authoritative.
8. **Open question deferred to the user, not decided here:** the palette currently ignores Obsidian's own "Excluded files" setting (`metadataCache.isUserIgnored`), which `FolderSuggest`/`FileSuggest` *do* honor. Folding it into the snapshot's IGNORED flag is one line and would make the two consistent — but it is a behavior change, so it should be a conscious call rather than a side effect of a perf rewrite.

**Total ≈ 3.15 kSLOC, ~1,490k raw tokens; ~1,330k Claude-path / ~1,255k Codex-path Opus/Sol-equivalent tokens.**
