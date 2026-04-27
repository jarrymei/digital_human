#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="$ROOT_DIR/upstream"

bash "$ROOT_DIR/scripts/check_assets.sh"

cd "$UPSTREAM_DIR"

exec python3 app.py \
  --transport webrtc \
  --model wav2lip \
  --avatar_id wav2lip256_avatar1 \
  --listenport 8010

