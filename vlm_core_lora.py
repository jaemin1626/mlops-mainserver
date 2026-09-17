import os
import re
from math import floor
import math
import time
from pathlib import Path

import cv2
import numpy as np
import torch
from PIL import Image
from vllm import LLM, SamplingParams
# [LoRA] vLLM 추론 요청에 학습된 어댑터를 연결합니다.
from vllm.lora.request import LoRARequest
from transformers import AutoProcessor


os.environ.setdefault("VLLM_ENABLE_V1_MULTIPROCESSING", "1")

VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".webm", ".m4v"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}


def is_video_path(path: str) -> bool:
    return Path(path).suffix.lower() in VIDEO_EXTENSIONS


def is_image_path(path: str) -> bool:
    return Path(path).suffix.lower() in IMAGE_EXTENSIONS


def get_media_type(path: str) -> str:
    if is_video_path(path):
        return "video"
    if is_image_path(path):
        return "image"
    raise ValueError(f"지원하지 않는 미디어 확장자입니다: {Path(path).suffix}")


def get_video_paths_from_folder(video_folder: str):
    return get_media_paths_from_folder(video_folder, media_type="video")


def get_image_paths_from_folder(image_folder: str):
    return get_media_paths_from_folder(image_folder, media_type="image")


def get_media_paths_from_folder(folder: str, media_type: str = "video"):
    """
    folder 및 모든 하위 폴더 내부의 미디어 파일 경로를 정렬해서 반환
    media_type: "video" | "image" | "all"
    """
    folder_path = Path(folder)

    if not folder_path.exists():
        raise FileNotFoundError(f"folder가 존재하지 않습니다: {folder_path}")

    if not folder_path.is_dir():
        raise NotADirectoryError(f"folder가 폴더가 아닙니다: {folder_path}")

    if media_type == "video":
        allowed = VIDEO_EXTENSIONS
        label = "비디오"
    elif media_type == "image":
        allowed = IMAGE_EXTENSIONS
        label = "이미지"
    elif media_type == "all":
        allowed = VIDEO_EXTENSIONS | IMAGE_EXTENSIONS
        label = "미디어"
    else:
        raise ValueError(f"media_type은 video/image/all 중 하나여야 합니다: {media_type}")

    media_paths = sorted(
        [
            str(p)
            for p in folder_path.rglob("*")
            if p.is_file() and p.suffix.lower() in allowed
        ]
    )

    if len(media_paths) == 0:
        raise ValueError(f"폴더 및 하위 폴더 안에 {label} 파일이 없습니다: {folder_path}")

    return media_paths


def load_image(image_path: str) -> Image.Image:
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"이미지 파일이 존재하지 않습니다: {image_path}")
    return Image.open(image_path).convert("RGB")


def get_image_info(image_path: str) -> dict:
    with Image.open(image_path) as img:
        width, height = img.size
        fmt = img.format or Path(image_path).suffix.lstrip(".").upper()
    return {
        "width": width,
        "height": height,
        "format": fmt,
        "media_type": "image",
    }


def _strip_model_noise(text: str) -> str:
    """모델 추론/서문(thinking) 등을 제거하고 본문만 남긴다."""
    text = (text or "").strip()
    if not text:
        return ""

    # Qwen3.5 `<think>` — 닫힌 블록 뒤가 최종 답변
    for close_tag in ("</think>", "</" + "think" + ">"):
        if close_tag.lower() in text.lower():
            text = re.split(re.escape(close_tag), text, maxsplit=1, flags=re.IGNORECASE)[-1].strip()
            break

    # Qwen3 / Qwen3.5 thinking 블록 (미완성 출력 포함)
    for open_tag, close_tag in (
        ("<think>", "</think>"),
        ("<" + "think" + ">", "<" + "/" + "think" + ">"),
        ("<thinking>", "</thinking>"),
    ):
        text = re.sub(
            re.escape(open_tag) + r"[\s\S]*?" + re.escape(close_tag),
            "",
            text,
            flags=re.IGNORECASE,
        )
        text = re.sub(re.escape(open_tag) + r"[\s\S]*$", "", text, flags=re.IGNORECASE)

    # 영문 chain-of-thought 서두 (THE USER WANTS ... 등)
    lines = text.splitlines()
    cleaned: list[str] = []
    for line in lines:
        upper = line.strip().upper()
        if upper.startswith("THE USER WANTS") or upper.startswith("LET ME ") or upper.startswith("I NEED TO "):
            continue
        cleaned.append(line)
    text = "\n".join(cleaned).strip()
    return text


def _normalize_judgment(value: str) -> str:
    token = re.sub(r"[^A-Za-z]", "", (value or "").strip()).upper()
    mapping = {
        "T": "T",
        "TRUE": "T",
        "F": "F",
        "FALSE": "F",
        "U": "U",
        "UNKNOWN": "U",
        "HOLD": "U",
    }
    return mapping.get(token, "")


def _normalize_risk(value: str) -> str:
    token = re.sub(r"[^A-Za-z]", "", (value or "").strip()).upper()
    mapping = {
        "H": "H",
        "HIGH": "H",
        "CRITICAL": "H",
        "M": "M",
        "MEDIUM": "M",
        "WARNING": "M",
        "WARN": "M",
        "L": "M",
        "LOW": "M",
        "N": "N",
        "NA": "N",
        "NONE": "N",
        "NORMAL": "N",
    }
    return mapping.get(token, "")


