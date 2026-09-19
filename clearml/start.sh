#!/usr/bin/env bash
# MLOps 한 번에 기동
#
#   start.sh 하나로 아래를 순서대로 실행합니다 (마운트 실패해도 MLOps 는 기동):
#     1. .env 생성·갱신
#     2. 학습 서버 SSH 키 생성 (새로 만들면 학습 서버 세팅 안내 후 대기)
#     3. NFS 마운트 (Dataset · 생성형 결과)
#     4. docker compose up
#     5. data-studio · seoul-studio 재기동 (마운트 경로 반영)
#     6. Grafana 모니터링 (.env 반영, --force-recreate)
#
#   사용:
#     bash /opt/clearml/start.sh
#     bash /opt/clearml/start.sh --no-mount
#     bash /opt/clearml/start.sh --no-monitoring
#     bash /opt/clearml/start.sh --no-remote-setup   # 학습 서버 SSH 확인 대기 없이 진행
#     bash /opt/clearml/start.sh --no-projects       # 기본 프로젝트(Dataset·Detector·VLM) 생성 생략
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# packaging/*.sh 는 CLEARML_DIR 기본값이 /opt/clearml 이므로, 이 저장소 위치로 맞춘다
export CLEARML_DIR="${CLEARML_DIR:-$ROOT}"
SKIP_MOUNT=0
SKIP_MONITORING=0
SKIP_REMOTE=0
SKIP_PROJECTS=0

while [ $# -gt 0 ]; do
    case "$1" in
        --no-mount) SKIP_MOUNT=1 ;;
        --no-monitoring) SKIP_MONITORING=1 ;;
        --no-remote-setup) SKIP_REMOTE=1 ;;
        --no-projects) SKIP_PROJECTS=1 ;;
        -h|--help)
            sed -n '2,21p' "$0"
            exit 0
            ;;
        *) echo "unknown option: $1" >&2; exit 1 ;;
    esac
    shift
done

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; BLU=$'\033[0;34m'; NC=$'\033[0m'
step() { echo -e "\n${BLU}▶ $*${NC}"; }
ok()   { echo -e "  ${GRN}✓${NC} $*"; }
warn() { echo -e "  ${YEL}!${NC} $*"; }

run_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        sudo "$@"
    fi
}

# ── 1/6 .env (서명 키 · 주소 · 파생 URL) ─────────────────────────────────
step "1/6 환경 설정 (.env)"
# NFS 마운트 스크립트가 sudo 로 data/ 를 만들면 root 소유가 되므로, 먼저 현재 사용자 소유로 만들어 둔다
mkdir -p "${ROOT}/data"
if [ ! -f "${ROOT}/.env" ]; then
    if [ -f "${ROOT}/.env.example" ]; then
        cp "${ROOT}/.env.example" "${ROOT}/.env"
        chmod 600 "${ROOT}/.env"
    fi
    bash "${ROOT}/packaging/migrate-env.sh" 2>/dev/null || true
fi

if [ ! -f "${ROOT}/.env" ] || ! grep -qE '^CLEARML_TOKEN_SECRET=.' "${ROOT}/.env" 2>/dev/null; then
    bash "${ROOT}/packaging/gen-secrets.sh"
fi
bash "${ROOT}/packaging/gen-auth.sh" >/dev/null
bash "${ROOT}/packaging/apply-env.sh"
ok ".env 준비"

# .env 의 MLOPS_ROOT 가 이 저장소 위치와 다르면 마운트·키 경로가 어긋나므로 중단
ENV_MLOPS_ROOT="$(set -a; . "${ROOT}/.env"; echo "${MLOPS_ROOT:-}")"
if [ -z "$ENV_MLOPS_ROOT" ]; then
    warn ".env 에 MLOPS_ROOT 없음 — 경로 검사 건너뜀 (.env.example 참고)"
elif [ "$(realpath -m "${ENV_MLOPS_ROOT}/clearml")" != "$(realpath -m "$ROOT")" ]; then
    echo -e "  ${RED}✗ .env 의 MLOPS_ROOT 가 이 저장소 위치와 다릅니다${NC}" >&2
    echo "      .env  : MLOPS_ROOT=${ENV_MLOPS_ROOT}  (→ ${ENV_MLOPS_ROOT}/clearml)" >&2
    echo "      실제  : ${ROOT}" >&2
    echo "      ${ROOT%/clearml} 로 .env 의 MLOPS_ROOT 를 고친 뒤 다시 실행하세요" >&2
    exit 1
