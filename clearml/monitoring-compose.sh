#!/usr/bin/env bash
# Monitoring docker compose — ClearML 과 같은 .env 사용
#
#   cd /opt/clearml && ./monitoring-compose.sh up -d
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${CLEARML_ENV_FILE:-${ROOT}/.env}"
MON_DIR="${MONITORING_DIR:-${ROOT}/clearml-monitoring/monitoring-deploy}"
PROJECT="${MONITORING_PROJECT:-monitoring-deploy}"

if [ ! -f "$ENV_FILE" ]; then
    echo "오류: ${ENV_FILE} 없음" >&2
    echo "  cp .env.example .env && bash packaging/migrate-env.sh" >&2
    exit 1
fi

exec docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "${MON_DIR}/docker-compose.yml" "$@"
