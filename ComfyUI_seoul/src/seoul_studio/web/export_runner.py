from __future__ import annotations

import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from seoul_studio.library_paths import resolve_preferred_video_path
from seoul_studio.task_export import send_videos_to_task
from seoul_studio.video_anonymize import anonymize_image, anonymize_video

ResolveSourceFn = Callable[[str], Path]
OutputRootFn = Callable[[], Path]
BrowseFn = Callable[[str, str], dict]


class ExportJobBusyError(RuntimeError):
    pass


class ExportJobRunner:
    """작업 보내기 + 비식별화 + 브라우저 보관 통합 파이프라인."""

    def __init__(
        self,
        resolve_source: ResolveSourceFn,
        output_root: OutputRootFn,
        browse_outputs: BrowseFn,
    ) -> None:
        self._resolve_source = resolve_source
        self._output_root = output_root
        self._browse_outputs = browse_outputs
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._active_id: Optional[str] = None

    def submit(
        self,
        *,
        paths: list[str],
        browse_path: str,
        media_filter: str,
        action: str,
        target: str,
        media_kind: str,
        frame_interval: int,
        folder_name: str,
        anonymize: bool,
        weights: Path,
        blur_ratio: int,
        conf: float,
        class_ids: list[int],
    ) -> dict[str, Any]:
        with self._lock:
            if self._active_id and self._jobs[self._active_id]["state"] == "running":
                raise ExportJobBusyError("이미 내보내기 작업이 진행 중입니다.")
            job_id = str(uuid.uuid4())
            self._jobs[job_id] = {
                "id": job_id,
                "state": "running",
                "action": action,
                "paths": paths,
                "browse_path": browse_path,
                "media_filter": media_filter,
                "progress": {"phase": "queued", "current": 0, "total": len(paths)},
                "results": [],
                "error": None,
            }
            self._active_id = job_id

        thread = threading.Thread(
            target=self._run_job,
            args=(
                job_id,
                paths,
                browse_path,
                media_filter,
                action,
                target,
                media_kind,
                frame_interval,
                folder_name,
                anonymize,
                weights,
                blur_ratio,
                conf,
                class_ids,
            ),
            daemon=True,
        )
        thread.start()
        return {"id": job_id, "job_id": job_id, "state": "running"}

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            return dict(job)

    def _run_job(
        self,
        job_id: str,
        paths: list[str],
        browse_path: str,
        media_filter: str,
        action: str,
        target: str,
        media_kind: str,
        frame_interval: int,
        folder_name: str,
        anonymize: bool,
        weights: Path,
        blur_ratio: int,
        conf: float,
        class_ids: list[int],
    ) -> None:
        results: list[dict[str, Any]] = []
        try:
            root = self._output_root()
            total = len(paths)
            for index, relpath in enumerate(paths, start=1):
                self._update_progress(
                    job_id,
                    phase="processing",
                    current=index,
                    total=total,
                    path=relpath,
                )
                source = self._resolve_source(relpath)

                suffix = source.suffix.lower()
                is_video = suffix in {".mp4", ".avi", ".mov", ".mkv", ".webm"}
                is_image = suffix in {".jpg", ".jpeg", ".png", ".bmp", ".webp"}

                if action == "archive":
                    if is_video:
                        result = anonymize_video(
                            source,
                            weights=weights,
                            blur_ratio=blur_ratio,
                            conf=conf,
                            class_ids=class_ids,
                            on_progress=lambda p, jid=job_id: self._merge_progress(jid, p),
                        )
                    elif is_image:
                        result = anonymize_image(
                            source,
                            weights=weights,
                            blur_ratio=blur_ratio,
                            conf=conf,
                            class_ids=class_ids,
                        )
                    else:
                        raise ValueError(f"비식별화를 지원하지 않는 형식입니다: {source.name}")
                    results.append({"path": relpath, "action": "archive", **result})
                    continue

                # action == "send"
                send_source = source
                send_relpath = relpath
                if is_video:
                    if anonymize:
                        anon_result = anonymize_video(
                            source,
                            weights=weights,
                            blur_ratio=blur_ratio,
                            conf=conf,
                            class_ids=class_ids,
                            on_progress=lambda p, jid=job_id: self._merge_progress(jid, p),
                        )
                        send_source = Path(anon_result["dest"])
                        send_relpath = send_source.relative_to(root).as_posix()
                        results.append({"path": relpath, "anonymized": anon_result})
                    else:
                        send_source, send_relpath = resolve_preferred_video_path(
                            source, root, prefer_anonymized=True
                        )

                export_result = send_videos_to_task(
                    [(send_source, send_relpath)],
                    target=target,
                    media_kind=media_kind,
                    frame_interval=frame_interval,
                    folder_name=folder_name,
                    anonymize_frames=anonymize and is_image,
                    blur_weights=weights,
                    blur_ratio=blur_ratio,
                    blur_conf=conf,
                    blur_class_ids=class_ids,
                )
                results.append({"path": relpath, "action": "send", **export_result})

            browse = self._browse_outputs(browse_path, media_filter)
            self._finish_job(job_id, results, browse)
        except Exception as exc:
            self._fail_job(job_id, str(exc))

    def _merge_progress(self, job_id: str, partial: dict[str, Any]) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            progress = dict(job.get("progress") or {})
            progress.update(partial)
            job["progress"] = progress

    def _update_progress(
        self,
        job_id: str,
        *,
        phase: str,
        current: int,
        total: int,
        path: str = "",
    ) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            job["progress"] = {
                "phase": phase,
                "current": current,
                "total": total,
                "path": path,
            }

    def _finish_job(self, job_id: str, results: list[dict], browse: dict) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            job["state"] = "done"
            job["results"] = results
            job["browse"] = browse
            job["progress"] = {"phase": "done", "current": len(results), "total": len(results)}
            if self._active_id == job_id:
                self._active_id = None

    def _fail_job(self, job_id: str, error: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return
            job["state"] = "failed"
            job["error"] = error
            if self._active_id == job_id:
                self._active_id = None
