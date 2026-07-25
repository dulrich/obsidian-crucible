# Local Inference — embeddings and reranking

Crucible's semantic search leg needs an **embedding** model, and the opt-in Rerank action needs a
**reranker**. Both can run locally. This guide covers which server to run, how to point Crucible
at it, and — mostly — the ways this goes wrong *without producing an error*.

That last part is the point of the guide. Local inference rarely fails loudly. It fails by
answering every request correctly-shaped and quietly wrong, passing every guard on the way.

> **About the numbers in this guide.** Figures marked **(provisional)** were measured on one
> machine across several sessions with differing batch sizes and sample sets. They are the right
> order of magnitude and the wrong thing to quote precisely. A single-protocol re-measurement is
> planned (`runs/dispatch/esi-field-report-protocol.md`); this guide will be updated with the
> results. Everything not marked provisional is a **structural fact** — a property of the
> software, not a measurement — and does not depend on that re-run.

---

## 1. A reranker is not an embedding model

**Read this before configuring anything.** It is the most expensive mistake available here,
because every structural guard passes it.

LM Studio serves cross-encoder rerankers through `/v1/embeddings` and lists them as
`type: embeddings`. They return properly normalised vectors at exactly the widths real embedders
use:

| Model, as LM Studio names it | Reported type | Returns | Collides with |
|---|---|---|---|
| `text-embedding-bge-reranker-v2-m3` | `embeddings` | 1024-d, L2-norm 1.000000 | `bge-m3` (1024d) |
| `text-embedding-bge-reranker-base` | `embeddings` | 768-d, L2-norm 1.000000 | `nomic-embed-text` (768d) |

Every check a careful person would write passes: the width matches, the vector is already
normalised, the id begins `text-embedding-`, and the server itself says it is an embedding model.
No field in any local runtime's API distinguishes a cross-encoder from a bi-encoder.

What actually happens, measured over 61 Wikipedia articles in three languages — where the right
answer is known, because an article's own translation is the one document that must rank first:

| | `bge-m3` (real bi-encoder) | `bge-reranker-v2-m3` used as an embedder |
|---|---|---|
| finds the right document first, en→fr | **100.0%** | **19.7%** |
| finds the right document first, en→ja | **98.4%** | **13.1%** |
| worst true-match rank (of 61) | 2nd | **61st — dead last** |
| gap between a real match and a stranger | **0.3513** | **0.0087** |
| ranks a true match above an unrelated one? | yes | **no — inverted** |

Every similarity it returns lands between 0.92 and 0.94, whatever you feed it. The gap it leaves
between a document's own translation and an unrelated article is **40× narrower** than the real
embedder's, and the ordering is not merely weak — unrelated documents on a similar topic score
*higher* than a document's own translation.

A user who picks this model indexes their entire vault with vectors that cannot rank, and sees no
error anywhere. The symptom is "search feels vague", attributed to anything but the embedder.

**The same weights rank correctly through a real rerank endpoint.** It is the endpoint, not the
model: a cross-encoder scores a *(query, document)* pair jointly and has no meaningful standalone
vector to hand out. Pooling its internals into something 1024 floats wide does not make it an
embedding.

**What to do:**

1. In Crucible's provider settings, mark reranker models **Rerank**, never Embedding. The Rerank
   capability flag keeps them out of the embedding picker — that flag is the structural mitigation
   for exactly this.
2. Treat `text-embedding-` in a model id as naming convention, not evidence. LM Studio's prefix
   actively encourages the wrong flag.
3. Use a reranker only through a server that exposes a real `/rerank` endpoint (§4).
4. If a model's name contains `rerank` or `cross-enc`, Crucible logs a warning when it is used as
   an embedder. That warning is debug-gated (`window.__CRUCIBLE_DEBUG__ = true`) and is a
   heuristic on naming, so it warns rather than blocks — do not rely on it to catch a
   differently-named reranker.

---

## 2. The two jobs

| Job | Setting | What it does | Cost profile |
|---|---|---|---|
| **Embedding** | `searchEmbeddingModel` (+ Semantic indexing on) | one vector per chunk, once per edit; one per query at search time | large one-time backfill, then trivial |
| **Reranking** | `searchRerankModel`, `searchRerankTopN` (default 30) | rescores the top N results when the user presses Rerank | zero until pressed, then a burst |

