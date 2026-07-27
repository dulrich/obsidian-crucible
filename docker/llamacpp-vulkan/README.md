# crucible-inference — llama.cpp on Vulkan + llama-swap

One always-on GPU inference router serving Crucible's embedding and reranking backends (and,
eventually, chat models) from a single container on **127.0.0.1:4806**.

This replaces the old shape — two separate `llama-server` containers, each behind its own
systemd socket that started/stopped the container on demand — with **one router process**
(`llama-swap`) that itself spawns/swaps/unloads the actual `llama-server` children per-model,
in-container, per its `config.yaml`. The socket-activation apparatus (`systemd/*.socket`,
`*.service`, `crucible-inference-ctl`, `install.sh`) was deleted at the 2026-07-26 cutover —
it lives on in git history if a per-model socket-activated deployment is ever wanted again.

| | Infinity (CPU) | this (Vulkan GPU) | |
|---|---|---|---|
| Embedding `bge-m3`, batch 96 | 3.7 chunks/s | **95.0 chunks/s** | 25.7× |
| Reranking `bge-reranker-v2-m3`, 30 docs | 9.48 s | **0.280 s** | 34× |
| Cold start after idle | n/a (always resident) | **1.3 s** | |
| Warm request | | 67 ms | |

Measured 2026-07-25 on an RX 9070 (gfx1201, RDNA4) via RADV, against the single-model shape.
The reranking figure is the one that matters in use: at Crucible's `searchRerankTopN` of 30 it
is the difference between a button people avoid and one they press without thinking.

## What is here

```
Dockerfile          multi-stage build: llama.cpp b10121 (Vulkan) + llama-swap v243, debian:sid-slim
entrypoint.sh       refuses to start on a software rasteriser (see "The llvmpipe trap"); dual-use
                    exec tail — runs whatever command it's given (llama-swap or a bare llama-server)
config.yaml         llama-swap router config: models, aliases, ttl, groups — bind-mounted, not baked in
smoke-inference.sh  host-run smoke test against a running router (see "Smoke testing" below)
```

Tag: **`crucible-llamacpp-vulkan:b10121-swap243`** — llama.cpp tag + llama-swap tag, both baked
into the name so it's visible without opening the Dockerfile.

The compose service itself (`crucible-inference`, port mapping, `/models` and `config.yaml`
mounts, `/dev/dri` passthrough, `mem_limit`) lives in the fleet repo,
`context-control/compose.home.yml`.

## Dual-use image, on purpose

`entrypoint.sh` only proves the GPU is real (the assertion below); everything after that is
`exec "$@"` — whatever command the container is given, unchanged. Two supported shapes:

```bash
# The new default (this image's CMD): llama-swap owns the router, spawns llama-server children
# per config.yaml.
docker run ... crucible-llamacpp-vulkan:b10121-swap243
# equivalent to:
docker run ... crucible-llamacpp-vulkan:b10121-swap243 \
  llama-swap -config /app/config.yaml -listen :4806

# The old single-model shape still works unchanged, for anything not yet migrated:
docker run ... crucible-llamacpp-vulkan:b10121-swap243 \
  llama-server -m /models/CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf --embeddings -ngl 99 ...
```

Both paths pass through the same GPU assertion; there is no separate "router mode" build.

## `config.yaml` — the router's model list

Bind-mounted **read-only** at `/app/config.yaml`; the Dockerfile does not `COPY` it, so editing
it (adding a model, changing a `ttl`) needs no image rebuild — only a container restart. See the
file itself for the full annotated shape; the essentials:

| Alias | Group | Role | ttl | Notes |
|---|---|---|---|---|
| `bge-m3` | `retrieval` | embedding | 1800s | f16, 1024d |
| `bge-reranker-v2` | `retrieval` | rerank | 1800s | Q8_0, `/rerank` only |
| `gemma-4-12b` | `chat` | chat | 1800s | Q4_K_M, `-c 32768`, `--jinja`; cutover-tested |
| `nemotron-4b` | `chat` | chat | 1800s | Q4_K_M, `-c 32768`, `--jinja`; small/fast option |

