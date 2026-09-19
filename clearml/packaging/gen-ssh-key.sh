#!/usr/bin/env bash
# MLOps → 학습 서버 SSH 키 준비 (없을 때만 생성, 공개키 출력)
#
#   사용법:
#     ./gen-ssh-key.sh                # .env 의 TRAINING_SSH_DIR 에 생성
#     ./gen-ssh-key.sh --dir ~/.ssh   # 다른 디렉터리 지정
#
#   출력된 공개키 한 줄을 학습 서버 train.env 의 MLOPS_SSH_PUBLIC_KEY= 뒤에 붙여 넣는다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEARML_DIR="${CLEARML_DIR:-$(dirname "$SCRIPT_DIR")}"
ENV_FILE="${CLEARML_ENV_FILE:-${CLEARML_DIR}/.env}"
KEY_DIR=""

GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'
ok()   { echo -e "  ${GRN}✓${NC} $*"; }
warn() { echo -e "  ${YEL}!${NC} $*"; }
die()  { echo -e "  ${RED}✗ $*${NC}" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --dir)     KEY_DIR="${2:?--dir 값 필요}"; shift ;;
        -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
        *)         die "알 수 없는 옵션: $1" ;;
    esac
    shift
done

if [ -z "$KEY_DIR" ] && [ ! -f "$ENV_FILE" ]; then
    die "${ENV_FILE} 없음 — 먼저 'cp .env.example .env' 후 경로를 수정하거나, --dir 로 키 디렉터리를 지정하세요"
fi
if [ -z "$KEY_DIR" ]; then
    # shellcheck disable=SC1090
    KEY_DIR="$(set -a; . "$ENV_FILE"; echo "${TRAINING_SSH_DIR:-}")"
fi
[ -n "$KEY_DIR" ] || die "키 디렉터리 미지정 — .env 의 TRAINING_SSH_DIR 를 설정하거나 --dir 사용"

# sudo 로 실행하면 키 소유자가 root 가 되어 컨테이너(TRAINING_SSH_UID)가 읽지 못한다
if [ "$(id -u)" = 0 ]; then
    warn "root 로 실행 중 — 학습을 시작시키는 MLOps 계정으로 로그인해서 실행하세요"
fi

KEY="${KEY_DIR}/id_ed25519"
mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

if [ -e "$KEY" ]; then
    ok "기존 키 사용 (덮어쓰지 않음): ${KEY}"
    [ -f "${KEY}.pub" ] || ssh-keygen -y -f "$KEY" > "${KEY}.pub"
else
    # passphrase 없음: 자동 실행 시 입력 요구로 멈추지 않도록
    ssh-keygen -t ed25519 -N '' -f "$KEY" -C "mlops-$(hostname)" >/dev/null
    ok "새 키 생성: ${KEY}"
fi

[ "$(wc -l < "${KEY}.pub")" = 1 ] || die "${KEY}.pub 가 한 줄이 아닙니다"

echo
echo "── 공개키 (학습 서버 train.env 의 MLOPS_SSH_PUBLIC_KEY= 뒤에 한 줄로 붙여 넣기) ──"
cat "${KEY}.pub"
echo
warn "개인키(${KEY})는 절대 공유하지 마세요"
