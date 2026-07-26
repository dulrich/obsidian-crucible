# crucible-inference — llama.cpp on Vulkan + llama-swap

One always-on GPU inference router serving Crucible's embedding and reranking backends (and,
eventually, chat models) from a single container on **127.0.0.1:4806**.

This replaces the old shape — two separate `llama-server` containers, each behind its own
systemd socket that started/stopped the container on demand — with **one router process**
(`llama-swap`) that itself spawns/swaps/unloads the actual `llama-server` children per-model,
in-container, per its `config.yaml`. The socket-activation apparatus (`systemd/*.socket`,
`*.service`, `crucible-inference-ctl`) still lives in this directory and still works against the
image's old dual-single-model shape, but it is retired once the router cutover lands — see
"Migration status" below.

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
systemd/            retired at cutover: socket units, service units, installer, lifecycle helper
```

Tag: **`crucible-llamacpp-vulkan:b10121-swap243`** — llama.cpp tag + llama-swap tag, both baked
into the name so it's visible without opening the Dockerfile.

The compose service itself (`crucible-inference`, port mapping, `/models` and `config.yaml`
mounts, `/dev/dri` passthrough, `mem_limit`) lives in the fleet repo,
`context-control/compose.home.yml` — that wiring, plus the live cutover, is a separate,
cross-repo work package from this directory's contents. See the governing plan
(`plans/model-catalog-ux-local-inference-and-remediations.md`, WP-4/WP-5/WP-6) for the full
sequencing.

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

- **Aliases are the API surface, append-only.** `bge-m3` and `bge-reranker-v2` are the exact
  `modelId` values Crucible's live plugin settings (`data.json`) already store for the embed and
  rerank provider entries — that's what makes pointing a vault at this service a base-URL-only
  change instead of a model-id rewrite. Never rename or delete an alias once a vault may be
  using it; only add new ones.
- **`retrieval` group** (`swap: false, exclusive: false, persistent: false`) holds both models —
  small enough, and used closely enough together by one search/rerank flow, that neither should
  evict the other. `ttl: 1800` (30 min) unloads an idle model and returns its VRAM; `persistent`
  staying `false` is what lets that `ttl` actually apply.
- **A commented-out `chat` group stub** (`swap: true, exclusive: true`) is there for whenever a
  chat model joins this router — see the comment in `config.yaml` for why chat needs the
  opposite settings from retrieval, and the untested VRAM-eviction risk that implies.
- `-b/-ub 8192`, `-ngl 99`, and the **absence** of `--pooling` are carried over verbatim from the
  compose invocations this service replaces — don't add `--pooling` back; the GGUF metadata and
  `--embeddings`/`--reranking` already select the right pooling.

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
broken" lesson. The `ttl`-unload check is opt-in and slow (`--wait-ttl`) because the retrieval
group's `ttl` is 1800s; without the flag it's reported as skipped, not silently omitted.

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

This directory is mid-migration from the old per-model socket-activated shape to the always-on
llama-swap router. As of this file:

- The Dockerfile, `entrypoint.sh`, `config.yaml`, and `smoke-inference.sh` in this directory
  build and describe the **new** router shape (`crucible-inference` on port 4806).
- The `systemd/` unit files, `crucible-inference-ctl`, and the compose services
  `crucible-embed-gpu`/`crucible-rerank-gpu` (context-control) are still the **live** path —
  they are not touched by this change and continue to work exactly as documented in git history.
- Bringing up `crucible-inference` in compose, running the smoke test against the real service,
  testing the chat-evicts-retrieval interleave, flipping Crucible's provider base URLs from
  4804/4805 to 4806, and retiring the systemd sockets are separate, later steps (cutover) — not
  part of authoring this container image and its config.

## The CPU services are still there

`crucible-embedder` and `crucible-reranker` (Infinity) remain on the `cpu-inference` profile
throughout this migration and stay as the fallback for a host with no usable GPU.

```bash
hc up crucible-embedder      # naming a profiled service enables its profile
docker stop crucible-embedder
```

A bare `hc down` will not stop them, because `down` only considers active profiles.
