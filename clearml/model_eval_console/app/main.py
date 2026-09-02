from __future__ import annotations

import csv
import io
import json
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .config import Settings, load_settings
from .db import Database
from .sync import ClearMLMongoSync, SyncWorker


settings = load_settings()
database = Database(settings.db_path)
sync_service = ClearMLMongoSync(settings, database)
sync_worker = SyncWorker(sync_service, settings.sync_interval_sec)
BASE_DIR = Path(__file__).resolve().parent


@asynccontextmanager
async def lifespan(_: FastAPI):
    database.init()
    try:
        sync_service.sync_once()
    except Exception:
        pass
    sync_worker.start()
    yield
    sync_worker.stop()


app = FastAPI(title=settings.app_title, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


def _format_timestamp(value: Any) -> str | None:
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
            parsed = datetime.fromisoformat(candidate)
            return parsed.strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue

    if "." in text:
        return text.split(".", 1)[0]
    return text[:19]


def _serialize_model(row: Any) -> dict[str, Any]:
    data = dict(row)
    raw_json = data.get("raw_json")
    if raw_json:
        try:
            raw = json.loads(raw_json)
        except json.JSONDecodeError:
            raw = {}
        data.update(raw)
    for field in ["source_last_update", "task_created", "task_completed", "published_at"]:
        data[field] = _format_timestamp(data.get(field))
    for field in ["deployment_decided_at", "latest_run_requested_at", "latest_run_finished_at"]:
        data[field] = _format_timestamp(data.get(field))
    if data.get("latest_run_metrics_json"):
        try:
            data["latest_run_metrics"] = json.loads(data["latest_run_metrics_json"])
        except json.JSONDecodeError:
            data["latest_run_metrics"] = None
    else:
        data["latest_run_metrics"] = None
    return data


def _format_metric_value(value: Any) -> str:
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if abs(value) >= 100:
            return f"{value:.1f}"
        if abs(value) >= 1:
            return f"{value:.3f}"
        return f"{value:.4f}"
    return str(value)


def _prepare_metric_cards(model: dict[str, Any]) -> list[dict[str, Any]]:
    cards = []
    for label in ["mAP50-95", "mAP50", "Precision", "Recall", "Accuracy", "Validation Loss", "Train Loss"]:
        metric = (model.get("latest_metrics") or {}).get(label)
        if not metric:
            continue
        cards.append(
            {
                "label": label,
                "value": _format_metric_value(metric.get("value")),
                "iter": metric.get("iter"),
            }
        )
    return cards


def _prepare_result_tables(model: dict[str, Any]) -> dict[str, Any]:
    metrics = model.get("latest_run_metrics") or {}
    if not isinstance(metrics, dict):
        return {"summary_rows": [], "item_rows": [], "raw_metrics": None}

    summary_rows = []
    for label, key in [
        ("F1 Score", "average_f1_score"),
        ("Accuracy", "average_accuracy"),
        ("Precision", "precision"),
        ("Recall", "recall"),
    ]:
        value = metrics.get(key)
        if isinstance(value, (int, float)):
            summary_rows.append({"label": label, "value": _format_metric_value(value)})

    item_rows = []
    for row in metrics.get("rows") or []:
        if not isinstance(row, dict):
            continue
        item_rows.append(
            {
                "filename": row.get("filename") or "-",
                "tp": row.get("tp", 0),
                "tn": row.get("tn", 0),
                "fp": row.get("fp", 0),
                "fn": row.get("fn", 0),
            }
        )

    raw_metrics = None if item_rows else metrics
    return {
        "summary_rows": summary_rows,
        "item_rows": item_rows,
        "raw_metrics": raw_metrics,
    }


def _derive_model_state(model: dict[str, Any]) -> str:
    deployment_status = str(model.get("deployment_status") or "").lower()
    if deployment_status == "deployed":
        return "deployed"

    latest_run_status = str(model.get("latest_run_status") or "").lower()
    if latest_run_status in {"queued", "running"}:
        return "evaluating"
    if latest_run_status == "completed":
        return "evaluated"

    return "published"


def _build_publish_summary(models: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "total": len(models),
        "detection": sum(1 for model in models if model.get("project_category") == "Detection"),
        "classification": sum(1 for model in models if model.get("project_category") == "Classification"),
        "with_metrics": sum(1 for model in models if model.get("metric_cards")),
        "deployed": sum(1 for model in models if str(model.get("deployment_status") or "").lower() == "deployed"),
    }


def _serialize_run(row: Any) -> dict[str, Any]:
    data = dict(row)
    for field in ["requested_at", "started_at", "finished_at"]:
        data[field] = _format_timestamp(data.get(field))
    if data.get("metrics_json"):
        try:
            data["metrics"] = json.loads(data["metrics_json"])
        except json.JSONDecodeError:
            data["metrics"] = None
    else:
        data["metrics"] = None
    if data.get("request_payload_json"):
        try:
            data["request_payload"] = json.loads(data["request_payload_json"])
        except json.JSONDecodeError:
            data["request_payload"] = None
    else:
        data["request_payload"] = None
    return data


def _to_number(value: Any) -> int | float | None:
    if value in {None, ""}:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    if number.is_integer():
        return int(number)
    return number


def _build_summary_text(metrics: dict[str, Any]) -> str:
    parts = []
    for key in ["average_f1_score", "average_accuracy", "precision", "recall"]:
        value = metrics.get(key)
        if isinstance(value, (int, float)):
            parts.append(f"{key}={value:.4f}" if isinstance(value, float) else f"{key}={value}")
    return ", ".join(parts) if parts else "evaluation result uploaded"


def _parse_csv_result(content: str) -> tuple[str, dict[str, Any]]:
    reader = csv.DictReader(io.StringIO(content))
    rows: list[dict[str, Any]] = []
    totals = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
    summary_values: dict[str, Any] = {}

    for row in reader:
        filename = (row.get("Filename") or "").strip()
        if filename.startswith("Average "):
            metric_name = filename.lower().replace(" ", "_")
            value = _to_number(row.get("tp#"))
            summary_values[metric_name] = value
            continue

        normalized = {
            "filename": filename,
            "tp": int(_to_number(row.get("tp#")) or 0),
            "fp": int(_to_number(row.get("fp#")) or 0),
            "fn": int(_to_number(row.get("fn#")) or 0),
            "tn": int(_to_number(row.get("tn#")) or 0),
        }
        rows.append(normalized)
        for key in totals:
            totals[key] += normalized[key]

    precision = totals["tp"] / (totals["tp"] + totals["fp"]) if (totals["tp"] + totals["fp"]) else 0.0
    recall = totals["tp"] / (totals["tp"] + totals["fn"]) if (totals["tp"] + totals["fn"]) else 0.0
    accuracy = (totals["tp"] + totals["tn"]) / sum(totals.values()) if sum(totals.values()) else 0.0
    f1_score = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0

    metrics = {
        "source_type": "csv",
        "row_count": len(rows),
        "totals": totals,
        "precision": precision,
        "recall": recall,
        "accuracy": summary_values.get("average_accuracy", accuracy),
        "average_accuracy": summary_values.get("average_accuracy", accuracy),
        "average_f1_score": summary_values.get("average_f1_score", f1_score),
        "rows": rows,
    }
    return _build_summary_text(metrics), metrics


def _parse_json_result(content: str) -> tuple[str, dict[str, Any]]:
    payload = json.loads(content)
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="result JSON must be an object")

    result_summary = str(payload.get("result_summary") or "").strip()
    metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else payload
    if not result_summary:
        result_summary = _build_summary_text(metrics if isinstance(metrics, dict) else {})
    return result_summary, metrics if isinstance(metrics, dict) else {"payload": payload}


