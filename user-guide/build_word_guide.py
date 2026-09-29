#!/usr/bin/env python3
"""Build the end-to-end Intellivix MLOps guide as a self-contained DOCX."""

from __future__ import annotations

import html
import os
import re
import shutil
import struct
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent
SCREENS = ROOT / "screens"
BUILD = ROOT / ".word-build"
OUTPUT = ROOT / "Intellivix_MLOps_배포_및_사용자_가이드.docx"

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture"


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def font_path(bold=False, mono=False):
    candidates = []
    if mono:
        candidates += ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"]
    elif bold:
        candidates += [
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        ]
    else:
        candidates += [
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
    return next((p for p in candidates if Path(p).exists()), None)


def make_terminal(name: str, title: str, lines: list[str]) -> Path:
    path = BUILD / f"terminal-{name}.png"
    width, pad, line_h = 1400, 54, 42
    height = 94 + pad + line_h * len(lines) + 42
    image = Image.new("RGB", (width, height), "#101827")
    draw = ImageDraw.Draw(image)
    title_font = ImageFont.truetype(font_path(bold=True), 29)
    mono_font = ImageFont.truetype(font_path(mono=True), 25)
    draw.rectangle((0, 0, width, 78), fill="#1d293b")
    for x, color in [(30, "#ff5f57"), (64, "#febc2e"), (98, "#28c840")]:
        draw.ellipse((x, 26, x + 20, 46), fill=color)
    draw.text((145, 22), title, font=title_font, fill="#e6edf3")
    y = 104
    for line in lines:
        color = "#7ee787" if line.startswith("$") else "#c9d1d9"
        draw.text((pad, y), line, font=mono_font, fill=color)
        y += line_h
    image.save(path, quality=95)
    return path


def redact_dashboard() -> Path:
    source = SCREENS / "dashboard.png"
    target = BUILD / "dashboard-redacted.png"
    image = Image.open(source).convert("RGB")
    draw = ImageDraw.Draw(image)
    # The server address is in the top-left dashboard status strip.
    draw.rounded_rectangle((8, 8, 390, 54), radius=8, fill="#111827")
    font = ImageFont.truetype(font_path(bold=True), 22)
    draw.text((16, 18), "TRAINING SERVER · <TRAIN_SERVER_IP>", font=font, fill="#ffffff")
    image.save(target)
    return target


class Docx:
    def __init__(self):
        self.body: list[str] = []
        self.images: list[tuple[Path, str, int, int]] = []
        self._rid = 10
        self._docpr = 1

    def run(self, text, bold=False, color=None, size=None, mono=False, italic=False):
        props = []
        if bold:
            props.append("<w:b/>")
        if italic:
            props.append("<w:i/>")
        if color:
            props.append(f'<w:color w:val="{color}"/>')
        if size:
            props.append(f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>')
        if mono:
            props.append('<w:rFonts w:ascii="D2Coding" w:hAnsi="D2Coding" w:eastAsia="D2Coding"/>')
        preserve = ' xml:space="preserve"' if str(text).startswith(" ") or str(text).endswith(" ") else ""
        return f"<w:r><w:rPr>{''.join(props)}</w:rPr><w:t{preserve}>{esc(text)}</w:t></w:r>"

    def p(self, text="", style=None, align=None, before=0, after=100, left=0, keep=False,
          bold=False, color=None, size=None, mono=False, italic=False, shade=None):
        ppr = []
        if style:
            ppr.append(f'<w:pStyle w:val="{style}"/>')
        if align:
            ppr.append(f'<w:jc w:val="{align}"/>')
        if before or after:
            ppr.append(f'<w:spacing w:before="{before}" w:after="{after}" w:line="300" w:lineRule="auto"/>')
        if left:
            ppr.append(f'<w:ind w:left="{left}"/>')
        if keep:
            ppr.append("<w:keepNext/>")
        if shade:
            ppr.append(f'<w:shd w:val="clear" w:color="auto" w:fill="{shade}"/>')
            ppr.append('<w:ind w:left="180" w:right="180"/>')
            ppr.append('<w:spacing w:before="100" w:after="100"/>')
        self.body.append(f"<w:p><w:pPr>{''.join(ppr)}</w:pPr>{self.run(text, bold, color, size, mono, italic)}</w:p>")

    def heading(self, text, level=1):
        self.p(text, style=f"Heading{level}", before=180, after=110, keep=True)

    def bullet(self, text, level=0):
        self.p("• " + text, left=360 + level * 300, after=55)

    def numbered(self, items):
        for i, item in enumerate(items, 1):
            self.p(f"{i}. {item}", left=260, after=70)

    def code(self, lines):
        for line in lines.strip("\n").splitlines():
            self.p(line or " ", mono=True, size=18, color="E6EDF3", shade="172033", after=0)
        self.p("", after=70)

    def note(self, title, text, kind="info"):
        colors = {"info": ("EAF3FF", "155EEF"), "warn": ("FFF4E5", "B54708"), "ok": ("ECFDF3", "027A48")}
        fill, color = colors[kind]
        xml = self.run(title + "  ", bold=True, color=color) + self.run(text, color="344054")
        self.body.append(f'<w:p><w:pPr><w:shd w:val="clear" w:fill="{fill}"/><w:ind w:left="220" w:right="220"/><w:spacing w:before="90" w:after="110"/></w:pPr>{xml}</w:p>')

    def table(self, headers, rows, widths=None):
        if widths is None:
            widths = [int(9300 / len(headers))] * len(headers)
        grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in widths)
        trs = []
        for ri, row in enumerate([headers] + rows):
            cells = []
            for ci, value in enumerate(row):
                fill = "1E3A5F" if ri == 0 else ("F4F7FB" if ri % 2 == 0 else "FFFFFF")
                color = "FFFFFF" if ri == 0 else "1F2937"
                cells.append(
                    f'<w:tc><w:tcPr><w:tcW w:w="{widths[ci]}" w:type="dxa"/><w:shd w:val="clear" w:fill="{fill}"/>'
                    '<w:tcMar><w:top w:w="90" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tcMar></w:tcPr>'
                    f'<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>{self.run(value, bold=ri == 0, color=color, size=18)}</w:p></w:tc>'
                )
            trs.append("<w:tr>" + "".join(cells) + "</w:tr>")
        self.body.append(
            '<w:tbl><w:tblPr><w:tblW w:w="9300" w:type="dxa"/><w:tblLayout w:type="fixed"/>'
            '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="D0D5DD"/><w:left w:val="single" w:sz="4" w:color="D0D5DD"/>'
            '<w:bottom w:val="single" w:sz="4" w:color="D0D5DD"/><w:right w:val="single" w:sz="4" w:color="D0D5DD"/>'
            '<w:insideH w:val="single" w:sz="4" w:color="D0D5DD"/><w:insideV w:val="single" w:sz="4" w:color="D0D5DD"/></w:tblBorders></w:tblPr>'
            f'<w:tblGrid>{grid}</w:tblGrid>{"".join(trs)}</w:tbl>'
        )
        self.p("", after=70)

    def page_break(self):
        self.body.append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')

    def image(self, path: Path, caption: str, width_in=6.75):
        with Image.open(path) as im:
            px_w, px_h = im.size
        cx = int(width_in * 914400)
        cy = int(cx * px_h / px_w)
        max_cy = int(7.25 * 914400)
        if cy > max_cy:
            scale = max_cy / cy
            cx, cy = int(cx * scale), max_cy
        self._rid += 1
        rid = f"rId{self._rid}"
        self._docpr += 1
        dest = f"image{len(self.images) + 1}{path.suffix.lower()}"
        self.images.append((path, dest, cx, cy))
        drawing = f'''<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">
<wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>
<wp:docPr id="{self._docpr}" name="{esc(caption)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="{A}" noChangeAspect="1"/></wp:cNvGraphicFramePr>
<a:graphic xmlns:a="{A}"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic xmlns:pic="{PIC}"><pic:nvPicPr><pic:cNvPr id="0" name="{esc(dest)}"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="{rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln w="6350"><a:solidFill><a:srgbClr val="D0D5DD"/></a:solidFill></a:ln></pic:spPr>
</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'''
        self.body.append(f'<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="80" w:after="60"/></w:pPr>{drawing}</w:p>')
        self.p(caption, align="center", italic=True, color="667085", size=18, after=110)

    def write(self):
        BUILD.mkdir(exist_ok=True)
        document = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="{W}" xmlns:r="{R}" xmlns:wp="{WP}" xmlns:a="{A}" xmlns:pic="{PIC}"><w:body>{''.join(self.body)}
<w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:footerReference w:type="default" r:id="rId3"/>
<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="900" w:right="950" w:bottom="900" w:left="950" w:header="420" w:footer="420"/>
<w:cols w:space="425"/><w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>'''
        rels = [
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>',
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>',
        ]
        for index, (_, dest, _, _) in enumerate(self.images, start=11):
            rels.append(f'<Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/{dest}"/>')
        doc_rels = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{"".join(rels)}</Relationships>'''
        types = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>', '<Default Extension="xml" ContentType="application/xml"/>', '<Default Extension="png" ContentType="image/png"/>', '<Default Extension="jpg" ContentType="image/jpeg"/>', '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>', '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>', '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>', '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>', '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>', '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>']
        content_types = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">{"".join(types)}</Types>'
        package_rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>'''
        styles = styles_xml()
        header = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="{W}"><w:p><w:pPr><w:jc w:val="right"/><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="155EEF"/></w:pBdr></w:pPr>{self.run("INTELLIVIX MLOps  |  배포 및 사용자 가이드", bold=True, color="344054", size=17)}</w:p></w:hdr>'''
        footer = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="{W}"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>{self.run("INTELLIVIX MLOps  •  ", color="667085", size=16)}<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>'''
        core = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Intellivix MLOps 배포 및 사용자 가이드</dc:title><dc:creator>Intellivix</dc:creator><dc:description>GitHub 배포부터 사용자 동작까지</dc:description><dcterms:created xsi:type="dcterms:W3CDTF">2026-09-21T00:00:00Z</dcterms:created></cp:coreProperties>'''
        app = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Office Word</Application><Company>Intellivix</Company></Properties>'''
        with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("[Content_Types].xml", content_types)
            z.writestr("_rels/.rels", package_rels)
            z.writestr("word/document.xml", document)
            z.writestr("word/_rels/document.xml.rels", doc_rels)
            z.writestr("word/styles.xml", styles)
            z.writestr("word/header1.xml", header)
            z.writestr("word/footer1.xml", footer)
            z.writestr("docProps/core.xml", core)
            z.writestr("docProps/app.xml", app)
            for source, dest, _, _ in self.images:
                z.write(source, f"word/media/{dest}")


def styles_xml():
    return f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="{W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Malgun Gothic"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:color w:val="1F2937"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:color w:val="102A43"/><w:sz w:val="58"/><w:szCs w:val="58"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="155EEF"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="280" w:after="140"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="102A43"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="155EEF"/><w:sz w:val="25"/><w:szCs w:val="25"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="180" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="344054"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
</w:styles>'''


def add_screen(doc, name, caption, intro=None, steps=None, note=None):
    doc.page_break()
    doc.heading(caption, 2)
    if intro:
        doc.p(intro)
    path = BUILD / "dashboard-redacted.png" if name == "dashboard" else SCREENS / f"{name}.png"
    doc.image(path, f"실제 서비스 화면 — {caption}")
    if steps:
        doc.numbered(steps)
    if note:
        doc.note("확인", note, "ok")


def build():
    if BUILD.exists():
        shutil.rmtree(BUILD)
    BUILD.mkdir()
    redact_dashboard()
    terminal_clone = make_terminal("clone", "MLOps 서버 · 저장소 준비", [
        "$ cd <MLOPS_INSTALL_PARENT_PATH>",
        "$ git clone <GIT_REPOSITORY_URL> mlops-mainserver",
        "$ cd mlops-mainserver/clearml",
        "$ cp .env.example .env",
        "$ vi .env",
    ])
    terminal_start = make_terminal("start", "MLOps 서버 · 최초 기동", [
        "$ bash start.sh",
        "[1/6] 환경 설정 및 보안 값 생성",
        "[2/6] 학습 서버 SSH 접속 확인",
        "[3/6] Dataset / 생성 영상 NFS 마운트",
        "[4/6] ClearML 및 연동 서비스 기동",
        "[5/6] Data Studio / Video Studio 기동",
        "[6/6] Grafana 기동 (선택)",
    ])
    terminal_train = make_terminal("train", "학습 서버 · 최초 연결", [
        "$ cd <TRAIN_REPOSITORY_PATH>",
        "$ vi mount/config/train.env",
        "MLOPS_SSH_PUBLIC_KEY=<MLOPS 서버가 출력한 공개키 한 줄>",
        "$ bash start.sh",
        "학습 서버 세팅 완료",
    ])
    terminal_check = make_terminal("check", "MLOps 서버 · 정상 동작 확인", [
        "$ ./compose.sh ps",
        "ClearML / Data Studio / Video Studio ... Up",
        "$ bash training-ssh.sh doctor",
        "SSH_OK",
        "$ mount | grep <TRAIN_SERVER_IP>",
        "Dataset 및 generate_datasets 마운트 확인",
    ])

    d = Docx()
    d.p("INTELLIVIX MLOPS", bold=True, color="155EEF", size=22, before=800, after=300)
    d.p("배포 및 사용자 가이드", style="Title", after=180)
    d.p("GitHub 배포부터 데이터 생성·라벨링·학습·모델 다운로드까지", style="Subtitle", after=420)
    d.table(["문서 대상", "범위"], [["시스템 관리자", "저장소 배포, 서버 연동, 최초 기동, 계정·권한"], ["일반 사용자", "영상 생성, 라벨링·검수, 학습, 배포 파일 준비, 데이터 관리"]], [2600, 6700])
    d.note("표기 원칙", "실제 서버 주소와 설치 경로는 문서에 노출하지 않고 <MLOPS_SERVER_IP>, <TRAIN_SERVER_IP> 등 환경별 값으로 표시합니다.", "info")
    d.p("화면 확인 기준: 2026.09 · 웹 버전", color="667085", italic=True, after=60)
    d.p("화면의 파일명·수량·작업 이력은 캡처 시점의 예시입니다.", color="667085", italic=True)
    d.page_break()
    d.heading("문서 사용 방법", 1)
    d.p("처음 설치하는 관리자는 1부부터 순서대로 진행합니다. 이미 서비스가 동작 중인 사용자는 2부부터 시작해도 됩니다.")
    d.heading("목차", 2)
    for line in [
        "1부. GitHub 저장소 배포 및 서버 기동",
        "  1. 구성과 사전 조건",
        "  2. 저장소 받기 및 환경 설정",
        "  3. 학습 서버 연결과 최초 기동",
        "  4. 정상 동작 확인과 최초 관리자 설정",
        "2부. 사용자 작업 흐름",
        "  5. 로그인 및 권한",
        "  6. 학습 데이터 생성",
        "  7. Detector / VLM 라벨링과 검수",
        "  8. 모델 학습 및 배포 파일 준비",
        "  9. Dataset 버전·데이터 관리",
        "부록. 장애 확인표와 완료 체크리스트",
    ]:
        d.p(line, after=55)
    d.heading("환경별 대체 표기", 2)
    d.table(["표기", "입력할 값", "예시 용도"], [
        ["<GIT_REPOSITORY_URL>", "조직에서 안내한 GitHub/Git 저장소 URL", "git clone"],
        ["<MLOPS_SERVER_IP>", "ClearML·Data Studio가 실행되는 서버 IP", "웹 접속, API"],
        ["<TRAIN_SERVER_IP>", "GPU 학습·ComfyUI·NFS 서버 IP", "SSH, NFS, 생성 서버"],
        ["<MLOPS_INSTALL_PARENT_PATH>", "저장소를 받을 상위 폴더", "clone 위치"],
        ["<TRAIN_REPOSITORY_PATH>", "학습 서버 저장소 루트", "학습 서버 start.sh"],
        ["<TRAIN_SERVER_USER>", "학습 서버 SSH 계정", "원격 접속"],
    ], [2900, 4100, 2300])

    d.page_break()
    d.heading("1부. GitHub 저장소 배포 및 서버 기동", 1)
    d.heading("1. 구성과 사전 조건", 2)
    d.p("두 서버가 한 시스템처럼 동작합니다. MLOps 서버는 웹·API·관리 기능을 제공하고, 학습 서버는 GPU 작업과 Dataset/생성 영상 저장 공간을 제공합니다.")
    d.table(["구성", "주요 역할", "필수 조건"], [
        ["MLOps 서버", "ClearML UI, Data Studio, Video Studio, 모델 평가, 선택적 Grafana", "Docker, Docker Compose v2, Python 3, sudo 가능 계정"],
        ["학습 서버", "Detector/VLM 학습, ComfyUI, Dataset·생성 영상 NFS 제공", "학습 저장소와 start.sh, GPU 환경"],
        ["네트워크", "MLOps → 학습 서버 통신", "SSH 22, NFS 2049, ComfyUI 포트 접근"],
    ], [2200, 4200, 2900])
    d.note("중요", "start.sh와 git 명령을 sudo로 실행하지 마세요. SSH 키와 설정 파일이 root 소유가 되어 서비스가 읽지 못할 수 있습니다.", "warn")
    d.heading("전체 배포 순서", 2)
    d.numbered([
        "MLOps 서버에서 Git 저장소를 clone하고 clearml/.env를 작성합니다.",
        "MLOps 서버에서 bash start.sh를 실행합니다.",
        "SSH 연결 안내가 나오면 학습 서버에 공개키를 등록하고 학습 서버의 bash start.sh를 실행합니다.",
        "MLOps 서버 터미널로 돌아와 1을 입력해 NFS 마운트와 서비스 기동을 완료합니다.",
        "웹 접속, 최초 로그인, 권한·API 키 설정, 정상 동작 확인을 수행합니다.",
        "사용자가 데이터 생성 → 라벨링·검수 → 학습 → 모델 다운로드 흐름을 수행합니다.",
    ])

    d.page_break()
    d.heading("2. 저장소 받기 및 환경 설정", 2)
    d.image(terminal_clone, "명령 예시 — MLOps 서버에서 Git 저장소를 받고 .env를 준비합니다.")
    d.code("""cd <MLOPS_INSTALL_PARENT_PATH>
git clone <GIT_REPOSITORY_URL> mlops-mainserver
cd mlops-mainserver/clearml
cp .env.example .env
vi .env""")
    d.heading("반드시 확인할 .env 항목", 3)
    d.table(["키", "의미", "작성 기준"], [
        ["MLOPS_ROOT", "MLOps 저장소 루트", "실제 clone 위치의 절대 경로"],
        ["CLEARML_SERVER_IP", "MLOps 서비스 주소", "<MLOPS_SERVER_IP>"],
        ["MONITORING_SERVER_IP", "Grafana 주소", "보통 <MLOPS_SERVER_IP>"],
        ["TRAINING_SERVER_IP", "학습·ComfyUI·NFS 주소", "<TRAIN_SERVER_IP>"],
        ["TRAINING_SERVER_USER", "학습 서버 SSH 사용자", "<TRAIN_SERVER_USER>"],
        ["TRAINING_ROOT", "학습 서버 저장소 루트", "<TRAIN_REPOSITORY_PATH>"],
    ], [2600, 3300, 3400])
    d.code("""MLOPS_ROOT=<MLOPS_REPOSITORY_PATH>
CLEARML_SERVER_IP=<MLOPS_SERVER_IP>
MONITORING_SERVER_IP=<MLOPS_SERVER_IP>
TRAINING_SERVER_IP=<TRAIN_SERVER_IP>
TRAINING_SERVER_USER=<TRAIN_SERVER_USER>
TRAINING_ROOT=<TRAIN_REPOSITORY_PATH>""")
    d.note("설정 원칙", "일반 사용자는 .env 하나만 수정합니다. docker-compose.yml, config/apiserver.conf와 자동 생성 키는 직접 수정하지 않습니다.", "info")

    d.page_break()
    d.heading("3. 학습 서버 연결과 최초 기동", 2)
    d.image(terminal_start, "명령 예시 — MLOps 서버에서 bash start.sh를 실행하면 6단계를 순차 처리합니다.")
    d.code("bash start.sh")
    d.table(["단계", "자동 처리 내용", "완료 확인"], [
        ["1/6", "환경 설정, 서명 키·임시 비밀번호, 파생 URL", "오류 없이 다음 단계 진행"],
        ["2/6", "SSH 키 생성, 호스트 키 등록, 학습 서버 접속 시험", "SSH_OK 또는 학습 서버 안내 출력"],
        ["3/6", "Dataset·생성 영상 NFS 마운트", "두 마운트 확인"],
        ["4/6", "ClearML 스택, 초기 관리자, 학습 지표 수집", "컨테이너 Up"],
        ["5/6", "Data Studio·Video Studio 재기동", "웹 하위 경로 응답"],
        ["6/6", "Grafana 모니터링(선택)", "Grafana 접속"],
    ], [1200, 5500, 2600])
    d.note("첫 빌드", "이미지를 원격 레지스트리에서 먼저 찾는 과정에서 빨간 오류가 잠시 보여도, 이어서 로컬 빌드가 진행되면 정상입니다. 최종 완료 상태를 확인하세요.", "info")

    d.page_break()
    d.heading("3-1. SSH 안내가 표시될 때: 학습 서버 설정", 2)
    d.p("MLOps 서버의 start.sh가 학습 서버 접속에 실패하면 공개키를 출력하고 입력을 기다립니다. MLOps 터미널은 닫지 않은 채 학습 서버에서 아래를 수행합니다.")
    d.image(terminal_train, "명령 예시 — 학습 서버에 MLOps 공개키를 등록하고 최초 설정을 실행합니다.")
    d.numbered([
        "학습 서버에 <TRAIN_SERVER_USER> 계정으로 로그인합니다.",
        "<TRAIN_REPOSITORY_PATH>로 이동합니다.",
        "mount/config/train.env의 MLOPS_SSH_PUBLIC_KEY에 MLOps 터미널이 출력한 공개키 한 줄을 넣습니다. 기존 키가 있으면 교체합니다.",
        "학습 서버에서 bash start.sh를 실행합니다. MLOps IP와 루트 경로를 묻는 경우 .env와 같은 값을 입력합니다.",
        "‘학습 서버 세팅 완료’를 확인합니다.",
        "MLOps 터미널로 돌아가 질문에 1을 입력합니다. SSH_OK 뒤 3/6 단계부터 계속됩니다.",
    ])
    d.note("키 입력", "공개키는 줄바꿈 없이 한 줄 전체를 복사합니다. 저장소를 다시 clone하면 새 키가 만들어질 수 있으므로 학습 서버의 옛 키도 교체해야 합니다.", "warn")

    d.page_break()
    d.heading("4. 정상 동작 확인과 최초 관리자 설정", 2)
    d.image(terminal_check, "명령 예시 — 컨테이너, SSH, NFS의 세 가지를 모두 확인합니다.")
    d.table(["확인 대상", "확인 방법", "정상 기준"], [
        ["서비스", "./compose.sh ps", "주요 서비스가 Up"],
        ["학습 서버 SSH", "bash training-ssh.sh doctor", "SSH_OK"],
        ["NFS", "mount | grep <TRAIN_SERVER_IP>", "Dataset·generate_datasets 두 항목"],
        ["ClearML", "http://<MLOPS_SERVER_IP>:8080", "로그인 화면"],
        ["Data Studio", "http://<MLOPS_SERVER_IP>:8080/data-studio/", "홈 화면"],
        ["Video Studio", "http://<MLOPS_SERVER_IP>:8080/seoul-studio/", "브라우저/이미지→영상"],
        ["모델 평가", "http://<MLOPS_SERVER_IP>:8090", "평가 콘솔"],
        ["Grafana(선택)", "http://<MLOPS_SERVER_IP>:3000", "대시보드"],
    ], [1900, 4700, 2700])
    d.note("재실행", "start.sh는 반복 실행을 고려해 작성되어 있습니다. 재부팅 후 NFS가 자동 마운트되지 않았다면 MLOps 서버에서 bash start.sh를 다시 실행합니다.", "info")

    add_screen(d, "login", "최초 로그인", "관리자가 발급한 계정으로 MLOps 웹에 접속합니다.", [
        "브라우저에서 http://<MLOPS_SERVER_IP>:8080을 엽니다.",
        "최초 관리자라면 admin과 clearml/.env의 CLEARML_LOGIN_PASSWORD 값을 사용합니다.",
        "첫 로그인에서 비밀번호 변경 화면이 나오면 새 비밀번호로 변경합니다.",
        "대시보드가 보이면 로그인 완료입니다.",
    ], "변경 후 실제 비밀번호는 .env의 최초 임시값과 달라질 수 있습니다.")
    add_screen(d, "dashboard", "대시보드 및 학습 서버 상태 확인", steps=[
        "상단 TRAINING SERVER 값이 <TRAIN_SERVER_IP>를 가리키는지 확인합니다.",
        "LIVE 표시와 최근 수집 시간이 갱신되는지 확인합니다.",
        "GPU·CPU·메모리 지표가 표시되는지 확인합니다.",
        "Recent Tasks에서 학습 작업 상태를 확인합니다.",
    ], note="서버 값이 오래되었거나 ‘데이터 지연’이면 training-metrics 서비스와 SSH 연결을 확인합니다.")
    add_screen(d, "admin", "관리자 메뉴 진입", steps=[
        "Settings를 열고 Admin을 선택합니다.",
        "일반 사용자의 화면에 Admin이 없으면 관리자 권한이 없는 정상 상태입니다.",
    ])
    add_screen(d, "admin-panel", "계정·그룹 생성 및 권한 부여", steps=[
        "사용자 → + 계정 생성에서 이름, 로그인 계정, 초기 비밀번호를 입력합니다.",
        "데이터 생성, 라벨링 작업, 라벨링 검수, 학습 및 배포 중 필요한 권한만 선택합니다.",
        "여러 사용자에게 같은 권한을 줄 때는 그룹을 만들고 사용자를 배정합니다.",
        "저장 후 사용자 목록과 권한 변경 이력을 확인합니다.",
    ], note="개인 권한과 그룹 권한은 함께 적용됩니다. 개인 체크를 해제해도 그룹 권한으로 유지될 수 있습니다.")

    d.page_break()
    d.heading("4-1. 학습 Task와 Grafana 연결", 2)
    d.p("학습 결과를 ClearML 대시보드에 표시하려면 웹에서 API 자격 증명을 발급해 학습 서버에 등록합니다.")
    d.numbered([
        "MLOps 웹 → Profile → Settings → Workspace → Create new credentials를 선택합니다.",
        "발급된 Access Key와 Secret Key를 안전하게 보관합니다.",
        "학습 서버에서 ./scripts/config.sh setup-clearml을 실행해 키를 등록합니다.",
        "Grafana를 사용할 때는 MLOps .env의 CLEARML_ACCESS_KEY와 CLEARML_SECRET_KEY에 서비스용 키를 넣고 bash start.sh를 다시 실행합니다.",
    ])
    d.note("보안", "Access Key, Secret Key, SSH 개인 키, 비밀번호는 화면 캡처나 운영 문서에 기록하지 않습니다.", "warn")

    d.page_break()
    d.heading("2부. 사용자 작업 흐름", 1)
    d.p("사용자 작업의 기본 흐름은 ‘데이터 준비 → 라벨링 → 검수 → 학습 → 배포 파일 다운로드 → 버전 기록’입니다. 기존 데이터가 준비되어 있으면 영상 생성 단계는 생략할 수 있습니다.")
    d.table(["순서", "메뉴", "완료 기준"], [
        ["1", "Video Studio", "영상 생성 또는 기존 영상을 작업 폴더로 전달"],
        ["2", "Data Studio", "Detector/VLM 라벨 저장, 검수 승인"],
        ["3", "모델 학습 및 배포", "학습 완료 상태"],
        ["4", "배포", "Detector ONNX 또는 VLM zip 다운로드"],
        ["5", "Datasets", "버전·branch 설명과 사용 이력 확인"],
    ], [900, 3300, 5100])

    add_screen(d, "video-settings", "5. Video Studio 연결 설정", steps=[
        "Video Studio → 이미지 → 영상을 열고 연결 설정을 누릅니다.",
        "생성 서버는 관리자가 배포 시 구성한 <TRAIN_SERVER_IP>:<COMFYUI_PORT> 연결을 사용합니다.",
        "저장할 폴더명을 입력해 만들기를 누른 뒤 ‘이 폴더를 저장 위치로 사용’을 선택합니다.",
        "설정 저장 후 현재 저장 폴더를 확인합니다.",
    ], note="생성 서버 주소를 사용자가 임의로 변경하지 않습니다. 연결 실패 시 관리자에게 <TRAIN_SERVER_IP>의 ComfyUI 상태 확인을 요청합니다.")
    add_screen(d, "video-create", "6. 이미지로 학습용 영상 생성", steps=[
        "시작 이미지에서 PNG, JPEG 또는 WebP 파일을 선택합니다.",
        "입력 프롬프트에 원하는 움직임을 구체적으로 작성합니다. 영어 프롬프트가 더 안정적일 수 있습니다.",
        "해상도, 길이, 반복을 선택합니다. 최초 확인은 반복 1회를 권장합니다.",
        "필요하면 네거티브 프롬프트와 고급 설정을 입력합니다.",
        "영상 생성을 누르고 결과 영상을 재생해 움직임과 화질을 확인합니다.",
    ], note="GPU가 학습 중이라는 안내가 나오면 학습이 끝난 뒤 다시 시도합니다.")
    add_screen(d, "video", "7. 영상을 라벨링 작업으로 보내기", steps=[
        "브라우저에서 폴더를 열고 사용할 영상을 체크합니다.",
        "작업으로 보내기(+비식별화)를 누릅니다.",
        "대상에서 Detector 또는 VLM을 선택합니다. Detector는 이미지로 추출하고, VLM은 이미지 또는 영상을 선택합니다.",
        "이미지 추출 시 간격 N 프레임을 입력합니다. N이 작을수록 더 많은 이미지가 생성됩니다.",
        "필요하면 안면·번호판 비식별화를 켜고 시작합니다.",
        "Data Studio 홈에서 새로고침해 전달된 폴더를 확인합니다.",
    ], note="‘비식별화만’은 브라우저 보관 용도입니다. 라벨링으로 이어가려면 반드시 ‘작업으로 보내기’를 선택합니다.")

    add_screen(d, "studio", "8. Detector 작업 폴더와 역할 선택", steps=[
        "Data Studio 홈에서 Detector를 선택합니다.",
        "라벨 작성자는 작업자, 검사 담당자는 검수자를 선택합니다.",
        "프로젝트 폴더 카드 또는 검수 대기 열기를 선택합니다.",
        "파일 수, 라벨률, 검수 대기, 반려 수를 확인합니다.",
    ], note="라벨률과 승인율은 다릅니다. 라벨이 있어도 검수 승인이 끝난 것은 아닙니다.")
    add_screen(d, "label-detector", "9. Detector 객체 박스 작성·검수", steps=[
        "폴더 열기로 이미지 폴더를 열고 클래스 세트를 불러옵니다.",
        "클래스 순서가 학습의 클래스 ID 0, 1, 2…와 일치하는지 확인합니다.",
        "작업자 역할에서 객체 모서리 두 곳을 지정해 박스를 만들고 위치·크기를 조정합니다.",
        "필요한 모든 객체를 표시한 뒤 Ctrl+S로 저장합니다.",
        "검수 요청 후 검수자가 클래스·위치·누락 여부를 확인해 승인 또는 반려합니다.",
    ], note="캡처는 검수자 역할의 읽기 전용 예시입니다. 박스 작성은 작업자 역할에서 수행합니다.")
    add_screen(d, "studio-vlm", "10. VLM 작업 폴더와 역할 선택", steps=[
        "Data Studio 홈에서 VLM을 선택합니다.",
        "이미지 수, 영상 수, 라벨률, 검수 대기와 반려 수를 확인합니다.",
        "작업할 프로젝트 폴더를 열고 작업자 역할을 선택합니다.",
    ])
    add_screen(d, "label-vlm", "11. VLM 질문·정답 작성·검수", steps=[
        "이미지 또는 영상을 열고 실제 보이는 전체 상황을 확인합니다.",
        "질의에 모델이 답해야 할 질문을 작성합니다.",
        "응답에는 확인되는 사실만 정확하게 작성하고 의도를 추측하지 않습니다.",
        "Ctrl+S로 저장하고 완료 항목은 검수 요청을 누릅니다.",
        "검수자는 질의·응답의 정확성과 누락을 확인해 승인 또는 반려합니다.",
    ], note="자동 저장을 끈 경우 다음 항목으로 이동하기 전에 직접 저장합니다. 캡처의 읽기 전용은 검수자 역할 예시입니다.")

    d.page_break()
    d.heading("12. 검수 상태 흐름", 2)
    d.table(["상태", "담당", "해야 할 일", "다음 상태"], [
        ["작업중", "작업자", "라벨 작성·저장", "검수 요청"],
        ["검수대기", "검수자", "내용 확인", "승인 또는 반려"],
        ["반려", "작업자", "사유 확인·수정·저장", "재검수"],
        ["승인", "검수자", "완료 확인", "학습 데이터 사용"],
    ], [1700, 1700, 3700, 2200])
    d.table(["기능", "조작"], [["저장 / 폴더 열기", "Ctrl+S / Ctrl+O"], ["이전 / 다음", "A / D (입력칸 밖)"], ["Detector 확대 / 이동", "마우스 휠 / 스페이스+드래그"], ["실행 취소 / 다시 실행", "Ctrl+Z / Ctrl+Y"], ["박스 삭제", "박스 선택 후 Backspace"], ["전체 단축키", "Detector 상단 단축키 버튼"]], [4200, 5100])

    add_screen(d, "train", "13. Detector 학습 데이터 준비 및 실행", steps=[
        "모델 학습 및 배포 → 학습 → Detector를 선택합니다.",
        "Dataset version·branch를 선택하거나 폴더로 직접 데이터를 선택합니다.",
        "실제 사용 파일 목록에서 제외할 파일을 해제합니다.",
        "클래스 입력 순서가 YOLO 라벨의 클래스 ID와 일치하는지 확인합니다.",
        "클래스 적용·data.yaml 저장 또는 annotation 자동 생성을 눌러 학습용 목록을 만듭니다.",
        "GPU, Epoch, Batch size, 이미지 크기, 모델 크기, 작업 이름을 확인합니다.",
        "학습 시작을 누르고 상태·로그의 최종 완료를 확인합니다.",
    ], note="annotation 자동 생성은 객체 박스를 새로 만드는 기능이 아닙니다. 기존 라벨로 학습 목록을 준비합니다.")
    add_screen(d, "train-vlm", "14. VLM 데이터 준비 및 학습", steps=[
        "학습 대상 Image, Video, Both 중 하나를 선택합니다.",
        "프로젝트 기준에 따라 LoRA 또는 Full을 선택합니다.",
        "Dataset version·branch 또는 폴더 트리에서 데이터를 선택합니다.",
        "train.json·valid.json 생성을 누르고 완료 경로를 확인합니다.",
        "GPU, Epoch, 그래디언트 누적, 학습률, 작업 이름을 확인합니다.",
        "영상 학습이면 샘플링 FPS와 최대 픽셀도 확인한 뒤 학습을 시작합니다.",
        "상태·로그의 최종 완료 후 배포 탭으로 이동합니다.",
    ], note="화면 기준 VLM 라벨은 9:1로 분할됩니다. 중간 종료 전에 체크포인트가 저장되었다고 가정하지 않습니다.")
    add_screen(d, "deploy-detector", "15. Detector ONNX 변환 및 다운로드", steps=[
        "배포 → Detector에서 새로고침을 누르고 완료된 학습 모델을 선택합니다.",
        "입력 가로·세로, Confidence, IoU, Max Detections, ONNX Opset을 적용 환경에 맞춥니다.",
        "ONNX로 변환을 누르고 상태·로그에서 완료를 확인합니다.",
        "원본 ONNX 또는 NMS 포함 최종 ONNX를 적용 프로그램 요구사항에 맞게 다운로드합니다.",
        "파일명, 학습 프로젝트, 변환 설정, 다운로드 시간을 기록합니다.",
    ], note="변환·다운로드 완료는 운영 서비스 교체 완료를 뜻하지 않습니다. 실제 적용은 운영 환경 담당 절차를 따릅니다.")
    add_screen(d, "deploy-vlm", "16. VLM 모델 패키지 다운로드", steps=[
        "배포 → VLM에서 학습 유형과 같은 Image, Video, Both 탭을 선택합니다.",
        "새로고침 후 프로젝트와 모델 폴더를 확인합니다.",
        "zip 다운로드를 누르고 브라우저의 다운로드 완료를 확인합니다.",
        "프로젝트명·학습 유형과 함께 보관하고 적용 담당자에게 전달합니다.",
    ], note="목록이 비어 있으면 학습 최종 완료 여부, 선택한 유형, 새로고침 순서로 확인합니다.")

    add_screen(d, "datasets", "17. Dataset 프로젝트 선택", steps=[
        "DATASETS에서 Dataset 프로젝트를 엽니다.",
        "Detector 또는 VLM을 선택합니다.",
        "버전 수, 파일 수, 최신 버전을 확인합니다.",
    ])
    add_screen(d, "dataset-versions", "18. Dataset 버전·branch와 변경 이력", steps=[
        "VERSION BRANCHES에서 확인할 branch를 선택합니다.",
        "그래프 노드를 눌러 부모 관계와 포함 데이터 Tree를 확인합니다.",
        "학습·검증·테스트 수량과 부모 대비 추가·삭제 데이터를 확인합니다.",
        "Branch 설명에 목적과 변경 이유를 적고 저장합니다.",
        "학습 활용 이력에서 이 데이터를 사용한 작업을 확인합니다.",
    ], note="화면의 파일 수에는 이미지 외 라벨 등 관련 파일이 포함될 수 있습니다. 데이터 수와 파일 수를 같은 값으로 보지 않습니다.")

    d.page_break()
    d.heading("19. 장애 확인표", 2)
    d.table(["증상", "먼저 확인", "조치"], [
        ["SSH Permission denied", "MLOps 공개키와 학습 서버 authorized_keys 지문", "train.env의 공개키 교체 후 학습 서버 start.sh 재실행"],
        ["NFS 마운트 실패", "TRAINING_SERVER_IP와 NFS 경로, 2049 통신", "학습 서버 NFS export 후 MLOps start.sh 재실행"],
        ["대시보드 데이터 지연", "training-metrics와 SSH doctor", "SSH 복구 후 지표 서비스 재기동"],
        ["생성 서버 연결 실패", "학습 서버 ComfyUI 상태와 포트", "학습 서버에서 ComfyUI 기동"],
        ["로그인 연동 실패", "apiserver·Elasticsearch 상태", "관련 컨테이너 로그 확인 후 재기동"],
        ["학습 시작 비활성", "학습용 파일 생성과 권한", "data.yaml 또는 JSON 재생성, 권한 요청"],
        ["완료 모델 없음", "학습 완료·모델 유형·새로고침", "최종 완료 후 올바른 탭 선택"],
        ["Grafana 비어 있음", "서비스 API 키와 exporter 401", ".env 키 갱신 후 start.sh"],
    ], [2200, 3800, 3300])
    d.note("문의할 때", "오류 메시지, 발생 메뉴, 폴더명, 학습 작업명, 발생 시각을 함께 전달합니다. 비밀번호·Secret Key·SSH 개인 키는 전달하지 않습니다.", "info")

    d.page_break()
    d.heading("20. 완료 체크리스트", 2)
    d.heading("관리자 배포 완료", 3)
    for item in [
        "□ 저장소 clone과 .env 작성 완료",
        "□ MLOps start.sh 1/6~6/6 완료",
        "□ 학습 서버 SSH_OK",
        "□ Dataset·생성 영상 NFS 마운트 확인",
        "□ ClearML·Data Studio·Video Studio 웹 접속 확인",
        "□ 최초 관리자 비밀번호 변경",
        "□ 사용자·그룹·최소 권한 설정",
        "□ 학습 서버 ClearML API 키 연결",
        "□ 대시보드 학습 서버 지표 갱신 확인",
    ]:
        d.p(item, after=65)
    d.heading("사용자 작업 완료", 3)
    for item in [
        "□ 데이터 폴더와 대상(Detector/VLM) 확인",
        "□ 라벨 저장·검수 요청·반려 수정·승인 확인",
        "□ 학습 데이터 파일(data.yaml 또는 JSON) 생성 확인",
        "□ 학습 최종 완료 상태와 로그 확인",
        "□ 올바른 ONNX 또는 VLM zip 다운로드",
        "□ 모델 파일명·학습 작업·Dataset 버전 기록",
        "□ 원본 보관 후 삭제 대상 재확인",
    ]:
        d.p(item, after=65)
    d.note("최종 기준", "웹 화면이 열리는 것만으로 배포 완료로 판단하지 않습니다. SSH, NFS, 학습 지표, 실제 사용자 작업 흐름까지 확인해야 합니다.", "ok")
    d.p("— 문서 끝 —", align="center", color="667085", italic=True, before=500)
    d.write()


if __name__ == "__main__":
    build()
    print(OUTPUT)
