"""Generate disjoint randomized image lists, preserving dataset-relative paths."""
import json
import random
from pathlib import Path

def build(folders, remote_root, out_dir, seed=None, dataset_root=None):
    root = Path(dataset_root).resolve() if dataset_root else Path(folders[0]).resolve().parent
    files = set()
    for folder in folders:
        for p in Path(folder).rglob('*'):
            if p.suffix.lower() not in {'.jpg', '.jpeg', '.png', '.bmp', '.webp'} or not p.is_file():
                continue
            resolved = p.resolve()
            if not resolved.is_relative_to(root):
                raise ValueError('Image outside dataset root')
            files.add(remote_root.rstrip('/')+'/'+resolved.relative_to(root).as_posix())
    files = sorted(files)
    if len(files) < 2:
        raise ValueError('9:1 분할에는 이미지가 최소 2개 필요합니다.')
    random.Random(seed).shuffle(files)
    cut = max(1, min(len(files)-1, round(len(files)*0.9)))
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for name, items in [('train', files[:cut]), ('val', files[cut:])]:
        (out/(name+'.json')).write_text(json.dumps(items, ensure_ascii=False, indent=2)+'\n')
    return cut, len(files)-cut


def validate_classes(classes):
    if not isinstance(classes, list) or not 1 <= len(classes) <= 1000:
        raise ValueError('클래스를 1~1000개 입력하세요.')
    result = []
    for name in classes:
        if not isinstance(name, str) or not name.strip() or len(name) > 120 or any(ord(c) < 32 or ord(c) == 127 for c in name):
            raise ValueError('클래스 이름은 비어 있거나 제어 문자를 포함할 수 없습니다.')
        result.append(name.strip())
    if len(set(result)) != len(result):
        raise ValueError('클래스 이름이 중복됩니다.')
    return result


def detector_bundle(folders, remote_root, out_dir, classes, dataset_root):
    """Create two TXT image manifests and a YOLO YAML; existing box labels are retained."""
    classes = validate_classes(classes)
    root = Path(dataset_root).resolve()
    if not isinstance(remote_root, str) or not remote_root.startswith('/') or '..' in Path(remote_root).parts or any(ord(c) < 32 for c in remote_root):
        raise ValueError('Invalid training image root')
    images = set()
    for raw in folders:
        folder = Path(raw).resolve()
        if not folder.is_relative_to(root) or not folder.is_dir():
            raise ValueError('Dataset folder not found')
        for image in folder.rglob('*'):
            if image.suffix.lower() not in {'.jpg', '.jpeg', '.png', '.bmp', '.webp', '.tif', '.tiff'} or not image.is_file():
                continue
            image = image.resolve()
            if not image.is_relative_to(root):
                raise ValueError('Image outside dataset root')
            if any(ord(c) < 32 or ord(c) == 127 for c in str(image)) or '\\' in str(image):
                raise ValueError('이미지 경로에 지원하지 않는 문자가 있습니다.')
            images.add(image)
    if len(images) < 2:
        raise ValueError('9:1 분할에는 이미지가 최소 2개 필요합니다.')
    missing_labels = 0
    for image in sorted(images):
        # YOLO: replace the last images/ directory with labels/, or use a sibling TXT.
        rel = image.relative_to(root)
        parts = list(rel.parts)
        indices = [i for i, part in enumerate(parts[:-1]) if part == 'images']
        if indices:
            parts[indices[-1]] = 'labels'
        label = (root / Path(*parts)).with_suffix('.txt')
        if not label.resolve().is_relative_to(root):
            raise ValueError('Label outside dataset root')
        if not label.is_file():
            missing_labels += 1
            continue
        for line_no, line in enumerate(label.read_text(encoding='utf-8').splitlines(), 1):
            tokens = line.split()
            if not tokens:
                continue
            if not tokens[0].isascii() or not tokens[0].isdigit() or int(tokens[0]) >= len(classes):
                raise ValueError(f'{label.relative_to(root)}:{line_no}: 클래스 ID가 0~{len(classes)-1} 범위를 벗어납니다.')
    files = [remote_root.rstrip('/') + '/' + image.relative_to(root).as_posix() for image in sorted(images)]
    random.Random(42).shuffle(files)
    cut = max(1, min(len(files)-1, round(len(files)*0.9)))
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for name, items in [('train', files[:cut]), ('valid', files[cut:]), ('test', files[cut:])]:
        (out / (name+'.txt')).write_text('\n'.join(items)+'\n', encoding='utf-8')
    # No host-specific YAML root: resolve manifests next to the YAML in the training container.
    names = '\n'.join(f'  {index}: {json.dumps(name, ensure_ascii=False)}' for index, name in enumerate(classes))
    yaml = '\n'.join([
        '# YOLO dataset config for detector training',
        '# Images live at: /workspace/Dataset/detector/',
        '# Split lists at: /workspace/Detector/data/generated/<timestamp>/',
        '',
        'path: /workspace/Dataset/detector',
        'train: /workspace/Detector/data/generated/<timestamp>/train.txt',
        'val: /workspace/Detector/data/generated/<timestamp>/valid.txt',
        'test: /workspace/Detector/data/generated/<timestamp>/test.txt',
        '',
        'names:', names, '',
        '# Quick test with built-in sample dataset:',
        '# DATA=coco8.yaml'])+'\n'
    (out / 'data.yaml').write_text(yaml, encoding='utf-8')
    return {'train': cut, 'test': len(files)-cut, 'classes': classes,
            'missing_labels': missing_labels, 'yaml': yaml}
