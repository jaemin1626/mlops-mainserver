"""Validated Detector launch contract and bounded, asynchronous job tracking."""
import datetime
import logging
import os
import re
import shlex
import subprocess
import threading
import uuid
from pathlib import PurePosixPath
from client import command, ssh_command, TRAINING_ROOT

SCRIPT = TRAINING_ROOT + '/scripts/train.sh'
BASE = PurePosixPath(TRAINING_ROOT) / 'Detector'
OPTIONS = {'type': '--type', 'data': '--data', 'epochs': '--epochs',
           'batch': '--batch', 'gpu': '--gpu', 'img_size': '--img-size',
           'weights': '--weights', 'name': '--name', 'resume': '--resume'}
LOG = logging.getLogger('detector')


def validate_path(key, value):
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise ValueError(f'{key}: invalid path')
    if any(ord(c) < 32 or ord(c) == 127 for c in value) or '\\' in value:
        raise ValueError(f'{key}: invalid path')
    path = PurePosixPath(value)
    if '..' in path.parts:
        raise ValueError(f'{key}: parent traversal is forbidden')
    resolved = path if path.is_absolute() else BASE / path
    roots = [BASE / 'data'] if key == 'data' else [BASE / 'weights', BASE / 'runs/Detector']
    suffixes = {'.yaml', '.yml'} if key == 'data' else {'.pt'}
    if resolved.suffix not in suffixes or not any(resolved.is_relative_to(r) for r in roots):
        raise ValueError(f'{key}: path is outside permitted server directories')
    return value


def remote_command(params):
    if not isinstance(params, dict) or params.get('type') != 'detector':
        raise ValueError('type must be detector')
    params = dict(params)
    params.pop('folders', None)
    if params.keys() - OPTIONS.keys():
        raise ValueError('Unsupported Detector parameters')
    args = [SCRIPT]
    for key, flag in OPTIONS.items():
        if key not in params:
            continue
        value = params[key]
        if key in {'epochs', 'batch', 'img_size'}:
            if type(value) is not int or value <= 0:
                raise ValueError(f'{key} must be a positive integer')
        elif key == 'gpu':
            if not isinstance(value, str) or not re.fullmatch(r'[0-9]+(?:,[0-9]+)*', value):
                raise ValueError('gpu must be comma-separated GPU numbers')
        elif key == 'name':
            if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
                raise ValueError('name must contain only letters, numbers, _ and -')
        elif key in {'data', 'weights'}:
            validate_path(key, value)
        elif key == 'resume':
            if type(value) is not bool:
                raise ValueError('resume must be boolean')
            if value:
                args.append(flag)
            continue
        args.extend([flag, str(value)])
    return shlex.join(args)


