# llama.cpp `llama-server` on Vulkan, for the fleet's GPU embedding and reranking services.
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

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Read-only mount point for the GGUF library. Nothing in this image ever writes to it.
VOLUME ["/models"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
