import json
from typing import Any, Literal

from seoul_studio.paths import workflow_dir

RESOLUTIONS: dict[str, dict[str, int]] = {
    "832x480": {"width": 832, "height": 480},
    "1280x720": {"width": 1280, "height": 720},
}

DURATIONS: tuple[int, ...] = (5, 10, 15)
FPS = 24
DEFAULT_RESOLUTION = "1280x720"
DEFAULT_DURATION = 5
MAX_REPEAT = 10

Mode = Literal["i2v"]
SUPPORTED_MODES: tuple[str, ...] = ("i2v",)


def _workflow_options() -> dict[str, Any]:
    """Size choices declared by the active workflow folder, if it has any."""
    path = workflow_dir() / "options.json"
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def resolution_options() -> list[dict[str, Any]]:
    declared = _workflow_options().get("resolutions")
    if declared:
        return declared
    return [
        {
            "id": key,
            "label": f"{spec['width']}×{spec['height']}",
            "width": spec["width"],
            "height": spec["height"],
            "default": key == DEFAULT_RESOLUTION,
        }
        for key, spec in RESOLUTIONS.items()
    ]


def aspect_ratio_options() -> list[dict[str, Any]]:
    return _workflow_options().get("aspect_ratios", [])


def duration_options() -> list[dict[str, Any]]:
    return [
        {"id": seconds, "label": f"{seconds}초", "default": seconds == DEFAULT_DURATION}
        for seconds in DURATIONS
    ]


def default_option_id(options: list[dict[str, Any]]) -> Any:
    for option in options:
        if option.get("default"):
            return option["id"]
    return options[0]["id"] if options else None
