#!/usr/bin/env bash
# Host-run smoke test for the crucible-inference llama-swap router (config.yaml in this dir).
#
# Run this AFTER the compose service is up (that wiring is a later, cross-repo work package —
# this script only assumes something is answering on the target URL). It does not start, stop,
# or otherwise touch any container.
#
# Usage:
#   docker/llamacpp-vulkan/smoke-inference.sh [--url http://127.0.0.1:4806] [--wait-ttl]
#
# --wait-ttl is opt-in and slow on purpose: the retrieval group's ttl is 1800s (30 minutes), so
# proving unload-on-ttl for real means sleeping through it. Without the flag, that check is
# skipped and reported as such rather than silently omitted.
#
# Exits non-zero on any check failure. Requires: curl, jq.
set -u

URL="http://127.0.0.1:4806"
WAIT_TTL=0

while [ "$#" -gt 0 ]; do
	case "$1" in
	--url)
		URL="$2"
		shift 2
		;;
	--wait-ttl)
		WAIT_TTL=1
		shift
		;;
	*)
		echo "unknown argument: $1" >&2
		exit 2
		;;
	esac
done

for bin in curl jq; do
	if ! command -v "$bin" >/dev/null 2>&1; then
		echo "[smoke] FATAL: '$bin' is required but not on PATH." >&2
		exit 2
	fi
done

fail=0
note() { echo "[smoke] $*"; }
pass() { echo "[smoke] PASS: $*"; }
bad() {
	echo "[smoke] FAIL: $*" >&2
	fail=1
}

# ── 1. /health ───────────────────────────────────────────────────────────────────────────────
note "checking GET /health ..."
health_code=$(curl -s -o /tmp/crucible-smoke-health.json -w '%{http_code}' --max-time 10 "$URL/health") || health_code="000"
if [ "$health_code" = "200" ]; then
	pass "/health returned 200"
else
	bad "/health returned $health_code (expected 200)"
fi

