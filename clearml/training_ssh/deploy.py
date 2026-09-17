"""Model deployment helpers.

Lists already-trained Detector/VLM models and lets an operator either:
  - export a chosen Detector .pt checkpoint to ONNX with custom input size /
    confidence / IoU settings (reusing the existing remote
    scripts/export.sh Docker entrypoint), or
  - download a trained VLM model folder as a zip (for manual upload to vLLM).

Nothing here trains a model or changes training defaults; it only reads the
remote filesystem and re-runs the existing export script with per-request
overrides, so the training server's own train.env defaults are untouched.
"""
import datetime
import json
import logging
import os
import re
import shlex
import subprocess
import threading
import uuid
from pathlib import PurePosixPath

from client import ssh_command, TRAINING_ROOT as _TRAINING_ROOT_STR
from detector import BASE as DETECTOR_BASE, JOBS, validate_path
from vlm import resources as vlm_resources

LOG = logging.getLogger('deploy')

TRAINING_ROOT = PurePosixPath(_TRAINING_ROOT_STR)
RUN_EXPORT_SCRIPT = './scripts/export.sh'
VLM_TRAINED_ROOT = TRAINING_ROOT / 'VLM/runs/train'
DEPLOY_HISTORY_FILE = os.environ.get('DEPLOY_HISTORY_FILE', '/data/deploy/history.json')

_INT_BOUNDS = {
    'imgsz_h': (32, 4096, 640),
    'imgsz_w': (32, 4096, 640),
    'batch': (1, 64, 1),
    'opset': (11, 22, 17),
    'max_det': (1, 2000, 300),
}
_RATIO_BOUNDS = {
    'conf': 0.2,
    'iou': 0.5,
}


def _child_env():
    return JOBS.child_env()


# Detector 학습 화면(train/app.js)의 '모델 크기' 선택이 실제로 매핑되는 기본 가중치.
# 배포 목록에 학습 시 사용한 크기를 보여주기 위해 역방향으로 이 매핑을 사용한다.
_MODEL_SIZE_BY_BASENAME = {
    'yolo26n.pt': 'Small',
    'yolo26l.pt': 'Medium',
    'yolo26x.pt': 'Large',
}
_ARGS_MODEL_RE = re.compile(r'^(.*/args\.yaml):model:\s*(\S+)\s*$')


def _detector_model_sizes(root):
    """run 폴더별 학습 시 사용한 기본 모델 크기(Small/Medium/Large). 조회 실패 시 빈 dict."""
    remote = f"grep -H '^model:' {shlex.quote(str(root))}/*/args.yaml 2>/dev/null"
    result = subprocess.run(ssh_command(remote), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, errors='replace', timeout=15, env=_child_env())
    sizes = {}
    for line in result.stdout.splitlines():
        match = _ARGS_MODEL_RE.match(line)
        if not match:
            continue
        run_dir = str(PurePosixPath(match.group(1)).parent)
        sizes[run_dir] = _MODEL_SIZE_BY_BASENAME.get(PurePosixPath(match.group(2)).name)
    return sizes


def list_detector_models():
    """Trained Detector checkpoints (best.pt) under runs/Detector, newest first."""
    root = DETECTOR_BASE / 'runs/Detector'
    remote = (
        f"find {shlex.quote(str(root))} -maxdepth 3 -name best.pt "
        "-printf '%T@ %s %p\\n' 2>/dev/null; "
        f"find {shlex.quote(str(root))} -maxdepth 3 -name '*.onnx' "
        "-printf '%p\\n' 2>/dev/null"
    )
    result = subprocess.run(ssh_command(remote), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, errors='replace', timeout=30, env=_child_env())
    if result.returncode != 0:
        raise RuntimeError('학습된 Detector 모델 목록을 가져오지 못했습니다.')
    lines = result.stdout.splitlines()
    onnx_by_dir = {}
    for line in lines:
        if line.endswith('.onnx'):
            onnx_by_dir.setdefault(str(PurePosixPath(line).parent), []).append(PurePosixPath(line).name)
    model_sizes = _detector_model_sizes(root)
    models = []
    for line in lines:
        if not line.endswith('best.pt'):
            continue
        mtime, size, path = line.split(' ', 2)
        directory = str(PurePosixPath(path).parent)
        run_dir = str(PurePosixPath(path).parent.parent)
        models.append(dict(
            path=path,
            run_name=PurePosixPath(run_dir).name,
            model_size=model_sizes.get(run_dir),
            size=int(size),
            mtime=float(mtime),
            onnx_files=sorted(onnx_by_dir.get(directory, [])),
        ))
    models.sort(key=lambda m: m['mtime'], reverse=True)
    return models


def list_vlm_models():
    """Trained VLM model folders (already has config.json), from the shared VLM probe."""
    return vlm_resources().get('trained_models', [])


