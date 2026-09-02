#!/usr/bin/env bash
# MLOps 한 번에 기동
#
#   start.sh 하나로 아래를 순서대로 실행합니다 (마운트 실패해도 MLOps 는 기동):
#     1. nfs-common 설치 (없으면)
#     2. Dataset NFS 마운트 (dataset-mount.env)
#     3. .env 생성·갱신
#     4. docker compose up
#     5. data-studio 재기동 (마운트 경로 반영)
#
#   사용자 설정:
#     .env  ← 모든 설정 (cp .env.example .env)
#
#   사용:
#     bash /opt/clearml/start.sh
#     bash /opt/clearml/start.sh --no-mount
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKIP_MOUNT=0

while [ $# -gt 0 ]; do
    case "$1" in
        --no-mount) SKIP_MOUNT=1 ;;
        -h|--help)
            sed -n '2,18p' "$0"
            exit 0
            ;;
        *) echo "unknown option: $1" >&2; exit 1 ;;
    esac
    shift
done

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; BLU=$'\033[0;34m'; NC=$'\033[0m'
step() { echo -e "\n${BLU}▶ $*${NC}"; }
ok()   { echo -e "  ${GRN}✓${NC} $*"; }
warn() { echo -e "  ${YEL}!${NC} $*"; }

run_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        sudo "$@"
    fi
}

# ── 1/4 Dataset 마운트 (Data Studio) ─────────────────────────────────────
step "1/4 Dataset mount (실패해도 다음 단계 진행)"
if [ "$SKIP_MOUNT" = 1 ]; then
    echo "  skipped (--no-mount)"
else
    bash "${ROOT}/mount/scripts/mount_dataset.sh" mount || true
fi

# ── 2/4 .env (서명 키 · 주소 · 파생 URL) ─────────────────────────────────
step "2/4 환경 설정 (.env)"
if [ ! -f "${ROOT}/.env" ]; then
    if [ -f "${ROOT}/.env.example" ]; then
        cp "${ROOT}/.env.example" "${ROOT}/.env"
        chmod 600 "${ROOT}/.env"
    fi
    bash "${ROOT}/packaging/migrate-env.sh" 2>/dev/null || true
fi

if [ ! -f "${ROOT}/.env" ] || ! grep -qE '^CLEARML_TOKEN_SECRET=.' "${ROOT}/.env" 2>/dev/null; then
    bash "${ROOT}/packaging/gen-secrets.sh"
fi
bash "${ROOT}/packaging/gen-auth.sh" >/dev/null
bash "${ROOT}/packaging/apply-env.sh"
ok ".env 준비"

# ── 3/4 Docker Compose ───────────────────────────────────────────────────
step "3/4 MLOps docker compose up"
cd "${ROOT}"
./compose.sh up -d
ok "compose up 완료"

# ── 4/4 Data Studio 마운트 경로 반영 ─────────────────────────────────────
step "4/4 Data Studio 재기동 (Dataset bind mount 반영)"
./compose.sh up -d --force-recreate data-studio
ok "data-studio ready"

# ── 결과 요약 ────────────────────────────────────────────────────────────
HOST_IP="$(grep '^CLEARML_HOST_IP=' "${ROOT}/.env" 2>/dev/null | cut -d= -f2- || echo '?')"
DATASET_PATH="$(grep '^DATASET_EXPORT_PATH=' "${ROOT}/.env" 2>/dev/null | cut -d= -f2- || echo '?')"

echo ""
echo "=================================================="
echo "  ClearML UI  : http://${HOST_IP}:8080"
echo "  Data Studio : http://${HOST_IP}:8080/data-studio/"
echo "  Dataset path: ${DATASET_PATH}"
echo "=================================================="
bash "${ROOT}/mount/scripts/mount_dataset.sh" status 2>/dev/null || true
