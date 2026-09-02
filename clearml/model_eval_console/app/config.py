from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


@dataclass(slots=True)
class Settings:
    app_title: str
    app_host: str
    app_port: int
    db_path: Path
    mongo_uri: str
    mongo_db: str
    elastic_uri: str
    publish_prefixes: list[str]
    publish_markers: list[str]
    sync_interval_sec: int
    default_queue: str
    bridge_token: str | None


def load_settings() -> Settings:
    db_path = Path(
        os.getenv(
            "MODEL_EVAL_DB_PATH",
            "/opt/clearml/model_eval_console/data/console.db",
        )
    )
    return Settings(
        app_title=os.getenv("MODEL_EVAL_APP_TITLE", "Model Evaluation Console"),
        app_host=os.getenv("MODEL_EVAL_HOST", "0.0.0.0"),
        app_port=int(os.getenv("MODEL_EVAL_PORT", "8090")),
        db_path=db_path,
        mongo_uri=os.getenv("MODEL_EVAL_MONGO_URI", "mongodb://localhost:27017"),
        mongo_db=os.getenv("MODEL_EVAL_MONGO_DB", "backend"),
        elastic_uri=os.getenv("MODEL_EVAL_ELASTIC_URI", "http://localhost:9200"),
        publish_prefixes=_split_csv(
            os.getenv("MODEL_EVAL_PUBLISH_PREFIXES", "[배포],deploy,published")
        ),
        publish_markers=_split_csv(
            os.getenv("MODEL_EVAL_PUBLISH_MARKERS", "published,deploy,prod")
        ),
        sync_interval_sec=int(os.getenv("MODEL_EVAL_SYNC_INTERVAL_SEC", "60")),
        default_queue=os.getenv("MODEL_EVAL_DEFAULT_QUEUE", "eval-windows"),
        bridge_token=os.getenv("MODEL_EVAL_BRIDGE_TOKEN") or None,
    )
