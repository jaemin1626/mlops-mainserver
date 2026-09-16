#!/usr/bin/env bash
# 생성형 결과(영상) NFS 마운트 — 설정은 /opt/clearml/.env
#
#   mount   : 학습 서버 NFS → MLOPS_GENERATED_MOUNT_PATH
#   status  : 마운트 상태 확인
#   umount  : 마운트 해제
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${CLEARML_ENV_FILE:-${ROOT}/.env}"

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; BLU=$'\033[0;34m'; NC=$'\033[0m'
info() { echo -e "${BLU}▶ $*${NC}"; }
ok()   { echo -e "  ${GRN}✓${NC} $*"; }
warn() { echo -e "  ${YEL}!${NC} $*"; }
err()  { echo -e "  ${RED}✗${NC} $*" >&2; }

load_config() {
    if [ ! -f "$ENV_FILE" ]; then
        err "설정 없음: ${ENV_FILE} — cp .env.example .env"
        return 1
    fi
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    TRAINING_SERVER_IP="${TRAINING_SERVER_IP:? .env 에 TRAINING_SERVER_IP 필요}"
    TRAINING_GENERATED_PATH="${TRAINING_GENERATED_PATH:? .env 에 TRAINING_GENERATED_PATH 필요}"
    MLOPS_GENERATED_MOUNT_PATH="${MLOPS_GENERATED_MOUNT_PATH:-/home/intellivix/train/ComfyUI/generate_datasets}"
    LOCAL_MOUNT_PATH="${MLOPS_GENERATED_MOUNT_PATH}"
    NFS_MOUNT_OPTS="${NFS_MOUNT_OPTS:-rw,nfsvers=4,soft,timeo=30,retrans=2}"
    NFS_SOURCE="${TRAINING_SERVER_IP}:${TRAINING_GENERATED_PATH}"
}

is_mounted() {
    mountpoint -q "$LOCAL_MOUNT_PATH" 2>/dev/null
}

current_mount_source() {
    findmnt -n -o SOURCE --target "$LOCAL_MOUNT_PATH" 2>/dev/null || true
}

is_expected_mount() {
    is_mounted && [ "$(current_mount_source)" = "$NFS_SOURCE" ]
}

umount_existing() {
    if ! is_mounted; then
        return 0
    fi
    local old
    old="$(current_mount_source)"
    warn "기존 마운트 해제: ${old:-${LOCAL_MOUNT_PATH}}"
    if [ "$(id -u)" -eq 0 ]; then
        umount "$LOCAL_MOUNT_PATH" 2>/dev/null || umount -l "$LOCAL_MOUNT_PATH"
    else
        run_root umount "$LOCAL_MOUNT_PATH" 2>/dev/null || run_root umount -l "$LOCAL_MOUNT_PATH"
    fi
    ok "unmounted ${LOCAL_MOUNT_PATH}"
}

sync_compose_env() {
    local set_env="${ROOT}/packaging/lib/set_env.py"
    mkdir -p "${LOCAL_MOUNT_PATH}"
    if [ -f "$set_env" ] && [ -f "$ENV_FILE" ]; then
        python3 "$set_env" "$ENV_FILE" \
            "GENERATED_EXPORT_PATH=${LOCAL_MOUNT_PATH}" >/dev/null 2>&1 || true
        chmod 600 "$ENV_FILE" 2>/dev/null || true
    fi
}

run_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    else
        sudo "$@"
    fi
}

ensure_nfs_client() {
    if command -v mount.nfs >/dev/null 2>&1; then
        return 0
    fi
    if ! command -v apt-get >/dev/null 2>&1; then
        warn "apt-get 없음 — nfs-common 을 수동 설치하세요"
        return 1
    fi
    info "nfs-common 설치 (NFS 마운트용)..."
    if run_root apt-get update -qq && run_root apt-get install -y -qq nfs-common; then
        ok "nfs-common 설치 완료"
        return 0
    fi
    warn "nfs-common 설치 실패"
    return 1
}