def _positive_int(params, key):
    lo, hi, default = _INT_BOUNDS[key]
    value = params.get(key)
    if value in (None, ''):
        value = default
    try:
        value = int(value)
    except (TypeError, ValueError):
        raise ValueError(f'{key}: 정수를 입력하세요.')
    if not lo <= value <= hi:
        raise ValueError(f'{key}: {lo}~{hi} 범위로 입력하세요.')
    return value


def _ratio(params, key):
    default = _RATIO_BOUNDS[key]
    value = params.get(key)
    if value in (None, ''):
        value = default
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise ValueError(f'{key}: 숫자를 입력하세요.')
    if not 0 <= value <= 1:
        raise ValueError(f'{key}: 0~1 사이 값을 입력하세요.')
    return value


def validate_export_params(params):
    if not isinstance(params, dict):
        raise ValueError('요청 형식이 올바르지 않습니다.')
    weights = params.get('weights')
    validate_path('weights', weights)
    imgsz_h = _positive_int(params, 'imgsz_h')
    imgsz_w = imgsz_h if params.get('imgsz_w') in (None, '') else _positive_int(params, 'imgsz_w')
    return dict(
        weights=weights,
        imgsz_h=imgsz_h,
        imgsz_w=imgsz_w,
        batch=_positive_int(params, 'batch'),
        opset=_positive_int(params, 'opset'),
        max_det=_positive_int(params, 'max_det'),
        conf=_ratio(params, 'conf'),
        iou=_ratio(params, 'iou'),
    )


def export_output_paths(weights, imgsz_h, imgsz_w):
    """Mirrors Detector/scripts/train/export.py's own output naming exactly."""
    stem = PurePosixPath(weights).stem
    size_tag = str(imgsz_h) if imgsz_h == imgsz_w else f'{imgsz_h}x{imgsz_w}'
    directory = PurePosixPath(weights).parent
    return dict(
        raw=str(directory / f'{stem}_{size_tag}_nms.onnx'),
        final=str(directory / f'{stem}_{size_tag}_e_nms.onnx'),
    )


def _validate_onnx_path(path):
    if not isinstance(path, str) or not path or len(path) > 1024:
        raise ValueError('path: invalid path')
    if any(ord(c) < 32 or ord(c) == 127 for c in path) or '\\' in path:
        raise ValueError('path: invalid path')
    candidate = PurePosixPath(path)
    if '..' in candidate.parts:
        raise ValueError('path: parent traversal is forbidden')
    resolved = candidate if candidate.is_absolute() else DETECTOR_BASE / candidate
    roots = [DETECTOR_BASE / 'weights', DETECTOR_BASE / 'runs/Detector']
    if resolved.suffix != '.onnx' or not any(resolved.is_relative_to(root) for root in roots):
        raise ValueError('path: path is outside permitted server directories')
    return str(resolved)


def onnx_test_command(path):
    resolved = _validate_onnx_path(path)
    # test/[ doesn't understand `--` as an end-of-options marker; safe here since
    # resolved is always an absolute path (starts with '/', never with '-').
    return ssh_command(f'test -f {shlex.quote(resolved)}'), resolved


def onnx_cat_command(path):
    resolved = _validate_onnx_path(path)
    return ssh_command(f'cat -- {shlex.quote(resolved)}')


def _validate_vlm_model_path(path):
    if not isinstance(path, str) or not path or len(path) > 1024:
        raise ValueError('path: invalid path')
    if any(ord(c) < 32 or ord(c) == 127 for c in path) or '\\' in path:
        raise ValueError('path: invalid path')
    prefix = '/workspace/VLM/'
    if not path.startswith(prefix):
        raise ValueError('path: 허용된 VLM 모델 경로가 아닙니다.')
    relative = path[len(prefix):]
    if '..' in PurePosixPath(relative).parts:
        raise ValueError('path: parent traversal is forbidden')
    candidate = TRAINING_ROOT / 'VLM' / relative
    if not candidate.is_relative_to(VLM_TRAINED_ROOT) or candidate == VLM_TRAINED_ROOT:
        raise ValueError('path: 허용된 VLM 모델 경로가 아닙니다.')
    return candidate


def vlm_test_command(path):
    directory = _validate_vlm_model_path(path)
    return ssh_command(f'test -d {shlex.quote(str(directory / 'best'))} && test -r {shlex.quote(str(directory / 'best' / 'adapter_model.safetensors'))}'), directory


def vlm_zip_command(path):
    directory = _validate_vlm_model_path(path)
    remote = f'cd -- {shlex.quote(str(directory))} && zip -rq - -- best'
    return ssh_command(remote)


def export_remote_command(validated):
    """Build the training-host command; export.sh launches export.py inside Detector Docker."""
    args = [
        RUN_EXPORT_SCRIPT,
        '--weights', str(validated['weights']),
        '--height', str(validated['imgsz_h']),
        '--width', str(validated['imgsz_w']),
        '--confidence', str(validated['conf']),
        '--iou', str(validated['iou']),
        '--max-detections', str(validated['max_det']),
        '--opset', str(validated['opset']),
    ]
    return f'cd -- {shlex.quote(str(TRAINING_ROOT))} && {shlex.join(args)}'