def _judgment_display(code: str) -> str:
    return {"T": "TRUE", "F": "FALSE", "U": "UNKNOWN"}.get(code, code)


def _risk_display(code: str) -> str:
    return {"H": "Critical", "M": "Warning", "N": "Normal"}.get(code, code)


def _is_unified_line(line: str) -> bool:
    parts = line.split("|", 4)
    if len(parts) < 5:
        return False
    return bool(_normalize_judgment(parts[0])) and bool(_normalize_risk(parts[1]))


def _parse_structured_block(text: str) -> dict | None:
    """`판정: ...` / `위험도: ...` / `판단근거: ...` / `설명: ...` 4줄 형식."""
    cleaned = _strip_model_noise(text)
    if not cleaned:
        return None

    fields: dict[str, str] = {}
    patterns = {
        "judgment": r"판정\s*[:：]\s*(TRUE|FALSE|UNKNOWN|T|F|U)\b",
        "risk": r"위험도\s*[:：]\s*(Critical|Warning|Normal|HIGH|MEDIUM|LOW|H|M|L|N)\b",
        "basis": r"(?:판단근거|진위\s*근거)\s*[:：]\s*(.+?)\s*(?:\n|$)",
        "description": r"설명\s*[:：]\s*(.+?)\s*(?:\n|$)",
    }
    for key, pattern in patterns.items():
        match = re.search(pattern, cleaned, re.IGNORECASE)
        if match:
            fields[key] = match.group(1).strip()

    if not fields.get("judgment") or not fields.get("risk"):
        return None

    judgment = _normalize_judgment(fields["judgment"])
    risk = _normalize_risk(fields["risk"])
    if not judgment or not risk:
        return None

    basis = fields.get("basis", "").strip().strip("`")
    description = fields.get("description", "").strip().strip("`")
    if not description:
        return None

    return {
        "judgment": judgment,
        "risk": risk,
        "basis_codes": basis,
        "truth_codes": basis,
        "risk_codes": "",
        "description": description,
        "answer": cleaned,
    }


def _extract_unified_line(raw_text: str) -> str:
    text = _strip_model_noise(raw_text)
    text = text.strip().strip("`").strip()

    for m in re.finditer(
        r"`([TFU]\s*\|\s*[HMLN]\s*\|[^`]+)`",
        raw_text or "",
        re.IGNORECASE,
    ):
        candidate = m.group(1).strip()
        if _is_unified_line(candidate):
            return candidate

    lines = [ln.strip().strip("`").strip() for ln in text.splitlines() if ln.strip()]
    for candidate in reversed(lines):
        if _is_unified_line(candidate):
            return candidate

    if _is_unified_line(text):
        return text

    match = re.search(
        r"([TFU]|TRUE|FALSE|UNKNOWN)\s*\|\s*([HMLN]|Critical|Warning|Normal)\s*\|([^|\n]+)\|([^|\n]+)\|(.+?)(?:\n|$)",
        text,
        re.IGNORECASE,
    )
    if match:
        j = _normalize_judgment(match.group(1))
        r = _normalize_risk(match.group(2))
        return f"{j}|{r}|{match.group(3).strip()}|{match.group(4).strip()}|{match.group(5).strip()}"

    return text


def parse_unified_output(raw_text: str) -> dict:
    """구조화 4줄 또는 legacy `판정|위험도|진위근거|위험도근거|설명` 파싱."""
    structured = _parse_structured_block(raw_text)
    if structured:
        judgment_ok = bool(structured["judgment"])
        risk_ok = bool(structured["risk"])
        return {
            "raw_text": raw_text,
            **structured,
            "parse_ok": judgment_ok and risk_ok and bool(structured["description"]),
        }

    text = _extract_unified_line(raw_text)
    parts = text.split("|", 4)
    while len(parts) < 5:
        parts.append("")

    judgment = _normalize_judgment(parts[0])
    risk = _normalize_risk(parts[1])
    truth_codes = parts[2].strip()
    risk_codes = parts[3].strip()
    description = parts[4].strip()
    basis_codes = ",".join(
        [c for c in [truth_codes, risk_codes] if c and c.upper() != "NA"]
    )

    judgment_ok = bool(judgment)
    risk_ok = bool(risk)

    return {
        "raw_text": raw_text,
        "judgment": judgment if judgment_ok else "",
        "risk": risk if risk_ok else "",
        "basis_codes": basis_codes,
        "truth_codes": truth_codes,
        "risk_codes": risk_codes,
        "description": description,
        "answer": text,
        "parse_ok": judgment_ok and risk_ok and bool(description),
    }


