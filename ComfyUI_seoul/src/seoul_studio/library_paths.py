"""브라우저·비식별화 경로 규칙."""

from __future__ import annotations

from pathlib import Path

ANONY_DIR = "Anony"
MEDIA_FILTER_ORIGINAL = "original"
MEDIA_FILTER_ANONYMIZED = "anonymized"
MEDIA_FILTER_ALL = "all"
MEDIA_FILTERS = {MEDIA_FILTER_ORIGINAL, MEDIA_FILTER_ANONYMIZED, MEDIA_FILTER_ALL}
RESERVED_DIR_NAMES = {ANONY_DIR}


def normalize_media_filter(raw: str | None) -> str:
    value = str(raw or MEDIA_FILTER_ALL).strip().lower()
    if value not in MEDIA_FILTERS:
        return MEDIA_FILTER_ALL
    return value


def is_anony_relpath(relpath: str) -> bool:
    return ANONY_DIR in Path(relpath).parts


def is_legacy_anony_filename(name: str) -> bool:
    stem = Path(name).stem.lower()
    return stem.endswith("_anony") or stem.endswith(".anony")


def media_kind_for_relpath(relpath: str) -> str:
    if is_anony_relpath(relpath) or is_legacy_anony_filename(relpath):
        return MEDIA_FILTER_ANONYMIZED
    return MEDIA_FILTER_ORIGINAL


def anony_dir_for(parent: Path) -> Path:
    return parent / ANONY_DIR


def anony_video_candidates(source: Path) -> list[Path]:
    source = Path(source).resolve()
    parent = source.parent
    stem = source.stem
    suffix = source.suffix
    names = [
        anony_dir_for(parent) / source.name,
        anony_dir_for(parent) / f"{stem}_anony{suffix}",
        parent / f"{stem}_anony{suffix}",
    ]
    seen: set[Path] = set()
    out: list[Path] = []
    for candidate in names:
        resolved = candidate.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        if resolved.is_file():
            out.append(resolved)
    return out


def resolve_preferred_video_path(source: Path, root: Path, *, prefer_anonymized: bool) -> tuple[Path, str]:
    source = Path(source).resolve()
    root = Path(root).resolve()
    relpath = source.relative_to(root).as_posix()

    if not prefer_anonymized:
        return source, relpath

    if media_kind_for_relpath(relpath) == MEDIA_FILTER_ANONYMIZED:
        return source, relpath

    for candidate in anony_video_candidates(source):
        return candidate, candidate.relative_to(root).as_posix()
    return source, relpath


def anony_dest_for_source(source: Path, unique_dest_path_fn) -> Path:
    source = Path(source).resolve()
    dest_dir = anony_dir_for(source.parent)
    dest_dir.mkdir(parents=True, exist_ok=True)
    return unique_dest_path_fn(dest_dir, source.name)


def resolve_source_path(root: Path, relpath: str) -> Path:
    """출력 루트 아래 상대 경로 → 절대 Path (파일 존재 검증)."""
    root = Path(root).resolve()
    if not relpath or ".." in Path(relpath).parts:
        raise FileNotFoundError(f"잘못된 파일 경로입니다: {relpath}")
    path = (root / relpath).resolve()
    try:
        path.relative_to(root)
    except ValueError as exc:
        raise FileNotFoundError(f"파일을 찾을 수 없습니다: {relpath}") from exc
    if not path.is_file():
        raise FileNotFoundError(f"파일을 찾을 수 없습니다: {relpath}")
    return path
