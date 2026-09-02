#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# ClearML 스택 오프라인 이관 번들 생성
#
#   docker save 는 "이미지" 만 저장한다. 이 스택의 커스터마이징은 대부분
#   이미지 바깥(호스트 bind mount, build context, DB 데이터)에 있으므로
#   이미지만 옮기면 순정 ClearML 이 뜬다. 이 스크립트는 세 가지를 함께 묶는다.
#
#     1. 이미지  : 실행 중인 컨테이너의 "실제 이미지 ID" 를 버전 태그로 고정해 저장
#     2. 설정    : branding / nginx / grafana 대시보드 / exporter 소스 / 빌드 컨텍스트
#     3. 데이터  : mongo / elasticsearch / grafana / redis (선택)
#
#   사용법:
#     ./pack.sh                      # 이미지 + 설정 (기본)
#     ./pack.sh --with-data          # + mongo/elastic/grafana/redis
#     ./pack.sh --with-data --stop   # 스택을 잠시 내리고 정합성 있는 데이터 백업
#     ./pack.sh --with-prometheus    # + prometheus TSDB (약 8GB)
#     ./pack.sh --images-only
#     ./pack.sh --out /mnt/usb/bundle
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CLEARML_DIR="${CLEARML_DIR:-/opt/clearml}"
MONITORING_DIR="${MONITORING_DIR:-${CLEARML_DIR}/monitoring}"
DATA_STUDIO_DIR="${DATA_STUDIO_DIR:-/opt/data_studio}"

CLEARML_PROJECT="${CLEARML_PROJECT:-clearml}"
MONITORING_PROJECT="${MONITORING_PROJECT:-monitoring-deploy}"

BUNDLE_ID="${BUNDLE_ID:-$(date +%Y%m%d)}"
OUT_ROOT="${OUT_ROOT:-/opt/clearml-bundle}"

WITH_IMAGES=1
WITH_CONFIG=1
WITH_DATA=0
WITH_PROMETHEUS=0
STOP_STACK=0

# 호스트 계정으로는 못 읽는 컨테이너 소유 디렉터리를 다루기 위한 root 헬퍼.
# busybox tar 가 아닌 GNU tar 가 필요해서 alpine 대신 ubuntu 를 쓴다.
HELPER_IMAGE="${HELPER_IMAGE:-ubuntu:22.04}"

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; BLU=$'\033[0;34m'; NC=$'\033[0m'
step() { echo -e "\n${BLU}▶ $*${NC}"; }
ok()   { echo -e "  ${GRN}✓${NC} $*"; }
warn() { echo -e "  ${YEL}!${NC} $*"; }
die()  { echo -e "  ${RED}✗ $*${NC}" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --with-data)       WITH_DATA=1 ;;
        --with-prometheus) WITH_DATA=1; WITH_PROMETHEUS=1 ;;
        --stop)            STOP_STACK=1 ;;
        --images-only)     WITH_CONFIG=0; WITH_DATA=0 ;;
        --no-images)       WITH_IMAGES=0 ;;
        --out)             OUT_ROOT="$2"; shift ;;
        --id)              BUNDLE_ID="$2"; shift ;;
        -h|--help)         sed -n '2,25p' "$0"; exit 0 ;;
        *)                 die "알 수 없는 옵션: $1" ;;
    esac
    shift
done

BUNDLE="${OUT_ROOT}/clearml-bundle-${BUNDLE_ID}"

if command -v pigz >/dev/null 2>&1; then
    COMPRESS="pigz -p $(nproc)"
else
    COMPRESS="gzip"
fi

# ── 루트 권한이 필요한 디렉터리를 sudo 없이 tar 로 묶는다 ─────────────────
# mongo/elastic/grafana 데이터는 컨테이너 UID 소유라 호스트 계정으로 못 읽는다.
# 헬퍼 컨테이너를 root 로 띄워 읽고, 소유권은 tar 안에 숫자 UID 로 보존한다.
tar_as_root() {
    local src="$1" out="$2"; shift 2
    local excludes=()
    for e in "$@"; do excludes+=(--exclude="$e"); done
    docker run --rm -v "${src}:/src:ro" "$HELPER_IMAGE" \
        tar -C /src --numeric-owner -cf - "${excludes[@]}" . | $COMPRESS > "$out"
}

