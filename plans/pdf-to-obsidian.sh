#!/usr/bin/env bash
set -euo pipefail

PDF="${1:?Usage: pdf2md FILE.pdf}"
VAULT="$HOME/Obsidian/YourVault"
OUT="$VAULT/inbox/pdf_imports"

mkdir -p "$OUT"

chandra "$PDF" "$OUT" \
  --method hf \
  --include-images \
  --no-headers-footers