class Jobs:
    def __init__(self):
        self.lock = threading.Lock()
        self.jobs = {}
        self.processes = {}
        self.dataset_sessions = {}

    def start(self, params, dataset_metadata=None, dataset_cookie=None):
        if not isinstance(params, dict):
            raise ValueError('Training request must be an object')
        params = dict(params)
        if not params.get('name'):
            if params.get('type') == 'vlm':
                modality = str(params.get('modality') or 'both').lower()
                prefix = {'image': 'Image', 'video': 'Video', 'both': 'Both'}.get(modality)
                if not prefix:
                    raise ValueError('지원하지 않는 VLM 학습 대상입니다.')
            else:
                prefix = 'detector'
            params['name'] = f"{prefix}_{datetime.datetime.now().strftime('%Y%m%d%H%M%S')}"
        ui_settings = params.pop('ui_settings', None)
        if ui_settings is not None and not isinstance(ui_settings, dict):
            raise ValueError('ui_settings must be an object')
        if params.get('type') == 'vlm':
            from vlm import prepare
            prepared = prepare(params)
            params = prepared['params']
            launch_command = prepared['command']
            if self.remote_running('vlm') or self.remote_running():
                raise RuntimeError('학습 서버에서 이미 학습이 진행 중입니다.')
        else:
            prepared = None
            launch_command = remote_command(params)
        if dataset_metadata:
            import json
            launch_command='python3 '+TRAINING_ROOT+'/scripts/mlops_dataset_train.py --metadata '+shlex.quote(json.dumps(dataset_metadata,ensure_ascii=False))+' -- '+launch_command
        command = ssh_command(launch_command)
        with self.lock:
            if any(j['status'] in {'queued', 'running', 'stopping'} for j in self.jobs.values()):
                raise RuntimeError('A training job is already running')
            job_id = uuid.uuid4().hex
            self.jobs[job_id] = dict(id=job_id, status='queued', logs='', ssh_exit_code=None,
                                     script_exit_code=None, error=None, params=dict(params), ui_settings=ui_settings,
                                     effective=prepared['effective'] if prepared else params,
                                     dataset_metadata=dataset_metadata,command=launch_command, clearml_task_id=None, clearml_path=None)
            if dataset_cookie:self.dataset_sessions[job_id]=dataset_cookie
            while len(self.jobs) > 100:
                del self.jobs[next(iter(self.jobs))]
        threading.Thread(target=self.run, args=(job_id, command), daemon=True).start()
        return self.get(job_id)

    def get(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            return dict(job) if job else None

    def append(self, job_id, stream, text):
        LOG.warning('[%s][%s] %s', job_id, stream, text.rstrip())
        with self.lock:
            job = self.jobs[job_id]
            path_match=re.search(r'(/projects/[a-f0-9]{32}/(?:tasks|experiments)/([a-f0-9]{32})/output/log)',text,re.IGNORECASE)
            if path_match:
                job['clearml_task_id']=path_match.group(2)
                job['clearml_path']=path_match.group(1)
            task_match = re.search(r'(?:tasks|experiments)/([a-f0-9]{32})|(?:task id[=: ]+)([a-f0-9]{32})', text, re.IGNORECASE)
            if task_match:
                job['clearml_task_id'] = next(g for g in task_match.groups() if g)
            job['logs'] = (job['logs'] + f'[{stream}] ' + text)[-65536:]

    def report_dataset(self,job_id):
        with self.lock:
            job=dict(self.jobs[job_id]);cookie=self.dataset_sessions.get(job_id)
            if not job.get('clearml_task_id') or not cookie or job.get('dataset_reported'):return
        from dataset_registry import Registry
        try:
            registry=Registry(cookie);task=registry.call('tasks.get_by_id',{'task':job['clearml_task_id']})['task']
            configs=dict(task.get('configuration',{}));configs['MLOps Dataset']={'name':'MLOps Dataset','type':'json','value':__import__('json').dumps(job['dataset_metadata'],ensure_ascii=False)}
            registry.call('tasks.edit',{'task':job['clearml_task_id'],'force':True,'configuration':configs})
            dataset_id=job['dataset_metadata'].get('dataset_id')
            if dataset_id:
                registry.record_training_usage(job.get('params',{}).get('type','detector'),dataset_id,task,job.get('params',{}).get('type','detector'))
            with self.lock:self.jobs[job_id]['dataset_reported']=True
        except Exception as exc:LOG.warning('Dataset metadata reporting failed: %s',exc)

    def run(self, job_id, command):
        try:
            with self.lock:
                if self.jobs[job_id]['status'] != 'queued':
                    return
            env = dict(os.environ)
            password = env.pop('TRAINING_SSH_PASSWORD', '')
            if password:
                env['SSHPASS'] = password
            with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True, errors='replace', env=env) as process:
                with self.lock:
                    self.processes[job_id] = process
                with self.lock:
                    if self.jobs[job_id]['status'] == 'queued':
                        self.jobs[job_id]['status'] = 'running'
                    else:
                        process.terminate()
                def drain(pipe, name):
                    with pipe:
                        while True:
                            chunk = pipe.readline(4096)
                            if not chunk:
                                break
                            self.append(job_id, name, chunk)
                            self.report_dataset(job_id)
                readers = [threading.Thread(target=drain, args=(pipe, name))
                           for pipe, name in [(process.stdout, 'stdout'), (process.stderr, 'stderr')]]
                for reader in readers:
                    reader.start()
                code = process.wait()
                self.report_dataset(job_id)
                for reader in readers:
                    reader.join()
            self.append(job_id, 'backend', f'SSH exit code: {code}\n')
            with self.lock:
                self.processes.pop(job_id, None)
                self.dataset_sessions.pop(job_id,None)
                stopped = self.jobs[job_id].get("status") in {"stopping", "stopped"}
                self.jobs[job_id].update(status=self.jobs[job_id]["status"] if stopped else ("completed" if code == 0 else "failed"),
                    ssh_exit_code=code, script_exit_code=code if 0 <= code < 255 else None,
                    error='SSH transport failure or remote exit 255; remote result unknown' if code == 255
                          else ('SSH process terminated' if code < 0 else None))
        except Exception as exc:
            with self.lock:
                self.processes.pop(job_id, None)
                self.dataset_sessions.pop(job_id,None)
            self.append(job_id, 'backend', f'{exc}\n')
            with self.lock:
                self.jobs[job_id].update(status='failed', error=str(exc))

    def remote_running(self, project='detector'):
        try:
            result = subprocess.run(command(['status']), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, errors='replace', timeout=30, env=self.child_env())
            if result.returncode != 0:
                raise RuntimeError('원격 학습 상태 확인 실패')
            match = re.search(r'^'+re.escape(project)+r'\s+(\S+)', result.stdout.lower(), re.MULTILINE)
            if not match:
                raise RuntimeError('원격 Detector 상태를 확인할 수 없습니다.')
            return match.group(1) in {'running', 'created', 'restarting', 'paused'}
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError('원격 학습 상태 확인 시간 초과') from exc

    def active(self):
        with self.lock:
            return [dict(j) for j in self.jobs.values() if j['status'] in {'queued', 'running', 'stopping'}]

    def stop_remote(self, project='detector'):
        try:
            task_id=None
            if project=='vlm' and self.remote_running(project):
                snapshot=subprocess.run(ssh_command('cat '+TRAINING_ROOT+'/VLM/.cache/current_clearml_task_id'),capture_output=True,text=True,timeout=15,env=self.child_env())
                candidate=snapshot.stdout.strip()
                if snapshot.returncode==0 and re.fullmatch(r'[a-f0-9]{32}',candidate):task_id=candidate
            stop_command = command(['stop', project])
            result = subprocess.run(stop_command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, errors='replace', timeout=60, env=self.child_env())
            output = (result.stdout + result.stderr).strip()
            if result.returncode == 0 and (self.remote_running(project) if project!='detector' else self.remote_running()):
                return {'status': 'failed', 'logs': output, 'error': '종료 명령 이후에도 원격 학습이 실행 중입니다.'}
            return {'status': 'stopped' if result.returncode == 0 else 'failed',
                    'logs': output, 'ssh_exit_code': result.returncode, 'clearml_task_id':task_id}
        except Exception as exc:
            return {'status': 'failed', 'logs': str(exc), 'error': str(exc)}

    @staticmethod
    def child_env():
        env = dict(os.environ)
        password = env.pop('TRAINING_SSH_PASSWORD', '')
        if password:
            env['SSHPASS'] = password
        return env

    def stop(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if job and job['status'] not in {'queued', 'running', 'stopping'}:
                return dict(job)
            previous = job['status'] if job else None
            if job:
                job['status'] = 'stopping'
        project = job.get('params', {}).get('type', 'detector') if job else 'detector'
        result = self.stop_remote(project) if project != 'detector' else self.stop_remote()
        if not job:
            return dict(result, id=job_id)
        self.append(job_id, 'stop', result.get('logs', '') + '\n')
        with self.lock:
            if result['status'] == 'failed':
                if self.jobs[job_id]['status'] == 'stopping':
                    self.jobs[job_id]['status'] = previous
                return dict(result, id=job_id)
            self.jobs[job_id]['status'] = 'stopped'
            process = self.processes.get(job_id)
        if process and process.poll() is None:
            process.terminate()
        return self.get(job_id)


JOBS = Jobs()
