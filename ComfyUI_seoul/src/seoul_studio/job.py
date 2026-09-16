from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Optional

from seoul_studio.presets import (
    DURATIONS,
    FPS,
    SUPPORTED_MODES,
    aspect_ratio_options,
    default_option_id,
    resolution_options,
)


class JobValidationError(ValueError):
    pass


@dataclass
class JobRequest:
    mode: str
    prompt: str
    resolution: str
    duration_sec: int
    seed: int
    width: int = 0
    height: int = 0
    megapixels: float = 0.0
    aspect_ratio: str = ""
    fps: int = FPS
    image_path: Optional[str] = None
    negative_prompt: str = ""

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def parse_job(payload: dict[str, Any]) -> JobRequest:
    mode = str(payload.get("mode", "")).strip()
    if mode not in SUPPORTED_MODES:
        raise JobValidationError("지원하지 않는 모드입니다. 이미지 영상(i2v)만 사용할 수 있습니다.")

    prompt = str(payload.get("prompt", "")).strip()
    if not prompt:
        raise JobValidationError("프롬프트를 입력하세요.")

    resolution = str(payload.get("resolution", "")).strip()
    choices = resolution_options()
    selected = next((item for item in choices if item["id"] == resolution), None)
    if selected is None:
        raise JobValidationError("알 수 없는 해상도입니다. 목록에서 선택하세요.")

    ratios = aspect_ratio_options()
    aspect_ratio = str(payload.get("aspect_ratio", "") or "").strip()
    if ratios:
        if not aspect_ratio:
            aspect_ratio = str(default_option_id(ratios))
        if aspect_ratio not in [item["id"] for item in ratios]:
            raise JobValidationError("알 수 없는 종횡비입니다. 목록에서 선택하세요.")
    else:
        aspect_ratio = ""

    try:
        duration_sec = int(payload.get("duration_sec"))
    except (TypeError, ValueError) as exc:
        raise JobValidationError("영상 길이를 선택하세요.") from exc
    if duration_sec not in DURATIONS:
        raise JobValidationError("알 수 없는 길이입니다. 목록에서 선택하세요.")

    try:
        seed = int(payload.get("seed", 0))
    except (TypeError, ValueError) as exc:
        raise JobValidationError("시드는 숫자여야 합니다.") from exc

    image_path = payload.get("image_path")
    if image_path is not None:
        image_path = str(image_path).strip() or None

    if mode == "i2v":
        if not image_path:
            raise JobValidationError("이미지 영상은 입력 이미지가 필요합니다.")
        if not Path(image_path).is_file():
            raise JobValidationError("선택한 이미지 파일을 찾을 수 없습니다.")

    return JobRequest(
        mode=mode,
        prompt=prompt,
        resolution=resolution,
        duration_sec=duration_sec,
        seed=seed,
        width=int(selected.get("width", 0)),
        height=int(selected.get("height", 0)),
        megapixels=float(selected.get("megapixels", 0.0)),
        aspect_ratio=aspect_ratio,
        fps=FPS,
        image_path=image_path,
        negative_prompt=str(payload.get("negative_prompt", "") or ""),
    )
