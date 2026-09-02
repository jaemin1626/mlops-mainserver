#!/usr/bin/env bash
# 예전 servers.conf / dataset-mount.env / secrets/.env / monitoring/.env → .env 통합
#
#   bash packaging/migrate-env.sh
set -euo pipefail

CLEARML_DIR="${CLEARML_DIR:-/opt/clearml}"
ENV_FILE="${CLEARML_ENV_FILE:-${CLEARML_DIR}/.env}"
SET_ENV="${CLEARML_DIR}/packaging/lib/set_env.py"

merge_file() {
    local f="$1"
    [ -f "$f" ] || return 0
    echo "  + ${f}"
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            ''|'#'*) continue ;;
            *=*)
                key="${line%%=*}"
                val="${line#*=}"
                case "$key" in
                    CLEARML_HOST_IP) key=CLEARML_SERVER_IP ;;
                esac
                python3 "$SET_ENV" "$ENV_FILE" "${key}=${val}" >/dev/null
                ;;
        esac
    done < "$f"
}

if [ -f "$ENV_FILE" ]; then
    echo "이미 ${ENV_FILE} 있음 — 기존 값 유지, 다른 파일에서 빈 키만 채움"
else
    cp "${CLEARML_DIR}/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
fi

echo "통합 중..."
merge_file "${CLEARML_DIR}/servers.conf"
merge_file "${CLEARML_DIR}/mount/config/dataset-mount.env"
merge_file "${CLEARML_DIR}/secrets/.env"
merge_file "${CLEARML_DIR}/clearml-monitoring/monitoring-deploy/.env"
merge_file "/opt/clearml-monitoring/monitoring-deploy/.env"

bash "${CLEARML_DIR}/packaging/apply-env.sh"
echo "완료: ${ENV_FILE}"
