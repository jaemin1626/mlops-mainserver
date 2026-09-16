"""Same-origin API; every operation requires a verified ClearML session."""
import datetime
import json
import logging
import os
import tempfile
import threading
import urllib.request
import re
from urllib.parse import parse_qs, urlparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from annotation_builder import build, detector_bundle, validate_classes
from transfer_annotations import transfer, transfer_detector_bundle
from detector import JOBS

ROOT = Path(os.environ['TRAINING_DATASET_LOCAL_ROOT']).resolve()
LOCK = threading.Lock()

class H(BaseHTTPRequestHandler):
    def out(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authenticated(self):
        cookie = self.headers.get('Cookie', '')
        if not cookie:
            return False
        try:
            req = urllib.request.Request('http://apiserver:8008/users.get_current_user', data=b'{}', headers={'Cookie': cookie, 'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=10) as response:
                result = json.load(response)
            return result.get('meta', {}).get('result_code') == 200 and bool(result.get('data', {}).get('user', {}).get('id'))
        except Exception:
            return False

    def sync_clearml_stopped(self, result):
        task_id = result.get('clearml_task_id')
        if not task_id or result.get('status') != 'stopped':
            return result
        try:
            payload = {'task':task_id, 'force':True, 'status_reason':'MLOps user stopped training',
                       'status_message':'Remote training verified stopped by MLOps'}
            req = urllib.request.Request('http://apiserver:8008/tasks.stopped',
                data=json.dumps(payload).encode(),
                headers={'Cookie':self.headers.get('Cookie',''), 'Content-Type':'application/json'})
            with urllib.request.urlopen(req, timeout=15) as response:
                data=json.load(response)
            if data.get('meta',{}).get('result_code') != 200:
                raise RuntimeError('ClearML task state update rejected')
            result['clearml_status']='stopped'
        except Exception:
            logging.getLogger('training.stop').exception('ClearML stopped status synchronization failed')
            result['error']='학습은 종료됐지만 ClearML 실험 상태 갱신에 실패했습니다. 종료 버튼으로 다시 시도하세요.'
            result['clearml_sync_failed']=True
        return result

    def do_GET(self):
        if not self.authenticated():
            return self.out(401, {'error': 'ClearML 로그인이 필요합니다.'})
        parsed=urlparse(self.path)
        if parsed.path in {'/datasets/tree','/datasets/nodes','/datasets/version','/datasets/graph','/datasets/details'}:
            try:
                from dataset_api import remote
                from dataset_registry import Registry
                q=parse_qs(parsed.query);kind=q.get('type',['detector'])[0]
                if parsed.path=='/datasets/tree':return self.out(200,remote('inventory',{'dataset_type':kind,'modality':q.get('modality',['both'])[0]}))
                registry=Registry(self.headers.get('Cookie',''))
                if parsed.path=='/datasets/graph':return self.out(200,registry.graph(kind))
                if parsed.path=='/datasets/nodes':return self.out(200,{'nodes':registry.list_dataset_nodes(kind)})
                if parsed.path=='/datasets/details':return self.out(200,registry.dataset_details(kind,q.get('id',[''])[0]))
                return self.out(200,registry.get_dataset_manifest(kind,q.get('id',[''])[0]))
            except ValueError as exc:return self.out(400,{'error':str(exc)})
            except Exception as exc:return self.out(502,{'error':str(exc)})
        if self.path == '/capabilities':
            return self.out(200, {'launch': True, 'types': ['detector', 'vlm'], 'annotations': True})
        if self.path == '/jobs/active':
            try:
                states={kind:JOBS.remote_running(kind) for kind in ['detector','vlm']}
                return self.out(200, {'jobs': JOBS.active(), 'remote_running': any(states.values()), 'remote_types':[k for k,v in states.items() if v]})
            except Exception as exc:
                return self.out(502, {'error': str(exc)})
        if self.path.startswith('/jobs/'):
            job = JOBS.get(self.path.removeprefix('/jobs/'))
            return self.out(200 if job else 404, job or {'error': 'Job not found'})
        if self.path == '/vlm/resources':
            try:
                from vlm import resources
                return self.out(200, resources())
            except Exception as exc:
                return self.out(502, {'error':str(exc)})
        if urlparse(self.path).path == '/detector/datasets':
            raw = parse_qs(urlparse(self.path).query).get('path', [''])[0].strip('/')
            current = (ROOT / raw).resolve()
            if not current.is_relative_to(ROOT) or not current.is_dir():
                return self.out(400, {'error': '올바른 폴더 경로가 아닙니다.'})
            base = ROOT if parse_qs(urlparse(self.path).query).get('all', [''])[0] == '1' else current
            candidates = base.rglob('*') if base != current or parse_qs(urlparse(self.path).query).get('all', [''])[0] == '1' else base.iterdir()
            folders = [p.relative_to(ROOT).as_posix() for p in sorted(candidates) if p.is_dir() and not p.is_symlink() and p.resolve().is_relative_to(ROOT)]
            classes = []
            labels = ROOT / 'label.txt'
            if labels.is_file() and labels.resolve().is_relative_to(ROOT):
                try:
                    classes = validate_classes([line.strip() for line in labels.read_text(encoding='utf-8').splitlines() if line.strip()])
                except (ValueError, OSError):
                    pass
            return self.out(200, {'items': folders, 'classes': classes})
        self.out(404, {'error': 'not found'})

    def do_POST(self):
        delete_match=re.fullmatch(r'/api/v[0-9.]+/tasks\.delete',urlparse(self.path).path)
        if delete_match:
            if not self.authenticated():return self.out(401,{'meta':{'result_code':401,'result_msg':'ClearML 로그인이 필요합니다.'},'data':{}})
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=65536:raise ValueError('Invalid request size')
                q=json.loads(self.rfile.read(size));task_id=q.get('task') if isinstance(q,dict) else None
                if not isinstance(task_id,str):raise ValueError('Dataset ID가 필요합니다.')
                from dataset_registry import Registry
                registry=Registry(self.headers.get('Cookie',''));children=registry.children(task_id)
                if children:
                    return self.out(409,{'meta':{'result_code':409,'result_subcode':0,'result_msg':'하위 Dataset이 존재하기 때문에 삭제할 수 없습니다.'},'data':{'children':[{'id':n['id'],'version':n['version']} for n in children]}})
                return self.out(200,{'meta':{'result_code':200,'result_subcode':0,'result_msg':'OK'},'data':registry.call('tasks.delete',q)})
            except (ValueError,UnicodeError) as exc:return self.out(400,{'meta':{'result_code':400,'result_msg':str(exc)},'data':{}})
            except Exception as exc:
                logging.getLogger('datasets').exception('Dataset delete guard failed')
                return self.out(502,{'meta':{'result_code':502,'result_msg':str(exc)},'data':{}})
        if self.path not in {'/annotations', '/detector/annotations', '/jobs', '/stop', '/stop/vlm', '/vlm/preview', '/vlm/annotations','/datasets/select','/datasets/prepare','/datasets/connect','/datasets/branch','/datasets/description'} and not (self.path.startswith('/jobs/') and self.path.endswith('/stop')):
            return self.out(404, {'error': 'not found'})
        if self.headers.get('Origin') != os.environ['ANNOTATION_ALLOWED_ORIGIN']:
            return self.out(403, {'error': 'Origin rejected'})
        if not self.authenticated():
            return self.out(401, {'error': 'ClearML 로그인이 필요합니다.'})
        if self.path in {'/stop','/stop/vlm'} or self.path.endswith('/stop'):
            result = JOBS.stop_remote('vlm') if self.path == '/stop/vlm' else JOBS.stop_remote() if self.path == '/stop' else JOBS.stop(self.path.removeprefix('/jobs/').removesuffix('/stop').strip('/'))
            result=self.sync_clearml_stopped(result)
            return self.out(200 if result['status'] != 'failed' and not result.get('clearml_sync_failed') else 502, result)
        if self.path=='/datasets/description':
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=8192:raise ValueError('Invalid request size')
                q=json.loads(self.rfile.read(size))
                if not isinstance(q,dict) or q.keys()-{'dataset_type','id','description'}:raise ValueError('Unsupported Dataset parameters')
                kind=q.get('dataset_type');task_id=q.get('id');description=q.get('description')
                if kind not in {'detector','vlm'} or not isinstance(task_id,str) or not isinstance(description,str):raise ValueError('Dataset 설명 값을 확인하세요.')
                from dataset_registry import Registry
                return self.out(200,Registry(self.headers.get('Cookie','')).update_description(kind,task_id,description))
            except (ValueError,UnicodeError) as exc:return self.out(400,{'error':str(exc)})
            except Exception as exc:
                logging.getLogger('datasets').exception('Dataset description update failed')
                return self.out(502,{'error':str(exc)})
        if self.path=='/datasets/branch':
            acquired=False
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=65536:raise ValueError('Invalid request size')
                q=json.loads(self.rfile.read(size))
                if not isinstance(q,dict) or q.keys()-{'dataset_type','parent_id','version','description','branch_name','new_branch'}:raise ValueError('Unsupported Dataset parameters')
                kind=q.get('dataset_type');parent=q.get('parent_id');version=q.get('version');description=q.get('description','');branch_name=q.get('branch_name');new_branch=q.get('new_branch',False)
                if kind not in {'detector','vlm'} or not isinstance(parent,str) or not isinstance(version,str) or not isinstance(description,str) or len(description)>4000 or (branch_name is not None and not isinstance(branch_name,str)) or not isinstance(new_branch,bool):raise ValueError('Dataset 생성 값을 확인하세요.')
                acquired=LOCK.acquire(blocking=False)
                if not acquired:raise RuntimeError('이미 Dataset 생성 요청을 처리 중입니다.')
                from dataset_registry import Registry
                return self.out(201,Registry(self.headers.get('Cookie','')).create_branch(kind,parent,version.strip(),description.strip(),branch_name.strip() if branch_name else None,new_branch))
            except (ValueError,UnicodeError) as exc:return self.out(400,{'error':str(exc)})
            except RuntimeError as exc:return self.out(409,{'error':str(exc)})
            except Exception as exc:
                logging.getLogger('datasets').exception('Dataset branch creation failed')
                return self.out(502,{'error':str(exc)})
            finally:
                if acquired:LOCK.release()
        if self.path in {'/datasets/select','/datasets/prepare','/datasets/connect'}:
            acquired=False
            try:
                from dataset_api import query,remote,connect
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=16000000:raise ValueError('Invalid request size')
                q=json.loads(self.rfile.read(size));cookie=self.headers.get('Cookie','')
                if self.path!='/datasets/select':
                    acquired=LOCK.acquire(blocking=False)
                    if not acquired:raise RuntimeError('이미 데이터 생성·학습 요청을 처리 중입니다.')
                    if JOBS.active() or JOBS.remote_running('vlm') or JOBS.remote_running('detector'):raise RuntimeError('학습 중에는 데이터 생성·새 버전 연결을 할 수 없습니다.')
                if self.path=='/datasets/connect':return self.out(200,connect(q,cookie))
                return self.out(200,remote('select' if self.path=='/datasets/select' else 'prepare',query(q,cookie)))
            except (ValueError,UnicodeError) as exc:return self.out(400,{'error':str(exc)})
            except RuntimeError as exc:return self.out(409,{'error':str(exc)})
            except Exception as exc:
                logging.getLogger('datasets').exception('Dataset operation failed')
                return self.out(502,{'error':str(exc)})
            finally:
                if acquired:LOCK.release()
        if self.path == '/vlm/annotations':
            if not LOCK.acquire(blocking=False):return self.out(409,{'error':'이미 생성 중입니다.'})
            try:
                if JOBS.active() or JOBS.remote_running('vlm'):raise RuntimeError('학습 중에는 데이터 JSON을 변경할 수 없습니다.')
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=65536:raise ValueError('Invalid request size')
                q=json.loads(self.rfile.read(size))
                if not isinstance(q,dict):raise ValueError('Invalid request object')
                import subprocess
                from client import ssh_command
                r=subprocess.run(ssh_command('python3 /home/intellivix/train/scripts/mlops_vlm_dataset.py'),input=json.dumps(q),capture_output=True,text=True,timeout=150,env=JOBS.child_env())
                result=json.loads(r.stdout)
                return self.out(400 if r.returncode else 200,result)
            except ValueError as exc:return self.out(400,{'error':str(exc)})
            except RuntimeError as exc:return self.out(409,{'error':str(exc)})
            except Exception as exc:return self.out(502,{'error':str(exc)})
            finally:LOCK.release()
        if self.path in {'/jobs','/vlm/preview'}:
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 16000000:
                    raise ValueError('Invalid request size')
                params=json.loads(self.rfile.read(size))
                if self.path == '/vlm/preview':
                    from vlm import prepare
                    return self.out(200, prepare(params))
                with LOCK:
                    from dataset_api import training_metadata
                    metadata=training_metadata(params,self.headers.get('Cookie',''))
                    return self.out(202,JOBS.start(params,dataset_metadata=metadata,dataset_cookie=self.headers.get('Cookie','')) if metadata else JOBS.start(params))
            except (ValueError, UnicodeError) as exc:
                return self.out(400, {'error': str(exc)})
            except RuntimeError as exc:
                return self.out(409, {'error': str(exc)})
            except Exception as exc:
                return self.out(502, {'error': str(exc)})
        if not LOCK.acquire(blocking=False):
            return self.out(409, {'error': '이미 생성·전송 중입니다.'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 16000000:
                raise ValueError('Invalid request size')
            q = json.loads(self.rfile.read(size))
            if not isinstance(q, dict):
                raise ValueError('Invalid request object')
            if self.path == '/detector/annotations' and q.keys() - {'folders', 'classes'}:
                raise ValueError('Unsupported dataset parameters')
            raw_folders = q.get('folders')
            if not isinstance(raw_folders, list) or not 1 <= len(raw_folders) <= 100:
                raise ValueError('폴더를 1~100개 선택하세요.')
            folders = []
            for raw in raw_folders:
                if not isinstance(raw, str) or not raw or len(raw) > 1024 or any(ord(c) < 32 for c in raw) or Path(raw).is_absolute() or '..' in Path(raw).parts:
                    raise ValueError('Invalid relative folder')
                folder = (ROOT / raw).resolve()
                if not folder.is_relative_to(ROOT) or not folder.is_dir():
                    raise ValueError('Dataset folder not found')
                folders.append(folder)
            if self.path == '/detector/annotations':
                with tempfile.TemporaryDirectory() as tmp:
                    summary = detector_bundle(folders, os.getenv('TRAINING_IMAGE_ROOT', '/workspace/Dataset/detector'),
                                              tmp, q.get('classes'), dataset_root=ROOT)
                    result = transfer_detector_bundle(tmp)
                return self.out(200, {'ok': True, **summary, **result})
            day = datetime.datetime.now().strftime('%Y%m%d')
            with tempfile.TemporaryDirectory() as tmp:
                tr, va = build(folders, os.getenv('TRAINING_IMAGE_ROOT', '/workspace/Dataset/detector'), tmp, dataset_root=ROOT)
                destination = transfer(Path(tmp)/'train.json', Path(tmp)/'val.json', day)
            self.out(200, {'ok': True, 'train': tr, 'val': va, 'train_path': destination+'/train.json', 'val_path': destination+'/val.json'})
        except (ValueError, UnicodeError) as exc:
            self.out(400, {'error': str(exc)})
        except Exception:
            logging.getLogger('detector.annotations').exception('Dataset preparation failed')
            self.out(502, {'error': '생성 또는 SSH 전송 실패. 서버 로그를 확인하세요.'})
        finally:
            LOCK.release()

    def log_message(self, *args):
        pass

if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8091), H).serve_forever()
