#!/usr/bin/env python3
"""
PPOCRLabel(autoDialog) 기반 OCR sidecar — 단어 박스(return_word_box) 검출.
- PaddleOCR + TextRecognition 1회 로드 후 ocr.predict(img) 연속 호출
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from typing import Any

os.environ.setdefault("DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("FLAGS_use_mkldnn", "0")


def configure_stdio_utf8() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if hasattr(sys.stdin, "reconfigure"):
        try:
            sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


configure_stdio_utf8()

def _add_windows_dll_dirs() -> None:
    """Electron spawn 환경에서 torch/paddle 종속 DLL을 못 찾는 WinError 127 완화."""
    if sys.platform != "win32" or not hasattr(os, "add_dll_directory"):
        return
    roots: list[str] = []
    try:
        import site

        for sp in site.getsitepackages() + [site.getusersitepackages()]:
            if not sp:
                continue
            roots.append(os.path.join(sp, "torch", "lib"))
            roots.append(os.path.join(sp, "paddle", "libs"))
            roots.append(os.path.join(sp, "paddle", "base", "lib"))
    except Exception:  # noqa: BLE001
        pass
    # site-packages가 비어 있어도 실행 파일 기준 추정
    prefix = getattr(sys, "base_prefix", None) or sys.prefix
    roots.extend(
        [
            os.path.join(prefix, "Lib", "site-packages", "torch", "lib"),
            os.path.join(prefix, "Lib", "site-packages", "paddle", "libs"),
        ]
    )
    seen: set[str] = set()
    for d in roots:
        key = os.path.normcase(os.path.abspath(d))
        if key in seen or not os.path.isdir(d):
            continue
        seen.add(key)
        try:
            os.add_dll_directory(d)
        except Exception:  # noqa: BLE001
            pass
        # PATH에도 넣어 CreateProcess 계열 종속 로딩 보조
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


_add_windows_dll_dirs()

# Windows: paddle 선로드 시 modelscope→torch DLL 충돌 → torch를 paddle/paddleocr보다 먼저 import
try:
    import torch  # noqa: F401
except Exception:  # noqa: BLE001
    pass

try:
    import paddle
except Exception as _paddle_err:  # noqa: BLE001
    paddle = None  # type: ignore[assignment,misc]
    _PADDLE_IMPORT_ERROR: str | None = str(_paddle_err)
else:
    _PADDLE_IMPORT_ERROR = None

try:
    from paddleocr import PaddleOCR, TextRecognition
except Exception as _import_err:  # noqa: BLE001
    PaddleOCR = None  # type: ignore[misc, assignment]
    TextRecognition = None  # type: ignore[misc, assignment]
    _PADDLEOCR_IMPORT_ERROR: str | None = str(_import_err)
else:
    _PADDLEOCR_IMPORT_ERROR = None


def _is_fatal_ocr_error(exc: BaseException) -> bool:
    msg = str(exc)
    return (
        "PDX has already been initialized" in msg
        or "WinError 127" in msg
        or "shm.dll" in msg
        or "Error loading" in msg and "torch" in msg
        or "DLL load failed" in msg
    )

# PP-OCRv5 / PP-OCRv6 — tiny가 v6 최경량 (약 1.5M 파라미터)
MODEL_PRESETS: dict[str, dict[str, str]] = {
    "mobile": {
        "det": "PP-OCRv5_mobile_det",
        "rec": "PP-OCRv5_mobile_rec",
        "label": "PP-OCRv5 mobile",
    },
    "server": {
        "det": "PP-OCRv5_server_det",
        "rec": "PP-OCRv5_server_rec",
        "label": "PP-OCRv5 server",
    },
    "v6_tiny": {
        "det": "PP-OCRv6_tiny_det",
        "rec": "PP-OCRv6_tiny_rec",
        "label": "PP-OCRv6 tiny",
    },
}

ocr_engine = None
text_recognizer = None
active_lang: str | None = None
active_device: str = "cpu"
active_preset: str = "v6_tiny"


def normalize_preset(preset: str | None) -> str:
    key = str(preset or "v6_tiny").strip().lower()
    return key if key in MODEL_PRESETS else "v6_tiny"


def current_model_names() -> tuple[str, str]:
    row = MODEL_PRESETS[active_preset]
    return row["det"], row["rec"]


def inspect_gpu() -> dict[str, Any]:
    """CUDA 사용 가능 여부 — PPOCRLabel과 동일하게 paddle 선로드 후 확인."""
    override = os.environ.get("OCR_DEVICE", "gpu").strip().lower()
    if override == "cpu":
        return {
            "gpu_available": False,
            "requested": "cpu",
            "reason": "OCR_DEVICE=cpu (CPU 강제)",
        }
    if paddle is None:
        return {
            "gpu_available": False,
            "requested": "gpu",
            "reason": _PADDLE_IMPORT_ERROR or "paddle import 실패",
        }
    try:
        if not paddle.is_compiled_with_cuda():
            return {
                "gpu_available": False,
                "requested": "gpu",
                "reason": "paddlepaddle CPU 패키지 — paddlepaddle-gpu 설치 필요",
            }
        if paddle.device.cuda.device_count() <= 0:
            return {"gpu_available": False, "requested": "gpu", "reason": "CUDA GPU를 찾을 수 없음"}
        return {"gpu_available": True, "requested": "gpu", "reason": ""}
    except Exception as exc:  # noqa: BLE001
        return {"gpu_available": False, "requested": "gpu", "reason": str(exc)}


def resolve_device() -> str:
    """기본 GPU 우선. GPU 불가 시에만 CPU (UI에서 경고)."""
    info = inspect_gpu()
    if info["requested"] == "cpu":
        return "cpu"
    return "gpu" if info["gpu_available"] else "cpu"


def device_status_payload() -> dict[str, Any]:
    info = inspect_gpu()
    running_on_cpu = active_device == "cpu"
    warning: str | None = None
    if running_on_cpu:
        if info["requested"] == "cpu":
            warning = "CPU 강제 모드(OCR_DEVICE=cpu)로 동작 중입니다."
        else:
            reason = str(info.get("reason") or "GPU를 사용할 수 없습니다")
            warning = (
                f"현재 CPU로 동작 중입니다 — {reason}. "
                "paddlepaddle-gpu·torch 설치 상태를 확인한 뒤 앱을 재시작하세요."
            )
    det_name, rec_name = current_model_names()
    return {
        "device": active_device,
        "gpuAvailable": bool(info["gpu_available"]),
        "runningOnCpu": running_on_cpu,
        "deviceWarning": warning,
        "modelPreset": active_preset,
        "modelLabel": MODEL_PRESETS[active_preset]["label"],
        "detModel": det_name,
        "recModel": rec_name,
        "detectOptions": dict(active_detect_options),
    }


def reset_engines() -> None:
    global ocr_engine, text_recognizer, active_lang, active_device, active_preset, active_detect_options
    ocr_engine = None
    text_recognizer = None
    active_lang = None
    active_device = "cpu"
    active_preset = "v6_tiny"
    active_detect_options = {
        "minTextLen": MIN_TEXT_LEN,
        "minBoxSize": MIN_BOX_W,
    }


def write_response(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def imread_unicode(path: str):
    import cv2
    import numpy as np

    data = np.fromfile(path, dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def build_ppocrlabel_ocr(lang: str, device: str, det_name: str, rec_name: str):
    """PP-OCRv5/v6 — 단어 단위 박스(return_word_box)로 번호판 등 공백 분리."""
    if PaddleOCR is None:
        raise RuntimeError(_PADDLEOCR_IMPORT_ERROR or "paddleocr is not installed")
    return PaddleOCR(
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device=device,
        lang=lang,
        text_detection_model_name=det_name,
        text_recognition_model_name=rec_name,
        enable_mkldnn=False,
        return_word_box=True,
    )


def build_ppocrlabel_recognizer(device: str, rec_name: str):
    if TextRecognition is None:
        raise RuntimeError(_PADDLEOCR_IMPORT_ERROR or "paddleocr is not installed")
    return TextRecognition(model_name=rec_name, device=device)


def warmup_ocr() -> None:
    """PPOCRLabel — data/paddle.png 또는 더미 이미지로 1회 predict."""
    if ocr_engine is None:
        return
    script_dir = os.path.dirname(os.path.abspath(__file__))
    sample = os.path.normpath(os.path.join(script_dir, "..", "..", "PPOCRLabel", "data", "paddle.png"))
    if os.path.isfile(sample):
        try:
            ocr_engine.predict(sample)
            return
        except Exception:
            pass
    import numpy as np

    try:
        dummy = np.zeros((64, 64, 3), dtype=np.uint8)
        ocr_engine.predict(dummy)
    except Exception:
        pass


def ensure_init(lang: str, preset: str = "v6_tiny") -> None:
    """PPOCRLabel 앱 기동 시 모델 로드 — lang·preset 변경 시에만 재생성."""
    global ocr_engine, text_recognizer, active_lang, active_device, active_preset
    preset = normalize_preset(preset)
    device = resolve_device()
    if (
        ocr_engine is not None
        and text_recognizer is not None
        and active_lang == lang
        and active_device == device
        and active_preset == preset
    ):
        return

    ocr_engine = None
    text_recognizer = None
    row = MODEL_PRESETS[preset]
    ocr_engine = build_ppocrlabel_ocr(lang, device, row["det"], row["rec"])
    text_recognizer = build_ppocrlabel_recognizer(device, row["rec"])
    active_lang = lang
    active_device = device
    active_preset = preset
    warmup_ocr()


MIN_BOX_W = 20
MIN_BOX_H = 20
MIN_TEXT_LEN = 2
# 단어 박스 가로 여유 — 라인 높이 대비 (det 박스보다 좁게 잡히는 보정)
WORD_BOX_X_PAD_RATIO = 0.12

active_detect_options: dict[str, int] = {
    "minTextLen": MIN_TEXT_LEN,
    "minBoxSize": MIN_BOX_W,
}


def parse_detect_options(raw: Any) -> dict[str, int]:
    opts = dict(active_detect_options)
    if not isinstance(raw, dict):
        return opts
    try:
        min_text = int(raw.get("minTextLen", opts["minTextLen"]))
        opts["minTextLen"] = max(1, min(32, min_text))
    except (TypeError, ValueError):
        pass
    try:
        min_box = int(raw.get("minBoxSize", opts["minBoxSize"]))
        opts["minBoxSize"] = max(1, min(512, min_box))
    except (TypeError, ValueError):
        pass
    return opts


def apply_detect_options(raw: Any) -> dict[str, int]:
    global active_detect_options
    active_detect_options = parse_detect_options(raw)
    return active_detect_options


def _keep_text_box(text: str) -> bool:
    t = str(text or "").strip()
    if not t:
        return False
    return len(t) >= active_detect_options["minTextLen"]


def _quad_bounds(pts: list[list[float]]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _refine_word_quad(
    pts: list[list[float]],
    line_poly: Any,
    img_w: int | None = None,
    img_h: int | None = None,
) -> list[list[float]]:
    """단어 박스 — 라인 det 높이·가로 패딩·최소 크기 보정."""
    wx0, wy0, wx1, wy1 = _quad_bounds(pts)
    if line_poly is not None:
        if hasattr(line_poly, "tolist"):
            line_poly = line_poly.tolist()
        if isinstance(line_poly, (list, tuple)) and len(line_poly) >= 3:
            line_pts = [[float(p[0]), float(p[1])] for p in line_poly]
            lx0, ly0, lx1, ly1 = _quad_bounds(line_pts)
            line_h = max(1.0, ly1 - ly0)
            pad_x = max(2.0, line_h * WORD_BOX_X_PAD_RATIO)
            wx0 = _clamp(wx0 - pad_x, lx0, lx1)
            wx1 = _clamp(wx1 + pad_x, lx0, lx1)
            wy0, wy1 = ly0, ly1

    cx = (wx0 + wx1) / 2.0
    cy = (wy0 + wy1) / 2.0
    min_box = float(active_detect_options["minBoxSize"])
    half_w = max((wx1 - wx0) / 2.0, min_box / 2.0)
    half_h = max((wy1 - wy0) / 2.0, min_box / 2.0)
    wx0, wx1 = cx - half_w, cx + half_w
    wy0, wy1 = cy - half_h, cy + half_h

    if img_w is not None and img_w > 0:
        wx0 = _clamp(wx0, 0.0, float(img_w))
        wx1 = _clamp(wx1, 0.0, float(img_w))
    if img_h is not None and img_h > 0:
        wy0 = _clamp(wy0, 0.0, float(img_h))
        wy1 = _clamp(wy1, 0.0, float(img_h))

    return _rect_to_quad_points(wx0, wy0, wx1, wy1)


def _rect_to_quad_points(xmin: float, ymin: float, xmax: float, ymax: float) -> list[list[float]]:
    return [
        [xmin, ymin],
        [xmax, ymin],
        [xmax, ymax],
        [xmin, ymax],
    ]


def _poly_to_box_dict(poly: Any, text: str, score: float) -> dict[str, Any] | None:
    if poly is None:
        return None
    if hasattr(poly, "tolist"):
        poly = poly.tolist()
    if not isinstance(poly, (list, tuple)) or len(poly) < 3:
        return None
    pts = [[float(p[0]), float(p[1])] for p in poly]
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return {
        "text": text,
        "score": score,
        "xmin": min(xs),
        "ymin": min(ys),
        "xmax": max(xs),
        "ymax": max(ys),
        "points": pts,
    }


def _word_box_to_quad(word_box: Any) -> list[list[float]] | None:
    if word_box is None:
        return None
    if hasattr(word_box, "tolist"):
        word_box = word_box.tolist()
    if not isinstance(word_box, (list, tuple)):
        return None
    if len(word_box) == 4 and all(isinstance(v, (int, float)) for v in word_box):
        xmin, ymin, xmax, ymax = (float(v) for v in word_box)
        return _rect_to_quad_points(xmin, ymin, xmax, ymax)
    if len(word_box) >= 4 and isinstance(word_box[0], (list, tuple)):
        return [[float(p[0]), float(p[1])] for p in word_box[:4]]
    return None


def boxes_from_ocr_result(
    result: dict[str, Any],
    img_w: int | None = None,
    img_h: int | None = None,
) -> list[dict[str, Any]]:
    """return_word_box 결과를 단어 박스로 변환. 공백·빈 단어는 제외."""
    word_texts = result.get("text_word") or []
    word_boxes = result.get("text_word_boxes") or result.get("text_word_region") or []
    line_scores = result.get("rec_scores") or []
    line_polys = result.get("rec_polys") or []
    line_texts = result.get("rec_texts") or []

    boxes: list[dict[str, Any]] = []
    if word_texts and word_boxes:
        for line_idx, words in enumerate(word_texts):
            line_text = str(line_texts[line_idx]).strip() if line_idx < len(line_texts) else ""
            if not _keep_text_box(line_text):
                continue
            if not isinstance(words, (list, tuple)):
                words = [words]
            line_box_row = word_boxes[line_idx] if line_idx < len(word_boxes) else None
            if line_box_row is None:
                continue
            if hasattr(line_box_row, "tolist"):
                line_box_row = line_box_row.tolist()
            line_poly = line_polys[line_idx] if line_idx < len(line_polys) else None
            score = float(line_scores[line_idx]) if line_idx < len(line_scores) else 0.0
            for word_idx, word in enumerate(words):
                text = str(word).strip()
                if not _keep_text_box(text):
                    continue
                wb = None
                if isinstance(line_box_row, (list, tuple)) and word_idx < len(line_box_row):
                    wb = line_box_row[word_idx]
                pts = _word_box_to_quad(wb)
                if pts is None:
                    continue
                pts = _refine_word_quad(pts, line_poly, img_w, img_h)
                row = _poly_to_box_dict(pts, text, score)
                if row is not None:
                    boxes.append(row)
        if boxes:
            return boxes

    polys = result.get("rec_polys") or []
    texts = result.get("rec_texts") or []
    for i, poly in enumerate(polys):
        text = str(texts[i]).strip() if i < len(texts) else ""
        if not _keep_text_box(text):
            continue
        score = float(line_scores[i]) if i < len(line_scores) else 0.0
        if poly is not None:
            if hasattr(poly, "tolist"):
                poly = poly.tolist()
            if isinstance(poly, (list, tuple)) and len(poly) >= 3:
                pts = [[float(p[0]), float(p[1])] for p in poly]
                pts = _refine_word_quad(pts, None, img_w, img_h)
                poly = pts
        row = _poly_to_box_dict(poly, text, score)
        if row is not None:
            boxes.append(row)
    return boxes


def predict_image(img) -> list[dict[str, Any]]:
    """autoRecognitionCurrent / autoDialog.Worker.run — 단어 박스 우선."""
    h, w = img.shape[:2]
    if h <= 32 or w <= 32:
        return []

    raw = ocr_engine.predict(img)
    if not raw:
        return []
    result = raw[0] if isinstance(raw, list) and len(raw) > 0 else raw
    if result is None:
        return []
    # paddlex OCRResult는 Mapping이지만 dict가 아닐 수 있음 → 키 접근 가능한 형태로 정규화
    if not isinstance(result, dict):
        if hasattr(result, "keys") and hasattr(result, "get"):
            result = {k: result.get(k) for k in result.keys()}  # type: ignore[union-attr]
        elif hasattr(result, "json") and isinstance(getattr(result, "json"), dict):
            nested = result.json.get("res") if isinstance(result.json.get("res"), dict) else result.json
            result = nested if isinstance(nested, dict) else {}
        else:
            return []
    if not isinstance(result, dict):
        return []
    return boxes_from_ocr_result(result, img_w=w, img_h=h)


def detect_recognize_path(path: str) -> tuple[list[dict[str, Any]], int]:
    img = imread_unicode(path)
    if img is None:
        raise RuntimeError(f"failed to read image: {path}")
    t0 = time.perf_counter()
    boxes = predict_image(img)
    predict_ms = int((time.perf_counter() - t0) * 1000)
    return boxes, predict_ms


def batch_detect_paths(paths: list[str]) -> dict[str, Any]:
    """AutoDialog.Worker — 동일 프로세스·동일 ocr_engine 으로 연속 predict."""
    results: list[dict[str, Any]] = []
    total_predict_ms = 0
    for path in paths:
        t0 = time.perf_counter()
        try:
            boxes, predict_ms = detect_recognize_path(path)
            total_predict_ms += predict_ms
            results.append(
                {
                    "imagePath": path,
                    "ok": True,
                    "boxes": boxes,
                    "predictMs": predict_ms,
                }
            )
        except Exception as exc:  # noqa: BLE001
            predict_ms = int((time.perf_counter() - t0) * 1000)
            total_predict_ms += predict_ms
            results.append(
                {
                    "imagePath": path,
                    "ok": False,
                    "error": str(exc),
                    "boxes": [],
                    "predictMs": predict_ms,
                }
            )
    return {
        "results": results,
        "totalPredictMs": total_predict_ms,
        "count": len(results),
    }


def get_rotate_crop_image(img, points):
    """PPOCRLabel libs/utils.py — reRecognition / singleRerecognition."""
    import cv2
    import numpy as np

    pts = np.array(points, dtype=np.float32)
    if pts.shape[0] < 4:
        raise ValueError("need 4 points")
    pts = pts[:4].copy()
    d = 0.0
    for index in range(-1, 3):
        d += (
            -0.5
            * (pts[index + 1][1] + pts[index][1])
            * (pts[index + 1][0] - pts[index][0])
        )
    if d < 0:
        pts[1], pts[3] = pts[3].copy(), pts[1].copy()

    img_crop_width = int(
        max(
            np.linalg.norm(pts[0] - pts[1]),
            np.linalg.norm(pts[2] - pts[3]),
        )
    )
    img_crop_height = int(
        max(
            np.linalg.norm(pts[0] - pts[3]),
            np.linalg.norm(pts[1] - pts[2]),
        )
    )
    if img_crop_width < 1 or img_crop_height < 1:
        return None
    pts_std = np.float32(
        [
            [0, 0],
            [img_crop_width, 0],
            [img_crop_width, img_crop_height],
            [0, img_crop_height],
        ]
    )
    m = cv2.getPerspectiveTransform(pts, pts_std)
    dst_img = cv2.warpPerspective(
        img,
        m,
        (img_crop_width, img_crop_height),
        borderMode=cv2.BORDER_REPLICATE,
        flags=cv2.INTER_CUBIC,
    )
    dst_h, dst_w = dst_img.shape[0:2]
    if dst_h * 1.0 / dst_w >= 1.5:
        dst_img = np.rot90(dst_img)
    return dst_img


def recognize_quad(path: str, points: list) -> dict[str, Any]:
    img = imread_unicode(path)
    if img is None:
        raise RuntimeError(f"failed to read image: {path}")
    if not points or len(points) < 4:
        raise ValueError("points must have 4 entries")
    crop = get_rotate_crop_image(img, points)
    if crop is None:
        raise RuntimeError("failed to crop quad region")
    result = text_recognizer.predict(crop)
    if not result:
        return {"text": "", "score": 0.0}
    row = result[0] if isinstance(result, list) else result
    if isinstance(row, dict):
        return {
            "text": str(row.get("rec_text") or row.get("text") or "").strip(),
            "score": float(row.get("rec_score") or row.get("score") or 0.0),
        }
    return {"text": "", "score": 0.0}


def handle(req: dict[str, Any]) -> dict[str, Any]:
    cmd = req.get("cmd")
    lang = str(req.get("lang") or "korean")
    preset = normalize_preset(req.get("modelPreset"))

    if cmd == "ping":
        info = inspect_gpu()
        return {
            "ok": True,
            "ready": ocr_engine is not None,
            **(
                device_status_payload()
                if ocr_engine is not None
                else {
                    "device": "gpu" if info["gpu_available"] else "cpu",
                    "gpuAvailable": bool(info["gpu_available"]),
                    "runningOnCpu": not info["gpu_available"],
                    "deviceWarning": (
                        None
                        if info["gpu_available"]
                        else f"GPU 미사용 — {info['reason']}. OCR 준비 전 상태입니다."
                    ),
                }
            ),
        }

    if cmd == "init":
        if PaddleOCR is None or TextRecognition is None:
            raise RuntimeError(
                _PADDLEOCR_IMPORT_ERROR
                or "paddleocr import failed — Python 환경에 paddleocr/paddlepaddle를 설치하세요."
            )
        t0 = time.perf_counter()
        apply_detect_options(req.get("detectOptions"))
        ensure_init(lang, preset)
        load_ms = int((time.perf_counter() - t0) * 1000)
        return {"ok": True, "ready": True, "loadMs": load_ms, **device_status_payload()}

    if cmd == "shutdown":
        reset_engines()
        return {"ok": True}

    if cmd == "detect_recognize":
        path = str(req.get("imagePath") or "")
        if not path:
            raise ValueError("imagePath required")
        apply_detect_options(req.get("detectOptions"))
        if ocr_engine is None:
            ensure_init(lang, preset)
        boxes, predict_ms = detect_recognize_path(path)
        return {
            "ok": True,
            "boxes": boxes,
            "predictMs": predict_ms,
            **device_status_payload(),
        }

    if cmd == "batch_detect":
        paths = req.get("imagePaths") or []
        if not isinstance(paths, list) or len(paths) == 0:
            raise ValueError("imagePaths required")
        apply_detect_options(req.get("detectOptions"))
        if ocr_engine is None:
            ensure_init(lang, preset)
        batch = batch_detect_paths([str(p) for p in paths])
        return {
            "ok": True,
            **batch,
            **device_status_payload(),
        }

    if cmd == "recognize_quad":
        path = str(req.get("imagePath") or "")
        if not path:
            raise ValueError("imagePath required")
        if text_recognizer is None:
            ensure_init(lang, preset)
        pts = req.get("points") or []
        text = recognize_quad(path, pts)
        return {"ok": True, **text}

    raise ValueError(f"unknown cmd: {cmd}")


def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        req_id = None
        req: dict[str, Any] = {}
        fatal = False
        try:
            req = json.loads(line)
            req_id = req.get("id")
            out = handle(req)
        except Exception as exc:  # noqa: BLE001
            fatal = _is_fatal_ocr_error(exc)
            out = {
                "ok": False,
                "error": str(exc),
                "trace": traceback.format_exc(),
                "fatal": fatal,
            }
        if req_id is not None:
            out["id"] = req_id
        write_response(out)
        if fatal:
            # Electron이 깨끗한 워커를 다시 띄우도록 프로세스 종료
            raise SystemExit(2)
        if isinstance(req, dict) and req.get("cmd") == "shutdown":
            break


if __name__ == "__main__":
    main()
