#!/usr/bin/env python3
"""KEY=VALUE 파일에서 지정한 키만 갱신한다.

주석과 순서, 그리고 지정하지 않은 키(API 키·비밀번호 등)는 그대로 둔다.
없는 키는 파일 끝에 추가한다.

사용법: set_env.py <파일> KEY=VALUE [KEY=VALUE ...]
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print(f"사용법: {sys.argv[0]} <파일> KEY=VALUE [KEY=VALUE ...]", file=sys.stderr)
        return 2

    path = sys.argv[1]
    updates: dict[str, str] = {}
    for arg in sys.argv[2:]:
        key, sep, value = arg.partition("=")
        if not sep:
            print(f"KEY=VALUE 형식이 아님: {arg}", file=sys.stderr)
            return 2
        updates[key] = value

    lines: list[str] = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()

    out: list[str] = []
    seen: set[str] = set()
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith("#") or "=" not in stripped:
            out.append(line)
            continue
        key = stripped.split("=", 1)[0].strip()
        if key not in updates:
            out.append(line)
        elif key in seen:
            continue  # 같은 키가 여러 번 있으면 첫 줄만 남긴다
        else:
            out.append(f"{key}={updates[key]}\n")
            seen.add(key)

    missing = [k for k in updates if k not in seen]
    if missing:
        if out and not out[-1].endswith("\n"):
            out.append("\n")
        for key in missing:
            out.append(f"{key}={updates[key]}\n")

    with open(path, "w", encoding="utf-8") as fh:
        fh.writelines(out)

    for key in updates:
        marker = "+" if key in missing else "="
        print(f"    {marker} {key}={updates[key]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