fi

# ── 2/6 SSH 키 (MLOps → 학습 서버) ───────────────────────────────────────
step "2/6 학습 서버 SSH 키"
SSH_KEY_DIR="$(set -a; . "${ROOT}/.env"; echo "${TRAINING_SSH_DIR:-}")"
if [ -z "$SSH_KEY_DIR" ]; then
    warn "TRAINING_SSH_DIR 미설정 — SSH 키 단계 건너뜀"
elif [ -e "${SSH_KEY_DIR}/id_ed25519" ]; then
    ok "SSH 키 있음: ${SSH_KEY_DIR}/id_ed25519"
else
    bash "${ROOT}/packaging/gen-ssh-key.sh" --dir "$SSH_KEY_DIR"
fi

# SSH 키 파일 소유자와 컨테이너 실행 UID 를 맞춘다 (다르면 컨테이너가 키를 못 읽는다)
if [ -n "$SSH_KEY_DIR" ] && [ -e "${SSH_KEY_DIR}/id_ed25519" ]; then
    KEY_UID="$(stat -c '%u' "${SSH_KEY_DIR}/id_ed25519")"
    KEY_GID="$(stat -c '%g' "${SSH_KEY_DIR}/id_ed25519")"
    if [ "$KEY_UID" != 0 ]; then
        python3 "${ROOT}/packaging/lib/set_env.py" "${ROOT}/.env" \
            "TRAINING_SSH_UID=${KEY_UID}" "TRAINING_SSH_GID=${KEY_GID}" >/dev/null
        ok "TRAINING_SSH_UID/GID = ${KEY_UID}:${KEY_GID} (키 소유자 기준)"
    fi
fi

# 학습 서버 접속 정보 (.env)
TR_HOST="$(set -a; . "${ROOT}/.env"; echo "${TRAINING_SSH_HOST:-${TRAINING_SERVER_IP:-}}")"
TR_USER="$(set -a; . "${ROOT}/.env"; echo "${TRAINING_SSH_USER:-}")"
TR_PORT="$(set -a; . "${ROOT}/.env"; echo "${TRAINING_SSH_PORT:-22}")"
TR_KNOWN="${SSH_KEY_DIR}/known_hosts"

# 학습 서버 호스트 키를 known_hosts 에 등록 (없을 때만, 지문을 함께 보여 준다)
ensure_known_host() {
    [ -n "$TR_HOST" ] || return 0
    ssh-keygen -F "$TR_HOST" -f "$TR_KNOWN" >/dev/null 2>&1 && return 0
    local scan; scan="$(ssh-keyscan -p "$TR_PORT" -t ed25519,ecdsa,rsa "$TR_HOST" 2>/dev/null)" || true
    if [ -z "$scan" ]; then
        warn "학습 서버(${TR_HOST}:${TR_PORT})에서 호스트 키를 가져오지 못했습니다 — 학습 서버 sshd 를 확인하세요"
        return 1
    fi
    echo "  ssh-keyscan -p ${TR_PORT} -H ${TR_HOST} >> ${TR_KNOWN}"
    mkdir -p "$(dirname "$TR_KNOWN")"
    ssh-keyscan -H -p "$TR_PORT" -t ed25519,ecdsa,rsa "$TR_HOST" 2>/dev/null >> "$TR_KNOWN"
    chmod 644 "$TR_KNOWN"
    echo "$scan" | ssh-keygen -lf - | sed 's/^/      지문 /'
    ok "학습 서버 호스트 키를 known_hosts 에 등록"
}

# 학습 서버 SSH 접속을 실제로 시험한다 (0: 성공)
check_training_ssh() {
    local key="${SSH_KEY_DIR}/id_ed25519" out rc=0
    [ -e "$key" ] || return 0
    if [ -z "$TR_HOST" ] || [ -z "$TR_USER" ]; then
        warn "TRAINING_SSH_HOST / TRAINING_SSH_USER 미설정 — SSH 접속 확인 건너뜀"
        return 0
    fi
    out="$(timeout 15 ssh -i "$key" -p "$TR_PORT" -o BatchMode=yes -o IdentitiesOnly=yes \
        -o UserKnownHostsFile="$TR_KNOWN" -o StrictHostKeyChecking=yes -o ConnectTimeout=8 \
        "${TR_USER}@${TR_HOST}" true 2>&1)" || rc=$?
    if [ "$rc" = 0 ]; then
        ok "학습 서버 SSH 접속 확인 (SSH_OK): ${TR_USER}@${TR_HOST}"
    elif echo "$out" | grep -qi "permission denied"; then
        warn "학습 서버가 이 MLOps 서버의 키를 받아 주지 않습니다 (${TR_USER}@${TR_HOST})"
        return 1
    else
        warn "학습 서버 SSH 접속 실패: $(echo "$out" | tail -1)"
        return 1
    fi
}

