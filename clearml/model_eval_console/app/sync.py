from __future__ import annotations

import json
import logging
import threading
from datetime import datetime
from pathlib import PurePosixPath
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

from pymongo import MongoClient

from .config import Settings
from .db import Database


logger = logging.getLogger(__name__)

TARGET_PROJECT_PREFIXES = (
    "Intellivix_DNN_Models/Detection",
    "Intellivix_DNN_Models/Classification",
)

INTERESTING_METRIC_VARIANTS = [
    "metrics/mAP50(B)",
    "metrics/mAP50-95(B)",
    "metrics/precision(B)",
    "metrics/recall(B)",
    "mAP50(B)",
    "mAP50-95(B)",
    "precision(B)",
    "recall(B)",
    "mAP_0.5",
    "mAP_0.5:0.95",
    "precision",
    "recall",
    "accuracy",
    "train_loss",
    "valid_loss",
    "validation: epoch_accuracy",
    "validation: epoch_loss",
    "epoch_accuracy",
    "epoch_loss",
]

INTERESTING_METRIC_NAMES = [
    "metrics",
    "val",
    "valid_0",
    "accuracy",
    "epoch_accuracy",
    "epoch_loss",
    "Loss",
    "Training Loss",
]


def _project_category(project_name: str) -> str:
    if project_name.startswith("Intellivix_DNN_Models/Detection"):
        return "Detection"
    if project_name.startswith("Intellivix_DNN_Models/Classification"):
        return "Classification"
    return "Other"


def _artifact_name(uri: str | None) -> str | None:
    if not uri:
        return None
    try:
        return PurePosixPath(uri).name or None
    except Exception:
        return uri.rsplit("/", 1)[-1] if "/" in uri else uri


def _metric_label(metric: str | None, variant: str | None) -> str | None:
    text = f"{metric or ''} {variant or ''}".lower()
    if "map50-95" in text or "map_0.5:0.95" in text:
        return "mAP50-95"
    if "map50" in text or "map_0.5" in text:
        return "mAP50"
    if "precision" in text:
        return "Precision"
    if "recall" in text:
        return "Recall"
    if "accuracy" in text:
        return "Accuracy"
    if "valid_loss" in text or "validation: epoch_loss" in text:
        return "Validation Loss"
    if "train_loss" in text or "epoch_loss" in text or metric == "Training Loss":
        return "Train Loss"
    return None


def _short_project_name(project_name: str) -> str:
    return project_name.rsplit("/", 1)[-1]


def _select_leaf_projects(projects: dict[str, str]) -> dict[str, str]:
    relevant = {
        project_id: name
        for project_id, name in projects.items()
        if any(name == prefix or name.startswith(f"{prefix}/") for prefix in TARGET_PROJECT_PREFIXES)
    }
    leaf_projects: dict[str, str] = {}
    project_names = list(relevant.values())

    for project_id, name in relevant.items():
        if name in TARGET_PROJECT_PREFIXES:
            continue
        if any(other != name and other.startswith(f"{name}/") for other in project_names):
            continue
        leaf_projects[project_id] = name

    return leaf_projects


def _is_archived(document: dict[str, Any]) -> bool:
    system_tags = [str(tag).lower() for tag in (document.get("system_tags") or [])]
    return "archived" in system_tags


def _normalize_model_name(name: str) -> str:
    prefix = "Imported by "
    if name.startswith(prefix):
        return name[len(prefix):].strip()
    return name.strip()


def _parse_timestamp(value: Any) -> datetime | None:
    if value in {None, ""}:
        return None

    text = str(value).strip()
    if not text:
        return None

    normalized = text.replace("Z", "+00:00")
    candidates = [normalized]
    if "T" not in normalized and " " in normalized:
        candidates.append(normalized.replace(" ", "T", 1))

    for candidate in candidates:
        try:
            return datetime.fromisoformat(candidate)
        except ValueError:
            continue
    return None


def _latest_timestamp(*values: Any) -> str:
    dated_values: list[tuple[datetime, str]] = []
    fallback_values: list[str] = []

    for value in values:
        if value in {None, ""}:
            continue
        text = str(value)
        parsed = _parse_timestamp(text)
        if parsed is not None:
            dated_values.append((parsed, text))
        else:
            fallback_values.append(text)

    if dated_values:
        return max(dated_values, key=lambda item: item[0])[1]
    return fallback_values[0] if fallback_values else ""


def _find_publish_reason(model: dict[str, Any], settings: Settings) -> str | None:
    if bool(model.get("ready")):
        return "ready-model"

    name = str(model.get("name") or "")
    tags = [str(tag).lower() for tag in (model.get("tags") or [])]
    system_tags = [str(tag).lower() for tag in (model.get("system_tags") or [])]

    for prefix in settings.publish_prefixes:
        if name.startswith(prefix):
            return f"name-prefix:{prefix}"

    for marker in settings.publish_markers:
        marker_lower = marker.lower()
        if marker_lower in tags:
            return f"tag:{marker}"
        if marker_lower in system_tags:
            return f"system-tag:{marker}"

    return None


