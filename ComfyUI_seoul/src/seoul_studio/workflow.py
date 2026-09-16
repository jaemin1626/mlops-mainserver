import copy
import json
from dataclasses import dataclass
from typing import Any, Optional

from seoul_studio.job import JobRequest
from seoul_studio.paths import repo_root, workflow_dir

__all__ = [
    "WorkflowBundle",
    "WorkflowNotFoundError",
    "apply_job_to_workflow",
    "load_workflow_bundle",
    "repo_root",
    "workflow_dir",
]


class WorkflowNotFoundError(RuntimeError):
    pass


@dataclass
class WorkflowBundle:
    prompt: dict[str, Any]
    mapping: dict[str, str]


def load_workflow_bundle(mode: str) -> WorkflowBundle:
    root = workflow_dir()
    prompt_path = root / f"{mode}_api.json"
    mapping_path = root / "mapping.json"
    if not prompt_path.is_file():
        raise WorkflowNotFoundError(
            f"이 워크플로 폴더에는 {mode} 워크플로가 없습니다: {prompt_path}"
        )
    prompt = json.loads(prompt_path.read_text(encoding="utf-8"))
    mapping_all = json.loads(mapping_path.read_text(encoding="utf-8"))
    if mode not in mapping_all:
        raise WorkflowNotFoundError(
            f"이 워크플로 폴더의 mapping.json에 {mode} 항목이 없습니다: {mapping_path}"
        )
    return WorkflowBundle(prompt=prompt, mapping=mapping_all[mode])


def apply_job_to_workflow(
    graph: dict[str, Any],
    mapping: dict[str, str],
    job: JobRequest,
    uploaded_image_name: Optional[str] = None,
) -> dict[str, Any]:
    patched = copy.deepcopy(graph)

    _set_input(patched, mapping, "prompt_node", "prompt_input", job.prompt)
    _set_input(patched, mapping, "negative_node", "negative_input", job.negative_prompt)
    _set_input(patched, mapping, "seed_node", "seed_input", job.seed)
    _set_input(patched, mapping, "seed_node_2", "seed_input", job.seed)

    if "megapixels_node" in mapping:
        _set_input(patched, mapping, "megapixels_node", "megapixels_input", job.megapixels)
        _set_input(patched, mapping, "aspect_ratio_node", "aspect_ratio_input", job.aspect_ratio)
        _set_input(patched, mapping, "length_node", "length_input", job.duration_sec)
    elif "width_node" in mapping:
        _set_input(patched, mapping, "width_node", "width_input", job.width)
        _set_input(patched, mapping, "height_node", "height_input", job.height)
        _set_input(patched, mapping, "length_node", "length_input", job.duration_sec)
    else:
        _set_input(patched, mapping, "size_node", "width_input", job.width)
        _set_input(patched, mapping, "size_node", "height_input", job.height)
        _set_input(patched, mapping, "size_node", "length_input", job.duration_sec)

    _set_input(patched, mapping, "fps_node", "fps_input", job.fps)

    if "t2v_mode_node" in mapping:
        _set_input(patched, mapping, "t2v_mode_node", "t2v_mode_input", False)

    if uploaded_image_name and "image_node" in mapping:
        _set_input(patched, mapping, "image_node", "image_input", uploaded_image_name)

    return patched


def _set_input(
    graph: dict[str, Any],
    mapping: dict[str, str],
    node_key: str,
    input_key: str,
    value: Any,
) -> None:
    if node_key not in mapping or input_key not in mapping:
        return
    node_id = mapping[node_key]
    input_name = mapping[input_key]
    graph[node_id]["inputs"][input_name] = value