# 학습 서버에서 해야 할 일을 그대로 보여 준다
show_train_instructions() {
    echo ""
    echo "${YEL}==================================================${NC}"
    echo "${YEL}  학습 서버 세팅이 필요합니다 (MLOps SSH 공개키 등록)${NC}"
    echo "${YEL}==================================================${NC}"
    echo ""
    echo "다음은 학습 서버(${TR_USER}@${TR_HOST})에서 실행하세요:"
    echo "  1) mount/config/train.env 의 MLOPS_SSH_PUBLIC_KEY 를 아래 한 줄로 입력 (이미 다른 키가 있으면 교체)"
    echo ""
    echo "       $(cat "${SSH_KEY_DIR}/id_ed25519.pub")"
    echo ""
    echo "     키 지문: $(ssh-keygen -lf "${SSH_KEY_DIR}/id_ed25519.pub" | awk '{print $2}')"
    echo "  2) bash start.sh"
    echo "     - MLOps 서버 IP / 루트 경로는 이 서버 .env 의 값과 같아야 합니다:"
    echo "       $(set -a; . "${ROOT}/.env"; echo "IP=${CLEARML_SERVER_IP}  루트=${MLOPS_ROOT}")"
    echo ""
}

if [ -n "$SSH_KEY_DIR" ]; then
    ensure_known_host || true
    if ! check_training_ssh; then
        show_train_instructions
        if [ "$SKIP_REMOTE" = 0 ] && [ -t 0 ]; then
            while true; do
                read -r -p "학습 서버에서 위 내용을 진행하셨나요? [1=예 / 0=아니오(종료)] > " _ans
                case "${_ans:-}" in
                    1)
                        echo ""
                        echo "MLOps 서버에서 자동으로 실행합니다:"
                        ensure_known_host || true
                        echo "  ssh -o BatchMode=yes -p ${TR_PORT} ${TR_USER}@${TR_HOST} true && echo SSH_OK"
                        if check_training_ssh; then break; fi
                        echo "  아직 접속되지 않습니다. 학습 서버 세팅을 확인한 뒤 다시 선택하세요."
                        echo ""
                        ;;
                    0)
                        echo ""
                        echo "학습 서버 세팅을 마친 뒤 bash start.sh 를 다시 실행하세요."
                        exit 0
                        ;;
                    *) echo "  1 또는 0 을 입력하세요." ;;
                esac
            done
        else
            warn "대화형 터미널이 아니거나 --no-remote-setup 이라 대기하지 않고 진행합니다 (학습 서버 SSH 는 나중에 다시 실행해 연결)"
        fi
    fi
fi

# 이후 단계(지표 수집 서비스 기동)에서 쓸 SSH 접속 결과
SSH_OK=0
if [ -n "$SSH_KEY_DIR" ]; then check_training_ssh >/dev/null 2>&1 && SSH_OK=1 || true; fi

# ── 3/6 NFS 마운트 (Dataset + 생성형 결과) ───────────────────────────────
step "3/6 NFS mount (실패해도 다음 단계 진행)"
if [ "$SKIP_MOUNT" = 1 ]; then
    echo "  skipped (--no-mount)"
else
    NFS_HOST="$(set -a; . "${ROOT}/.env"; echo "${TRAINING_SERVER_IP:-}")"
    if [ -n "$NFS_HOST" ] && ! timeout 4 bash -c "echo > /dev/tcp/${NFS_HOST}/2049" 2>/dev/null; then
        warn "학습 서버 NFS(2049)에 연결할 수 없습니다 — 학습 서버에서 bash start.sh (NFS export 포함)를 실행했는지 확인하세요"
    fi
    bash "${ROOT}/mount/scripts/mount_dataset.sh" mount || true
    bash "${ROOT}/mount/scripts/mount_generated.sh" mount || true
fi