- **Aliases are the API surface, append-only.** `bge-m3` and `bge-reranker-v2` are the exact
  `modelId` values Crucible's live plugin settings (`data.json`) already store for the embed and
  rerank provider entries — that's what makes pointing a vault at this service a base-URL-only
  change instead of a model-id rewrite. Never rename or delete an alias once a vault may be
  using it; only add new ones. `gemma-4-12b` and `nemotron-4b` are the first two additions.
- **`retrieval` group** (`swap: false, exclusive: false, persistent: false`) holds both retrieval
  models — small enough, and used closely enough together by one search/rerank flow, that
  neither should evict the other. `ttl: 1800` (30 min) unloads an idle model and returns its
  VRAM; `persistent` staying `false` is what lets that `ttl` actually apply.
- **`chat` group** (`swap: true, exclusive: true, persistent: false`) holds `gemma-4-12b` and
  `nemotron-4b` — the opposite policy from `retrieval`, because a chat model is large enough
  that it cannot safely coexist with another chat model or the retrieval pair under this GPU's
  VRAM. `exclusive: true` means a chat request evicts `bge-m3`/`bge-reranker-v2` first; a
  retrieval request afterward reloads without evicting the chat model. The eviction mechanics
  were verified at cutover (two full evict→reload cycles, byte-identical embeddings, no amdgpu
  errors); the specific model list above is new and gets the live smoke test (including the
  chat-completion checks below) before being treated as validated in production. See
  `config.yaml`'s `chat` group comment for the full VRAM fit math — measured host GPU VRAM,
  per-model weight sizes, and why `gemma-4-26B-A4B`/27B/31B/35B-A3B are excluded.
- `-b/-ub 8192`, `-ngl 99`, and the **absence** of `--pooling` on the retrieval macro are carried
  over verbatim from the compose invocations this service replaces — don't add `--pooling` back;
  the GGUF metadata and `--embeddings`/`--reranking` already select the right pooling. The chat
  macro (`llama_server_chat_common`) deliberately uses smaller `-b 2048 -ub 512` (llama.cpp's own
  defaults) instead — a large ubatch helps batch-embedding throughput but only costs VRAM for a
  single-conversation chat decode, and that VRAM matters more here given the fit math above.
  `--jinja` renders each chat model's own embedded GGUF chat template instead of a hardcoded
  built-in one — required for gemma4's reasoning-style template.

## Smoke testing

```bash
docker/llamacpp-vulkan/smoke-inference.sh                       # default target :4806
docker/llamacpp-vulkan/smoke-inference.sh --url http://127.0.0.1:4806
docker/llamacpp-vulkan/smoke-inference.sh --wait-ttl            # also proves ttl-unload (~30 min sleep)
```

Requires `curl` and `jq` on the host running it; runs entirely against the already-running
router over HTTP — it never touches Docker/systemd itself. Checks, in order: `/health` is 200;
`/v1/models` lists both `bge-m3` and `bge-reranker-v2`; `/v1/embeddings` for `bge-m3` returns a
well-formed numeric vector (its length is reported, not asserted — dimension is a model fact,
not a script fact); `/rerank` for `bge-reranker-v2` against 3 documents returns exactly 3 results
with a unique index in `[0,2]` and a numeric `relevance_score` each; `/api/v0/models` (an LM
Studio-only endpoint llama-swap doesn't implement) fails fast — any 4xx/5xx within ~5s, not a
hang — per the fleet's standing "an endpoint that never fails loudly can still be silently
broken" lesson; `/v1/chat/completions` for each configured chat alias (`gemma-4-12b`,
`nemotron-4b`) with `max_tokens: 256` returns a non-empty `content` (the first request evicts
the retrieval group, per the `chat` group's `exclusive: true`, so this check budgets a longer
timeout for the cold spawn). The `ttl`-unload check is opt-in and slow (`--wait-ttl`) because the
retrieval group's `ttl` is 1800s; without the flag it's reported as skipped, not silently
omitted.

