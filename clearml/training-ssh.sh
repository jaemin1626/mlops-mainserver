#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
password_args=()
if [[ "${1:-}" == "--password" ]]; then
    shift
    read -r -s -p '학습 서버 SSH 비밀번호: ' TRAINING_SSH_PASSWORD </dev/tty
    printf '\n' >/dev/tty
    [[ -n "$TRAINING_SSH_PASSWORD" ]] || { echo '비밀번호가 비어 있습니다.' >&2; exit 2; }
    export TRAINING_SSH_PASSWORD
    password_args=(-e TRAINING_SSH_PASSWORD)
fi
exec bash "${ROOT}/compose.sh" --profile training-ssh run --rm --no-deps -T "${password_args[@]}" training-ssh "$@"
