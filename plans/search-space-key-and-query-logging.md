# Portable embedding-space keys, and passive query logging for a real S2

*Recommended model/effort — Claude: Sonnet/medium for WP-1, Opus/high for WP-2; Codex: Terra/medium for WP-1, Sol/medium-high for WP-2.*

## Context

Both work packages come out of ESI WP-5 Stage 2, and both were found by the user doing ordinary
things rather than by a review.

**WP-1** surfaced when "Fetch Models" was used to configure the local GPU embedder. It populated
the model field with `/models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf` — the served id, which
for a llama-server container is a **container-internal mount path**. That string then flows
straight into the vector-space key, because `SearchManager.activeEmbeddingSpaceId()`
(`src/search/SearchManager.ts:365`) builds the space as `activeEmbeddingModelId() + '/' + precision`
and `activeEmbeddingModelId()` (`:349`) returns `settings.searchEmbeddingModel.modelId` verbatim.

Measured 2026-07-25 against the live container: **llama-server ignores the `model` request field
entirely and echoes it back.** `totally-made-up-name` returns a valid 1024-d embedding with
`"model":"totally-made-up-name"` in the response. Two consequences:

- The space key becomes host- and mount-specific. Change the compose mount, or switch to the
  `crucible-embed-gpu` variant that mounts `~/.lmstudio/models`, and the same weights produce a
  different space → a full re-embed of 52,627 chunks for nothing. This is exactly what the design
  comment at `src/search/types.ts:71-73` forbids, and the same category of error as the plan's own
  recorded rule that ollama's `digest` must not be the key.
- **WP-2's "warn once per session when `servedModel` disagrees with the configured id" can never
  fire against llama-server**, because an echo cannot disagree. A guard that structurally cannot
  trip is worth either fixing or documenting as inert.

The workaround in use today is manual: type `bge-m3` instead. It works *because llama-server hosts
one model and ignores the field* — it would be wrong against LM Studio or vLLM, which route on the
id. So the fix cannot simply be "always shorten the id".

**WP-2** comes from arm D1 (`runs/measurements/esi-fr-2026-07-25/arms/D1-fts-vs-vector.md`). D1
could only be run on **four** queries because no recorded set of real vault searches exists — the
one attempt to find them swept monthly `## Observations`, `core/`, and a sibling repo and turned up
exactly one recollection-shaped line in the whole vault. Constructed fill was considered and
rejected: if the same party writes the queries and runs the test, "FTS cannot find this" becomes a
property of the authorship. The user's own conclusion, and it is the right one.

Logging by discipline fails for the obvious reason — you remember to log a query exactly when you
are not in a hurry, which is not when the hard lookups happen. Logging passively does not.

## Decisions locked

User-confirmed 2026-07-25:

1. **Both are follow-ups, not report edits.** Changing the ranker or the space key mid-report
   invalidates every number in `runs/measurements/esi-fr-2026-07-25/`.
2. **Query logging is a real feature, not test scaffolding** — it ships to users, so it is
   opt-in, local, and inspectable.

## Key Changes

**WP-1 — Separate the request-model id from the vector-space id (~0.35 kSLOC touched, ~180k tokens, ~14 min wall).** Files: `src/search/SearchManager.ts`, `src/search/types.ts`, `src/types.ts`, `src/settings/sections/ai.ts`, `src/providers/openaiCompatible.ts`, `tests/searchEmbeddingSpace.test.mjs`. *Model: mid (Claude Sonnet/medium; Codex Terra/medium). Execution: subagent.* No dependencies.

- **Add an explicit, optional space id on the model** — `ProviderModel.embeddingSpaceId?: string`
  beside the existing `embeddingVariant?`. When set it *replaces* the model id in the space key;
  when empty, behaviour is exactly today's. This is the honest fix: the portable identity becomes
  a thing the user states rather than a thing inferred from a string that was never meant to carry
  it. Follow `embeddingVariant`'s precedent for the settings row and its "fallback for runtimes
  that cannot self-report" labelling.
- **Normalize a path-shaped model id when deriving the space** (not when sending the request):
  if the configured id looks like a filesystem path, key on its basename without extension. This
  is a mitigation, not the fix — `bge-m3-f16` and LM Studio's `text-embedding-bge-m3@f16` still
  differ — so it must not be presented as making spaces portable across servers.
