#!/usr/bin/env python3
"""
ClearML Prometheus Exporter
모델별 학습 주기·시간·빈도, 데이터셋 구축 현황 등을 Prometheus 메트릭으로 노출
"""

import os
import time
import logging
import requests
import hashlib
from datetime import datetime, timezone, timedelta
from collections import defaultdict
from prometheus_client import start_http_server, Gauge, Info, REGISTRY, PROCESS_COLLECTOR, PLATFORM_COLLECTOR

# 기본 콜렉터 제거 (순수 ClearML 메트릭만 노출)
REGISTRY.unregister(PROCESS_COLLECTOR)
REGISTRY.unregister(PLATFORM_COLLECTOR)
try:
    from prometheus_client import GC_COLLECTOR
    REGISTRY.unregister(GC_COLLECTOR)
except Exception:
    pass

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger("clearml-exporter")

# ──────────────────────────────────────────────
# 환경 변수 설정
# ──────────────────────────────────────────────
CLEARML_API_HOST    = os.getenv("CLEARML_API_HOST", "http://apiserver:8008")
CLEARML_ACCESS_KEY  = os.getenv("CLEARML_ACCESS_KEY", "")
CLEARML_SECRET_KEY  = os.getenv("CLEARML_SECRET_KEY", "")
SCRAPE_INTERVAL_SEC = int(os.getenv("SCRAPE_INTERVAL_SEC", "60"))
EXPORTER_PORT       = int(os.getenv("EXPORTER_PORT", "9090"))
# 학습 빈도 계산 기간 (일)
FREQUENCY_WINDOW_DAYS = int(os.getenv("FREQUENCY_WINDOW_DAYS", "30"))
# Grafana 대시보드 자동 링크 업데이트용
GRAFANA_URL         = os.getenv("GRAFANA_URL", "http://grafana:3000")
GRAFANA_USER        = os.getenv("GRAFANA_USER", "admin")
GRAFANA_PASSWORD    = os.getenv("GRAFANA_PASSWORD", "admin")
GRAFANA_DASH_UID    = os.getenv("GRAFANA_DASH_UID", "clearml-mlops-main")
# 태깅 툴 API 주소 (YOLOv7 Data Studio)
TAGGING_TOOL_URL    = os.getenv("TAGGING_TOOL_URL", "")
# GitLab
GITLAB_URL          = os.getenv("GITLAB_URL", "")
GITLAB_TOKEN        = os.getenv("GITLAB_TOKEN", "")
GITLAB_PROJECT_IDS  = os.getenv("GITLAB_PROJECT_IDS", "")  # 쉼표 구분 프로젝트 ID 목록
SERVER_HOST_ALIASES = os.getenv("SERVER_HOST_ALIASES", "")  # 예: host1=학습서버A,1bc44d31189f=DGX-A100


def _parse_alias_map(raw: str) -> dict:
    alias_map = {}
    for item in raw.split(","):
        entry = item.strip()
        if not entry or "=" not in entry:
            continue
        key, value = entry.split("=", 1)
        key = key.strip()
        value = value.strip()
        if key and value:
            alias_map[key] = value
    return alias_map


SERVER_HOST_ALIAS_MAP = _parse_alias_map(SERVER_HOST_ALIASES)


def _normalize_gpu_name(gpu_type: str) -> str:
    gpu_type = (gpu_type or "").strip()
    if not gpu_type:
        return ""
    first_gpu = gpu_type.split(",")[0].strip()
    if first_gpu.startswith("NVIDIA "):
        first_gpu = first_gpu[len("NVIDIA "):]
    return first_gpu


def resolve_server_host_display(hostname: str, runtime: dict | None = None) -> str:
    hostname = (hostname or "-").strip() or "-"
    if hostname in SERVER_HOST_ALIAS_MAP:
        return SERVER_HOST_ALIAS_MAP[hostname]

    runtime = runtime or {}
    gpu_name = _normalize_gpu_name(str(runtime.get("gpu_type") or ""))
    gpu_count = runtime.get("gpu_count")

    try:
        gpu_count = int(gpu_count)
    except Exception:
        gpu_count = 0

    if gpu_name and gpu_count > 0:
        return f"{gpu_name} {gpu_count}GPU 서버"
    if gpu_name:
        return f"{gpu_name} 서버"
    return hostname

# ── ClearML last_metrics 해시 키 (MD5(이름)) ──
_MD5 = lambda s: hashlib.md5(s.encode()).hexdigest()
SUMMARY_HASH   = _MD5("Summary")
MAP50_HASH     = _MD5("metrics/mAP50(B)")
MAP50_95_HASH  = _MD5("metrics/mAP50-95(B)")
PRECISION_HASH = _MD5("metrics/precision(B)")
RECALL_HASH    = _MD5("metrics/recall(B)")
# Classification 성능 지표 해시 (Performance (mA) / Valid mA)
PERF_MA_HASH   = _MD5("Performance (mA)")
VALID_MA_HASH  = _MD5("Valid mA")
# HuggingFace Transformers epoch 해시 (last_metrics 내 임의 섹션의 epoch 배리언트)
HF_TRAIN_HASH  = _MD5("Train")
HF_EPOCH_HASH  = _MD5("epoch")

# ──────────────────────────────────────────────
# Prometheus 메트릭 정의
# ──────────────────────────────────────────────

# ▶ 프로젝트
clearml_projects_total = Gauge(
    "clearml_projects_total",
    "ClearML 전체 프로젝트 수"
)

# ▶ 태스크(학습)
clearml_tasks_total = Gauge(
    "clearml_tasks_total",
    "ClearML 태스크 총 수",
    ["project", "status"]
)
clearml_task_last_run_timestamp = Gauge(
    "clearml_task_last_run_timestamp_seconds",
    "모델(태스크 이름)별 마지막 학습 완료 Unix timestamp",
    ["project", "task_name"]
)
clearml_task_last_run_duration_seconds = Gauge(
    "clearml_task_last_run_duration_seconds",
    "모델(태스크 이름)별 가장 최근 학습 소요 시간(초)",
    ["project", "task_name"]
)
clearml_task_avg_duration_seconds = Gauge(
    "clearml_task_avg_duration_seconds",
    "모델(태스크 이름)별 평균 학습 소요 시간(초)",
    ["project", "task_name"]
)
clearml_task_training_frequency = Gauge(
    "clearml_task_training_frequency_per_day",
    f"모델(태스크 이름)별 최근 {FREQUENCY_WINDOW_DAYS}일 학습 빈도 (회/일)",
    ["project", "task_name"]
)
clearml_task_training_count_window = Gauge(
    "clearml_task_training_count_in_window",
    f"모델(태스크 이름)별 최근 {FREQUENCY_WINDOW_DAYS}일 총 학습 횟수",
    ["project", "task_name"]
)
clearml_task_training_count_ytd = Gauge(
    "clearml_task_training_count_ytd",
    "모델(태스크 이름)별 올해(YTD) 누적 학습 횟수",
    ["project", "task_name"]
)
clearml_task_run_history_ytd_seconds = Gauge(
    "clearml_task_run_history_ytd_seconds",
    "올해(YTD) 완료된 개별 학습 실행 이력 (값=학습 소요 시간 초)",
    ["project", "model", "task_name", "task_id", "completed_ts_ms", "server_host", "worker"]
)
clearml_running_tasks_total = Gauge(
    "clearml_running_tasks_total",
    "현재 실행 중인 태스크 수",
    ["project"]
)

