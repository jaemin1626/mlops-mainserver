"""I2V 프롬프트 AI 초안 — 한글 의도 → 고정 섹션 영문."""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request
from typing import Any

log = logging.getLogger(__name__)

SECTION_HEADERS = (
    "[global prompt]",
    "[camera]",
    "[event start]",
    "[motion / subject]",
    "[motion constraint]",
)
NEGATIVE_HEADER = "[negative prompt]"

SUPPORTED_SCENARIOS = frozenset({"generic", "fire", "smoke", "person"})

DEFAULT_NEGATIVE = (
    "blurry, watermark, camera shake, pan, tilt, zoom, reframing, "
    "extra limbs, distorted faces, text overlay, logo"
)

SYSTEM_PROMPT = """You write image-to-video prompts for a fixed industrial CCTV camera.
Output MUST be English only inside each section.

Use EXACTLY these section headers in this order (each on its own line):
[global prompt]
[camera]
[event start]
[motion / subject]
[motion constraint]
[negative prompt]

Rules:
- The camera never moves: no pan, tilt, zoom, shake, or reframing.
- Only describe motion that is allowed; everything else stays static.
- Keep each section concise (1-4 sentences).
- [negative prompt] is a single comma-separated line of negatives (no brackets inside).
- Do not add markdown, code fences, or extra sections.
"""


class PromptAssistError(ValueError):
    pass


def default_llm_model() -> str:
    return (os.environ.get("PROMPT_LLM_MODEL", "llama3.2:3b").strip() or "llama3.2:3b")


def llm_configured() -> bool:
    return bool(os.environ.get("PROMPT_LLM_BASE_URL", "").strip())


def _openai_chat_completions_url(base: str) -> str:
    root = base.rstrip("/")
    if root.endswith("/v1"):
        return f"{root}/chat/completions"
    return f"{root}/v1/chat/completions"


def prompt_llm_status() -> dict[str, Any]:
    base = os.environ.get("PROMPT_LLM_BASE_URL", "").strip().rstrip("/")
    model = default_llm_model()
    status: dict[str, Any] = {
        "llm_configured": bool(base),
        "backend": "ollama",
        "model": model,
        "reachable": False,
        "model_pulled": False,
    }
    if not base:
        status["backend"] = "none"
        return status
    if "11434" not in base and "ollama" not in base:
        status["backend"] = "openai_compatible"
    root = base[:-3] if base.endswith("/v1") else base
    try:
        req = urllib.request.Request(f"{root}/api/tags")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        status["reachable"] = True
        names = [str(item.get("name", "")) for item in data.get("models", [])]
        for name in names:
            if name == model or name.startswith(f"{model}:") or model.startswith(f"{name.split(':')[0]}:"):
                status["model_pulled"] = True
                break
        if not status["model_pulled"]:
            base_name = model.split(":")[0]
            status["model_pulled"] = any(n.split(":")[0] == base_name for n in names)
    except Exception as exc:
        log.debug("prompt LLM status check failed: %s", exc)
    return status


def _normalize_scenario(raw: str) -> str:
    key = (raw or "generic").strip().lower()
    return key if key in SUPPORTED_SCENARIOS else "generic"


def _infer_scenario_from_ko(intent_ko: str, scenario: str) -> str:
    if scenario != "generic":
        return scenario
    text = intent_ko.lower()
    if any(token in text for token in ("화재", "불꽃", "불", "fire")):
        return "fire"
    if any(token in text for token in ("연기", "smoke")):
        return "smoke"
    if any(token in text for token in ("사람", "보행", "行人", "person", "worker")):
        return "person"
    return "generic"


def _strip_code_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```[a-zA-Z]*\n?", "", stripped)
        stripped = re.sub(r"\n?```$", "", stripped)
    return stripped.strip()


def validate_structured_text(text: str) -> bool:
    body = text.lower()
    for header in SECTION_HEADERS:
        if header not in body:
            return False
    if NEGATIVE_HEADER not in body:
        return False
    return True


def split_positive_negative(text: str) -> tuple[str, str]:
    normalized = _strip_code_fence(text)
    match = re.search(r"\[negative prompt\]", normalized, flags=re.IGNORECASE)
    if not match:
        raise PromptAssistError("응답에 [negative prompt] 섹션이 없습니다.")
    positive = normalized[: match.start()].strip()
    negative_block = normalized[match.end() :].strip()
    negative = re.sub(r"\s+", " ", negative_block.split("\n", 1)[0]).strip(" ,.")
    if not positive or not negative:
        raise PromptAssistError("positive 또는 negative 내용이 비어 있습니다.")
    return positive, negative


