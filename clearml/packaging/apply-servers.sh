#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# servers.conf 의 주소를 각 설정 파일에 반영한다.
#
#   주소가 여러 파일에 흩어져 있어서 이관할 때마다 하나씩 빠뜨리게 된다.
#   servers.conf 를 단일 원본으로 두고 이 스크립트가 아래에 뿌린다.
#
#     /opt/clearml/secrets/.env                    (compose 변수)
#     monitoring-deploy/.env                       (exporter · grafana)
#
#   packaging/install.sh · packaging/pack.sh 는 실행할 때
#   servers.conf 를 직접 읽거나 CLEARML_DIR 기준으로 동작한다.
#
#   자격증명(API 키·비밀번호·토큰)은 건드리지 않는다.
#
#   사용법:
#     ./apply-servers.sh              # 반영만
#     ./apply-servers.sh --restart    # 반영 후 스택 재기동
#     ./apply-servers.sh --check      # 아무것도 바꾸지 않고 차이만 확인
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CLEARML_DIR="${CLEARML_DIR:-/opt/clearml}"
MONITORING_DIR="${MONITORING_DIR:-/opt/clearml-monitoring/monitoring-deploy}"
SERVERS_CONF="${SERVERS_CONF:-${CLEARML_DIR}/servers.conf}"
CLEARML_ENV_FILE="${CLEARML_ENV_FILE:-${CLEARML_DIR}/secrets/.env}"

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
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *)         die "알 수 없는 옵션: $1" ;;
    esac
    shift
done

[ -f "$SERVERS_CONF" ] || die "${SERVERS_CONF} 없음"
# shellcheck disable=SC1090
. "$SERVERS_CONF"

: "${CLEARML_SERVER_IP:?servers.conf 에 CLEARML_SERVER_IP 가 없습니다}"
MONITORING_SERVER_IP="${MONITORING_SERVER_IP:-$CLEARML_SERVER_IP}"

MOUNT_ENV="${MOUNT_ENV:-${CLEARML_DIR}/mount/config/dataset-mount.env}"
DATASET_EXPORT_PATH="/opt/clearml/data/datasets"
if [ -f "$MOUNT_ENV" ]; then
    # shellcheck disable=SC1090
    . "$MOUNT_ENV"
    DATASET_EXPORT_PATH="${HOST_DATASET_PATH:-${LOCAL_MOUNT_PATH:-/opt/clearml/data/datasets}}"
fi

WEB_URL="http://${CLEARML_SERVER_IP}:${CLEARML_WEB_PORT:-8080}"
API_URL="http://${CLEARML_SERVER_IP}:${CLEARML_API_PORT:-8008}"
FILES_URL="http://${CLEARML_SERVER_IP}:${CLEARML_FILES_PORT:-8081}"

# 모니터링이 ClearML 과 같은 서버면 컨테이너에서 host.docker.internal 로 붙는 게
# 방화벽·바인딩 영향을 안 받아서 안전하다.
if [ "$MONITORING_SERVER_IP" = "$CLEARML_SERVER_IP" ]; then
    EXPORTER_API_URL="http://host.docker.internal:${CLEARML_API_PORT:-8008}"
else
    EXPORTER_API_URL="$API_URL"
fi

step "servers.conf 읽음: ${SERVERS_CONF}"
echo "    ClearML     : ${WEB_URL}  (api ${CLEARML_API_PORT:-8008}, files ${CLEARML_FILES_PORT:-8081})"
echo "    모니터링    : http://${MONITORING_SERVER_IP}:${GRAFANA_PORT:-3000}  (grafana)"
echo "    학습 서버   : ${TRAINING_SERVER_USER:-user}@${TRAINING_SERVER_IP:-미설정}"
echo "    exporter→API: ${EXPORTER_API_URL}"

if [ "$CHECK_ONLY" = 1 ]; then
    step "현재 설정과 비교"
    for f in "${CLEARML_ENV_FILE}" "${MONITORING_DIR}/.env"; do
        echo "  ${f}"
        if [ -f "$f" ]; then
            grep -nE '^(CLEARML_HOST_IP|CLEARML_WEB_HOST|CLEARML_FILES_HOST|SERVER_HOST|CLEARML_API_HOST|EXPORTER_PORT|PROMETHEUS_PORT|GRAFANA_PORT|TAGGING_TOOL_URL|GITLAB_URL|GITLAB_PROJECT_IDS)=' "$f" \
                | sed 's/^/      /' || echo "      (해당 키 없음)"
        else
            echo "      (파일 없음)"
        fi
    done
    exit 0
