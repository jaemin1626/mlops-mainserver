import io
import os
import zipfile
import json
import urllib.request
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from seoul_studio.config import AppConfig, default_config_path, effective_output_dir, load_config, normalize_server_url, save_config
from seoul_studio.generate import run_generation
from seoul_studio.job import JobValidationError
from seoul_studio.library_paths import (
    ANONY_DIR,
    MEDIA_FILTER_ALL,
    MEDIA_FILTER_ANONYMIZED,
    MEDIA_FILTER_ORIGINAL,
    RESERVED_DIR_NAMES,
    anony_dir_for,
    media_kind_for_relpath,
    normalize_media_filter,
    resolve_preferred_video_path,
)
from seoul_studio.task_export import send_videos_to_task
from seoul_studio.blur_detector import validate_blur_weights
from seoul_studio.video_anonymize import (
    default_blur_ratio,
    default_conf,
    default_imgsz,
    default_weights_path,
)
from seoul_studio.training_guard import TRAINING_BLOCK_MESSAGE, is_training_active
from seoul_studio.presets import aspect_ratio_options, duration_options, resolution_options
from seoul_studio.prompt_assist import (
    PromptAssistError,
    assist as run_prompt_assist,
)
from seoul_studio.web.anonymize_runner import AnonymizeJobBusyError, AnonymizeJobRunner
from seoul_studio.web.export_runner import ExportJobBusyError, ExportJobRunner
from seoul_studio.web.job_runner import JobBusyError, JobRunner

STATIC_DIR = Path(__file__).resolve().parent / "static"
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".gif"}
ROOT_LABEL = "generate_datasets"
SKIP_DIRS = {"uploads"}


class SettingsBody(BaseModel):
    server_url: str
    output_subdir: str = ""


class CreateFolderBody(BaseModel):
    parent: str = ""
    name: str


class ActiveFolderBody(BaseModel):
    path: str = ""


class BatchPathsBody(BaseModel):
    paths: list[str]
    browse_path: str = ""


class SendToTaskBody(BaseModel):
    paths: list[str]
    browse_path: str = ""
    target: str
    media_kind: str
    frame_interval: int = 30
    folder_name: str = ""


ANONYMIZE_BLUR_RATIO = 10
ANONYMIZE_CONF = 0.25
ANONYMIZE_ALLOWED_CLASSES = {2, 5}


class AnonymizeBody(BaseModel):
    paths: list[str]
    browse_path: str = ""
    media_filter: str = MEDIA_FILTER_ALL
    blur_ratio: int | None = None
    conf: float | None = None
    classes: list[int] | None = None


class ExportBody(BaseModel):
    paths: list[str]
    browse_path: str = ""
    media_filter: str = MEDIA_FILTER_ALL
    action: str
    target: str = "detector"
    media_kind: str = "image"
    frame_interval: int = 30
    folder_name: str = ""
    anonymize: bool = False
    classes: list[int] | None = None


class PromptAssistBody(BaseModel):
    intent_ko: str
    scenario: str = "generic"


def _config_path() -> Path:
    override = os.environ.get("SEOUL_STUDIO_CONFIG")
    if override:
        return Path(override)
    return default_config_path()


def _base_path() -> str:
    raw = os.environ.get("SEOUL_STUDIO_BASE_PATH", "").strip()
    if not raw or raw == "/":
        return ""
    return raw.rstrip("/")


def _load_app_config() -> AppConfig:
    config_path = _config_path()
    config = load_config(config_path).normalized()

    env_url = os.environ.get("SEOUL_STUDIO_COMFY_URL", "").strip()
    if env_url:
        config = AppConfig(
            server_url=normalize_server_url(env_url),
            output_dir=config.output_dir,
            output_subdir=config.output_subdir,
        )

    output_override = os.environ.get("SEOUL_STUDIO_OUTPUT_DIR", "").strip()
    if output_override:
        config = AppConfig(
            server_url=config.server_url,
            output_dir=output_override,
            output_subdir=config.output_subdir,
        )

    return config.normalized()