def load_video_frames_online_style(
    video_path: str,
    sample_fps: float = 1.0,
    target_num_frames: int = 32,
):
    """
    OpenCV 기반 비디오 프레임 로더
    """
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"비디오 파일이 존재하지 않습니다: {video_path}")

    cap = cv2.VideoCapture(video_path)

    if not cap.isOpened():
        raise ValueError(f"비디오를 열 수 없습니다: {video_path}")

    total_frames_orig = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    orig_fps = float(cap.get(cv2.CAP_PROP_FPS))

    if orig_fps <= 0:
        orig_fps = 1.0

    if total_frames_orig <= 0:
        cap.release()
        raise ValueError(f"원본 비디오 프레임 수를 읽을 수 없습니다: {video_path}")

    duration = total_frames_orig / orig_fps

    num_frames_to_sample = total_frames_orig

    if target_num_frames > 0:
        num_frames_to_sample = min(num_frames_to_sample, target_num_frames)

    if sample_fps > 0:
        num_frames_to_sample = min(num_frames_to_sample, floor(duration * sample_fps))

    num_frames_to_sample = max(num_frames_to_sample, 1)

    sample_indices = np.linspace(
        0,
        total_frames_orig - 1,
        num_frames_to_sample,
        dtype=int,
    ).tolist()

    frames = []
    sampled_indices = []

    for idx in sample_indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
        ok, frame = cap.read()

        if not ok:
            continue

        frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        frames.append(frame)
        sampled_indices.append(int(idx))

    cap.release()

    if not frames:
        raise ValueError(f"샘플링된 프레임이 없습니다: {video_path}")

    metadata = {
        "total_num_frames": total_frames_orig,
        "fps": orig_fps,
        "duration": duration,
        "video_backend": "opencv",
        "frames_indices": sampled_indices,
        "do_sample_frames": False,
    }

    return frames, metadata


def _get_decoded_token(logprob_obj):
    """
    vLLM 버전에 따라 decoded_token 속성명이 다를 수 있어 안전하게 처리
    """
    token = getattr(logprob_obj, "decoded_token", None)

    if token is None:
        token = getattr(logprob_obj, "token", None)

    if token is None:
        token = ""

    return str(token)


def _get_logprob(logprob_obj):
    """
    vLLM Logprob 객체에서 logprob 값 추출
    """
    return float(getattr(logprob_obj, "logprob"))


def calc_yes_no_probability_from_first_token_logprobs(first_token_logprobs):
    """
    첫 토큰 후보 중 '네'와 '아/아니/아니오'의 logprob를 찾아서
    네/아니오 두 후보 기준 일치도를 계산합니다.

    P(네) = exp(logprob_네) / (exp(logprob_네) + exp(logprob_아니오))
    P(아니오) = exp(logprob_아니오) / (exp(logprob_네) + exp(logprob_아니오))

    반환:
        yes_prob_percent: float or None
        no_prob_percent: float or None
        debug_candidates: list[tuple[token_text, logprob]]
    """
    if not first_token_logprobs:
        return None, None, []

    yes_logprob = None
    no_logprob = None
    debug_candidates = []

    for token_id, logprob_obj in first_token_logprobs.items():
        token_text = _get_decoded_token(logprob_obj)
        token_clean = token_text.strip()
        lp = _get_logprob(logprob_obj)

        debug_candidates.append((token_text, lp))

        # max_tokens=1일 때 "네"가 1토큰으로 나오는 경우
        if token_clean == "네":
            if yes_logprob is None or lp > yes_logprob:
                yes_logprob = lp

        # max_tokens=1일 때 "아"가 나오면 "아니오"로 매핑
        # 혹시 토크나이저/버전에 따라 "아니", "아니오"가 바로 잡히는 경우도 대응
        if token_clean in {"아", "아니", "아니오"}:
            if no_logprob is None or lp > no_logprob:
                no_logprob = lp

    # 둘 다 top logprobs 안에 없으면 계산 불가
    if yes_logprob is None and no_logprob is None:
        return None, None, debug_candidates

    # 한쪽만 top logprobs 안에 있으면 해당 후보가 압도적으로 높다고 보고 100% 처리
    if yes_logprob is not None and no_logprob is None:
        return 100.0, 0.0, debug_candidates

    if yes_logprob is None and no_logprob is not None:
        return 0.0, 100.0, debug_candidates

    # 수치 안정성을 위해 max logprob를 빼고 softmax 계산
    max_logprob = max(yes_logprob, no_logprob)
    yes_score = math.exp(yes_logprob - max_logprob)
    no_score = math.exp(no_logprob - max_logprob)
    total_score = yes_score + no_score

    yes_prob_percent = yes_score / total_score * 100.0
    no_prob_percent = no_score / total_score * 100.0

    return yes_prob_percent, no_prob_percent, debug_candidates


