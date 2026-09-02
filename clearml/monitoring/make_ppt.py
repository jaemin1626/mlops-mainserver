"""
ClearML MLOps 모니터링 대시보드 PPT 생성 스크립트
=====================================================
사용법:
  pip install python-pptx
  python make_ppt.py

슬라이드 구성 (총 4페이지):
  1. 표지
  2. 전체 현황 요약
  3. 모델별 학습 현황
  4. 모델 성능 지표

이미지 파일 준비 (같은 폴더에 놓기):
  img_s1_kpi.png           - 전체현황 KPI 5개 stat 패널
  img_s1_active.png        - 현재 학습 중인 모델 테이블
  img_s2_lastrun.png       - 모델별 마지막 학습 시각 테이블
  img_s2_avgdur.png        - 모델별 평균 학습 소요시간 테이블
  img_s2_ytd.png           - 2026 누적 학습 횟수 YTD 테이블
  img_s2_compare.png       - 마지막 vs 평균 비교 테이블
  img_s2_bar.png           - 모델별 학습 소요시간 막대그래프
  img_s3_detection.png     - Detection 모델 성능 막대그래프
  img_s3_cls.png           - Classification 모델 성능 막대그래프
  img_s3_trend.png         - 버전별 성능 추이 팝업 패널

이미지 없이 실행하면 회색 placeholder 박스로 대체됩니다.
"""

import os
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN

C_BG          = RGBColor(0x0D, 0x1B, 0x2A)
C_ACCENT      = RGBColor(0x00, 0xB4, 0xD8)
C_WHITE       = RGBColor(0xFF, 0xFF, 0xFF)
C_LIGHT       = RGBColor(0xCA, 0xE9, 0xFF)
C_GRAY        = RGBColor(0x8E, 0xA8, 0xC3)
C_CARD        = RGBColor(0x02, 0x3E, 0x5E)
C_PLACEHOLDER = RGBColor(0x1A, 0x2F, 0x44)

W         = Inches(13.33)
H         = Inches(7.5)
LX        = Inches(0.35)
LW        = Inches(0.14)
CX        = Inches(0.65)
CW_LEFT   = Inches(4.55)
IMG_X     = Inches(5.45)
IMG_W     = Inches(7.55)


def set_bg(slide):
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = C_BG


def rect(slide, l, t, w, h, fill, border_color=None, border_pt=None):
    s = slide.shapes.add_shape(1, l, t, w, h)
    s.fill.solid()
    s.fill.fore_color.rgb = fill
    if border_color:
        s.line.color.rgb = border_color
        if border_pt:
            s.line.width = Pt(border_pt)
    else:
        s.line.fill.background()
    return s


