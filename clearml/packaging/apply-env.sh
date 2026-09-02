#!/usr/bin/env bash
# .env 한 파일에서 파생 URL·경로를 계산해 같은 .env 에 반영한다.
#
#   사용법:
#     ./apply-env.sh
#     ./apply-env.sh --restart
#     ./apply-env.sh --check
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEARML_DIR="${CLEARML_DIR:-/opt/clearml}"
ENV_FILE="${CLEARML_ENV_FILE:-${CLEARML_DIR}/.env}"
MONITORING_DIR="${MONITORING_DIR:-/opt/clearml-monitoring/monitoring-deploy}"
CLEARML_PROJECT="${CLEARML_PROJECT:-clearml}"
MONITORING_PROJECT="${MONITORING_PROJECT:-monitoring-deploy}"

DO_RESTART=0
CHECK_ONLY=0

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; BLU=$'\033[0;34m'; NC=$'\033[0m'
step() { echo -e "\n${BLU}▶ $*${NC}"; }
ok()   { echo -e "  ${GRN}✓${NC} $*"; }
warn() { echo -e "  ${YEL}!${NC} $*"; }
die()  { echo -e "  ${RED}✗ $*${NC}" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --restart) DO_RESTART=1 ;;
        --check)   CHECK_ONLY=1 ;;
        -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
        *)         die "알 수 없는 옵션: $1" ;;
    esac
    shift
done

[ -f "$ENV_FILE" ] || die "${ENV_FILE} 없음 — cp .env.example .env 후 수정하세요"

# shellcheck disable=SC1090
. "$ENV_FILE"

: "${CLEARML_SERVER_IP:?${ENV_FILE} 에 CLEARML_SERVER_IP 필요}"

MONITORING_SERVER_IP="${MONITORING_SERVER_IP:-$CLEARML_SERVER_IP}"
HOST_DATASET_PATH="${HOST_DATASET_PATH:-/opt/clearml/data/datasets}"

WEB_URL="http://${CLEARML_SERVER_IP}:${CLEARML_WEB_PORT:-8080}"
API_URL="http://${CLEARML_SERVER_IP}:${CLEARML_API_PORT:-8008}"
FILES_URL="http://${CLEARML_SERVER_IP}:${CLEARML_FILES_PORT:-8081}"

if [ "$MONITORING_SERVER_IP" = "$CLEARML_SERVER_IP" ]; then
    EXPORTER_API_URL="http://host.docker.internal:${CLEARML_API_PORT:-8008}"
else
    EXPORTER_API_URL="$API_URL"
fi

step ".env 읽음: ${ENV_FILE}"
echo "    ClearML     : ${WEB_URL}"
echo "    모니터링    : http://${MONITORING_SERVER_IP}:${GRAFANA_PORT:-3000}"
echo "    Dataset NFS : ${TRAINING_SERVER_IP:-?}:${TRAINING_DATASET_PATH:-?} → ${HOST_DATASET_PATH}"
echo "    exporter→API: ${EXPORTER_API_URL}"

if [ "$CHECK_ONLY" = 1 ]; then
    grep -nE '^(CLEARML_HOST_IP|CLEARML_WEB_HOST|CLEARML_FILES_HOST|DATASET_EXPORT_PATH|CLEARML_API_HOST|SERVER_HOST)=' "$ENV_FILE" \
        | sed 's/^/      /' || echo "      (파생 키 없음 — apply-env 실행 필요)"
    exit 0
fi

cp -a "$ENV_FILE" "${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true

python3 "${SCRIPT_DIR}/lib/set_env.py" "$ENV_FILE" \
    "CLEARML_HOST_IP=${CLEARML_SERVER_IP}" \
    "CLEARML_WEB_HOST=${WEB_URL}" \
    "CLEARML_FILES_HOST=${FILES_URL}" \
    "DATASET_EXPORT_PATH=${HOST_DATASET_PATH}" \
    "CLEARML_API_HOST=${EXPORTER_API_URL}" \
    "SERVER_HOST=${MONITORING_SERVER_IP}" \
    "EXPORTER_PORT=${EXPORTER_PORT:-9090}" \
    "PROMETHEUS_PORT=${PROMETHEUS_PORT:-9091}" \
    "GRAFANA_PORT=${GRAFANA_PORT:-3000}" \
    "TAGGING_TOOL_URL=${TAGGING_TOOL_URL:-}" \
    "GITLAB_URL=${GITLAB_URL:-}" \
    "GITLAB_PROJECT_IDS=${GITLAB_PROJECT_IDS:-}"

chmod 600 "$ENV_FILE"
ok "파생 값 반영 완료 (자격증명은 그대로)"

if [ "$DO_RESTART" = 1 ]; then
    step "스택 재기동"
    (cd "$CLEARML_DIR" && ./compose.sh up -d --no-build)
    (cd "$CLEARML_DIR" && ./monitoring-compose.sh up -d --no-build)
    ok "완료"
else
    echo "  재기동: packaging/apply-env.sh --restart"
fi
