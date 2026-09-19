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
#     bash /opt/clearml/start.sh --no-remote-setup   # 학습 서버 자동 세팅(키 등록·NFS export) 생략
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
    if [ "$SKIP_REMOTE" = 0 ] && [ -t 0 ]; then
        echo "  → 이어서 학습 서버에 공개키를 자동 등록할 수 있습니다 (학습 서버 비밀번호 1회 입력)"
    else
        echo ""
        echo "${YEL}==================================================${NC}"
        echo "${YEL}  [알림] 학습 서버에 위 공개키를 등록하세요${NC}"
        echo "${YEL}==================================================${NC}"
        echo "  학습 서버의 ${TRAINING_SSH_USER:-계정}에서: echo '<위 공개키 한 줄>' >> ~/.ssh/authorized_keys"
        echo "  (등록 후 start.sh 를 다시 실행하면 접속 확인과 나머지 단계가 진행됩니다)"
    fi
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

# 학습 서버 SSH 접속을 실제로 시험하고, 안 되면 조치할 명령을 그대로 보여 준다 (중단하지 않음)
check_training_ssh() {
    local key="${SSH_KEY_DIR}/id_ed25519" khosts="${SSH_KEY_DIR}/known_hosts" host user port out rc=0
    [ -e "$key" ] || return 0
    host="$(set -a; . "${ROOT}/.env"; echo "${TRAINING_SSH_HOST:-${TRAINING_SERVER_IP:-}}")"
    user="$(set -a; . "${ROOT}/.env"; echo "${TRAINING_SSH_USER:-}")"
    port="$(set -a; . "${ROOT}/.env"; echo "${TRAINING_SSH_PORT:-22}")"
    if [ -z "$host" ] || [ -z "$user" ]; then
        warn "TRAINING_SSH_HOST / TRAINING_SSH_USER 미설정 — SSH 접속 확인 건너뜀"
        return 0
    fi
    out="$(timeout 15 ssh -i "$key" -p "$port" -o BatchMode=yes -o IdentitiesOnly=yes \
        -o UserKnownHostsFile="$khosts" -o StrictHostKeyChecking=yes -o ConnectTimeout=8 \
        "${user}@${host}" true 2>&1)" || rc=$?
    if [ "$rc" = 0 ]; then
        ok "학습 서버 SSH 접속 확인: ${user}@${host}"
    elif echo "$out" | grep -qiE "host key verification failed|no .* host key is known"; then
        warn "학습 서버 호스트 키가 known_hosts 에 없습니다. MLOps 서버에서 실행:"
        echo "      ssh-keyscan -p ${port} -H ${host} >> ${khosts}"
        return 1
    elif echo "$out" | grep -qi "permission denied"; then
        warn "학습 서버가 이 키를 받아 주지 않습니다 (${user}@${host}). 이 서버의 키 지문:"
        echo "      $(ssh-keygen -lf "${key}.pub" | awk '{print $2}')"
        echo "    [권장] 학습 서버의 mount/config/train.env 의 MLOPS_SSH_PUBLIC_KEY 를 아래 한 줄로 바꾸고 bash start.sh 재실행"
        echo "      $(cat "${key}.pub")"
        echo "    (학습 서버 start.sh 가 접속 IP 제한(restrict,from=)을 붙여 등록합니다)"
        echo "    [대안] 학습 서버의 ${user} 계정에서 직접 추가:"
        echo "      mkdir -p ~/.ssh && chmod 700 ~/.ssh"
        echo "      echo '$(cat "${key}.pub")' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
        echo "    (TRAINING_SSH_USER=${user} 가 학습 서버의 실제 계정과 같은지도 확인)"
        return 1
    else
        warn "학습 서버 SSH 접속 실패: $(echo "$out" | tail -1)"
        return 1
    fi
}
if [ -n "$SSH_KEY_DIR" ]; then
    # 학습 서버 호스트 키가 known_hosts 에 없으면 지문을 보여 주고 등록 (새로 clone 한 직후에는 항상 없다)
    _khost="$(set -a; . "${ROOT}/.env"; echo "${TRAINING_SSH_HOST:-${TRAINING_SERVER_IP:-}}")"
    if [ -n "$_khost" ] && [ "$SKIP_REMOTE" = 0 ] && [ -t 0 ] \
        && ! ssh-keygen -F "$_khost" -f "${SSH_KEY_DIR}/known_hosts" >/dev/null 2>&1; then
        bash "${ROOT}/packaging/bootstrap-training-server.sh" hostkey || warn "호스트 키 등록을 건너뜀"
    fi
    if ! check_training_ssh && [ "$SKIP_REMOTE" = 0 ] && [ -t 0 ]; then
        echo ""
        echo "  학습 서버 세팅을 어떻게 할까요?"
        echo "    1) 자동  — 이 서버가 SSH 로 대신 등록 (학습 서버 계정 비밀번호 1회 입력)"
        echo "    2) 직접  — 학습 서버에서 start.sh 를 실행해 세팅한 뒤 여기로 돌아와 Enter"
        echo "    3) 건너뜀"
        read -r -p "  선택 [1/2/3] > " _choice
        case "${_choice:-3}" in
            1) bash "${ROOT}/packaging/bootstrap-training-server.sh" key || warn "자동 등록 실패 — 위 수동 명령을 사용하세요" ;;
            2) echo ""
               echo "  학습 서버에서 아래 한 줄을 mount/config/train.env 의 MLOPS_SSH_PUBLIC_KEY 값으로 넣고 (이미 다른 키가 있으면 교체)"
               echo "  bash start.sh 를 실행하세요. (train.env 에 키가 비어 있으면 실행 중에 붙여 넣으라고 묻습니다)"
               echo "    $(cat "${SSH_KEY_DIR}/id_ed25519.pub")"
               echo "  (학습 서버의 MLOps IP·루트 경로는 이 서버 .env 의 CLEARML_SERVER_IP / MLOPS_ROOT 와 같아야 합니다)"
               read -r -p "  학습 서버 세팅을 마쳤으면 Enter > " _ ;;
            *) warn "건너뜀 — 학습 서버 SSH 는 나중에 start.sh 를 다시 실행해 연결하세요" ;;
        esac
        check_training_ssh || true
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
        warn "학습 서버 NFS(2049)에 연결할 수 없습니다 — export 가 안 되어 있는 것으로 보입니다"
        if [ "$SKIP_REMOTE" = 0 ] && [ -t 0 ]; then
            read -r -p "  SSH 로 학습 서버 NFS export 를 자동 세팅할까요? (sudo 비밀번호 입력) [y/N] " _yn
            if [ "${_yn:-n}" = y ]; then
                bash "${ROOT}/packaging/bootstrap-training-server.sh" nfs || warn "자동 세팅 실패 — 학습 서버에서 수동으로 진행하세요"
            fi
        fi
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
for _ in $(seq 1 30); do
    ADMIN_COUNT="$(docker exec clearml-access-control python -c \
        "import sqlite3;print(sqlite3.connect('/data/access.db').execute('select count(*) from users').fetchone()[0])" 2>/dev/null || true)"
    [ -n "$ADMIN_COUNT" ] && break
    sleep 1