# ──────────────────────────────────────────────────────────────────────────
step "사전 점검"
command -v docker >/dev/null || die "docker 없음"
docker info >/dev/null 2>&1 || die "docker 데몬에 접근할 수 없습니다"
docker image inspect "$HELPER_IMAGE" >/dev/null 2>&1 || docker pull "$HELPER_IMAGE"
python3 -c 'import yaml' 2>/dev/null || die "python3 pyyaml 필요 (pip install pyyaml)"

# /opt 처럼 root 소유 경로에도 만들 수 있게 실패 시 헬퍼 컨테이너로 우회한다
if ! mkdir -p "$BUNDLE"/{images,compose,config,data} 2>/dev/null; then
    docker run --rm -v /:/host "$HELPER_IMAGE" sh -c \
        "mkdir -p /host${BUNDLE}/images /host${BUNDLE}/compose /host${BUNDLE}/config /host${BUNDLE}/data \
         && chown -R $(id -u):$(id -g) /host${OUT_ROOT}" \
        || die "번들 디렉터리를 만들 수 없습니다: ${BUNDLE}"
fi
ok "번들 경로: ${BUNDLE}"

# ──────────────────────────────────────────────────────────────────────────
step "1/5 실행 중인 컨테이너에서 실제 이미지 ID 수집 및 태그 고정"

declare -A SVC_PIN      # "project|service" -> 고정 이미지 참조
declare -A PIN_ID       # 고정 이미지 참조   -> 이미지 ID
PIN_LIST=()

derive_pin() {
    local ref="$1" id="$2" repo tag ver bld env
    if [[ "${ref##*/}" == *:* ]]; then
        repo="${ref%:*}"; tag="${ref##*:}"
    else
        repo="$ref"; tag="latest"
    fi
    # 이미 버전이 박힌 태그는 그대로 쓴다 (mongo:7.0.22 등)
    if [ "$tag" != "latest" ]; then
        echo "$ref"; return
    fi
    env=$(docker image inspect "$id" --format '{{range .Config.Env}}{{println .}}{{end}}')
    ver=$(sed -n 's/^CLEARML_SERVER_VERSION=//p' <<<"$env" | head -1)
    bld=$(sed -n 's/^CLEARML_SERVER_BUILD=//p' <<<"$env" | head -1)
    if [ -n "$ver" ]; then
        echo "${repo}:${ver}-${bld:-0}"
    else
        echo "${repo}:pin-${BUNDLE_ID}"
    fi
}

for name in $(docker ps --format '{{.Names}}'); do
    read -r proj svc cfg_ref real_id < <(docker inspect "$name" --format \
        '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}} {{.Config.Image}} {{.Image}}')
    case "$proj" in
        "$CLEARML_PROJECT"|"$MONITORING_PROJECT") ;;
        *) continue ;;
    esac

    pin_ref="$(derive_pin "$cfg_ref" "$real_id")"
    SVC_PIN["${proj}|${svc}"]="$pin_ref"

    if [ "${PIN_ID[$pin_ref]:-}" != "$real_id" ]; then
        docker tag "$real_id" "$pin_ref"
        PIN_ID["$pin_ref"]="$real_id"
        PIN_LIST+=("$pin_ref")
    fi

    tagged_now=$(docker image inspect "$cfg_ref" --format '{{.Id}}' 2>/dev/null || echo "")
    if [ -n "$tagged_now" ] && [ "$tagged_now" != "$real_id" ]; then
        warn "${name}: 태그 ${cfg_ref} 가 실행 중인 이미지와 다름 → ${pin_ref} 로 고정"
    else
        ok "${name}: ${cfg_ref} → ${pin_ref}"
    fi
done

[ "${#PIN_LIST[@]}" -gt 0 ] || die "대상 컨테이너를 찾지 못했습니다 (스택이 떠 있어야 합니다)"

# 설치 스크립트가 root 권한 작업에 쓰는 헬퍼 이미지도 함께 넣는다
docker tag "$HELPER_IMAGE" "clearml-bundle-helper:${BUNDLE_ID}"
PIN_LIST+=("clearml-bundle-helper:${BUNDLE_ID}")

# 이미지 ID(= config JSON 의 sha256)는 save/load 를 거치면 재계산될 수 있다.
# 원본과 대상의 Docker 버전이나 이미지 스토어(containerd snapshotter vs 클래식 overlay2)가
# 다르면 config 가 다른 형식으로 다시 직렬화되기 때문이다. 레이어 내용은 그대로다.
# 그래서 검증 기준은 ID 가 아니라 RootFS 레이어 다이제스트로 잡는다.
layer_fingerprint() {
    docker image inspect "$1" --format '{{range .RootFS.Layers}}{{println .}}{{end}}' \
        | sha256sum | cut -d' ' -f1
}