def _static_asset_version() -> str:
    latest = 0
    for name in ("app.js", "style.css", "index.html"):
        path = STATIC_DIR / name
        if path.is_file():
            latest = max(latest, int(path.stat().st_mtime))
    return str(latest or 1)


def _host_output_hint() -> str:
    return os.environ.get(
        "SEOUL_STUDIO_HOST_OUTPUT_DIR",
        "/opt/clearml/data/generate_datasets",
    ).strip()


def _output_root() -> Path:
    return Path(_load_app_config().output_dir).resolve()


def _normalize_relpath(raw: str) -> str:
    cleaned = str(raw or "").strip().strip("/")
    if cleaned in {"", ".", "./"}:
        return ""
    path = Path(cleaned)
    if ".." in path.parts:
        raise HTTPException(status_code=400, detail="잘못된 폴더 경로입니다.")
    return path.as_posix()


def _resolve_under_root(relpath: str, *, must_exist: bool = True) -> Path:
    normalized = _normalize_relpath(relpath)
    root = _output_root()
    target = (root / normalized).resolve() if normalized else root
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="잘못된 폴더 경로입니다.") from exc
    if must_exist and not target.is_dir():
        raise HTTPException(status_code=404, detail="폴더를 찾을 수 없습니다.")
    return target


def _validate_folder_name(name: str) -> str:
    cleaned = name.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="폴더 이름을 입력하세요.")
    if cleaned in {".", ".."} or "/" in cleaned or "\\" in cleaned:
        raise HTTPException(status_code=400, detail="사용할 수 없는 폴더 이름입니다.")
    if cleaned in SKIP_DIRS or cleaned in RESERVED_DIR_NAMES:
        raise HTTPException(status_code=400, detail="예약된 폴더 이름입니다.")
    return cleaned


def _count_videos_in_tree(directory: Path, root: Path) -> int:
    count = 0
    if not directory.is_dir():
        return 0
    for path in directory.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in VIDEO_EXTENSIONS:
            continue
        relative = path.relative_to(root)
        if any(part in SKIP_DIRS for part in relative.parts[:-1]):
            continue
        count += 1
    return count


def _set_output_subdir(relpath: str) -> AppConfig:
    normalized = _normalize_relpath(relpath)
    if normalized:
        _resolve_under_root(normalized, must_exist=True)
    config = _load_app_config()
    updated = AppConfig(
        server_url=config.server_url,
        output_dir=config.output_dir,
        output_subdir=normalized,
    ).normalized()
    save_config(updated, _config_path())
    return _load_app_config()


def _resolve_output_file(relpath: str) -> Path:
    if not relpath or ".." in Path(relpath).parts:
        raise HTTPException(status_code=400, detail="잘못된 파일 경로입니다.")
    output_dir = _output_root()
    path = (output_dir / relpath).resolve()
    try:
        path.relative_to(output_dir)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.") from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="파일을 찾을 수 없습니다.")
    if path.suffix.lower() not in VIDEO_EXTENSIONS:
        raise HTTPException(status_code=404, detail="영상 파일이 아닙니다.")
    return path


def _video_item(entry: Path, root: Path) -> dict:
    relpath = entry.relative_to(root).as_posix()
    stat = entry.stat()
    return {
        "name": relpath,
        "label": entry.name,
        "size": stat.st_size,
        "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "media_kind": media_kind_for_relpath(relpath),
    }


def _collect_videos(directory: Path, root: Path) -> list[dict]:
    if not directory.is_dir():
        return []
    items: list[dict] = []
    for entry in sorted(directory.iterdir(), key=lambda path: path.name.lower()):
        if entry.is_file() and entry.suffix.lower() in VIDEO_EXTENSIONS:
            items.append(_video_item(entry, root))
    return items


