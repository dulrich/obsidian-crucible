#!/bin/sh
# Refuse to start on the CPU.
#
# The failure this guards against is not a crash, it is a success that is quietly worthless. A
# Vulkan loader with no usable GPU driver still enumerates `llvmpipe`, a software rasteriser, as
# a perfectly valid Vulkan device. llama-server will happily run on it, answer every request,
# pass any "is the port open" healthcheck, and be several times *slower* than the CPU containers
# this service replaced — with nothing anywhere saying so. Measured on this box the gap is 6x for
# embedding and 24x for reranking, so a silent fallback is not a degraded service, it is a
# regression wearing the costume of a working one.
#
# So: prove a hardware device is present, print what the inference library itself resolves, and
# only then exec. Set CRUCIBLE_ALLOW_CPU_VULKAN=1 to bypass, which exists for debugging on a
# machine with no GPU and should never be set in the fleet.
set -eu

echo "[entrypoint] vulkan devices visible to this container:"
vulkaninfo --summary 2>/dev/null | grep -E 'deviceName|deviceType|driverName|driverInfo' || {
	echo "[entrypoint] FATAL: vulkaninfo produced no device information at all." >&2
	echo "[entrypoint] The container almost certainly has no /dev/dri passthrough. Check that" >&2
	echo "[entrypoint] the compose service has devices: [\"/dev/dri:/dev/dri\"] and group_add for" >&2
	echo "[entrypoint] the host's render and video groups." >&2
	exit 1
}

if [ "${CRUCIBLE_ALLOW_CPU_VULKAN:-0}" != "1" ]; then
	# INTEGRATED is accepted as well as DISCRETE: an APU is a legitimate deployment, llvmpipe is
	# not. The test is the device *type*, not the driver name, because a future driver name is
	# not knowable here while "is this silicon" is.
	if ! vulkaninfo --summary 2>/dev/null | grep -qE 'PHYSICAL_DEVICE_TYPE_(DISCRETE|INTEGRATED)_GPU'; then
		echo "[entrypoint] FATAL: no hardware Vulkan device found — only a software rasteriser." >&2
		echo "[entrypoint] Running here would be slower than the CPU services this replaces, so" >&2
		echo "[entrypoint] the container refuses to start rather than silently degrade." >&2
		echo "[entrypoint] Most likely cause: the image's Mesa is too old for this GPU. This box" >&2
		echo "[entrypoint] needs Mesa >= 26 for gfx1201 (RDNA4); see the Dockerfile's header." >&2
		echo "[entrypoint] Override with CRUCIBLE_ALLOW_CPU_VULKAN=1 only for debugging." >&2
		exit 1
	fi
fi

# What vulkaninfo sees and what ggml resolves are two different questions, and only the second
# one decides where the tensors land. Print it so `docker logs` answers "did it use the GPU?"
# without anyone having to reproduce a benchmark.
echo "[entrypoint] devices as ggml resolves them:"
llama-server --list-devices 2>&1 | sed 's/^/[entrypoint]   /' || true

# Dual-use tail: this used to hardcode `exec llama-server "$@"`, but the image now also runs
# llama-swap (which spawns its own llama-server children internally per its config.yaml) as the
# default CMD. The GPU assertion above is identical either way — it belongs to the container,
# not to whichever process ends up owning the tensors — so only this exec needs to become
# argv-agnostic. Passing a bare `llama-server -m ... --embeddings ...` command still works
# exactly as before.
echo "[entrypoint] starting: $*"
exec "$@"
