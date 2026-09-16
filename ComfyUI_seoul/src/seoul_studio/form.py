import secrets
from dataclasses import dataclass

from seoul_studio.job import JobValidationError
from seoul_studio.presets import MAX_REPEAT


@dataclass
class FormState:
    mode: str
    prompt: str
    resolution: str
    duration_sec: str
    seed_text: str
    image_path: str
    negative_prompt: str = ""
    aspect_ratio: str = ""
    random_seed: bool = True
    repeat: int = 1


def random_seed_value() -> int:
    return secrets.randbelow(2_147_483_647)


def parse_repeat(raw: object) -> int:
    try:
        count = int(raw)
    except (TypeError, ValueError) as exc:
        raise JobValidationError("반복 횟수는 숫자여야 합니다.") from exc
    if count < 1 or count > MAX_REPEAT:
        raise JobValidationError(f"반복 횟수는 1부터 {MAX_REPEAT}까지입니다.")
    return count


def form_to_payload(state: FormState) -> dict[str, object]:
    if state.random_seed:
        seed = random_seed_value()
    else:
        seed_text = state.seed_text.strip()
        if not seed_text:
            raise JobValidationError("고정 시드를 쓰려면 숫자를 입력하세요.")
        try:
            seed = int(seed_text)
        except ValueError as exc:
            raise JobValidationError("시드는 숫자여야 합니다.") from exc
    try:
        duration_sec = int(str(state.duration_sec).strip())
    except ValueError as exc:
        raise JobValidationError("영상 길이를 선택하세요.") from exc
    payload: dict[str, object] = {
        "mode": state.mode,
        "prompt": state.prompt,
        "resolution": state.resolution,
        "duration_sec": duration_sec,
        "seed": seed,
        "negative_prompt": state.negative_prompt,
    }
    if state.aspect_ratio.strip():
        payload["aspect_ratio"] = state.aspect_ratio.strip()
    if state.image_path.strip():
        payload["image_path"] = state.image_path.strip()
    return payload