class VLM_infer:
    def __init__(
        self,
        model_path,
        # [LoRA] adapter_config.json과 adapter_model.safetensors가 있는 폴더입니다.
        # None이면 원본 기본 모델만 사용합니다.
        lora_path=None,
        # [LoRA] 학습할 때 사용한 rank 이상이어야 합니다. 현재 기본값은 16입니다.
        max_lora_rank=16,
        n_device=1,
        gpu_memory_utilization=0.9,
        max_model_len=32655,
        max_num_batched_tokens=32655,
        sample_fps=1.0,
        target_num_frames=128,
        enable_prefix_caching=None,
        mm_processor_cache_gb=None,
    ):
        self.model_path = model_path
        # [LoRA] 파일 경로가 아니라 어댑터 폴더 경로를 저장합니다.
        self.lora_path = str(Path(lora_path).expanduser().resolve()) if lora_path else None
        self.max_lora_rank = int(max_lora_rank)
        self.n_device = n_device
        self.gpu_memory_utilization = gpu_memory_utilization
        self.max_model_len = max_model_len
        self.max_num_batched_tokens = max_num_batched_tokens
        self.sample_fps = sample_fps
        self.target_num_frames = target_num_frames
        self.enable_prefix_caching = (
            ENABLE_PREFIX_CACHING if enable_prefix_caching is None else enable_prefix_caching
        )
        self.mm_processor_cache_gb = (
            MM_PROCESSOR_CACHE_GB if mm_processor_cache_gb is None else mm_processor_cache_gb
        )

        self.vlm_model = None
        self.processor = None
        # [LoRA] generate()에 전달할 vLLM 어댑터 요청입니다.
        self.lora_request = None

        self.init_model()

    def init_model(self):
        total_gpu = torch.cuda.device_count()

        if total_gpu <= 0:
            raise RuntimeError("사용 가능한 CUDA GPU가 없습니다.")

        if not isinstance(self.n_device, int) or self.n_device <= 0:
            raise ValueError("n_device는 1 이상의 정수여야 합니다.")

        if self.n_device > total_gpu:
            raise ValueError(
                f"요청한 n_device={self.n_device}가 현재 GPU 개수 {total_gpu}보다 많습니다."
            )

        # [LoRA] 어댑터를 사용할 때 필수 파일과 rank를 먼저 확인합니다.
        if self.lora_path:
            adapter_dir = Path(self.lora_path)
            if not adapter_dir.is_dir():
                raise FileNotFoundError(f"LoRA 어댑터 폴더가 없습니다: {adapter_dir}")
            for filename in ("adapter_config.json", "adapter_model.safetensors"):
                if not (adapter_dir / filename).is_file():
                    raise FileNotFoundError(
                        f"LoRA 필수 파일이 없습니다: {adapter_dir / filename}"
                    )
            if self.max_lora_rank <= 0:
                raise ValueError("max_lora_rank는 1 이상이어야 합니다.")

        self.vlm_model = LLM(
            model=self.model_path,
            tokenizer=self.model_path,
            trust_remote_code=True,
            tensor_parallel_size=self.n_device,
            gpu_memory_utilization=self.gpu_memory_utilization,
            max_model_len=self.max_model_len,
            max_num_batched_tokens=self.max_num_batched_tokens,
            enable_prefix_caching=self.enable_prefix_caching,
            mm_processor_cache_gb=self.mm_processor_cache_gb,
            # [LoRA] vLLM 엔진에서 어댑터 로딩 기능을 활성화합니다.
            enable_lora=bool(self.lora_path),
            max_loras=1,
            max_lora_rank=self.max_lora_rank,
        )

        # [LoRA] 실제 어댑터는 기본 모델 로딩 후 요청 객체로 연결합니다.
        if self.lora_path:
            self.lora_request = LoRARequest(
                lora_name="trained_adapter",
                lora_int_id=1,
                lora_path=self.lora_path,
            )

        # Processor와 tokenizer는 LoRA 폴더가 아니라 기본 모델 것을 사용합니다.
        self.processor = AutoProcessor.from_pretrained(
            self.model_path,
            trust_remote_code=True,
        )

    def inference(
        self,
        media_paths,
        user_query,
        max_tokens_size=256,
        stop_words=None,
        stop_token_ids=None,
        include_stop_str_in_output=True,
        is_time=0,
    ):
        """비디오/이미지 통합 추론. 출력: `판정|위험도|진위근거|위험도근거|설명`"""
        if isinstance(media_paths, str):
            media_paths = [media_paths]

        if not isinstance(media_paths, list) or len(media_paths) == 0:
            raise ValueError("media_paths는 미디어 1개 또는 경로 리스트여야 합니다.")

        if isinstance(user_query, str):
            user_queries = [user_query] * len(media_paths)
        elif isinstance(user_query, list):
            if len(user_query) != len(media_paths):
                raise ValueError(
                    f"media_paths 개수({len(media_paths)})와 user_query 개수({len(user_query)})가 같아야 합니다."
                )
            user_queries = user_query
        else:
            raise TypeError("user_query는 str 또는 list[str] 여야 합니다.")

        batch_inputs = []
        debug_infos = []

        for media_path, query in zip(media_paths, user_queries):
            if not isinstance(media_path, str):
                raise TypeError("media_paths 내부 원소는 str, 즉 미디어 경로여야 합니다.")

            media_type = get_media_type(media_path)

            if media_type == "video":
                video_frames, video_metadata = load_video_frames_online_style(
                    video_path=media_path,
                    sample_fps=self.sample_fps,
                    target_num_frames=self.target_num_frames,
                )
                debug_infos.append(
                    {
                        "media_path": media_path,
                        "media_type": "video",
                        "sampled_frame_count": len(video_frames),
                        "original_total_frames": video_metadata["total_num_frames"],
                        "original_fps": video_metadata["fps"],
                        "duration": video_metadata["duration"],
                    }
                )
                messages = [
                    {
                        "role": "user",
                        "content": [
                            {"type": "video"},
                            {"type": "text", "text": query},
                        ],
                    },
                ]
                multi_modal_data = {"video": [(video_frames, video_metadata)]}
            else:
                image = load_image(media_path)
                debug_infos.append(
                    {
                        "media_path": media_path,
                        "media_type": "image",
                        "width": image.width,
                        "height": image.height,
                    }
                )
                messages = [
                    {
                        "role": "user",
                        "content": [
                            {"type": "image"},
                            {"type": "text", "text": query},
                        ],
                    },
                ]
                multi_modal_data = {"image": image}

            prompt = self.processor.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )

            batch_inputs.append(
                {
                    "prompt": prompt,
                    "multi_modal_data": multi_modal_data,
                }
            )

        sampling_params = SamplingParams(
            temperature=0.0,
            top_k=1,
            max_tokens=max_tokens_size,
            stop=stop_words,
            stop_token_ids=stop_token_ids,
            include_stop_str_in_output=include_stop_str_in_output,
        )

        print("===== Generate Input Info =====")
        print(f"batch_inputs size: {len(batch_inputs)}")
        for idx, info in enumerate(debug_infos, 1):
            print(f"[Input {idx:03d}] {info}")

        if is_time == 1:
            torch.cuda.synchronize()
            start = time.perf_counter()
            outputs = self.vlm_model.generate(
                batch_inputs,
                sampling_params=sampling_params,
                # [LoRA] None이면 기본 모델, LoRARequest이면 어댑터 적용 모델로 추론합니다.
                lora_request=self.lora_request,
            )
            torch.cuda.synchronize()
            generate_time = time.perf_counter() - start
            print(f"[TIME] vLLM generate only time: {generate_time:.3f} sec")
        else:
            outputs = self.vlm_model.generate(
                batch_inputs,
                sampling_params=sampling_params,
                # [LoRA] None이면 기본 모델, LoRARequest이면 어댑터 적용 모델로 추론합니다.
                lora_request=self.lora_request,
            )
            generate_time = None

        results = []
        output_token_counts = []
        for out in outputs:
            completion = out.outputs[0]
            raw_text = completion.text.strip()
            parsed = parse_unified_output(raw_text)
            parsed["output_tokens"] = (
                len(completion.token_ids) if completion.token_ids is not None else 0
            )
            results.append(parsed)
            output_token_counts.append(parsed["output_tokens"])

        return results, generate_time, output_token_counts


