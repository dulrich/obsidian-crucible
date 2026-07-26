# Crucible Search Companion

Crucible's Obsidian plugin talks to a local HTTP service for search storage and ranking. This keeps native SQLite modules out of the plugin bundle.

## Local SQLite

### Docker Compose (primary)

The companion runs as a docker-compose service, either standalone (`docker compose up` from this repo root) or enrolled in the `context-control` fleet as `crucible-search` (`home-compose up crucible-search`). The container binds `0.0.0.0` internally and publishes to the host on loopback only, so from the plugin's point of view it's reachable the same way as the standalone process below.

Defaults inside the container:

- URL: `http://127.0.0.1:4801`
- Database: named volume `crucible-search-data`, mounted at `/data/search.sqlite`

The volume starts **empty** — the schema self-creates on first boot, but it holds no chunks until you run a search index rebuild from the plugin. This is expected after first `up`, not a bug.

### Standalone (dev fallback)

```bash
npm run search:serve
```

Defaults:

- URL: `http://127.0.0.1:4801`
- Database: `.crucible/search.sqlite`

Overrides:

```bash
node scripts/search-companion.mjs --port 4801 --host 127.0.0.1 --db /path/to/search.sqlite
```

Or via environment: `CRUCIBLE_SEARCH_PORT`, `CRUCIBLE_SEARCH_HOST`, `CRUCIBLE_SEARCH_DB`. `CRUCIBLE_SEARCH_HOST` defaults to `127.0.0.1` (loopback-only) for the standalone path; only the container sets it to `0.0.0.0`, since a loopback bind inside a container is unreachable from the host even with a published port.

