# GPU embedding and reranking for Crucible — llama.cpp on Vulkan

On-demand, socket-activated `llama-server` containers that serve Crucible's embedding and
reranking backends from the GPU instead of the CPU.

| | Infinity (CPU) | this (Vulkan GPU) | |
|---|---|---|---|
| Embedding `bge-m3`, batch 96 | 8.5 chunks/s | **90.0 chunks/s** | 10.6× |
| Reranking `bge-reranker-v2-m3`, 30 docs | 7.3 s | **0.147 s** | 50× |
| Cold start after idle | n/a (always resident) | **1.3 s** | |
| Warm request | | 67 ms | |

Measured 2026-07-25 on an RX 9070 (gfx1201, RDNA4) via RADV. The reranking figure is the one
that matters in use: at Crucible's `searchRerankTopN` of 30 it is the difference between a
button people avoid and one they press without thinking.

## What is here

```
Dockerfile          multi-stage llama.cpp b10121 build, Vulkan backend, debian:sid-slim
entrypoint.sh       refuses to start on a software rasteriser (see "The llvmpipe trap")
systemd/            socket units, service units, installer, lifecycle helper
```

The compose services themselves live in the fleet repo, in
`context-control/compose.home.yml` — `crucible-embed-gpu` and `crucible-rerank-gpu`, both under
the `gpu-inference` profile.

## Install

```bash
cd /home/_shared_code/context-control
hc up crucible-embed-gpu          # builds the image the first time (~3 min)
docker compose -f compose.home.yml stop crucible-embed-gpu

/home/_shared_code/obsidian-crucible/docker/llamacpp-vulkan/systemd/install.sh
```

Then point Crucible at the **socket** ports, not the container ports:

| Setting | Value |
|---|---|
| Embedding provider kind | `openai-compatible` |
| Embedding base URL | `http://127.0.0.1:4812/v1` — the `/v1` is required; the client appends `/embeddings` |
| Rerank base URL | `http://127.0.0.1:4813` — **no** `/v1`; the client appends `/rerank` |
| Rerank model capability | **Rerank**, never Embedding — see below |

## How the on-demand lifecycle works

```
Crucible ──► 127.0.0.1:4812  (systemd socket, always listening, costs nothing)
                  │  first connection
                  ▼
             crucible-embed.service
                  ├─ ExecStartPre  crucible-inference-ctl up …   docker compose up + wait /health
                  ├─ ExecStart     systemd-socket-proxyd --exit-idle-time=30min ──► 127.0.0.1:14812
                  └─ ExecStopPost  crucible-inference-ctl down … docker compose stop
```

The socket is the address of record; the container's published port (`14812`/`14813`) is an
implementation detail and nothing should be configured against it — pointing a client there
bypasses the on-demand start and hits a stopped container.

Idle timeout is **30 minutes**, chosen so a working session pays the 1.3 s cold start at most
once while an idle desktop still gets its VRAM back (~1.2 GB embedder, ~0.7 GB reranker) long
before anyone sits down to a game.

Useful commands:

```bash
systemctl --user status crucible-embed.socket crucible-embed.service
systemctl --user stop crucible-embed.service     # force the container down now
journalctl --user -u crucible-embed.service -f
docker logs crucible-embed-gpu                   # the entrypoint's GPU assertion lives here
```

## The llvmpipe trap

This is the failure mode the whole `entrypoint.sh` exists for, and it is worth understanding
before changing the base image.

A Vulkan loader with no usable hardware driver still enumerates **`llvmpipe`**, a software
rasteriser, as a completely valid Vulkan device — it is present even on this working host,
alongside the real GPU. So an image whose Mesa is too old to claim this GPU does not fail
loudly. `llama-server` starts, answers every request correctly, passes any healthcheck that
only asks "is the port open", and runs **several times slower than the CPU containers it
replaced**. A silent CPU fallback is not a degraded service; it is a regression wearing the
costume of a working one.

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
`nomic-embed-text`). Measured discrimination margin on one query against two relevant and two
irrelevant documents: **0.0080 for the misused reranker versus 0.3994 for a real bi-encoder**,
with the genuinely on-topic document ranking *below* arctic tern migration.

The same weights score correctly through a real rerank endpoint — this container's `/v1/rerank`
puts the on-topic document at +1.66 and the irrelevant ones at −11.03. It is the endpoint, not
the model. Mark rerankers **Rerank** in Crucible's model capabilities so they stay out of the
embedding picker.

## Wire contract note

llama.cpp's `/v1/rerank` returns **raw logits** — negative, unbounded (`+1.66`, `−11.03`).
Infinity returns **sigmoid-normalised 0–1** (`0.6047`). Higher is better in both, so ordering
logic and Crucible's strict parser are unaffected, but anything asserting a 0–1 range will be
wrong against llama.cpp.

## Vector-space warning

The f16 GGUF served here is **not the same vector space** as the fp32 ONNX weights Infinity
serves, even though both are "bge-m3" at 1024d. Measured: mean cosine 1.0000 and minimum 0.9991
— which looks negligible — while top-10 rank overlap falls to **0.8182**, i.e. one result in ten
changes place. Cosine badly understates this.

Crucible models that explicitly: `chunks.embedding_space` (schema 4) keys on model id *plus*
normalised precision, the vector scan filters by it, and mixing two spaces in one vault is
refused at upsert. So switching the embedding provider to this service is a deliberate act that
re-embeds the vault — which now costs ~14 minutes rather than ~2.3 hours.

Verify agreement rather than assuming it, with `scripts/embedding-agreement.mjs`. This image's
output was checked against the LM Studio llama.cpp build at the same precision: **MIN cosine
0.999983** across ten texts with a 0.309 control, i.e. the same space, so measurements taken
through LM Studio transfer to this container.

## Rebuilding / upgrading llama.cpp

```bash
docker compose -f /home/_shared_code/context-control/compose.home.yml build \
  --build-arg LLAMA_CPP_TAG=bXXXXX crucible-embed-gpu
```

Bump deliberately and re-run the agreement harness afterwards. A llama.cpp change to pooling or
normalisation would move every vector this serves, and the symptom would be gradually worse
search rather than an error.

## The CPU services are still there

`crucible-embedder` and `crucible-reranker` (Infinity) moved to the `cpu-inference` profile.
They no longer start with a bare `hc up`, but they are not gone — they are the reference CPU
implementation, the fallback for a host with no usable GPU, and the runtime that produced the
fp32 vectors currently in the index.

```bash
hc up crucible-embedder      # naming a profiled service enables its profile
docker stop crucible-embedder
```

A bare `hc down` will not stop them, because `down` only considers active profiles.