def _browse_outputs(relpath: str, media_filter: str = MEDIA_FILTER_ALL) -> dict:
    media_filter = normalize_media_filter(media_filter)
    current = _resolve_under_root(relpath, must_exist=True)
    root = _output_root()
    normalized = _normalize_relpath(relpath)

    subfolders: list[dict] = []
    for entry in sorted(current.iterdir(), key=lambda path: path.name.lower()):
        if not entry.is_dir() or entry.name in SKIP_DIRS:
            continue
        if media_filter == MEDIA_FILTER_ORIGINAL and entry.name == ANONY_DIR:
            continue
        if media_filter == MEDIA_FILTER_ANONYMIZED and entry.name == ANONY_DIR:
            continue
        child_path = entry.relative_to(root).as_posix()
        subfolders.append(
            {
                "name": entry.name,
                "path": child_path,
                "video_count": _count_videos_in_tree(entry, root),
                "is_anony": entry.name == ANONY_DIR,
            }
        )

    originals = _collect_videos(current, root)
    anonymized_dir = anony_dir_for(current)
    anonymized = _collect_videos(anonymized_dir, root) if anonymized_dir.is_dir() else []
    legacy_anony = [item for item in originals if item["media_kind"] == MEDIA_FILTER_ANONYMIZED]
    originals = [item for item in originals if item["media_kind"] == MEDIA_FILTER_ORIGINAL]

    if media_filter == MEDIA_FILTER_ANONYMIZED:
        items = anonymized + legacy_anony
    elif media_filter == MEDIA_FILTER_ORIGINAL:
        items = originals
    else:
        items = originals + anonymized + legacy_anony

    items.sort(key=lambda item: item["modified_at"], reverse=True)
    host_root = _host_output_hint()
    host_path = f"{host_root}/{normalized}" if normalized else host_root
    return {
        "root_label": ROOT_LABEL,
        "output_dir": str(root),
        "host_output_dir": host_root,
        "path": normalized,
        "host_path": host_path,
        "output_subdir": normalized,
        "media_filter": media_filter,
        "subfolders": subfolders,
        "items": items,
    }


def _tree_children(relpath: str) -> list[dict]:
    current = _resolve_under_root(relpath, must_exist=True)
    root = _output_root()
    nodes: list[dict] = []
    for entry in sorted(current.iterdir(), key=lambda path: path.name.lower()):
        if not entry.is_dir() or entry.name in SKIP_DIRS:
            continue
        child_path = entry.relative_to(root).as_posix()
        has_children = any(
            child.is_dir() and child.name not in SKIP_DIRS for child in entry.iterdir()
        )
        nodes.append(
            {
                "name": entry.name,
                "path": child_path,
                "is_anony": entry.name == ANONY_DIR,
                "has_children": has_children,
            }
        )
    return nodes