# ── 4/6 Docker Compose ───────────────────────────────────────────────────
step "4/6 MLOps docker compose up"
cd "${ROOT}"
bash "${ROOT}/packaging/prepare-dirs.sh"   # 컨테이너 UID 에 맞게 데이터 폴더 권한 부여
./compose.sh up -d
ok "compose up 완료"

# ── 초기 관리자 (로그인 계정이 하나도 없을 때만 .env 의 CLEARML_LOGIN_* 로 생성) ──
step "초기 관리자 계정"
ADMIN_COUNT=""
FOLLOWUP=0   # 1: .env 의 임시 비밀번호가 아직 유효 → 기본 프로젝트 생성·학습 서버 API 키 발급을 이어서 한다
for _ in $(seq 1 30); do
    ADMIN_COUNT="$(docker exec clearml-access-control python -c \
        "import sqlite3;print(sqlite3.connect('/data/access.db').execute('select count(*) from users').fetchone()[0])" 2>/dev/null || true)"
    [ -n "$ADMIN_COUNT" ] && break
    sleep 1
done
ADMIN_ENV="$(set -a; . "${ROOT}/.env"; printf '%s\n%s\n%s' "${CLEARML_LOGIN_USER:-admin}" "${CLEARML_LOGIN_NAME:-Intellivix Admin}" "${CLEARML_LOGIN_PASSWORD:-}")"
IFS=$'\n' read -r -d '' ADMIN_U ADMIN_N ADMIN_P <<<"${ADMIN_ENV}"$'\n' || true
if [ -z "$ADMIN_COUNT" ]; then
    warn "access-control 이 준비되지 않아 건너뜀 — 나중에: docker exec clearml-access-control python /app/manage.py create-admin ..."
elif [ "$ADMIN_COUNT" != 0 ]; then
    ok "로그인 계정 있음 (${ADMIN_COUNT}개) — 관리자 생성 건너뜀"
    # 관리자가 아직 임시 비밀번호를 바꾸지 않았다면(첫 로그인 전) 이전 실행이 중간에 끝났을 수 있으니 후속 작업을 이어서 한다
    _TEMP="$(docker exec -e IVX_U="$ADMIN_U" clearml-access-control python -c \
        "import os,sqlite3;print(sqlite3.connect('/data/access.db').execute('select count(*) from users where username=? and must_change_password=1',(os.environ['IVX_U'],)).fetchone()[0])" 2>/dev/null || true)"
    if [ "${_TEMP:-0}" = 1 ]; then
        ok "관리자 '${ADMIN_U}' 가 아직 임시 비밀번호 상태 — 프로젝트 생성·API 키 발급을 이어서 확인합니다"
        FOLLOWUP=1
    fi
elif [ -z "$ADMIN_P" ]; then
    warn ".env 에 CLEARML_LOGIN_PASSWORD 없음 — 관리자 생성 건너뜀"
else
    docker exec -e IVX_U="$ADMIN_U" -e IVX_N="$ADMIN_N" -e IVX_P="$ADMIN_P" clearml-access-control \
        sh -c 'python /app/manage.py create-admin --username "$IVX_U" --name "$IVX_N" --password "$IVX_P"' >/dev/null
    ok "관리자 '${ADMIN_U}' 생성 (첫 로그인 시 비밀번호 변경 요구)"
    ./compose.sh up -d --force-recreate apiserver
    FOLLOWUP=1
fi

if [ "$FOLLOWUP" = 1 ]; then
    # apiserver 가 응답할 때까지 기다린다
    for _ in $(seq 1 30); do
        curl -s -m 3 -o /dev/null "http://localhost:8008/debug.ping" && break
        sleep 2
    done
    # 기본 프로젝트(Dataset, Detector, VLM) — 이미 있으면 건드리지 않는다
    if [ "$SKIP_PROJECTS" = 0 ]; then
        python3 "${ROOT}/packaging/ensure-clearml-projects.py" || true
    fi
    # 학습 서버가 ClearML 에 연결되도록 API 키를 발급해 학습 서버 train.env 에 넣는다 (SSH 가 되고 키가 비어 있을 때만)
    if [ "$SSH_OK" = 1 ]; then
        step "학습 서버 ClearML API 키 발급"
        python3 "${ROOT}/packaging/provision-training-credentials.py" || true
    else
        warn "학습 서버 SSH 가 연결되지 않아 ClearML API 키 발급을 건너뜀 — SSH 를 맞춘 뒤 start.sh 를 다시 실행하세요 (첫 로그인 전까지 가능)"
    fi
