import os
import re
import shutil
import subprocess
from pathlib import Path

VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".gif"}


def datasets_root() -> Path:
    return Path(os.environ.get("SEOUL_STUDIO_DATASETS_DIR", "/data/datasets")).resolve()


def yolo_generated_dir() -> Path:
    return datasets_root() / "detector" / "generated"


def vlm_generated_dir() -> Path:
    return datasets_root() / "vlm" / "generated"


def safe_video_folder_name(relpath: str) -> str:
    stem = Path(relpath).stem.strip()
    cleaned = re.sub(r"[^\w\-+.]+", "_", stem)
    return (cleaned or "video")[:120]


def unique_dest_dir(parent: Path, folder_name: str) -> Path:
    candidate = parent / folder_name
    if not candidate.exists():
        return candidate
    for index in range(2, 1000):
        candidate = parent / f"{folder_name}_{index}"
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"사용 가능한 폴더 이름을 찾지 못했습니다: {folder_name}")


def unique_dest_path(dest_dir: Path, filename: str) -> Path:
    candidate = dest_dir / filename
    if not candidate.exists():
        return candidate
    stem = Path(filename).stem
    suffix = Path(filename).suffix
    for index in range(2, 1000):
        candidate = dest_dir / f"{stem}_{index}{suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"사용 가능한 파일 이름을 찾지 못했습니다: {filename}")


def extract_frames(source: Path, dest_root: Path, interval: int, video_folder_name: str) -> list[str]:
    if interval < 1:
        raise ValueError("추출 간격은 1 이상이어야 합니다.")
    dest_dir = unique_dest_dir(dest_root, video_folder_name)
    dest_dir.mkdir(parents=True, exist_ok=True)
    out_pattern = str(dest_dir / "%06d.jpg")
    vf = f"select=not(mod(n\\,{interval})),scale=trunc(iw/2)*2:trunc(ih/2)*2"
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source),
        "-vf",
        vf,
        "-vsync",
        "vfr",
        out_pattern,
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)
    return sorted(str(path) for path in dest_dir.glob("*.jpg"))


def copy_video(source: Path, dest_dir: Path, relpath: str) -> str:
    dest_dir.mkdir(parents=True, exist_ok=True)
    filename = Path(relpath).name
    dest = unique_dest_path(dest_dir, filename)
    shutil.copy2(source, dest)
    return str(dest)


def send_videos_to_task(
    sources: list[tuple[Path, str]],
    *,
    target: str,
    media_kind: str,
    frame_interval: int,
) -> dict:
    normalized_target = str(target or "").strip().lower()
    normalized_kind = str(media_kind or "").strip().lower()

    if normalized_target == "yolo":
        if normalized_kind != "image":
            raise ValueError("YOLO는 이미지(프레임 추출) 형식만 지원합니다.")
        dest_root = yolo_generated_dir()
    elif normalized_target == "vlm":
        dest_root = vlm_generated_dir()
    else:
        raise ValueError("대상은 yolo 또는 vlm 이어야 합니다.")

    if normalized_kind not in {"image", "video"}:
        raise ValueError("형식은 image 또는 video 이어야 합니다.")
    if normalized_target == "yolo" and normalized_kind == "video":
        raise ValueError("YOLO는 영상 형식을 지원하지 않습니다.")
    if normalized_kind == "image" and frame_interval < 1:
        raise ValueError("추출 간격은 1 이상이어야 합니다.")
    if not sources:
        raise ValueError("선택된 영상이 없습니다.")

    exported: list[dict] = []
    frame_count = 0
    video_count = 0

    for source_path, relpath in sources:
        if source_path.suffix.lower() not in VIDEO_EXTENSIONS:
            raise ValueError(f"영상 파일이 아닙니다: {relpath}")

        video_folder_name = safe_video_folder_name(relpath)
        if normalized_kind == "image":
            try:
                destinations = extract_frames(source_path, dest_root, frame_interval, video_folder_name)
            except subprocess.CalledProcessError as exc:
                detail = (exc.stderr or exc.stdout or "").strip() or "ffmpeg 실행 실패"
                raise RuntimeError(f"프레임 추출 실패 ({relpath}): {detail}") from exc
            if not destinations:
                raise RuntimeError(f"추출된 프레임이 없습니다: {relpath}")
            frame_count += len(destinations)
        else:
            destinations = [copy_video(source_path, dest_root, relpath)]
            video_count += 1

        export_entry: dict = {"source": relpath, "destinations": destinations}
        if normalized_kind == "image" and destinations:
            export_entry["dest_folder"] = str(Path(destinations[0]).parent)
        exported.append(export_entry)

    return {
        "ok": True,
        "target": normalized_target,
        "media_kind": normalized_kind,
        "dest_root": str(dest_root),
        "exported": exported,
        "frame_count": frame_count,
        "video_count": video_count,
    }
