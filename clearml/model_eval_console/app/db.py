from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


def utc_now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


class Database:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def init(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS published_models (
                    model_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    project_id TEXT,
                    project_name TEXT,
                    task_id TEXT,
                    uri TEXT,
                    framework TEXT,
                    ready INTEGER NOT NULL DEFAULT 0,
                    publish_reason TEXT NOT NULL,
                    source_last_update TEXT,
                    discovered_at TEXT NOT NULL,
                    last_synced_at TEXT NOT NULL,
                    raw_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS evaluation_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    model_id TEXT NOT NULL,
                    model_name TEXT NOT NULL,
                    queue_name TEXT NOT NULL,
                    evaluation_profile TEXT,
                    target_dataset TEXT,
                    request_payload_json TEXT,
                    status TEXT NOT NULL,
                    requested_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    evaluator_host TEXT,
                    external_job_id TEXT,
                    result_summary TEXT,
                    metrics_json TEXT,
                    notes TEXT,
                    callback_payload TEXT,
                    FOREIGN KEY (model_id) REFERENCES published_models (model_id)
                );

                CREATE INDEX IF NOT EXISTS idx_runs_status ON evaluation_runs(status);
                CREATE INDEX IF NOT EXISTS idx_runs_model_id ON evaluation_runs(model_id);

                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS model_review_state (
                    model_id TEXT PRIMARY KEY,
                    deployment_status TEXT,
                    deployment_note TEXT,
                    deployment_decided_at TEXT,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (model_id) REFERENCES published_models (model_id)
                );
                """
            )
            self._ensure_column(conn, "evaluation_runs", "evaluation_profile", "TEXT")
            self._ensure_column(conn, "evaluation_runs", "target_dataset", "TEXT")
            self._ensure_column(conn, "evaluation_runs", "request_payload_json", "TEXT")
            conn.execute(
                """
                INSERT INTO app_settings (key, value, updated_at)
                VALUES ('evaluation_mode', 'manual', ?)
                ON CONFLICT(key) DO NOTHING
                """,
                (utc_now(),),
            )

    def _ensure_column(
        self,
        conn: sqlite3.Connection,
        table_name: str,
        column_name: str,
        column_definition: str,
    ) -> None:
        existing_columns = {
            row["name"] for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()
        }
        if column_name not in existing_columns:
            conn.execute(
                f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_definition}"
            )

    def upsert_published_models(self, models: list[dict[str, Any]]) -> int:
        now = utc_now()
        with self.connect() as conn:
            conn.execute("DELETE FROM published_models")
            for model in models:
                conn.execute(
                    """
                    INSERT INTO published_models (
                        model_id, name, project_id, project_name, task_id, uri,
                        framework, ready, publish_reason, source_last_update,
                        discovered_at, last_synced_at, raw_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(model_id) DO UPDATE SET
                        name = excluded.name,
                        project_id = excluded.project_id,
                        project_name = excluded.project_name,
                        task_id = excluded.task_id,
                        uri = excluded.uri,
                        framework = excluded.framework,
                        ready = excluded.ready,
                        publish_reason = excluded.publish_reason,
                        source_last_update = excluded.source_last_update,
                        last_synced_at = excluded.last_synced_at,
                        raw_json = excluded.raw_json
                    """,
                    (
                        model["model_id"],
                        model["name"],
                        model.get("project_id"),
                        model.get("project_name"),
                        model.get("task_id"),
                        model.get("uri"),
                        model.get("framework"),
                        int(bool(model.get("ready"))),
                        model["publish_reason"],
                        model.get("source_last_update"),
                        now,
                        now,
                        json.dumps(model, ensure_ascii=False),
                    ),
                )
            return len(models)

    def list_published_models(self) -> list[sqlite3.Row]:
        with self.connect() as conn:
            return conn.execute(
                """
                SELECT pm.*, 
                       mrs.deployment_status,
                       mrs.deployment_note,
                       mrs.deployment_decided_at,
                       (SELECT status FROM evaluation_runs er WHERE er.model_id = pm.model_id ORDER BY er.id DESC LIMIT 1) AS latest_run_status,
                       (SELECT id FROM evaluation_runs er WHERE er.model_id = pm.model_id ORDER BY er.id DESC LIMIT 1) AS latest_run_id,
                       (SELECT requested_at FROM evaluation_runs er WHERE er.model_id = pm.model_id ORDER BY er.id DESC LIMIT 1) AS latest_run_requested_at,
                       (SELECT finished_at FROM evaluation_runs er WHERE er.model_id = pm.model_id ORDER BY er.id DESC LIMIT 1) AS latest_run_finished_at,
                       (SELECT result_summary FROM evaluation_runs er WHERE er.model_id = pm.model_id ORDER BY er.id DESC LIMIT 1) AS latest_run_result_summary,
                       (SELECT evaluator_host FROM evaluation_runs er WHERE er.model_id = pm.model_id ORDER BY er.id DESC LIMIT 1) AS latest_run_evaluator_host,
                       (SELECT external_job_id FROM evaluation_runs er WHERE er.model_id = pm.model_id ORDER BY er.id DESC LIMIT 1) AS latest_run_external_job_id,
                       (SELECT metrics_json FROM evaluation_runs er WHERE er.model_id = pm.model_id ORDER BY er.id DESC LIMIT 1) AS latest_run_metrics_json
                FROM published_models pm
                LEFT JOIN model_review_state mrs ON mrs.model_id = pm.model_id
                ORDER BY COALESCE(pm.source_last_update, pm.last_synced_at) DESC, pm.name ASC
                """
            ).fetchall()

    def get_setting(self, key: str, default: str | None = None) -> str | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT value FROM app_settings WHERE key = ?",
                (key,),
            ).fetchone()
            return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        now = utc_now()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO app_settings (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                """,
                (key, value, now),
            )

    def get_evaluation_mode(self) -> str:
        value = (self.get_setting("evaluation_mode", "manual") or "manual").lower()
        return value if value in {"manual", "auto"} else "manual"

    def get_published_model(self, model_id: str) -> sqlite3.Row | None:
        with self.connect() as conn:
            return conn.execute(
                "SELECT * FROM published_models WHERE model_id = ?",
                (model_id,),
            ).fetchone()

    def create_evaluation_run(
        self,
        model_id: str,
        queue_name: str,
        *,
        evaluation_profile: str | None = None,
        target_dataset: str | None = None,
        request_payload: dict[str, Any] | None = None,
    ) -> int:
        with self.connect() as conn:
            model = conn.execute(
                "SELECT model_id, name FROM published_models WHERE model_id = ?",
                (model_id,),
            ).fetchone()
            if not model:
                raise KeyError(f"Unknown model_id: {model_id}")
            cursor = conn.execute(
                """
                INSERT INTO evaluation_runs (
                    model_id, model_name, queue_name, evaluation_profile,
                    target_dataset, request_payload_json, status, requested_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    model["model_id"],
                    model["name"],
                    queue_name,
                    evaluation_profile,
                    target_dataset,
                    json.dumps(request_payload, ensure_ascii=False) if request_payload else None,
                    "queued",
                    utc_now(),
                ),
            )
            return int(cursor.lastrowid)

    def ensure_evaluation_run(
        self,
        model_id: str,
        queue_name: str,
        *,
        evaluation_profile: str | None = None,
        target_dataset: str | None = None,
        request_payload: dict[str, Any] | None = None,
    ) -> int | None:
        with self.connect() as conn:
            existing = conn.execute(
                "SELECT id FROM evaluation_runs WHERE model_id = ? ORDER BY id DESC LIMIT 1",
                (model_id,),
            ).fetchone()
            if existing:
                return None

            model = conn.execute(
                "SELECT model_id, name FROM published_models WHERE model_id = ?",
                (model_id,),
            ).fetchone()
            if not model:
                raise KeyError(f"Unknown model_id: {model_id}")

            cursor = conn.execute(
                """
                INSERT INTO evaluation_runs (
                    model_id, model_name, queue_name, evaluation_profile,
                    target_dataset, request_payload_json, status, requested_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    model["model_id"],
                    model["name"],
                    queue_name,
                    evaluation_profile,
                    target_dataset,
                    json.dumps(request_payload, ensure_ascii=False) if request_payload else None,
                    "queued",
                    utc_now(),
                ),
            )
            return int(cursor.lastrowid)

    def ensure_auto_evaluation_runs(self, model_ids: list[str], queue_name: str) -> int:
        created = 0
        for model_id in model_ids:
            if self.ensure_evaluation_run(model_id, queue_name) is not None:
                created += 1
        return created

    def list_runs(self) -> list[sqlite3.Row]:
        with self.connect() as conn:
            return conn.execute(
                "SELECT * FROM evaluation_runs ORDER BY id DESC"
            ).fetchall()

    def get_run(self, run_id: int) -> sqlite3.Row | None:
        with self.connect() as conn:
            return conn.execute(
                "SELECT * FROM evaluation_runs WHERE id = ?",
                (run_id,),
            ).fetchone()

    def get_latest_run_for_model(self, model_id: str) -> sqlite3.Row | None:
        with self.connect() as conn:
            return conn.execute(
                "SELECT * FROM evaluation_runs WHERE model_id = ? ORDER BY id DESC LIMIT 1",
                (model_id,),
            ).fetchone()

    def set_deployment_status(
        self,
        model_id: str,
        deployment_status: str,
        note: str | None = None,
    ) -> None:
        allowed = {"pending", "deployed", "hold"}
        if deployment_status not in allowed:
            raise ValueError(f"Unsupported deployment status: {deployment_status}")

        now = utc_now()
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO model_review_state (
                    model_id, deployment_status, deployment_note,
                    deployment_decided_at, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(model_id) DO UPDATE SET
                    deployment_status = excluded.deployment_status,
                    deployment_note = excluded.deployment_note,
                    deployment_decided_at = excluded.deployment_decided_at,
                    updated_at = excluded.updated_at
                """,
                (model_id, deployment_status, note, now, now),
            )

    def claim_next_queued_run(
        self,
        *,
        evaluator_host: str,
        queue_name: str | None = None,
        external_job_id: str | None = None,
        notes: str | None = None,
        callback_payload: dict[str, Any] | None = None,
    ) -> tuple[sqlite3.Row, sqlite3.Row] | None:
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")

            if queue_name:
                run = conn.execute(
                    """
                    SELECT *
                    FROM evaluation_runs
                    WHERE status = 'queued' AND queue_name = ?
                    ORDER BY id ASC
                    LIMIT 1
                    """,
                    (queue_name,),
                ).fetchone()
            else:
                run = conn.execute(
                    """
                    SELECT *
                    FROM evaluation_runs
                    WHERE status = 'queued'
                    ORDER BY id ASC
                    LIMIT 1
                    """
                ).fetchone()

            if not run:
                return None

            fields: list[str] = [
                "status = ?",
                "started_at = COALESCE(started_at, ?)",
                "evaluator_host = ?",
            ]
            values: list[Any] = ["running", utc_now(), evaluator_host]

            if external_job_id is not None:
                fields.append("external_job_id = ?")
                values.append(external_job_id)

            if notes is not None:
                fields.append("notes = ?")
                values.append(notes)

            if callback_payload is not None:
                fields.append("callback_payload = ?")
                values.append(json.dumps(callback_payload, ensure_ascii=False))

            values.append(run["id"])
            conn.execute(
                f"UPDATE evaluation_runs SET {', '.join(fields)} WHERE id = ?",
                values,
            )

            updated_run = conn.execute(
                "SELECT * FROM evaluation_runs WHERE id = ?",
                (run["id"],),
            ).fetchone()
            model = conn.execute(
                "SELECT * FROM published_models WHERE model_id = ?",
                (run["model_id"],),
            ).fetchone()

            if not updated_run or not model:
                return None

            return updated_run, model

    def update_run(
        self,
        run_id: int,
        *,
        status: str,
        evaluator_host: str | None = None,
        external_job_id: str | None = None,
        result_summary: str | None = None,
        metrics: dict[str, Any] | None = None,
        notes: str | None = None,
        callback_payload: dict[str, Any] | None = None,
    ) -> None:
        allowed = {"queued", "running", "completed", "failed", "canceled"}
        if status not in allowed:
            raise ValueError(f"Unsupported run status: {status}")

        fields: list[str] = ["status = ?"]
        values: list[Any] = [status]

        if status == "running":
            fields.append("started_at = COALESCE(started_at, ?)")
            values.append(utc_now())

        if status in {"completed", "failed", "canceled"}:
            fields.append("finished_at = ?")
            values.append(utc_now())

        if evaluator_host is not None:
            fields.append("evaluator_host = ?")
            values.append(evaluator_host)

        if external_job_id is not None:
            fields.append("external_job_id = ?")
            values.append(external_job_id)

        if result_summary is not None:
            fields.append("result_summary = ?")
            values.append(result_summary)

        if metrics is not None:
            fields.append("metrics_json = ?")
            values.append(json.dumps(metrics, ensure_ascii=False))

        if notes is not None:
            fields.append("notes = ?")
            values.append(notes)

        if callback_payload is not None:
            fields.append("callback_payload = ?")
            values.append(json.dumps(callback_payload, ensure_ascii=False))

        values.append(run_id)

        with self.connect() as conn:
            conn.execute(
                f"UPDATE evaluation_runs SET {', '.join(fields)} WHERE id = ?",
                values,
            )

    def status_summary(self) -> dict[str, int]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT status, COUNT(*) AS count FROM evaluation_runs GROUP BY status"
            ).fetchall()
            result = {"queued": 0, "running": 0, "completed": 0, "failed": 0, "canceled": 0}
            for row in rows:
                result[row["status"]] = row["count"]
            return result
