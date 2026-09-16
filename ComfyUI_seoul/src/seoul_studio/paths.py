import os
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def workflow_dir() -> Path:
    override = os.environ.get("SEOUL_STUDIO_WORKFLOW_DIR")
    if override:
        return Path(override)
    return repo_root() / "workflows"