The bundled companion script implements local SQLite FTS5/BM25 plus a vector leg: it stores embedding vectors as a `BLOB` (little-endian float32, not JSON — a BLOB reads straight into a `Float32Array` with zero parse, which matters once you're loading 52k+ chunks on wake) and ranks with them. `POST /v1/search` fuses three RRF lists — text, title, vector — rather than two, and `scoreVector`/`attribution.vectorRank` are populated whenever a query embedding arrives and the vault has vectors.

**Why no `sqlite-vec` (or other vector extension), and why that's a measured decision, not a deferred TODO.** `sqlite-vec`'s `vec0` tables do exhaustive KNN — ANN indexing (IVF/HNSW) is roadmap, not shipped — so it would buy a large constant factor via SIMD/quantization, not a smaller complexity class, at the cost of the companion's most load-bearing invariant: dependency-free, one-file `COPY`, no `npm install`, no platform-and-arch-specific `.so`. Brute-force cosine over the full in-memory matrix already measures **13ms at 384d, 24ms at 768d, 33ms at 1024d** over 52,257 chunks (single-threaded JS, `Float32Array` full scan), and that scan is exactly linear:

| chunks | ≈ notes | scan | resident |
|---|---|---|---|
| 52,257 (today) | 5,455 | 33ms | 0.21 GB |
| 100,000 | 10,400 | 63ms | 0.41 GB |
| 250,000 | 26,100 | **158ms** | 1.02 GB |
| 500,000 | 52,200 | 316ms | 2.05 GB |
| 1,000,000 | 104,400 | 631ms | 4.10 GB |

Type-ahead has a 200ms debounce and the companion answers a 3-character FTS query in ~27ms today, so +33ms is invisible and +158ms starts to bite — the **interactive ceiling is ~250k chunks (~26,000 notes)**. Past that, the dependency-free escape hatches, in order, are: (1) shard the scan across `node:worker_threads` over a `SharedArrayBuffer` (the matrix is already one flat `Float32Array`), which buys roughly the same constant factor SIMD would; then (2), if resident memory becomes binding first (it does, around the same point), `int8` quantization with a float32 rescore of the top ~1000 cuts residency 4×. See the AGENTS.md quirk on the vector leg for the rest of the reasoning (dimension-agnostic contract, the full-matrix-scan requirement, why `int8` isn't used yet at this size) and `plans/semantic-vector-leg-and-reranker.md`'s "Why not `sqlite-vec` now" section for the full argument as originally worked through.

### Schema and operational surface

- **Schema version 5** is required (`SCHEMA_VERSION` in this script, `SEARCH_REQUIRED_SCHEMA_VERSION` in `src/search/types.ts`, bumped together). A companion reporting a lower `schemaVersion` is flagged `rebuildRequired` by the client. Every migration runs automatically on companion startup and none of them re-reads a note or recomputes a vector:
  - **2→3** — three additive `ALTER TABLE chunks ADD COLUMN` statements (`embedding BLOB`, `embedding_dim INTEGER`, `embedding_model TEXT`).
  - **3→4** — one additive `ALTER TABLE chunks ADD COLUMN embedding_space TEXT`, backfilled from `embedding_model` so an index written before the column existed keeps exactly its current vector identity.
  - **4→5** — `chunks` moves from `PRIMARY KEY (id)` to `PRIMARY KEY (vault_id, id)`. SQLite cannot `ALTER` a primary key, so this is a **lossless table rebuild, not a reindex**: create the replacement table, `INSERT ... SELECT` every column (and the `rowid`) across, drop, rename, then drop and refill `chunks_fts` from `chunks` in the same transaction. The copy cannot lose a row because the new key is strictly weaker than the old one — a table that enforced `id` unique across the whole database necessarily satisfies `(vault_id, id)` unique. Embeddings ride across untouched.

  **Upgrading to schema 5 means updating the plugin and rebuilding the companion image together.** Between the two, `/health` reports `ok: false` and search is *unavailable*, not degraded — the client refuses an index it cannot rely on rather than serving it silently. Rebuild the container in the same landing as the plugin update.
- **Vault isolation.** Chunk ids are only unique *within* a vault: `stableChunkId` folds the vault id into its hash, and every companion statement keys on `(vault_id, id)` or `(vault_id, path)` — the upsert's conflict target, the `chunks_fts` delete, the vector-leg hydration, and the FTS→`chunks` join. Before schema 5 the first two keyed on `id` alone, so two vaults sharing one companion re-labelled and then destroyed each other's rows with no error anywhere. `tests/searchVaultIsolation.test.mjs` is the regression barrier; do not reintroduce an `id`-only chunk statement.
- **`GET /health`** reports the vector leg's real state: `vectorAvailable` (the vault holds usable vectors at one consistent width), `vectorBackend` (which backend answered — `brute-force-js` today), `embeddedChunks`, `embeddingDim`, and `embeddingModel` (the model that produced them, when every embedded chunk agrees on it).
- **`Search: embed missing vectors`** (command id `search-embed-missing`, in the `Search` command group) backfills vectors for already-indexed notes without touching the FTS index or calling `resetIndex()` — turning on semantic search after a vault is already indexed does not require a full rebuild. It fans out resumable batches, skips paths whose embedding coverage already matches the active model, and defers (rather than fails) on a transient embedder outage.

Recommended plugin settings for the bundled local service:

- Search service URL: `http://127.0.0.1:4801`
- Vault ID: any stable per-vault key, for example `default` or the vault folder name
- Semantic indexing: optional; requires a configured embedding-capable provider/model

The SQLite database is local to the machine running the companion. Back it up with the vault if you want the index cache to survive machine rebuilds, or delete it and run a search rebuild to regenerate it.

## Standalone Local Postgres

The bundled `scripts/search-companion.mjs` does not implement Postgres. For a standalone local Postgres companion, run a separate HTTP service that exposes the same API contract below and configure Crucible to point at that service.

Expected setup shape:

- Postgres database reachable from the companion process, for example `postgres://crucible:crucible@127.0.0.1:5432/crucible_search`
- A chunks table keyed by `vaultId + chunkId`, with metadata JSON and optional embedding storage
- Text ranking with Postgres full-text search, or hybrid ranking if the service also enables `pgvector`
- Plugin Search service URL set to the local companion HTTP URL, not the raw Postgres connection string
- Plugin Vault ID set to a stable vault key shared by all requests

Do not put database credentials in Obsidian settings. Keep them in the standalone companion service environment, for example `DATABASE_URL`, and expose only the local HTTP endpoint to the plugin.

## Supabase

The bundled companion script does not implement Supabase. For Supabase-backed search, run a companion service that talks to Supabase from a trusted server-side process and implements the API contract below.

Expected setup shape:

- Supabase project with Postgres tables equivalent to the chunk storage contract
- Optional `pgvector` extension if the companion ranks embeddings
- Companion service configured with Supabase URL plus a server-side key in its environment
- Plugin Search service URL set to the companion HTTP URL
- Plugin Vault ID set to a stable vault key; use row-level policy or service-side filtering so vaults do not bleed into each other

Do not store Supabase service-role keys in Obsidian settings. If a browser-accessible anon key is used, the companion still needs to enforce vault scoping and should avoid exposing write access directly from the plugin.

## Inference services (embeddings + reranking)

**For choosing and configuring a model server generally — including the cross-encoder trap, the
quantization hazard, and the provider-kind/base-URL rules — see [Local inference](local-inference.md).**
This section covers only what this fleet runs.

Semantic search and the opt-in reranker need a model server; the fleet declares one rather than
leaving it as a thing you have to remember to start. Four services sit beside `crucible-search`,
one model each, in two pairs:

| Service | Port | Model | Purpose | Profile |
|---|---|---|---|---|
| `crucible-embedder` | `127.0.0.1:4802` | `BAAI/bge-m3` (1024d, fp32 ONNX) | `POST /v1/embeddings` — OpenAI-compatible | `cpu-inference` |
| `crucible-reranker` | `127.0.0.1:4803` | `BAAI/bge-reranker-v2-m3` (torch) | `POST /rerank` | `cpu-inference` |
| `crucible-embed-gpu` | `127.0.0.1:4804` | `bge-m3` GGUF f16 | `POST /v1/embeddings` | `gpu-inference` |
| `crucible-rerank-gpu` | `127.0.0.1:4805` | `bge-reranker-v2-m3` GGUF Q8_0 | `POST /rerank` | `gpu-inference` |

The CPU pair runs the [Infinity](https://github.com/michaelfeil/infinity) inference server
(`michaelf34/infinity:0.0.77-cpu`); the GPU pair runs `llama-server` (llama.cpp) on Vulkan, built
and documented in [`docker/llamacpp-vulkan/`](../docker/llamacpp-vulkan/README.md). Like
`crucible-search`, all four publish to `127.0.0.1` only — an embedder port also carries an
unauthenticated, full-access inference API.

Both pairs sit behind compose profiles, so a bare `hc up` starts neither: the CPU pair is the
reference implementation and the no-GPU fallback, and the GPU pair is started on demand by systemd
socket activation rather than by compose. `4804`/`4805` are **socket** addresses that always
listen; the containers' own published ports (`14804`/`14805`) are an implementation detail and
nothing should be configured against them — a client pointed there bypasses the on-demand start
and hits a stopped container.

**The GPU pair above is mid-migration to a single router, `crucible-inference` on
`127.0.0.1:4806`** — one always-on `llama-swap` process that spawns/unloads the same
`bge-m3`/`bge-reranker-v2-m3` `llama-server` children on demand (`ttl`-based, not
socket-activated), replacing `crucible-embed-gpu`/`crucible-rerank-gpu` and the systemd socket
apparatus entirely. The container image and its router config already exist in this repo's
[`docker/llamacpp-vulkan/`](../docker/llamacpp-vulkan/README.md); wiring `crucible-inference` into
this fleet's compose file, running its smoke test live, and flipping this fleet's provider base
URLs from `4804`/`4805` to `4806` are separate, later steps not yet landed as of this writing — see
[Local inference](local-inference.md) §12a for the full setup and its "Migration status" note, and
§12a/Rule 2 for why the new router needs only one base URL for both jobs instead of the asymmetric
pair described below. Until that cutover lands, the table above is what this fleet actually runs.

**The two engine flags differ on purpose.** The embedder runs `--engine optimum` (ONNX); the
reranker runs `--engine torch`. `optimum` resolves ONNX weights from the HF repo, and
`BAAI/bge-reranker-v2-m3` publishes PyTorch weights only — under `optimum` it dies during engine
selection with `No onnx files found`, before downloading a byte, at any memory limit. `bge-m3`
does ship `onnx/model.onnx`, so the embedder keeps the faster ONNX path. Check which weights a
repo actually publishes before aligning these.

**Why the CPU pair is Infinity and the GPU pair is not.** ROCm is blocked on this box and the
host is not the reason: host ROCm 7.2.2 supports gfx1201 (RX 9070 / RDNA4) fine, but the newest
published AMD Infinity image ships torch `2.5.1+rocm6.2`, whose compiled arch list stops at
`gfx1100`/`gfx942` (and `latest-amd` is five months *older* still); gfx1201 needs ROCm 6.4+.
Worse, `torch.cuda.is_available()` returns `True` on that image and only fails at the first real
kernel — so a naive GPU switch passes the healthcheck and then dies on the first embedding
request. Do not attempt to force it with `HSA_OVERRIDE_GFX_VERSION`: that wedges the GPU hard
enough to cost a desktop session. Full findings, the hang signature and recovery paths are in
`context-control/references/rdna4-gpu-hang.md`.

**Vulkan is not blocked**, which is why the GPU pair exists at all: RADV drives gfx1201 today, and
llama.cpp's Vulkan backend runs both workloads on it. That path has its own silent-failure mode —
a Vulkan loader with no usable hardware driver still enumerates the `llvmpipe` software
rasteriser as a valid device, so a too-old Mesa yields a server that answers every request
correctly and runs slower than the CPU containers it replaced. See
[`docker/llamacpp-vulkan/`](../docker/llamacpp-vulkan/README.md) for the base-image constraint and
the startup assertion that catches it, and [Local inference](local-inference.md) for the general
form of both traps.

**Switching the embedder between these pairs triggers a re-embed, and that is conservatism rather
than a correctness requirement.** Schema 4's `embedding_space` treats Infinity's fp32 ONNX vectors
and llama.cpp's f16 GGUF vectors as different spaces, so the coverage check notices and the vault
re-embeds rather than silently mixing. Re-measured in July 2026 with adequate statistical power,
the two are **retrievally identical**: over 61 parallel Wikipedia articles both score en→fr P@1
100% and en→ja 98.4% with discrimination spread 0.3513 vs 0.3515, and the small rank churn between
them (mean top-10 Jaccard 0.9939) is matched exactly by two *builds of the same engine loading a
byte-identical file*. See the eval-harness repo's local-inference-bench archive
(`/home/_shared_code/eval-harness`) for the full result and [Local inference](local-inference.md)
§6 for what it means in practice. The guard stays because it is cheap and fails closed — do not
read it as evidence that the two pairs disagree.

**Why `bge-m3` is the recommended default.** `searchEmbeddingModel` is a plain user setting — the
companion is dimension-agnostic and stores whatever width arrives, so nothing forces `bge-m3`
specifically. It's recommended because Crucible ships publicly and no English-only assumption may
be baked into the defaults, even though *this* vault measures 100.0% ASCII (13 of 52,257 chunks
carry any non-Latin script, all incidental — a GitHub issue thread and two YouTube "about" pages).
`bge-m3` is 1024d, multilingual, and has an 8,192-token context window that this vault's chunks
never come close to truncating against. Measured over all 52,453 chunks: **mean 1,117 characters,
median 1,320, max 1,999**. Note that 1,800 (`searchChunkMaxChars`) is a *target*, not a hard
ceiling — `chunkText` prepends up to `searchChunkOverlapChars` (default 200) of overlap to a
paragraph that already fits, so a chunk can reach `maxChars + overlapChars`; 143 chunks do exceed
1,800. The mean sits well below the median because a long tail of very short chunks pulls it down
(p5 is 43 characters). Cheaper monolingual alternatives,
if multilingual recall isn't a requirement for a given vault: `nomic-embed-text` (768d) or
`bge-small-en-v1.5` (384d) — both cut matrix size and per-query scan time roughly in proportion to
dimension (see the scan-time table above). **That caveat is measured, and it is understated:**
`nomic-embed-text` (Q4_K_M) scores en→fr 95.1% and en→ja **85.2%** against `bge-m3`'s 100% / 98.4%,
with a discrimination spread of 0.1064 against 0.3513 — a **3.3× narrower** band between a real
match and an unrelated document on the same corpus. The cost is not only non-English recall; it is
less room between right and wrong answers everywhere. Quantization, by contrast, is nearly free
down to Q8_0 — see [Local inference](local-inference.md) §6.

**Pointing Crucible at the embedder:** in the plugin's provider settings, add a provider of kind
`openai-compatible` with base URL `http://127.0.0.1:4802/v1` (no API key required) and set
`searchEmbeddingModel` to `BAAI/bge-m3` on that provider. The `openai-compatible` client appends
`/embeddings` to the configured base URL itself, so the base URL must include the `/v1` segment
— the embedder is started with `--url-prefix /v1` specifically so this matches.

**Reranker endpoint:** `POST http://127.0.0.1:4803/rerank` — no `/v1` prefix; Infinity's default
route is unprefixed and the reranker container is not started with `--url-prefix`. The GPU
reranker on `4805` serves `/rerank` and `/v1/rerank` both, so either configured base URL works
there. Verified request/response shape:

```
POST /rerank
{ "model": "BAAI/bge-reranker-v2-m3", "query": "...", "documents": ["...", "..."] }

200 OK
{ "results": [ { "index": 0, "relevance_score": 0.93 }, ... ], "model": "...", "usage": {...} }
```

**The two rerankers do not return the same scale.** Infinity returns sigmoid-normalised 0–1
(`0.6047`); llama.cpp returns raw logits — negative and unbounded (`+1.66` relevant, `−11.03`
irrelevant). Higher is better in both, so ordering and the strict parser are unaffected, but any
threshold or test asserting a 0–1 range is wrong against the GPU pair.

**When they're down:** the CPU pair carries `restart: unless-stopped` and a `/health` healthcheck,
same as `crucible-search`; the GPU pair is instead started on demand by its socket and stopped
again after 30 minutes idle, so "not running" is its normal resting state rather than a fault.
If the embedder is unreachable, `attachEmbeddings` catches the failure,
logs a debug-gated warning, and the index falls back to FTS-only for that flush — search stays
functional, just without the vector rank, until the container comes back. If the reranker is
unreachable, the explicit rerank action in the search modal fails with an error; it never blocks
type-ahead search, which does not call it.

## API Contract

- `GET /health`
- `POST /v1/index/reset`
- `POST /v1/chunks/upsert`
- `POST /v1/chunks/delete`
- `POST /v1/files/state`
- `POST /v1/search`

All mutation/search requests include `vaultId` so multiple vaults can share one companion database. That sharing is only actually safe from **schema 5** onwards — see the `4→5` migration above. An implementation of this contract must key chunk storage on `vaultId + chunkId`, never on `chunkId` alone.