def _resolve_target_run(model_id: str) -> int:
    latest_run = database.get_latest_run_for_model(model_id)
    if latest_run:
        return int(latest_run["id"])
    return database.create_evaluation_run(model_id, settings.default_queue)


@app.get("/")
def dashboard(request: Request):
    models = [_serialize_model(row) for row in database.list_published_models()]
    for model in models:
        model["metric_cards"] = _prepare_metric_cards(model)
        model["display_status"] = _derive_model_state(model)
        model["result_tables"] = _prepare_result_tables(model)
    models.sort(key=lambda item: (item.get("source_last_update") or "", item.get("name") or ""), reverse=True)
    publish_summary = _build_publish_summary(models)

    selected_model_id = (request.query_params.get("selected") or "").strip()
    selected_model = None
    if models:
        selected_model = next((model for model in models if model.get("model_id") == selected_model_id), None)
        if selected_model is None:
            selected_model = models[0]

    return templates.TemplateResponse(
        "dashboard.html",
        {
            "request": request,
            "app_title": settings.app_title,
            "models": models,
            "selected_model": selected_model,
            "publish_summary": publish_summary,
            "evaluation_mode": database.get_evaluation_mode(),
            "default_queue": settings.default_queue,
            "last_error": sync_service.last_error,
            "last_synced_count": sync_service.last_synced_count,
            "publish_prefixes": settings.publish_prefixes,
            "publish_markers": settings.publish_markers,
        },
    )


