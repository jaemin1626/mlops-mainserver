"""Same-origin API; every operation requires a verified ClearML session."""
import datetime
import json
import logging
import os
import tempfile
import threading
import urllib.request
import re
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from annotation_builder import build, detector_bundle, validate_classes
from transfer_annotations import transfer, transfer_detector_bundle
from detector import JOBS

ROOT = Path(os.environ['TRAINING_DATASET_LOCAL_ROOT']).resolve()
LOCK = threading.Lock()

def cleanup_fileserver_artifacts(urls, cookie):
    """Delete a deleted task's uploaded files from the ClearML fileserver.

    tasks.delete only removes the Mongo record; the uploaded zip/json files
    stay on disk forever unless deleted here, which is why orphaned
    Dataset/.datasets/* folders kept piling up.

    This only removes the individual files (the fileserver's HTTP API has no
    directory-delete), so the now-empty Dataset/.datasets/<name>.<task_id>/
    folder shell is left behind. Removing that shell too would need
    filesystem access to the fileserver's disk, but annotation-api runs as
    an unprivileged, read_only, cap_drop:ALL container while every file the
    fileserver creates is owned root:root — giving it write access there
    means either running it as root or adding a privileged helper, both of
    which are a deliberate hardening trade-off, not something to flip on
    silently.
    """
    log = logging.getLogger('datasets')
    all_urls = (urls.get('artifact_urls') or []) + (urls.get('model_urls') or []) + (urls.get('event_urls') or [])
    jar = SimpleCookie()
    jar.load(cookie or '')
    if 'clearml_token_basic' not in jar:
        log.warning('cleanup_fileserver_artifacts: no clearml_token_basic cookie, %d url(s) left uncleaned', len(all_urls))
        return
    token = jar['clearml_token_basic'].value
    from dataset_registry import FILES
    allowed = urlparse(FILES)
    for url in all_urls:
        parsed = urlparse(url)
        if parsed.scheme != allowed.scheme or parsed.netloc != allowed.netloc:
            log.warning('cleanup_fileserver_artifacts: skipping %s (host not allowed, expected %s)', url, FILES)
            continue
        try:
            req = urllib.request.Request(url, method='DELETE', headers={'Authorization': 'Bearer ' + token})
            urllib.request.urlopen(req, timeout=30)
        except Exception:
            log.exception('Fileserver artifact delete failed: %s', url)

def cleanup_output_models(registry, model_ids, model_uri_by_id, cookie):
    """Delete a task's output models (weights files) after the task itself is gone.

    tasks.delete has no working 'delete the output model too' switch on this
    ClearML server build — it only unlinks the model (task field becomes
    __DELETED__<id>) and leaves both the model record and its uploaded file
    (e.g. best.pt) behind, so models.delete has to do the real deletion.

    But for an *archived* task, ClearML appears to purge the model record as
    part of tasks.delete itself, so models.delete then 400s with "Invalid
    model id" — by which point its response can't hand back the file's url
    any more. That's why model_uri_by_id (fetched before the task was
    touched) is the thing this relies on for the fileserver cleanup, not
    models.delete's response; deleting the record is best-effort on top.
    """
    for model_id in model_ids or []:
        try:
            registry.call('models.delete', {'model': model_id, 'force': True})
        except Exception:
            logging.getLogger('datasets').info('models.delete no-op for %s (likely already purged with the archived task)', model_id)
        uri = model_uri_by_id.get(model_id)
        if uri:
            cleanup_fileserver_artifacts({'artifact_urls': [uri]}, cookie)

DEBUG_IMAGE_EVENT_TYPES = ('training_debug_image', 'plot')

def fetch_debug_event_urls(registry, task_id):
    """Collect a task's debug-image/plot file URLs before it gets deleted.

    events.get_task_events 400s once the task's Mongo record is gone, so this
    must run before tasks.delete, not after. tasks.delete's own
    return_file_urls never includes these on this ClearML build (it only
    ever fills in artifact_urls), which is why the metrics/*/*.png/.jpg
    files under a training task's fileserver folder kept accumulating.
    """
    urls = []
    for event_type in DEBUG_IMAGE_EVENT_TYPES:
        try:
            events = registry.call('events.get_task_events', {
                'task': task_id, 'event_type': event_type, 'order': 'asc', 'batch_size': 500,
            }).get('events', [])
        except Exception:
            continue
        urls.extend(e['url'] for e in events if e.get('url'))
    return urls