Exits non-zero on any failed check.

## The llvmpipe trap

This is the failure mode `entrypoint.sh`'s GPU assertion exists for, and it is worth
understanding before changing the base image — the assertion is unchanged by the llama-swap
addition; it fires the same way whether the container ultimately runs `llama-swap` or a bare
`llama-server`.

A Vulkan loader with no usable hardware driver still enumerates **`llvmpipe`**, a software
rasteriser, as a completely valid Vulkan device — it is present even on this working host,
alongside the real GPU. So an image whose Mesa is too old to claim this GPU does not fail
loudly. `llama-server` (whether run directly or spawned as a llama-swap child) starts, answers
every request correctly, passes any healthcheck that only asks "is the port open", and runs
**several times slower than the CPU containers it replaced**. A silent CPU fallback is not a
degraded service; it is a regression wearing the costume of a working one.

The base image is therefore load-bearing. `debian:sid-slim` ships Mesa 26.1.5, which is what
gfx1201 (RDNA4) needs — the host runs the same version from the kisak PPA, and that is why the
GPU works here at all. Debian trixie and Ubuntu 24.04 ship Mesa 24.x/25.0.x. **Do not move the
base image to a stable release**, and if you do, expect the entrypoint to refuse to start rather
than let it degrade quietly.

`entrypoint.sh` asserts `PHYSICAL_DEVICE_TYPE_DISCRETE_GPU` or `INTEGRATED_GPU` before exec'ing,
and logs what `llama-server --list-devices` resolves so `docker logs` answers "did it use the
GPU?" without anyone reproducing a benchmark. `CRUCIBLE_ALLOW_CPU_VULKAN=1` bypasses the check
and should never be set in the fleet.

(As it happens ggml filters llvmpipe out on its own — it resolves only `Vulkan0: AMD Radeon
RX 9070 (RADV GFX1201)`. The assertion does not depend on that continuing to be true.)

## A reranker is not an embedding model

The most expensive mistake available here, because every structural guard passes it.

LM Studio serves cross-encoder rerankers through `/v1/embeddings` as `type: embeddings`, and
they return properly normalised vectors at exactly the widths real embedders use — 1024d for
`bge-reranker-v2-m3` (colliding with `bge-m3`) and 768d for `bge-reranker-base` (colliding with
`nomic-embed-text`). Measured (61 parallel Wikipedia articles, en/fr/ja): cross-lingual P@1
collapses to 19.7%/13.1% against 100%/98.4% for the same model family used correctly, and
ordering is inverted — see `docs/local-inference.md` for the full numbers.

The same weights score correctly through a real rerank endpoint — this container's `/v1/rerank`
puts an on-topic document at a strongly positive logit and irrelevant ones strongly negative. It
is the endpoint, not the model. Mark rerankers **Rerank** in Crucible's model capabilities so
they stay out of the embedding picker — `config.yaml`'s `bge-reranker-v2-m3-Q8_0` model is
reachable only via `--reranking` + `/rerank`, never through `/v1/embeddings`.

## Wire contract note

llama.cpp's `/v1/rerank` returns **raw logits** — negative, unbounded (e.g. `+1.66`, `−11.03`).
Infinity (the CPU reranker) returns **sigmoid-normalised 0–1** (e.g. `0.6047`). Higher is better
in both, so ordering logic and Crucible's strict parser are unaffected, but anything asserting a
0–1 range will be wrong against llama.cpp, and scores are not comparable across servers.

## Vector-space warning