def _model_priority(model_doc: dict[str, Any], task: dict[str, Any]) -> tuple[int, int, int, str]:
    artifact_name = (_artifact_name(model_doc.get("uri")) or "").lower()
    model_name = str(model_doc.get("name") or "").lower()
    task_status = str(task.get("status") or "").lower()

    is_ready = 1 if bool(model_doc.get("ready")) else 0
    is_published_task = 1 if task_status == "published" else 0
    is_primary_artifact = 1 if artifact_name in {"best.pt", "last.pt"} else 0
    is_epoch_artifact = 0 if "epoch_" in artifact_name or "epoch_" in model_name else 1
    freshness = str(model_doc.get("last_update") or "")

    return (is_ready, is_published_task, is_primary_artifact + is_epoch_artifact, freshness)


class ClearMLMongoSync:
    def __init__(self, settings: Settings, database: Database):
        self.settings = settings
        self.database = database
        self.last_error: str | None = None
        self.last_synced_count = 0

    def _elastic_search(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        request = Request(
            url=f"{self.settings.elastic_uri.rstrip('/')}/{path.lstrip('/')}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))

    def _load_task_metrics(self, task_ids: list[str]) -> dict[str, dict[str, Any]]:
        if not task_ids:
            return {}

        metrics_by_task: dict[str, dict[str, Any]] = {}
        for task_id in task_ids:
            payload = {
                "size": 200,
                "sort": [
                    {"iter": {"order": "desc"}},
                    {"timestamp": {"order": "desc"}},
                ],
                "_source": ["task", "metric", "variant", "value", "iter"],
                "query": {
                    "bool": {
                        "filter": [{"term": {"task": task_id}}],
                        "should": [
                            {"terms": {"variant": INTERESTING_METRIC_VARIANTS}},
                            {"terms": {"metric": INTERESTING_METRIC_NAMES}},
                        ],
                        "minimum_should_match": 1,
                    }
                },
            }

            try:
                response = self._elastic_search("events-training_stats_scalar-*/_search", payload)
            except (URLError, TimeoutError, OSError, ValueError):
                logger.exception("Failed loading task metrics from Elasticsearch for task %s", task_id)
                continue

            metrics: dict[str, Any] = {}
            for hit in response.get("hits", {}).get("hits", []):
                source = hit.get("_source", {})
                label = _metric_label(source.get("metric"), source.get("variant"))
                if not label or label in metrics:
                    continue
                metrics[label] = {
                    "value": source.get("value"),
                    "iter": source.get("iter"),
                    "metric": source.get("metric"),
                    "variant": source.get("variant"),
                }
            if metrics:
                metrics_by_task[task_id] = metrics

        return metrics_by_task

    def sync_once(self) -> int:
        client = MongoClient(self.settings.mongo_uri)
        try:
            db = client[self.settings.mongo_db]
            projects = {
                row["_id"]: row.get("name")
                for row in db.project.find({}, {"_id": 1, "name": 1})
            }
            leaf_projects = _select_leaf_projects(projects)

            task_rows = list(
                db.task.find(
                    {"project": {"$in": list(leaf_projects.keys())}, "type": "training"},
                    {
                        "_id": 1,
                        "name": 1,
                        "project": 1,
                        "status": 1,
                        "created": 1,
                        "completed": 1,
                        "last_update": 1,
                        "system_tags": 1,
                    },
                )
            )
            task_by_id = {str(row["_id"]): row for row in task_rows}
            task_name_index = {
                (str(row.get("project") or ""), str(row.get("name") or "")): row
                for row in task_rows
                if not _is_archived(row)
            }

            candidate_model_docs = list(
                db.model.find(
                    {
                        "project": {"$in": list(leaf_projects.keys())},
                    },
                    {
                        "_id": 1,
                        "name": 1,
                        "project": 1,
                        "task": 1,
                        "uri": 1,
                        "framework": 1,
                        "ready": 1,
                        "tags": 1,
                        "system_tags": 1,
                        "last_update": 1,
                    },
                ).sort("last_update", -1)
            )

            resolved_models: dict[str, dict[str, Any]] = {}
            matched_task_ids: set[str] = set()

            for model_doc in candidate_model_docs:
                if model_doc.get("uri") == "file:///uploading_file" or _is_archived(model_doc):
                    continue

                publish_reason = _find_publish_reason(model_doc, self.settings)
                if not publish_reason:
                    continue

                related_task = None
                model_task_id = str(model_doc.get("task") or "").strip()
                if model_task_id:
                    related_task = task_by_id.get(model_task_id)

                if related_task is None:
                    normalized_name = _normalize_model_name(str(model_doc.get("name") or ""))
                    related_task = task_name_index.get((str(model_doc.get("project") or ""), normalized_name))

                if related_task is None or _is_archived(related_task):
                    continue

                related_task_id = str(related_task["_id"])
                matched_task_ids.add(related_task_id)
                current = resolved_models.get(related_task_id)
                candidate = {
                    "model_doc": model_doc,
                    "task": related_task,
                    "publish_reason": publish_reason,
                }
                if current is None:
                    resolved_models[related_task_id] = candidate
                    continue

                if _model_priority(model_doc, related_task) > _model_priority(current["model_doc"], current["task"]):
                    resolved_models[related_task_id] = candidate

            project_representatives: dict[str, dict[str, Any]] = {}
            for resolved in resolved_models.values():
                task = resolved["task"]
                project_id = str(task.get("project") or "")
                current = project_representatives.get(project_id)
                if current is None:
                    project_representatives[project_id] = resolved
                    continue

                if _model_priority(resolved["model_doc"], task) > _model_priority(current["model_doc"], current["task"]):
                    project_representatives[project_id] = resolved

            selected_task_ids = {
                str(resolved["task"]["_id"])
                for resolved in project_representatives.values()
            }
            metrics_by_task = self._load_task_metrics(sorted(selected_task_ids))
            models = []

            for resolved in project_representatives.values():
                model_doc = resolved["model_doc"]
                task = resolved["task"]
                publish_reason = resolved["publish_reason"]
                task_id = str(task["_id"])
                project_name = leaf_projects.get(task.get("project")) or projects.get(task.get("project")) or "Unknown project"
                published_name = _normalize_model_name(str(model_doc.get("name") or "Unnamed model"))

                models.append(
                    {
                        "model_id": str(model_doc["_id"]),
                        "name": published_name,
                        "published_model_name": model_doc.get("name") or published_name,
                        "project_id": task.get("project"),
                        "project_name": project_name,
                        "task_id": task_id,
                        "uri": model_doc.get("uri"),
                        "artifact_name": _artifact_name(model_doc.get("uri")),
                        "framework": model_doc.get("framework"),
                        "ready": bool(model_doc.get("ready")),
                        "publish_reason": publish_reason,
                        "source_last_update": _latest_timestamp(model_doc.get("last_update"), task.get("last_update")),
                        "project_category": _project_category(project_name),
                        "project_short_name": _short_project_name(project_name),
                        "task_status": task.get("status") or "unknown",
                        "task_created": str(task.get("created") or ""),
                        "task_completed": str(task.get("completed") or ""),
                        "latest_metrics": metrics_by_task.get(task_id, {}),
                        "publish_history": [
                            {
                                "model_doc_id": str(model_doc["_id"]),
                                "name": model_doc.get("name") or published_name,
                                "uri": model_doc.get("uri"),
                                "artifact_name": _artifact_name(model_doc.get("uri")),
                                "framework": model_doc.get("framework"),
                                "ready": bool(model_doc.get("ready")),
                                "publish_reason": publish_reason,
                                "last_update": str(model_doc.get("last_update") or ""),
                            }
                        ],
                        "publish_count": 1,
                        "history_count": 1,
                        "latest_publish": {
                            "model_doc_id": str(model_doc["_id"]),
                            "name": model_doc.get("name") or published_name,
                            "uri": model_doc.get("uri"),
                            "artifact_name": _artifact_name(model_doc.get("uri")),
                            "framework": model_doc.get("framework"),
                            "ready": bool(model_doc.get("ready")),
                            "publish_reason": publish_reason,
                            "last_update": str(model_doc.get("last_update") or ""),
                        },
                    }
                )

            self.last_synced_count = self.database.upsert_published_models(models)
            if self.database.get_evaluation_mode() == "auto":
                self.database.ensure_auto_evaluation_runs(
                    [str(model["model_id"]) for model in models],
                    self.settings.default_queue,
                )
            self.last_error = None
            return self.last_synced_count
        except Exception as exc:
            self.last_error = str(exc)
            logger.exception("Failed syncing published models from MongoDB")
            raise
        finally:
            client.close()


class SyncWorker:
    def __init__(self, sync_service: ClearMLMongoSync, interval_sec: int):
        self.sync_service = sync_service
        self.interval_sec = interval_sec
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True, name="model-eval-sync")

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=2)

    def _run(self) -> None:
        while not self.stop_event.is_set():
            try:
                self.sync_service.sync_once()
            except Exception:
                pass
            self.stop_event.wait(self.interval_sec)