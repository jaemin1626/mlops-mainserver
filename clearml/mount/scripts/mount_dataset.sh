#!/usr/bin/env bash
# Data Studio용 Dataset 마운트 — 설정은 mount/config/dataset-mount.env 만 수정
#
#   mount   : 학습 서버 NFS → LOCAL_MOUNT_PATH (실패해도 exit 0, MLOps 진행 가능)
#   status  : 마운트 상태 확인
#   umount  : 마운트 해제
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOUNT_ENV="${MOUNT_ENV:-${ROOT}/mount/config/dataset-mount.env}"

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; BLU=$'\033[0;34m'; NC=$'\033[0m'
info() { echo -e "${BLU}▶ $*${NC}"; }
ok()   { echo -e "  ${GRN}✓${NC} $*"; }
warn() { echo -e "  ${YEL}!${NC} $*"; }
err()  { echo -e "  ${RED}✗${NC} $*" >&2; }

load_config() {
    [ -f "$MOUNT_ENV" ] || { err "설정 파일 없음: ${MOUNT_ENV}"; return 1; }
    # shellcheck disable=SC1090
    . "$MOUNT_ENV"
    TRAINING_SERVER_IP="${TRAINING_SERVER_IP:?dataset-mount.env 에 TRAINING_SERVER_IP 필요}"
    TRAINING_DATASET_PATH="${TRAINING_DATASET_PATH:?dataset-mount.env 에 TRAINING_DATASET_PATH 필요}"
    # HOST_DATASET_PATH: ClearML 서버 디스크 경로 (compose → 컨테이너 /data/datasets)
    HOST_DATASET_PATH="${HOST_DATASET_PATH:-${LOCAL_MOUNT_PATH:-/opt/clearml/data/datasets}}"
    LOCAL_MOUNT_PATH="${HOST_DATASET_PATH}"
    NFS_MOUNT_OPTS="${NFS_MOUNT_OPTS:-rw,nfsvers=4,soft,timeo=30,retrans=2}"
    NFS_SOURCE="${TRAINING_SERVER_IP}:${TRAINING_DATASET_PATH}"
}

is_mounted() {
    mountpoint -q "$LOCAL_MOUNT_PATH" 2>/dev/null
}

sync_compose_env() {
    local set_env="${ROOT}/packaging/lib/set_env.py"
    local secrets_env="${ROOT}/secrets/.env"
    mkdir -p "${ROOT}/secrets" "${LOCAL_MOUNT_PATH}"
    chmod 700 "${ROOT}/secrets" 2>/dev/null || true
    if [ -f "$set_env" ]; then
        python3 "$set_env" "$secrets_env" "DATASET_EXPORT_PATH=${LOCAL_MOUNT_PATH}" >/dev/null 2>&1 || true
        chmod 600 "$secrets_env" 2>/dev/null || true
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

    info "Dataset mount (Data Studio)"
    echo "  Config:     ${MOUNT_ENV}"
    echo "  Source:     ${NFS_SOURCE}"
    echo "  Mount point:${LOCAL_MOUNT_PATH}"

    run_root mkdir -p "$LOCAL_MOUNT_PATH" 2>/dev/null || mkdir -p "$LOCAL_MOUNT_PATH" 2>/dev/null || true

    if is_mounted; then
        ok "already mounted"
        sync_compose_env
        return 0
    fi

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
        warn "마운트 실패 — Data Studio 는 빈 폴더로 동작, MLOps 는 계속 진행 가능"
        warn "  학습 서버에서 export 확인: showmount -e ${TRAINING_SERVER_IP}"
        warn "  수동: sudo mount -t nfs -o ${NFS_MOUNT_OPTS} ${NFS_SOURCE} ${LOCAL_MOUNT_PATH}"
    fi

    sync_compose_env
    return 0
}

cmd_status() {
    load_config || exit 1

    echo "Dataset mount status"
    echo "  Config:      ${MOUNT_ENV}"
    echo "  Source:      ${NFS_SOURCE}"
    echo "  Mount point: ${LOCAL_MOUNT_PATH}"
    echo "  Compose env: DATASET_EXPORT_PATH → secrets/.env"

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

    if docker inspect clearml-data-studio >/dev/null 2>&1; then
        echo "  Container:   $(docker inspect clearml-data-studio --format '{{range .Mounts}}{{if eq .Destination "/data/datasets"}}{{.Source}} -> {{.Destination}}{{end}}{{end}}' 2>/dev/null)"
    fi
}

cmd_umount() {
    load_config || exit 1
    if is_mounted; then
        if [ "$(id -u)" -eq 0 ]; then
            umount "$LOCAL_MOUNT_PATH"
        else
        run_root umount "$LOCAL_MOUNT_PATH"
        fi
        ok "unmounted ${LOCAL_MOUNT_PATH}"
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