def text(slide, txt, l, t, w, h, size=14, bold=False,
         color=C_WHITE, align=PP_ALIGN.LEFT):
    tb = slide.shapes.add_textbox(l, t, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    p.alignment = align
    run = p.add_run()
    run.text = txt
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    return tb


def bullets(slide, items, l, t, w, h, size=12.5, color=C_GRAY):
    tb = slide.shapes.add_textbox(l, t, w, h)
    tf = tb.text_frame
    tf.word_wrap = True
    for i, item in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.space_before = Pt(4)
        run = p.add_run()
        run.text = f"▸  {item}" if not item.startswith("─") and not item.startswith(" ") else item
        run.font.size = Pt(size)
        run.font.color.rgb = C_ACCENT if item.startswith("▸") or (not item.startswith(" ") and not item.startswith("─") and i == 0) else (C_GRAY if item.startswith(" ") or item.startswith("─") else color)
        # 세부 항목(들여쓰기)은 연회색
        if item.startswith("  ·"):
            run.font.color.rgb = C_GRAY
        elif item.startswith("─"):
            run.font.color.rgb = RGBColor(0x2A, 0x4A, 0x6A)
        else:
            run.font.color.rgb = C_LIGHT


def img_or_placeholder(slide, path, l, t, w, h, label="캡처 삽입"):
    if os.path.exists(path):
        slide.shapes.add_picture(path, l, t, w, h)
    else:
        rect(slide, l, t, w, h, C_PLACEHOLDER,
             border_color=C_ACCENT, border_pt=1.2)
        mid_t = t + (h - Inches(0.45)) // 2
        text(slide, f"[ {label} ]", l, mid_t, w, Inches(0.45),
             size=9.5, color=C_GRAY, align=PP_ALIGN.CENTER)


def slide_header(slide, title, subtitle, section_tag):
    set_bg(slide)
    rect(slide, LX, Inches(0), LW, H, C_ACCENT)
    tw, th = Inches(3.4), Inches(0.34)
    rect(slide, W - tw - Inches(0.3), Inches(0.12), tw, th, C_CARD)
    text(slide, section_tag,
         W - tw - Inches(0.3), Inches(0.12), tw, th,
         size=10, color=C_ACCENT, align=PP_ALIGN.CENTER)
    text(slide, title, CX, Inches(0.2), Inches(8.5), Inches(0.68),
         size=30, bold=True, color=C_WHITE)
    rect(slide, CX, Inches(0.92), Inches(1.2), Pt(3), C_ACCENT)
    text(slide, subtitle, CX, Inches(1.0), Inches(12.3), Inches(0.38),
         size=12, color=C_GRAY)


def panel_badges(slide, labels, start_y=Inches(1.48)):
    x = CX
    for label in labels:
        w = Inches(max(len(label) * 0.145 + 0.45, 1.2))
        rect(slide, x, start_y, w, Inches(0.28), C_CARD,
             border_color=C_ACCENT, border_pt=0.8)
        text(slide, label, x + Inches(0.07), start_y,
             w, Inches(0.28), size=8.5, bold=True, color=C_ACCENT)
        x += w + Inches(0.1)


# ── 슬라이드 1: 표지 ──────────────────────────────────────────

def slide_cover(prs):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    set_bg(slide)
    rect(slide, Inches(0), Inches(0), Inches(0.18), H, C_ACCENT)
    rect(slide, Inches(7.3), Inches(0), Inches(6.03), H, C_CARD)
    rect(slide, Inches(7.3), Inches(0), Inches(0.06), H, C_ACCENT)

    text(slide, "ClearML MLOps",
         Inches(1.0), Inches(1.4), Inches(6.0), Inches(1.4),
         size=52, bold=True, color=C_WHITE)
    text(slide, "모니터링 대시보드",
         Inches(1.0), Inches(2.85), Inches(6.0), Inches(0.9),
         size=36, color=C_ACCENT)
    rect(slide, Inches(1.0), Inches(3.83), Inches(5.5), Pt(2.5), C_ACCENT)
    text(slide, "ClearML  ·  Prometheus  ·  Grafana",
         Inches(1.0), Inches(3.96), Inches(6.0), Inches(0.5),
         size=15, color=C_GRAY)
    text(slide, "2026. 03",
         Inches(1.0), Inches(4.6), Inches(3), Inches(0.38),
         size=13, color=C_GRAY)

    sections = [
        ("①", "전체 현황 요약",   "KPI 5종  +  실시간 학습 현황"),
        ("②", "모델별 학습 현황",  "소요시간  ·  YTD  ·  비교"),
        ("③", "모델 성능 지표",   "Detection  /  Classification  /  버전 추이"),
    ]
    for i, (num, sec, desc) in enumerate(sections):
        tp = Inches(1.9) + i * Inches(1.6)
        rect(slide, Inches(7.8), tp, Inches(5.0), Inches(1.35),
             C_BG, border_color=C_ACCENT, border_pt=0.8)
        text(slide, num,
             Inches(7.95), tp + Inches(0.1), Inches(0.65), Inches(0.5),
             size=24, bold=True, color=C_ACCENT)
        text(slide, sec,
             Inches(8.65), tp + Inches(0.1), Inches(3.9), Inches(0.45),
             size=15, bold=True, color=C_WHITE)
        text(slide, desc,
             Inches(8.65), tp + Inches(0.6), Inches(3.9), Inches(0.5),
             size=11, color=C_GRAY)


# ── 슬라이드 2: 전체 현황 요약 ───────────────────────────────

def slide_section1(prs):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    slide_header(slide,
        "① 전체 현황 요약",
        "대시보드 최상단 — 시스템 전체 상태를 한눈에 파악",
        "Section 1 / 3")

    panel_badges(slide, ["KPI 카운터 ×5", "실시간 학습 모니터링"])

    desc = [
        "전체 프로젝트 수",
        "전체 태스크 누적 수",
        "현재 학습 중(in_progress) 모델 수",
        "등록된 데이터셋 수",
        "활용 가능 모델 수 (completed + stopped)",
        "─────────────────────",
        "현재 학습 중인 모델 상세 테이블",
        "  · 모델명 / 버전 / 시작 시각",
        "  · 현재 Epoch / 전체 Epoch",
        "  · 진행률 게이지 바",
        "  · 1 Epoch 평균 소요 시간 (초)",
    ]
    bullets(slide, desc, CX, Inches(1.88), CW_LEFT, Inches(5.4), size=12)

    img_or_placeholder(slide, "img_s1_kpi.png",
                       IMG_X, Inches(1.35), IMG_W, Inches(2.12),
                       "전체 현황 요약 — KPI 5개 stat 패널")
    img_or_placeholder(slide, "img_s1_active.png",
                       IMG_X, Inches(3.6), IMG_W, Inches(3.75),
                       "현재 학습 중인 모델 테이블")


# ── 슬라이드 3: 모델별 학습 현황 ─────────────────────────────

def slide_section2(prs):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    slide_header(slide,
        "② 모델별 학습 현황",
        "각 모델의 학습 이력 · 소요시간 · 빈도를 다각도로 분석",
        "Section 2 / 3")

    panel_badges(slide,
        ["마지막 학습 시각", "평균 소요시간", "YTD 횟수", "비교", "막대그래프"])

    desc = [
        "마지막 학습 시각 — 최근 완료 태스크 일시",
        "평균 학습 소요시간 — started→completed 기준",
        "YTD 누적 학습 횟수 — 2026. 01. 01 이후",
        "─────────────────────",
        "마지막 vs 평균 비교",
        "  · 최근 학습이 평균보다 빠른지 즉시 판별",
        "  · Δ(차이) 컬럼으로 이상 강조",
        "─────────────────────",
        "모델별 학습 소요시간 막대그래프",
        "  · 평균 학습 시간을 모델 간 시각 비교",
        "  · 학습 비용이 높은 모델 식별",
    ]
    bullets(slide, desc, CX, Inches(1.88), CW_LEFT, Inches(5.4), size=11.5)

    # 상단 3개 이미지
    iw3 = (IMG_W - Inches(0.22)) / 3
    ih_top = Inches(2.72)
    for i, (path, label) in enumerate([
        ("img_s2_lastrun.png", "마지막 학습 시각"),
        ("img_s2_avgdur.png",  "평균 소요시간"),
        ("img_s2_ytd.png",     "YTD 누적 횟수"),
    ]):
        img_or_placeholder(slide, path,
                           IMG_X + i * (iw3 + Inches(0.11)),
                           Inches(1.35), iw3, ih_top, label)

    # 하단 2개 이미지
    iw2a = Inches(3.55)
    iw2b = IMG_W - iw2a - Inches(0.11)
    ih_bot = Inches(3.08)
    img_or_placeholder(slide, "img_s2_compare.png",
                       IMG_X, Inches(4.19), iw2a, ih_bot,
                       "마지막 vs 평균 비교")
    img_or_placeholder(slide, "img_s2_bar.png",
                       IMG_X + iw2a + Inches(0.11), Inches(4.19), iw2b, ih_bot,
                       "학습 소요시간 막대그래프")


# ── 슬라이드 4: 모델 성능 지표 ───────────────────────────────

def slide_section3(prs):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    slide_header(slide,
        "③ 모델 성능 지표",
        "최신 학습 결과 성능 비교 및 버전별 추이 드릴다운",
        "Section 3 / 3")

    panel_badges(slide,
        ["Detection (mAP·P·F1)", "Classification (mA)", "버전별 추이"])

    desc = [
        "Detection 모델 성능",
        "  · mAP@50       IOU 0.5 기준 평균 정밀도",
        "  · mAP@50-95  다중 IOU 기준 (엄격)",
        "  · Precision      검출된 것 중 정답 비율",
        "  · F1-Score       Precision × Recall 조화평균",
        "─────────────────────",
        "Classification 모델 성능",
        "  · mA (Mean Accuracy)  클래스별 정확도 평균",
        "─────────────────────",
        "버전별 성능 추이 드릴다운",
        "  · 패널 클릭 → 해당 모델 버전 추이 팝업",
        "  · X축: 버전명, 학습 완료일 순 정렬",
        "  · unix_ts 레이블로 시간 순서 보정",
    ]
    bullets(slide, desc, CX, Inches(1.88), CW_LEFT, Inches(5.4), size=11.5)

    # 상단 2개 이미지
    iw2 = (IMG_W - Inches(0.12)) / 2
    ih_top = Inches(2.85)
    img_or_placeholder(slide, "img_s3_detection.png",
                       IMG_X, Inches(1.35), iw2, ih_top,
                       "Detection 모델 성능 (mAP·Precision·F1)")
    img_or_placeholder(slide, "img_s3_cls.png",
                       IMG_X + iw2 + Inches(0.12), Inches(1.35), iw2, ih_top,
                       "Classification 모델 성능 (mA)")

    # 하단 1개 와이드 이미지
    img_or_placeholder(slide, "img_s3_trend.png",
                       IMG_X, Inches(4.32), IMG_W, Inches(2.97),
                       "버전별 성능 추이 팝업 패널 (Detection / Classification)")


# ── 메인 ─────────────────────────────────────────────────────

def main():
    prs = Presentation()
    prs.slide_width  = W
    prs.slide_height = H

    slide_cover(prs)
    slide_section1(prs)
    slide_section2(prs)
    slide_section3(prs)

    output = "clearml_mlops_dashboard.pptx"
    prs.save(output)
    print(f"✅  PPT 생성 완료: {output}  (4슬라이드)")
    print()
    print("📌  캡처 이미지를 아래 파일명으로 같은 폴더에 저장 후 재실행하면 이미지가 삽입됩니다:")
    images = [
        ("img_s1_kpi.png",       "슬라이드 2 — KPI 5개 stat 패널"),
        ("img_s1_active.png",    "슬라이드 2 — 현재 학습 중인 모델 테이블"),
        ("img_s2_lastrun.png",   "슬라이드 3 — 마지막 학습 시각 테이블"),
        ("img_s2_avgdur.png",    "슬라이드 3 — 평균 소요시간 테이블"),
        ("img_s2_ytd.png",       "슬라이드 3 — YTD 누적 횟수 테이블"),
        ("img_s2_compare.png",   "슬라이드 3 — 마지막 vs 평균 비교 테이블"),
        ("img_s2_bar.png",       "슬라이드 3 — 학습 소요시간 막대그래프"),
        ("img_s3_detection.png", "슬라이드 4 — Detection 성능 막대그래프"),
        ("img_s3_cls.png",       "슬라이드 4 — Classification 성능 막대그래프"),
        ("img_s3_trend.png",     "슬라이드 4 — 버전별 성능 추이 팝업 패널"),
    ]
    for fname, desc in images:
        mark = "✅" if os.path.exists(fname) else "⬜"
        print(f"  {mark}  {fname:<28} ← {desc}")


if __name__ == "__main__":
    main()