fi

# webserver(nginx)는 시작할 때 apiserver 의 IP 를 기억한다.
# 위에서 apiserver 가 (설정 변경·관리자 생성으로) 다시 만들어졌을 수 있으므로, 항상 웹서버를 재시작해 새 IP 를 알게 한다.
step "웹서버 재시작 (apiserver 주소 갱신)"
./compose.sh restart webserver >/dev/null 2>&1 && ok "webserver 재시작" || warn "webserver 재시작 실패 — 수동: ./compose.sh restart webserver"

# ── 학습 서버 지표 수집 (SSH 접속이 확인된 경우에만) ──────────────────────
step "학습 서버 연동 서비스 (training-metrics · annotation-api)"
if [ "$SSH_OK" = 1 ]; then
    ./compose.sh --profile training-ssh up -d --build training-metrics annotation-api
    ok "training-metrics 기동 — 대시보드의 TRAINING SERVER 지표가 5초마다 갱신됩니다"
    ok "annotation-api 기동 — 학습 화면(/train/)의 Dataset 폴더·라벨·배포 기능이 사용됩니다"
else
    warn "학습 서버 SSH 접속이 확인되지 않아 건너뜀 — 접속을 맞춘 뒤 start.sh 를 다시 실행하세요"
fi

# ── 5/6 Data Studio · Seoul Studio 재기동 (마운트/설정 반영) ─────────────
step "5/6 Data Studio · Seoul Studio 재기동"
./compose.sh up -d --force-recreate data-studio seoul-studio
ok "data-studio · seoul-studio ready"

# ── 6/6 Grafana 모니터링 (.env 변경 반영) ─────────────────────────────────
step "6/6 Grafana 모니터링"
if [ "$SKIP_MONITORING" = 1 ]; then
    echo "  skipped (--no-monitoring)"
else
    # compose up -d 만으로는 실행 중 컨테이너 env 가 안 바뀜 → force-recreate
    ./monitoring-compose.sh up -d --force-recreate
    ok "monitoring ready"
fi

# ── 결과 요약 ────────────────────────────────────────────────────────────
HOST_IP="$(grep '^CLEARML_HOST_IP=' "${ROOT}/.env" 2>/dev/null | cut -d= -f2- || echo '?')"
DATASET_PATH="$(grep '^DATASET_EXPORT_PATH=' "${ROOT}/.env" 2>/dev/null | cut -d= -f2- || echo '?')"
GENERATED_PATH="$(grep '^GENERATED_EXPORT_PATH=' "${ROOT}/.env" 2>/dev/null | cut -d= -f2- || echo '?')"
GRAFANA_PORT="$(grep '^GRAFANA_PORT=' "${ROOT}/.env" 2>/dev/null | cut -d= -f2- || echo '3000')"

echo ""
echo "=================================================="
echo "  ClearML UI  : http://${HOST_IP}:8080"
echo "  Data Studio : http://${HOST_IP}:8080/data-studio/"
echo "  Seoul Studio: http://${HOST_IP}:8080/seoul-studio/"
echo "  Grafana     : http://${HOST_IP}:${GRAFANA_PORT}/d/clearml-mlops-main"
echo "  Dataset path: ${DATASET_PATH}"
echo "  Generated path: ${GENERATED_PATH}"
if [ "$SSH_OK" = 1 ]; then
    echo "  학습 서버 SSH: ${TR_USER}@${TR_HOST} 연결됨"
    _KEYSTATE="$(python3 "${ROOT}/packaging/provision-training-credentials.py" --check 2>/dev/null | head -1 || true)"
    case "$_KEYSTATE" in
        *"이미 있음"*) echo "  ClearML API 키: 학습 서버에 등록됨" ;;
        *"비어 있음"*) echo "  ClearML API 키: 학습 서버에 아직 없음 → 웹 Settings > Workspace 에서 발급해 학습 서버 ./scripts/config.sh setup-clearml" ;;
    esac
else
    echo "  학습 서버 SSH: 연결 안 됨 (start.sh 를 다시 실행해 연결)"
fi
echo "=================================================="
bash "${ROOT}/mount/scripts/mount_dataset.sh" status 2>/dev/null || true
echo ""
bash "${ROOT}/mount/scripts/mount_generated.sh" status 2>/dev/null || true
