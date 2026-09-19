#!/usr/bin/env bash
# MLOps 서버에서 학습 서버 쪽 세팅(키 등록, NFS export)을 SSH 로 대신 수행한다.
#
#   사용법:
#     ./bootstrap-training-server.sh key            # 공개키 등록 (학습 서버 비밀번호 1회 입력)
#     ./bootstrap-training-server.sh nfs            # train.env 값 채우기 + export_dataset.sh setup (sudo 비밀번호 입력)
#     ./bootstrap-training-server.sh all            # key → nfs
#     ./bootstrap-training-server.sh hostkey        # 학습 서버 호스트 키만 known_hosts 에 등록 (지문 확인 후 y)
#     ./bootstrap-training-server.sh nfs --dry-run  # 학습 서버에서 실행할 명령만 출력
#
#   필요한 값은 모두 .env 에서 읽는다 (TRAINING_SSH_*, TRAINING_ROOT, MLOPS_ROOT, CLEARML_SERVER_IP).
#   비밀번호는 저장하지 않고 ssh 가 직접 물어본다 → 터미널에서 실행해야 한다.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEARML_DIR="${CLEARML_DIR:-$(dirname "$SCRIPT_DIR")}"
ENV_FILE="${CLEARML_ENV_FILE:-${CLEARML_DIR}/.env}"

GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'
ok()   { echo -e "  ${GRN}✓${NC} $*"; }
warn() { echo -e "  ${YEL}!${NC} $*"; }
die()  { echo -e "  ${RED}✗ $*${NC}" >&2; exit 1; }

MODE="${1:-all}"; shift || true
DRY=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1; done
case "$MODE" in key|nfs|all|hostkey) ;; -h|--help) sed -n '2,13p' "$0"; exit 0 ;; *) die "사용법: $0 key|nfs|all|hostkey [--dry-run]" ;; esac

[ -f "$ENV_FILE" ] || die "${ENV_FILE} 없음"
# shellcheck disable=SC1090
eval "$(set -a; . "$ENV_FILE"; for v in TRAINING_SSH_HOST TRAINING_SERVER_IP TRAINING_SSH_USER TRAINING_SSH_PORT \
    TRAINING_SSH_DIR TRAINING_ROOT MLOPS_ROOT CLEARML_SERVER_IP; do printf '%s=%q\n' "$v" "${!v:-}"; done)"
HOST="${TRAINING_SSH_HOST:-$TRAINING_SERVER_IP}"; USER_="$TRAINING_SSH_USER"; PORT="${TRAINING_SSH_PORT:-22}"
KEY="${TRAINING_SSH_DIR}/id_ed25519"; KNOWN="${TRAINING_SSH_DIR}/known_hosts"
[ -n "$HOST" ] && [ -n "$USER_" ] || die ".env 에 TRAINING_SSH_HOST(또는 TRAINING_SERVER_IP), TRAINING_SSH_USER 필요"
[ -e "$KEY" ] || die "SSH 키 없음 — 먼저 bash packaging/gen-ssh-key.sh"
[ -t 0 ] || [ "$DRY" = 1 ] || die "비밀번호 입력이 필요해 터미널(tty)에서만 실행할 수 있습니다"

ssh_opts=(-p "$PORT" -o UserKnownHostsFile="$KNOWN" -o StrictHostKeyChecking=yes -o ConnectTimeout=8)

key_works() {
    timeout 15 ssh -i "$KEY" "${ssh_opts[@]}" -o BatchMode=yes -o IdentitiesOnly=yes "${USER_}@${HOST}" true >/dev/null 2>&1
}

ensure_host_key() {
    ssh-keygen -F "$HOST" -f "$KNOWN" >/dev/null 2>&1 && return 0
    warn "${HOST} 의 호스트 키가 known_hosts 에 없습니다"
    local scan; scan="$(ssh-keyscan -p "$PORT" -t ed25519,ecdsa,rsa "$HOST" 2>/dev/null)" || true
    [ -n "$scan" ] || die "${HOST}:${PORT} 에서 호스트 키를 가져오지 못했습니다 (학습 서버 sshd 확인)"
    echo "      서버가 제시한 지문 (학습 서버에서 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub' 결과와 비교):"
    echo "$scan" | ssh-keygen -lf - | sed 's/^/        /'
    if [ "$DRY" = 1 ]; then warn "[dry-run] known_hosts 등록은 건너뜀"; return 0; fi
    read -r -p "  이 서버가 맞으면 y > " yn
    [ "$yn" = y ] || die "호스트 키 등록을 취소했습니다"
    mkdir -p "$(dirname "$KNOWN")"
    ssh-keyscan -H -p "$PORT" -t ed25519,ecdsa,rsa "$HOST" 2>/dev/null >> "$KNOWN"
    chmod 644 "$KNOWN"; ok "known_hosts 에 등록"
}

do_key() {
    echo "▶ 공개키 등록: ${USER_}@${HOST}"
    ensure_host_key
    if [ "$DRY" = 0 ] && key_works; then ok "이미 키로 접속됩니다 — 등록 불필요"; return 0; fi
    echo "      실행: ssh-copy-id -i ${KEY}.pub ${USER_}@${HOST}  (학습 서버 ${USER_} 계정 비밀번호를 물어봅니다)"
    [ "$DRY" = 1 ] && return 0
    ssh-copy-id -i "${KEY}.pub" "${ssh_opts[@]}" "${USER_}@${HOST}" || die "ssh-copy-id 실패"
    key_works && ok "키로 접속 확인" || die "등록했지만 키 접속이 안 됩니다 (학습 서버 홈/.ssh 권한 확인)"
}

do_nfs() {
    echo "▶ 학습 서버 NFS export 세팅: ${USER_}@${HOST}:${TRAINING_ROOT}"
    [ -n "$TRAINING_ROOT" ] && [ -n "$MLOPS_ROOT" ] && [ -n "$CLEARML_SERVER_IP" ] || die ".env 에 TRAINING_ROOT, MLOPS_ROOT, CLEARML_SERVER_IP 필요"
    local remote
    remote="$(cat <<R
set -e
cd $(printf '%q' "$TRAINING_ROOT")
f=mount/config/train.env
[ -f "\$f" ] || cp mount/config/train.env.example "\$f"
setv() { if grep -q "^\$1=" "\$f"; then sed -i "s|^\$1=.*|\$1=\$2|" "\$f"; else echo "\$1=\$2" >> "\$f"; fi; }
setv MLOPS_SERVER_IP $(printf '%q' "$CLEARML_SERVER_IP")
setv MLOPS_ROOT_PATH $(printf '%q' "$MLOPS_ROOT")
sudo ./mount/scripts/export_dataset.sh setup
./mount/scripts/export_dataset.sh status
R
)"
    if [ "$DRY" = 1 ]; then echo "      학습 서버에서 실행될 내용:"; echo "$remote" | sed 's/^/        /'; return 0; fi
    key_works || die "키로 접속이 안 됩니다 — 먼저: $0 key"
    echo "      (sudo 비밀번호를 물어보면 학습 서버 ${USER_} 계정 비밀번호를 입력하세요)"
    ssh -t -i "$KEY" "${ssh_opts[@]}" -o IdentitiesOnly=yes "${USER_}@${HOST}" "bash -c $(printf '%q' "$remote")" \
        || die "학습 서버 세팅 실패 — 출력 확인"
    ok "학습 서버 NFS export 완료"
}

case "$MODE" in
    hostkey) ensure_host_key ;;
    key) do_key ;;
    nfs) do_nfs ;;
    all) do_key; do_nfs ;;
esac
