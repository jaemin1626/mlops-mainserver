"""YOLOv7 (WongKinYiu) 가중치 로드·프레임 추론."""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import numpy as np
import torch


@dataclass
class _YoloV7Boxes:
    xyxy: torch.Tensor
    cls: torch.Tensor

    def __len__(self) -> int:
        return int(self.xyxy.shape[0])


@dataclass
class _YoloV7Result:
    boxes: Optional[_YoloV7Boxes]


class YoloV7BlurModel:
    """video_anonymize 가 기대하는 ultralytics 유사 predict 인터페이스."""

    backend = "yolov7"

    def __init__(self, model: torch.nn.Module, *, stride: int, names: dict[int, str]) -> None:
        self._model = model
        self.stride = stride
        self.names = names

    def predict(
        self,
        source: Any,
        *,
        imgsz: int = 896,
        conf: float = 0.25,
        iou: float = 0.45,
        classes: Optional[list[int]] = None,
        device: Optional[str] = None,
        verbose: bool = False,
        save: bool = False,
        save_txt: bool = False,
    ) -> list[_YoloV7Result]:
        del verbose, save, save_txt
        frame = np.asarray(source)
        if frame.ndim != 3:
            raise ValueError("YOLOv7 predict 는 HxWxC BGR 프레임만 지원합니다.")

        letterbox, non_max_suppression, scale_coords = _yolov7_utils()
        use_device = _resolve_device(device)
        self._model.to(use_device)

        img0 = frame.copy()
        img, _, _ = letterbox(img0, imgsz, stride=self.stride, auto=True)
        img = img[:, :, ::-1].transpose(2, 0, 1)
        img = np.ascontiguousarray(img)
        tensor = torch.from_numpy(img).to(use_device).float() / 255.0
        if tensor.ndimension() == 3:
            tensor = tensor.unsqueeze(0)

        with torch.no_grad():
            pred = self._model(tensor)[0]
            detections = non_max_suppression(pred, conf, iou, classes=classes)

        det = detections[0]
        if det is None or not len(det):
            return [_YoloV7Result(boxes=None)]

        det = det.clone()
        det[:, :4] = scale_coords(tensor.shape[2:], det[:, :4], img0.shape).round()
        xyxy = det[:, :4].detach().cpu()
        cls = det[:, 5].detach().cpu()
        return [_YoloV7Result(boxes=_YoloV7Boxes(xyxy=xyxy, cls=cls))]


_yolov7_utils_cache: tuple[Any, Any, Any] | None = None


def _yolov7_utils() -> tuple[Any, Any, Any]:
    global _yolov7_utils_cache
    if _yolov7_utils_cache is not None:
        return _yolov7_utils_cache

    _ensure_yolov7_path()
    from utils.datasets import letterbox
    from utils.general import non_max_suppression, scale_coords

    _yolov7_utils_cache = (letterbox, non_max_suppression, scale_coords)
    return _yolov7_utils_cache


def default_yolov7_dir() -> Path:
    return Path(os.environ.get("SEOUL_STUDIO_YOLOV7_DIR", "/app/yolov7")).resolve()


def _ensure_yolov7_path() -> Path:
    root = default_yolov7_dir()
    if not root.is_dir():
        raise RuntimeError(
            f"YOLOv7 코드 경로가 없습니다: {root}. "
            "Docker 이미지에 yolov7 클론 또는 SEOUL_STUDIO_YOLOV7_DIR 를 확인하세요."
        )
    root_str = str(root)
    if root_str not in sys.path:
        sys.path.insert(0, root_str)
    return root


def _resolve_device(device: Optional[str]) -> torch.device:
    if device:
        return torch.device(device)
    return torch.device("cuda:0" if torch.cuda.is_available() else "cpu")


def _model_stride(model: torch.nn.Module) -> int:
    stride = int(max(getattr(model, "stride", [32])))
    return max(stride, 32)


def _normalize_names(raw: Any) -> dict[int, str]:
    if isinstance(raw, dict):
        return {int(k): str(v) for k, v in raw.items()}
    if isinstance(raw, (list, tuple)):
        return {idx: str(name) for idx, name in enumerate(raw)}
    return {}


def load_yolov7_model(weights: Path) -> YoloV7BlurModel:
    weights = Path(weights).resolve()
    if not weights.is_file():
        raise FileNotFoundError(
            f"가중치(.pt) 없음: {weights}. SEOUL_STUDIO_BLUR_WEIGHTS 경로에 모델을 배치하세요."
        )

    _ensure_yolov7_path()
    checkpoint = torch.load(str(weights), map_location="cpu", weights_only=False)
    if not isinstance(checkpoint, dict):
        raise RuntimeError("YOLOv7 가중치 형식이 올바르지 않습니다.")

    model_obj = checkpoint.get("ema") or checkpoint.get("model")
    if model_obj is None:
        raise RuntimeError("YOLOv7 checkpoint 에 model/ema 가 없습니다.")

    model = model_obj.float().eval()
    names = _normalize_names(getattr(model, "names", None) or checkpoint.get("names"))
    return YoloV7BlurModel(model, stride=_model_stride(model), names=names)


def weights_look_like_yolov7(weights: Path) -> bool:
    import zipfile

    weights = Path(weights)
    if not weights.is_file():
        return False
    try:
        with zipfile.ZipFile(weights) as archive:
            pkl_name = next((name for name in archive.namelist() if name.endswith("data.pkl")), None)
            if not pkl_name:
                return False
            text = archive.read(pkl_name).decode("latin1", errors="ignore")
            return "models.yolo" in text or "models.common" in text
    except (OSError, zipfile.BadZipFile, KeyError):
        return False