# ▶ 성능 지표 (Detection: mAP, Classification: precision/recall)
clearml_task_perf_map50 = Gauge(
    "clearml_task_perf_map50",
    "최근 학습의 mAP@50",
    ["project", "task_name"]
)
clearml_task_perf_map50_95 = Gauge(
    "clearml_task_perf_map50_95",
    "최근 학습의 mAP@50-95",
    ["project", "task_name"]
)
clearml_task_perf_precision = Gauge(
    "clearml_task_perf_precision",
    "최근 학습의 Precision",
    ["project", "task_name"]
)
clearml_task_perf_recall = Gauge(
    "clearml_task_perf_recall",
    "최근 학습의 Recall",
    ["project", "task_name"]
)
clearml_task_perf_f1 = Gauge(
    "clearml_task_perf_f1",
    "최근 학습의 F1-score (2*P*R/(P+R))",
    ["project", "task_name"]
)
clearml_task_perf_accuracy = Gauge(
    "clearml_task_perf_accuracy",
    "Classification 모델 버전별 학습 정확도 (Valid mA) — 이력 조회용",
    ["project", "task_name"]
)
clearml_task_perf_accuracy_latest = Gauge(
    "clearml_task_perf_accuracy_latest",
    "Classification 모델 최신 버전 정확도 (Valid mA) — 패널 기본 표시용",
    ["project", "version_count"]
)
clearml_task_perf_accuracy_history = Gauge(
    "clearml_task_perf_accuracy_history",
    "Classification 버전별 정확도 — unix_ts 레이블로 학습완료 잼 표현",
    ["model", "task_name", "unix_ts"]
)
clearml_task_perf_detection_history = Gauge(
    "clearml_task_perf_detection_history",
    "Detection 버전별 성능 — unix_ts 레이블로 학습완료 잼 표현",
    ["model", "task_name", "metric_type", "unix_ts"]
)

# ▶ 현재 학습 중인 태스크
clearml_active_task_epoch = Gauge(
    "clearml_active_task_epoch",
    "현재 학습 중인 태스크의 현재 epoch — 모델/버전/시작시각/전체epoch 레이블 포함",
    ["model", "version", "started_fmt", "started_ts", "total_epochs", "sec_per_epoch", "estimated_end_ms"]
)

# ▶ 데이터셋
clearml_datasets_total = Gauge(
    "clearml_datasets_total",
    "ClearML 데이터셋 총 수",
    ["project"]
)
clearml_dataset_versions_total = Gauge(
    "clearml_dataset_versions_total",
    "데이터셋별 총 버전 수",
    ["project", "dataset_name"]
)
clearml_dataset_last_updated_timestamp = Gauge(
    "clearml_dataset_last_updated_timestamp_seconds",
    "데이터셋 마지막 업데이트 Unix timestamp",
    ["project", "dataset_name"]
)
clearml_dataset_file_count = Gauge(
    "clearml_dataset_file_count",
    "데이터셋 최신 버전 파일 수",
    ["project", "dataset_name"]
)
clearml_dataset_size_bytes = Gauge(
    "clearml_dataset_size_bytes",
    "데이터셋 최신 버전 용량(bytes)",
    ["project", "dataset_name"]
)
clearml_dataset_status = Gauge(
    "clearml_dataset_status_info",
    "데이터셋 상태 (1=완료, 0=진행중/미완료)",
    ["project", "dataset_name", "status"]
)

# ▶ 모델
clearml_models_total = Gauge(
    "clearml_models_total",
    "등록된 모델 총 수",
    ["project"]
)
clearml_model_last_updated_timestamp = Gauge(
    "clearml_model_last_updated_timestamp_seconds",
    "모델별 마지막 등록/업데이트 Unix timestamp",
    ["project", "model_name"]
)

# ▶ 태깅 현황 (YOLOv7 Data Studio)
tagging_project_target = Gauge(
    "tagging_project_target_total",
    "태깅 프로젝트 목표 수량",
    ["project_id", "project_name", "status"]
)
tagging_project_allocated = Gauge(
    "tagging_project_allocated_total",
    "태깅 프로젝트 배분 수량",
    ["project_id", "project_name", "status"]
)
tagging_project_completed = Gauge(
    "tagging_project_completed_total",
    "태깅 프로젝트 완료 수량",
    ["project_id", "project_name", "status"]
)
tagging_project_progress = Gauge(
    "tagging_project_progress_pct",
    "태깅 프로젝트 진행률 (%)",
    ["project_id", "project_name", "status"]
)
tagging_project_start_ts = Gauge(
    "tagging_project_start_timestamp",
    "태깅 프로젝트 시작 타임스탬프 (ms)",
    ["project_id", "project_name", "status"]
)
tagging_project_end_ts = Gauge(
    "tagging_project_end_timestamp",
    "태깅 프로젝트 종료 타임스탬프 (ms)",
    ["project_id", "project_name", "status"]
)
tagging_project_info = Gauge(
    "tagging_project_info",
    "태깅 프로젝트 통합 정보 (날짜 포함)",
    ["project_id", "project_name", "status", "sort_key",
     "start_date", "end_date",
     "target_total", "allocated", "completed", "progress"]
)

# ▶ GitLab 커밋 현황
gitlab_commit_count = Gauge(
    "gitlab_commit_count",
    "GitLab 프로젝트별 커밋 수",
    ["project_id", "project_name", "namespace", "author_name", "period"]
)
gitlab_project_commit_total = Gauge(
    "gitlab_project_commit_total",
    "GitLab 프로젝트별 전체 커밋 수 (기간 내)",
    ["project_id", "project_name", "namespace", "period"]
)
gitlab_lines_added = Gauge(
    "gitlab_lines_added",
    "GitLab 작성자별 코드 추가 라인 수",
    ["project_id", "project_name", "namespace", "author_name", "period"]
)
gitlab_lines_deleted = Gauge(
    "gitlab_lines_deleted",
    "GitLab 작성자별 코드 삭제 라인 수",
    ["project_id", "project_name", "namespace", "author_name", "period"]
)
gitlab_tag_info = Gauge(
    "gitlab_tag_info",
    "GitLab 프로젝트 최신 태그 정보 (값=생성 Unix timestamp ms)",
    ["project_id", "project_name", "namespace", "tag_name", "created_by", "commit_title"]
)