# ── 2. /v1/models lists both aliases ────────────────────────────────────────────────────────
# llama-swap (verified on v243) does not surface aliases as top-level ids: each entry's id is
# the canonical model name, and its aliases ride in meta.llamaswap.aliases. Requests BY alias
# still route (checks 3 and 4 use the aliases), so accept an alias appearing in either place.
note "checking GET /v1/models ..."
models_json=$(curl -s --max-time 10 "$URL/v1/models") || models_json=""
model_names=$(echo "$models_json" | jq -r '
	.data[]? | (.id // empty), (.meta.llamaswap.aliases[]? // empty)
' 2>/dev/null)
if echo "$model_names" | grep -qx "bge-m3" && echo "$model_names" | grep -qx "bge-reranker-v2"; then
	pass "/v1/models lists both aliases (bge-m3, bge-reranker-v2)"
else
	bad "/v1/models did not list both required aliases (as ids or meta.llamaswap.aliases). Got: $(echo "$model_names" | tr '\n' ',' )"
fi

# ── 3. /v1/embeddings (model bge-m3) returns a numeric vector ───────────────────────────────
note "checking POST /v1/embeddings (model=bge-m3) ..."
embed_json=$(curl -s --max-time 60 "$URL/v1/embeddings" \
	-H 'Content-Type: application/json' \
	-d '{"model":"bge-m3","input":"crucible smoke test embedding"}') || embed_json=""
embed_len=$(echo "$embed_json" | jq -r '
	(.data[0].embedding // empty)
	| if type == "array" and length > 0 and (all(.[]; type == "number")) then length else empty end
' 2>/dev/null)
if [ -n "$embed_len" ]; then
	pass "/v1/embeddings returned a numeric vector of length $embed_len"
else
	bad "/v1/embeddings did not return a well-formed numeric vector. Response: $embed_json"
fi

# ── 4. /rerank (model bge-reranker-v2, 3 docs) ──────────────────────────────────────────────
note "checking POST /rerank (model=bge-reranker-v2, 3 docs) ..."
rerank_json=$(curl -s --max-time 60 "$URL/rerank" \
	-H 'Content-Type: application/json' \
	-d '{
		"model": "bge-reranker-v2",
		"query": "What is the capital of France?",
		"documents": [
			"Paris is the capital of France.",
			"Arctic terns migrate thousands of miles each year.",
			"The Eiffel Tower is a famous landmark in Paris."
		]
	}') || rerank_json=""
# Note on "finite": strict JSON cannot encode NaN/Infinity at all, so if either server emitted
# a non-finite score as a bare literal, curl's response fails to parse as JSON entirely and
# rerank_check comes back empty below (treated as a failure) rather than silently passing —
# there's no separate isnan/isinfinite check needed once the payload parses as JSON.
rerank_check=$(echo "$rerank_json" | jq -r '
	(.results // empty) as $r
	| if ($r | type) != "array" or ($r | length) != 3 then "bad:shape"
	  elif ([$r[].index] | sort) != [0,1,2] then "bad:index"
	  elif ([$r[].relevance_score] | all(type == "number")) != true then "bad:score"
	  else "ok"
	  end
' 2>/dev/null)
if [ "$rerank_check" = "ok" ]; then
	pass "/rerank returned 3 results with a unique in-range index and a finite relevance_score each"
else
	bad "/rerank response failed validation (${rerank_check:-no parseable response}). Response: $rerank_json"
fi

# ── 5. /api/v0/models fails FAST (not hang) ─────────────────────────────────────────────────
# This is an LM Studio-only endpoint. llama-swap does not implement it. The point of this check
# isn't that it 404s (any 4xx/5xx is acceptable) — it's that an unknown endpoint must fail fast
# rather than hang the connection open, per the recorded "probe by response body/behavior, not
# assumption" lesson elsewhere in this fleet.
note "checking GET /api/v0/models fails fast (unsupported endpoint) ..."
start_ts=$(date +%s)
unsupported_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL/api/v0/models")
curl_rc=$?
end_ts=$(date +%s)
elapsed=$((end_ts - start_ts))
if [ "$curl_rc" -ne 0 ]; then
	bad "/api/v0/models curl call failed/timed out (rc=$curl_rc) after ${elapsed}s — expected a fast 4xx/5xx, not a hang"
elif [ "$elapsed" -gt 5 ]; then
	bad "/api/v0/models took ${elapsed}s (> 5s) — expected a fast failure"
elif echo "$unsupported_code" | grep -qE '^[45][0-9][0-9]$'; then
	pass "/api/v0/models failed fast with $unsupported_code in ${elapsed}s"
else
	bad "/api/v0/models returned $unsupported_code (expected 4xx/5xx) in ${elapsed}s"
fi

# ── 6. GET /running — ttl unload (optional, slow) ───────────────────────────────────────────
if [ "$WAIT_TTL" -eq 1 ]; then
	ttl_seconds=1800
	note "checking GET /running shows the retrieval group unloading after ttl (${ttl_seconds}s) — this will sleep through the full ttl, ~30 minutes ..."
	running_before=$(curl -s --max-time 10 "$URL/running")
	before_count=$(echo "$running_before" | jq -r '(.running // .models // []) | length' 2>/dev/null)
	note "models running before wait: ${before_count:-unknown}"
	sleep "$((ttl_seconds + 30))"
	running_after=$(curl -s --max-time 10 "$URL/running")
	after_count=$(echo "$running_after" | jq -r '(.running // .models // []) | length' 2>/dev/null)
	if [ "${after_count:-1}" = "0" ]; then
		pass "/running shows 0 models loaded after the ttl window (VRAM returned)"
	else
		bad "/running still shows ${after_count:-unknown} model(s) loaded after waiting past ttl. Response: $running_after"
	fi
else
	note "SKIPPED: ttl-unload check (pass --wait-ttl to run it — it sleeps ~30 minutes for the retrieval group's 1800s ttl)"
fi

echo
if [ "$fail" -eq 0 ]; then
	echo "[smoke] all checks passed"
	exit 0
else
	echo "[smoke] one or more checks FAILED" >&2
	exit 1
fi
