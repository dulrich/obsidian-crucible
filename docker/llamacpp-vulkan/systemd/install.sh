#!/usr/bin/env bash
# Install the on-demand GPU inference units into the *user* systemd instance.
#
# User units, not system units, for one reason: the containers are started through the calling
# user's Docker access and read GGUFs out of that user's LM Studio library. A system unit would
# run as root and have neither.
#
# Units are symlinked rather than copied, so editing them in the repo takes effect after a
# `systemctl --user daemon-reload` — no re-install step to forget.
set -euo pipefail

here="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")" && pwd)"
target="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$target"

for unit in crucible-embed.socket crucible-embed.service crucible-rerank.socket crucible-rerank.service; do
	ln -sfn "$here/$unit" "$target/$unit"
	echo "linked $target/$unit -> $here/$unit"
done

systemctl --user daemon-reload

# Only the SOCKETS are enabled. Enabling the services would start the containers at login and
# defeat the entire point — the socket is what makes them on-demand.
systemctl --user enable --now crucible-embed.socket crucible-rerank.socket

echo
echo "Sockets armed. Crucible should point at:"
echo "  embeddings  http://127.0.0.1:4804/v1     (openai-compatible provider kind)"
echo "  reranking   http://127.0.0.1:4805        (no /v1 suffix — the client appends /rerank)"
echo
echo "First request after 30 idle minutes pays a container start plus a model load."
echo "Check state with:  systemctl --user status crucible-embed.socket crucible-embed.service"

# Linger is what keeps user units alive outside a login session. Without it the sockets die when
# the last session closes, which is surprising on a desktop that gets logged out and back in.
if ! loginctl show-user "$USER" --property=Linger 2>/dev/null | grep -q 'Linger=yes'; then
	echo
	echo "NOTE: linger is off for $USER, so these sockets stop when your last session ends."
	echo "      Enable it with:  sudo loginctl enable-linger $USER"
fi