They have opposite requirements, which is why splitting them across two servers is normal rather
than untidy:

- The embedder is a **throughput** problem. It processes tens of thousands of chunks once, then
  goes nearly idle. Being 10× faster turns a coffee break into a pause.
- The reranker is a **latency** problem. It runs 30 documents while a person watches. At 7 seconds
  the button gets avoided; at 0.15 seconds it gets pressed without thinking. Same work, completely
  different acceptability threshold.

You do not need both. Semantic search works with an embedder alone; reranking is opt-in.

---

## 3. Choosing a route

| Route | Provider kind | Embed | Rerank | GPU | Lifecycle |
|---|---|---|---|---|---|
| **Infinity** in Docker | `openai-compatible` | yes | **yes** — native `/rerank` | CPU in practice; ROCm/CUDA images exist and are arch-fussy | compose service, `restart: unless-stopped`, always resident |
| **`llama-server`** (llama.cpp) | `openai-compatible` | yes | **yes** — `--reranking --pooling rank` | Vulkan / ROCm / CUDA / Metal | your own unit or compose entry; can be socket-activated on demand |
| **LM Studio** | `openai-compatible` | yes | **no** — rejects `/v1/rerank` | Vulkan / ROCm / Metal | GUI app; you start it |
| **ollama** | `ollama` | yes | **no** — no rerank endpoint | Vulkan needs `OLLAMA_VULKAN=1` on the unit | systemd, always-on, model swap on demand |
| **Hosted API** | `openai` / `openai-compatible` | yes | provider-dependent | n/a | nothing to run |

**The honest trade-off, stated once.** The fast local route (llama.cpp on a GPU) and the
convenient one (a compose service that is simply always up) are not the same route, and neither is
universally right:

- **Always-on service management** — an Infinity container with `restart: unless-stopped` and a
  healthcheck is up after a reboot, up after a crash, and visible to whatever manages the rest of
  your fleet. It costs resident RAM continuously and, on CPU, is several times slower.
- **Speed and less resident memory** — `llama-server` on a GPU is dramatically faster
  **(provisional: ~10× embedding, ~50× reranking)**, but a bare `llama-server` is a process you
  started. Making it as durable as the container means writing a unit for it. Socket activation
  gets both (always reachable, only resident when used) at the cost of a cold start on the first
  request after idle **(provisional: ~1.3 s, comfortably inside Crucible's 5 s interactive
  timeout)**.
- **LM Studio** is the best place to *evaluate* models — it downloads and swaps them in a GUI, and
  it bundles the llama.cpp binaries you would otherwise build. It is the worst place to *depend*
  on one, because it is an application a person launches.
- **Hosted** removes every operational problem and sends every chunk of your vault to a third
  party. For a personal knowledge vault that is often the deciding factor, in either direction.

A common and reasonable arrangement: LM Studio to try models out, then whichever server you can
keep running for the one you settle on.

---

## 4. Setting each route up

Two rules govern all of them; getting either wrong produces a confusing failure.

**Rule 1 — the provider kind is about the wire protocol, not the vendor.** LM Studio, llama.cpp,
vLLM, LocalAI and TEI are all `openai-compatible`. Only ollama is `ollama` — it speaks its own
JSON at `/api/embed`, and pointing an `ollama`-kind provider at an OpenAI-compatible port fails
with an empty response rather than a clear error.

**Rule 2 — base URLs are asymmetric, and this is not a bug.** Crucible appends the operation path
to whatever you configure:

| Purpose | Client appends | So configure |
|---|---|---|
| Embeddings, `openai-compatible` | `/embeddings` | `http://host:port/v1` — **include the `/v1`** |
| Rerank, `openai-compatible` | `/rerank` | whatever prefix that server serves rerank under |

Infinity's default routes are unprefixed, so its reranker is configured as `http://host:4803`
with **no** `/v1`, while its embedder — started with `--url-prefix /v1` — is
`http://host:4802/v1`. llama.cpp serves `/rerank` *and* `/v1/rerank`, so either works there.
Configure the reranker as its own provider entry; there is no rerank-specific URL field.

### Infinity (Docker)