: > "${BUNDLE}/images/image-map.txt"
for ref in "${PIN_LIST[@]}"; do
    printf '%s\t%s\t%s\n' "$ref" \
        "${PIN_ID[$ref]:-$(docker image inspect "$ref" --format '{{.Id}}')}" \
        "$(layer_fingerprint "$ref")" \
        >> "${BUNDLE}/images/image-map.txt"
done

# ──────────────────────────────────────────────────────────────────────────
IMAGES_TAR="${BUNDLE}/images/images-${BUNDLE_ID}.tar.gz"
if [ "$WITH_IMAGES" = 1 ]; then
step "2/5 이미지 저장 (수 GB, 수 분 소요)"
    docker save "${PIN_LIST[@]}" | $COMPRESS > "$IMAGES_TAR"
    ok "$(du -h "$IMAGES_TAR" | cut -f1)  ${IMAGES_TAR}"
else
step "2/5 이미지 저장 — 건너뜀 (--no-images)"
fi

# ──────────────────────────────────────────────────────────────────────────
step "3/5 compose 파일 이미지 고정"

pin_compose() {
    local proj="$1" src="$2" dst_dir="$3"
    mkdir -p "$dst_dir"
    local mapfile="${dst_dir}/image-pin.map"
    : > "$mapfile"
    for key in "${!SVC_PIN[@]}"; do
        [ "${key%%|*}" = "$proj" ] || continue
        printf 'SERVICE\t%s\t%s\n' "${key#*|}" "${SVC_PIN[$key]}" >> "$mapfile"
    done
    echo "  ${src}"
    python3 "${SCRIPT_DIR}/lib/pin_compose.py" "$src" "${dst_dir}/docker-compose.yml" "$mapfile"
}

pin_compose "$CLEARML_PROJECT"    "${CLEARML_DIR}/docker-compose.yml"    "${BUNDLE}/compose/clearml"
pin_compose "$MONITORING_PROJECT" "${MONITORING_DIR}/docker-compose.yml" "${BUNDLE}/compose/monitoring"

# 고정 정보는 "실행 중인" 컨테이너에서만 만들어진다. 서비스가 하나라도 꺼져 있으면
# 그 서비스만 :latest 인 채로 번들에 들어가고, 대상 서버는 오프라인 설치인데도
# Docker Hub 에서 최신판을 받아 온다. 그 최신판은 브랜딩 파일의 빌드 해시와 맞지 않아
# 순정 UI 가 뜬다. 조용히 넘어가면 안 되는 상황이라 여기서 끊는다.
mapfile -t BUNDLED_REFS < <(cut -f1 "${BUNDLE}/images/image-map.txt")
UNPINNED=0
for f in "${BUNDLE}/compose/clearml/docker-compose.yml" \
         "${BUNDLE}/compose/monitoring/docker-compose.yml"; do
    while IFS= read -r ref; do
        found=0
        for b in "${BUNDLED_REFS[@]}"; do
            if [ "$b" = "$ref" ]; then found=1; break; fi
        done
        [ "$found" = 1 ] && continue
        echo -e "  ${RED}✗${NC} ${f#"${BUNDLE}/compose/"} 의 ${ref} 가 번들 이미지 목록에 없습니다"
        UNPINNED=1
    done < <(sed -n 's/^ *image: *\([^ #]*\).*/\1/p' "$f" | sort -u)
done
if [ "$UNPINNED" = 1 ]; then
    warn "해당 서비스의 컨테이너가 꺼져 있었을 가능성이 큽니다"
    echo "         docker compose -p ${CLEARML_PROJECT} ps -a  로 확인하고 전부 띄운 뒤 다시 실행하세요"
    die "고정되지 않은 이미지가 있습니다 — 대상 서버가 Docker Hub 에서 최신판을 받게 됩니다"
fi
ok "compose 가 참조하는 이미지 전부 번들에 포함됨"

WEB_IMAGE="${SVC_PIN[${CLEARML_PROJECT}|webserver]:-}"
[ -n "$WEB_IMAGE" ] || die "webserver 컨테이너가 실행 중이 아닙니다 — 브랜딩 검증을 할 수 없습니다"
echo "  브랜딩 마운트 검증"
bash "${SCRIPT_DIR}/lib/check_mounts.sh" \
    "${BUNDLE}/compose/clearml/docker-compose.yml" webserver "$WEB_IMAGE" \
    || die "브랜딩 파일과 ClearML 이미지 버전이 맞지 않습니다"

