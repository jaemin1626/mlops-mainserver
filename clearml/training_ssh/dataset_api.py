"""Tree API orchestration and verified Dataset version association."""
import json
import subprocess
from client import ssh_command
from detector import JOBS
from dataset_registry import Registry,NAMES

def remote(operation,q):
    result=subprocess.run(ssh_command('python3 /home/intellivix/train/scripts/mlops_dataset_tree.py'),input=json.dumps({'operation':operation,**q}),capture_output=True,text=True,timeout=300,env=JOBS.child_env())
    try:data=json.loads(result.stdout)
    except ValueError as exc:raise RuntimeError('데이터 처리 서버 응답 오류: '+result.stderr[-300:]) from exc
    if result.returncode:raise ValueError(data.get('error','데이터 처리 실패'))
    return data

def query(q,cookie):
    if not isinstance(q,dict) or q.keys()-{'dataset_type','selected_folders','selected_files','source_id','modality','classes','token','branch_name','new_branch','version','description','dataset_only'}:raise ValueError('Unsupported dataset parameters')
    kind=q.get('dataset_type')
    if kind not in NAMES:raise ValueError('Invalid dataset type')
    clean=dict(q);source=clean.pop('source_id',None);clean.pop('branch_name',None);clean.pop('new_branch',None);clean.pop('version',None);clean.pop('description',None)
    if source:clean['source_manifest']=Registry(cookie).get_dataset_manifest(kind,source)
    return clean

def connect(q,cookie):
    clean=query(q,cookie);directory_manifest=remote('bundle',clean)
    source_id=q.get('source_id');registry=Registry(cookie)
    # Confirm source identity and generated selection before creating any native task.
    if (directory_manifest.get('source_node') or {}).get('id')!=source_id:raise ValueError('부모 버전이 변경됐습니다. 데이터를 다시 생성하세요.')
    if sorted(directory_manifest['selected_folders'])!=sorted(q.get('selected_folders',[])):raise ValueError('폴더 선택이 변경됐습니다. 데이터를 다시 생성하세요.')
    if q.get('selected_files') is not None and sorted(directory_manifest['selected_files'])!=sorted(q['selected_files']):raise ValueError('파일 선택이 변경됐습니다. 데이터를 다시 생성하세요.')
    parent_task=registry.get_dataset_version(q['dataset_type'],source_id) if source_id else None
    parent_branch=(parent_task or {}).get('runtime',{}).get('dataset_branch') or 'v1'
    branch_name=q.get('branch_name') or parent_branch;new_branch=q.get('new_branch',False)
    if not isinstance(new_branch,bool) or not isinstance(branch_name,str):raise ValueError('Dataset Branch 설정이 올바르지 않습니다.')
    branches=registry.graph(q['dataset_type']).get('branches',[parent_branch]);branches=branches if isinstance(branches,list) else [parent_branch]
    if new_branch and branch_name in branches:raise ValueError('이미 존재하는 Dataset Branch입니다.')
    if not new_branch and branch_name not in branches:raise ValueError('선택한 Dataset Branch가 존재하지 않습니다.')
    if not new_branch and branch_name!=parent_branch:raise ValueError('선택한 Version과 Branch가 일치하지 않습니다.')
    directory_manifest['dataset_branch']=branch_name
    parent_state=registry.state(parent_task) if parent_task else {}
    parent_struct=json.loads(parent_task.get('configuration',{}).get('Dataset Struct',{}).get('value','{}')) if parent_task else {}
    node=None
    try:
        node=registry.create_dataset_version(q['dataset_type'],source_id,directory_manifest,version=q.get('version'),description=q.get('description'))
        uploaded=remote('upload',{'dataset_type':q['dataset_type'],'modality':q.get('modality','both'),'token':q['token'],'node':node,'parent_state':parent_state,'parent_struct':parent_struct,'cookie':cookie})
        registry.upload_dataset_files(node,uploaded)
        linked=registry.finalize_dataset_version(node,directory_manifest,uploaded,parent_task)
        return dict(ok=True,source_node=linked,manifest=directory_manifest)
    except Exception:
        if node:
            try:registry.call('tasks.failed',{'task':node['id'],'force':True,'status_reason':'MLOps Dataset version creation failed; training not started'})
            except Exception:pass
        raise

META={'dataset_branch','dataset_project','dataset_name','dataset_version','dataset_parent_version','dataset_id','dataset_manifest','train_list','valid_list','test_list','valid_json','dataset_token','dataset_modality'}
def training_metadata(params,cookie):
    metadata={k:params.pop(k) for k in list(params) if k in META}
    if not metadata:return None
    kind=params['type'];token=metadata.get('dataset_token')
    manifest=remote('bundle',{'dataset_type':kind,'modality':metadata.get('dataset_modality','both'),'token':token})
    files=manifest['generated_files'];expected=manifest['bundle']+'/manifest.json'
    if metadata.get('dataset_manifest')!=expected:raise ValueError('Dataset manifest 경로가 일치하지 않습니다.')
    if kind=='vlm':
        if params.get('train_json')!=files['train'] or params.get('val_json')!=files['valid']:raise ValueError('생성된 Dataset 학습·검증 JSON과 다릅니다.')
    elif params.get('data')!='data/generated/'+token+'/data.yaml':raise ValueError('생성된 Dataset YAML과 다릅니다.')
    id=metadata.get('dataset_id')
    if id:
        r=Registry(cookie);task=r.get_dataset_version(kind,id)
        if task['status'] not in {'completed','published'}:raise ValueError('확정된 Dataset 버전이 아닙니다.')
        native=r.get_dataset_manifest(kind,id)
        if task.get('runtime',{}).get('version')!=metadata.get('dataset_version'):raise ValueError('Dataset 버전 불일치')
        if (task.get('runtime',{}).get('dataset_branch') or 'v1')!=metadata.get('dataset_branch','v1'):raise ValueError('Dataset 브랜치 불일치')
        # A source version can be used with a changed selection when no new version is requested.
        metadata['selection_modified']=set(native['selected_files'])!=set(manifest['selected_files'])
    metadata['train_list' if kind=='detector' else 'train_json']=files['train']
    metadata['valid_list' if kind=='detector' else 'valid_json']=files['valid']
    if kind=='detector':metadata['test_list']=files['test']
    return metadata