def create_app(generate_fn: Optional[Callable] = None) -> FastAPI:
    runner = JobRunner(generate_fn or run_generation, _load_app_config)
    anonymize_runner = AnonymizeJobRunner(_resolve_output_file, _output_root, _browse_outputs)
    export_runner = ExportJobRunner(_resolve_output_file, _output_root, _browse_outputs)
    app = FastAPI(title="영상 만들기")
    base_path = _base_path()

    @app.middleware('http')
    async def require_generation_permission(request: Request, call_next):
        if '/api/' in request.url.path and request.method in {'POST', 'PUT', 'PATCH', 'DELETE'}:
            url = os.environ.get('ACCESS_CONTROL_URL', 'http://access-control:8095') + '/authorize?permission=DATA_GENERATE'
            try:
                check = urllib.request.Request(url, headers={'Cookie': request.headers.get('cookie', '')})
                with urllib.request.urlopen(check, timeout=5) as response:
                    if response.status != 200:
                        return JSONResponse({'error': '데이터 생성 권한이 필요합니다.'}, status_code=403)
            except urllib.error.HTTPError as exc:
                return JSONResponse({'error': '로그인 또는 데이터 생성 권한이 필요합니다.'}, status_code=exc.code if exc.code in (401, 403) else 403)
            except Exception:
                return JSONResponse({'error': '권한 서비스를 확인할 수 없습니다.'}, status_code=503)
        return await call_next(request)

    @app.get("/api/health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/", response_class=HTMLResponse)
    def home() -> str:
        html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        html = html.replace("__SEOUL_STUDIO_BASE__", base_path or "/")
        asset_version = _static_asset_version()
        html = html.replace("static/style.css", f"static/style.css?v={asset_version}")
        html = html.replace("static/app.js", f"static/app.js?v={asset_version}")
        return html

    @app.get("/api/bootstrap")
    def bootstrap() -> dict:
        config = _load_app_config()
        host_root = _host_output_hint()
        subdir = config.output_subdir
        weights = default_weights_path()
        weights_load_error = validate_blur_weights(weights) if weights.is_file() else None
        weights_ready = weights.is_file() and weights_load_error is None
        return {
            "config": asdict(config),
            "root_label": ROOT_LABEL,
            "host_output_dir": host_root,
            "save_path": f"{host_root}/{subdir}" if subdir else host_root,
            "resolutions": resolution_options(),
            "aspect_ratios": aspect_ratio_options(),
            "durations": duration_options(),
            "blur": {
                "weights_path": str(weights),
                "weights_available": weights.is_file(),
                "weights_ready": weights_ready,
                "weights_load_error": weights_load_error,
                "default_blur_ratio": default_blur_ratio(),
                "default_conf": default_conf(),
                "default_imgsz": default_imgsz(),
            },
        }

    @app.post("/api/prompt-assist")
    def prompt_assist(body: PromptAssistBody) -> dict:
        try:
            result = run_prompt_assist(body.intent_ko, body.scenario)
            return {
                "positive": result["positive"],
                "negative": result["negative"],
                "scenario": result.get("scenario"),
            }
        except PromptAssistError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.put("/api/settings")
    def update_settings(body: SettingsBody) -> dict:
        current = _load_app_config()
        config = AppConfig(
            server_url=normalize_server_url(body.server_url),
            output_dir=current.output_dir,
            output_subdir=_normalize_relpath(body.output_subdir),
        ).normalized()
        if config.output_subdir:
            _resolve_under_root(config.output_subdir, must_exist=True)
        save_config(config, _config_path())
        return {"ok": True, "config": asdict(_load_app_config())}

    @app.get("/api/training-status")
    def training_status() -> dict:
        active, tasks = is_training_active()
        return {
            "training_active": active,
            "running_count": len(tasks),
            "message": TRAINING_BLOCK_MESSAGE if active else "",
            "tasks": [
                {
                    "id": task.get("id", ""),
                    "name": task.get("name", ""),
                    "project_id": (task.get("project") or {}).get("id", ""),
                }
                for task in tasks[:10]
            ],
        }

    @app.post("/api/jobs", status_code=202)
    async def start_job(
        mode: str = Form(...),
        prompt: str = Form(...),
        resolution: str = Form(...),
        duration_sec: str = Form(...),
        seed: str = Form(""),
        random_seed: str = Form("true"),
        negative_prompt: str = Form(""),
        aspect_ratio: str = Form(""),
        output_name: str = Form(""),
        image: Optional[UploadFile] = File(None),
    ) -> dict:
        if is_training_active()[0]:
            raise HTTPException(status_code=409, detail=TRAINING_BLOCK_MESSAGE)
        image_path = ""
        if image is not None and image.filename:
            data = await image.read()
            if data:
                image_path = runner.save_upload(image.filename, data)
        try:
            return runner.submit(
                mode,
                prompt,
                resolution,
                duration_sec,
                seed,
                image_path,
                negative_prompt,
                random_seed.strip().lower() in ("1", "true", "yes"),
                aspect_ratio,
                output_name,
            )
        except JobValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except JobBusyError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/jobs/{job_id}")
    def job_status(job_id: str) -> dict:
        job = runner.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="작업을 찾을 수 없습니다.")
        return job

    @app.get("/api/jobs/{job_id}/video")
    def job_video(job_id: str) -> FileResponse:
        job = runner.get(job_id)
        if job is None or job["state"] != "done" or not job["output_path"]:
            raise HTTPException(status_code=404, detail="결과 영상이 아직 없습니다.")
        path = Path(job["output_path"])
        if not path.is_file():
            raise HTTPException(status_code=404, detail="결과 파일을 찾을 수 없습니다.")
        return FileResponse(path, media_type="video/mp4", filename=path.name)

    @app.get("/api/outputs/browse")
    def browse_outputs(path: str = "", media_filter: str = MEDIA_FILTER_ALL) -> dict:
        return _browse_outputs(path, media_filter)

    @app.get("/api/outputs/tree")
    def output_tree(path: str = "") -> dict:
        normalized = _normalize_relpath(path)
        if normalized:
            _resolve_under_root(normalized, must_exist=True)
        return {"path": normalized, "children": _tree_children(normalized)}

    @app.put("/api/outputs/active-folder")
    def set_active_folder(body: ActiveFolderBody) -> dict:
        config = _set_output_subdir(body.path)
        return {
            "ok": True,
            "config": asdict(config),
            "browse": _browse_outputs(config.output_subdir, MEDIA_FILTER_ALL),
        }

    @app.post("/api/outputs/folders")
    def create_output_folder(body: CreateFolderBody) -> dict:
        parent = _normalize_relpath(body.parent)
        name = _validate_folder_name(body.name)
        parent_dir = _resolve_under_root(parent, must_exist=True)
        target = parent_dir / name
        if target.exists():
            raise HTTPException(status_code=409, detail="같은 이름의 폴더가 이미 있습니다.")
        target.mkdir(parents=False, exist_ok=False)
        child_path = target.relative_to(_output_root()).as_posix()
        return {
            "ok": True,
            "folder": {"name": name, "path": child_path},
            "browse": _browse_outputs(parent, MEDIA_FILTER_ALL),
        }

    @app.get("/api/outputs")
    def list_outputs(path: str = "", media_filter: str = MEDIA_FILTER_ALL) -> dict:
        return _browse_outputs(path, media_filter)

    def _validate_anonymize_request(body: AnonymizeBody) -> Path:
        if not body.paths:
            raise HTTPException(status_code=400, detail="선택된 영상이 없습니다.")
        if len(body.paths) > 10:
            raise HTTPException(status_code=400, detail="한 번에 10개까지 비식별화할 수 있습니다.")

        weights = default_weights_path()
        if not weights.is_file():
            raise HTTPException(
                status_code=503,
                detail=f"가중치(.pt)가 없습니다: {weights}. SEOUL_STUDIO_BLUR_WEIGHTS 경로를 확인하세요.",
            )
        weights_load_error = validate_blur_weights(weights)
        if weights_load_error:
            raise HTTPException(status_code=400, detail=weights_load_error)

        if not body.classes:
            raise HTTPException(status_code=400, detail="비식별화 대상 클래스를 하나 이상 선택하세요.")
        invalid_classes = sorted(set(body.classes) - ANONYMIZE_ALLOWED_CLASSES)
        if invalid_classes:
            raise HTTPException(
                status_code=400,
                detail=f"허용되지 않는 클래스 ID: {', '.join(str(x) for x in invalid_classes)}",
            )
        if body.blur_ratio is not None and body.blur_ratio != ANONYMIZE_BLUR_RATIO:
            raise HTTPException(status_code=400, detail=f"블러 강도는 {ANONYMIZE_BLUR_RATIO} 로 고정됩니다.")
        if body.conf is not None and body.conf != ANONYMIZE_CONF:
            raise HTTPException(status_code=400, detail=f"검출 conf 는 {ANONYMIZE_CONF} 로 고정됩니다.")
        return weights

    @app.post("/api/outputs/anonymize/jobs", status_code=202)
    def start_anonymize_job(body: AnonymizeBody) -> dict:
        weights = _validate_anonymize_request(body)
        try:
            return anonymize_runner.submit(
                paths=body.paths,
                browse_path=body.browse_path,
                media_filter=normalize_media_filter(body.media_filter),
                weights=weights,
                blur_ratio=ANONYMIZE_BLUR_RATIO,
                conf=ANONYMIZE_CONF,
                class_ids=sorted(set(body.classes or [])),
            )
        except AnonymizeJobBusyError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/outputs/anonymize/jobs/{job_id}")
    def anonymize_job_status(job_id: str) -> dict:
        job = anonymize_runner.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="비식별화 작업을 찾을 수 없습니다.")
        return job

    def _validate_export_classes(body: ExportBody) -> list[int]:
        needs_classes = body.action == "archive" or body.anonymize
        if not needs_classes:
            return []
        if not body.classes:
            raise HTTPException(status_code=400, detail="비식별화 대상 클래스를 하나 이상 선택하세요.")
        invalid_classes = sorted(set(body.classes) - ANONYMIZE_ALLOWED_CLASSES)
        if invalid_classes:
            raise HTTPException(
                status_code=400,
                detail=f"허용되지 않는 클래스 ID: {', '.join(str(x) for x in invalid_classes)}",
            )
        return sorted(set(body.classes))

    def _validate_export_weights() -> Path:
        weights = default_weights_path()
        if not weights.is_file():
            raise HTTPException(
                status_code=503,
                detail=f"가중치(.pt)가 없습니다: {weights}. SEOUL_STUDIO_BLUR_WEIGHTS 경로를 확인하세요.",
            )
        weights_load_error = validate_blur_weights(weights)
        if weights_load_error:
            raise HTTPException(status_code=400, detail=weights_load_error)
        return weights

    @app.post("/api/outputs/export/jobs", status_code=202)
    def start_export_job(body: ExportBody) -> dict:
        if not body.paths:
            raise HTTPException(status_code=400, detail="선택된 영상이 없습니다.")
        if len(body.paths) > 50:
            raise HTTPException(status_code=400, detail="한 번에 50개까지 처리할 수 있습니다.")

        action = str(body.action or "").strip().lower()
        if action not in {"send", "archive"}:
            raise HTTPException(status_code=400, detail="action 은 send 또는 archive 이어야 합니다.")

        if action == "send":
            if body.frame_interval < 1 or body.frame_interval > 10_000:
                raise HTTPException(status_code=400, detail="추출 간격은 1~10000 사이여야 합니다.")
            if not body.folder_name.strip():
                raise HTTPException(status_code=400, detail="저장 폴더명을 입력하세요.")

        class_ids = _validate_export_classes(body)
        weights = _validate_export_weights() if action == "archive" or body.anonymize else default_weights_path()

        if (action == "archive" or body.anonymize) and not weights.is_file():
            raise HTTPException(status_code=503, detail="비식별화 가중치를 사용할 수 없습니다.")

        try:
            return export_runner.submit(
                paths=body.paths,
                browse_path=body.browse_path,
                media_filter=normalize_media_filter(body.media_filter),
                action=action,
                target=body.target,
                media_kind=body.media_kind,
                frame_interval=body.frame_interval,
                folder_name=body.folder_name.strip(),
                anonymize=body.anonymize,
                weights=weights,
                blur_ratio=ANONYMIZE_BLUR_RATIO,
                conf=ANONYMIZE_CONF,
                class_ids=class_ids,
            )
        except ExportJobBusyError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/outputs/export/jobs/{job_id}")
    def export_job_status(job_id: str) -> dict:
        job = export_runner.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="내보내기 작업을 찾을 수 없습니다.")
        return job

    @app.get("/api/outputs/{filepath:path}")
    def output_video(filepath: str) -> FileResponse:
        path = _resolve_output_file(filepath)
        media_type = "video/mp4"
        if path.suffix.lower() == ".webm":
            media_type = "video/webm"
        elif path.suffix.lower() == ".gif":
            media_type = "image/gif"
        return FileResponse(path, media_type=media_type, filename=path.name)

    @app.delete("/api/outputs/{filepath:path}")
    def delete_output(filepath: str) -> dict:
        path = _resolve_output_file(filepath)
        try:
            path.unlink()
        except OSError as exc:
            raise HTTPException(status_code=500, detail="파일을 삭제하지 못했습니다.") from exc
        return {"ok": True, "deleted": filepath}

    @app.post("/api/outputs/delete-folder")
    def delete_folder_outputs(path: str = "", media_filter: str = MEDIA_FILTER_ALL) -> dict:
        browse = _browse_outputs(path, media_filter)
        deleted: list[str] = []
        errors: list[str] = []
        for item in browse["items"]:
            try:
                file_path = _resolve_output_file(str(item["name"]))
                file_path.unlink()
                deleted.append(str(item["name"]))
            except HTTPException:
                errors.append(str(item["name"]))
            except OSError:
                errors.append(str(item["name"]))
        if errors and not deleted:
            raise HTTPException(status_code=500, detail="영상을 삭제하지 못했습니다.")
        return {
            "ok": True,
            "deleted": deleted,
            "count": len(deleted),
            "failed": errors,
            "browse": _browse_outputs(path, media_filter),
        }

    @app.post("/api/outputs/delete-batch")
    def delete_batch_outputs(body: BatchPathsBody) -> dict:
        if not body.paths:
            raise HTTPException(status_code=400, detail="선택된 영상이 없습니다.")
        deleted: list[str] = []
        errors: list[str] = []
        for relpath in body.paths:
            try:
                file_path = _resolve_output_file(relpath)
                file_path.unlink()
                deleted.append(relpath)
            except HTTPException:
                errors.append(relpath)
            except OSError:
                errors.append(relpath)
        if errors and not deleted:
            raise HTTPException(status_code=500, detail="영상을 삭제하지 못했습니다.")
        return {
            "ok": True,
            "deleted": deleted,
            "count": len(deleted),
            "failed": errors,
            "browse": _browse_outputs(body.browse_path, MEDIA_FILTER_ALL),
        }

    @app.post("/api/outputs/send-to-task")
    def send_outputs_to_task(body: SendToTaskBody) -> dict:
        if not body.paths:
            raise HTTPException(status_code=400, detail="선택된 영상이 없습니다.")
        if len(body.paths) > 50:
            raise HTTPException(status_code=400, detail="한 번에 50개까지 보낼 수 있습니다.")
        if body.frame_interval < 1 or body.frame_interval > 10_000:
            raise HTTPException(status_code=400, detail="추출 간격은 1~10000 사이여야 합니다.")

        root = _output_root()
        sources: list[tuple[Path, str]] = []
        for relpath in body.paths:
            source = _resolve_output_file(relpath)
            preferred, preferred_relpath = resolve_preferred_video_path(
                source, root, prefer_anonymized=True
            )
            sources.append((preferred, preferred_relpath))

        try:
            result = send_videos_to_task(
                sources,
                target=body.target,
                media_kind=body.media_kind,
                frame_interval=body.frame_interval,
                folder_name=body.folder_name,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        return result

    @app.post("/api/outputs/download-batch")
    def download_batch_outputs(body: BatchPathsBody) -> StreamingResponse:
        if not body.paths:
            raise HTTPException(status_code=400, detail="선택된 영상이 없습니다.")
        if len(body.paths) > 100:
            raise HTTPException(status_code=400, detail="한 번에 100개까지 다운로드할 수 있습니다.")

        buffer = io.BytesIO()
        used_names: set[str] = set()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for relpath in body.paths:
                path = _resolve_output_file(relpath)
                arcname = Path(relpath).name
                if arcname in used_names:
                    arcname = f"{Path(relpath).parent.name}_{arcname}" if Path(relpath).parent.name else f"dup_{arcname}"
                used_names.add(arcname)
                archive.write(path, arcname=arcname)
        buffer.seek(0)
        folder_label = _normalize_relpath(body.browse_path) or "generate_datasets"
        filename = f"{folder_label.replace('/', '-') or 'videos'}.zip"
        return StreamingResponse(
            buffer,
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    if not base_path:
        return app

    root = FastAPI(title="Video Studio Gateway")
    root.mount(base_path, app)

    @root.get(base_path, include_in_schema=False)
    def redirect_trailing() -> RedirectResponse:
        return RedirectResponse(url=f"{base_path}/", status_code=301)

    return root


app = create_app()


def main() -> None:
    host = os.environ.get("SEOUL_STUDIO_HOST", "0.0.0.0")
    port = int(os.environ.get("SEOUL_STUDIO_PORT", "7860"))
    uvicorn.run(app, host=host, port=port, log_level="info")
