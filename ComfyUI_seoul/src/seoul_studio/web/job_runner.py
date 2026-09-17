import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from seoul_studio.comfy_client import GenerationResult
from seoul_studio.config import AppConfig
from seoul_studio.form import FormState, form_to_payload
from seoul_studio.job import JobRequest, JobValidationError, parse_job


GenerateFn = Callable[..., GenerationResult]


class JobBusyError(RuntimeError):
    pass


class JobRunner:
    def __init__(self, generate_fn: GenerateFn, get_config: Callable[[], AppConfig]) -> None:
        self._generate_fn = generate_fn
        self._get_config = get_config
        self._lock = threading.Lock()
        self._jobs: dict[str, dict[str, Any]] = {}
        self._active_id: Optional[str] = None

    def submit(
        self,
        mode: str,
        prompt: str,
        resolution: str,
        duration_sec: str,
        seed_text: str,
        image_path: str = "",
        negative_prompt: str = "",
        random_seed: bool = True,
        aspect_ratio: str = "",
        output_name: str = "",
    ) -> dict[str, Any]:
        payload = form_to_payload(
            FormState(
                mode=mode,
                prompt=prompt,
                resolution=resolution,
                duration_sec=duration_sec,
                seed_text=seed_text,
                image_path=image_path,
                negative_prompt=negative_prompt,
                aspect_ratio=aspect_ratio,
                random_seed=random_seed,
                output_name=output_name,
            )
        )
        parse_job(payload)
        with self._lock:
            if self._active_id and self._jobs[self._active_id]["state"] == "running":
                raise JobBusyError("이미 생성이 진행 중입니다.")
            job_id = str(uuid.uuid4())
            record = {
                "id": job_id,
                "state": "running",
                "message": "생성을 시작합니다…",
                "logs": ["생성을 시작합니다…"],
                "progress": None,
                "stage": None,
                "indeterminate": True,
                "output_path": None,
                "error": None,
                "payload": payload,
            }
            self._jobs[job_id] = record
            self._active_id = job_id
        thread = threading.Thread(target=self._run, args=(job_id,), daemon=True)
        thread.start()
        return {"id": job_id, "state": "running", "seed": payload["seed"]}

    def get(self, job_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return {
                "id": job["id"],
                "state": job["state"],
                "message": job["message"],
                "logs": list(job.get("logs") or []),
                "progress": job.get("progress"),
                "stage": job.get("stage"),
                "indeterminate": bool(job.get("indeterminate", False)),
                "output_path": job["output_path"],
                "error": job["error"],
                "seed": job["payload"]["seed"],
            }

    def _run(self, job_id: str) -> None:
        with self._lock:
            payload = dict(self._jobs[job_id]["payload"])
        try:
            job_req: JobRequest = parse_job(payload)
            config = self._get_config()

            def on_progress(message: str) -> None:
                with self._lock:
                    self._jobs[job_id]["message"] = message

            def on_log(message: str) -> None:
                with self._lock:
                    logs = self._jobs[job_id]["logs"]
                    if _should_replace_last_log(logs, message):
                        logs[-1] = message
                    elif not logs or logs[-1] != message:
                        logs.append(message)
                    if len(logs) > 300:
                        del logs[:-300]
                    self._jobs[job_id]["message"] = message

            def on_event(event: dict[str, Any]) -> None:
                with self._lock:
                    job = self._jobs[job_id]
                    message = event.get("message")
                    if message:
                        job["message"] = message
                    progress = event.get("progress")
                    if progress:
                        job["progress"] = progress
                        job["indeterminate"] = False
                    elif "indeterminate" in event:
                        job["indeterminate"] = bool(event["indeterminate"])
                        if event["indeterminate"]:
                            job["progress"] = None
                    stage = event.get("stage")
                    if stage is not None:
                        job["stage"] = stage

            result = self._generate_fn(
                config,
                job_req,
                on_progress=on_progress,
                on_log=on_log,
                on_event=on_event,
            )
            with self._lock:
                self._jobs[job_id]["state"] = "done"
                self._jobs[job_id]["message"] = "완료"
                self._jobs[job_id]["progress"] = {"value": 1, "max": 1, "percent": 100}
                self._jobs[job_id]["indeterminate"] = False
                self._jobs[job_id]["output_path"] = result.output_path
        except Exception as exc:
            with self._lock:
                self._jobs[job_id]["state"] = "error"
                self._jobs[job_id]["message"] = "실패"
                self._jobs[job_id]["error"] = str(exc)

    def save_upload(self, filename: str, data: bytes) -> str:
        config = self._get_config()
        upload_dir = Path(config.output_dir) / "uploads"
        upload_dir.mkdir(parents=True, exist_ok=True)
        safe_name = Path(filename).name or "upload.png"
        dest = upload_dir / f"{uuid.uuid4().hex}_{safe_name}"
        dest.write_bytes(data)
        return str(dest)


def _should_replace_last_log(logs: list[str], message: str) -> bool:
    if not logs:
        return False
    last = logs[-1]
    if message and message[0].isdigit() and "%" in message:
        return last and last[0].isdigit() and "%" in last
    if message.startswith("실행 중:"):
        return last.startswith("실행 중:")
    if message.startswith("대기열 "):
        return last.startswith("대기열 ")
    return False
