# Thermo-Nuclear Code Review — Vault Search Feature

## Context

The vault search feature was added across the last 5 commits (`eb8963c..80652dc`, ~4,300 lines).
It introduces a SQLite-backed search companion (`scripts/search-companion.mjs`), a `src/search/`
module (manager, client, chunker, modal, lifecycle gate, debounce), 5 orchestration workflows,
embedding + multi-modal (image-extraction) support in `providers.ts`, and folder-scoped exclusions.
It is explicitly **not yet fully implemented** (embeddings are scaffolding).

This review judges implementation quality, not behavior. The feature is reasonably well-tested
(8 new test files) and the `src/search/` decomposition is mostly sound. But there are **two
presumptive blockers** and several high-value simplifications that should land before this grows
further, because the churn-risk the commit messages worry about is real and concentrated in a few
spots.

---

## Blockers

### B1. `providers.ts` crossed the 1,000-line line (981 → 1,309)

This is the rule-1 violation. The PR dumped **two unrelated capability areas** — text embeddings
*and* multi-modal image extraction — directly into the already-large `ProviderManager` class:

- `embed()` + `callOpenAICompatibleEmbedding()` + `callOllamaEmbedding()`
- `extractImageMetadata()` + `callOpenAIImageExtraction()` + `callAnthropicImageExtraction()` +
  `callGoogleImageExtraction()` + `callOllamaImageExtraction()`

That's ~330 lines of per-provider HTTP plumbing, each method a near-copy of the others (headers,
`requestUrl`, status check, provider-specific JSON shape, parse). `ProviderManager` was already a
god-object for completions; this makes it worse.

The current file is organized **by capability**: three public methods (`complete`, `embed`,
`extractImageMetadata`), each repeating the same preamble (modelId check → CLI check → `loadApiKey`)
then a `switch (provider.kind)`. But everything that actually changes together lives **per provider**:
auth/header quirks (the OpenRouter `HTTP-Referer`/`X-Title` block is already duplicated across the
completion and image methods), `baseUrl` defaults, key-loading semantics (Ollama needs none), and
finish-reason mapping (`normalizeChatCompletionFinishReason` vs `normalizeAnthropicFinishReason`).

**Remedy (split by provider, not by capability):** one module per provider —
`src/providers/openaiCompatible.ts` (OpenAI + OpenRouter, differing only in baseURL default +
headers), `anthropic.ts`, `google.ts`, `ollama.ts`, `cli.ts` — each implementing a capability
interface with **optional** methods:

```ts
interface ProviderClient {
  complete?(...): Promise<ProviderCompletionResult>;
  embed?(...): Promise<ProviderEmbeddingResult>;
  extractImage?(...): Promise<ProviderImageExtractionResult>;
}
```

