import io
import os
import zipfile
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from seoul_studio.config import AppConfig, default_config_path, effective_output_dir, load_config, normalize_server_url, save_config
from seoul_studio.generate import run_generation
from seoul_studio.job import JobValidationError
from seoul_studio.task_export import send_videos_to_task
from seoul_studio.training_guard import TRAINING_BLOCK_MESSAGE, is_training_active
from seoul_studio.presets import aspect_ratio_options, duration_options, resolution_options
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
    if cleaned in SKIP_DIRS:
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


def _browse_outputs(relpath: str) -> dict:
    current = _resolve_under_root(relpath, must_exist=True)
    root = _output_root()
    normalized = _normalize_relpath(relpath)

    subfolders: list[dict] = []
    items: list[dict] = []
    for entry in sorted(current.iterdir(), key=lambda path: path.name.lower()):
        if entry.is_dir():
            if entry.name in SKIP_DIRS:
                continue
            child_path = entry.relative_to(root).as_posix()
            subfolders.append(
                {
                    "name": entry.name,
                    "path": child_path,
                    "video_count": _count_videos_in_tree(entry, root),
                }
            )
            continue
        if entry.is_file() and entry.suffix.lower() in VIDEO_EXTENSIONS:
            stat = entry.stat()
            file_path = entry.relative_to(root).as_posix()
            items.append(
                {
                    "name": file_path,
                    "size": stat.st_size,
                    "modified_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
                }
            )

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
        "subfolders": subfolders,
        "items": items,
    }


def create_app(generate_fn: Optional[Callable] = None) -> FastAPI:
    runner = JobRunner(generate_fn or run_generation, _load_app_config)
    app = FastAPI(title="영상 만들기")
    base_path = _base_path()

    @app.get("/api/health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/", response_class=HTMLResponse)
    def home() -> str:
        html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        html = html.replace("__SEOUL_STUDIO_BASE__", base_path or "/")
        return html

    @app.get("/api/bootstrap")
    def bootstrap() -> dict:
        config = _load_app_config()
        host_root = _host_output_hint()
        subdir = config.output_subdir
        return {
            "config": asdict(config),
            "root_label": ROOT_LABEL,
            "host_output_dir": host_root,
            "save_path": f"{host_root}/{subdir}" if subdir else host_root,
            "resolutions": resolution_options(),
            "aspect_ratios": aspect_ratio_options(),
            "durations": duration_options(),
        }

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
    def browse_outputs(path: str = "") -> dict:
        return _browse_outputs(path)

    @app.put("/api/outputs/active-folder")
    def set_active_folder(body: ActiveFolderBody) -> dict:
        config = _set_output_subdir(body.path)
        return {"ok": True, "config": asdict(config), "browse": _browse_outputs(config.output_subdir)}

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
        return {"ok": True, "folder": {"name": name, "path": child_path}, "browse": _browse_outputs(parent)}

    @app.get("/api/outputs")
    def list_outputs(path: str = "") -> dict:
        return _browse_outputs(path)

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
    def delete_folder_outputs(path: str = "") -> dict:
        browse = _browse_outputs(path)
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
            "browse": _browse_outputs(path),
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
            "browse": _browse_outputs(body.browse_path),
        }

    @app.post("/api/outputs/send-to-task")
    def send_outputs_to_task(body: SendToTaskBody) -> dict:
        if not body.paths:
            raise HTTPException(status_code=400, detail="선택된 영상이 없습니다.")
        if len(body.paths) > 50:
            raise HTTPException(status_code=400, detail="한 번에 50개까지 보낼 수 있습니다.")
        if body.frame_interval < 1 or body.frame_interval > 10_000:
            raise HTTPException(status_code=400, detail="추출 간격은 1~10000 사이여야 합니다.")

        sources: list[tuple[Path, str]] = []
        for relpath in body.paths:
            sources.append((_resolve_output_file(relpath), relpath))

        try:
            result = send_videos_to_task(
                sources,
                target=body.target,
                media_kind=body.media_kind,
                frame_interval=body.frame_interval,
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
