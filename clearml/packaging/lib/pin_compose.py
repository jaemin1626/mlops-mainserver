#!/usr/bin/env python3
"""docker-compose.yml 의 이미지 참조를 고정 태그로 치환한다.

주석과 서식을 보존해야 하므로 YAML 파서로 재직렬화하지 않고 라인 단위로 편집한다.

매핑 파일 형식 (TAB 구분):
    IMAGE   <기존 이미지 참조>   <고정 이미지 참조>
    SERVICE <서비스 이름>        <고정 이미지 참조>

IMAGE 는 `image:` 값이 정확히 일치할 때 치환한다.
SERVICE 는 해당 서비스에 `image:` 가 있으면 치환하고, 없으면(= build 전용 서비스)
서비스 블록 첫 줄에 `image:` 를 새로 삽입한다.
"""

from __future__ import annotations

import re
import sys

SERVICE_HEADER = re.compile(r"^(\s{2})([A-Za-z0-9_.-]+):\s*(#.*)?$")
SERVICE_IMAGE = re.compile(r"^(\s{4})image:\s*(\S+)\s*(#.*)?$")
TOP_LEVEL_KEY = re.compile(r"^([A-Za-z0-9_.-]+):")


def load_map(path: str) -> tuple[dict[str, str], dict[str, str]]:
    by_image: dict[str, str] = {}
    by_service: dict[str, str] = {}
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            kind, key, value = line.split("\t")
            if kind == "IMAGE":
                by_image[key] = value
            elif kind == "SERVICE":
                by_service[key] = value
            else:
                raise SystemExit(f"알 수 없는 매핑 종류: {kind}")
    return by_image, by_service


def pin(lines: list[str], by_image: dict[str, str], by_service: dict[str, str]) -> tuple[list[str], list[str]]:
    out: list[str] = []
    changes: list[str] = []
    in_services = False
    service: str | None = None
    # 서비스별로 image: 를 이미 만났는지, 삽입 지점은 어디인지 추적한다.
    pending_insert: dict[str, int] = {}

    def close_service() -> None:
        nonlocal service
        if service and service in pending_insert:
            idx = pending_insert.pop(service)
            ref = by_service[service]
            indent = "    "
            out.insert(idx, f"{indent}image: {ref}\n")
            changes.append(f"{service}: image 추가 -> {ref}")
        service = None

    for line in lines:
        if TOP_LEVEL_KEY.match(line):
            close_service()
            in_services = line.startswith("services:")
            out.append(line)
            continue

        if in_services:
            header = SERVICE_HEADER.match(line)
            if header:
                close_service()
                service = header.group(2)
                out.append(line)
                if service in by_service:
                    pending_insert[service] = len(out)
                continue

            image_line = SERVICE_IMAGE.match(line)
            if image_line and service:
                current = image_line.group(2)
                new_ref = by_service.get(service) or by_image.get(current)
                if new_ref and new_ref != current:
                    out.append(f"{image_line.group(1)}image: {new_ref}\n")
                    changes.append(f"{service}: {current} -> {new_ref}")
                else:
                    out.append(line)
                pending_insert.pop(service, None)
                continue

        out.append(line)

    close_service()
    return out, changes


def main() -> int:
    if len(sys.argv) != 4:
        print(f"사용법: {sys.argv[0]} <입력 compose> <출력 compose> <매핑 파일>", file=sys.stderr)
        return 2

    src, dst, mapping = sys.argv[1:4]
    by_image, by_service = load_map(mapping)

    with open(src, encoding="utf-8") as fh:
        lines = fh.readlines()

    out, changes = pin(lines, by_image, by_service)

    with open(dst, "w", encoding="utf-8") as fh:
        fh.writelines(out)

    for change in changes:
        print(f"    {change}")
    if not changes:
        print("    (치환 대상 없음)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())