#!/usr/bin/env bash
# 인터넷이 되는 PC에서 실행한 뒤 linux-server/ 전체를 USB로 옮긴다.
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
WHEELS="${SERVER_DIR}/wheels"
mkdir -p "${WHEELS}" "${SERVER_DIR}/models/checkpoints" \
  "${SERVER_DIR}/models/text_encoders" "${SERVER_DIR}/models/vae" \
  "${SERVER_DIR}/models/loras" "${SERVER_DIR}/models/unet" \
  "${SERVER_DIR}/models/latent_upscale_models" "${SERVER_DIR}/custom_nodes"

python3 -m pip download -d "${WHEELS}" -r "${SERVER_DIR}/requirements-comfy.txt"

if [ ! -d "${SERVER_DIR}/ComfyUI/.git" ] && [ ! -f "${SERVER_DIR}/ComfyUI/main.py" ]; then
  git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git "${SERVER_DIR}/ComfyUI"
fi

clone_node() {
  local url="$1"
  local dest="$2"
  if [ ! -d "${dest}" ]; then
    git clone --depth 1 "${url}" "${dest}"
  fi
}

clone_node https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git \
  "${SERVER_DIR}/custom_nodes/ComfyUI-VideoHelperSuite"
clone_node https://github.com/kijai/ComfyUI-KJNodes.git \
  "${SERVER_DIR}/custom_nodes/ComfyUI-KJNodes"
clone_node https://github.com/city96/ComfyUI-GGUF.git \
  "${SERVER_DIR}/custom_nodes/ComfyUI-GGUF"
clone_node https://github.com/rgthree/rgthree-comfy.git \
  "${SERVER_DIR}/custom_nodes/rgthree-comfy"

echo "모델은 Hugging Face에서 받아 models/ 아래에 두세요. 목록: models/REQUIRED.txt"
echo "예: huggingface-cli download Lightricks/LTX-2.3-fp8 --local-dir ${SERVER_DIR}/models/checkpoints"
echo "collect_online.sh 완료. 이 폴더를 폐쇄망으로 복사하세요."