class ExportJobs:
    """Tracks async Docker-backed `scripts/export.sh` invocations, one at a time."""

    def __init__(self):
        self.lock = threading.Lock()
        self.history_lock = threading.Lock()
        self.jobs = {}

    def start(self, params):
        validated = validate_export_params(params)
        if JOBS.active() or JOBS.remote_running('detector') or JOBS.remote_running('vlm'):
            raise RuntimeError('학습 중에는 모델을 변환할 수 없습니다.')
        with self.lock:
            if any(job['status'] in {'queued', 'running'} for job in self.jobs.values()):
                raise RuntimeError('이미 변환 작업이 진행 중입니다.')
            job_id = uuid.uuid4().hex
            outputs = export_output_paths(validated['weights'], validated['imgsz_h'], validated['imgsz_w'])
            self.jobs[job_id] = dict(
                id=job_id, status='queued', logs='', exit_code=None, error=None,
                params=validated, outputs=outputs,
                deployed_by=str(params.get('deployed_by') or '사용자'),
                project_name=str(params.get('project_name') or PurePosixPath(validated['weights']).parents[1].name),
                requested_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            )
            while len(self.jobs) > 50:
                del self.jobs[next(iter(self.jobs))]
        threading.Thread(target=self._run, args=(job_id, validated), daemon=True).start()
        return self.get(job_id)

    def get(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            return dict(job) if job else None

    def _append(self, job_id, text):
        if not text:
            return
        with self.lock:
            job = self.jobs[job_id]
            job['logs'] = (job['logs'] + text)[-65536:]

    def _read_history(self):
        try:
            with open(DEPLOY_HISTORY_FILE, encoding='utf-8') as stream:
                data = json.load(stream)
            return data if isinstance(data, list) else []
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return []

    def history(self):
        with self.history_lock:
            return self._read_history()

    def _write_history(self, history):
        directory = os.path.dirname(DEPLOY_HISTORY_FILE)
        os.makedirs(directory, exist_ok=True)
        temporary = DEPLOY_HISTORY_FILE + '.tmp'
        with open(temporary, 'w', encoding='utf-8') as stream:
            json.dump(history, stream, ensure_ascii=False, indent=2)
        os.replace(temporary, DEPLOY_HISTORY_FILE)

    def delete_history(self, record_id):
        if not isinstance(record_id, str) or not re.fullmatch(r'[0-9a-f]{32}', record_id):
            raise ValueError('올바른 배포 기록 ID가 아닙니다.')
        with self.history_lock:
            history = self._read_history()
            remaining = [item for item in history if item.get('id') != record_id]
            if len(remaining) == len(history):
                return False
            self._write_history(remaining)
            return True

    def record_download(self, kind, path, deployed_by):
        """Log a direct model download (currently just VLM's zip download,
        which unlike Detector's ONNX export has no async job to hang a
        completion record off of)."""
        record = {
            'id': uuid.uuid4().hex,
            'deployed_by': deployed_by or '사용자',
            'project_name': PurePosixPath(path).name if path else 'unknown',
            'deployed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'kind': kind,
            'path': path,
        }
        with self.history_lock:
            history = [record, *self._read_history()][:200]
            self._write_history(history)

    def _record_completed(self, job):
        record = {
            'id': job['id'],
            'deployed_by': job.get('deployed_by', '사용자'),
            'project_name': job.get('project_name') or (PurePosixPath(job.get('params', {}).get('weights', 'unknown')).parents[1].name if len(PurePosixPath(job.get('params', {}).get('weights', 'unknown')).parents) > 1 else 'unknown'),
            'deployed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'weights': job['params']['weights'],
            'outputs': job['outputs'],
        }
        with self.history_lock:
            history = [record, *[item for item in self._read_history() if item.get('id') != record['id']]][:200]
            self._write_history(history)

    def _run(self, job_id, validated):
        remote = export_remote_command(validated)
        try:
            with subprocess.Popen(ssh_command(remote), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, errors='replace', env=_child_env()) as process:
                with self.lock:
                    if self.jobs[job_id]['status'] == 'queued':
                        self.jobs[job_id]['status'] = 'running'
                    else:
                        process.terminate()
                        return
                for line in process.stdout:
                    self._append(job_id, line)
                code = process.wait()
            with self.lock:
                self.jobs[job_id].update(
                    status='completed' if code == 0 else 'failed',
                    exit_code=code,
                    error=None if code == 0 else '변환이 실패했습니다. 로그를 확인하세요.',
                )
                completed_job = dict(self.jobs[job_id]) if code == 0 else None
            if completed_job and completed_job.get('deployed_by'):
                try:
                    self._record_completed(completed_job)
                except Exception:
                    LOG.exception('Could not persist deployment history')
        except Exception as exc:
            LOG.exception('Detector ONNX export failed')
            with self.lock:
                self.jobs[job_id].update(status='failed', error=str(exc))


EXPORT_JOBS = ExportJobs()