# ──────────────────────────────────────────────
# ClearML REST API 클라이언트
# ──────────────────────────────────────────────

class ClearMLClient:
    def __init__(self, host: str, access_key: str = "", secret_key: str = ""):
        self.host = host.rstrip("/")
        self.session = requests.Session()
        self.token = None

        if access_key and secret_key:
            self._login(access_key, secret_key)

    def _login(self, access_key: str, secret_key: str):
        """API Key로 Bearer 토큰 발급"""
        try:
            resp = self.session.get(
                f"{self.host}/auth.login",
                auth=(access_key, secret_key),
                timeout=10
            )
            resp.raise_for_status()
            data = resp.json()
            self.token = data.get("data", {}).get("token", "")
            if self.token:
                self.session.headers.update({"Authorization": f"Bearer {self.token}"})
                log.info("ClearML API 인증 완료")
        except Exception as e:
            log.warning(f"ClearML API 인증 실패 (인증 없이 진행): {e}")

    def post(self, endpoint: str, payload: dict) -> dict:
        """ClearML REST API POST 호출"""
        url = f"{self.host}/{endpoint}"
        try:
            resp = self.session.post(url, json=payload, timeout=30)
            resp.raise_for_status()
            return resp.json().get("data", {})
        except Exception as e:
            log.error(f"API 호출 실패 [{endpoint}]: {e}")
            return {}

    def get(self, endpoint: str, params: dict = None) -> dict:
        url = f"{self.host}/{endpoint}"
        try:
            resp = self.session.get(url, params=params, timeout=30)
            resp.raise_for_status()
            return resp.json().get("data", {})
        except Exception as e:
            log.error(f"API 호출 실패 [{endpoint}]: {e}")
            return {}

    # ── 프로젝트 ──────────────────────────────
    def get_projects(self) -> list:
        data = self.post("projects.get_all_ex", {
            "only_fields": ["id", "name"],
            "page": 0,
            "page_size": 500
        })
        return data.get("projects", [])

    def get_project_name_by_id(self, project_id: str) -> str:
        """숨겨진 .datasets 하위 프로젝트 등 일반 조회에서 누락된 project ID를 직접 조회.
        ClearML Dataset은 '부모/.datasets/데이터셋명' 형태로 자동 생성되므로
        '/.datasets/' 이후를 제거하여 상위 프로젝트명을 반환."""
        data = self.post("projects.get_all_ex", {
            "id": [project_id],
            "only_fields": ["id", "name"]
        })
        projs = data.get("projects", [])
        if projs:
            name = projs[0].get("name", project_id)
            # "부모/.datasets/데이터셋명" → "부모"
            if "/.datasets/" in name:
                name = name.split("/.datasets/")[0]
            return name
        return project_id  # fallback: ID 그대로 반환

    # ── 태스크 ────────────────────────────────
    def get_tasks(self, project_ids: list = None, status: list = None,
                  only_fields: list = None, page_size: int = 500) -> list:
        payload = {"page": 0, "page_size": page_size}
        if project_ids:
            payload["project"] = project_ids
        if status:
            payload["status"] = status
        if only_fields:
            payload["only_fields"] = only_fields
        # 학습/파이프라인 태스크만 (데이터셋 제외)
        payload["type"] = ["training", "testing", "inference", "controller"]

        all_tasks = []
        while True:
            data = self.post("tasks.get_all_ex", payload)
            tasks = data.get("tasks", [])
            all_tasks.extend(tasks)
            if len(tasks) < page_size:
                break
            payload["page"] += 1
        return all_tasks

    def get_tasks_in_window(self, days: int, project_ids: list = None) -> list:
        """최근 N일 완료된 학습 태스크"""
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        payload = {
            "page": 0,
            "page_size": 1000,
            "status": ["completed"],
            "type": ["training", "testing", "inference", "controller"],
            "order_by": ["-completed"],
            "system_tags": ["-archived"]
        }
        if project_ids:
            payload["project"] = project_ids
        # completed 이후 필터는 scroll 방식으로
        all_tasks = []
        while True:
            data = self.post("tasks.get_all_ex", payload)
            tasks = data.get("tasks", [])
            if not tasks:
                break
            for t in tasks:
                completed = t.get("completed") or t.get("last_update", "")
                if completed and completed < cutoff:
                    return all_tasks  # 이미 정렬됐으므로 조회 중단
                all_tasks.append(t)
            if len(tasks) < 1000:
                break
            payload["page"] += 1
        return all_tasks

    # ── 데이터셋 ──────────────────────────────
    def get_datasets(self) -> list:
        """ClearML Dataset은 system_tag='dataset'인 데이터 처리 태스크"""
        payload = {
            "page": 0,
            "page_size": 500,
            "system_tags": ["dataset"],
            "only_fields": [
                "id", "name", "project", "status",
                "last_update", "runtime", "configuration"
            ]
        }
        all_ds = []
        while True:
            data = self.post("tasks.get_all_ex", payload)
            tasks = data.get("tasks", [])
            all_ds.extend(tasks)
            if len(tasks) < 500:
                break
            payload["page"] += 1
        return all_ds

    # ── 모델 ──────────────────────────────────
    def get_models(self, project_ids: list = None) -> list:
        payload = {
            "page": 0,
            "page_size": 500,
            "only_fields": ["id", "name", "project", "created", "last_update"]
        }
        if project_ids:
            payload["project"] = project_ids
        all_models = []
        while True:
            data = self.post("models.get_all_ex", payload)
            models = data.get("models", [])
            all_models.extend(models)
            if len(models) < 500:
                break
            payload["page"] += 1
        return all_models


# ──────────────────────────────────────────────
# 메트릭 수집 로직
# ──────────────────────────────────────────────