# ============================================================
# HTML/CLI가 함께 사용하는 공통 설정
# 첨부된 통합 테스트 코드의 설정값과 동일합니다.
# ============================================================
# 경로는 이 파일(test_qwen3vl/vlm_core.py) 위치를 기준으로 계산해
# 절대경로 하드코딩 없이(=상대경로로) 프로젝트 어디에 두어도 동작하게 한다.
_BASE_DIR = Path(__file__).resolve().parent
_PROJECT_ROOT = _BASE_DIR.parent

DEFAULT_MODEL_NAME = os.getenv("MODEL_NAME", "Qwen3.5-9B")
MODEL_OPTIONS = {
    "Qwen3.5-9B": _PROJECT_ROOT / "vlm_model" / "Qwen3.5-9B",
    "Qwen3.5-2B": _PROJECT_ROOT / "vlm_model" / "Qwen3.5-2B",
    "Qwen3.5-4B": _PROJECT_ROOT / "vlm_model" / "Qwen3.5-4B",
}

# 모델별 vLLM gpu_memory_utilization (GPU VRAM 비율)
MODEL_GPU_MEMORY_UTILIZATION = {
    "Qwen3.5-9B": 0.9,
    "Qwen3.5-2B": 0.45,
    "Qwen3.5-4B": 0.45,
}


def resolve_model_path(model_name: str | None = None) -> str:
    name = model_name or DEFAULT_MODEL_NAME
    if name not in MODEL_OPTIONS:
        raise ValueError(
            f"지원하지 않는 모델입니다: {name}. 사용 가능: {list(MODEL_OPTIONS.keys())}"
        )
    path = MODEL_OPTIONS[name]
    if not path.is_dir():
        raise FileNotFoundError(f"모델 경로가 없습니다: {path}")
    return str(path)


MODEL_PATH = resolve_model_path()

# [LoRA] 어댑터 폴더를 환경변수로 지정합니다.
# 예: export LORA_PATH=/models/adapters/Qwen3.5-2B/best
# 비워 두면 LoRA 없이 원본 기본 모델로 실행합니다.
LORA_PATH = os.getenv("LORA_PATH", "").strip() or None
# [LoRA] 학습 설정의 LoRA Rank와 같거나 큰 값으로 지정합니다.
LORA_MAX_RANK = int(os.getenv("LORA_MAX_RANK", "16"))
# [LoRA] 2B 어댑터를 4B/9B 모델에 잘못 적용하지 않도록 모델명을 확인합니다.
LORA_BASE_MODEL_NAME = os.getenv("LORA_BASE_MODEL_NAME", "Qwen3.5-2B").strip()

WARMUP_VIDEO_PATH = str(_BASE_DIR / "warmup_test.mp4")

IS_TIME = 1
MAX_TOKENS = 256
N_DEVICE = 1
GPU_MEMORY_UTILIZATION = 0.9
MAX_MODEL_LEN = 65536
MAX_NUM_BATCHED = 12000
SAMPLE_FPS = 1.0
TARGET_NUM_FRAMES = 128
STOP_WORDS = None
STOP_TOKEN_IDS = None

