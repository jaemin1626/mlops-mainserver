"""비식별화 YOLO 가중치 로드 (ultralytics / YOLOv7)."""

from __future__ import annotations

from pathlib import Path

from seoul_studio.yolov7_backend import load_yolov7_model, weights_look_like_yolov7

_blur_model_cache: dict[str, object] = {}


def friendly_blur_load_error(exc: Exception) -> str:
    msg = str(exc).strip()
    lower = msg.lower()
    if "yolov5" in lower and ("not forwards compatible" in lower or "yolov8" in lower):
        return (
            "가중치(.pt)가 YOLOv5 형식입니다. YOLOv7 native .pt 는 YOLOv7 백엔드로, "
            "ultralytics .pt 는 YOLOv8+ 백엔드로 자동 처리됩니다."
        )
    if "can't get attribute 'mp'" in lower or "no module named 'models'" in lower:
        return (
            "가중치(.pt)를 로드할 수 없습니다. YOLOv7 학습 가중치라면 SEOUL_STUDIO_YOLOV7_DIR "
            "경로에 yolov7 코드가 있어야 합니다."
        )
    if msg:
        return msg
    return "가중치(.pt) 로드에 실패했습니다."


def detect_weights_backend(weights: Path) -> str:
    if weights_look_like_yolov7(weights):
        return "yolov7"
    return "ultralytics"


def load_blur_model(weights: Path):
    weights = Path(weights).resolve()
    if not weights.is_file():
        raise FileNotFoundError(
            f"가중치(.pt) 없음: {weights}. SEOUL_STUDIO_BLUR_WEIGHTS 경로에 모델을 배치하세요."
        )

    cache_key = f"{weights}:{weights.stat().st_mtime_ns}"
    cached = _blur_model_cache.get(cache_key)
    if cached is not None:
        return cached

    backend = detect_weights_backend(weights)
    try:
        if backend == "yolov7":
            model = load_yolov7_model(weights)
        else:
            model = _load_ultralytics_model(weights)
    except TypeError as exc:
        if backend == "ultralytics" and weights_look_like_yolov7(weights):
            try:
                model = load_yolov7_model(weights)
            except Exception as fallback_exc:
                raise RuntimeError(friendly_blur_load_error(fallback_exc)) from fallback_exc
        else:
            raise RuntimeError(friendly_blur_load_error(exc)) from exc
    except Exception as exc:
        raise RuntimeError(friendly_blur_load_error(exc)) from exc

    _blur_model_cache.clear()
    _blur_model_cache[cache_key] = model
    return model


def _load_ultralytics_model(weights: Path):
    try:
        from ultralytics import YOLO
    except ImportError as exc:
        raise RuntimeError("비식별화에 ultralytics 가 필요합니다.") from exc
    return YOLO(str(weights))


def validate_blur_weights(weights: Path) -> str | None:
    try:
        load_blur_model(weights)
        return None
    except (FileNotFoundError, RuntimeError) as exc:
        return str(exc)
