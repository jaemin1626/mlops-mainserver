#!/usr/bin/env bash
# ClearML docker compose wrapper — secrets/.env 를 자동으로 읽는다.
#
#   cd /opt/clearml && ./compose.sh up -d
#   ./compose.sh ps
#   ./compose.sh logs -f webserver
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${CLEARML_ENV_FILE:-${ROOT}/secrets/.env}"
COMPOSE_PROJECT="${CLEARML_PROJECT:-clearml}"

if [ ! -f "$ENV_FILE" ]; then
    echo "오류: ${ENV_FILE} 없음" >&2
    echo "  bash packaging/gen-secrets.sh && bash packaging/apply-servers.sh" >&2
    exit 1
fi

exec docker compose -p "$COMPOSE_PROJECT" --env-file "$ENV_FILE" -f "${ROOT}/docker-compose.yml" "$@"