# vLLM 캐시 — 추론 시간 편차 완화 (모델 로드 시 1회 적용, 재시작 필요)
def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


ENABLE_PREFIX_CACHING = _env_bool("VLLM_ENABLE_PREFIX_CACHING", False)
MM_PROCESSOR_CACHE_GB = float(os.getenv("VLLM_MM_PROCESSOR_CACHE_GB", "0"))

# ------------------------------------------------------------
# prompt/ 폴더의 이벤트별 통합 프롬프트 프리셋
# 파일명 예: "[Seoul] 쓰러짐.txt"
# ------------------------------------------------------------
_PROMPT_PRESET_DIR = Path(__file__).resolve().parent / "prompt"
DEFAULT_PRESET_LABEL = "쓰러짐"


def _parse_preset_filename(name: str) -> str | None:
    if not name.endswith(".txt"):
        return None
    label = name.replace("[Seoul]", "").replace("[KLID]", "")
    if label.endswith(".txt"):
        label = label[:-4]
    label = label.strip().strip("_- ").strip()
    if "검증" in label or "설명" in label:
        return None
    return label or None


def _read_preset_content(label: str) -> str:
    if not _PROMPT_PRESET_DIR.is_dir():
        return ""

    fallback = ""
    for path in sorted(_PROMPT_PRESET_DIR.iterdir()):
        if not path.is_file():
            continue
        file_label = _parse_preset_filename(path.name)
        if file_label is None:
            continue
        try:
            content = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if not fallback:
            fallback = content
        if file_label == label:
            return content
    return fallback


USER_QUERY = _read_preset_content(DEFAULT_PRESET_LABEL)
WARMUP_QUERY = (
    "영상을 확인하고 한 줄로만 출력하세요. "
    "형식: T|N|NORMAL_ACTIVITY|NA|테스트 응답입니다."
)


def load_default_prompt() -> str:
    return _read_preset_content(DEFAULT_PRESET_LABEL)


def list_prompt_presets() -> dict:
    """prompt/ 폴더의 이벤트별 통합 프리셋 목록."""
    result = {"presets": []}
    if not _PROMPT_PRESET_DIR.is_dir():
        return result

    for path in sorted(_PROMPT_PRESET_DIR.iterdir()):
        if not path.is_file():
            continue
        label = _parse_preset_filename(path.name)
        if label is None:
            continue
        try:
            content = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        result["presets"].append(
            {
                "label": label,
                "content": content,
                "sha256": get_prompt_sha256(content),
                "file": path.name,
            }
        )

    result["presets"].sort(key=lambda x: x["label"])
    return result


def save_prompt_preset(label: str, content: str) -> dict:
    """선택한 프리셋 내용을 prompt/ 파일에 저장한다."""
    clean_label = (label or "").strip()
    if not clean_label:
        raise ValueError("프리셋 라벨이 비어 있습니다.")

    text = content.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise ValueError("프롬프트 내용이 비어 있습니다.")

    if not _PROMPT_PRESET_DIR.is_dir():
        raise FileNotFoundError("prompt 폴더가 없습니다.")

    target_path: Path | None = None
    for path in sorted(_PROMPT_PRESET_DIR.iterdir()):
        if not path.is_file():
            continue
        file_label = _parse_preset_filename(path.name)
        if file_label == clean_label:
            target_path = path
            break

    if target_path is None:
        raise FileNotFoundError(f"프리셋 파일을 찾을 수 없습니다: {clean_label}")

    target_path.write_text(text + "\n", encoding="utf-8")
    return {
        "label": clean_label,
        "file": target_path.name,
        "sha256": get_prompt_sha256(text),
    }


def get_media_info(media_path: str) -> dict:
    if is_image_path(media_path):
        return get_image_info(media_path)
    return get_video_info(media_path)


def get_prompt_sha256(prompt: str) -> str:
    import hashlib
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def get_video_info(video_path: str) -> dict:
    """영상의 해상도/FPS/재생시간(초)/프레임수를 반환한다."""
    cap = cv2.VideoCapture(video_path)
    try:
        if not cap.isOpened():
            return {}
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        duration = (frame_count / fps) if fps > 0 else 0.0
        return {
            "width": width,
            "height": height,
            "fps": round(fps, 2),
            "frame_count": frame_count,
            "duration": round(duration, 2),
        }
    finally:
        cap.release()


SPLIT_EVENT_NAMES = (
    "쓰러짐", "폭행", "흡연", "화재감지", "침입", "무단투기", "군중밀집",
)

_SPLIT_FILENAME_EVENT_HINTS = (
    ("falldown", "쓰러짐"),
    ("fall_down", "쓰러짐"),
    ("fight", "폭행"),
    ("assault", "폭행"),
    ("smoking", "흡연"),
    ("fire", "화재감지"),
    ("intrusion", "침입"),
    ("dumping", "무단투기"),
    ("crowd", "군중밀집"),
)


def _detect_event_name(path_parts: list[str], filename_stem: str) -> str:
    for part in path_parts:
        for event in SPLIT_EVENT_NAMES:
            if part == event or event in part:
                return event

    stem_lower = filename_stem.lower()
    for keyword, event in _SPLIT_FILENAME_EVENT_HINTS:
        if keyword in stem_lower:
            return event
    return "unknown"


