import json
import mimetypes
import os
import re
import shutil
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import websocket

from seoul_studio.job import JobRequest
from seoul_studio.workflow import apply_job_to_workflow, load_workflow_bundle

VIDEO_SUFFIXES = {".mp4", ".webm", ".mov", ".gif"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
_MEDIA_BASENAME_RE = re.compile(r"^(.+?)_(\d+)(?:-audio)?\.\w+$", re.IGNORECASE)


class ExecutionProgressTracker:
    """ComfyUI 노드 실행 순서와 단계별 진행률을 추적합니다."""

    def __init__(self, prompt_graph: dict[str, Any]) -> None:
        self._titles: dict[str, str] = {}
        for node_id, node in prompt_graph.items():
            if not isinstance(node, dict):
                continue
            meta = node.get("_meta") or {}
            title = str(meta.get("title") or node.get("class_type") or node_id)
            self._titles[str(node_id)] = title
        self._total = len(self._titles)
        self._order: list[str] = []
        self._current: Optional[str] = None
        self._value = 0
        self._max = 1

    def handle_executing(self, node: Optional[str]) -> dict[str, Any]:
        if node:
            node = str(node)
            if node not in self._order:
                self._order.append(node)
            self._current = node
            self._value = 0
            self._max = 1
            return self._event(
                message="영상 생성 중…",
                indeterminate=True,
            )
        self._current = None
        return self._event(message="마무리 중…", indeterminate=True)

    def handle_progress(
        self,
        value: int,
        max_val: int,
        node: Optional[str] = None,
    ) -> dict[str, Any]:
        if node:
            node = str(node)
            if node not in self._order:
                self._order.append(node)
            self._current = node
        self._value = value
        self._max = max(max_val, 1)
        step_pct = min(100, int(value * 100 / self._max))
        overall = self._overall_percent()
        return self._event(
            message="영상 생성 중…",
            progress={
                "value": value,
                "max": self._max,
                "percent": step_pct,
                "overall_percent": overall,
            },
            indeterminate=False,
        )

    def _step_index(self) -> int:
        if self._current and self._current in self._order:
            return self._order.index(self._current) + 1
        return max(1, len(self._order))

    def _overall_percent(self) -> int:
        if self._total <= 0:
            return 0
        completed = self._step_index() - 1
        step_frac = self._value / self._max
        return min(99, int((completed + step_frac) / self._total * 100))

    def _stage_payload(self) -> Optional[dict[str, Any]]:
        return None

    def _event(
        self,
        message: str,
        *,
        progress: Optional[dict[str, Any]] = None,
        indeterminate: bool,
    ) -> dict[str, Any]:
        return {
            "message": message,
            "progress": progress,
            "stage": self._stage_payload(),
            "indeterminate": indeterminate,
        }


class ComfyConnectionError(RuntimeError):
    pass


class ComfyJobError(RuntimeError):
    pass


@dataclass
class GenerationResult:
    prompt_id: str
    output_path: str
    filename: str


class ComfyClient:
    def __init__(
        self,
        base_url: str,
        timeout: float = 30.0,
        poll_interval: float = 0.2,
        max_wait: float = 3600.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.poll_interval = poll_interval
        self.max_wait = max_wait
        self.client_id = str(uuid.uuid4())

    def ping(self) -> dict[str, Any]:
        return self._get_json("/system_stats")

    def run_job(
        self,
        job: JobRequest,
        output_dir: str,
        on_progress: Optional[Callable[[str], None]] = None,
        on_log: Optional[Callable[[str], None]] = None,
        on_event: Optional[Callable[[dict[str, Any]], None]] = None,
    ) -> GenerationResult:
        try:
            return self._run_job(job, output_dir, on_progress, on_log, on_event)
        except (URLError, TimeoutError, ConnectionError, OSError) as exc:
            raise ComfyConnectionError(
                "생성 서버에 연결할 수 없습니다. IP와 방화벽을 확인하세요."
            ) from exc

    def _run_job(
        self,
        job: JobRequest,
        output_dir: str,
        on_progress: Optional[Callable[[str], None]],
        on_log: Optional[Callable[[str], None]],
        on_event: Optional[Callable[[dict[str, Any]], None]],
    ) -> GenerationResult:
        def emit(line: str, *, log: bool = True) -> None:
            self._notify(on_progress, line)
            if log:
                self._notify(on_log, line)
            self._notify_event(
                on_event,
                {"message": line, "progress": None, "indeterminate": True},
            )

        stop_ws = threading.Event()
        tracker_holder: list[Optional[ExecutionProgressTracker]] = [None]
        ws_thread = threading.Thread(
            target=self._watch_comfy_ws,
            args=(on_event, stop_ws, tracker_holder),
            daemon=True,
        )
        ws_thread.start()
        try:
            bundle = load_workflow_bundle(job.mode)
            uploaded_name = None
            if job.mode == "i2v" and job.image_path:
                emit("이미지 업로드 중")
                uploaded_name = self.upload_image(job.image_path)
            prompt_graph = apply_job_to_workflow(
                bundle.prompt,
                bundle.mapping,
                job,
                uploaded_image_name=uploaded_name,
            )
            tracker_holder[0] = ExecutionProgressTracker(prompt_graph)
            emit("생성 요청 전송")
            prompt_id = self.submit_prompt(prompt_graph)
            emit("생성 진행 중", log=False)
            outputs = self.wait_for_outputs(prompt_id, emit)
            output_ready_at = time.time()
            emit("결과 저장 중")
            dest = Path(output_dir).resolve()
            dest.mkdir(parents=True, exist_ok=True)
            output_root = _find_output_root(dest)
            file_info = resolve_best_video_output(
                outputs, output_root, dest, min_mtime=output_ready_at
            )
            local_path = persist_output_video(
                file_info,
                dest=dest,
                output_root=output_root,
                download=self.download_view,
            )
            _cleanup_duplicate_media(dest, local_path)
            _sync_preview_png_number(output_root, local_path)
            _cleanup_comfy_root_copies(output_root, local_path)
            local_path = apply_custom_output_name(local_path, job.output_name)
            emit("완료")
            self._notify_event(
                on_event,
                {
                    "message": "완료",
                    "progress": {"value": 1, "max": 1, "percent": 100},
                    "indeterminate": False,
                },
            )
            return GenerationResult(
                prompt_id=prompt_id,
                output_path=str(local_path),
                filename=local_path.name,
            )
        finally:
            stop_ws.set()
            ws_thread.join(timeout=2)

    def _watch_comfy_ws(
        self,
        on_event: Optional[Callable[[dict[str, Any]], None]],
        stop_event: threading.Event,
        tracker_holder: list[Optional[ExecutionProgressTracker]],
    ) -> None:
        ws_url = (
            self.base_url.replace("http://", "ws://").replace("https://", "wss://")
            + f"/ws?clientId={self.client_id}"
        )
        ws: Optional[websocket.WebSocket] = None
        try:
            ws = websocket.create_connection(ws_url, timeout=10)
            ws.settimeout(1.0)
            while not stop_event.is_set():
                try:
                    message = ws.recv()
                except websocket.WebSocketTimeoutException:
                    continue
                except websocket.WebSocketConnectionClosedException:
                    break
                if not isinstance(message, str):
                    continue
                try:
                    payload = json.loads(message)
                except json.JSONDecodeError:
                    continue
                event = _parse_ws_event(payload, tracker_holder[0] if tracker_holder else None)
                if event:
                    self._notify_event(on_event, event)
        except Exception:
            pass
        finally:
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass

    def upload_image(self, image_path: str) -> str:
        path = Path(image_path)
        body, content_type = encode_multipart_file("image", path)
        payload = self._request_json(
            "POST",
            "/upload/image",
            data=body,
            headers={"Content-Type": content_type},
        )
        name = payload.get("name")
        if not name:
            raise ComfyJobError("이미지 업로드에 실패했습니다.")
        return str(name)

    def submit_prompt(self, prompt_graph: dict[str, Any]) -> str:
        payload = self._request_json(
            "POST",
            "/prompt",
            data=json.dumps(
                {"prompt": prompt_graph, "client_id": self.client_id}
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        prompt_id = payload.get("prompt_id")
        if not prompt_id:
            raise ComfyJobError("생성 요청이 거부되었습니다.")
        return str(prompt_id)

    def wait_for_outputs(
        self,
        prompt_id: str,
        on_progress: Optional[Callable[[str], None]] = None,
    ) -> dict[str, Any]:
        deadline = time.time() + self.max_wait
        while time.time() < deadline:
            history = self._get_json(f"/history/{prompt_id}")
            entry = history.get(prompt_id)
            if entry:
                status = entry.get("status") or {}
                if status.get("status_str") == "error" or _history_failed(status):
                    raise ComfyJobError("서버에서 생성이 실패했습니다. 로그를 확인하세요.")
                if status.get("completed") or entry.get("outputs"):
                    outputs = entry.get("outputs") or {}
                    if outputs:
                        return outputs
            time.sleep(self.poll_interval)
        raise ComfyJobError("생성 대기 시간이 초과되었습니다.")

    def download_view(self, file_info: dict[str, str]) -> bytes:
        query = urlencode(
            {
                "filename": file_info["filename"],
                "subfolder": file_info.get("subfolder", ""),
                "type": file_info.get("type", "output"),
            }
        )
        return self._request_bytes("GET", f"/view?{query}")

    def _get_json(self, path: str) -> dict[str, Any]:
        return self._request_json("GET", path)

    def _request_json(
        self,
        method: str,
        path: str,
        data: Optional[bytes] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> dict[str, Any]:
        raw = self._request_bytes(method, path, data=data, headers=headers)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _request_bytes(
        self,
        method: str,
        path: str,
        data: Optional[bytes] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> bytes:
        request = Request(self.base_url + path, data=data, method=method)
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                return response.read()
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace").strip()
            if detail:
                raise ComfyJobError(f"서버 오류({exc.code}): {detail}") from exc
            raise ComfyJobError(f"서버 오류({exc.code})가 발생했습니다.") from exc

    def _notify(self, on_progress: Optional[Callable[[str], None]], message: str) -> None:
        if on_progress:
            on_progress(message)

    def _notify_event(
        self,
        on_event: Optional[Callable[[dict[str, Any]], None]],
        event: dict[str, Any],
    ) -> None:
        if on_event:
            on_event(event)


def _parse_ws_event(
    payload: dict[str, Any],
    tracker: Optional[ExecutionProgressTracker] = None,
) -> Optional[dict[str, Any]]:
    msg_type = payload.get("type")
    data = payload.get("data") or {}
    if msg_type == "progress":
        value = int(data.get("value") or 0)
        max_val = max(int(data.get("max") or 1), 1)
        node = data.get("node")
        if tracker:
            return tracker.handle_progress(value, max_val, str(node) if node else None)
        pct = min(100, int(value * 100 / max_val))
        return {
            "message": "영상 생성 중…",
            "progress": {"value": value, "max": max_val, "percent": pct},
            "indeterminate": False,
        }
    if msg_type == "executing":
        node = data.get("node")
        if tracker:
            return tracker.handle_executing(str(node) if node else None)
        if node:
            return {
                "message": "처리 중…",
                "progress": None,
                "indeterminate": True,
            }
        return {
            "message": "마무리 중…",
            "progress": None,
            "indeterminate": True,
        }
    if msg_type == "execution_cached":
        nodes = data.get("nodes") or []
        count = len(nodes)
        return {"message": "영상 생성 중…", "progress": None, "indeterminate": True}
    if msg_type == "status":
        exec_info = (data.get("status") or {}).get("exec_info") or {}
        remaining = exec_info.get("queue_remaining")
        if remaining is not None:
            if remaining:
                return {
                    "message": "대기 중…",
                    "progress": None,
                    "indeterminate": True,
                }
            return {
                "message": "영상 생성 중…",
                "progress": None,
                "indeterminate": True,
            }
    if msg_type == "execution_error":
        return {"message": "실행 오류", "progress": None, "indeterminate": True}
    return None


def extract_media_files(outputs: dict[str, Any]) -> list[dict[str, str]]:
    files: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for node_output in outputs.values():
        if not isinstance(node_output, dict):
            continue
        for key in ("gifs", "videos", "images", "files"):
            items = node_output.get(key)
            if not items:
                continue
            for item in items:
                if not isinstance(item, dict) or not item.get("filename"):
                    continue
                entry = {
                    "filename": str(item["filename"]),
                    "subfolder": str(item.get("subfolder", "")),
                    "type": str(item.get("type", "output")),
                }
                marker = (entry["filename"], entry["subfolder"], entry["type"])
                if marker in seen:
                    continue
                seen.add(marker)
                files.append(entry)
    return files


def extract_media_file(outputs: dict[str, Any]) -> dict[str, str]:
    files = extract_media_files(outputs)
    if not files:
        raise ComfyJobError("결과 파일을 찾지 못했습니다.")
    return _pick_preferred_media_file(files)


MAX_OUTPUT_SEQUENCE_DRIFT = 5


def resolve_best_video_output(
    outputs: dict[str, Any],
    output_root: Path,
    dest: Path,
    *,
    min_mtime: Optional[float] = None,
) -> dict[str, str]:
    file_info = extract_media_file(outputs)
    parsed = parse_media_basename(file_info["filename"])
    if not parsed:
        return file_info

    prefix, api_seq, _width = parsed
    # ComfyUI는 보통 output 루트에 직접 씁니다. dest(저장 폴더)의 예전 파일은 제외합니다.
    # 이 ComfyUI 서버는 이 앱 전용이 아니라 다른 워크플로/도구와 공유될 수 있으므로,
    # 폴더 스캔으로 "더 큰 번호"를 찾는 이 안전장치가 엉뚱한 영상을 고르지 않도록
    # (1) min_mtime: 이번 작업 결과가 나온 시점 이후에 생긴 파일만, (2) 번호 차이가
    # MAX_OUTPUT_SEQUENCE_DRIFT 이내인 파일만 후보로 인정한다.
    on_disk = find_newest_video_file(output_root, prefix=prefix, min_mtime=min_mtime)
    if on_disk is None:
        return file_info

    disk_parsed = parse_media_basename(on_disk.name)
    if (
        disk_parsed
        and api_seq < disk_parsed[1] <= api_seq + MAX_OUTPUT_SEQUENCE_DRIFT
    ):
        return file_info_from_disk_path(on_disk, output_root)
    return file_info


def file_info_from_disk_path(path: Path, output_root: Path) -> dict[str, str]:
    subfolder = ""
    try:
        relative = path.parent.resolve().relative_to(output_root.resolve())
        if str(relative) != ".":
            subfolder = relative.as_posix()
    except ValueError:
        pass
    return {
        "filename": path.name,
        "subfolder": subfolder,
        "type": "output",
    }


def persist_output_video(
    file_info: dict[str, str],
    *,
    dest: Path,
    output_root: Path,
    download: Callable[[dict[str, str]], bytes],
) -> Path:
    filename = Path(file_info["filename"]).name
    local_path = (dest / filename).resolve()
    if local_path.is_file():
        return local_path

    candidates: list[Path] = []
    root_path = (output_root / filename).resolve()
    if root_path.is_file():
        candidates.append(root_path)

    subfolder = str(file_info.get("subfolder") or "").strip().strip("/")
    if subfolder:
        sub_path = (output_root / subfolder / filename).resolve()
        if sub_path.is_file():
            candidates.append(sub_path)

    if candidates:
        source = max(candidates, key=lambda path: path.stat().st_mtime)
        if source != local_path:
            local_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, local_path)
        return local_path

    data = download(file_info)
    local_path.parent.mkdir(parents=True, exist_ok=True)
    local_path.write_bytes(data)
    return local_path


def parse_media_basename(filename: str) -> Optional[tuple[str, int, int]]:
    match = _MEDIA_BASENAME_RE.match(Path(filename).name)
    if not match:
        return None
    return match.group(1), int(match.group(2)), len(match.group(2))


def find_newest_video_file(
    *directories: Path, prefix: str, min_mtime: Optional[float] = None
) -> Optional[Path]:
    found: list[Path] = []
    for directory in directories:
        if not directory.is_dir():
            continue
        for path in directory.iterdir():
            if not path.is_file() or path.suffix.lower() not in VIDEO_SUFFIXES:
                continue
            parsed = parse_media_basename(path.name)
            if not parsed or parsed[0] != prefix:
                continue
            if min_mtime is not None and path.stat().st_mtime < min_mtime:
                continue
            found.append(path)
    if not found:
        return None
    return max(found, key=lambda path: (parse_media_basename(path.name) or ("", -1, 0))[1])


def _pick_preferred_media_file(files: list[dict[str, str]]) -> dict[str, str]:
    if not files:
        raise ComfyJobError("결과 파일을 찾지 못했습니다.")

    def rank(item: dict[str, str]) -> tuple[int, int]:
        name = item["filename"].lower()
        parsed = parse_media_basename(item["filename"])
        seq = parsed[1] if parsed else -1
        if "-audio." in name:
            return 3, seq
        if any(name.endswith(ext) for ext in VIDEO_SUFFIXES):
            return 2, seq
        if any(name.endswith(ext) for ext in IMAGE_SUFFIXES):
            return 1, seq
        return 0, seq

    best = max(files, key=rank)
    if rank(best)[0] < 2:
        raise ComfyJobError("결과 영상을 찾지 못했습니다.")
    return best


def _sync_preview_png_number(output_root: Path, video_path: Path) -> None:
    """ComfyUI 프리뷰 PNG를 영상과 같은 번호·같은 저장 폴더로 맞춥니다."""
    parsed = parse_media_basename(video_path.name)
    if not parsed:
        return

    prefix, number, width = parsed
    save_dir = video_path.parent
    target = save_dir / f"{prefix}_{number:0{width}d}.png"

    search_dirs: list[Path] = [output_root]
    if save_dir.resolve() != output_root.resolve():
        search_dirs.append(save_dir)

    candidates: list[Path] = []
    seen: set[Path] = set()
    for directory in search_dirs:
        for path in directory.glob(f"{prefix}_*.png"):
            if not path.is_file():
                continue
            resolved = path.resolve()
            if resolved in seen or resolved == target.resolve():
                continue
            seen.add(resolved)
            candidates.append(path)

    if not candidates:
        return

    source = max(candidates, key=lambda path: path.stat().st_mtime)
    source_parsed = parse_media_basename(source.name.replace(".png", ".mp4"))
    if source.resolve() == target.resolve():
        return
    if source_parsed and source_parsed[1] == number and source.parent.resolve() == save_dir.resolve():
        return

    if target.exists():
        try:
            target.unlink()
        except OSError:
            pass
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.parent.resolve() == target.parent.resolve():
            source.rename(target)
        else:
            shutil.move(str(source), str(target))
    except OSError:
        pass


def _find_output_root(dest: Path) -> Path:
    for parent in [dest, *dest.parents]:
        if parent.name == "output" or parent.as_posix().endswith("/data/output"):
            return parent
    env_root = os.environ.get("SEOUL_STUDIO_OUTPUT_DIR", "").strip()
    if env_root:
        return Path(env_root).resolve()
    return dest


def _cleanup_comfy_root_copies(output_root: Path, kept_path: Path) -> None:
    """ComfyUI는 NFS 루트에 직접 저장하므로, 하위 폴더 저장 시 루트 사본을 제거."""
    kept_resolved = kept_path.resolve()
    root_resolved = output_root.resolve()
    if kept_resolved.parent == root_resolved:
        return
    names = {kept_path.name}
    if "-audio." in kept_path.name:
        names.add(kept_path.name.replace("-audio.", "."))
    for name in names:
        root_copy = root_resolved / name
        if root_copy.is_file() and root_copy.resolve() != kept_resolved:
            try:
                root_copy.unlink()
            except OSError:
                pass

    parsed = parse_media_basename(kept_path.name)
    if parsed:
        prefix, number, width = parsed
        root_png = root_resolved / f"{prefix}_{number:0{width}d}.png"
        if root_png.is_file() and root_png.resolve().parent != kept_resolved.parent:
            try:
                root_png.unlink()
            except OSError:
                pass


def _resolve_output_media_path(dest: Path, file_info: dict[str, str]) -> Path:
    subfolder = file_info.get("subfolder", "").strip().strip("/")
    filename = Path(file_info["filename"]).name
    target = dest / subfolder / filename if subfolder else dest / filename
    if target.is_file():
        return target
    prefixed = dest / f"i2v_{filename}"
    if prefixed.is_file():
        return prefixed
    return dest / filename


def _cleanup_duplicate_media(dest: Path, kept_path: Path) -> None:
    kept_name = kept_path.name
    candidates: list[Path] = []
    if "-audio." in kept_name:
        silent_name = kept_name.replace("-audio.", ".")
        candidates.append(kept_path.with_name(silent_name))
    prefix = f"i2v_{kept_name}"
    candidates.append(kept_path.with_name(prefix))
    if "-audio." in kept_name:
        candidates.append(kept_path.with_name(f"i2v_{kept_name.replace('-audio.', '.')}"))

    for path in candidates:
        if path == kept_path or not path.is_file():
            continue
        try:
            path.unlink()
        except OSError:
            pass


def apply_custom_output_name(local_path: Path, output_name: Optional[str]) -> Path:
    """사용자가 지정한 파일명으로 결과 영상(및 있으면 짝이 되는 프리뷰 png)을 바꾼다.
    같은 이름이 이미 있으면 뒤에 번호를 붙여 겹치지 않게 한다."""
    if not output_name:
        return local_path

    dest = local_path.parent
    suffix = local_path.suffix
    candidate = dest / f"{output_name}{suffix}"
    counter = 2
    while candidate.resolve() != local_path.resolve() and candidate.exists():
        candidate = dest / f"{output_name}_{counter}{suffix}"
        counter += 1

    if candidate.resolve() == local_path.resolve():
        return local_path

    try:
        local_path.rename(candidate)
    except OSError:
        return local_path

    parsed = parse_media_basename(local_path.name)
    if parsed:
        prefix, number, width = parsed
        preview_png = dest / f"{prefix}_{number:0{width}d}.png"
        if preview_png.is_file():
            try:
                preview_png.rename(candidate.with_suffix(".png"))
            except OSError:
                pass

    return candidate


def _history_failed(status: dict[str, Any]) -> bool:
    messages = status.get("messages") or []
    for item in messages:
        if isinstance(item, (list, tuple)) and item and item[0] == "execution_error":
            return True
    return False


def encode_multipart_file(field_name: str, path: Path) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    filename = path.name
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    header = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode("utf-8")
    footer = f"\r\n--{boundary}--\r\n".encode("utf-8")
    body = header + path.read_bytes() + footer
    return body, f"multipart/form-data; boundary={boundary}"
