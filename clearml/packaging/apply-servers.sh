#!/usr/bin/env bash
# deprecated — apply-env.sh 사용
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/apply-env.sh" "$@"
