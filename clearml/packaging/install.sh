#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# ClearML 스택 오프라인 번들 설치 (대상 서버에서 실행)
#
#   pack.sh 가 만든 번들 디렉터리 안에서 실행한다.
#
#     ./install.sh                 # 이미지 + 설정 복원 후 기동
#     ./install.sh --with-data     # + mongo/elastic/grafana 데이터 복원 (기존 데이터 덮어씀)
#     ./install.sh --no-start      # 복원만 하고 기동은 수동으로
#     ./install.sh --verify-only   # 아무것도 바꾸지 않고 검증만
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CLEARML_DIR="${CLEARML_DIR:-/opt/clearml}"
MONITORING_ROOT="${MONITORING_ROOT:-/opt/clearml-monitoring}"
MONITORING_DIR="${MONITORING_DIR:-${MONITORING_ROOT}/monitoring-deploy}"
DATA_STUDIO_DIR="${DATA_STUDIO_DIR:-/opt/data_studio}"

CLEARML_PROJECT="${CLEARML_PROJECT:-clearml}"
MONITORING_PROJECT="${MONITORING_PROJECT:-monitoring-deploy}"

WITH_DATA=0
DO_START=1
VERIFY_ONLY=0

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; BLU=$'\033[0;34m'; NC=$'\033[0m'
step() { echo -e "\n${BLU}▶ $*${NC}"; }
ok()   { echo -e "  ${GRN}✓${NC} $*"; }
warn() { echo -e "  ${YEL}!${NC} $*"; }
die()  { echo -e "  ${RED}✗ $*${NC}" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --with-data)   WITH_DATA=1 ;;
        --no-start)    DO_START=0 ;;
        --verify-only) VERIFY_ONLY=1; DO_START=0 ;;
        -h|--help)     sed -n '2,14p' "$0"; exit 0 ;;
        *)             die "알 수 없는 옵션: $1" ;;
    esac
    shift
done

BUNDLE_ID="$(sed -n 's/^bundle_id *: *//p' "${BUNDLE_DIR}/MANIFEST.txt")"
HELPER="clearml-bundle-helper:${BUNDLE_ID}"

# ── root 권한 작업을 sudo 없이 헬퍼 컨테이너로 처리 ────────────────────────
as_root() { docker run --rm -v /opt:/opt "$HELPER" "$@"; }

untar_as_root() {  # <tar.gz> <대상 디렉터리>
    local archive="$1" dest="$2"
    as_root mkdir -p "$dest"
    gzip -dc "$archive" | docker run --rm -i -v /opt:/opt "$HELPER" \
        tar -C "$dest" --numeric-owner -xf -
}