def collect_metrics(client: ClearMLClient):
    log.info("메트릭 수집 시작...")
    start = time.time()

    # ── 프로젝트 목록 ─────────────────────────
    projects = client.get_projects()
    project_id_to_name = {p["id"]: p.get("name", p["id"]) for p in projects}
    clearml_projects_total.set(len(projects))

    # 누락된 project ID를 직접 조회하는 캐싱 래퍼
    _project_cache: dict = {}
    def resolve_project(project_id: str) -> str:
        if not project_id:
            return "unknown"
        if project_id in project_id_to_name:
            return project_id_to_name[project_id]
        if project_id not in _project_cache:
            _project_cache[project_id] = client.get_project_name_by_id(project_id)
        return _project_cache[project_id]

    # ── 태스크 / 학습 메트릭 ──────────────────
    all_tasks = client.get_tasks(
        only_fields=["id", "name", "project", "status", "started", "completed",
                     "last_update", "execution", "hyperparams", "last_metrics"]
    )

    # (project_name, status) → count
    task_count_map = defaultdict(int)
    # (project_name, task_name) → list of (started, completed) tuples (for duration)
    duration_map   = defaultdict(list)
    # (project_name, task_name) → latest completed timestamp
    last_run_map   = defaultdict(float)
    # running tasks per project
    running_map    = defaultdict(int)

    for task in all_tasks:
        proj_name  = resolve_project(task.get("project", {}).get("id", ""))
        task_name  = task.get("name", "unknown")
        status     = task.get("status", "unknown")

        task_count_map[(proj_name, status)] += 1

        if status == "in_progress":
            running_map[proj_name] += 1

        # 학습 소요 시간 계산
        started   = task.get("started")
        completed = task.get("completed")
        if started and completed and status == "completed":
            try:
                ts   = _parse_ts(started)
                tc   = _parse_ts(completed)
                dur  = tc - ts
                if dur > 0:
                    duration_map[(proj_name, task_name)].append(dur)
                if tc > last_run_map[(proj_name, task_name)]:
                    last_run_map[(proj_name, task_name)] = tc
            except Exception:
                pass

    # Prometheus에 태스크 카운트 기록 (매 수집마다 초기화 후 재설정)
    clearml_tasks_total._metrics.clear()
    for (proj, status), count in task_count_map.items():
        clearml_tasks_total.labels(project=proj, status=status).set(count)

    # running 태스크 (매 수집마다 초기화 — 학습 완료 시 즉시 0 반영)
    clearml_running_tasks_total._metrics.clear()
    for proj, count in running_map.items():
        clearml_running_tasks_total.labels(project=proj).set(count)

    # ── 현재 학습 중인 태스크 상세 정보 ─────────
    clearml_active_task_epoch._metrics.clear()
    running_tasks_detail = client.get_tasks(
        status=["in_progress"],
        only_fields=["id", "name", "project", "started", "last_iteration", "hyperparams", "last_metrics"]
    )
    for task in running_tasks_detail:
        proj_id    = task.get("project", {}).get("id", "")
        proj_name  = resolve_project(proj_id)
        proj_short = proj_name.split("/")[-1]
        task_name  = task.get("name", "unknown")
        started    = task.get("started")
        last_iter  = task.get("last_iteration") or 0
        hp = task.get("hyperparams", {}) or {}
        total_epochs = 0
        # 프레임워크별 epoch 파라미터 이름 순서대로 탐색
        _EPOCH_KEYS = ["epochs", "num_train_epochs", "n_epochs", "max_epochs", "num_epochs", "EPOCHS"]
        for section, params in hp.items():
            for _ekey in _EPOCH_KEYS:
                ep = params.get(_ekey, {}) or {}
                if ep.get("value"):
                    try:
                        val = int(float(ep["value"]))
                        if val > 0:
                            total_epochs = val
                            break
                    except Exception:
                        pass
            if total_epochs > 0:
                break
        started_ts_sec = _parse_ts(started) if started else 0.0
        started_fmt = (
            datetime.fromtimestamp(started_ts_sec, tz=timezone.utc)
            .astimezone().strftime("%Y-%m-%d %H:%M")
            if started_ts_sec else "-"
        )
        now_sec = time.time()
        elapsed_sec = max(now_sec - started_ts_sec, 0) if started_ts_sec else 0

        # ── iteration 기반 태스크(LLM 등) 판별 ──────────────────────────────
        # YOLO/CV: last_iteration ≈ 현재 epoch (수십~수백)
        # LLM(HF): last_iteration = global step (수만), total_epochs는 작음
        is_iter_based = (total_epochs > 0 and last_iter > total_epochs * 10)
        if is_iter_based:
            # last_metrics에서 어느 섹션이든 'epoch' variant 값 스캔 (HuggingFace 등)
            lm = task.get("last_metrics", {}) or {}
            hf_epoch_val = None
            for section_data in lm.values():
                if isinstance(section_data, dict):
                    epoch_entry = section_data.get(HF_EPOCH_HASH)
                    if epoch_entry and epoch_entry.get("value") is not None:
                        v = epoch_entry["value"]
                        if v and float(v) > 0:
                            hf_epoch_val = float(v)
                            break
            if hf_epoch_val is not None:
                # 실제 현재 epoch 값을 사용해 정확한 계산
                current_display = float(hf_epoch_val)
                sec_per_epoch = int(elapsed_sec / current_display) if current_display > 0 else 0
                estimated_end_ms = (
                    int((started_ts_sec + total_epochs * sec_per_epoch) * 1000)
                    if started_ts_sec and sec_per_epoch > 0 else 0
                )
            else:
                # epoch 스칼라 없음 → iteration 값 그대로 표시, 종료 예측 불가
                current_display = float(last_iter)
                sec_per_epoch = 0
                estimated_end_ms = 0
        else:
            # CV/Detection 태스크: last_iteration = 현재 epoch
            current_display = float(last_iter)
            sec_per_epoch = int(elapsed_sec / last_iter) if last_iter > 0 else 0
            estimated_end_ms = (
                int((started_ts_sec + total_epochs * sec_per_epoch) * 1000)
                if started_ts_sec else 0
            )
        # ────────────────────────────────────────────────────────────────────

        clearml_active_task_epoch.labels(
            model=proj_short,
            version=task_name,
            started_fmt=started_fmt,
            started_ts=str(int(started_ts_sec)),
            total_epochs=str(total_epochs),
            sec_per_epoch=str(sec_per_epoch),
            estimated_end_ms=str(estimated_end_ms)
        ).set(current_display)

    # 학습 지속시간 / 마지막 실행
    for (proj, name), durations in duration_map.items():
        avg_dur  = sum(durations) / len(durations)
        last_dur = durations[-1]  # 시간순 정렬 아님 → 아래에서 재정렬
        clearml_task_avg_duration_seconds.labels(project=proj, task_name=name).set(avg_dur)

    for (proj, name), ts in last_run_map.items():
        clearml_task_last_run_timestamp.labels(project=proj, task_name=name).set(ts)

    # 가장 최근 학습의 duration 따로 계산 (completed 기준 정렬)
    # (proj, task_name) → list of (completed_ts, duration)
    last_dur_map = defaultdict(list)
    # (proj, task_name) → list of (completed_ts, map50, map50_95, precision, recall)
    perf_map = defaultdict(list)
    # (proj, task_name) → list of (completed_ts, valid_ma)
    perf_acc = defaultdict(list)
    for task in all_tasks:
        if task.get("status") != "completed":
            continue
        proj_name = resolve_project(task.get("project", {}).get("id", ""))
        task_name = task.get("name", "unknown")
        started   = task.get("started")
        completed = task.get("completed")
        if started and completed:
            try:
                ts  = _parse_ts(started)
                tc  = _parse_ts(completed)
                dur = tc - ts
                if dur > 0:
                    last_dur_map[(proj_name, task_name)].append((tc, dur))
                # 성능 지표 수집
                lm = task.get("last_metrics", {}) or {}
                summary = lm.get(SUMMARY_HASH, {})
                if summary:
                    map50     = (summary.get(MAP50_HASH)     or {}).get("value")
                    map50_95  = (summary.get(MAP50_95_HASH)  or {}).get("value")
                    precision = (summary.get(PRECISION_HASH) or {}).get("value")
                    recall    = (summary.get(RECALL_HASH)    or {}).get("value")
                    if any(v is not None for v in [map50, map50_95, precision, recall]):
                        perf_map[(proj_name, task_name)].append(
                            (tc, map50, map50_95, precision, recall)
                        )
                # Classification 정확도 (Performance (mA) / Valid mA)
                perf_section = lm.get(PERF_MA_HASH, {})
                if perf_section:
                    valid_ma = (perf_section.get(VALID_MA_HASH) or {}).get("value")
                    if valid_ma is not None:
                        perf_acc[(proj_name, task_name)].append((tc, valid_ma))
            except Exception:
                pass

    for (proj, name), items in last_dur_map.items():
        items.sort(key=lambda x: x[0])
        clearml_task_last_run_duration_seconds.labels(project=proj, task_name=name).set(items[-1][1])

    # 성능 지표 Prometheus 기록
    for (proj, name), items in perf_map.items():
        items.sort(key=lambda x: x[0])
        _, map50, map50_95, precision, recall = items[-1]
        if map50 is not None:
            clearml_task_perf_map50.labels(project=proj, task_name=name).set(map50)
        if map50_95 is not None:
            clearml_task_perf_map50_95.labels(project=proj, task_name=name).set(map50_95)
        if precision is not None:
            clearml_task_perf_precision.labels(project=proj, task_name=name).set(precision)
        if recall is not None:
            clearml_task_perf_recall.labels(project=proj, task_name=name).set(recall)
        if precision is not None and recall is not None and (precision + recall) > 0:
            f1 = 2 * precision * recall / (precision + recall)
            clearml_task_perf_f1.labels(project=proj, task_name=name).set(f1)

    # Classification 정확도 (Valid mA) 기록 — 버전별 이력
    for (proj, name), items in perf_acc.items():
        items.sort(key=lambda x: x[0])
        _, valid_ma = items[-1]
        clearml_task_perf_accuracy.labels(project=proj, task_name=name).set(valid_ma)

    # Classification 정확도 — unix_ts 레이블로 학습완료 시각 표현 (Grafana 수치 변환용)
    for (proj, name), items in perf_acc.items():
        model_short = proj.split("/")[-1]
        for tc, valid_ma in items:
            clearml_task_perf_accuracy_history.labels(
                model=model_short,
                task_name=name,
                unix_ts=str(int(tc * 1000))  # ms epoch 문자열
            ).set(valid_ma)

    # Detection 성능 — unix_ts 레이블로 학습완료 시각 표현
    for (proj, name), items in perf_map.items():
        model_short = proj.split("/")[-1]
        for tc, map50, map50_95, precision, recall in items:
            unix_ts_ms = str(int(tc * 1000))
            if map50 is not None:
                clearml_task_perf_detection_history.labels(
                    model=model_short, task_name=name,
                    metric_type="map50", unix_ts=unix_ts_ms
                ).set(map50)
            if map50_95 is not None:
                clearml_task_perf_detection_history.labels(
                    model=model_short, task_name=name,
                    metric_type="map50_95", unix_ts=unix_ts_ms
                ).set(map50_95)
            if precision is not None:
                clearml_task_perf_detection_history.labels(
                    model=model_short, task_name=name,
                    metric_type="precision", unix_ts=unix_ts_ms
                ).set(precision)
            if precision is not None and recall is not None and (precision + recall) > 0:
                f1 = 2 * precision * recall / (precision + recall)
                clearml_task_perf_detection_history.labels(
                    model=model_short, task_name=name,
                    metric_type="f1", unix_ts=unix_ts_ms
                ).set(f1)

    # Classification 정확도 — 프로젝트별 최신값 + 버전 수
    proj_latest: dict = {}  # proj → (latest_tc, valid_ma)
    proj_count:  dict = {}  # proj → version_count
    for (proj, name), items in perf_acc.items():
        items.sort(key=lambda x: x[0])
        tc, valid_ma = items[-1]
        proj_count[proj] = proj_count.get(proj, 0) + 1
        if proj not in proj_latest or tc > proj_latest[proj][0]:
            proj_latest[proj] = (tc, valid_ma)
    for proj, (_, valid_ma) in proj_latest.items():
        vc = str(proj_count.get(proj, 1))
        clearml_task_perf_accuracy_latest.labels(project=proj, version_count=vc).set(valid_ma)

    # ── 학습 빈도 (최근 N일) ──────────────────
    recent_tasks = client.get_tasks_in_window(days=FREQUENCY_WINDOW_DAYS)
    freq_count = defaultdict(int)
    clearml_task_training_count_window._metrics.clear()
    clearml_task_training_frequency._metrics.clear()
    for task in recent_tasks:
        proj_name = resolve_project(task.get("project", {}).get("id", ""))
        task_name = task.get("name", "unknown")
        freq_count[(proj_name, task_name)] += 1

    for (proj, name), count in freq_count.items():
        clearml_task_training_count_window.labels(project=proj, task_name=name).set(count)
        clearml_task_training_frequency.labels(project=proj, task_name=name).set(
            round(count / FREQUENCY_WINDOW_DAYS, 4)
        )

    # ── YTD 학습 횟수 (올해 1월 1일 ~ 현재) ──────────
    year_start = datetime(datetime.now(timezone.utc).year, 1, 1, tzinfo=timezone.utc)
    ytd_days = max(1, (datetime.now(timezone.utc) - year_start).days)
    ytd_tasks = client.get_tasks_in_window(days=ytd_days)
    ytd_count = defaultdict(int)
    clearml_task_training_count_ytd._metrics.clear()
    clearml_task_run_history_ytd_seconds._metrics.clear()
    for task in ytd_tasks:
        proj_name = resolve_project(task.get("project", {}).get("id", ""))
        task_name = task.get("name", "unknown")
        ytd_count[(proj_name, task_name)] += 1

        started = task.get("started")
        completed = task.get("completed") or task.get("last_update")
        task_id = task.get("id", "")
        runtime = task.get("runtime") or {}
        server_host = resolve_server_host_display(
            str(runtime.get("hostname") or "-"),
            runtime,
        )
        worker = str(task.get("last_worker") or "-")
        if completed:
            try:
                tc = _parse_ts(completed)
                dur = 0.0
                if started:
                    ts = _parse_ts(started)
                    dur = max(tc - ts, 0.0)
                clearml_task_run_history_ytd_seconds.labels(
                    project=proj_name,
                    model=proj_name.split("/")[-1],
                    task_name=task_name,
                    task_id=task_id,
                    completed_ts_ms=str(int(tc * 1000)),
                    server_host=server_host,
                    worker=worker
                ).set(dur)
            except Exception:
                pass

    for (proj, name), count in ytd_count.items():
        clearml_task_training_count_ytd.labels(project=proj, task_name=name).set(count)

    # ── 데이터셋 메트릭 ───────────────────────
    datasets = client.get_datasets()

    # ClearML 내장 예시 프로젝트 제외 (읽기 전용 public 태스크)
    EXCLUDE_PROJECT_PREFIXES = ("ClearML -", "ClearML Examples", "media/")

    # 매 수집마다 초기화 (삭제·제외된 항목 즉시 제거)
    clearml_datasets_total._metrics.clear()
    clearml_dataset_versions_total._metrics.clear()
    clearml_dataset_last_updated_timestamp._metrics.clear()
    clearml_dataset_file_count._metrics.clear()
    clearml_dataset_size_bytes._metrics.clear()
    clearml_dataset_status._metrics.clear()

    # dataset_name별 버전 그룹화
    ds_versions = defaultdict(list)
    for ds in datasets:
        proj_name = resolve_project(ds.get("project", {}).get("id", ""))
        if any(proj_name.startswith(p) for p in EXCLUDE_PROJECT_PREFIXES):
            continue
        ds_name   = ds.get("name", "unknown")
        ds_versions[(proj_name, ds_name)].append(ds)

    # 프로젝트별 데이터셋 고유 이름 수
    ds_project_names = defaultdict(set)
    for (proj, name) in ds_versions:
        ds_project_names[proj].add(name)

    for proj, names in ds_project_names.items():
        clearml_datasets_total.labels(project=proj).set(len(names))

    for (proj, name), versions in ds_versions.items():
        clearml_dataset_versions_total.labels(project=proj, dataset_name=name).set(len(versions))

        # 최신 버전 (last_update 기준)
        latest = sorted(versions, key=lambda x: x.get("last_update", ""), reverse=True)[0]

        last_update = latest.get("last_update", "")
        if last_update:
            try:
                clearml_dataset_last_updated_timestamp.labels(
                    project=proj, dataset_name=name
                ).set(_parse_ts(last_update))
            except Exception:
                pass

        # runtime 내 파일 수 / 크기 (ClearML Dataset 메타데이터)
        runtime = latest.get("runtime", {}) or {}
        # ds_file_count: 직접 업로드 파일, ds_link_count: 외부 링크 파일 (합산)
        file_count = (runtime.get("ds_file_count") or 0) + (runtime.get("ds_link_count") or 0)
        if file_count == 0:
            file_count = runtime.get("file_count", 0) or 0
        # 압축 크기 → 원본 크기 → total_size 순으로 폴백
        size_bytes = (runtime.get("ds_total_size_compressed") or 0) or \
                     (runtime.get("ds_total_size") or 0) or \
                     (runtime.get("total_size") or 0)

        clearml_dataset_file_count.labels(project=proj, dataset_name=name).set(file_count)
        clearml_dataset_size_bytes.labels(project=proj, dataset_name=name).set(size_bytes)

        ds_status = latest.get("status", "unknown")
        clearml_dataset_status.labels(
            project=proj,
            dataset_name=name,
            status=ds_status
        ).set(1 if ds_status == "completed" else 0)

    # ── 모델 메트릭 ───────────────────────────
    # 활용 가능 모델: completed(정상 완료) + stopped(의도적 조기 종료) 태스크 기준
    usable_model_count = defaultdict(int)
    for task in all_tasks:
        if task.get("status") in ("completed", "stopped"):
            proj_name = resolve_project(task.get("project", {}).get("id", ""))
            usable_model_count[proj_name] += 1

    for proj, count in usable_model_count.items():
        clearml_models_total.labels(project=proj).set(count)

    # 모델 최종 업데이트 타임스탬프는 기존 모델 레지스트리 기준 유지
    models = client.get_models()
    model_latest = defaultdict(float)
    for model in models:
        proj_name  = resolve_project(model.get("project", {}).get("id", ""))
        model_name = model.get("name", "unknown")
        ts_str = model.get("last_update") or model.get("created", "")
        if ts_str:
            try:
                ts = _parse_ts(ts_str)
                if ts > model_latest[(proj_name, model_name)]:
                    model_latest[(proj_name, model_name)] = ts
            except Exception:
                pass

    for (proj, name), ts in model_latest.items():
        clearml_model_last_updated_timestamp.labels(project=proj, model_name=name).set(ts)

    # ── 태깅 현황 (YOLOv7 Data Studio) ──────────────────────────
    if TAGGING_TOOL_URL:
        try:
            tresp = requests.get(f"{TAGGING_TOOL_URL}/api/projects/overview", timeout=10)
            tresp.raise_for_status()
            tdata = tresp.json()
            # API가 folders 배열을 반환하는 경우 우선 사용, 없으면 projects 사용
            tfolders = tdata.get("folders") or tdata.get("projects", [])
            tagging_project_target._metrics.clear()
            tagging_project_allocated._metrics.clear()
            tagging_project_completed._metrics.clear()
            tagging_project_progress._metrics.clear()
            tagging_project_start_ts._metrics.clear()
            tagging_project_end_ts._metrics.clear()
            tagging_project_info._metrics.clear()
            for p in tfolders:
                # folders 구조: folder, taskCount, allocatedCount, completedCount, lastUpdated, assignedWorker
                # projects 구조: id, name, status, targetTotal, allocated, completed, progress, createdAt, archivedAt
                is_folder = "folder" in p
                pid = str(p.get("folder") or p.get("id", ""))
                pname = str(p.get("folder") or p.get("name", pid))
                pstatus = str(p.get("status", "ACTIVE"))
                if not pid:
                    continue
                task_total = int(p.get("taskCount") if is_folder else p.get("targetTotal", 0))
                allocated  = int(p.get("allocatedCount") if is_folder else p.get("allocated", 0))
                completed  = int(p.get("completedCount") if is_folder else p.get("completed", 0))
                progress   = round(completed / task_total * 100, 1) if task_total else 0.0
                if not is_folder:
                    progress = float(p.get("progress", progress))
                last_ts = p.get("lastUpdated") or p.get("createdAt")
                archived_ts = None if is_folder else p.get("archivedAt")

                lbl = dict(project_id=pid, project_name=pname, status=pstatus)
                tagging_project_target.labels(**lbl).set(task_total)
                tagging_project_allocated.labels(**lbl).set(allocated)
                tagging_project_completed.labels(**lbl).set(completed)
                tagging_project_progress.labels(**lbl).set(progress)
                if last_ts:
                    tagging_project_start_ts.labels(**lbl).set(last_ts)
                if archived_ts:
                    tagging_project_end_ts.labels(**lbl).set(archived_ts)
                start_date = datetime.fromtimestamp(
                    last_ts / 1000, tz=timezone.utc
                ).strftime("%Y-%m-%d") if last_ts else "-"
                end_date = datetime.fromtimestamp(
                    archived_ts / 1000, tz=timezone.utc
                ).strftime("%Y-%m-%d") if archived_ts else "-"
                # sort_key: 최신 업데이트 순 정렬
                _ts_s = int(last_ts / 1000) if last_ts else 0
                sort_key = str(9_999_999_999 - _ts_s)
                worker = str(p.get("assignedWorker", "")) if is_folder else ""
                tagging_project_info.labels(
                    project_id=pid,
                    project_name=pname,
                    status=pstatus,
                    sort_key=sort_key,
                    start_date=start_date,
                    end_date=end_date,
                    target_total=str(task_total),
                    allocated=str(allocated),
                    completed=str(completed),
                    progress=str(progress),
                ).set(1)
            log.info(f"태깅 메트릭 수집 완료: {len(tfolders)}개 프로젝트")
        except Exception as te:
            log.warning(f"태깅 메트릭 수집 실패 (무시): {te}")

    # ── GitLab 커밋 현황 ─────────────────────────────────────
    if GITLAB_URL and GITLAB_TOKEN:
        try:
            gl_headers = {"PRIVATE-TOKEN": GITLAB_TOKEN}
            gl_base = GITLAB_URL.rstrip("/")
            now_utc = datetime.now(timezone.utc)
            periods = {
                "today":   (now_utc.replace(hour=0, minute=0, second=0, microsecond=0), now_utc),
                "week":    (now_utc - timedelta(days=7),  now_utc),
                "month":   (now_utc - timedelta(days=30), now_utc),
            }
            # 프로젝트 목록 수집 (GITLAB_PROJECT_IDS 지정 시 해당 ID만, 없으면 membership 전체)
            gl_projects = []
            if GITLAB_PROJECT_IDS.strip():
                for pid_str in GITLAB_PROJECT_IDS.split(","):
                    pid_str = pid_str.strip()
                    if not pid_str:
                        continue
                    r = requests.get(
                        f"{gl_base}/api/v4/projects/{pid_str}",
                        headers=gl_headers,
                        timeout=10
                    )
                    if r.status_code == 200:
                        gl_projects.append(r.json())
            else:
                page = 1
                while True:
                    r = requests.get(
                        f"{gl_base}/api/v4/projects",
                        headers=gl_headers,
                        params={"membership": "true", "per_page": 50, "page": page, "simple": "true"},
                        timeout=10
                    )
                    r.raise_for_status()
                    batch = r.json()
                    if not batch:
                        break
                    gl_projects.extend(batch)
                    if len(batch) < 50:
                        break
                    page += 1

            # ── 더블버퍼: 먼저 모든 데이터를 수집 후 한꺼번에 메트릭 교체 ──
            buf_commit_count   = {}   # (pid,pname,pns,author,period) → cnt
            buf_proj_total     = {}   # (pid,pname,pns,period)        → cnt
            buf_lines_added    = {}   # (pid,pname,pns,author,period) → lines
            buf_lines_deleted  = {}   # (pid,pname,pns,author,period) → lines

            for proj in gl_projects:
                pid   = str(proj["id"])
                pname = proj["name"]
                pns   = proj.get("namespace", {}).get("full_path", "") if isinstance(proj.get("namespace"), dict) else str(proj.get("namespace", ""))

                for period_name, (since, until) in periods.items():
                    # ── 커밋 목록 수집 (최대 500개, stats 없이 빠르게) ──
                    commits = []
                    cpage = 1
                    while len(commits) < 500:
                        cr = requests.get(
                            f"{gl_base}/api/v4/projects/{pid}/repository/commits",
                            headers=gl_headers,
                            params={
                                "since":    since.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                "until":    until.strftime("%Y-%m-%dT%H:%M:%SZ"),
                                "per_page": 100,
                                "page":     cpage,
                                "all":      "true",
                            },
                            timeout=10
                        )
                        if cr.status_code != 200:
                            break
                        batch = cr.json()
                        if not batch:
                            break
                        commits.extend(batch)
                        if len(batch) < 100:
                            break
                        cpage += 1

                    # ── 커밋 수 집계 ──
                    author_counts: dict = {}
                    for c in commits:
                        author = c.get("author_name") or c.get("committer_name", "unknown")
                        author_counts[author] = author_counts.get(author, 0) + 1

                    for author, cnt in author_counts.items():
                        buf_commit_count[(pid, pname, pns, author, period_name)] = cnt

                    buf_proj_total[(pid, pname, pns, period_name)] = len(commits)

                    # ── 라인 수 집계 (최근 30개 커밋 개별 API, time budget 15s) ──
                    author_added:   dict = {}
                    author_deleted: dict = {}
                    budget_end = time.monotonic() + 15
                    for c in commits[:30]:
                        if time.monotonic() > budget_end:
                            break
                        sha    = c.get("id", "")
                        author = c.get("author_name") or c.get("committer_name", "unknown")
                        try:
                            sr = requests.get(
                                f"{gl_base}/api/v4/projects/{pid}/repository/commits/{sha}",
                                headers=gl_headers,
                                timeout=4
                            )
                            if sr.status_code == 200:
                                st = sr.json().get("stats") or {}
                                author_added[author]   = author_added.get(author, 0)   + int(st.get("additions", 0))
                                author_deleted[author] = author_deleted.get(author, 0) + int(st.get("deletions", 0))
                        except Exception:
                            pass

                    for author in author_counts:
                        if author_added.get(author, 0) > 0 or author_deleted.get(author, 0) > 0:
                            buf_lines_added[(pid, pname, pns, author, period_name)]   = author_added.get(author, 0)
                            buf_lines_deleted[(pid, pname, pns, author, period_name)] = author_deleted.get(author, 0)

            # ── 원자적 교체: clear → set (공백 시간 ≈ 0) ──
            gitlab_commit_count._metrics.clear()
            gitlab_project_commit_total._metrics.clear()
            gitlab_lines_added._metrics.clear()
            gitlab_lines_deleted._metrics.clear()

            for (pid, pname, pns, author, period_name), cnt in buf_commit_count.items():
                gitlab_commit_count.labels(
                    project_id=pid, project_name=pname,
                    namespace=pns, author_name=author, period=period_name
                ).set(cnt)
            for (pid, pname, pns, period_name), cnt in buf_proj_total.items():
                gitlab_project_commit_total.labels(
                    project_id=pid, project_name=pname,
                    namespace=pns, period=period_name
                ).set(cnt)
            for (pid, pname, pns, author, period_name), lines in buf_lines_added.items():
                gitlab_lines_added.labels(
                    project_id=pid, project_name=pname,
                    namespace=pns, author_name=author, period=period_name
                ).set(lines)
            for (pid, pname, pns, author, period_name), lines in buf_lines_deleted.items():
                gitlab_lines_deleted.labels(
                    project_id=pid, project_name=pname,
                    namespace=pns, author_name=author, period=period_name
                ).set(lines)

            # ── 프로젝트별 최신 태그 수집 (더블버퍼) ──
            buf_tag_info = {}  # (pid,pname,pns,tag_name,created_by,commit_title) → ts_ms
            for proj in gl_projects:
                pid   = str(proj["id"])
                pname = proj["name"]
                pns   = proj.get("namespace", {}).get("full_path", "") if isinstance(proj.get("namespace"), dict) else str(proj.get("namespace", ""))
                tr = requests.get(
                    f"{gl_base}/api/v4/projects/{pid}/repository/tags",
                    headers=gl_headers,
                    params={"per_page": 10, "page": 1, "order_by": "updated", "sort": "desc"},
                    timeout=10
                )
                if tr.status_code != 200:
                    continue
                for tag in tr.json():
                    tag_name     = tag.get("name", "")
                    commit       = tag.get("commit") or {}
                    # annotated tag의 message 우선, 없으면 commit title 사용
                    tag_msg      = (tag.get("message") or "").strip()
                    commit_title = (commit.get("title") or commit.get("message") or "").split("\n")[0].strip()
                    content      = tag_msg if tag_msg else commit_title
                    # committed_date(push 시각) 우선, 없으면 authored_date
                    created_at   = commit.get("committed_date") or commit.get("created_at") or commit.get("authored_date", "")
                    created_by   = commit.get("committer_name") or commit.get("author_name", "")
                    if not tag_name:
                        continue
                    ts_ms = 0.0
                    if created_at:
                        try:
                            from datetime import datetime as _dt
                            ts_ms = _dt.fromisoformat(created_at.replace("Z", "+00:00")).timestamp() * 1000
                        except Exception:
                            pass
                    buf_tag_info[(pid, pname, pns, tag_name, created_by, content)] = ts_ms

            # ── 태그 원자적 교체 ──
            gitlab_tag_info._metrics.clear()
            for (pid, pname, pns, tag_name, created_by, content), ts_ms in buf_tag_info.items():
                gitlab_tag_info.labels(
                    project_id=pid, project_name=pname,
                    namespace=pns, tag_name=tag_name,
                    created_by=created_by, commit_title=content
                ).set(ts_ms)

            log.info(f"GitLab 커밋 메트릭 수집 완료: {len(gl_projects)}개 프로젝트")
        except Exception as ge:
            log.warning(f"GitLab 메트릭 수집 실패 (무시): {ge}")

    elapsed = round(time.time() - start, 2)
    log.info(f"메트릭 수집 완료 ({elapsed}s) — 프로젝트:{len(projects)}, "
             f"태스크:{len(all_tasks)}, 데이터셋:{len(datasets)}, 모델:{len(models)}")

    # Grafana 대시보드 링크 시간 범위 자동 갱신
    try:
        _update_grafana_timeranges(perf_acc, perf_map)
    except Exception as e:
        log.warning(f"Grafana 링크 갱신 실패 (무시): {e}")