def _detect_polarity(path_parts: list[str], filename_stem: str) -> str:
    for part in path_parts:
        low = part.lower()
        if low == "positive":
            return "positive"
        if low == "negative":
            return "negative"

    stem_lower = filename_stem.lower()
    if "positive" in stem_lower or "_pos" in stem_lower:
        return "positive"
    if "negative" in stem_lower or "_neg" in stem_lower:
        return "negative"
    return "unknown"


def resolve_split_output_dir(video_path: str, output_base: str) -> tuple[Path, dict]:
    """
    저장 구조: {output_base}/{이벤트}/{positive|negative}/{영상명}/1.mp4 …
    """
    src = Path(video_path)
    parts = list(src.parts)
    stem = src.stem

    event = _detect_event_name(parts, stem)
    polarity = _detect_polarity(parts, stem)

    out_dir = Path(output_base).expanduser().resolve() / event / polarity / stem
    return out_dir, {
        "event_name": event,
        "polarity": polarity,
        "video_folder": stem,
    }


def split_video_by_interval(
    video_path: str,
    output_dir: str,
    interval_sec: float,
) -> dict:
    """
    OpenCV로 영상을 설정한 초(interval)마다 잘라 저장한다.
    저장 구조: {output_dir}/{이벤트}/{positive|negative}/{영상명}/1.mp4, 2.mp4 …
    """
    interval_sec = float(interval_sec)
    if interval_sec <= 0:
        raise ValueError("분할 간격(초)은 0보다 커야 합니다.")

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"비디오를 열 수 없습니다: {video_path}")

    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 25.0)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    if src_w <= 0 or src_h <= 0:
        cap.release()
        raise ValueError(f"영상 해상도를 읽을 수 없습니다: {video_path}")
    if frame_count <= 0:
        cap.release()
        raise ValueError(f"영상 프레임을 읽을 수 없습니다: {video_path}")

    src = Path(video_path)
    out_dir, layout = resolve_split_output_dir(video_path, output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    suffix = ".mp4"
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")

    frames_per_segment = max(1, int(round(interval_sec * fps)))

    segments: list[dict] = []
    segment_idx = 0
    frame_in_segment = 0
    writer: cv2.VideoWriter | None = None
    current_out: Path | None = None
    start_frame = 0

    def _open_writer(seg_no: int) -> cv2.VideoWriter:
        nonlocal current_out
        out_path = out_dir / f"{seg_no}{suffix}"
        current_out = out_path
        w = cv2.VideoWriter(str(out_path), fourcc, fps, (src_w, src_h))
        if not w.isOpened():
            raise ValueError(f"출력 파일을 생성할 수 없습니다: {out_path}")
        return w

    frame_no = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break

        if frame_in_segment == 0:
            if writer is not None:
                writer.release()
                segments[-1]["end_frame"] = frame_no - 1
                segments[-1]["end_sec"] = round((frame_no - 1) / fps, 3)
            segment_idx += 1
            writer = _open_writer(segment_idx)
            start_frame = frame_no
            segments.append({
                "index": segment_idx,
                "output_path": str(current_out.resolve()),
                "output_name": current_out.name,
                "start_frame": start_frame,
                "start_sec": round(start_frame / fps, 3),
                "frames_written": 0,
            })

        writer.write(frame)
        segments[-1]["frames_written"] += 1
        frame_in_segment += 1
        frame_no += 1

        if frame_in_segment >= frames_per_segment:
            frame_in_segment = 0

    if writer is not None:
        writer.release()
        segments[-1]["end_frame"] = frame_no - 1
        segments[-1]["end_sec"] = round((frame_no - 1) / fps, 3)

    cap.release()

    if not segments:
        raise ValueError("분할할 프레임이 없습니다.")

    return {
        "source_path": os.path.abspath(video_path),
        "source_name": src.name,
        "output_dir": str(out_dir.resolve()),
        "layout": layout,
        "interval_sec": interval_sec,
        "fps": round(fps, 2),
        "source_duration": round(frame_count / fps, 3),
        "frame_count": frame_count,
        "segment_count": len(segments),
        "segments": segments,
    }


def crop_video_bbox(
    video_path: str,
    output_path: str,
    x: int,
    y: int,
    width: int,
    height: int,
) -> dict:
    """
    OpenCV로 영상의 bbox 영역만 잘라 저장한다.
    (x, y, width, height)는 원본 해상도 기준 픽셀 좌표.
    """
    x = int(x)
    y = int(y)
    width = int(width)
    height = int(height)
    if width <= 0 or height <= 0:
        raise ValueError("bbox width/height는 1 이상이어야 합니다.")

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"비디오를 열 수 없습니다: {video_path}")

    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 25.0)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    if src_w <= 0 or src_h <= 0:
        cap.release()
        raise ValueError(f"영상 해상도를 읽을 수 없습니다: {video_path}")

    x = max(0, min(x, src_w - 1))
    y = max(0, min(y, src_h - 1))
    width = min(width, src_w - x)
    height = min(height, src_h - y)

    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    suffix = out_path.suffix.lower() if out_path.suffix else ".mp4"
    if suffix not in {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}:
        out_path = out_path.with_suffix(".mp4")
        suffix = ".mp4"

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(out_path), fourcc, fps, (width, height))
    if not writer.isOpened():
        cap.release()
        raise ValueError(f"출력 파일을 생성할 수 없습니다: {out_path}")

    written = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        cropped = frame[y : y + height, x : x + width]
        if cropped.shape[1] != width or cropped.shape[0] != height:
            cropped = cv2.resize(cropped, (width, height))
        writer.write(cropped)
        written += 1

    cap.release()
    writer.release()

    if written <= 0:
        try:
            out_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise ValueError("crop할 프레임이 없습니다.")

    return {
        "source_path": os.path.abspath(video_path),
        "output_path": str(out_path.resolve()),
        "bbox": {"x": x, "y": y, "width": width, "height": height},
        "source_size": {"width": src_w, "height": src_h},
        "output_size": {"width": width, "height": height},
        "fps": round(fps, 2),
        "frames_written": written,
        "frame_count_source": frame_count,
    }