@app.post("/sync-now")
def sync_now():
    sync_service.sync_once()
    return RedirectResponse(url="/", status_code=303)


@app.post("/settings/evaluation-mode")
def set_evaluation_mode(evaluation_mode: str = Form(...)):
    mode = evaluation_mode.strip().lower()
    if mode not in {"manual", "auto"}:
        raise HTTPException(status_code=400, detail="Unsupported evaluation mode")
    database.set_setting("evaluation_mode", mode)
    if mode == "auto":
        sync_service.sync_once()
    return RedirectResponse(url="/", status_code=303)


@app.post("/models/{model_id}/request-eval")
def request_model_evaluation(model_id: str):
    database.create_evaluation_run(model_id, settings.default_queue)
    return RedirectResponse(url=f"/?selected={model_id}", status_code=303)


@app.post("/models/{model_id}/upload-result")
async def upload_model_result(
    model_id: str,
    result_file: UploadFile | None = File(default=None),
    result_json: str = Form(default=""),
    evaluator_host: str = Form(default=""),
    external_job_id: str = Form(default=""),
    notes: str = Form(default=""),
):
    run_id = _resolve_target_run(model_id)

    if result_file and result_file.filename:
        content = (await result_file.read()).decode("utf-8", errors="replace")
        if result_file.filename.lower().endswith(".json"):
            result_summary, metrics = _parse_json_result(content)
        else:
            result_summary, metrics = _parse_csv_result(content)
    elif result_json.strip():
        result_summary, metrics = _parse_json_result(result_json)
    else:
        raise HTTPException(status_code=400, detail="result file or result JSON is required")

    database.update_run(
        run_id,
        status="completed",
        evaluator_host=evaluator_host.strip() or None,
        external_job_id=external_job_id.strip() or None,
        result_summary=result_summary,
        metrics=metrics,
        notes=notes.strip() or None,
        callback_payload={
            "source": "manual-upload",
            "model_id": model_id,
            "result_summary": result_summary,
            "metrics": metrics,
        },
    )
    return RedirectResponse(url=f"/?selected={model_id}", status_code=303)


@app.post("/models/{model_id}/deployment")
def set_model_deployment(
    model_id: str,
    deployment_status: str = Form(...),
    deployment_note: str = Form(default=""),
):
    status = deployment_status.strip().lower()
    if status not in {"deployed", "hold", "pending"}:
        raise HTTPException(status_code=400, detail="Unsupported deployment status")
    database.set_deployment_status(model_id, status, deployment_note.strip() or None)
    return RedirectResponse(url=f"/?selected={model_id}", status_code=303)


@app.post("/models/{model_id}/queue")
def queue_model(
    model_id: str,
    queue_name: str = Form(...),
    evaluation_profile: str = Form(default=""),
    target_dataset: str = Form(default=""),
    request_payload: str = Form(default=""),
):
    try:
        parsed_payload = json.loads(request_payload) if request_payload.strip() else None
        database.create_evaluation_run(
            model_id=model_id,
            queue_name=queue_name,
            evaluation_profile=evaluation_profile.strip() or None,
            target_dataset=target_dataset.strip() or None,
            request_payload=parsed_payload,
        )
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="request_payload must be valid JSON") from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return RedirectResponse(url="/", status_code=303)


@app.post("/runs/{run_id}/status")
def update_run_status(
    run_id: int,
    status: str = Form(...),
    notes: str = Form(default=""),
    result_summary: str = Form(default=""),
):
    database.update_run(
        run_id,
        status=status,
        notes=notes or None,
        result_summary=result_summary or None,
    )
    return RedirectResponse(url="/", status_code=303)


@app.get("/api/models")
def api_models():
    items = []
    for row in database.list_published_models():
        model = _serialize_model(row)
        model["display_status"] = _derive_model_state(model)
        items.append(model)
    return {"items": items}