def _call_llm(user_message: str) -> str:
    base = os.environ.get("PROMPT_LLM_BASE_URL", "").strip().rstrip("/")
    if not base:
        return ""
    model = default_llm_model()
    api_key = os.environ.get("PROMPT_LLM_API_KEY", "").strip()
    timeout = float(os.environ.get("PROMPT_LLM_TIMEOUT_SEC", "90"))

    url = _openai_chat_completions_url(base)
    payload: dict[str, Any] = {
        "model": model,
        "temperature": 0.35,
        "max_tokens": 1200,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        log.warning("prompt LLM HTTP %s: %s", exc.code, detail)
        return ""
    except Exception as exc:
        log.warning("prompt LLM request failed: %s", exc)
        return ""

    choices = body.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    content = message.get("content") or ""
    return str(content).strip()


def _build_user_message(intent_ko: str, scenario: str) -> str:
    return (
        f"Scenario hint: {scenario}\n"
        f"User intent (Korean):\n{intent_ko.strip()}\n\n"
        "Write the complete structured prompt now."
    )


def _try_llm(intent_ko: str, scenario: str) -> dict[str, str] | None:
    if not llm_configured():
        return None
    user_msg = _build_user_message(intent_ko, scenario)
    for attempt in range(2):
        raw = _call_llm(user_msg if attempt == 0 else user_msg + "\n\nInclude every required section header exactly once.")
        if not raw:
            return None
        try:
            if not validate_structured_text(raw):
                continue
            positive, negative = split_positive_negative(raw)
            return {"positive": positive, "negative": negative}
        except PromptAssistError:
            continue
    return None


def _scenario_motion(scenario: str) -> tuple[str, str, str]:
    if scenario == "fire":
        return (
            "Shortly after the start, a small localized fire ignites at one plausible ground-level area. "
            "The flames remain small but clearly visible within the wide frame.",
            "Only the small flames and a limited amount of light smoke at the fire location may move. "
            "All equipment, structures, and background elements remain completely static.",
            "The fire must not spread widely, explode, or grow into a large blaze. No people or vehicles appear.",
        )
    if scenario == "smoke":
        return (
            "After a brief calm period, a thin plume of light gray smoke begins to rise from one localized area.",
            "Only the slow rising and slight drift of the thin smoke may move. Everything else stays static.",
            "The smoke must stay thin and must not become dense black smoke or obscure the scene.",
        )
    if scenario == "person":
        return (
            "A single person enters from the edge of the frame and walks slowly along a natural path.",
            "Only that person may move. All machinery, materials, and background remain static.",
            "No camera movement. No additional people or vehicles appear.",
        )
    return (
        "The site operates normally with subtle ambient activity appropriate to the reference image.",
        "Only minimal, localized motion allowed by the user intent may occur. All other elements stay static.",
        "No camera movement. Do not introduce new objects unless described in the user intent.",
    )


def generate_template(intent_ko: str, scenario: str) -> dict[str, str]:
    event_start, motion_subject, motion_constraint = _scenario_motion(scenario)
    positive = (
        "[global prompt]\n\n"
        "A fixed industrial CCTV video based on the provided reference image. "
        "The entire clip keeps one unchanged wide security-camera view from start to finish. "
        "Composition, camera position, perspective, equipment layout, and lighting stay the same.\n\n"
        "[camera]\n\n"
        "A permanently mounted CCTV camera with absolutely no movement, shaking, panning, tilting, zooming, or reframing.\n\n"
        "[event start]\n\n"
        "The scene begins calm and stable. "
        f"{event_start}\n\n"
        "[motion / subject]\n\n"
        f"{motion_subject}\n\n"
        "[motion constraint]\n\n"
        f"{motion_constraint}"
    )
    negative = DEFAULT_NEGATIVE
    return {"positive": positive, "negative": negative}


def assist(intent_ko: str, scenario: str = "generic") -> dict[str, object]:
    text = (intent_ko or "").strip()
    if not text:
        raise PromptAssistError("한글로 만들고 싶은 장면을 입력해 주세요.")
    if len(text) > 4000:
        raise PromptAssistError("입력은 4000자 이내로 작성해 주세요.")

    scenario_key = _infer_scenario_from_ko(text, _normalize_scenario(scenario))
    llm_result = _try_llm(text, scenario_key)
    if llm_result:
        return {
            "positive": llm_result["positive"],
            "negative": llm_result["negative"],
            "scenario": scenario_key,
            "source": "llm",
            "summary_ko": text[:200],
        }

    template = generate_template(text, scenario_key)
    return {
        "positive": template["positive"],
        "negative": template["negative"],
        "scenario": scenario_key,
        "source": "template",
        "summary_ko": text[:200],
    }
