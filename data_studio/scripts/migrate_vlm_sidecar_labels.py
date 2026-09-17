#!/usr/bin/env python3
"""Copy legacy VLM labels next to their referenced media files.

The legacy *_json folders are intentionally retained as a rollback copy.
"""
import argparse
import json
import shutil
from pathlib import Path


def media_path(root: Path, value: str) -> Path:
    normalized = value.replace('\\', '/')
    prefixes = ('/data/datasets/vlm/', '/workspace/Dataset/vlm/', '/home/intellivix/train/Dataset/vlm/')
    for prefix in prefixes:
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix):]
            break
    # Legacy labels commonly use ../images/... relative to the old *_json root.
    while normalized.startswith('../'):
        normalized = normalized[3:]
    candidate = (root / normalized.lstrip('/')).resolve()
    if not candidate.is_relative_to(root.resolve()):
        raise ValueError('media path is outside Dataset/vlm')
    return candidate


def migrate(root: Path, apply: bool) -> dict[str, int]:
    counts = {key: 0 for key in ('labels', 'copied', 'identical', 'conflict', 'missing', 'invalid')}
    for legacy in ('images_json', 'videos_json', 'image_json', 'video_json'):
        source_root = root / legacy
        if not source_root.is_dir():
            continue
        for source in sorted(source_root.rglob('*.json')):
            try:
                value = json.loads(source.read_text(encoding='utf-8'))
                rows = value if isinstance(value, list) else [value]
                if not rows or not all(isinstance(row, dict) for row in rows):
                    raise ValueError('label must contain an object or object array')
            except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
                counts['invalid'] += 1
                continue
            for row in rows:
                counts['labels'] += 1
                ref = row.get('image') or row.get('video')
                try:
                    if not isinstance(ref, str) or not ref:
                        raise ValueError('missing image/video')
                    media = media_path(root, ref)
                except ValueError:
                    counts['invalid'] += 1
                    continue
                if not media.is_file():
                    # Some legacy rows contain a stale path but their *_json
                    # location still mirrors the real media directory.
                    rel = source.relative_to(source_root).with_suffix('')
                    media_root = root / ('videos' if 'video' in legacy else 'images')
                    suffixes = ('.mp4', '.avi', '.mov', '.mkv', '.webm') if 'video' in legacy else ('.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff')
                    inferred = next((media_root / rel.parent / (rel.name + ext) for ext in suffixes if (media_root / rel.parent / (rel.name + ext)).is_file()), None)
                    if inferred is None:
                        counts['missing'] += 1
                        continue
                    media = inferred.resolve()
                destination = media.with_suffix('.json')
                migrated = dict(row)
                field = 'video' if isinstance(row.get('video'), str) and row.get('video') else 'image'
                migrated[field] = 'vlm/' + media.relative_to(root).as_posix()
                content = json.dumps(migrated, ensure_ascii=False, indent=2) + '\n'
                if destination.exists():
                    try:
                        current = json.loads(destination.read_text(encoding='utf-8'))
                    except (OSError, UnicodeError, json.JSONDecodeError):
                        counts['conflict'] += 1
                        continue
                    if current == migrated:
                        counts['identical'] += 1
                        continue
                    # A previous interrupted migration may have copied the old
                    # ../images or ../videos value. It is safe to normalize it.
                    if current == row and apply:
                        destination.write_text(content, encoding='utf-8')
                        counts['copied'] += 1
                        continue
                    if current == row:
                        counts['copied'] += 1
                    else:
                        counts['conflict'] += 1
                    continue
                if apply:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_text(content, encoding='utf-8')
                    shutil.copystat(source, destination)
                counts['copied'] += 1
    return counts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('/opt/clearml/data/datasets/vlm'))
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    result = migrate(args.root.resolve(), args.apply)
    result['mode'] = 'apply' if args.apply else 'dry-run'
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result['conflict']:
        raise SystemExit(2)


if __name__ == '__main__':
    main()
