import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


DEFAULT_SERVER_URL = ""


def normalize_server_url(raw: str) -> str:
    url = raw.strip().rstrip("/")
    if url.endswith("/prompt"):
        url = url[: -len("/prompt")]
    return url.rstrip("/")


@dataclass
class AppConfig:
    server_url: str
    output_dir: str
    output_subdir: str = ""

    def normalized(self) -> "AppConfig":
        subdir = self.output_subdir.strip().strip("/")
        if subdir in {"", ".", "./"}:
            subdir = ""
        return AppConfig(
            server_url=normalize_server_url(self.server_url),
            output_dir=self.output_dir.strip(),
            output_subdir=subdir,
        )


def effective_output_dir(config: AppConfig) -> Path:
    base = Path(config.output_dir)
    if config.output_subdir:
        return base / config.output_subdir
    return base


def default_output_dir() -> str:
    return str(Path.home() / "Videos" / "SeoulStudio")


def default_config() -> AppConfig:
    return AppConfig(
        server_url=DEFAULT_SERVER_URL,
        output_dir=default_output_dir(),
    ).normalized()


def default_config_path() -> Path:
    return Path.home() / ".seoul-studio" / "config.json"


def load_config(path: Path) -> AppConfig:
    defaults = default_config()
    if not path.is_file():
        return defaults
    raw: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return AppConfig(
        server_url=normalize_server_url(str(raw.get("server_url") or defaults.server_url)),
        output_dir=str(raw.get("output_dir") or defaults.output_dir),
        output_subdir=str(raw.get("output_subdir") or defaults.output_subdir),
    ).normalized()


def save_config(config: AppConfig, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    normalized = config.normalized()
    path.write_text(
        json.dumps(asdict(normalized), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