# ──────────────────────────────────────────────────────────────────────────
step "사전 점검"
command -v docker >/dev/null || die "docker 없음"
docker info >/dev/null 2>&1 || die "docker 데몬에 접근할 수 없습니다"
docker compose version >/dev/null 2>&1 || die "docker compose v2 없음"
[ -f "${BUNDLE_DIR}/MANIFEST.txt" ] || die "MANIFEST.txt 없음 — 번들 디렉터리에서 실행하세요"
# root 권한 작업은 /opt 를 마운트한 헬퍼 컨테이너로 처리하므로 경로가 /opt 밑이어야 한다
for d in "$CLEARML_DIR" "$MONITORING_ROOT" "$DATA_STUDIO_DIR"; do
    case "$d" in /opt/*) ;; *) die "설치 경로는 /opt 하위여야 합니다: ${d}" ;; esac
done
ok "번들 ${BUNDLE_ID}"

step "체크섬 검증"
(cd "$BUNDLE_DIR" && sha256sum -c --quiet SHA256SUMS) || die "체크섬 불일치 — 전송이 손상되었습니다"
ok "SHA256 전부 일치"

# ──────────────────────────────────────────────────────────────────────────
step "1/6 이미지 로드"
IMAGES_TAR=$(ls "${BUNDLE_DIR}"/images/images-*.tar.gz 2>/dev/null | head -1 || true)
if [ "$VERIFY_ONLY" = 1 ]; then
    warn "검증 모드 — 로드 건너뜀"
elif [ -z "$IMAGES_TAR" ]; then
    warn "이미지 아카이브 없음 (--no-images 로 만든 번들) — 로드 건너뜀"
else
    gzip -dc "$IMAGES_TAR" | docker load
fi

# 이미지 ID 는 save/load 과정에서 재계산될 수 있다 (Docker 버전이나 이미지 스토어가
# 다르면 config JSON 이 다른 형식으로 다시 직렬화된다). 레이어 내용은 그대로이므로
# RootFS 레이어 다이제스트로 대조한다.
MISSING=0
while IFS=$'\t' read -r ref want_id want_fp; do
    [ -n "$ref" ] || continue
    have_id=$(docker image inspect "$ref" --format '{{.Id}}' 2>/dev/null || echo "")
    if [ -z "$have_id" ]; then
        echo -e "  ${RED}✗${NC} ${ref} 없음"; MISSING=1; continue
    fi
    have_fp=$(docker image inspect "$ref" --format '{{range .RootFS.Layers}}{{println .}}{{end}}' \
        | sha256sum | cut -d' ' -f1)

    if [ -z "$want_fp" ]; then
        # 레이어 지문이 없는 구버전 번들 — ID 로만 대조한다
        if [ "$have_id" = "$want_id" ]; then
            ok "${ref}  ${have_id:7:12}"
        else
            echo -e "  ${RED}✗${NC} ${ref} ID 불일치 (기대 ${want_id:7:12}, 실제 ${have_id:7:12})"; MISSING=1
        fi
    elif [ "$have_fp" != "$want_fp" ]; then
        echo -e "  ${RED}✗${NC} ${ref} 레이어 불일치 — 원본과 다른 이미지입니다"; MISSING=1
    elif [ "$have_id" != "$want_id" ]; then
        ok "${ref}  레이어 일치 (ID 는 ${have_id:7:12} 로 재계산됨 — 정상)"
    else
        ok "${ref}  ${have_id:7:12}"
    fi
done < "${BUNDLE_DIR}/images/image-map.txt"
[ "$MISSING" = 0 ] || die "이미지 검증 실패"

# ──────────────────────────────────────────────────────────────────────────
step "2/6 호스트 설정 · 소스 복원"
if [ "$VERIFY_ONLY" = 1 ]; then
    warn "검증 모드 — 건너뜀"
else
    restore() {  # <아카이브 파일명> <대상 디렉터리>
        local archive="${BUNDLE_DIR}/config/$1" dest="$2"
        [ -f "$archive" ] || { warn "$1 없음 — 건너뜀"; return; }
        untar_as_root "$archive" "$dest"
        ok "${dest}"
    }
    restore opt-clearml.tar.gz            "$CLEARML_DIR"
    restore opt-clearml-monitoring.tar.gz "$MONITORING_ROOT"
    restore opt-data_studio.tar.gz        "$DATA_STUDIO_DIR"

    # 고정 태그가 박힌 compose 로 교체 (원본은 .orig 로 보관)
    for pair in "clearml:${CLEARML_DIR}" "monitoring:${MONITORING_DIR}"; do
        src="${BUNDLE_DIR}/compose/${pair%%:*}/docker-compose.yml"
        dst="${pair#*:}/docker-compose.yml"
        [ -f "$dst" ] && as_root cp "$dst" "${dst}.orig"
        as_root cp "$src" "$dst"
        ok "$dst (이미지 고정본)"
    done
fi

# ──────────────────────────────────────────────────────────────────────────
step "3/6 브랜딩·설정 마운트 검증"
# 오프라인 설치인데 compose 가 로컬에 없는 이미지를 참조하면, 도커가 말없이
# Docker Hub 에서 최신판을 받아 온다. 원본 서버와 다른 버전이 뜨는 것과 같으므로
# 검증에 들어가기 전에 끊는다. (pack.sh 때 컨테이너가 꺼져 있으면 이렇게 된다)
for cf in "${BUNDLE_DIR}/compose/clearml/docker-compose.yml" \
          "${BUNDLE_DIR}/compose/monitoring/docker-compose.yml"; do
    [ -f "$cf" ] || continue
    while IFS= read -r ref; do
        docker image inspect "$ref" >/dev/null 2>&1 && continue
        echo -e "  ${RED}✗${NC} ${cf#"${BUNDLE_DIR}/compose/"} 의 ${ref} 가 로컬에 없습니다"
        die "번들에 고정되지 않은 이미지입니다 — 원본 서버에서 스택을 전부 띄우고 pack.sh 를 다시 실행하세요"
    done < <(sed -n 's/^ *image: *\([^ #]*\).*/\1/p' "$cf" | sort -u)
