#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="$ROOT_DIR/upstream"

MODEL_FILE="$UPSTREAM_DIR/models/wav2lip.pth"
AVATAR_DIR="$UPSTREAM_DIR/data/avatars/wav2lip256_avatar1"

missing=0

if [[ -f "$MODEL_FILE" ]]; then
  echo "[ok] $MODEL_FILE"
else
  echo "[missing] $MODEL_FILE"
  missing=1
fi

if [[ -d "$AVATAR_DIR" ]]; then
  echo "[ok] $AVATAR_DIR"
else
  echo "[missing] $AVATAR_DIR"
  missing=1
fi

if [[ "$missing" -ne 0 ]]; then
  echo
  echo "LiveTalking 资产还没准备齐。请按 README 下载 wav2lip 权重和 wav2lip256_avatar1。"
  exit 1
fi

echo
echo "LiveTalking 关键资产已准备齐，可以启动 wav2lip WebRTC 实验。"