def _update_grafana_timeranges(perf_acc: dict, perf_map: dict):
    """수집된 데이터의 completed_at 범위로 Grafana 패널 링크 URL 자동 갱신"""
    BUFFER_MS = 3 * 24 * 3600 * 1000  # 3일 여유

    # Classification 범위
    clf_ts = [tc for items in perf_acc.values() for tc, _ in items]
    # Detection 범위
    det_ts = [tc for items in perf_map.values() for tc, *_ in items]

    if not clf_ts and not det_ts:
        return

    clf_from = int(min(clf_ts) * 1000 - BUFFER_MS) if clf_ts else None
    clf_to   = int(max(clf_ts) * 1000 + BUFFER_MS) if clf_ts else None
    det_from = int(min(det_ts) * 1000 - BUFFER_MS) if det_ts else None
    det_to   = int(max(det_ts) * 1000 + BUFFER_MS) if det_ts else None

    auth = (GRAFANA_USER, GRAFANA_PASSWORD)
    resp = requests.get(f"{GRAFANA_URL}/api/dashboards/uid/{GRAFANA_DASH_UID}",
                        auth=auth, timeout=5)
    if resp.status_code != 200:
        return
    dash_data = resp.json()
    dash = dash_data["dashboard"]
    uid  = dash["uid"]

    changed = False
    for p in dash.get("panels", []):
        if not isinstance(p, dict):
            continue
        pid = p.get("id")

        if pid == 16:
            for lk in p.get("fieldConfig", {}).get("defaults", {}).get("links", []):
                new_url = (f"/d/{uid}?var-selected_model=${{__data.fields.\ubaa8\ub378}}"
                           f"&viewPanel=18&from=now-90d&to=now")
                if lk.get("url") != new_url:
                    lk["url"] = new_url
                    changed = True

        if pid == 15:
            for lk in p.get("fieldConfig", {}).get("defaults", {}).get("links", []):
                new_url = (f"/d/{uid}?var-selected_detection_model=${{__data.fields.\ubaa8\ub378}}"
                           f"&viewPanel=19&from=now-90d&to=now")
                if lk.get("url") != new_url:
                    lk["url"] = new_url
                    changed = True

    if changed:
        dash["version"] = dash_data["dashboard"]["version"]
        requests.post(f"{GRAFANA_URL}/api/dashboards/db", auth=auth, timeout=5,
                      json={"dashboard": dash, "overwrite": True,
                            "folderId": dash_data.get("meta", {}).get("folderId", 0),
                            "message": "auto: update time range from training data"})
        log.info("Grafana \ub9c1\ud06c URL \uac31\uc2e0: now-90d~now")


def _parse_ts(value) -> float:
    """ISO8601 문자열 또는 Unix timestamp → float"""
    if not value:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        # ClearML은 ISO 8601 형식 반환
        from dateutil import parser as dp
        dt = dp.parse(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    return 0.0


# ──────────────────────────────────────────────
# 메인 루프
# ──────────────────────────────────────────────

def main():
    log.info(f"ClearML Prometheus Exporter 시작 (port={EXPORTER_PORT}, "
             f"interval={SCRAPE_INTERVAL_SEC}s, window={FREQUENCY_WINDOW_DAYS}days)")
    log.info(f"ClearML API: {CLEARML_API_HOST}")

    start_http_server(EXPORTER_PORT)
    client = ClearMLClient(CLEARML_API_HOST, CLEARML_ACCESS_KEY, CLEARML_SECRET_KEY)

    # 최초 수집 (서버 기동 직후)
    while True:
        try:
            collect_metrics(client)
        except Exception as e:
            log.exception(f"메트릭 수집 중 오류: {e}")
        time.sleep(SCRAPE_INTERVAL_SEC)


if __name__ == "__main__":
    main()
