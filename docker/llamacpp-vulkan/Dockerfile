# llama.cpp `llama-server` on Vulkan + llama-swap, for the fleet's GPU inference services.
#
# Resulting tag: crucible-llamacpp-vulkan:b10121-swap243 (llama.cpp tag + llama-swap tag baked
# into this image, so the tag alone tells you both pins without opening the Dockerfile).
#
# As of the llama-swap addition this image is dual-use, and that is deliberate — it is mid
# migration from "one model, one process, one systemd socket" to "one always-on multi-model
# router" (see README.md). `ENTRYPOINT` still only proves the GPU is real; whatever command you
# pass after that (`llama-swap -config ... -listen ...` — the image's `CMD` default — or a bare
# `llama-server -m ... --embeddings ...` for the old single-model shape) is exec'd unchanged.
#
# Why this image exists at all, when the search companion's Dockerfile sits at the repo root:
# that one ships Crucible's own code, this one ships a third-party inference server. Its build
# context is this directory (not the repo root), so it shares nothing with the companion image —
# in particular it does not inherit the root `.dockerignore`, which is load-bearing there and
# irrelevant here.
#
# ── The base image is the entire point, so do not "modernise" it downward ────────────────────
#
# The GPU is an RX 9070 (gfx1201, RDNA4). RADV drives it, but only on a recent Mesa: this box's
# host runs 26.1.5 from the kisak PPA, which is *why* it works. `debian:sid-slim` is used here
# because it independently ships that same 26.1.5, verified inside a container with only
# /dev/dri passed through:
#
#   deviceName = AMD Radeon RX 9070 (RADV GFX1201)   deviceType = DISCRETE_GPU
#   driverName = radv                                driverInfo = Mesa 26.1.5-1
#
# A stable base (Debian trixie, Ubuntu 24.04) ships Mesa 24.x/25.0.x, and the failure is silent
# rather than loud: `llvmpipe` — a software rasteriser — is *also* enumerated as a Vulkan device
# (see the probe output above; it is there even on a working host). So an image whose RADV is
# too old to claim gfx1201 does not fail to start. It runs on the CPU, passes any healthcheck
# that only asks "is the server up", and is *slower* than the Infinity CPU containers it was
# meant to replace. This is the same shape as the `torch.cuda.is_available()` trap already
# recorded for the ROCm attempt, and it is why entrypoint.sh asserts the selected device rather
# than trusting that the GPU was picked.
#
# The cost of sid is that it moves. The Mesa version is therefore pinned in the compose
# healthcheck's expectations rather than here, and `docker compose build --no-cache` is the way
# to pick up a Mesa fix.

# ── Build stage ──────────────────────────────────────────────────────────────────────────────
FROM debian:sid-slim AS build

# Pinned to a release tag, not master: an inference server that silently changes its wire format
# under a rebuild is exactly what the embedding-space work exists to make impossible elsewhere.
# Bump deliberately, and re-run the agreement harness (scripts/embedding-agreement.mjs) when you
# do — a llama.cpp change to pooling or normalisation would move every vector this serves.
ARG LLAMA_CPP_TAG=b10121

# `glslc` alone is not enough: ggml's vulkan-shaders-gen resolves SPIRV-Headers through CMake's
# find_package, and Debian ships those headers in their own package rather than pulling them in
# as a glslc dependency. Without spirv-headers the configure step fails with
# "Could not find a package configuration file provided by SPIRV-Headers" before a single shader
# is compiled.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates \
      libvulkan-dev glslc spirv-headers spirv-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch "${LLAMA_CPP_TAG}" https://github.com/ggml-org/llama.cpp.git .

