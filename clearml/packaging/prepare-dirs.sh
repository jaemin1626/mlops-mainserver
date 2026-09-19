#!/usr/bin/env bash
# 컨테이너가 쓰는 데이터 폴더의 소유자를 컨테이너 실행 UID 에 맞춘다.
#
#   Docker 가 bind mount 폴더를 root 소유로 만들면, root 가 아닌 컨테이너
#   (elasticsearch, prometheus, grafana, access-control)는 쓰기 권한이 없어
#   기동 직후 죽는다. start.sh 가 compose up 전에 이 스크립트를 호출한다.
#
#   사용법: ./prepare-dirs.sh      (이미 맞는 폴더는 건드리지 않는다)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEARML_DIR="${CLEARML_DIR:-$(dirname "$SCRIPT_DIR")}"

GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; NC=$'\033[0m'
ok()   { echo -e "  ${GRN}✓${NC} $*"; }
warn() { echo -e "  ${YEL}!${NC} $*"; }

# chown 은 root 권한이 필요하므로 docker(alpine)로 수행한다 — sudo 비밀번호 불필요
# 상위 폴더(data 등)가 root 소유라 mkdir 이 안 되면, 그 폴더 자체(하위 제외)만 현재 사용자 소유로 바꾼다.
# 마운트 스크립트가 sudo mkdir -p 로 data/ 를 root 소유로 만드는 경우가 있다.
make_dir() {   # <경로>
    local path="$1" parent
    mkdir -p "$path" 2>/dev/null && return 0
    parent="$(dirname "$path")"
    docker run --rm -v "${parent}:/p" alpine chown "$(id -u):$(id -g)" /p >/dev/null 2>&1 || true
    mkdir -p "$path"
}

fix_owner() {   # <경로> <uid:gid> [chmod 모드]
    local path="$1" owner="$2" mode="${3:-}"
    make_dir "$path"
    local cur; cur="$(stat -c '%u:%g' "$path")"
    if [ "$cur" = "$owner" ] && { [ -z "$mode" ] || [ "$(stat -c '%a' "$path")" = "$mode" ]; }; then
        return 0
    fi
    local cmd="chown -R ${owner} /d"
    [ -n "$mode" ] && cmd="${cmd} && chmod ${mode} /d"
    if docker run --rm -v "${path}:/d" alpine sh -c "$cmd" >/dev/null 2>&1; then
        ok "${path#"$CLEARML_DIR"/} → ${owner}${mode:+ (${mode})}"
    else
        warn "${path} 소유자 변경 실패 — 수동: sudo chown -R ${owner} ${path}"
    fi
}

# config: 소유자는 유지하고 access-control(gid 999)만 쓸 수 있게 그룹 권한을 준다
fix_group() {   # <경로> <gid>
    local path="$1" gid="$2"
    make_dir "$path"
    if [ "$(stat -c '%g' "$path")" = "$gid" ] && [ "$(stat -c '%a' "$path")" = 775 ]; then
        return 0
    fi
    if docker run --rm -v "${path}:/d" alpine sh -c "chgrp ${gid} /d && chmod 775 /d" >/dev/null 2>&1; then
        ok "${path#"$CLEARML_DIR"/} → 그룹 ${gid} (775)"
    else
        warn "${path} 그룹 변경 실패 — 수동: sudo chgrp ${gid} ${path} && sudo chmod 775 ${path}"
    fi
}

fix_owner "${CLEARML_DIR}/data/elastic_7"         1000:0        # elasticsearch
fix_owner "${CLEARML_DIR}/access_control/data"    1000:999      # access-control (sqlite)
fix_group "${CLEARML_DIR}/config"                 999           # access-control → fixed-users.json
fix_owner "${CLEARML_DIR}/monitoring/data/prometheus" 65534:65534
fix_owner "${CLEARML_DIR}/monitoring/data/grafana"    472:472
# annotation-api(training-ssh 프로필)는 TRAINING_SSH_UID:GID 로 실행되며 이 폴더에 배포 이력을 쓴다
_ssh_ids="$(set -a; . "${CLEARML_DIR}/.env" 2>/dev/null; echo "${TRAINING_SSH_UID:-$(id -u)}:${TRAINING_SSH_GID:-$(id -g)}")"
fix_owner "${CLEARML_DIR}/training_ssh/data"           "$_ssh_ids"

# 지표 파일: 저장소에는 없다. 파일이 없으면 Docker 가 같은 이름의 "폴더"를 만들어 버리므로 빈 초기값을 미리 만들어 둔다.
metrics="${CLEARML_DIR}/branding/training-metrics.json"
if [ ! -e "$metrics" ]; then
    echo '{"ok": false, "error": "수집 전"}' > "$metrics"
    ok "branding/training-metrics.json 초기 파일 생성"
fi
