# Model Evaluation Console

Lightweight web application for orchestrating published ClearML models through an external Windows evaluation tool.

## What It Does

- Reads candidate published models from the local ClearML MongoDB metadata store.
- Tracks evaluation state in a local SQLite database.
- Shows a dashboard for:
  - published model candidates
  - queued evaluations
  - running evaluations
  - completed evaluations
  - failed evaluations
- Exposes JSON APIs so a Windows bridge service can claim work, mark runs as running, and report results.

## Publish Detection Rule

This first version uses a pragmatic heuristic for "published" models:

- model `tags` or `system_tags` contains `published`, `deploy`, or `prod`
- or model name starts with one of the configured prefixes

Default prefixes:

- `[배포]`
- `deploy`
- `published`

You can adjust this with environment variables.

## Directory Layout

```text
model_eval_console/
  app/
    main.py
    config.py
    db.py
    sync.py
    templates/
    static/
  requirements.txt
```

## Run

```bash
cd /opt/clearml/model_eval_console
python3 -m pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8090
```

Then open:

```text
http://172.16.15.243:8090
```

## Environment Variables

- `MODEL_EVAL_DB_PATH`
  - default: `/opt/clearml/model_eval_console/data/console.db`
- `MODEL_EVAL_MONGO_URI`
  - default: `mongodb://localhost:27017`
- `MODEL_EVAL_MONGO_DB`
  - default: `backend`
- `MODEL_EVAL_PUBLISH_PREFIXES`
  - default: `[배포],deploy,published`
- `MODEL_EVAL_PUBLISH_MARKERS`
  - default: `published,deploy,prod`
- `MODEL_EVAL_SYNC_INTERVAL_SEC`
  - default: `60`
- `MODEL_EVAL_DEFAULT_QUEUE`
  - default: `eval-windows`
- `MODEL_EVAL_BRIDGE_TOKEN`
  - optional shared token for callback APIs from the Windows bridge

## Intended Bridge Flow

1. User publishes a model in ClearML.
2. This app detects the model and shows it in the dashboard.
3. Operator queues evaluation for the model.
4. Windows bridge polls or receives the queued run.
5. Bridge launches the C++ evaluator.
6. Bridge posts status and results back to this app.
7. Operators review completion state and metrics in the web UI.

## Evaluation Request Fields

When queuing a model from the dashboard, the operator can provide:

- `queue_name`
- `evaluation_profile`
- `target_dataset`
- `request_payload` JSON

These values are stored with the evaluation run and returned to the Windows bridge in the `claim-next` response.

Example request payload:

```json
{
  "threshold": 0.5,
  "batch_size": 8,
  "scenario": "night-driving"
}
```

## Bridge API

The Windows bridge service can use the following endpoints.

Base URL:

```text
http://172.16.15.243:8090
```

Optional header when `MODEL_EVAL_BRIDGE_TOKEN` is configured:

```text
x-bridge-token: <shared-token>
```

### Health Check

```http
GET /api/health
```

Response example:

```json
{
  "ok": true,
  "last_error": null,
  "last_synced_count": 161
}
```

### Claim Next Queued Run

```http
POST /api/bridge/claim-next
Content-Type: application/json
```

Request body example:

```json
{
  "evaluator_host": "WIN-EVAL-01",
  "queue_name": "eval-windows",
  "external_job_id": "job-20260415-0001"
}
```

Response when a job exists:

```json
{
  "ok": true,
  "item": {
    "run": {
      "id": 12,
      "model_id": "398bc17ac3494e49af62079d9705ce6f",
      "status": "running",
      "queue_name": "eval-windows",
      "evaluation_profile": "default-yolov8",
      "target_dataset": "night-validation",
      "request_payload": {
        "threshold": 0.5,
        "batch_size": 8
      }
    },
    "model": {
      "model_id": "398bc17ac3494e49af62079d9705ce6f",
      "name": "VLM_Dataset",
      "uri": "http://..."
    }
  }
}
```

Response when no queued job exists:

```json
{
  "ok": true,
  "item": null
}
```

### Update Run Status

The bridge can report state changes using the callback API.

```http
POST /api/bridge/callback
Content-Type: application/json
```

Request body example:

```json
{
  "run_id": 12,
  "status": "completed",
  "evaluator_host": "WIN-EVAL-01",
  "external_job_id": "job-20260415-0001",
  "result_summary": "mAP50=0.941, latency=12.3ms",
  "metrics": {
    "map50": 0.941,
    "latency_ms": 12.3
  },
  "notes": "evaluation finished successfully"
}
```

Supported callback statuses:

- `running`
- `completed`
- `failed`
- `canceled`

## Notes

- This app does not modify ClearML internals.
- It reads model metadata from MongoDB and maintains evaluation workflow state in SQLite.
- It is designed as an orchestration console, not as the evaluation worker itself.
