#!/usr/bin/env python3
"""Add one external-data-path note while preserving a user-edited DOCX."""

from __future__ import annotations

import html
import re
import sys
import zipfile
from pathlib import Path


NOTE_TITLE = "외부 데이터 추가 시  "
NOTE_TEXT = (
    "외부에서 준비한 데이터를 사용하려면 먼저 Video Studio의 브라우저 탭에서 "
    "확인할 수 있는 저장 경로(브라우저 탭의 폴더 트리에 표시되는 경로)에 파일을 넣어야 합니다. "
    "브라우저 탭에서 보이지 않는 경로에 저장한 파일은 ‘작업으로 보내기’ 대상에서 선택할 수 없습니다."
)


def run(text: str, *, bold=False, color="344054") -> str:
    props = ("<w:b/>" if bold else "") + f'<w:color w:val="{color}"/>'
    return f"<w:r><w:rPr>{props}</w:rPr><w:t>{html.escape(text)}</w:t></w:r>"


def main(source: Path, output: Path) -> None:
    with zipfile.ZipFile(source, "r") as zin:
        document = zin.read("word/document.xml").decode("utf-8")
        if NOTE_TEXT in html.unescape(re.sub(r"<[^>]+>", "", document)):
            raise SystemExit("The note is already present in the document.")

        marker = "1. 브라우저에서 폴더를 열고 사용할 영상을 체크합니다."
        match = None
        for candidate in re.finditer(r"<w:p(?:\s[^>]*)?>.*?</w:p>", document, flags=re.DOTALL):
            plain = html.unescape("".join(re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", candidate.group(0), flags=re.DOTALL)))
            if marker in plain:
                match = candidate
                break
        if not match:
            raise SystemExit("Could not find the Video Studio browser instruction.")

        note = (
            '<w:p><w:pPr><w:shd w:val="clear" w:fill="EAF3FF"/>'
            '<w:ind w:left="220" w:right="220"/>'
            '<w:spacing w:before="90" w:after="110"/></w:pPr>'
            + run(NOTE_TITLE, bold=True, color="155EEF")
            + run(NOTE_TEXT)
            + "</w:p>"
        )
        document = document[: match.start()] + note + document[match.start() :]

        output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output, "w") as zout:
            for item in zin.infolist():
                data = document.encode("utf-8") if item.filename == "word/document.xml" else zin.read(item.filename)
                zout.writestr(item, data)

    print(output)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(f"usage: {sys.argv[0]} SOURCE.docx OUTPUT.docx")
    main(Path(sys.argv[1]), Path(sys.argv[2]))