# ──────────────────────────────────────────────────────────────────────────
if [ "$WITH_CONFIG" = 1 ]; then
step "4/5 호스트 설정 · 소스 아카이브"

# .env · apiserver.conf 는 서버 고유값이라 번들에 넣지 않는다.
# 대상 서버에서 cp .env.example .env → gen-secrets.sh · gen-auth.sh · apply-env.sh
tar_as_root "$CLEARML_DIR" "${BUNDLE}/config/opt-clearml.tar.gz" \
    ./data ./logs ./agent ./.env ./config/apiserver.conf \
    "*.tar" "*.swp" "*.swo" "*.bak-*"
ok "$(du -h "${BUNDLE}/config/opt-clearml.tar.gz" | cut -f1)  /opt/clearml (branding, nginx, model_eval_console, 스크립트)"
echo "         .env · config/apiserver.conf 제외"

# 모니터링 설정 — data/ · .env 제외 (통합 .env 는 clearml/.env)
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
rsync -a --exclude 'data' --exclude '.env' \
    "${MONITORING_DIR}/" "${STAGE}/"

SECRETS_DIR="${OUT_ROOT}/secrets-backup-${BUNDLE_ID}"
if [ -f "${CLEARML_DIR}/.env" ]; then
    mkdir -p "$SECRETS_DIR" && chmod 700 "$SECRETS_DIR"
    cp "${CLEARML_DIR}/.env" "${SECRETS_DIR}/mlops.env"
    chmod 600 "${SECRETS_DIR}/mlops.env"
    warn "원본 .env 백업: ${SECRETS_DIR}/mlops.env  ← 번들에 포함되지 않음"
fi

tar -C "$STAGE" --numeric-owner -cf - . | $COMPRESS > "${BUNDLE}/config/opt-clearml-monitoring.tar.gz"
rm -rf "$STAGE"; trap - EXIT
ok "$(du -h "${BUNDLE}/config/opt-clearml-monitoring.tar.gz" | cut -f1)  ${MONITORING_DIR} (grafana, prometheus, exporter)"

tar_as_root "$DATA_STUDIO_DIR" "${BUNDLE}/config/opt-data_studio.tar.gz" \
    ./node_modules ./dist ./release ./.git ./poly_test
ok "$(du -h "${BUNDLE}/config/opt-data_studio.tar.gz" | cut -f1)  ${DATA_STUDIO_DIR} (Data Studio build context)"
else
step "4/5 호스트 설정 · 소스 아카이브 — 건너뜀"
fi

# ──────────────────────────────────────────────────────────────────────────
if [ "$WITH_DATA" = 1 ]; then
step "5/5 데이터 백업"

    step_mongo() {
        docker exec clearml-mongo mongodump --archive --gzip \
            > "${BUNDLE}/data/mongo-dump.archive.gz"
        ok "$(du -h "${BUNDLE}/data/mongo-dump.archive.gz" | cut -f1)  mongo (프로젝트·태스크·사용자 메타데이터)"
    }

    if [ "$STOP_STACK" = 1 ]; then
        warn "정합성 있는 백업을 위해 스택을 내립니다"
        step_mongo
        (cd "$CLEARML_DIR" && ./compose.sh stop)
        (cd "$CLEARML_DIR" && ./monitoring-compose.sh stop 2>/dev/null) \
            || (cd "$MONITORING_DIR" && docker compose -p "$MONITORING_PROJECT" stop)
    else
        warn "스택이 떠 있는 상태로 백업합니다 (--stop 권장)"
        step_mongo
    fi

    tar_as_root "${CLEARML_DIR}/data/elastic_7" "${BUNDLE}/data/elastic_7.tar.gz"
    ok "$(du -h "${BUNDLE}/data/elastic_7.tar.gz" | cut -f1)  elasticsearch (실험 지표·로그)"

    tar_as_root "${CLEARML_DIR}/data/redis" "${BUNDLE}/data/redis.tar.gz"
    ok "$(du -h "${BUNDLE}/data/redis.tar.gz" | cut -f1)  redis"

    tar_as_root "${CLEARML_DIR}/data/datasets" "${BUNDLE}/data/datasets.tar.gz"
    ok "$(du -h "${BUNDLE}/data/datasets.tar.gz" | cut -f1)  datasets (data-studio 마운트)"

    tar_as_root "${MONITORING_DIR}/data/grafana" "${BUNDLE}/data/grafana.tar.gz"
    ok "$(du -h "${BUNDLE}/data/grafana.tar.gz" | cut -f1)  grafana (대시보드 수정본·사용자)"

    if [ "$WITH_PROMETHEUS" = 1 ]; then
        tar_as_root "${MONITORING_DIR}/data/prometheus" "${BUNDLE}/data/prometheus.tar.gz"
        ok "$(du -h "${BUNDLE}/data/prometheus.tar.gz" | cut -f1)  prometheus TSDB"
    else
        warn "prometheus TSDB 제외 (--with-prometheus 로 포함, 약 8GB)"
    fi

    if [ "$STOP_STACK" = 1 ]; then
        (cd "$CLEARML_DIR" && ./compose.sh start)
        (cd "$CLEARML_DIR" && ./monitoring-compose.sh start 2>/dev/null) \
            || (cd "$MONITORING_DIR" && docker compose -p "$MONITORING_PROJECT" start)
        ok "스택 재시작"
    fi
