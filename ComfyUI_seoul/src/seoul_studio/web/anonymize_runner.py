from __future__ import annotations

import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from seoul_studio.video_anonymize import anonymize_video


ResolveSourceFn = Callable[[str], Path]
OutputRootFn = Callable[[], Path]
BrowseFn = Callable[[str, str], dict]


class AnonymizeJobBusyError(RuntimeError):
    pass


class AnonymizeJobRunner:
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
        weights: Path,
        blur_ratio: int | None,
        conf: float | None,
        class_ids: list[int] | None,
    ) -> dict[str, Any]:
        with self._lock:
            if self._active_id and self._jobs[self._active_id]["state"] == "running":
                raise AnonymizeJobBusyError("이미 비식별화 작업이 진행 중입니다.")
            job_id = str(uuid.uuid4())
            self._jobs[job_id] = {
                "id": job_id,
                "state": "running",
                "message": "비식별화를 시작합니다…",
                "step": "",
                "detail": "",
                "progress": None,
                "indeterminate": True,
                "processed": [],
                "errors": [],
                "browse_path": browse_path,
                "media_filter": media_filter,
                "browse": None,
                "error": None,
                "total_videos": len(paths),
                "current_video_index": 0,
                "paths": list(paths),
                "weights": str(weights),
                "blur_ratio": blur_ratio,
                "conf": conf,
                "class_ids": class_ids,
            }
            self._active_id = job_id

        thread = threading.Thread(target=self._run, args=(job_id,), daemon=True)
        thread.start()
        return {"id": job_id, "state": "running"}

    def get(self, job_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return {
                "id": job["id"],
                "state": job["state"],
                "message": job["message"],
                "step": job.get("step") or "",
                "detail": job.get("detail") or "",
                "progress": job.get("progress"),
                "indeterminate": bool(job.get("indeterminate", False)),
                "processed": list(job.get("processed") or []),
                "errors": list(job.get("errors") or []),
                "browse_path": job.get("browse_path") or "",
                "browse": job.get("browse"),
                "error": job.get("error"),
                "total_videos": job.get("total_videos") or 0,
                "current_video_index": job.get("current_video_index") or 0,
            }

    def is_running(self) -> bool:
        with self._lock:
            if not self._active_id:
                return False
            job = self._jobs.get(self._active_id)
            return bool(job and job["state"] == "running")

    def _run(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            paths: list[str] = list(job["paths"])
            browse_path: str = job["browse_path"]
            media_filter: str = job.get("media_filter") or "all"
            weights = Path(job["weights"])
            blur_ratio = job["blur_ratio"]
            conf = job["conf"]
            class_ids = job["class_ids"]
            total_videos = len(paths)

        root = self._output_root()
        processed: list[dict] = []
        errors: list[dict] = []

        try:
            for video_index, relpath in enumerate(paths):
                label = Path(relpath).name
                with self._lock:
                    job = self._jobs[job_id]
                    job["current_video_index"] = video_index + 1
                    job["message"] = "비식별화 처리 중…"
                    job["step"] = f"{video_index + 1}/{total_videos} · {label}"
                    job["detail"] = "영상 준비 중…"
                    job["indeterminate"] = True
                    job["progress"] = None

                def on_progress(event: dict[str, Any], *, _video_index: int = video_index) -> None:
                    phase = event.get("phase") or "processing"
                    with self._lock:
                        current = self._jobs[job_id]
                        if phase == "encoding":
                            current["detail"] = "H.264 인코딩 중…"
                            current["indeterminate"] = True
                            current["progress"] = None
                            return

                        frame = int(event.get("frame") or 0)
                        total_frames = event.get("total_frames")
                        if total_frames and int(total_frames) > 0:
                            within = min(1.0, frame / int(total_frames))
                            percent = int((( _video_index + within) / total_videos) * 100)
                            current["detail"] = f"프레임 {frame}/{int(total_frames)}"
                            current["progress"] = {
                                "value": frame,
                                "max": int(total_frames),
                                "percent": percent,
                                "overall_percent": percent,
                            }
                            current["indeterminate"] = False
                        else:
                            current["detail"] = f"프레임 {frame} 처리 중…"
                            current["indeterminate"] = True
                            current["progress"] = None

                try:
                    source = self._resolve_source(relpath)
                    result = anonymize_video(
                        source,
                        weights=weights,
                        blur_ratio=blur_ratio,
                        conf=conf,
                        class_ids=class_ids,
                        save_txt=False,
                        on_progress=on_progress,
                    )
                    dest_path = Path(result["dest"]).resolve()
                    processed.append(
                        {
                            "source": relpath,
                            "dest": dest_path.relative_to(root).as_posix(),
                            "frame_count": result["frame_count"],
                            "blurred_boxes": result["blurred_boxes"],
                        }
                    )
                except (FileNotFoundError, ValueError, RuntimeError, TypeError) as exc:
                    errors.append({"source": relpath, "error": str(exc)})
                except Exception as exc:
                    errors.append(
                        {
                            "source": relpath,
                            "error": str(exc) or "비식별화 처리 중 오류가 발생했습니다.",
                        }
                    )

            browse = self._browse_outputs(browse_path, media_filter)
            with self._lock:
                job = self._jobs[job_id]
                job["processed"] = processed
                job["errors"] = errors
                job["browse"] = browse
                if errors and not processed:
                    job["state"] = "error"
                    job["message"] = "비식별화 실패"
                    job["error"] = errors[0]["error"] if len(errors) == 1 else f"{len(errors)}개 영상 처리 실패"
                    job["indeterminate"] = False
                    job["progress"] = None
                else:
                    job["state"] = "done"
                    job["message"] = "비식별화 완료"
                    job["step"] = f"{len(processed)}/{total_videos}개 완료"
                    job["detail"] = ""
                    job["indeterminate"] = False
                    job["progress"] = {"value": 1, "max": 1, "percent": 100, "overall_percent": 100}
        except Exception as exc:
            with self._lock:
                job = self._jobs[job_id]
                job["state"] = "error"
                job["message"] = "비식별화 실패"
                job["error"] = str(exc)
                job["indeterminate"] = False
                job["progress"] = None