fi

backup() {
    [ -f "$1" ] || return 0
    cp -a "$1" "$1.bak-$(date +%Y%m%d-%H%M%S)"
}

step "1/2 ${CLEARML_ENV_FILE}"
backup "${CLEARML_ENV_FILE}"
mkdir -p "$(dirname "${CLEARML_ENV_FILE}")"
chmod 700 "$(dirname "${CLEARML_ENV_FILE}")"
python3 "${SCRIPT_DIR}/lib/set_env.py" "${CLEARML_ENV_FILE}" \
    "CLEARML_HOST_IP=${CLEARML_SERVER_IP}" \
    "CLEARML_WEB_HOST=${WEB_URL}" \
    "CLEARML_FILES_HOST=${FILES_URL}" \
    "DATASET_EXPORT_PATH=${DATASET_EXPORT_PATH:-/export/Dataset}"
chmod 600 "${CLEARML_ENV_FILE}"   # 서명 키가 같이 들어 있다
ok "반영 완료"

if ! grep -qE '^CLEARML_TOKEN_SECRET=.' "${CLEARML_ENV_FILE}"; then
    warn "CLEARML_TOKEN_SECRET 이 비어 있습니다 — ${SCRIPT_DIR}/gen-secrets.sh 를 먼저 실행하세요"
fi

step "2/2 ${MONITORING_DIR}/.env"
backup "${MONITORING_DIR}/.env"
python3 "${SCRIPT_DIR}/lib/set_env.py" "${MONITORING_DIR}/.env" \
    "SERVER_HOST=${MONITORING_SERVER_IP}" \
    "CLEARML_API_HOST=${EXPORTER_API_URL}" \
    "EXPORTER_PORT=${EXPORTER_PORT:-9090}" \
    "PROMETHEUS_PORT=${PROMETHEUS_PORT:-9091}" \
    "GRAFANA_PORT=${GRAFANA_PORT:-3000}" \
    "TAGGING_TOOL_URL=${TAGGING_TOOL_URL:-}" \
    "GITLAB_URL=${GITLAB_URL:-}" \
    "GITLAB_PROJECT_IDS=${GITLAB_PROJECT_IDS:-}"
ok "반영 완료 (API 키·비밀번호·토큰은 건드리지 않음)"

# ── 남아 있는 다른 IP 찾기 ────────────────────────────────────────────────
step "설정 파일에 남은 다른 주소 확인"
KNOWN="${CLEARML_SERVER_IP}|${MONITORING_SERVER_IP}|${TRAINING_SERVER_IP:-0.0.0.0}|127\.0\.0\.[0-9]+|0\.0\.0\.0"
STRAY=$(grep -rhoE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' \
    "${MONITORING_DIR}/.env" "${CLEARML_ENV_FILE}" "$SERVERS_CONF" 2>/dev/null \
    | sort -u | grep -vE "^(${KNOWN})$" || true)
if [ -n "$STRAY" ]; then
    warn "servers.conf 에 없는 주소가 남아 있습니다 (외부 서비스면 정상):"
    echo "$STRAY" | sed 's/^/         /'
else
    ok "모두 servers.conf 기준값"
fi

if [ "$DO_RESTART" = 1 ]; then
    step "스택 재기동"
    (cd "$CLEARML_DIR"    && ./compose.sh up -d --no-build)
    (cd "$MONITORING_DIR" && docker compose -p "$MONITORING_PROJECT" up -d --no-build)
    ok "완료"
else
    step "다음 단계"
    echo "  변경된 값을 적용하려면 재기동이 필요합니다:"
    echo "    cd ${CLEARML_DIR}    && ./compose.sh up -d --no-build"
    echo "    cd ${MONITORING_DIR} && docker compose -p ${MONITORING_PROJECT} up -d --no-build"
    echo "  또는  $0 --restart"
fi