cmd_mount() {
    load_config || return 0

    info "Generated datasets mount (Seoul Studio / Data Studio)"
    echo "  Config:     ${ENV_FILE}"
    echo "  Source:     ${NFS_SOURCE}"
    echo "  Mount point:${LOCAL_MOUNT_PATH}"

    run_root mkdir -p "$LOCAL_MOUNT_PATH" 2>/dev/null || mkdir -p "$LOCAL_MOUNT_PATH" 2>/dev/null || true

    if is_expected_mount; then
        ok "already mounted (${NFS_SOURCE})"
        sync_compose_env
        return 0
    fi

    umount_existing || true

    ensure_nfs_client || true

    if ! command -v mount.nfs >/dev/null 2>&1 && ! command -v mount >/dev/null 2>&1; then
        warn "mount 명령 없음 — 빈 디렉터리로 진행"
        sync_compose_env
        return 0
    fi

    info "NFS mount 시도..."
    MOUNT_RC=0
    if [ "$(id -u)" -eq 0 ]; then
        mount -t nfs -o "$NFS_MOUNT_OPTS" "$NFS_SOURCE" "$LOCAL_MOUNT_PATH" || MOUNT_RC=$?
    else
        run_root mount -t nfs -o "$NFS_MOUNT_OPTS" "$NFS_SOURCE" "$LOCAL_MOUNT_PATH" || MOUNT_RC=$?
    fi

    if [ "$MOUNT_RC" -eq 0 ] && is_mounted; then
        ok "mounted ${NFS_SOURCE} → ${LOCAL_MOUNT_PATH}"
        du -sh "$LOCAL_MOUNT_PATH" 2>/dev/null || true
    else
        warn "마운트 실패 — Seoul Studio 는 로컬 폴더로 동작, MLOps 는 계속 진행 가능"
        warn "  학습 서버에서 export 확인: showmount -e ${TRAINING_SERVER_IP}"
        warn "  수동: sudo mount -t nfs -o ${NFS_MOUNT_OPTS} ${NFS_SOURCE} ${LOCAL_MOUNT_PATH}"
    fi

    sync_compose_env
    return 0
}

cmd_status() {
    load_config || exit 1

    echo "Generated datasets mount status"
    echo "  Config:      ${ENV_FILE}"
    echo "  Source:      ${NFS_SOURCE}"
    echo "  Mount point: ${LOCAL_MOUNT_PATH}"
    echo "  Compose env: GENERATED_EXPORT_PATH → .env"

    if [ -d "$LOCAL_MOUNT_PATH" ]; then
        if is_mounted; then
            echo "  Status:      mounted (nfs)"
            findmnt -T "$LOCAL_MOUNT_PATH" 2>/dev/null || mount | grep -F "$LOCAL_MOUNT_PATH" || true
        else
            echo "  Status:      local directory (not mounted)"
        fi
        du -sh "$LOCAL_MOUNT_PATH" 2>/dev/null || true
    else
        echo "  Status:      MISSING"
    fi

    if docker inspect clearml-seoul-studio >/dev/null 2>&1; then
        echo "  Seoul Studio:$(docker inspect clearml-seoul-studio --format '{{range .Mounts}}{{if eq .Destination "/data/output"}}{{.Source}} -> {{.Destination}}{{end}}{{end}}' 2>/dev/null)"
    fi
    if docker inspect clearml-data-studio >/dev/null 2>&1; then
        echo "  Data Studio: $(docker inspect clearml-data-studio --format '{{range .Mounts}}{{if eq .Destination "/data/generate_datasets"}}{{.Source}} -> {{.Destination}}{{end}}{{end}}' 2>/dev/null)"
    fi
}

cmd_umount() {
    load_config || exit 1
    if is_mounted; then
        umount_existing
    else
        warn "not mounted: ${LOCAL_MOUNT_PATH}"
    fi
}

case "${1:-mount}" in
    mount)  cmd_mount ;;
    status) cmd_status ;;
    umount|unmount) cmd_umount ;;
    -h|--help)
        sed -n '2,8p' "$0"
        echo "  mount | status | umount"
        ;;
    *) err "unknown command: $1"; exit 1 ;;
esac
