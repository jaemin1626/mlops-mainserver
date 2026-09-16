#!/usr/bin/env bash
set -euo pipefail

CLEARML_DIR="${CLEARML_DIR:-/opt/clearml}"
ENV_FILE="${CLEARML_ENV_FILE:-${CLEARML_DIR}/.env}"
GEN_AUTH="${CLEARML_DIR}/packaging/gen-auth.sh"

if [[ -f "$ENV_FILE" ]] && grep -q '^CLEARML_INITIAL_ADMIN_BOOTSTRAPPED=true$' "$ENV_FILE"; then
  echo "초기 관리자 계정은 이미 생성되었습니다."
  exit 0
fi

read -r -p "초기 관리자 사용자명 [admin]: " admin_user
admin_user="${admin_user:-admin}"
read -r -p "관리자 표시 이름 [Intellivix Admin]: " admin_name
admin_name="${admin_name:-Intellivix Admin}"
read -r -s -p "초기 관리자 비밀번호 (비워두면 자동 생성): " admin_password
echo

if [[ -n "$admin_password" ]]; then
  CLEARML_LOGIN_PASSWORD="$admin_password" CLEARML_LOGIN_USER="$admin_user" CLEARML_LOGIN_NAME="$admin_name" bash "$GEN_AUTH"
else
  CLEARML_LOGIN_USER="$admin_user" CLEARML_LOGIN_NAME="$admin_name" bash "$GEN_AUTH"
fi

python3 "${CLEARML_DIR}/packaging/lib/set_env.py" "$ENV_FILE" "CLEARML_INITIAL_ADMIN_BOOTSTRAPPED=true" >/dev/null
chmod 600 "$ENV_FILE"
echo "초기 관리자 계정 설정이 완료되었습니다."
echo "cd ${CLEARML_DIR} && ./compose.sh up -d --no-build --force-recreate apiserver"
echo "주의: ClearML fixed_users에는 첫 로그인 후 비밀번호 변경 API가 없습니다."
