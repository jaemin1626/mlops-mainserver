#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# ClearML 웹 로그인 고정 계정 (fixed users) 설정
#
#   기본값으로는 누구나 아무 이름으로 가입·로그인 가능하다.
#   이 스크립트는 /opt/clearml/config/apiserver.conf 를 만들어
#   .env 에 지정한 계정만 로그인되게 한다.
#
#   사용법:
#     ./gen-auth.sh              # .env 에 계정 없으면 admin + 랜덤 비밀번호 생성
#     ./gen-auth.sh --show       # 현재 계정·설정 상태만 출력 (비밀번호 마스킹)
#     ./gen-auth.sh --rotate     # 비밀번호 새로 생성
#
#   수동 지정 (한 번만):
#     CLEARML_LOGIN_USER=admin CLEARML_LOGIN_PASSWORD='비밀번호' ./gen-auth.sh
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEARML_DIR="${CLEARML_DIR:-/opt/clearml}"
ENV_FILE="${CLEARML_ENV_FILE:-${CLEARML_DIR}/.env}"
CONF_DIR="${CLEARML_DIR}/config"
CONF_FILE="${CONF_DIR}/apiserver.conf"

ROTATE=0
SHOW_ONLY=0

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; BLU=$'\033[0;34m'; NC=$'\033[0m'
step() { echo -e "\n${BLU}▶ $*${NC}"; }
ok()   { echo -e "  ${GRN}✓${NC} $*"; }
warn() { echo -e "  ${YEL}!${NC} $*"; }
die()  { echo -e "  ${RED}✗ $*${NC}" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --rotate) ROTATE=1 ;;
        --show)   SHOW_ONLY=1 ;;
        -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
        *) die "알 수 없는 옵션: $1" ;;
    esac
    shift
done

read_key() {
    [ -f "$ENV_FILE" ] || return 0
    sed -n "s/^$1=//p" "$ENV_FILE" | head -1
}

gen_password() {
    python3 - <<'PY'
import secrets
import string
alphabet = string.ascii_letters + string.digits + "_@-+"
print("".join(secrets.choice(alphabet) for _ in range(20)), end="")
PY
}

if [ "$SHOW_ONLY" = 1 ]; then
    step "로그인 고정 계정 (${ENV_FILE})"
    u="$(read_key CLEARML_LOGIN_USER)"
    p="$(read_key CLEARML_LOGIN_PASSWORD)"
    n="$(read_key CLEARML_LOGIN_NAME)"
    if [ -n "$u" ] && [ -n "$p" ]; then
        ok "CLEARML_LOGIN_USER=${u}"
        ok "CLEARML_LOGIN_NAME=${n:-Intellivix Admin}"
        ok "CLEARML_LOGIN_PASSWORD=******** (${#p}자)"
    else
        warn "로그인 계정 미설정 — ./gen-auth.sh 실행 필요"
    fi
    if [ -f "$CONF_FILE" ]; then
        ok "${CONF_FILE} 존재"
    else
        warn "${CONF_FILE} 없음"
    fi
    exit 0
fi

step "ClearML fixed users 로그인 설정"

USER="${CLEARML_LOGIN_USER:-$(read_key CLEARML_LOGIN_USER)}"
NAME="${CLEARML_LOGIN_NAME:-$(read_key CLEARML_LOGIN_NAME)}"
PASS="${CLEARML_LOGIN_PASSWORD:-$(read_key CLEARML_LOGIN_PASSWORD)}"

[ -n "$USER" ] || USER="admin"
[ -n "$NAME" ] || NAME="Intellivix Admin"

if [ -n "$PASS" ] && [ "$ROTATE" = 0 ] && [ -z "${CLEARML_LOGIN_PASSWORD:-}" ]; then
    ok "기존 CLEARML_LOGIN_PASSWORD 유지"
else
    PASS="${CLEARML_LOGIN_PASSWORD:-$(gen_password)}"
    [ -f "$ENV_FILE" ] && cp -a "$ENV_FILE" "${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$(dirname "$ENV_FILE")"
    python3 "${SCRIPT_DIR}/lib/set_env.py" "$ENV_FILE" \
        "CLEARML_LOGIN_USER=${USER}" \
        "CLEARML_LOGIN_NAME=${NAME}" \
        "CLEARML_LOGIN_PASSWORD=${PASS}" >/dev/null
    chmod 700 "$(dirname "$ENV_FILE")"
    chmod 600 "$ENV_FILE"
    ok ".env 에 로그인 계정 저장 (권한 600)"
fi

mkdir -p "$CONF_DIR"
python3 - "$CONF_FILE" "$USER" "$PASS" "$NAME" <<'PY'
import sys

out_path, user, password, name = sys.argv[1:5]

def hocon_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')

content = f"""# ClearML fixed users — packaging/gen-auth.sh 로 생성·갱신
# 비밀번호 원본: /opt/clearml/.env (CLEARML_LOGIN_PASSWORD)

auth {{
    fixed_users {{
        enabled: true
        pass_hashed: false
        users: [
            {{
                username: "{hocon_escape(user)}"
                password: "{hocon_escape(password)}"
                name: "{hocon_escape(name)}"
            }}
        ]
    }}
}}
"""

with open(out_path, "w", encoding="utf-8") as fh:
    fh.write(content)
PY

chmod 600 "$CONF_FILE"
ok "${CONF_FILE} 생성 (권한 600)"

step "적용"
echo "  apiserver 재기동:"
echo "    cd ${CLEARML_DIR} && ./compose.sh up -d --no-build --force-recreate apiserver"
echo
echo "  로그인 계정"
echo "    사용자: ${USER}"
echo "    비밀번호: ${PASS}"
warn "위 비밀번호는 .env 에도 저장됩니다. 안전한 곳에 보관하세요."
warn "기존에 임의 이름으로 만든 계정은 UI(Administration → Users)에서 정리할 수 있습니다."