`ProviderManager` becomes a registry/dispatcher: resolve the provider impl by `kind`, call the
capability, and throw "provider does not support X" when the method is **absent** — which replaces
all three `default:` switch arms *and* the three duplicated preambles with a single lookup. A
provider that doesn't do embeddings simply omits the method. This co-locates each provider's auth /
headers / baseURL / finish-reason logic (deleting the OpenRouter-header duplication), pulls
`providers.ts` back under 1k, and means adding a provider or capability touches exactly one file.
(Image extraction is search-adjacent "multi-modal scaffolding," so it's in scope to call out here.)

### B2. Two parallel companion-availability gates

There are **two independent implementations** of "is the search companion up, and cache that
answer":

1. `SearchAutoIndexGate` (`src/search/lifecycleGate.ts`) — a proper class with online/offline TTL
   caches (`SEARCH_AUTO_ONLINE_CACHE_MS` / `OFFLINE_CACHE_MS`) and in-flight dedup. Used by `main.ts`
   for the auto-index path.
2. A module-level mutable `const searchOfflineUntilByUrl = new Map<string, number>()` plus
   `searchUnavailableResult()` / `searchErrorDeferredResult()` in
   `src/orchestration/workflows/SearchIndexWorkflow.ts`. Used by every workflow.

These have different semantics, separate state, and a hidden module-global Map keyed by URL (hard to
test/reset, survives across plugin reloads). Two sources of truth for the same fact is exactly the
spaghetti this skill flags.

**Remedy:** make `SearchManager` (or one shared gate it owns) the single authority on companion
availability — `await plugin.searchManager.companionAvailable()` — and delete the workflow-local
Map and `searchUnavailableResult`. Both the auto-index gate and the workflows then read one cache.

---

## High-value simplifications

### S1. Copy-pasted guard + try/catch across all 5 workflows

Every workflow in `SearchIndexWorkflow.ts` repeats the same scaffold:

```ts
if (!plugin.settings.searchEnabled) return { status: 'failed', error: '...' };
const unavailable = await searchUnavailableResult(plugin);
if (unavailable) return unavailable;
try { /* one real call */ }
catch (e) { const deferred = searchErrorDeferredResult(plugin, e); if (deferred) return deferred; throw e; }
```

Five classes, five copies. **Remedy:** a single wrapper —
`runSearchWorkflow(plugin, async () => { ...core... })` — that does the enabled-check, the
availability gate, and the deferred-on-network-error catch once. Each workflow collapses to its real
operation (often 3–4 lines). This is the biggest legibility win in the diff.

### S2. Error classification by regex string-sniffing

`searchErrorDeferredResult` decides "is this a transient companion outage" via
`/search service|connection|refused|timed out|network|fetch/i.test(message)`. This is brittle magic
(rule 4): any reworded error message silently changes retry behavior.

**Remedy:** have `SearchServiceClient` throw a typed `SearchServiceUnavailableError` for
timeouts / connection failures / 5xx, and let callers branch on `instanceof` instead of matching
prose. The `withTimeout` helper and the non-2xx branch in `client.ts` are the natural throw sites.

### S3. `source: 'auto' | 'manual'` mode flag + inline debounce in `main.ts`

`main.ts` grew the search wiring inline: an inline `Map<string, Timeout>` per-path debouncer in
`onload`, plus `enqueueSearchUpsert` / `enqueueSearchDeletePath` / `enqueueAutomaticSearchJob`, where
a `source` flag forks each enqueue into "go through the lifecycle gate" vs "enqueue directly." That's
a nullable-mode boolean threaded through three helpers, and it's feature logic living in the plugin
god-file (already 1,242 lines).

**Remedy:** extract a `SearchIndexCoordinator` (in `src/search/`) that owns the per-path debounce
timers, the availability gate, and the auto-vs-manual enqueue policy. `main.ts` just forwards vault
events (`create`/`modify`/`rename`/`delete`) to it. Removes ~80 lines from `main.ts`, deletes the
`source` branching (the coordinator *is* the auto path; manual callers hit `orchestrator.enqueue`
directly), and unifies with B2's gate.

### S4. `jobTypeConfig` boilerplate

`searchFileJobConfig`, `searchRebuildJobConfig`, `searchBatchJobConfig`, `searchSweepJobConfig` (and
the pre-existing `transcriptRefine`/`commandRun`/`imageMetadata`) are byte-identical except for
`dedupeKey`: all `{ persistence: 'file', maxParallel: 1, minIntervalMs: 0, dedupeKey }`.

**Remedy:** one helper — `fileJobConfig(dedupeKey?: (p) => string): JobTypeConfig` — collapses all
seven call sites to a single line each. Pure code-judo, no behavior change.

### S5. `indexFiles` returns a misleading file count

In `SearchManager.indexFiles`, `indexedFiles++` runs for **every input file** before the
`prepareFile` null-check, including non-indexable/excluded files and files whose hash is unchanged.
The method returns `{ files: indexedFiles }`, so the workflow notes ("Indexed N files") overcount —
they report files *seen*, not *indexed*. The genuinely useful counter (`processedFiles`, or a real
"changed/upserted" count) is computed but discarded.

**Remedy:** return the count of files actually upserted (or drop `indexedFiles` and report
`processedFiles`). Small, but it's a correctness/legibility wart in the core indexing loop.

### S6. `sweep()` magic keyword string

`SearchManager.sweep` appends a hardcoded incantation
(`'articles prompt kits project description relevant source repo guide'`) to every query. At minimum
hoist to a named constant with a comment on *why* those words; ideally this lives in config or in the
sweep workflow, not buried in the manager.

---

## What's good (keep)

- `src/search/` is otherwise a clean split: `chunker` is pure and well-tested, `client` cleanly
  isolates HTTP + normalization, `types` are explicit. The normalization functions in `client.ts`
  (`normalizeSearchResponse` etc.) are the right defensive boundary for an external service.
- `SearchAutoIndexGate` itself is a good abstraction (in-flight dedup + TTL) — the fix in B2 is to
  make it the *only* gate, not to remove it.
- Strong test coverage: chunker, client, debounce, lifecycle gate, hash, workflow queue, exclusions.
- `exclusions.ts` migration path (`migrateExcludedFolders`) is tidy and tested.

---

## Suggested sequencing

1. **B2 + S1 + S2 together** — unify availability gating, add the workflow wrapper, introduce the
   typed error. These three are interlocked and deliver the largest spaghetti reduction.
2. **B1** — split `providers.ts` embedding/image-extraction into capability modules (independent;
   biggest file-health win).
3. **S3** — extract `SearchIndexCoordinator`, deleting the `source` flag and the inline debounce.
4. **S4 / S5 / S6** — mechanical cleanups, land anytime.

## Verification

- `npm test` (or the project's test runner) — existing search test files must stay green; add a
  `runSearchWorkflow` wrapper test and a `SearchServiceUnavailableError` classification test.
- `npx tsc --noEmit` for the type changes (typed error, capability-module signatures).
- Manual: with the companion **down**, confirm auto-index and manual rebuild both defer (not throw)
  and the dashboard shows the "companion not reachable" deferral — exercises the unified gate.
- Manual: with the companion **up**, rebuild a small vault and confirm the "Indexed N files" note
  matches the count of files actually changed (validates S5).
- Confirm `wc -l src/providers.ts` is back under 1,000 after B1.