```bash
# one model per container; two containers
michaelf34/infinity:0.0.77-cpu v2 --model-id BAAI/bge-m3            --engine optimum --url-prefix /v1 --port 4802
michaelf34/infinity:0.0.77-cpu v2 --model-id BAAI/bge-reranker-v2-m3 --engine torch                    --port 4803
```

**The two `--engine` flags differ on purpose.** `optimum` runs ONNX and resolves ONNX weights from
the HF repo; `BAAI/bge-reranker-v2-m3` publishes PyTorch weights only, so under `optimum` it dies
during engine selection with `No onnx files found` — before downloading a byte, at any memory
limit. `bge-m3` does ship `onnx/model.onnx`, so the embedder keeps the faster ONNX path. **Check
which weights a repo actually publishes before aligning these flags.**

Crucible: provider kind `openai-compatible`, base URL `http://127.0.0.1:4802/v1`, no API key.

### `llama-server` (llama.cpp)

The engine LM Studio bundles, usable directly — and it does reranking, which LM Studio's own
server does not. If LM Studio is installed you already have the binary and the GGUF:

```bash
B=~/.lmstudio/extensions/backends/llama.cpp-linux-x86_64-vulkan-avx2-2.27.1
LD_LIBRARY_PATH=$B $B/llama-server \
  -m ~/.lmstudio/models/gpustack/bge-reranker-v2-m3-GGUF/bge-reranker-v2-m3-Q8_0.gguf \
  --host 127.0.0.1 --port 8012 --reranking --pooling rank -ngl 99
```

It serves `/rerank`, `/reranking`, `/v1/rerank` and `/v1/reranking`. Run a second instance without
`--reranking` for embeddings.

**Do not set `--pooling` on an embedding server unless you know you need to.** GGUFs carry their
pooling type in metadata and llama.cpp honours it. Forcing the flag silently changes the vector
space if a future GGUF disagrees — producing well-formed vectors of the right width that simply
mean something else. (`--pooling rank` on a *reranker* is different: that is what selects rerank
behaviour.)

A containerised, socket-activated version of both services lives in
[`docker/llamacpp-vulkan/`](../docker/llamacpp-vulkan/README.md), including the systemd units and
the GPU assertion described in §8.

### LM Studio

Start the server (default `127.0.0.1:1234`), load an embedding model, then in Crucible add an
`openai-compatible` provider at `http://127.0.0.1:1234/v1` — the `/v1` is required.

- Its native `GET /api/v0/models` reports `quantization`, `type`, `arch`, `state` and
  `max_context_length`. Crucible probes this to learn what precision actually loaded. The plain
  `/v1/models` carries only `id` and `owned_by` and is useless for that.
- **LM Studio answers unknown endpoints with HTTP 200** and `{"error":"Unexpected endpoint or
  method. (POST /x)"}` in the body. Any capability check based on the status code will report
  every capability as present. This is how `/v1/rerank` was first mistaken for supported.
- **It indexes one model under several aliases**, some carrying the quantization
  (`model@q4_k_m`), some not. The quant-free alias is the natural thing to configure, and the file
  beneath it can be swapped for a different quantization with no change to the string you
  configured. See §6.

### ollama

```bash
systemctl edit ollama          # Environment="OLLAMA_VULKAN=1" for AMD Vulkan
ollama pull bge-m3
curl -s localhost:11434/api/tags | jq '.models[].details'   # quantization_level, format, digest
```

Crucible: provider kind **`ollama`**, base URL `http://127.0.0.1:11434` (no `/v1`). ollama reports
quantization and a `digest` (sha256 of the weights blob) — the strongest identity of any local
runtime. It has **no rerank endpoint**, so pair it with something else if you want reranking.

### Hosted APIs

Provider kind `openai` or `openai-compatible` with the vendor's base URL and an API key. No
lifecycle to manage; every chunk of indexed text leaves the machine, including at index time, not
only at query time. Rerank availability is vendor-specific.

---

## 5. Verify it is actually working

Given §1, "it returns vectors" is not evidence. Four checks, in order of how much they buy:

1. **Rank something you know the answer to.** Embed one query and three documents — one clearly
   relevant, two clearly not — and check the ordering *and the spread*. A healthy bi-encoder leaves
   roughly **0.35** between a real match and an unrelated document. Everything landing in a
   0.85–0.99 band means the model is not discriminating, whatever it claims to be.

   **The sharpest version of this test costs nothing and needs no judgment: use a translation.**
   Take any paragraph, get a translation of it into a language your model claims to support, and
   embed both along with a dozen unrelated paragraphs. The translation shares almost no vocabulary
   with the original, so only a model that has actually encoded *meaning* will rank it first — a
   keyword-ish or broken embedding cannot fake it. `bge-m3` ranks it first 100% of the time
   (en→fr); the reranker-as-embedder from §1 manages 19.7%, and once put it dead last of 61.
   `scripts/embedding-quality.mjs` (`npm run search:quality`) automates exactly this.
2. **Compare runtimes before you switch between them.** `scripts/embedding-agreement.mjs` embeds
   the same real chunks through two servers and reports minimum cosine and top-10 rank overlap.
   Run it whenever you change server, model file, quantization or llama.cpp build.
3. **Ask the server what it loaded, and believe the file rather than the alias.** Crucible probes
   `/api/v0/models` (LM Studio) or `/api/tags` + `/api/show` (ollama) and shows the detected
   precision. Infinity reports no dtype at all — that is a clean "unknown", not a guess.
4. **On a GPU, confirm the GPU.** See the `llvmpipe` trap in §8: "it works and it is fast" is a
   comparison you have to actually make, because the silent fallback answers every request
   correctly.

---

## 6. Quantization, and why the same model name is not the same vector space

Changing engine, build or quantization does perturb the vectors. The question that matters is
whether the perturbation is large enough to change what you *retrieve*, and the answer — measured
against ground truth rather than against another server — is **no, until you go very low**.

Measured over 61 parallel Wikipedia articles in English, French and Japanese (11 topic clusters,
183 documents). Ground truth is that an article and its translation say the same thing in almost
no shared vocabulary, so a working multilingual embedder must rank the true translation first out
of 61 candidates. "Spread" is mean translation similarity minus mean unrelated-pair similarity —
how much room the model leaves between a real match and a stranger.

| Configuration | en→fr P@1 | en→ja P@1 | spread |
|---|---|---|---|
| Infinity, ONNX **fp32** | 100.0% | 98.4% | 0.3513 |
| llama.cpp, GGUF **f32** | 100.0% | 98.4% | 0.3513 |
| llama.cpp, GGUF **f16** | 100.0% | 98.4% | 0.3515 |
| llama.cpp, GGUF **f16**, different conversion | 100.0% | 98.4% | 0.3515 |
| llama.cpp, GGUF **Q8_0** | 100.0% | 98.4% | 0.3516 |
| llama.cpp, GGUF **Q4_K_M** | 98.4% | 98.4% | 0.3358 |
| llama.cpp, GGUF **Q2_K** (366 MB) | 100.0% | 100.0% | **0.2383** |

Three conclusions:

1. **Runtime, build and conversion do not change retrieval.** Two engines, two llama.cpp builds and
   two independent GGUF conversions land within 0.0003 of each other. Moving the same weights to a
   different host does not require a re-embed. (They are not bit-identical — roughly one result in
   a hundred shifts position — but the shift is numerical noise with no measurable quality cost.)
2. **Quantization degrades *spread*, not *ranking*.** Down to Q8_0 nothing is measurable at all.
   Q4_K_M costs one article out of 61. Even Q2_K still ranks the right translation first every
   time — but unrelated documents drift from 0.44 to 0.59 similarity, squeezing the space. Ranking
   reads order, so ranking survives; anything reading absolute scores does not.
3. **No similarity threshold separates a match from a stranger, in any configuration.** Even at
   100% P@1 the *worst* true translation scores below the *best* unrelated pair. Rank results;
   never write "drop anything below 0.5".

**Practical advice.** f16 is a fine default and Q8_0 is indistinguishable from it. Q4_K_M is a
reasonable trade if you want the memory back. Below that you are buying disk space with
discrimination, which matters most if you ever compare scores rather than order them. The larger
risk by far is not quantization — it is picking a model that is not an embedder at all (§1) or one
that does not cover your languages (§5).

