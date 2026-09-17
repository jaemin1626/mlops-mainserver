#!/usr/bin/env python3
"""
YOLO 객체 블러 - UI 없이 단독 실행, 다른 프로그램 import 가능

기능 (본 저장소와 동일):
  1) labels  — YOLO .txt 라벨 좌표로 영역 블러 (모델 불필요, 전처리 tab23)
  2) detect  — .pt 로 검출 후 검출 박스 블러 (YOLOv7 detect_and_blur.py 와 동일 UX)

의존성:
  pip install opencv-python numpy
  detect 모드: pip install ultralytics torch

예:
  python yolo_object_blur.py labels ./dataset --blur-ratio 20 --classes 0,1
  python yolo_object_blur.py detect ./images --weights best.pt --blur-ratio 20
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path
from typing import Iterable, Optional, Sequence, Set

import cv2
import numpy as np

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}


# ---------------------------------------------------------------------------
# 공통 유틸
# ---------------------------------------------------------------------------

def parse_class_filter(class_str: str) -> Optional[Set[str]]:
    """쉼표·공백 구분 클래스 ID. 비어 있으면 None(전체)."""
    raw = (class_str or "").strip()
    if not raw:
        return None
    return {p.strip() for p in re.split(r"[,;\s]+", raw) if p.strip()}


def parse_classes_int(class_str: str) -> Optional[list[int]]:
    filt = parse_class_filter(class_str)
    if filt is None:
        return None
    out: list[int] = []
    for x in filt:
        try:
            out.append(int(x))
        except ValueError:
            pass
    return out or None


def imread_bgr(path: Path) -> Optional[np.ndarray]:
    path = Path(path)
    data = path.read_bytes()
    arr = np.frombuffer(data, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def imwrite_bgr(path: Path, image: np.ndarray) -> bool:
    path = Path(path)
    ext = path.suffix.lower()
    enc = ext if ext in (".png", ".bmp", ".tif", ".tiff", ".webp") else ".jpg"
    ok, buf = cv2.imencode(enc, image)
    if not ok or buf is None:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buf.tobytes())
    return True


def resolve_anony_dir(source: Path, output_subdir: str = "Anony") -> Path:
    """폴더/파일 소스 → Anony 출력 루트 (detect_and_blur.py 와 동일 규칙)."""
    source = Path(source).resolve()
    if source.is_file():
        return source.parent / output_subdir
    if source.is_dir():
        return source / output_subdir
    raise FileNotFoundError(f"소스 경로 없음: {source}")


def collect_images(root: Path, *, exclude_under: Optional[Path] = None) -> list[Path]:
    root = Path(root).resolve()
    if root.is_file():
        return [root] if root.suffix.lower() in IMAGE_EXTS else []

    exclude_resolved = exclude_under.resolve() if exclude_under else None
    out: list[Path] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in IMAGE_EXTS:
            continue
        if exclude_resolved is not None:
            try:
                path.resolve().relative_to(exclude_resolved)
                continue
            except ValueError:
                pass
        out.append(path)
    return out


def yolo_norm_to_xyxy(
    x_center: float,
    y_center: float,
    width: float,
    height: float,
    img_w: int,
    img_h: int,
    padding: int = 0,
) -> Optional[tuple[int, int, int, int]]:
    w_abs = width * img_w
    h_abs = height * img_h
    cx = x_center * img_w
    cy = y_center * img_h
    x1 = int(cx - w_abs / 2) - padding
    y1 = int(cy - h_abs / 2) - padding
    x2 = int(cx + w_abs / 2) + padding
    y2 = int(cy + h_abs / 2) + padding
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(img_w - 1, x2), min(img_h - 1, y2)
    if x1 >= x2 or y1 >= y2:
        return None
    return x1, y1, x2, y2


def blur_box_region(
    image: np.ndarray,
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    kernel: int,
) -> bool:
    """단일 박스 영역에 cv2.blur 적용. 성공 시 True."""
    crop = image[y1:y2, x1:x2]
    if crop.size == 0:
        return False
    k = max(1, int(kernel))
    image[y1:y2, x1:x2] = cv2.blur(crop, (k, k))
    return True


def blur_image_from_yolo_txt_lines(
    image: np.ndarray,
    lines: Iterable[str],
    *,
    class_filter: Optional[Set[str]] = None,
    kernel: int = 20,
    padding: int = 0,
) -> int:
    """YOLO txt 한 장분 라인 → image in-place 블러. 적용된 박스 수 반환."""
    h, w = image.shape[:2]
    count = 0
    for line in lines:
        parts = line.strip().split()
        if len(parts) < 5:
            continue
        class_id = parts[0]
        if class_filter is not None and class_id not in class_filter:
            continue
        try:
            _, xc, yc, bw, bh = map(float, parts[:5])
        except ValueError:
            continue
        box = yolo_norm_to_xyxy(xc, yc, bw, bh, w, h, padding)
        if box is None:
            continue
        if blur_box_region(image, *box, kernel):
            count += 1
    return count


# ---------------------------------------------------------------------------
# labels 모드 — 기존 blur_objects_logic
# ---------------------------------------------------------------------------

def run_labels_mode(
    source: Path,
    *,
    blur_ratio: int = 20,
    blur_classes: str = "",
    padding: int = 0,
    copy_txt: bool = True,
    output_subdir: str = "Anony",
    verbose: bool = True,
) -> tuple[int, int]:
    """
    폴더(재귀) 또는 단일 이미지 + 짝 .txt 로 블러.
    Returns: (saved_images, blurred_boxes)
    """
    source = Path(source).resolve()
    root = source.parent if source.is_file() else source
    output_root = resolve_anony_dir(source, output_subdir)
    class_filter = parse_class_filter(blur_classes)
    kernel = max(1, int(blur_ratio))

    images = collect_images(source, exclude_under=output_root)
    if verbose:
        print(f"[labels] 이미지 {len(images)}장, 출력: {output_root}")
        if class_filter is None:
            print("  블러 대상: 모든 클래스")
        else:
            print(f"  블러 대상 클래스: {', '.join(sorted(class_filter))}")
        print(f"  커널: {kernel}×{kernel}, 패딩: {padding}px")

    saved = 0
    blurred_total = 0

    for i, image_path in enumerate(images, 1):
        txt_path = image_path.with_suffix(".txt")
        if not txt_path.is_file():
            if verbose:
                print(f"  [{i}/{len(images)}] 건너뜀 (txt 없음): {image_path.name}")
            continue

        image = imread_bgr(image_path)
        if image is None:
            if verbose:
                print(f"  [{i}/{len(images)}] 로드 실패: {image_path}")
            continue

        lines = txt_path.read_text(encoding="utf-8", errors="replace").splitlines()
        n = blur_image_from_yolo_txt_lines(
            image,
            lines,
            class_filter=class_filter,
            kernel=kernel,
            padding=max(0, int(padding)),
        )

        rel = image_path.relative_to(root)
        out_path = output_root / rel
        if imwrite_bgr(out_path, image):
            saved += 1
            blurred_total += n
            if verbose:
                msg = f"{n}개 블러" if n else "블러 대상 없음"
                print(f"  [{i}/{len(images)}] {image_path.name} — {msg}")

            if copy_txt:
                out_txt = output_root / txt_path.relative_to(root)
                out_txt.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(txt_path, out_txt)
        elif verbose:
            print(f"  [{i}/{len(images)}] 저장 실패: {image_path.name}")

    if verbose:
        print(f"[labels] 완료 — 이미지 {saved}장, 블러 {blurred_total}개")
    return saved, blurred_total


# ---------------------------------------------------------------------------
# detect 모드 — detect_and_blur.py (Ultralytics)
# ---------------------------------------------------------------------------

def _write_yolo_txt_from_ultralytics(result, txt_path: Path) -> None:
    txt_path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    if result.boxes is not None and len(result.boxes):
        for cls, xywh in zip(result.boxes.cls, result.boxes.xywhn):
            c = int(cls)
            x, y, w, h = xywh.tolist()
            lines.append(f"{c} {x:.6f} {y:.6f} {w:.6f} {h:.6f}\n")
    txt_path.write_text("".join(lines), encoding="utf-8")


def run_detect_mode(
    source: Path,
    weights: Path,
    *,
    blur_ratio: int = 20,
    imgsz: int = 896,
    conf: float = 0.25,
    iou: float = 0.45,
    blur_classes: str = "",
    save_txt: bool = True,
    hide_det_area: bool = True,
    device: str = "",
    output_subdir: str = "Anony",
    verbose: bool = True,
) -> tuple[int, int]:
    """
    Ultralytics YOLO 로 검출 후 박스 내부 블러.
    Returns: (saved_images, blurred_boxes)
    """
    try:
        from ultralytics import YOLO
    except ImportError as e:
        raise SystemExit(
            "detect 모드는 ultralytics 가 필요합니다: pip install ultralytics torch"
        ) from e

    source = Path(source).resolve()
    weights = Path(weights).resolve()
    if not weights.is_file():
        raise FileNotFoundError(f"가중치 없음: {weights}")

    root = source.parent if source.is_file() else source
    save_dir = resolve_anony_dir(source, output_subdir)
    save_dir.mkdir(parents=True, exist_ok=True)
    if save_txt:
        (save_dir / "labels").mkdir(parents=True, exist_ok=True)

    classes = parse_classes_int(blur_classes)
    kernel = max(1, int(blur_ratio))
    images = collect_images(source, exclude_under=save_dir)

    if verbose:
        print(f"[detect] 모델: {weights}")
        print(f"  이미지 {len(images)}장, 출력: {save_dir}")
        print(f"  imgsz={imgsz}, conf={conf}, iou={iou}, 커널={kernel}×{kernel}")

    model = YOLO(str(weights))
    saved = 0
    blurred_total = 0

    for i, image_path in enumerate(images, 1):
        image = imread_bgr(image_path)
        if image is None:
            if verbose:
                print(f"  [{i}/{len(images)}] 로드 실패: {image_path}")
            continue

        results = model.predict(
            source=image,
            imgsz=imgsz,
            conf=conf,
            iou=iou,
            classes=classes,
            device=device or None,
            verbose=False,
        )
        result = results[0]
        n = 0

        if result.boxes is not None and len(result.boxes):
            for xyxy in result.boxes.xyxy.cpu().numpy():
                x1, y1, x2, y2 = map(int, xyxy)
                if blur_box_region(image, x1, y1, x2, y2, kernel):
                    n += 1
                if not hide_det_area:
                    cv2.rectangle(image, (x1, y1), (x2, y2), (0, 255, 0), 2)

        if source.is_file():
            out_path = save_dir / image_path.name
        else:
            out_path = save_dir / image_path.relative_to(root)

        if imwrite_bgr(out_path, image):
            saved += 1
            blurred_total += n
            if verbose:
                print(f"  [{i}/{len(images)}] {image_path.name} — {n}개 블러")

            if save_txt:
                if source.is_file():
                    txt_path = save_dir / "labels" / f"{image_path.stem}.txt"
                else:
                    rel = image_path.relative_to(root)
                    txt_path = save_dir / "labels" / rel.with_suffix(".txt")
                _write_yolo_txt_from_ultralytics(result, txt_path)
        elif verbose:
            print(f"  [{i}/{len(images)}] 저장 실패: {image_path.name}")

    if verbose:
        print(f"[detect] 완료 — 이미지 {saved}장, 블러 {blurred_total}개")
    return saved, blurred_total


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="YOLO 객체 블러 (라벨 기반 / 검출+블러)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = p.add_subparsers(dest="mode", required=True)

    pl = sub.add_parser("labels", help="YOLO .txt 라벨로 블러 (모델 불필요)")
    pl.add_argument("source", type=Path, help="이미지 폴더 또는 단일 이미지")
    pl.add_argument("--blur-ratio", type=int, default=20, help="cv2.blur 커널 k×k (기본 20)")
    pl.add_argument("--classes", default="", help="블러할 클래스 ID (쉼표/공백, 비우면 전체)")
    pl.add_argument("--padding", type=int, default=0, help="박스 바깥 확장 px")
    pl.add_argument("--no-copy-txt", action="store_true", help=".txt 를 Anony/ 에 복사하지 않음")
    pl.add_argument("--output-subdir", default="Anony", help="출력 하위 폴더명 (기본 Anony)")
    pl.add_argument("-q", "--quiet", action="store_true")

    pd = sub.add_parser("detect", help="Ultralytics .pt 검출 후 블러")
    pd.add_argument("source", type=Path, help="이미지 폴더 또는 단일 이미지")
    pd.add_argument("--weights", "-w", type=Path, required=True, help="YOLO .pt 가중치")
    pd.add_argument("--blur-ratio", type=int, default=20, help="cv2.blur 커널 k×k (기본 20)")
    pd.add_argument("--imgsz", type=int, default=896)
    pd.add_argument("--conf", type=float, default=0.25)
    pd.add_argument("--iou", type=float, default=0.45)
    pd.add_argument("--classes", default="", help="검출·블러할 클래스 ID")
    pd.add_argument("--no-save-txt", action="store_true", help="YOLO 라벨 txt 저장 안 함")
    pd.add_argument("--show-boxes", action="store_true", help="검출 박스 테두리 표시 (기본: 숨김)")
    pd.add_argument("--device", default="", help="cuda device 또는 cpu")
    pd.add_argument("--output-subdir", default="Anony")
    pd.add_argument("-q", "--quiet", action="store_true")

    return p


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    verbose = not args.quiet

    try:
        if args.mode == "labels":
            run_labels_mode(
                args.source,
                blur_ratio=args.blur_ratio,
                blur_classes=args.classes,
                padding=args.padding,
                copy_txt=not args.no_copy_txt,
                output_subdir=args.output_subdir,
                verbose=verbose,
            )
        elif args.mode == "detect":
            run_detect_mode(
                args.source,
                args.weights,
                blur_ratio=args.blur_ratio,
                imgsz=args.imgsz,
                conf=args.conf,
                iou=args.iou,
                blur_classes=args.classes,
                save_txt=not args.no_save_txt,
                hide_det_area=not args.show_boxes,
                device=args.device,
                output_subdir=args.output_subdir,
                verbose=verbose,
            )
        else:
            raise AssertionError(f"unknown mode: {args.mode}")
    except (FileNotFoundError, SystemExit) as e:
        print(f"오류: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