done
if [ -z "$ADMIN_COUNT" ]; then
    warn "access-control 이 준비되지 않아 건너뜀 — 나중에: docker exec clearml-access-control python /app/manage.py create-admin ..."
elif [ "$ADMIN_COUNT" != 0 ]; then
    ok "로그인 계정 있음 (${ADMIN_COUNT}개) — 건너뜀"
else
    ADMIN_ENV="$(set -a; . "${ROOT}/.env"; printf '%s\n%s\n%s' "${CLEARML_LOGIN_USER:-admin}" "${CLEARML_LOGIN_NAME:-Intellivix Admin}" "${CLEARML_LOGIN_PASSWORD:-}")"
    IFS=$'\n' read -r -d '' ADMIN_U ADMIN_N ADMIN_P <<<"${ADMIN_ENV}"$'\n' || true
    if [ -z "$ADMIN_P" ]; then
        warn ".env 에 CLEARML_LOGIN_PASSWORD 없음 — 관리자 생성 건너뜀"
    else
        docker exec -e IVX_U="$ADMIN_U" -e IVX_N="$ADMIN_N" -e IVX_P="$ADMIN_P" clearml-access-control \
            sh -c 'python /app/manage.py create-admin --username "$IVX_U" --name "$IVX_N" --password "$IVX_P"' >/dev/null
        ok "관리자 '${ADMIN_U}' 생성 (첫 로그인 시 비밀번호 변경 요구)"
        ./compose.sh up -d --force-recreate apiserver
        # 처음 세팅 직후에는 .env 의 비밀번호가 유효하므로 기본 프로젝트(Dataset, Detector, VLM)도 만든다
        if [ "$SKIP_PROJECTS" = 0 ]; then
            for _ in $(seq 1 30); do
                curl -s -m 3 -o /dev/null "http://localhost:8008/debug.ping" && break
                sleep 2
            done
            python3 "${ROOT}/packaging/ensure-clearml-projects.py" || true
        fi
    fi
fi

# webserver(nginx)는 시작할 때 apiserver 의 IP 를 기억한다.
# 위에서 apiserver 가 (설정 변경·관리자 생성으로) 다시 만들어졌을 수 있으므로, 항상 웹서버를 재시작해 새 IP 를 알게 한다.
step "웹서버 재시작 (apiserver 주소 갱신)"
./compose.sh restart webserver >/dev/null 2>&1 && ok "webserver 재시작" || warn "webserver 재시작 실패 — 수동: ./compose.sh restart webserver"

# ── 학습 서버 지표 수집 (SSH 접속이 확인된 경우에만) ──────────────────────
step "학습 서버 지표 수집 (training-metrics)"
if [ "$SSH_OK" = 1 ]; then
    ./compose.sh --profile training-ssh up -d --build training-metrics
    ok "training-metrics 기동 — 대시보드의 TRAINING SERVER 지표가 5초마다 갱신됩니다"
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
echo "=================================================="
bash "${ROOT}/mount/scripts/mount_dataset.sh" status 2>/dev/null || true
echo ""
bash "${ROOT}/mount/scripts/mount_generated.sh" status 2>/dev/null || true
