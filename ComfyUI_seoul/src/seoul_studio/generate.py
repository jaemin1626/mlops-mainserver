from seoul_studio.comfy_client import ComfyClient, GenerationResult
from seoul_studio.config import AppConfig, effective_output_dir
from seoul_studio.job import JobRequest


def run_generation(
    config: AppConfig,
    job: JobRequest,
    on_progress=None,
    on_log=None,
    on_event=None,
) -> GenerationResult:
    client = ComfyClient(config.server_url)
    return client.run_job(
        job,
        str(effective_output_dir(config)),
        on_progress=on_progress,
        on_log=on_log,
        on_event=on_event,
    )
