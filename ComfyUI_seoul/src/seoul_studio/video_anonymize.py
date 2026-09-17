"""영상 프레임별 YOLO 검출 + 블러 비식별화."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable, Optional

import cv2

from seoul_studio.blur_detector import load_blur_model
from seoul_studio.library_paths import anony_dest_for_source
from seoul_studio.task_export import unique_dest_path
from seoul_studio.yolo_object_blur import blur_box_region, imread_bgr, imwrite_bgr, parse_classes_int


def default_weights_path() -> Path:
    return Path(os.environ.get("SEOUL_STUDIO_BLUR_WEIGHTS", "/data/models/anonymize/best.pt")).resolve()


def default_blur_ratio() -> int:
    raw = os.environ.get("SEOUL_STUDIO_BLUR_RATIO", "10").strip()
    try:
        return max(1, int(raw))
    except ValueError:
        return 10


def default_conf() -> float:
    raw = os.environ.get("SEOUL_STUDIO_BLUR_CONF", "0.25").strip()
    try:
        return float(raw)
    except ValueError:
        return 0.25


def default_imgsz() -> int:
    raw = os.environ.get("SEOUL_STUDIO_BLUR_IMGSZ", "896").strip()
    try:
        return max(32, int(raw))
    except ValueError:
        return 896


def format_blur_classes(class_ids: list[int] | None) -> str:
    """선택 클래스 ID → yolo_object_blur `--classes` 문자열. None/빈 리스트 = 전체."""
    if not class_ids:
        return ""
    return ",".join(str(int(class_id)) for class_id in class_ids)


def anonymize_video(
    source: Path,
    *,
    weights: Path,
    blur_ratio: int | None = None,
    imgsz: int | None = None,
    conf: float | None = None,
    iou: float = 0.45,
    blur_classes: str = "",
    class_ids: list[int] | None = None,
    device: str = "",
    dest: Path | None = None,
    save_txt: bool = False,
    on_progress: Optional[Callable[[dict[str, Any]], None]] = None,
) -> dict:
    source = Path(source).resolve()
    weights = Path(weights).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"영상 없음: {source}")
    if not weights.is_file():
        raise FileNotFoundError(
            f"가중치(.pt) 없음: {weights}. SEOUL_STUDIO_BLUR_WEIGHTS 경로에 모델을 배치하세요."
        )

    kernel = max(1, int(blur_ratio if blur_ratio is not None else default_blur_ratio()))
    predict_imgsz = imgsz if imgsz is not None else default_imgsz()
    predict_conf = conf if conf is not None else default_conf()
    if class_ids is not None:
        blur_classes = format_blur_classes(class_ids)
    classes = parse_classes_int(blur_classes)
    if save_txt:
        raise ValueError("비식별화 처리에서는 라벨 txt 저장(save_txt)을 지원하지 않습니다.")

    if dest is None:
        dest = anony_dest_for_source(source, unique_dest_path)
    dest.parent.mkdir(parents=True, exist_ok=True)

    cap = cv2.VideoCapture(str(source))
    if not cap.isOpened():
        raise RuntimeError(f"영상을 열 수 없습니다: {source}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    if not fps or fps <= 0 or fps > 1000:
        fps = 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if width <= 0 or height <= 0:
        cap.release()
        raise RuntimeError("영상 해상도를 읽을 수 없습니다.")

    model = load_blur_model(weights)
    frame_count = 0
    blurred_boxes = 0
    total_frames_est = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if total_frames_est <= 0:
        total_frames_est = None

    with tempfile.TemporaryDirectory(prefix="seoul-anony-") as tmpdir:
        raw_path = Path(tmpdir) / "raw.mp4"
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(str(raw_path), fourcc, fps, (width, height))
        if not writer.isOpened():
            cap.release()
            raise RuntimeError("출력 영상 writer를 열 수 없습니다.")

        while True:
            ok, frame = cap.read()
            if not ok:
                break
            frame_count += 1
            results = model.predict(
                source=frame,
                imgsz=predict_imgsz,
                conf=predict_conf,
                iou=iou,
                classes=classes,
                device=device or None,
                verbose=False,
                save=False,
                save_txt=False,
            )
            result = results[0]
            if result.boxes is not None and len(result.boxes):
                for xyxy in result.boxes.xyxy.cpu().numpy():
                    x1, y1, x2, y2 = map(int, xyxy)
                    if blur_box_region(frame, x1, y1, x2, y2, kernel):
                        blurred_boxes += 1
            writer.write(frame)
            if on_progress:
                on_progress(
                    {
                        "phase": "processing",
                        "frame": frame_count,
                        "total_frames": total_frames_est,
                    }
                )

        cap.release()
        writer.release()

        if frame_count == 0:
            raise RuntimeError("처리할 프레임이 없습니다.")

        if on_progress:
            on_progress({"phase": "encoding"})
        _encode_h264(raw_path, dest, fps)

    return {
        "source": str(source),
        "dest": str(dest),
        "frame_count": frame_count,
        "blurred_boxes": blurred_boxes,
    }


def _encode_h264(source: Path, dest: Path, fps: float) -> None:
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-r",
        str(fps),
        str(dest),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip() or "ffmpeg 인코딩 실패"
        raise RuntimeError(detail) from exc


def anonymize_image(
    source: Path,
    *,
    dest: Path | None = None,
    weights: Path | None = None,
    blur_ratio: int | None = None,
    conf: float | None = None,
    class_ids: list[int] | None = None,
) -> dict[str, Any]:
    """단일 이미지 YOLO 검출 + 블러."""
    source = source.resolve()
    if not source.is_file():
        raise FileNotFoundError(f"이미지를 찾을 수 없습니다: {source}")

    if dest is None:
        dest = anony_dest_for_source(source, unique_dest_path)
    dest.parent.mkdir(parents=True, exist_ok=True)

    weights = (weights or default_weights_path()).resolve()
    blur_ratio = blur_ratio if blur_ratio is not None else default_blur_ratio()
    conf = conf if conf is not None else default_conf()
    imgsz = default_imgsz()
    classes_str = format_blur_classes(class_ids)

    image = imread_bgr(source)
    if image is None:
        raise RuntimeError(f"이미지를 읽을 수 없습니다: {source}")
    model = load_blur_model(weights)
    results = model.predict(
        image,
        conf=conf,
        imgsz=imgsz,
        classes=parse_classes_int(classes_str) if classes_str else None,
        verbose=False,
    )
    blurred_boxes = 0
    for result in results:
        boxes = getattr(result, "boxes", None)
        if boxes is None:
            continue
        for box in boxes:
            xyxy = box.xyxy[0].tolist()
            blur_box_region(image, xyxy, blur_ratio)
            blurred_boxes += 1

    imwrite_bgr(dest, image)
    return {
        "source": str(source),
        "dest": str(dest),
        "blurred_boxes": blurred_boxes,
    }
