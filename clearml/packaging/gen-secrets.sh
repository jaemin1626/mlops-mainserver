#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# 서버마다 고유한 ClearML 서명 키를 만든다.
#
#   ClearML 은 기본 설정에 JWT 서명 키가 박혀 있고, 그 값은 GitHub 에 공개돼 있다.
#     apiserver/config/default/secure.conf → auth.token_secret
#
#   이대로 두면 두 가지 문제가 생긴다.
#
#   1. 다른 ClearML 서버가 발급한 토큰이 서명 검증을 통과한다. Mongo 를 새로 만들어도
#      브라우저에 남은 낡은 토큰이 "위조 아님" 판정을 받아서, 401 이 아니라
#      400 (Invalid user) 이 나온다. UI 는 401 에서만 로그인 화면으로 넘기므로
#      헤더와 사이드바가 빠진 껍데기 화면이 남는다.
#   2. 공개된 키를 아는 사람은 누구나 관리자 토큰을 위조할 수 있다.
#
#   이 스크립트는 /opt/clearml/secrets/.env 에 서버 고유 키를 넣는다. compose.sh 가
#   apiserver 와 fileserver 에 넘긴다. 키는 번들에 포함되지 않으므로 서버마다 달라진다.
#
#   사용법:
#     ./gen-secrets.sh            # 없을 때만 생성 (있으면 그대로 둠)
#     ./gen-secrets.sh --rotate   # 기존 값을 새로 갈아엎음 (전원 재로그인 필요)
#     ./gen-secrets.sh --show     # 현재 상태만 확인
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEARML_DIR="${CLEARML_DIR:-/opt/clearml}"
ENV_FILE="${CLEARML_ENV_FILE:-${CLEARML_DIR}/secrets/.env}"

# ClearML 문서가 권장하는 길이는 50~60자
SECRET_LEN=56
KEYS=(CLEARML_TOKEN_SECRET CLEARML_SESSION_SECRET)

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
        -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
        *) die "알 수 없는 옵션: $1" ;;
    esac
    shift
done

# head 가 파이프를 닫으면 tr 이 SIGPIPE 로 죽는다. pipefail 을 이 안에서만 끈다.
gen_secret() {
    ( set +o pipefail
      LC_ALL=C tr -dc 'A-Za-z0-9_-' < /dev/urandom | head -c "$SECRET_LEN" )
}

read_key() {  # <키>
    [ -f "$ENV_FILE" ] || return 0
    sed -n "s/^$1=//p" "$ENV_FILE" | head -1
}

if [ "$SHOW_ONLY" = 1 ]; then
    step "현재 서명 키 상태 (${ENV_FILE})"
    for k in "${KEYS[@]}"; do
        v="$(read_key "$k")"
        if [ -n "$v" ]; then
            ok "${k}  설정됨 (${#v}자, ${v:0:6}…)"
        else
            warn "${k}  비어 있음 — ClearML 기본 공개 키를 쓰게 됩니다"
        fi
    done
    exit 0
fi

step "서버 고유 서명 키 생성"

UPDATES=()
for k in "${KEYS[@]}"; do
    cur="$(read_key "$k")"
    if [ -n "$cur" ] && [ "$ROTATE" = 0 ]; then
        ok "${k}  이미 있음 — 유지 (바꾸려면 --rotate)"
        continue
    fi
    UPDATES+=("${k}=$(gen_secret)")
    [ -n "$cur" ] && warn "${k}  교체함" || ok "${k}  새로 만듦"
done

if [ "${#UPDATES[@]}" -eq 0 ]; then
    echo
    echo "  바뀐 것 없음."
    exit 0
fi

[ -f "$ENV_FILE" ] && cp -a "$ENV_FILE" "${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
python3 "${SCRIPT_DIR}/lib/set_env.py" "$ENV_FILE" "${UPDATES[@]}" >/dev/null
mkdir -p "$(dirname "$ENV_FILE")"
chmod 700 "$(dirname "$ENV_FILE")"
chmod 600 "$ENV_FILE"
ok "${ENV_FILE} (권한 600)"

step "적용"
echo "  apiserver 와 fileserver 를 다시 만들어야 반영됩니다."
echo "    cd ${CLEARML_DIR} && ./compose.sh up -d --no-build --force-recreate apiserver fileserver"
echo
warn "적용 즉시 기존 로그인 세션이 전부 무효가 됩니다. 브라우저에서 다시 로그인하면 됩니다."
echo "         SDK·agent 의 access_key/secret_key 는 영향 없습니다 (토큰만 다시 발급받습니다)."