else
step "5/5 데이터 백업 — 건너뜀 (--with-data 로 포함)"
fi

# ──────────────────────────────────────────────────────────────────────────
step "매니페스트 생성"
cp "${SCRIPT_DIR}/install.sh" "${BUNDLE}/install.sh"
cp "${SCRIPT_DIR}/gen-secrets.sh" "${BUNDLE}/gen-secrets.sh"
cp "${SCRIPT_DIR}/gen-auth.sh" "${BUNDLE}/gen-auth.sh"
mkdir -p "${BUNDLE}/lib" && cp -r "${SCRIPT_DIR}/lib/." "${BUNDLE}/lib/"
chmod +x "${BUNDLE}/install.sh" "${BUNDLE}/gen-secrets.sh" "${BUNDLE}/gen-auth.sh"

FS_SIZE=$(docker run --rm -v "${CLEARML_DIR}/data/fileserver:/f:ro" "$HELPER_IMAGE" du -sh /f 2>/dev/null | cut -f1 || echo "?")

{
    echo "bundle_id       : ${BUNDLE_ID}"
    echo "created_at      : $(date -Is)"
    echo "source_host     : $(hostname)"
    echo "helper_image    : clearml-bundle-helper:${BUNDLE_ID}"
    echo "with_config     : ${WITH_CONFIG}"
    echo "with_data       : ${WITH_DATA}"
    echo "with_prometheus : ${WITH_PROMETHEUS}"
    echo "fileserver_size : ${FS_SIZE}  (번들에 미포함 — rsync 로 별도 전송)"
    echo
    echo "[고정 이미지]"
    sed 's/^/  /' "${BUNDLE}/images/image-map.txt"
} > "${BUNDLE}/MANIFEST.txt"

(cd "$BUNDLE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)

cat "${BUNDLE}/MANIFEST.txt"
echo
step "완료"
echo "  번들   : ${BUNDLE}  ($(du -sh "$BUNDLE" | cut -f1))"
echo
echo "  전송   : rsync -aHAX --info=progress2 ${BUNDLE} user@대상서버:/opt/"
if [ "$WITH_DATA" = 1 ]; then
    echo "  설치   : 대상 서버에서  cd /opt/clearml-bundle-${BUNDLE_ID} && ./install.sh --with-data"
    echo
    echo "  기존 실험의 아티팩트까지 살리려면 파일서버(${FS_SIZE})도 옮겨야 합니다:"
    echo "           sudo rsync -aHAX --info=progress2 ${CLEARML_DIR}/data/fileserver/ user@대상서버:${CLEARML_DIR}/data/fileserver/"
else
    echo "  설치   : 대상 서버에서  cd /opt/clearml-bundle-${BUNDLE_ID} && ./install.sh"
    echo
    echo "  데이터 미포함 번들입니다. 대상 서버는 빈 ClearML 로 시작하고"
    echo "  브랜딩·Data Studio·Grafana 대시보드·exporter 만 그대로 올라갑니다."
fi
echo
echo "  설정   : 대상 서버에서  cp /opt/clearml/.env.example /opt/clearml/.env"
echo "           vi /opt/clearml/.env  (IP · NFS · API 키 · 비밀번호)"
echo "           /opt/clearml/packaging/apply-env.sh --restart"