# GGML_VULKAN=ON is the whole build. GGML_NATIVE=OFF keeps the binary from baking in this CPU's
# exact instruction set — the GPU does the work, and a portable binary means the image can be
# built on one fleet host and run on another without an illegal-instruction crash.
RUN cmake -B build \
      -DCMAKE_BUILD_TYPE=Release \
      -DGGML_VULKAN=ON \
      -DGGML_NATIVE=OFF \
      -DLLAMA_BUILD_TESTS=OFF \
      -DLLAMA_BUILD_EXAMPLES=OFF \
      -DLLAMA_BUILD_SERVER=ON \
      -DLLAMA_CURL=OFF \
    && cmake --build build --config Release --target llama-server -j"$(nproc)"

# ── llama-swap fetch stage ───────────────────────────────────────────────────────────────────
#
# llama-swap turns this image from "one model, one process" into a multi-model router: it spawns
# llama-server children on demand per request (holding the client's request until the child
# reports healthy on its `checkEndpoint`), swaps/unloads them per `ttl`, and exposes one stable
# set of aliases across `/v1/chat/completions`, `/v1/embeddings`, `/v1/models` (aggregated), and
# `/rerank` + `/v1/rerank`. It is a static Go binary published as a GitHub release asset, so
# there is no source build to reproduce here — only a download to pin and verify, the same shape
# as any other pinned third-party binary in this fleet.
#
# Pinned to >= v242 specifically: v242 fixed a TTL-unload deadlock, and llama-swap has no
# stability guarantee below that. v243 is the release this was authored against (2026-07-26).
# The checksum is not hand-typed: it is the `llama-swap_<ver>_linux_amd64.tar.gz` line from that
# release's own `llama-swap_<ver>_checksums.txt`, cross-checked here by downloading the asset
# and hashing it independently. Bump `LLAMA_SWAP_TAG` deliberately, and re-derive
# `LLAMA_SWAP_SHA256` from the new release's checksums file the same way — never hand-edit the
# hash to make a build pass.
FROM debian:sid-slim AS swap

ARG LLAMA_SWAP_TAG=v243
ARG LLAMA_SWAP_SHA256=1bb27ccbdaff0c4e42ef2356e2e7b5c693073dd57f9dcecf6c35ae6847f0b140

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /swap
# The release asset name drops the leading "v" from the tag (llama-swap_243_..., not
# llama-swap_v243_...) — `${LLAMA_SWAP_TAG#v}` strips it.
RUN curl -fsSL -o llama-swap.tar.gz \
      "https://github.com/mostlygeek/llama-swap/releases/download/${LLAMA_SWAP_TAG}/llama-swap_${LLAMA_SWAP_TAG#v}_linux_amd64.tar.gz" \
    && echo "${LLAMA_SWAP_SHA256}  llama-swap.tar.gz" | sha256sum -c - \
    && tar -xzf llama-swap.tar.gz llama-swap \
    && chmod +x llama-swap

# ── Runtime stage ────────────────────────────────────────────────────────────────────────────
FROM debian:sid-slim

# mesa-vulkan-drivers is RADV itself; vulkan-tools provides `vulkaninfo`, which entrypoint.sh
# uses to prove a discrete GPU was found before the server is allowed to start. Keeping
# vulkan-tools in the runtime image is deliberate: the assertion is worth more than the ~15MB.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libvulkan1 mesa-vulkan-drivers vulkan-tools libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/build/bin/llama-server /usr/local/bin/llama-server
COPY --from=build /src/build/bin/*.so /usr/local/lib/
RUN ldconfig

COPY --from=swap /swap/llama-swap /usr/local/bin/llama-swap

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Read-only mount point for the GGUF library. Nothing in this image ever writes to it.
VOLUME ["/models"]

# /app/config.yaml is where the compose service (context-control, WP-6) bind-mounts
# config.yaml read-only. It is NEVER COPYed into the image — llama-swap's config must be
# editable without a rebuild, and baking it in would defeat that. This just ensures the mount
# point directory exists.
RUN mkdir -p /app

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Dual-use default: the router is the new normal, but the image still runs a bare
# `llama-server ...` command unchanged (`entrypoint.sh`'s tail is `exec "$@"`) — see README.md.
CMD ["llama-swap", "-config", "/app/config.yaml", "-listen", ":4806"]
