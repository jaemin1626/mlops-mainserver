#!/usr/bin/env bash
# /opt 전체를 mlops-mainserver 하나의 repo에 올린다.
#
#   bash /opt/git-push.sh          # add + commit + push
#   bash /opt/git-push.sh --check  # add 전 상태만 확인
set -euo pipefail

cd /opt
REMOTE="${GIT_REMOTE:-http://172.16.8.64:1541/woals1626/mlops-mainserver.git}"

if [ ! -f /opt/.gitignore ]; then
    echo "오류: /opt/.gitignore 없음" >&2
    exit 1
fi

# clearml 안의 예전 git 제거 (중복 repo 방지)
if [ -d /opt/clearml/.git ]; then
    echo "▶ /opt/clearml/.git 제거 (repo 루트는 /opt)"
    rm -rf /opt/clearml/.git
fi

if [ ! -d /opt/.git ]; then
    echo "▶ /opt git init"
    git init
    git branch -M main
fi

if ! git remote get-url origin &>/dev/null; then
    git remote add origin "$REMOTE"
fi

git add .gitignore clearml/ clearml-monitoring/ data_studio/ comfyui_linux/

if [ "${1:-}" = "--check" ]; then
    git status
    exit 0
fi

if git diff --cached --quiet; then
    echo "커밋할 변경 없음"
else
    git -c user.name="${GIT_USER_NAME:-intellivix}" \
        -c user.email="${GIT_USER_EMAIL:-intellivix@ai-server}" \
        commit -m "${GIT_COMMIT_MSG:-/opt MLOps 전체 설정}"
fi

echo "▶ push (인증 필요)"
git push -u origin main