def get_file_sha256(file_path: str) -> str:
    import hashlib
    digest = hashlib.sha256()
    with open(file_path, "rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_model(model_name: str | None = None) -> VLM_infer:
    global MODEL_PATH
    name = model_name or DEFAULT_MODEL_NAME
    MODEL_PATH = resolve_model_path(name)
    gpu_mem = MODEL_GPU_MEMORY_UTILIZATION.get(name, GPU_MEMORY_UTILIZATION)

    # [LoRA] 어댑터가 학습된 기본 모델과 현재 선택 모델이 반드시 같아야 합니다.
    if LORA_PATH and name != LORA_BASE_MODEL_NAME:
        raise ValueError(
            f"LoRA 어댑터는 {LORA_BASE_MODEL_NAME}용이지만 현재 모델은 {name}입니다."
        )

    return VLM_infer(
        model_path=MODEL_PATH,
        # [LoRA] 기본 모델과 별도 폴더에 둔 어댑터를 전달합니다.
        lora_path=LORA_PATH,
        max_lora_rank=LORA_MAX_RANK,
        n_device=N_DEVICE,
        gpu_memory_utilization=gpu_mem,
        max_model_len=MAX_MODEL_LEN,
        max_num_batched_tokens=MAX_NUM_BATCHED,
        sample_fps=SAMPLE_FPS,
        target_num_frames=TARGET_NUM_FRAMES,
        enable_prefix_caching=ENABLE_PREFIX_CACHING,
        mm_processor_cache_gb=MM_PROCESSOR_CACHE_GB,
    )


def run_warmup(model: VLM_infer) -> None:
    if WARMUP_VIDEO_PATH is None:
        print("[WARMUP] WARMUP_VIDEO_PATH=None, warm-up을 생략합니다.")
        return
    if not os.path.isfile(WARMUP_VIDEO_PATH):
        raise FileNotFoundError(
            f"WARMUP_VIDEO_PATH가 존재하지 않습니다: {WARMUP_VIDEO_PATH}"
        )
    print(f"[WARMUP] 시작: {WARMUP_VIDEO_PATH}")
    model.inference(
        media_paths=WARMUP_VIDEO_PATH,
        user_query=WARMUP_QUERY,
        max_tokens_size=MAX_TOKENS,
        stop_words=STOP_WORDS,
        stop_token_ids=STOP_TOKEN_IDS,
        include_stop_str_in_output=True,
        is_time=0,
    )
    print("[WARMUP] 완료")


def _enrich_infer_result(media_path: str, out: dict, prompt: str, generate_time) -> dict:
    result = dict(out)
    result.update(
        {
            "media_path": os.path.abspath(media_path),
            "file_name": Path(media_path).name,
            "media_type": get_media_type(media_path),
            "media_sha256": get_file_sha256(media_path),
            "prompt_sha256": get_prompt_sha256(prompt),
            "generate_time": generate_time,
        }
    )
    return result


def infer_batch(model: VLM_infer, media_paths: list[str], prompt: str = USER_QUERY):
    outputs, generate_time, _ = model.inference(
        media_paths=media_paths,
        user_query=prompt,
        max_tokens_size=MAX_TOKENS,
        stop_words=STOP_WORDS,
        stop_token_ids=STOP_TOKEN_IDS,
        include_stop_str_in_output=True,
        is_time=IS_TIME,
    )
    if len(outputs) != len(media_paths):
        raise RuntimeError(
            f"배치 추론 결과 개수({len(outputs)})와 요청 개수({len(media_paths)})가 다릅니다."
        )
    per_time = (generate_time / len(media_paths)) if generate_time else None
    return [
        _enrich_infer_result(path, out, prompt, per_time)
        for path, out in zip(media_paths, outputs)
    ], generate_time


def infer_one(model: VLM_infer, media_path: str, prompt: str = USER_QUERY):
    outputs, generate_time, _ = model.inference(
        media_paths=media_path,
        user_query=prompt,
        max_tokens_size=MAX_TOKENS,
        stop_words=STOP_WORDS,
        stop_token_ids=STOP_TOKEN_IDS,
        include_stop_str_in_output=True,
        is_time=IS_TIME,
    )
    if not outputs:
        raise RuntimeError("모델 추론 결과가 비어 있습니다.")
    return _enrich_infer_result(media_path, outputs[0], prompt, generate_time)
