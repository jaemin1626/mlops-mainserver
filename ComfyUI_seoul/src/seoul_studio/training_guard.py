"""ClearML 학습 진행 여부 확인 — GPU 사용 중 생성 차단."""

from __future__ import annotations

import base64
import json
import logging
import os
import time
import urllib.error
import urllib.request
from typing import Any

log = logging.getLogger(__name__)

TRAINING_BLOCK_MESSAGE = (
    "GPU가 학습에 활용 중이므로, 학습이 완료된 후에 생성을 해주시길 바랍니다."
)

_CACHE_TTL_SEC = 15.0
_cache: dict[str, Any] = {"at": 0.0, "active": False, "tasks": []}


def _api_host() -> str:
    return (
        os.environ.get("CLEARML_API_HOST")
        or os.environ.get("CLEARML_API_URL")
        or "http://apiserver:8008"
    ).rstrip("/")


def _credentials() -> tuple[str, str] | None:
    access = (
        os.environ.get("CLEARML_API_ACCESS_KEY")
        or os.environ.get("CLEARML_ACCESS_KEY")
        or ""
    ).strip()
    secret = (
        os.environ.get("CLEARML_API_SECRET_KEY")
        or os.environ.get("CLEARML_SECRET_KEY")
        or ""
    ).strip()
    if access and secret:
        return access, secret
    return None


class _ClearMLClient:
    def __init__(self) -> None:
        self.host = _api_host()
        self._token = ""
        creds = _credentials()
        if creds:
            self._login(*creds)

    def _login(self, access_key: str, secret_key: str) -> None:
        url = f"{self.host}/auth.login"
        token = base64.b64encode(f"{access_key}:{secret_key}".encode()).decode("ascii")
        req = urllib.request.Request(url, headers={"Authorization": f"Basic {token}"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                self._token = body.get("data", {}).get("token", "")
        except Exception as exc:
            log.warning("ClearML auth failed: %s", exc)

    def _post(self, endpoint: str, payload: dict) -> dict:
        url = f"{self.host}/{endpoint.lstrip('/')}"
        headers = {"Content-Type": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                return body.get("data", {})
        except urllib.error.HTTPError as exc:
            log.warning("ClearML API HTTP error [%s]: %s", endpoint, exc)
            return {}
        except Exception as exc:
            log.warning("ClearML API error [%s]: %s", endpoint, exc)
            return {}

    def get_running_tasks(self) -> list[dict]:
        payload = {
            "page": 0,
            "page_size": 50,
            "status": ["in_progress"],
            "type": ["training", "controller"],
            "only_fields": ["id", "name", "project", "status", "started"],
        }
        data = self._post("tasks.get_all_ex", payload)
        return data.get("tasks", [])


def is_training_active(*, force_refresh: bool = False) -> tuple[bool, list[dict]]:
    """Return (active, running_tasks). API 오류·미설정 시 생성 허용."""
    now = time.monotonic()
    if not force_refresh and now - _cache["at"] < _CACHE_TTL_SEC:
        return bool(_cache["active"]), list(_cache["tasks"])

    if not _credentials():
        log.debug("ClearML credentials not configured — skipping training guard")
        _cache.update(at=now, active=False, tasks=[])
        return False, []

    client = _ClearMLClient()
    tasks = client.get_running_tasks()
    active = len(tasks) > 0
    _cache.update(at=now, active=active, tasks=tasks)
    return active, tasks