**Crucible keys on an embedding space, not a model name.** Companion schema 4 added
`chunks.embedding_space` = model id plus normalised precision (`bge-m3/f16`); the vector scan
filters by it, and mixing two spaces in one vault is refused at upsert with a 4xx. On the evidence
above this is a conservative guard rather than a necessary one — it prevents a mix whose measured
retrieval cost at f16-vs-f32 is nil — and it does **not** catch the failures that actually destroy
retrieval, since a cross-encoder and a real embedder at the same width and precision occupy the
same "space" by this definition. It is cheap and it fails closed, so it stays; do not read it as
evidence that f16 and fp32 are meaningfully different.

- Switching quantization triggers a re-embed. That is deliberate conservatism, not a correctness
  requirement at the top of the ladder.
- If your runtime cannot report its precision — Infinity cannot; it exposes only `backend` — the
  space falls back to the bare model id and nothing re-embeds. Declare it by hand in the model
  row's **Embedding precision (fallback)** field if you run two precisions of one model.
- Spellings are normalised, so `Q4_K_M`, `q4_k_m` and GGUF `file_type: 15` are one space rather
  than three.

---

## 7. The rerank wire contract

Higher is better everywhere, but the scales are not the same:

| Server | Returns | Example |
|---|---|---|
| llama.cpp `/v1/rerank` | **raw logits** — negative, unbounded | `+1.66` relevant, `−11.03` irrelevant |
| Infinity `/rerank` | **sigmoid-normalised 0–1** | `0.6047` |

Ordering logic is safe against both, and Crucible's strict parser (one result per document, no
`top_n` needed) passes against both. **Any UI, test or threshold asserting a 0–1 range is wrong
against llama.cpp** — and a fixed cutoff like "drop anything below 0.5" silently drops everything.

This also makes rerank scores non-comparable across servers. A logit of `−1.9` from one build and
`+4.9` from another can both be the top-ranked, correct answer.

---

## 8. Traps, each with its symptom

| Trap | Symptom |
|---|---|
| **Cross-encoder as embedder** (§1) | No error ever. Vectors are the right width and normalised; retrieval is vague; on-topic documents can rank below unrelated ones. |
| **Same name, different quantization** (§6) | No error, and — measured — no retrieval cost either down to Q8_0. Roughly 1 result in 100 shifts position. The real cost appears below Q4: scores compress toward each other, so ordering survives but any absolute threshold stops meaning anything. |
| **Trusting a similarity threshold** (§6) | No error. In *every* configuration measured, including ones that rank perfectly, the worst true match scores below the best unrelated pair — so a fixed cutoff drops real results and keeps junk. Rank; do not threshold. |
| **Engine flag vs published weights** | Infinity `--engine optimum` dies at startup with `No onnx files found`, before downloading anything, at any memory limit — because the repo ships PyTorch weights only. Looks like a memory or network problem; it is neither. |
| **Base-URL asymmetry** | 404s on `/embeddings` (missing `/v1`) or on `/v1/rerank` (extra `/v1` against a server that serves it unprefixed). |
| **HTTP 200 with an error body** (LM Studio) | A capability probe based on status codes reports every endpoint as supported. Check the response *body*. |
| **`torch.cuda.is_available()` returns `True` on a mismatched arch** | Container starts, healthcheck passes, and it dies on the first real request. A bad GPU configuration is indistinguishable from a good one until load. |
| **`llvmpipe` — the Vulkan version of the same trap** | A Vulkan loader with no usable hardware driver still enumerates `llvmpipe`, a software rasteriser, as a completely valid device. `llama-server` starts, answers everything correctly, passes any port-is-open healthcheck, and runs **several times slower than the CPU it replaced**. A silent CPU fallback is a regression wearing the costume of a working service. Assert a hardware device type at startup and log what the engine resolved; do not infer it from "the server came up". |
| **Request batch size** | Not an error — just 2.3× slower than it needs to be **(provisional; measured on CPU at 24 → 96, and Crucible caps at 96)**. |
| **Quoting throughput from a different text length** | The same model on the same CPU measured 301 items/s over title-length strings and 20.1/s over realistic ~1,118-character vault chunks — **15× apart on sequence length alone**. A throughput number without a text length attached is not transferable. |
| **Forcing `--pooling` on an embedding server** | No error; a future GGUF with different metadata silently yields well-formed vectors that mean something else. |
| **Skipping the cold start** | With socket activation the first request after idle pays the model load. Fine inside a 5 s timeout **(provisional: ~1.3 s)** — but point a client at the container's own published port instead of the socket and you bypass the on-demand start entirely and hit a stopped container. |