- **Fetch Models should not silently make the served id the space key.** Keep populating the
  request field with the served id (that is correct, and required by LM Studio/vLLM), but when the
  served id is path-shaped, prefill `embeddingSpaceId` with the normalized basename and say so in
  the UI. A user who never opens the field gets a portable key by default.
- **Decide the fate of the `servedModel` disagreement warning.** Against llama-server it cannot
  fire. Either drop it, or narrow it to providers whose `/v1/models` actually enumerates (LM
  Studio, vLLM) and document the echo case. Do not leave an inert guard implying coverage.
- Tests: a path-shaped id yields a basename-keyed space; an explicit `embeddingSpaceId` wins over
  both; an empty one reproduces today's key byte-for-byte (the no-re-embed guarantee).

**WP-2 — Passive vault-search logging (~0.5 kSLOC touched, ~260k tokens, ~20 min wall).** Files: `src/search/VaultSearchModal.ts` (or its actual home), `src/search/queryLog.ts` (new), `src/types.ts`, `src/settings/sections/ai.ts`, `tests/searchQueryLog.test.mjs` (new). *Model: top (Claude Opus/high; Codex Sol/medium-high) — it touches an interactive surface and writes user data. Execution: subagent.* Independent of WP-1.

- **Record, per search: the query text, the ranking shown (paths + ranks), the mode
  (fts/hybrid/rerank), and — the load-bearing part — which result the user opened.** Opening
  result #4 instead of #1 is a judgment-free relevance signal. This is implicit relevance
  feedback, which is how production IR systems are evaluated; it is strictly better evidence than
  a preference sitting because it is collected from real intent rather than recalled intent.
- **Opt-in, off by default, and visibly so.** It records what the user searches for; that is
  exactly the kind of thing that must never turn itself on.
- **Write to a managed note or JSONL under the queue root**, and — per the standing rule — make
  sure the path lands under an already-search-excluded prefix. A query log that gets indexed
  becomes the next `FEEDBACK.md`: a note containing every query's terms, which arm D1 measured
  suppressing the FTS fallback vault-wide.
- **No abandoned-search inference.** A search with no click is not a failure — the user may have
  read the snippet and been satisfied. Record the absence, do not label it.
- Deliverable for the report: a command that exports the log as an S2-shaped query file
  (`{id, text, source, targetPaths}`), with `targetPaths` seeded from what was actually opened.
  That closes the loop — D1 re-runs on real queries with real targets and no authorship bias.

## Public Interfaces

| Surface | Change |
|---|---|
| `ProviderModel.embeddingSpaceId?` | **New** optional setting; empty preserves today's key exactly |
| `searchQueryLogEnabled` | **New** setting, default **false** |
| `searchQueryLogPath` | **New**; must sit under a search-excluded prefix |
| `Search: export query log as query set` | **New** command |

No forced re-embed from either WP: WP-1's default path reproduces the current key byte-for-byte.

## Test Plan / Verification

Gates per the repo standard (`npm run lint`, `npx tsc -noEmit -skipLibCheck`, `npm test` — baseline
**520/520**, `node esbuild.config.mjs production`, `grep -rna "console\." src/` matching only
`src/log.ts`, and `file` on every edited file — a raw NUL has now shipped **three** times).

1. Empty `embeddingSpaceId` produces a key identical to the current one — the no-re-embed proof.
2. A path-shaped model id keys on its basename, and the request still sends the full id.
3. Query log is inert when disabled: no file created, no writes.
4. The log path is rejected at save time if it is not search-excluded.
5. Exported query sets validate against `dseries-judge.mjs prepare`'s schema.

## Assumptions

1. **llama-server ignoring the `model` field is verified, not assumed** (2026-07-25, both the
   embedder on 4804 and the reranker on 4805; rerank additionally answers on `/rerank`,
   `/v1/rerank` and `/reranking`). It is a property of that server, not of the
   `openai-compatible` kind — LM Studio and vLLM route on the id.
2. **The query log will be small.** Interactive searches are human-paced; this is not the
   orchestration queue and needs no rotation scheme on day one.
3. WP-2's value is realized weeks later, not on landing. It should ship early precisely because
   its output accrues with time.
