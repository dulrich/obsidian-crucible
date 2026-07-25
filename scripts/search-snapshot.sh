#!/usr/bin/env bash
# scripts/search-snapshot.sh — safe hot backup of the live search companion database.
#
# The companion database is WAL-mode (`PRAGMA journal_mode = WAL`,
# scripts/search-companion.mjs:119). A plain `cp` of search.sqlite omits the -wal sidecar and
# yields a stale or corrupt copy. This script instead runs SQLite's `VACUUM INTO` *inside* the
# container, which produces an atomic, consistent, self-contained, compacted snapshot with no
# downtime and no WAL sidecar to carry along.
#
# The database lives in the Docker volume `context-control_crucible-search-data` (the
# `context-control` fleet compose project's volume — NOT this repo's own docker-compose.yml,
# which names a volume `crucible-search-data` that does not exist / is not what's running),
# mounted at /data/search.sqlite inside the container named `crucible-search`.
#
# Usage:
#   scripts/search-snapshot.sh [output-path]
#
# With no argument, writes ./search-backup-<YYYY-MM-DD-HHMM>.sqlite in the current directory.
#
# ============================================================================================
# RESTORE PATH — read this before restoring, the load-bearing step is easy to skip
# ============================================================================================
#   1. Stop (or at minimum, do not point) anything that has the live search.sqlite open.
#   2. Copy the snapshot file into place as search.sqlite, e.g.:
#        docker cp ./search-backup-2026-07-25-1200.sqlite crucible-search:/data/search.sqlite
#   3. Delete any stale search.sqlite-wal and search.sqlite-shm sitting BESIDE the restored
#      file. This is not optional: VACUUM INTO produces a WAL-less snapshot, but the directory
#      you restore into may still hold sidecar files from before the restore. If they are left
#      in place, SQLite will replay the *old* WAL against the *newly restored* file on next
#      open, which will corrupt it or silently revert your restore back to pre-snapshot state.
#        docker exec crucible-search rm -f /data/search.sqlite-wal /data/search.sqlite-shm
#   4. Restart the search companion container so it reopens the file fresh.
# ============================================================================================
#
# This script never writes to the live database — VACUUM INTO is a read of the source database
# that writes only to a brand-new file at the destination path. The destination here is always
# /tmp inside the container (never /data), so the snapshot never lands in the live volume, and
# it is deleted from /tmp immediately after being copied out.

set -euo pipefail

CONTAINER="crucible-search"
HEALTH_URL="http://127.0.0.1:4801/health"

OUT_PATH="${1:-}"
if [ -z "$OUT_PATH" ]; then
	OUT_PATH="./search-backup-$(date +%F-%H%M).sqlite"
fi

echo "==> Checking container '$CONTAINER' is running..." >&2
if ! docker ps --format '{{.Names}}' | grep -Fxq "$CONTAINER"; then
	echo "ERROR: container '$CONTAINER' is not running (docker ps shows no match)." >&2
	echo "Refusing to snapshot — there is nothing to read from." >&2
	exit 1
fi

echo "==> Reading live /health for the expected chunk count..." >&2
HEALTH_JSON="$(curl -sf --max-time 10 "$HEALTH_URL")" || {
	echo "ERROR: could not reach $HEALTH_URL. Is the companion healthy?" >&2
	exit 1
}
LIVE_EMBEDDED_CHUNKS="$(printf '%s' "$HEALTH_JSON" | jq -r '.embeddedChunks // empty')"
if [ -z "$LIVE_EMBEDDED_CHUNKS" ]; then
	echo "ERROR: /health response did not include embeddedChunks; got: $HEALTH_JSON" >&2
	exit 1
fi
echo "    live embeddedChunks: $LIVE_EMBEDDED_CHUNKS" >&2

TMP_IN_CONTAINER="/tmp/search-snapshot-$$.sqlite"

echo "==> Running VACUUM INTO inside the container (writes only to /tmp, never /data)..." >&2
docker exec "$CONTAINER" node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/search.sqlite', { readOnly: true });
db.exec(\"VACUUM INTO '${TMP_IN_CONTAINER}'\");
db.close();
"

echo "==> Copying snapshot out of the container to $OUT_PATH ..." >&2
docker cp "$CONTAINER:$TMP_IN_CONTAINER" "$OUT_PATH"

echo "==> Cleaning up the in-container temp file..." >&2
docker exec "$CONTAINER" rm -f "$TMP_IN_CONTAINER"

if [ ! -s "$OUT_PATH" ]; then
	echo "ERROR: snapshot file $OUT_PATH is missing or empty after docker cp." >&2
	exit 1
fi

echo "==> Verifying snapshot integrity and chunk count..." >&2
if ! command -v sqlite3 >/dev/null 2>&1; then
	echo "ERROR: host 'sqlite3' CLI not found; cannot verify the snapshot. A backup nobody" >&2
	echo "verified is not a backup — refusing to declare success." >&2
	exit 1
fi

INTEGRITY="$(sqlite3 "$OUT_PATH" 'PRAGMA integrity_check;')"
if [ "$INTEGRITY" != "ok" ]; then
	echo "ERROR: snapshot failed integrity_check: $INTEGRITY" >&2
	exit 1
fi

SNAPSHOT_EMBEDDED_CHUNKS="$(sqlite3 "$OUT_PATH" 'SELECT COUNT(*) FROM chunks WHERE embedding IS NOT NULL;')"

if [ "$SNAPSHOT_EMBEDDED_CHUNKS" != "$LIVE_EMBEDDED_CHUNKS" ]; then
	echo "ERROR: snapshot embedded chunk count ($SNAPSHOT_EMBEDDED_CHUNKS) does not match" >&2
	echo "live /health.embeddedChunks ($LIVE_EMBEDDED_CHUNKS). The snapshot may have been taken" >&2
	echo "mid-write, or something is wrong. Not declaring success." >&2
	exit 1
fi

SIZE_BYTES="$(stat -c%s "$OUT_PATH" 2>/dev/null || stat -f%z "$OUT_PATH")"
SIZE_HUMAN="$(du -h "$OUT_PATH" | cut -f1)"

echo "==> Snapshot verified." >&2
echo "    path:            $OUT_PATH" >&2
echo "    size:            $SIZE_HUMAN ($SIZE_BYTES bytes)" >&2
echo "    embeddedChunks:  $SNAPSHOT_EMBEDDED_CHUNKS (matches live /health)" >&2
echo "    integrity_check: ok" >&2