---

## 9. Measured numbers

All **(provisional)** — one machine (Ryzen 9 7900X, RX 9070 / gfx1201 / RADV, 62 GB RAM), several
sessions, differing batch sizes. Absolute throughput is hardware-specific; treat the ratios as
more portable than the values, and both as pending re-measurement.

| Workload | Infinity (CPU, fp32 ONNX) | llama.cpp Vulkan (GPU, f16 GGUF) | Ratio |
|---|---|---|---|
| Embedding `bge-m3`, batch 96, ~1,118-char chunks | 8.5 chunks/s | 90.0 chunks/s | ~10.6× |
| Reranking `bge-reranker-v2-m3`, 30 documents | 4.1 docs/s → **7.3 s** per click | **0.147 s** per click | ~50× |
| Cold start after idle | n/a (always resident) | ~1.3 s | |
| Warm request | | ~67 ms | |

Two caveats that matter more than the values:

- **Raw-endpoint rates are not backfill rates.** Crucible also reads, chunks and hashes locally on
  the same thread. The CPU path measured 8.5 chunks/s at the endpoint and **5.8 end-to-end**. That
  ~0.68 factor is the only end-to-end datapoint that exists, and it was inferred across two
  sessions rather than measured as a pair — do not lean on it.
- **A rate without a duration is not a rate.** These were short observations. Sustained-backfill
  behaviour is unmeasured.

The reranking row is the decisive one. At `searchRerankTopN: 30`, 7.3 seconds per click is long
enough that the button gets avoided; 0.147 s is not.

---

## 10. Worked example — AMD RDNA4 (gfx1201)

One machine's specifics, included because the *shape* of the problem generalises.

- **ROCm is blocked, and not by the host.** Host ROCm 7.2.2 supports gfx1201 fine. The published
  AMD Infinity image ships torch `2.5.1+rocm6.2`, whose compiled arch list stops at
  `gfx1100`/`gfx942`; gfx1201 needs ROCm 6.4+. `torch.cuda.is_available()` still returns `True` on
  that image, so it passes its healthcheck and dies on the first kernel.
- **Do not force it with `HSA_OVERRIDE_GFX_VERSION`.** Presenting one architecture as another
  produces invalid GPU programs, which is the workload class that wedges this GPU hard enough to
  cost a desktop session. Signature, triggers, recovery paths (SSH or SysRq `S`-`U`-`B`; capture
  `/sys/class/drm/card1/device/devcoredump/data` *before* rebooting — it is in-memory only) are in
  `context-control/references/rdna4-gpu-hang.md`. Read it before any GPU experiment on this class
  of hardware; it is deliberately not duplicated here.
- **Vulkan is not blocked.** RADV drives gfx1201 today and has run sustained embedding and rerank
  workloads without instability. The hazard is invalid GPU programs, not mature inference kernels.
- **The Mesa version is load-bearing.** gfx1201 needs Mesa ≥ 26. A container based on Debian
  trixie or Ubuntu 24.04 ships 24.x/25.0.x and falls back to `llvmpipe` *silently* (§8) —
  `debian:sid-slim` ships 26.1.5. "Stabilising" the base image is the failure, not the fix.
- **The bundled ROCm llama.cpp build has never been probed.** llama.cpp compiles for a different
  target set than PyTorch, so it may support gfx1201 where torch does not. Since Vulkan already
  works, this is optimisation rather than enablement.

---

## 11. See also

- [Search companion](search-companion.md) — the search service itself, the embedding-space schema,
  and the fleet's current inference services.
- [`docker/llamacpp-vulkan/`](../docker/llamacpp-vulkan/README.md) — the socket-activated GPU
  embedding/reranking containers, their systemd units, and the GPU assertion.
- `context-control/references/rdna4-gpu-hang.md` — GPU hang signature and recovery.
- `runs/dispatch/esi-field-report-protocol.md` — the measurement protocol that will replace every
  provisional number above.
