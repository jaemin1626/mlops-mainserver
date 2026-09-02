#!/usr/bin/env bash
# dataset-mount.env 기준 상태 확인 (mount_dataset.sh status 로 위임)
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mount_dataset.sh" status
