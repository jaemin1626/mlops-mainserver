#!/usr/bin/env bash
# 특정 서비스의 bind mount 대상 경로가 이미지 안에 실제로 존재하는지 검사한다.
#
# ClearML 웹 UI 브랜딩은 `main-MY7YNF44.js` 처럼 빌드 해시가 박힌 파일을 덮어쓰는
# 방식이라 ClearML 버전이 바뀌면 파일명이 통째로 달라진다. 그 경우 마운트는
# 조용히 성공하지만 아무도 참조하지 않는 파일이 하나 생길 뿐이라 UI 는 순정으로
# 보인다. 이 검사는 배포 전에 그 상황을 잡아낸다.
#
#   해시가 박힌 파일이 이미지에 없으면  → 오류 (버전 불일치가 확실함)
#   그 외 파일이 이미지에 없으면        → 경고 (configuration.json 처럼 새로 추가하는 파일일 수 있음)
#
# rehash-branding.sh 로 파일명을 새 해시로 바꿨다면 새 이름은 당연히 이미지에 없다.
# 그래서 branding/rehash.map 을 읽어 새 이름을 순정 원본 이름으로 되돌린 뒤 검사한다.
# 버전 불일치를 잡아내는 능력은 그대로 유지된다.
#
# 사용법: check_mounts.sh <compose.yml> <service> <image> [경로 접두사]
set -euo pipefail

COMPOSE_FILE="$1"
SERVICE="$2"
IMAGE="$3"
PREFIX="${4:-/usr/share/nginx/html}"

MAP_FILE="${REHASH_MAP:-/opt/clearml/branding/rehash.map}"

# 이미지가 로컬에 없으면 docker run 이 조용히 Docker Hub 에서 받아 온다.
# 그러면 "번들에 담긴 버전" 이 아니라 "오늘자 최신판" 을 검사하게 되므로 무의미하다.
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
    echo "  [실패] ${IMAGE} 가 로컬에 없습니다 — 검사를 위해 Docker Hub 에서 받지 않습니다" >&2
    exit 1
}

# 예: main-MY7YNF44.js, chunk-XWAPV62X.js, c-logomark-FR6YLILN.svg
HASHED_RE='-[A-Z0-9]{8}\.[a-z]+$'

# 새 이름 -> 순정 원본 이름
declare -A ORIGIN
if [ -f "$MAP_FILE" ]; then
    while IFS=$'\t' read -r new orig; do
        case "$new" in ''|'#'*) continue ;; esac
        [ -n "$orig" ] && ORIGIN["$new"]="$orig"
    done < "$MAP_FILE"
fi

# 이미지 안에서 실제로 찾아볼 경로로 바꾼다
to_image_path() {
    local target="$1" base="${1##*/}"
    if [ -n "${ORIGIN[$base]:-}" ]; then
        echo "${target%/*}/${ORIGIN[$base]}"
    else
        echo "$target"
    fi
}

mapfile -t TARGETS < <(python3 - "$COMPOSE_FILE" "$SERVICE" "$PREFIX" <<'PY'
import sys, yaml

compose_file, service, prefix = sys.argv[1:4]
with open(compose_file, encoding="utf-8") as fh:
    doc = yaml.safe_load(fh)

for volume in (doc.get("services", {}).get(service, {}) or {}).get("volumes", []) or []:
    if isinstance(volume, dict):
        target = volume.get("target", "")
    else:
        parts = volume.split(":")
        target = parts[1] if len(parts) > 1 else ""
    if target.startswith(prefix):
        print(target)
PY
)

if [ "${#TARGETS[@]}" -eq 0 ]; then
    echo "  검사 대상 마운트 없음 (${SERVICE} → ${PREFIX})"
    exit 0
fi

LOOKUP=()
REHASHED=0
for t in "${TARGETS[@]}"; do
    resolved="$(to_image_path "$t")"
    [ "$resolved" != "$t" ] && REHASHED=$((REHASHED + 1))
    LOOKUP+=("$resolved")
done
[ "$REHASHED" -gt 0 ] && echo "  rehash.map 으로 ${REHASHED}개 파일을 순정 이름으로 되돌려 검사합니다"

MISSING=$(docker run --rm --entrypoint sh "$IMAGE" -c '
for p in "$@"; do
    [ -e "$p" ] || echo "$p"
done' _ "${LOOKUP[@]}")

FATAL=""
SOFT=""
while IFS= read -r path; do
    [ -n "$path" ] || continue
    if [[ "$path" =~ $HASHED_RE ]]; then
        FATAL+="         - ${path}"$'\n'
    else
        SOFT+="         - ${path}"$'\n'
    fi
done <<< "$MISSING"

if [ -n "$SOFT" ]; then
    echo "  [경고] 이미지에 없지만 새로 추가되는 파일 (의도한 것이면 무시):"
    printf '%s' "$SOFT"
fi

if [ -n "$FATAL" ]; then
    echo "  [실패] 빌드 해시가 박힌 파일이 ${IMAGE} 안에 없습니다:" >&2
    printf '%s' "$FATAL" >&2
    echo "         브랜딩 파일을 추출한 ClearML 버전과 이미지 버전이 다릅니다." >&2
    echo "         → 원본 버전 이미지로 고정하거나, 새 버전에서 브랜딩을 다시 추출하세요." >&2
    exit 1
fi

OK_COUNT=$(( ${#TARGETS[@]} - $(printf '%s' "$SOFT" | grep -c . || true) ))
echo "  [정상] ${SERVICE} 마운트 ${OK_COUNT}/${#TARGETS[@]} 개가 ${IMAGE} 안에 존재 (해시 파일 불일치 없음)"