@app.get("/api/runs")
def api_runs():
    return {"items": [_serialize_run(row) for row in database.list_runs()]}


@app.post("/api/models/{model_id}/result")
async def api_model_result(model_id: str, request: Request):
    payload = await request.json()
    result_summary = str(payload.get("result_summary") or "").strip()
    metrics = payload.get("metrics") if isinstance(payload.get("metrics"), dict) else payload
    if not result_summary:
        result_summary = _build_summary_text(metrics if isinstance(metrics, dict) else {})

    run_id = _resolve_target_run(model_id)
    database.update_run(
        run_id,
        status="completed",
        evaluator_host=payload.get("evaluator_host"),
        external_job_id=payload.get("external_job_id"),
        result_summary=result_summary,
        metrics=metrics if isinstance(metrics, dict) else {"payload": payload},
        notes=payload.get("notes"),
        callback_payload=payload,
    )
    run = database.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return {"ok": True, "item": _serialize_run(run)}


@app.get("/api/health")
def api_health():
    return {
        "ok": True,
        "last_error": sync_service.last_error,
        "last_synced_count": sync_service.last_synced_count,
    }


@app.post("/api/runs/{run_id}/claim")
async def api_claim_run(run_id: int, request: Request):
    payload = await request.json()
    database.update_run(
        run_id,
        status="running",
        evaluator_host=payload.get("evaluator_host"),
        external_job_id=payload.get("external_job_id"),
        notes=payload.get("notes"),
        callback_payload=payload,
    )
    run = database.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return {"item": _serialize_run(run)}


@app.post("/api/runs/{run_id}/complete")
async def api_complete_run(run_id: int, request: Request):
    payload = await request.json()
    database.update_run(
        run_id,
        status="completed",
        evaluator_host=payload.get("evaluator_host"),
        external_job_id=payload.get("external_job_id"),
        result_summary=payload.get("result_summary"),
        metrics=payload.get("metrics"),
        notes=payload.get("notes"),
        callback_payload=payload,
    )
    run = database.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return {"item": _serialize_run(run)}


@app.post("/api/runs/{run_id}/fail")
async def api_fail_run(run_id: int, request: Request):
    payload = await request.json()
    database.update_run(
        run_id,
        status="failed",
        evaluator_host=payload.get("evaluator_host"),
        external_job_id=payload.get("external_job_id"),
        result_summary=payload.get("result_summary"),
        metrics=payload.get("metrics"),
        notes=payload.get("notes"),
        callback_payload=payload,
    )
    run = database.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return {"item": _serialize_run(run)}


@app.post("/api/bridge/callback")
async def api_bridge_callback(request: Request):
    if settings.bridge_token:
        token = request.headers.get("x-bridge-token")
        if token != settings.bridge_token:
            raise HTTPException(status_code=401, detail="Invalid bridge token")

    payload = await request.json()
    run_id = int(payload.get("run_id"))
    status = str(payload.get("status"))
    if status not in {"running", "completed", "failed", "canceled"}:
        raise HTTPException(status_code=400, detail="Unsupported callback status")

    database.update_run(
        run_id,
        status=status,
        evaluator_host=payload.get("evaluator_host"),
        external_job_id=payload.get("external_job_id"),
        result_summary=payload.get("result_summary"),
        metrics=payload.get("metrics"),
        notes=payload.get("notes"),
        callback_payload=payload,
    )
    run = database.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return JSONResponse({"ok": True, "item": _serialize_run(run)})


@app.post("/api/bridge/claim-next")
async def api_bridge_claim_next(request: Request):
    if settings.bridge_token:
        token = request.headers.get("x-bridge-token")
        if token != settings.bridge_token:
            raise HTTPException(status_code=401, detail="Invalid bridge token")

    payload = await request.json()
    evaluator_host = str(payload.get("evaluator_host") or "").strip()
    if not evaluator_host:
        raise HTTPException(status_code=400, detail="evaluator_host is required")

    claimed = database.claim_next_queued_run(
        evaluator_host=evaluator_host,
        queue_name=payload.get("queue_name"),
        external_job_id=payload.get("external_job_id"),
        notes=payload.get("notes"),
        callback_payload=payload,
    )

    if not claimed:
        return JSONResponse({"ok": True, "item": None})

    run, model = claimed
    return JSONResponse(
        {
            "ok": True,
            "item": {
                "run": _serialize_run(run),
                "model": _serialize_model(model),
            },
        }
    )
