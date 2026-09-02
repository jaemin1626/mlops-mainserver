# 24GB VRAM 서버용 LTX 2.3 distilled FP8 고정 워크플로
#
# 이 JSON은 ComfyUI API 형식입니다. GUI는 mapping.json의 노드 ID만 치환합니다.
# Linux에 ComfyUI 0.16.1+를 올린 뒤, 템플릿 "LTX-2.3" distilled T2V/I2V를
# 한 번 성공 실행하고 Save (API Format)으로 다시 내보내면 노드 클래스가
# 해당 빌드와 100% 일치합니다. 내보낸 파일로 *_api.json을 교체한 다음
# mapping.json의 노드 번호만 맞추면 됩니다.
#
# 24GB 권장 플래그:
#   python main.py --listen <LAN_IP> --port 8188 --reserve-vram 8
# Gemma 3 12B 텍스트 인코더는 CPU(RAM) 오프로드.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/seoul-studio}"
COMFY_DIR="${INSTALL_ROOT}/ComfyUI"
VENV="${INSTALL_ROOT}/venv"
LISTEN_IP="${LISTEN_IP:-0.0.0.0}"
PORT="${PORT:-8188}"

echo "[seoul-studio] NVIDIA 드라이버 확인"
if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi가 없습니다. 대상 GPU/커널에 맞는 NVIDIA 드라이버를 먼저 설치하세요."
  echo "드라이버는 커널에 묶이므로 이 키트에 포함하지 않습니다."
  exit 1
fi
nvidia-smi

echo "[seoul-studio] 설치 경로 ${INSTALL_ROOT}"
mkdir -p "${INSTALL_ROOT}" "${COMFY_DIR}" "${INSTALL_ROOT}/models"

if [ ! -d "${VENV}" ]; then
  python3 -m venv "${VENV}"
fi
# shellcheck disable=SC1091
. "${VENV}/bin/activate"

WHEELS="${SERVER_DIR}/wheels"
if [ -d "${WHEELS}" ] && [ -n "$(ls -A "${WHEELS}" 2>/dev/null || true)" ]; then
  echo "[seoul-studio] 오프라인 wheels 설치"
  pip install --upgrade pip
  pip install --no-index --find-links "${WHEELS}" -r "${SERVER_DIR}/requirements-comfy.txt"
else
  echo "[seoul-studio] wheels 폴더가 비어 있습니다. 인터넷이 있는 PC에서 collect_online.sh를 먼저 실행하세요."
  exit 1
fi

if [ -d "${SERVER_DIR}/ComfyUI" ] && [ -f "${SERVER_DIR}/ComfyUI/main.py" ]; then
  echo "[seoul-studio] 동봉 ComfyUI 복사"
  rm -rf "${COMFY_DIR}"
  cp -a "${SERVER_DIR}/ComfyUI" "${COMFY_DIR}"
else
  echo "linux-server/ComfyUI 가 없습니다. collect_online.sh가 ComfyUI 소스를 넣어야 합니다."
  exit 1
fi

if [ -d "${SERVER_DIR}/custom_nodes" ]; then
  mkdir -p "${COMFY_DIR}/custom_nodes"
  cp -a "${SERVER_DIR}/custom_nodes/." "${COMFY_DIR}/custom_nodes/"
fi

echo "[seoul-studio] 모델 링크"
if [ -d "${SERVER_DIR}/models" ]; then
  mkdir -p "${COMFY_DIR}/models"
  cp -a "${SERVER_DIR}/models/." "${COMFY_DIR}/models/" 2>/dev/null || true
fi

mkdir -p "${COMFY_DIR}/user/default/workflows/seoul"
cp -a "${ROOT}/workflows/." "${COMFY_DIR}/user/default/workflows/seoul/"

cp "${SERVER_DIR}/extra_model_paths.yaml" "${COMFY_DIR}/extra_model_paths.yaml" 2>/dev/null || true

if [ -d /etc/systemd/system ] && [ "$(id -u)" -eq 0 ]; then
  sed -e "s|@INSTALL_ROOT@|${INSTALL_ROOT}|g" \
      -e "s|@LISTEN_IP@|${LISTEN_IP}|g" \
      -e "s|@PORT@|${PORT}|g" \
      "${SERVER_DIR}/comfyui.service.in" > /etc/systemd/system/seoul-comfyui.service
  systemctl daemon-reload
  systemctl enable seoul-comfyui.service
  echo "[seoul-studio] systemd 유닛 등록: seoul-comfyui.service"
  echo "시작: systemctl start seoul-comfyui"
else
  echo "[seoul-studio] root가 아니면 systemd를 건너뜁니다. start.sh로 실행하세요."
fi

echo "[seoul-studio] 설치 완료"
