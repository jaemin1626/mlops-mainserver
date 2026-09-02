#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# 브랜딩 파일에 내용 기반 해시를 다시 매긴다.
#
#   ClearML 웹 자산은 main-MY7YNF44.js 처럼 파일명에 내용 해시가 박혀 있다.
#   "이름이 같으면 내용도 같다" 는 약속이고, 브라우저는 이걸 믿고 캐시를 쓴다.
#   브랜딩은 순정 파일 위에 다른 내용을 덮어쓰면서 이름은 그대로 두므로
#   이 약속이 깨진다. 그래서 예전에 순정 ClearML 을 봤던 브라우저는 계속
#   순정 화면을 보여준다. 캐시를 손으로 지우기 전까지.
#
#   이 스크립트는 브랜딩 파일의 해시를 실제 내용으로 다시 계산해서 이름을 바꾸고,
#   참조하는 곳(index.html, 다른 브랜딩 js, docker-compose.yml)을 같이 고친다.
#   브라우저가 처음 보는 이름이 되므로 안 받을 수가 없다.
#
#   내용이 안 바뀌었으면 같은 이름이 나오므로 여러 번 돌려도 안전하다.
#
# ── 이름을 바꿔선 안 되는 파일 ─────────────────────────────────────────────
#
#   브랜딩 파일을 참조하는 곳이 순정 이미지 안에만 있는 경우가 있다. 그런 파일은
#   이름을 바꾸면 순정 참조가 옛 이름을 계속 요청하고, 그 경로에는 순정 내용이
#   남아 있으므로 브랜딩이 조용히 풀린다. 같은 모듈이 두 벌 로드되기도 한다.
#
#   그런 파일은 branding/rehash-exclude 에 한 줄씩 적어 두면 건너뛴다.
#   '#' 로 시작하는 줄은 주석이다.
#
#   참조가 순정 이미지 안에만 있는지 확인하는 방법:
#     for f in $(curl -s localhost:8080/ | grep -o '[a-z-]*-[A-Z0-9]\{8\}\.js'); do
#         curl -s "localhost:8080/$f" | grep -l '찾는이름' && echo "$f"
#     done
#
#   사용법:
#     ./rehash-branding.sh --dry-run   # 뭘 바꿀지만 보여준다
#     ./rehash-branding.sh             # 실제로 바꾼다 (백업 후)
#     ./rehash-branding.sh --verify    # 참조가 깨진 데 없는지만 검사
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEARML_DIR="${CLEARML_DIR:-/opt/clearml}"
BRANDING_DIR="${BRANDING_DIR:-${CLEARML_DIR}/branding}"
COMPOSE_FILE="${COMPOSE_FILE:-${CLEARML_DIR}/docker-compose.yml}"
MAP_FILE="${BRANDING_DIR}/rehash.map"
EXCLUDE_FILE="${BRANDING_DIR}/rehash-exclude"

