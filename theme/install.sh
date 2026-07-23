#!/usr/bin/env bash
# Symlink this theme into an Obsidian vault for the hot-reload dev loop.
# Usage: theme/install.sh /path/to/Vault
# Mirrors the plugin's own vault-symlink workflow. Obsidian loads a theme from
# <vault>/.obsidian/themes/<name>/ using theme.css + manifest.json.
set -euo pipefail

VAULT="${1:-}"
if [[ -z "$VAULT" ]]; then
  echo "usage: theme/install.sh /path/to/Vault" >&2
  exit 2
fi
if [[ ! -d "$VAULT/.obsidian" ]]; then
  echo "error: $VAULT/.obsidian not found — is that an Obsidian vault?" >&2
  exit 1
fi

THEME_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$VAULT/.obsidian/themes"
DEST="$DEST_DIR/Crucible N1 Console"

mkdir -p "$DEST_DIR"
ln -sfn "$THEME_SRC" "$DEST"
echo "linked: $DEST -> $THEME_SRC"
echo "Enable it in Obsidian: Settings → Appearance → Themes → 'Crucible N1 Console'."