def cleanup_task_events(registry, task_id, event_urls, cookie):
    if event_urls:
        cleanup_fileserver_artifacts({'artifact_urls': event_urls}, cookie)
    try:
        registry.call('events.delete_for_task', {'task': task_id})
    except Exception:
        logging.getLogger('datasets').exception('events.delete_for_task failed: %s', task_id)

def call_delete_with_cleanup(registry, method, payload, cookie, want_urls, output_models_by_id=None, model_uri_by_id=None, event_urls_by_id=None):
    """tasks.delete / tasks.delete_many wrapper that also frees the fileserver.

    Asks ClearML for the artifact URLs the deletion just orphaned and deletes
    those files, separately deletes each task's own output models (see
    cleanup_output_models — needs model_uri_by_id, fetched before this call)
    and debug-image/plot events (see cleanup_task_events — needs
    event_urls_by_id, also fetched before this call), then hides the 'urls'
    field again unless the original caller explicitly asked for it
    (return_file_urls).
    """
    output_models_by_id = output_models_by_id or {}
    model_uri_by_id = model_uri_by_id or {}
    event_urls_by_id = event_urls_by_id or {}
    result = registry.call(method, {**payload, 'return_file_urls': True})
    if method == 'tasks.delete':
        cleanup_fileserver_artifacts(result.get('urls') or {}, cookie)
        if result.get('deleted'):
            task_id = payload.get('task')
            cleanup_output_models(registry, output_models_by_id.get(task_id), model_uri_by_id, cookie)
            cleanup_task_events(registry, task_id, event_urls_by_id.get(task_id), cookie)
        if not want_urls:
            result.pop('urls', None)
    else:
        for item in result.get('succeeded') or []:
            cleanup_fileserver_artifacts(item.get('urls') or {}, cookie)
            if item.get('deleted'):
                task_id = item.get('id')
                cleanup_output_models(registry, output_models_by_id.get(task_id), model_uri_by_id, cookie)
                cleanup_task_events(registry, task_id, event_urls_by_id.get(task_id), cookie)
            if not want_urls:
                item.pop('urls', None)
    return result

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

    def current_access_user(self):
        try:
            req = urllib.request.Request(
                os.environ.get('ACCESS_CONTROL_URL', 'http://access-control:8095') + '/auth/me',
                headers={'Cookie': self.headers.get('Cookie', '')},
            )
            with urllib.request.urlopen(req, timeout=5) as response:
                return json.load(response)
        except Exception:
            return {}

    def authorized(self, permission):
        try:
            req = urllib.request.Request(
                os.environ.get('ACCESS_CONTROL_URL', 'http://access-control:8095') + '/authorize',
                data=json.dumps({'permission': permission}).encode(),
                headers={'Cookie': self.headers.get('Cookie', ''), 'Content-Type': 'application/json'},
            )
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status == 200
        except urllib.error.HTTPError as exc:
            return False if exc.code in (401, 403) else False
        except Exception:
            logging.getLogger('access').exception('Permission service unavailable')
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

    def stream_process(self, command, filename):
        """Stream a subprocess's stdout (e.g. remote `cat`/`zip` over SSH) as a file download."""
        import subprocess
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=JOBS.child_env())
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            while True:
                chunk = process.stdout.read(65536)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
        finally:
            if process.poll() is None:
                process.terminate()
            process.stdout.close()
            stderr_tail = process.stderr.read()[-2000:]
            code = process.wait(timeout=30)
            process.stderr.close()
            if code != 0:
                logging.getLogger('deploy').warning('Stream command exited %s: %s', code, stderr_tail.decode('utf-8', 'replace'))

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
        if self.path == '/deploy/detector/models':
            try:
                from deploy import list_detector_models
                return self.out(200, {'models': list_detector_models()})
            except Exception as exc:
                return self.out(502, {'error': str(exc)})
        if self.path == '/deploy/vlm/models':
            try:
                from deploy import list_vlm_models
                return self.out(200, {'models': list_vlm_models()})
            except Exception as exc:
                return self.out(502, {'error': str(exc)})
        if self.path == '/deploy/history':
            from deploy import EXPORT_JOBS
            return self.out(200, {'deployments': EXPORT_JOBS.history()})
        if self.path.startswith('/deploy/export/'):
            from deploy import EXPORT_JOBS
            job = EXPORT_JOBS.get(self.path.removeprefix('/deploy/export/'))
            return self.out(200 if job else 404, job or {'error': 'Job not found'})
        if urlparse(self.path).path in {'/deploy/detector/download', '/deploy/vlm/download'}:
            if not self.authorized('TRAIN_DEPLOY'):
                return self.out(403, {'error': '학습/배포 권한이 필요합니다.', 'permission': 'TRAIN_DEPLOY'})
            try:
                import subprocess
                from deploy import onnx_test_command, onnx_cat_command, vlm_test_command, vlm_zip_command
                path = parse_qs(urlparse(self.path).query).get('path', [''])[0]
                if urlparse(self.path).path == '/deploy/detector/download':
                    test_command, resolved = onnx_test_command(path)
                    check = subprocess.run(test_command, timeout=15, env=JOBS.child_env())
                    if check.returncode != 0:
                        return self.out(404, {'error': '파일을 찾을 수 없습니다.'})
                    return self.stream_process(onnx_cat_command(path), Path(resolved).name)
                test_command, resolved = vlm_test_command(path)
                check = subprocess.run(test_command, timeout=15, env=JOBS.child_env())
                if check.returncode != 0:
                    return self.out(404, {'error': '폴더를 찾을 수 없습니다.'})
                from deploy import EXPORT_JOBS
                user = self.current_access_user()
                try:
                    EXPORT_JOBS.record_download('vlm', path, user.get('name') or user.get('username') or '사용자')
                except Exception:
                    logging.getLogger('deploy').exception('VLM download history record failed')
                return self.stream_process(vlm_zip_command(path), resolved.name + '_best.zip')
            except ValueError as exc:
                return self.out(400, {'error': str(exc)})
            except Exception as exc:
                logging.getLogger('deploy').exception('Model download failed')
                return self.out(502, {'error': str(exc)})
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

    def do_DELETE(self):
        match=re.fullmatch(r'/deploy/history/([0-9a-f]{32})',urlparse(self.path).path)
        if not match:return self.out(404,{'error':'not found'})
        if not self.authenticated():return self.out(401,{'error':'ClearML 로그인이 필요합니다.'})
        user=self.current_access_user()
        if not user.get('is_admin'):return self.out(403,{'error':'관리자 권한이 필요합니다.'})
        try:
            from deploy import EXPORT_JOBS
            if not EXPORT_JOBS.delete_history(match.group(1)):
                return self.out(404,{'error':'배포 기록을 찾을 수 없습니다.'})
            return self.out(200,{'deleted':True,'id':match.group(1)})
        except ValueError as exc:return self.out(400,{'error':str(exc)})
        except Exception as exc:
            logging.getLogger('deploy').exception('Deployment history deletion failed')
            return self.out(502,{'error':'배포 기록 삭제에 실패했습니다.'})

    def do_POST(self):
        delete_match=re.fullmatch(r'/api/v[0-9.]+/tasks\.(delete|delete_many)',urlparse(self.path).path)
        if delete_match:
            if not self.authenticated():return self.out(401,{'meta':{'result_code':401,'result_msg':'ClearML 로그인이 필요합니다.'},'data':{}})
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=65536:raise ValueError('Invalid request size')
                q=json.loads(self.rfile.read(size))
                if not isinstance(q,dict):raise ValueError('잘못된 삭제 요청입니다.')
                method='tasks.'+delete_match.group(1)
                task_ids=[q.get('task')] if method=='tasks.delete' else q.get('ids')
                if not isinstance(task_ids,list) or not task_ids or any(not isinstance(task_id,str) for task_id in task_ids):
                    raise ValueError('Task ID가 필요합니다.')
                from dataset_registry import Registry
                registry=Registry(self.headers.get('Cookie',''))
                task_ids=list(dict.fromkeys(task_ids))
                if any(not re.fullmatch(r'[a-f0-9]{32}', task_id) for task_id in task_ids):
                    raise ValueError('올바르지 않은 Task ID가 포함되어 있습니다.')

                # Archive UI can retry the same batch after a successful cascade. Query all
                # existing rows at once so already-deleted IDs remain an idempotent success.
                existing_rows=registry.call('tasks.get_all',{
                    'id':task_ids,
                    'search_hidden':True,
                    'page':0,
                    'page_size':max(1,len(task_ids)),
                    'only_fields':['id','name','project','system_tags','models'],
                }).get('tasks',[])
                existing={task['id']:task for task in existing_rows}
                missing_ids=[task_id for task_id in task_ids if task_id not in existing]
                output_models_by_id={
                    task_id:[m['model'] for m in task.get('models',{}).get('output',[]) or [] if m.get('model')]
                    for task_id,task in existing.items()
                }
                all_output_model_ids=[model_id for ids in output_models_by_id.values() for model_id in ids]
                model_uri_by_id={}
                if all_output_model_ids:
                    model_uri_by_id={
                        m['id']:m['uri'] for m in registry.call('models.get_all',{
                            'id':all_output_model_ids,'only_fields':['id','uri'],'page_size':len(all_output_model_ids),
                        }).get('models',[]) if m.get('uri')
                    }
                event_urls_by_id={
                    task_id:fetch_debug_event_urls(registry,task_id)
                    for task_id in existing
                }

                training_tasks={}
                for task_id,task in existing.items():
                    if 'dataset' in task.get('system_tags',[]):
                        continue
                    project=registry.call('projects.get_by_id',{'project':task['project']})['project']['name']
                    if project in {'Detector','VLM'}:
                        training_tasks[task_id]=(project,task.get('name',''))

                delete_plan=registry.dataset_deletion_plan(list(existing))
                delete_plan['already_deleted_ids']=missing_ids
                if self.headers.get('X-IVX-Delete-Plan') == '1':
                    return self.out(200,{
                        'meta':{'result_code':200,'result_subcode':0,'result_msg':'OK'},
                        'data':delete_plan,
                    })
                confirmed=self.headers.get('X-IVX-Dataset-Cascade') == 'confirmed'
                if delete_plan['requires_confirmation'] and not confirmed:
                    return self.out(409,{
                        'meta':{
                            'result_code':409,
                            'result_subcode':0,
                            'result_msg':'선택한 Dataset에 하위 Dataset이 있습니다. 하위 Dataset까지 함께 삭제됩니다.',
                        },
                        'data':delete_plan,
                    })
                if training_tasks and not self.authorized('TRAIN_DEPLOY'):
                    return self.out(403,{'meta':{'result_code':403,'result_subcode':0,'result_msg':'학습/배포 권한이 필요합니다.'},'data':{}})

                if confirmed and delete_plan['selected_dataset_ids']:
                    # Children are already ordered before parents and every ID appears once.
                    dataset_ids={item['id'] for item in delete_plan['delete_order']}
                    ordered_ids=[item['id'] for item in delete_plan['delete_order']]
                    ordered_ids.extend(task_id for task_id in task_ids if task_id in existing and task_id not in dataset_ids)
                    succeeded=[]
                    delete_options={key:q[key] for key in (
                        'force','move_to_trash','return_file_urls','delete_output_models',
                        'delete_external_artifacts','include_pipeline_steps','status_reason','status_message'
                    ) if key in q}
                    for delete_id in ordered_ids:
                        result=call_delete_with_cleanup(registry,'tasks.delete',{'task':delete_id,**delete_options},self.headers.get('Cookie',''),delete_options.get('return_file_urls'),output_models_by_id,model_uri_by_id,event_urls_by_id)
                        succeeded.append({'id':delete_id,**result})
                    succeeded.extend({'id':task_id,'deleted':True,'already_deleted':True} for task_id in missing_ids)
                    if method=='tasks.delete':
                        selected_result=next((item for item in succeeded if item['id']==task_ids[0]),{'deleted':True})
                        deleted={k:v for k,v in selected_result.items() if k not in {'id','already_deleted'}}
                    else:
                        deleted={'succeeded':succeeded,'failed':[]}
                    deleted['cascade_delete_order']=ordered_ids
                elif missing_ids:
                    if method=='tasks.delete':
                        deleted={'deleted':True}
                    else:
                        remaining=[task_id for task_id in task_ids if task_id in existing]
                        if remaining:
                            forwarded={**q,'ids':remaining}
                            deleted=call_delete_with_cleanup(registry,method,forwarded,self.headers.get('Cookie',''),q.get('return_file_urls'),output_models_by_id,model_uri_by_id,event_urls_by_id)
                        else:
                            deleted={'succeeded':[],'failed':[]}
                        deleted.setdefault('succeeded',[]).extend(
                            {'id':task_id,'deleted':True,'already_deleted':True} for task_id in missing_ids
                        )
                else:
                    deleted=call_delete_with_cleanup(registry,method,q,self.headers.get('Cookie',''),q.get('return_file_urls'),output_models_by_id,model_uri_by_id,event_urls_by_id)
                if method=='tasks.delete':
                    deleted_ids=set(task_ids) if deleted.get('deleted') else set()
                else:
                    deleted_ids={item.get('id') for item in deleted.get('succeeded',[]) if item.get('deleted')}
                removed=[]
                cleanup_failed=[]
                for task_id,(project,task_name) in training_tasks.items():
                    if task_id not in deleted_ids:continue
                    import subprocess
                    from training_cleanup import remote_delete_command
                    result=subprocess.run(remote_delete_command(project,task_name),capture_output=True,text=True,timeout=60,env=JOBS.child_env())
                    if result.returncode:
                        logging.getLogger('training.delete').error('Remote training folder deletion failed: %s',result.stderr[-2000:])
                        cleanup_failed.append(task_name)
                        continue
                    try:removed.extend(json.loads(result.stdout).get('removed',[]))
                    except (ValueError,AttributeError):pass
                if cleanup_failed:
                    return self.out(502,{'meta':{'result_code':502,'result_subcode':0,'result_msg':'Task는 삭제됐지만 일부 학습 폴더 삭제에 실패했습니다.'},'data':{**deleted,'removed_training_folders':removed,'cleanup_failed':cleanup_failed}})
                return self.out(200,{'meta':{'result_code':200,'result_subcode':0,'result_msg':'OK'},'data':{**deleted,'removed_training_folders':removed}})
            except (ValueError,UnicodeError) as exc:return self.out(400,{'meta':{'result_code':400,'result_msg':str(exc)},'data':{}})
            except Exception as exc:
                logging.getLogger('datasets').exception('Task delete guard failed')
                return self.out(502,{'meta':{'result_code':502,'result_msg':str(exc)},'data':{}})
        if self.path not in {'/annotations', '/detector/annotations', '/jobs', '/stop', '/stop/vlm', '/vlm/preview', '/vlm/annotations','/datasets/select','/datasets/prepare','/datasets/connect','/datasets/branch','/datasets/description','/deploy/export'} and not (self.path.startswith('/jobs/') and self.path.endswith('/stop')):
            return self.out(404, {'error': 'not found'})
        if self.headers.get('Origin') != os.environ['ANNOTATION_ALLOWED_ORIGIN']:
            return self.out(403, {'error': 'Origin rejected'})
        if not self.authenticated():
            return self.out(401, {'error': 'ClearML 로그인이 필요합니다.'})
        train_paths = {'/jobs', '/stop', '/stop/vlm', '/vlm/preview', '/vlm/annotations', '/detector/annotations', '/annotations', '/deploy/export'}
        if (self.path in train_paths or (self.path.startswith('/jobs/') and self.path.endswith('/stop'))) and not self.authorized('TRAIN_DEPLOY'):
            return self.out(403, {'error': '학습/배포 권한이 필요합니다.', 'permission': 'TRAIN_DEPLOY'})
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
                from client import ssh_command, TRAINING_ROOT
                r=subprocess.run(ssh_command('python3 '+TRAINING_ROOT+'/scripts/mlops_vlm_dataset.py'),input=json.dumps(q),capture_output=True,text=True,timeout=150,env=JOBS.child_env())
                result=json.loads(r.stdout)
                return self.out(400 if r.returncode else 200,result)
            except ValueError as exc:return self.out(400,{'error':str(exc)})
            except RuntimeError as exc:return self.out(409,{'error':str(exc)})
            except Exception as exc:return self.out(502,{'error':str(exc)})
            finally:LOCK.release()
        if self.path == '/deploy/export':
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 16384:
                    raise ValueError('Invalid request size')
                params = json.loads(self.rfile.read(size))
                if not isinstance(params, dict):
                    raise ValueError('요청 형식이 올바르지 않습니다.')
                user = self.current_access_user()
                params['deployed_by'] = user.get('name') or user.get('username') or '사용자'
                from deploy import EXPORT_JOBS
                return self.out(202, EXPORT_JOBS.start(params))
            except (ValueError, UnicodeError) as exc:
                return self.out(400, {'error': str(exc)})
            except RuntimeError as exc:
                return self.out(409, {'error': str(exc)})
            except Exception as exc:
                logging.getLogger('deploy').exception('Detector export request failed')
                return self.out(502, {'error': str(exc)})
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