done
ok "compose 가 참조하는 이미지 전부 로컬에 있음 (Docker Hub 접속 없음)"

WEB_IMAGE=$(python3 -c "
import yaml,sys
d=yaml.safe_load(open('${BUNDLE_DIR}/compose/clearml/docker-compose.yml'))
print(d['services']['webserver']['image'])
")
bash "${BUNDLE_DIR}/lib/check_mounts.sh" \
    "${BUNDLE_DIR}/compose/clearml/docker-compose.yml" webserver "$WEB_IMAGE" \
    || die "브랜딩 파일이 ClearML 이미지 버전과 맞지 않습니다"

for f in "${CLEARML_DIR}/branding/index.html" \
         "${CLEARML_DIR}/nginx/default.d/data-studio.conf" \
         "${MONITORING_DIR}/config/grafana/dashboards/clearml-mlops.json" \
         "${MONITORING_DIR}/.env"; do
    [ -e "$f" ] && ok "$f" || warn "$f 없음"
done

# ──────────────────────────────────────────────────────────────────────────
step "4/6 데이터 디렉터리 준비"
# bind mount 대상이 없으면 도커가 root 소유로 만들어 버려서 Elasticsearch(1000) /
# Prometheus(65534) / Grafana(472) 가 자기 데이터 디렉터리에 못 쓴다.
# 없는 디렉터리만 만들고, 새로 만든 것만 chown 한다 (복원한 데이터는 건드리지 않는다).
if [ "$VERIFY_ONLY" = 1 ]; then
    warn "검증 모드 — 건너뜀"
else
    # "경로 uid:gid" 목록. ClearML 공식 설치 문서 기준으로 /opt/clearml 은 1000:1000.
    DIR_SPEC=""
    for d in data/elastic_7 data/mongo_4/db data/mongo_4/configdb data/redis \
             data/fileserver data/datasets logs config agent model_eval_console/data; do
        DIR_SPEC+="${CLEARML_DIR}/${d} 1000:1000"$'\n'
    done
    DIR_SPEC+="${MONITORING_DIR}/data/prometheus 65534:65534"$'\n'
    DIR_SPEC+="${MONITORING_DIR}/data/grafana 472:472"$'\n'

    printf '%s' "$DIR_SPEC" | docker run --rm -i -v /opt:/opt "$HELPER" sh -c '
        while read -r path owner; do
            [ -n "$path" ] || continue
            if [ -d "$path" ]; then
                echo "  = $path"
            else
                mkdir -p "$path" && chown -R "$owner" "$path" && echo "  + $path  ($owner)"
            fi
        done'
    ok "데이터 디렉터리 확인 완료 (+ 새로 만듦, = 기존 유지)"

    # ClearML 기본 JWT 서명 키는 GitHub 에 공개돼 있어서 서버끼리 토큰이 통용된다.
    # 서버마다 다른 키를 넣어야 낡은 토큰이 401 로 떨어지고 로그인 화면이 정상으로 뜬다.
    bash "${BUNDLE_DIR}/gen-secrets.sh" || die "서명 키 생성 실패"
fi

# ──────────────────────────────────────────────────────────────────────────
step "5/6 데이터 복원"
if [ "$WITH_DATA" = 0 ]; then
    warn "건너뜀 — 빈 ClearML 로 시작합니다 (신규 서버 구축이면 정상)"
elif [ "$VERIFY_ONLY" = 1 ]; then
    warn "검증 모드 — 건너뜀"
else
    restore_data() {  # <아카이브 파일명> <대상 디렉터리>
        local archive="${BUNDLE_DIR}/data/$1" dest="$2"
        [ -f "$archive" ] || { warn "$1 없음 — 건너뜀"; return; }
        case "$dest" in /opt/*/*) ;; *) die "안전하지 않은 복원 경로: ${dest}" ;; esac
        as_root rm -rf "$dest"
        untar_as_root "$archive" "$dest"
        ok "${dest}"
    }
    restore_data elastic_7.tar.gz  "${CLEARML_DIR}/data/elastic_7"
    restore_data redis.tar.gz      "${CLEARML_DIR}/data/redis"
    restore_data datasets.tar.gz   "${CLEARML_DIR}/data/datasets"
    restore_data grafana.tar.gz    "${MONITORING_DIR}/data/grafana"
    restore_data prometheus.tar.gz "${MONITORING_DIR}/data/prometheus"

    # 컨테이너가 non-root 로 뜨므로 소유권을 다시 맞춘다
    as_root chown -R 65534:65534 "${MONITORING_DIR}/data/prometheus" 2>/dev/null || true
    as_root chown -R 472:472     "${MONITORING_DIR}/data/grafana"    2>/dev/null || true
    ok "prometheus(65534) · grafana(472) 소유권 설정"

    # mongo 는 덤프 복원이라 mongo 컨테이너가 먼저 떠 있어야 한다
    if [ -f "${BUNDLE_DIR}/data/mongo-dump.archive.gz" ]; then
        (cd "$CLEARML_DIR" && ./compose.sh up -d --no-build mongo)
        for _ in $(seq 1 30); do
            docker exec clearml-mongo mongosh --quiet --eval 'db.runCommand({ping:1})' >/dev/null 2>&1 && break
            sleep 2
        done
        docker exec -i clearml-mongo mongorestore --archive --gzip --drop \
            < "${BUNDLE_DIR}/data/mongo-dump.archive.gz"
        ok "mongo 복원"
    fi
fi

# ──────────────────────────────────────────────────────────────────────────
step "6/6 기동"
if [ "$DO_START" = 0 ]; then
    warn "건너뜀"
    echo
    echo "  수동 기동:"
    echo "    cd ${CLEARML_DIR}    && ./compose.sh up -d --no-build"
    echo "    cd ${MONITORING_DIR} && docker compose -p ${MONITORING_PROJECT} up -d --no-build"
else
    # --no-build: 번들에 담긴 이미지를 쓰고, 없으면 조용히 재빌드하는 대신 실패시킨다
    (cd "$CLEARML_DIR"    && ./compose.sh up -d --no-build)
    (cd "$MONITORING_DIR" && docker compose -p "$MONITORING_PROJECT" up -d --no-build)
    sleep 20
    docker compose -p "$CLEARML_PROJECT" ps 2>/dev/null || (cd "$CLEARML_DIR" && ./compose.sh ps)
    docker compose -p "$MONITORING_PROJECT" ps
fi

step "서버 주소 확인"
# 주소는 servers.conf 한 곳에서 관리한다. 여기 값이 원본 서버 그대로면 알려준다.
SERVERS_CONF="${CLEARML_DIR}/servers.conf"
if [ -f "$SERVERS_CONF" ]; then
    CONF_IP=$(sed -n 's/^CLEARML_SERVER_IP=//p' "$SERVERS_CONF" | head -1)
    HOST_IPS=$(hostname -I 2>/dev/null || echo "")
    if [ -n "$CONF_IP" ] && ! grep -qw "$CONF_IP" <<<"$HOST_IPS"; then
        warn "servers.conf 의 CLEARML_SERVER_IP 가 ${CONF_IP} 로, 이 서버(${HOST_IPS% }) 주소가 아닙니다."
        echo "         주소는 이 파일 하나만 고치면 됩니다:"
        echo "           ${SERVERS_CONF}"
        echo "         고친 뒤 반영:"
        echo "           ${CLEARML_DIR}/packaging/apply-servers.sh --restart"
    else
        ok "servers.conf 의 주소가 이 서버와 일치합니다 (${CONF_IP})"
    fi
else
    warn "${SERVERS_CONF} 없음 — 주소를 각 .env 에서 직접 고쳐야 합니다"
fi
[ -f "${CLEARML_DIR}/secrets/.env" ] || warn "${CLEARML_DIR}/secrets/.env 없음 — agent-services 자격증명·호스트 주소가 비어 있습니다"

step "서명 키 확인"
# 기본 키를 그대로 쓰면 다른 서버가 발급한 토큰이 서명 검증을 통과해서
# 낡은 쿠키가 401 대신 400 을 받고, UI 헤더·사이드바가 안 그려진다.
if grep -qE '^CLEARML_TOKEN_SECRET=.' "${CLEARML_DIR}/secrets/.env" 2>/dev/null; then
    ok "이 서버 고유 JWT 서명 키 사용 중"
else
    warn "서명 키가 없습니다 — ClearML 기본 공개 키를 쓰게 됩니다"
    echo "         ${CLEARML_DIR}/packaging/gen-secrets.sh"
fi

# 번들에는 GitLab 토큰이 비워진 채로 들어온다
if grep -q '^GITLAB_TOKEN=$' "${MONITORING_DIR}/.env" 2>/dev/null; then
    warn "GITLAB_TOKEN 이 비어 있습니다 (번들에서 제외됨)."
    echo "         GitLab 커밋 현황 패널만 빈 채로 뜨고 나머지 지표는 정상입니다."
    echo "         필요하면 ${MONITORING_DIR}/.env 에 토큰을 넣고 exporter 를 재시작하세요."
fi

step "완료"
if [ "$WITH_DATA" = 0 ]; then
    echo "  빈 ClearML 로 기동했습니다. 다음 순서로 마무리하세요:"
    echo "    1. ${SERVERS_CONF} 에서 서버 주소 수정 후"
    echo "         ${CLEARML_DIR}/packaging/apply-servers.sh --restart"
    echo "    2. http://<이 서버>:8080 접속 → 첫 사용자 생성"
    echo "       (예전에 접속한 적 있으면 시크릿 창으로 열 것)"
    echo "    3. 프로필 → Settings → Workspace → Create new credentials"
    echo "    4. 발급한 키를 ${MONITORING_DIR}/.env 의"
    echo "       CLEARML_ACCESS_KEY / CLEARML_SECRET_KEY 에 넣고 exporter 재시작:"
    echo "         cd ${MONITORING_DIR} && docker compose -p ${MONITORING_PROJECT} up -d --no-build clearml-exporter"
else
    FS="${CLEARML_DIR}/data/fileserver"
    if [ -z "$(ls -A "$FS" 2>/dev/null)" ]; then
        warn "메타데이터는 복원됐지만 ${FS} 가 비어 있습니다."
        echo "         기존 실험의 아티팩트·모델 다운로드가 404 가 됩니다. 필요하면 원본에서 옮기세요:"
        echo "         sudo rsync -aHAX --info=progress2 원본서버:${FS}/ ${FS}/"
    fi
fi