DRY_RUN=0
VERIFY=0

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[1;33m'; BLU=$'\033[0;34m'; NC=$'\033[0m'
step() { echo -e "\n${BLU}▶ $*${NC}"; }
ok()   { echo -e "  ${GRN}✓${NC} $*"; }
warn() { echo -e "  ${YEL}!${NC} $*"; }
die()  { echo -e "  ${RED}✗ $*${NC}" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --verify)  VERIFY=1 ;;
        -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
        *) die "알 수 없는 옵션: $1" ;;
    esac
    shift
done

[ -d "$BRANDING_DIR" ] || die "${BRANDING_DIR} 없음"
[ -f "$COMPOSE_FILE" ] || die "${COMPOSE_FILE} 없음"

run_pass() {
    python3 - "$BRANDING_DIR" "$COMPOSE_FILE" "$MAP_FILE" "$DRY_RUN" "$VERIFY" \
              "$EXCLUDE_FILE" "$1" <<'PY'
import hashlib
import os
import re
import shutil
import sys
import time

branding_dir, compose_file, map_file, dry_run, verify, exclude_file, skip_backup = sys.argv[1:8]
dry_run = dry_run == "1"
verify = verify == "1"
skip_backup = skip_backup == "1"

GRN, YEL, RED, NC = "\033[0;32m", "\033[1;33m", "\033[0;31m", "\033[0m"
def ok(m):   print(f"  {GRN}✓{NC} {m}")
def warn(m): print(f"  {YEL}!{NC} {m}")
def bad(m):  print(f"  {RED}✗{NC} {m}")

# 해시가 박힌 자산만 대상으로 한다. logo.svg 처럼 고정 이름인 파일은
# 앱 코드가 경로를 박아 쓰므로 이름을 바꿀 수 없다.
HASHED = re.compile(r"^(?P<stem>.+)-(?P<hash>[A-Z0-9]{8})\.(?P<ext>js|css|svg)$")
# 참조를 찾아 고칠 텍스트 파일
TEXT_EXT = (".js", ".css", ".html", ".json", ".map")
# 이 스크립트 자신의 기록 파일. rehash.map 은 확장자가 .map 이라 TEXT_EXT 에
# 걸리는데, 여기에 적힌 "순정 원본 이름" 이 새 이름으로 치환되면 기록이
# 무의미해진다. 참조 검사와 수정 양쪽에서 제외한다.
BOOKKEEPING = ("rehash.map", "rehash-exclude")


def short_hash(path: str, self_name: str) -> str:
    """내용 sha256 을 파일명에 쓸 수 있는 8자 [A-Z0-9] 로 줄인다.

    자기 이름을 자기 안에서 참조하는 파일이 있다(main-*.js 가 그렇다).
    그 이름을 그대로 해시에 넣으면 "이름 → 해시 → 새 이름 → 다른 해시" 가
    끝없이 반복되어 수렴하지 않는다. 자기 이름은 가린 뒤 해시한다.
    """
    data = open(path, "rb").read().replace(self_name.encode(), b"__SELF__")
    digest = hashlib.sha256(data).digest()
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"   # base32 문자셋
    value = int.from_bytes(digest[:8], "big")
    out = []
    for _ in range(8):
        out.append(alphabet[value & 31])
        value >>= 5
    return "".join(out)


def load_map() -> dict:
    """이전 실행 기록. 새 이름 -> 원래(순정) 이름."""
    result = {}
    if os.path.exists(map_file):
        for line in open(map_file, encoding="utf-8"):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            new, _, orig = line.partition("\t")
            if orig:
                result[new] = orig
    return result


def load_excluded() -> dict:
    """이름을 바꾸면 안 되는 파일. 파일명 -> 이유.

    파일명 바로 앞에 붙어 있는 주석 줄들을 그 파일의 이유로 본다.
    빈 줄이 나오면 주석 묶음이 끊긴 것으로 처리한다.
    """
    result = {}
    if os.path.exists(exclude_file):
        reason = []
        for line in open(exclude_file, encoding="utf-8"):
            line = line.strip()
            if line.startswith("#"):
                reason.append(line.lstrip("#").strip())
            elif not line:
                reason = []
            else:
                result[line] = " ".join(x for x in reason if x)
                reason = []
    return result


prev = load_map()
excluded = load_excluded()

# ── 이름을 바꿀 파일 목록 만들기 ───────────────────────────────────────────
renames = {}      # 현재 이름 -> 새 이름
origin_of = {}    # 새 이름 -> 순정 원래 이름 (버전 검증용)

for name in sorted(os.listdir(branding_dir)):
    path = os.path.join(branding_dir, name)
    if not os.path.isfile(path):
        continue
    m = HASHED.match(name)
    if not m:
        continue
    if name in excluded:
        # 이름을 바꾸면 순정 참조가 깨진다. origin_of 에는 넣어 둬야
        # check_mounts.sh 의 버전 검증에서 빠지지 않는다.
        origin_of[name] = prev.get(name, name)
        continue
    new_name = f"{m['stem']}-{short_hash(path, name)}.{m['ext']}"
    # 이 파일이 예전에 한 번 이름이 바뀌었다면 순정 이름은 기록에서 가져온다
    origin = prev.get(name, name)
    origin_of[new_name] = origin
    if new_name != name:
        renames[name] = new_name

if excluded:
    print("\n\033[0;34m▶ 제외 (rehash-exclude)\033[0m")
    for name, reason in sorted(excluded.items()):
        missing = "" if os.path.exists(os.path.join(branding_dir, name)) else "   (branding/ 에 없음)"
        print(f"    {name}{missing}")
        if reason:
            print(f"      이유: {reason}")

# ── 검증 모드 ──────────────────────────────────────────────────────────────
if verify:
    print("\n\033[0;34m▶ 참조 검사\033[0m")
    problems = 0
    referenced = set()
    for name in os.listdir(branding_dir):
        if not name.endswith(TEXT_EXT) or name in BOOKKEEPING:
            continue
        text = open(os.path.join(branding_dir, name), encoding="utf-8", errors="replace").read()
        for ref in re.findall(r"[A-Za-z0-9_.-]+-[A-Z0-9]{8}\.(?:js|css|svg)", text):
            referenced.add(ref)
    for ref in sorted(referenced):
        if os.path.exists(os.path.join(branding_dir, ref)):
            ok(f"{ref}  참조 → 파일 있음")
        else:
            # 순정 이미지 안에 있는 파일을 가리키는 정상적인 참조일 수 있다
            warn(f"{ref}  참조 → branding/ 에 없음 (순정 이미지 파일이면 정상)")
    if renames:
        bad("내용과 파일명이 어긋난 파일이 있습니다. --dry-run 으로 확인하세요:")
        for old, new in renames.items():
            print(f"         {old}  →  {new}")
        problems += 1
    else:
        ok("모든 브랜딩 파일의 이름이 내용과 일치합니다")
    sys.exit(1 if problems else 0)

# ── 바꿀 게 없으면 종료 ────────────────────────────────────────────────────
print("\n\033[0;34m▶ 대상\033[0m")
if not renames:
    ok("모든 브랜딩 파일의 이름이 이미 내용과 일치합니다 — 바꿀 것 없음")
    sys.exit(0)

for old, new in renames.items():
    print(f"    {old}")
    print(f"      → {new}   (순정 원본: {origin_of[new]})")

# ── 참조를 고칠 파일 찾기 ──────────────────────────────────────────────────
targets = []
for name in sorted(os.listdir(branding_dir)):
    if name in BOOKKEEPING:
        continue
    if name.endswith(TEXT_EXT) and os.path.isfile(os.path.join(branding_dir, name)):
        targets.append(os.path.join(branding_dir, name))
targets.append(compose_file)

print("\n\033[0;34m▶ 참조 수정 대상\033[0m")
hits = {}
for path in targets:
    text = open(path, encoding="utf-8", errors="replace").read()
    found = {old: text.count(old) for old in renames if old in text}
    if found:
        hits[path] = found
        detail = ", ".join(f"{k}×{v}" for k, v in found.items())
        print(f"    {path}\n      {detail}")
if not hits:
    warn("참조하는 곳이 하나도 없습니다 — 파일명만 바꾸면 아무도 안 읽습니다")

if dry_run:
    print("\n  --dry-run 이라 실제로는 바꾸지 않았습니다.")
    sys.exit(0)

# ── 백업 후 적용 ───────────────────────────────────────────────────────────
# 두 번째 통과부터는 백업하지 않는다. 첫 통과의 백업이 원래 상태다.
if not skip_backup:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup_dir = f"{branding_dir}.bak-{stamp}"
    shutil.copytree(branding_dir, backup_dir)
    shutil.copy2(compose_file, f"{compose_file}.bak-{stamp}")
    print(f"\n\033[0;34m▶ 백업\033[0m")
    ok(backup_dir)
    ok(f"{compose_file}.bak-{stamp}")

print("\n\033[0;34m▶ 참조 수정\033[0m")
for path, found in hits.items():
    text = open(path, encoding="utf-8", errors="replace").read()
    for old in found:
        text = text.replace(old, renames[old])
    open(path, "w", encoding="utf-8").write(text)
    ok(path)

print("\n\033[0;34m▶ 파일명 변경\033[0m")
for old, new in renames.items():
    os.rename(os.path.join(branding_dir, old), os.path.join(branding_dir, new))
    ok(f"{old}  →  {new}")

# ── 기록 남기기 ────────────────────────────────────────────────────────────
# check_mounts.sh 가 "이 새 이름의 순정 원본은 무엇인가" 를 알아야
# ClearML 이미지 버전 검증을 계속할 수 있다.
with open(map_file, "w", encoding="utf-8") as fh:
    fh.write("# 새 파일명\t순정 원본 파일명\n")
    fh.write("# rehash-branding.sh 가 만든다. check_mounts.sh 가 버전 검증에 쓴다.\n")
    for new in sorted(origin_of):
        fh.write(f"{new}\t{origin_of[new]}\n")
ok(map_file)

# 참조를 고치면 그 파일의 내용이 바뀌므로 해시도 달라진다. 호출한 쪽이
# 한 번 더 돌려야 한다는 뜻으로 3 을 돌려준다.
sys.exit(3)
PY
}

if [ "$VERIFY" = 1 ] || [ "$DRY_RUN" = 1 ]; then
    run_pass 0
    exit $?
fi

# 한 번 통과로는 끝나지 않는다. main.js 안의 청크 참조를 고치면 main.js 의
# 내용이 바뀌고, 그러면 main.js 의 해시도 다시 계산해야 한다. 더 바꿀 것이
# 없을 때까지 반복한다. 자기 이름은 해시에서 가리므로 반드시 수렴한다.
PASS=1
SKIP_BACKUP=0
while :; do
    [ "$PASS" -gt 1 ] && echo -e "\n${BLU}▶ ${PASS}차 통과${NC}"
    set +e
    run_pass "$SKIP_BACKUP"
    RC=$?
    set -e
    [ "$RC" = 0 ] && break
    [ "$RC" = 3 ] || exit "$RC"
    SKIP_BACKUP=1
    PASS=$((PASS + 1))
    [ "$PASS" -gt 6 ] && die "6회 반복해도 이름이 안정되지 않았습니다"
done

step "Dockerfile.webserver 갱신 (옛 순정 URL → branding COPY)"
python3 - "${BRANDING_DIR}" "${BRANDING_DIR}/rehash.map" "${BRANDING_DIR}/Dockerfile.webserver" <<'PY'
import os, sys
branding_dir, map_file, dockerfile = sys.argv[1:4]
pairs = []
for line in open(map_file, encoding="utf-8"):
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    new, _, orig = line.partition("\t")
    if new and orig:
        pairs.append((new, orig))
def dest(name):
    if name.startswith("c-logomark-") and name.endswith(".svg"):
        return f"/usr/share/nginx/html/media/{name}"
    return f"/usr/share/nginx/html/{name}"
static = ["index.html","configuration.json","favicon.ico","logo.svg","logo-white.svg","small-logo.svg","small-logo-white.svg","c-logomark.svg"]
static_dest = {"favicon.ico":["/usr/share/nginx/html/favicon.ico","/usr/share/nginx/html/assets/favicon.ico"],"logo.svg":["/usr/share/nginx/html/assets/logo.svg"],"logo-white.svg":["/usr/share/nginx/html/assets/logo-white.svg"],"small-logo.svg":["/usr/share/nginx/html/assets/small-logo.svg"],"small-logo-white.svg":["/usr/share/nginx/html/assets/small-logo-white.svg"],"c-logomark.svg":["/usr/share/nginx/html/app/webapp-common/assets/icons/c-logomark.svg"],"index.html":["/usr/share/nginx/html/index.html"],"configuration.json":["/usr/share/nginx/html/configuration.json"]}
lines = ["FROM clearml/server:2.3.0-705","","COPY nginx/default.d/cache-control.conf /etc/nginx/default.d/cache-control.conf","COPY nginx/default.d/index-no-store.conf /etc/nginx/default.d/index-no-store.conf","COPY nginx/default.d/cache-bust.conf /etc/nginx/default.d/cache-bust.conf","COPY nginx/default.d/data-studio.conf /etc/nginx/default.d/data-studio.conf",""]
for f in static:
    for d in static_dest[f]:
        lines.append(f"COPY branding/{f} {d}")
for new, orig in sorted(pairs, key=lambda x: x[1]):
    if not os.path.isfile(os.path.join(branding_dir, new)):
        continue
    lines.append(f"COPY branding/{new} {dest(new)}")
    if new != orig:
        lines.append(f"COPY branding/{new} {dest(orig)}")
        print(f"  {orig}  ←  {new}")
open(dockerfile,"w",encoding="utf-8").write("\n".join(lines)+"\n")
PY

step "다음 단계"
echo "  webserver 이미지를 다시 굽고 재생성하세요 (bind mount 대신 이미지에 branding 포함):"
echo "    sudo bash ${SCRIPT_DIR}/build-webserver-image.sh"
echo "    cd ${CLEARML_DIR} && docker compose -p clearml up -d --force-recreate webserver"
echo
echo "  확인:"
echo "    curl -sI http://localhost:8080/dashboard | head -1   # 302 → ?ivx=1"
echo "    curl -s http://localhost:8080/dashboard?ivx=1 | grep -o 'main-[A-Z0-9]*\\.js'"
echo "    ${SCRIPT_DIR}/rehash-branding.sh --verify"