The f16 GGUF served here is **not the same vector space** as the fp32 ONNX weights Infinity
serves, even though both are "bge-m3" at 1024d. Measured: mean cosine 1.0000 and minimum 0.9991
— which looks negligible — while top-10 rank overlap falls to **0.8182**, i.e. one result in ten
changes place. Cosine badly understates this.

Crucible models that explicitly: `chunks.embedding_space` keys on model id *plus* normalised
precision, the vector scan filters by it, and mixing two spaces in one vault is refused at
upsert. So switching the embedding provider to this service is a deliberate act that re-embeds
the vault.

Verify agreement rather than assuming it, with `scripts/embedding-agreement.mjs`. This image's
output was checked against the LM Studio llama.cpp build at the same precision: **MIN cosine
0.999983** across ten texts with a 0.309 control, i.e. the same space, so measurements taken
through LM Studio transfer to this container. This did not change with the llama-swap addition —
the inference binary and its flags are byte-identical to the single-model shape; only the
process that launches it is new.

## Rebuilding / upgrading llama.cpp

```bash
docker build --build-arg LLAMA_CPP_TAG=bXXXXX -t crucible-llamacpp-vulkan:bXXXXX-swap243 \
  docker/llamacpp-vulkan
```

Bump `LLAMA_CPP_TAG` deliberately and re-run the agreement harness afterwards. A llama.cpp
change to pooling or normalisation would move every vector this serves, and the symptom would be
gradually worse search rather than an error. llama.cpp stays pinned at `b10121` as of this
writing — the llama-swap addition is not a reason to bump it.

## Upgrading llama-swap

```bash
docker build --build-arg LLAMA_SWAP_TAG=vNNN --build-arg LLAMA_SWAP_SHA256=<sha256> \
  -t crucible-llamacpp-vulkan:b10121-swapNNN docker/llamacpp-vulkan
```

Pinned to ≥v242 (the release that fixed a TTL-unload deadlock) by tag *and* checksum. Get the
checksum from the new release's own `llama-swap_<ver>_checksums.txt` asset (pick the
`linux_amd64.tar.gz` line) — don't hand-type it, and don't trust a value that isn't sourced from
that file. `docker build` fails closed on a mismatch (`sha256sum -c -`).

## Migration status

**Cutover complete (2026-07-26).** `crucible-inference` is the live and only inference path:
the compose service runs always-on in `context-control/compose.home.yml`, Crucible's two
retrieval provider entries point at `127.0.0.1:4806`, and the smoke test plus the
chat-evicts-retrieval interleave (two evict→reload cycles, byte-identical embeddings after each
reload, no amdgpu errors) passed against the real service before anything was retired. That
interleave test used gemma-4-12B as a throwaway chat member to prove the eviction mechanics —
`config.yaml` did not yet carry a real `chat` group.

**Chat models added, not yet part of "cutover complete" above.** `config.yaml` now configures
`gemma-4-12b` and `nemotron-4b` in a real `chat` group (see the model table and VRAM fit math
earlier in this file); this authoring pass did not start the container, load either model, or
touch the live service — the orchestrator reloads `crucible-inference` and runs
`smoke-inference.sh`'s new chat-completion checks against it separately. Once that passes,
adding a plugin-side chat provider entry (`openai-compatible`, base URL
`http://127.0.0.1:4806/v1`, model id `gemma-4-12b` or `nemotron-4b`) is a Crucible settings
change, not a code change.

Retired in the same cutover, all recoverable from git history if ever needed:

- The `systemd/` socket-activation apparatus in this directory (unit files,
  `crucible-inference-ctl`, `install.sh`).
- The per-model compose services `crucible-embed-gpu`/`crucible-rerank-gpu` (4804/4805).
- The Infinity CPU pair `crucible-embedder`/`crucible-reranker` (4802/4803) and their HF cache
  volumes. For a host with no usable GPU, the recipe survives as route (d) in
  [`docs/local-inference.md`](../../docs/local-inference.md).
