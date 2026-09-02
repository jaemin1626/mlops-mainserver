#!/usr/bin/env bash
set -euo pipefail
INSTALL_ROOT="${INSTALL_ROOT:-/opt/seoul-studio}"
LISTEN_IP="${LISTEN_IP:-0.0.0.0}"
PORT="${PORT:-8188}"
cd "${INSTALL_ROOT}/ComfyUI"
exec "${INSTALL_ROOT}/venv/bin/python" main.py \
  --listen "${LISTEN_IP}" \
  --port "${PORT}" \
  --reserve-vram 8 \
  --disable-auto-launch
