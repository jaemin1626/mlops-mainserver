"""Native ClearML Dataset registration over HTTP, without the ClearML SDK."""
import hashlib
import io
import json
import os
import re
import time
import urllib.request
import zipfile
from urllib.parse import urlparse, quote
from client import TRAINING_ROOT

API=os.getenv('DATASET_API_URL','http://apiserver:8008')
# No hardcoded fallback IP: CLEARML_FILES_HOST is derived from CLEARML_SERVER_IP by
# packaging/apply-env.sh, so an empty default here fails closed instead of silently
# trusting a stale dev-server address if the env var is ever missing.
FILES=os.getenv('CLEARML_FILES_HOST','')
NAMES={'detector':'Detector','vlm':'VLM'}

class RangeFile(io.RawIOBase):
    def __init__(self,registry,uri,size):self.registry=registry;self.uri=uri;self.size=size;self.position=0
    def seekable(self):return True
    def readable(self):return True
    def tell(self):return self.position
    def seek(self,offset,whence=0):
        self.position=(0 if whence==0 else self.position if whence==1 else self.size)+offset
        return self.position
    def read(self,size=-1):
        size=self.size-self.position if size<0 else min(size,self.size-self.position)
        if size<=0:return b''
        result=self.registry.download(self.uri,headers={'Range':f'bytes={self.position}-{self.position+size-1}'},limit=size,require_range=True)
        self.position+=len(result);return result

class Registry:
    def __init__(self,cookie):self.cookie=cookie
    def call(self,method,payload):
        req=urllib.request.Request(API+'/'+method,data=json.dumps(payload).encode(),headers={'Cookie':self.cookie,'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=40) as response:result=json.load(response)
        except Exception as exc:raise RuntimeError('ClearML '+method+' 요청 실패: '+str(exc)) from exc
        if result.get('meta',{}).get('result_code')!=200:raise RuntimeError('ClearML '+method+': '+str(result.get('meta',{}).get('result_msg','요청 거부')))
        return result.get('data',{})
    def download(self,uri,headers=None,limit=16000000,require_range=False):
        parsed=urlparse(uri);allowed=urlparse(FILES)
        if parsed.scheme!=allowed.scheme or parsed.netloc!=allowed.netloc:raise ValueError(f'허용된 ClearML 파일 서버의 아티팩트가 아닙니다. (uri={parsed.scheme}://{parsed.netloc}, allowed={allowed.scheme}://{allowed.netloc})')
        req=urllib.request.Request(uri,headers={'Cookie':self.cookie,**(headers or {})})
        with urllib.request.urlopen(req,timeout=60) as response:
            if require_range and response.status!=206:raise RuntimeError('파일 서버가 Dataset 부분 다운로드를 지원하지 않습니다.')
            data=response.read(limit+1)
        if len(data)>limit:raise ValueError('아티팩트 크기 제한 초과')
        return data
    def list_dataset_nodes(self,kind):
        if kind not in NAMES:raise ValueError('Invalid dataset type')
        name=NAMES[kind]
        projects=self.call('projects.get_all',{'name':'^Dataset(?:/|$)','search_hidden':True,'page_size':500}).get('projects',[])
        project_ids={p['id'] for p in projects if p['name'] in {'Dataset','Dataset/.datasets/'+name}}
        tasks=[]
        for page in range(100):
            rows=self.call('tasks.get_all',{'system_tags':['dataset'],'name':'^'+name+'$','project':list(project_ids),'page':page,'page_size':100,'only_fields':['id','name','project','created','status','runtime'],'order_by':['-created']}).get('tasks',[]) if project_ids else []
            tasks.extend(rows)
            if len(rows)<100:break
        versions=[dict(id=t['id'],version=t.get('runtime',{}).get('version',''),branch=t.get('runtime',{}).get('dataset_branch') or 'v1',status=t['status'],created=t.get('created'),modality=t.get('runtime',{}).get('dataset_modality',''),file_count=t.get('runtime',{}).get('ds_file_count',0)+t.get('runtime',{}).get('ds_link_count',0)) for t in tasks]
        return [dict(id=name,dataset_name=name,project='Dataset',versions=versions)] if versions else []
    def list_dataset_versions(self,kind):
        nodes=self.list_dataset_nodes(kind);return nodes[0]['versions'] if nodes else []
    def get_dataset_version(self,kind,id):
        if not re.fullmatch('[a-f0-9]{32}',id or ''):raise ValueError('Invalid Dataset ID')
        task=self.call('tasks.get_by_id',{'task':id})['task']
        project=self.call('projects.get_by_id',{'project':task['project']})['project']['name']
        if task['name']!=NAMES.get(kind) or 'dataset' not in task.get('system_tags',[]) or project not in {'Dataset','Dataset/.datasets/'+NAMES[kind]}:raise ValueError('다른 Dataset의 버전입니다.')
        return task
    def state(self,task):
        artifact=next((a for a in task.get('execution',{}).get('artifacts',[]) if a['key']=='state'),None)
        if not artifact:raise ValueError('Dataset state 아티팩트가 없습니다.')
        return json.loads(self.download(artifact['uri']))
    def get_dataset_manifest(self,kind,id):
        task=self.get_dataset_version(kind,id);state=self.state(task)
        native=next((a for a in task.get('execution',{}).get('artifacts',[]) if a['key']=='manifest'),None)
        if native:
            manifest=json.loads(self.download(native['uri']))
            return {**manifest,'source_node':{'project':'Dataset','dataset':NAMES[kind],'version':task['runtime']['version'],'branch':task.get('runtime',{}).get('dataset_branch') or 'v1','id':id},'dataset_name':NAMES[kind],'dataset_version':task['runtime']['version'],'parent_version':task.get('runtime',{}).get('dataset_parent_version')}
        entries=state.get('dataset_file_entries',[])+state.get('dataset_link_entries',[])
        media=[e for e in entries if e['relative_path'].startswith(kind+'/') and e['relative_path'].lower().endswith(('.jpg','.jpeg','.png','.bmp','.webp','.tif','.tiff','.mp4','.avi','.mov','.mkv','.webm'))]
        splits={key:[] for key in ['train','valid','test']}
        owners={};archives={}
        for entry in entries:
            name=entry['relative_path'].split('/')[-1]
            key={'train.txt':'train','valid.txt':'valid','val.txt':'valid','test.txt':'test','train.json':'train','valid.json':'valid','val.json':'valid','test.json':'test'}.get(name)
            if not key:continue
            owner=entry.get('parent_dataset_id',id)
            if owner not in owners:owners[owner]=self.call('tasks.get_by_id',{'task':owner})['task']
            artifact=next((a for a in owners[owner].get('execution',{}).get('artifacts',[]) if a['key']==entry.get('artifact_name','data')),None)
            if not artifact:raise ValueError('분할 목록의 원본 파일 아티팩트를 찾을 수 없습니다.')
            uri=artifact['uri']
            if uri not in archives:archives[uri]=zipfile.ZipFile(RangeFile(self,uri,artifact['content_size']))
            text=archives[uri].read(entry['relative_path']).decode('utf-8')
            rows=json.loads(text) if name.endswith('.json') else text.splitlines()
            for row in rows:
                path=row if isinstance(row,str) else row.get('image',row.get('video',''))
                prefixes=['/workspace/Dataset/'+kind+'/',TRAINING_ROOT+'/Dataset/'+kind+'/',kind+'/']
                for prefix in prefixes:
                    if path.startswith(prefix):path=path[len(prefix):];break
                if path:splits[key].append(path)
        for archive in archives.values():archive.close()
        media_paths={e['relative_path'][len(kind)+1:] for e in media}
        split_paths={p for rows in splits.values() for p in rows}
        selected=sorted(media_paths&split_paths if split_paths else media_paths)
        # Legacy versions may contain auxiliary/cache files but selection is media based.
        parents=state.get('dependency_graph',{}).get(id,[])
        parent_version=self.call('tasks.get_by_id',{'task':parents[0]})['task'].get('runtime',{}).get('version') if parents else None
        return dict(created=task.get('created'),dataset_type=kind,dataset_name=NAMES[kind],dataset_version=task.get('runtime',{}).get('version'),parent_version=parent_version,source_node={'project':'Dataset','dataset':NAMES[kind],'version':task.get('runtime',{}).get('version'),'branch':task.get('runtime',{}).get('dataset_branch') or 'v1','id':id,'parent_version':parent_version},selected_files=selected,selected_folders=sorted({p.rsplit('/',1)[0] if '/' in p else '.' for p in selected}),file_count=len(media),files=[dict(path=e['relative_path'][len(kind)+1:],size=e.get('size'),hash=e.get('hash')) for e in media],**splits,dependency_graph=state.get('dependency_graph',{}),legacy=True)

    @staticmethod
    def _config_json(task,key,default):
        raw=task.get('configuration',{}).get(key,{}).get('value')
        if not raw:return default
        try:return json.loads(raw)
        except (TypeError,ValueError):return default

    def record_training_usage(self,kind,dataset_id,training_task,model_type):
        """Persist the reverse link from a Dataset node to a ClearML training task."""
        dataset=self.get_dataset_version(kind,dataset_id)
        usage=self._config_json(dataset,'Training Usage',[])
        if not isinstance(usage,list):usage=[]
        task_id=training_task.get('id')
        if not task_id:return
        entry=dict(task_id=task_id,name=training_task.get('name') or task_id,
                   model_type=model_type,status=training_task.get('status') or 'in_progress',
                   used_at=training_task.get('created') or time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()))
        usage=[entry if row.get('task_id')==task_id else row for row in usage if isinstance(row,dict)]
        if not any(row.get('task_id')==task_id for row in usage):usage.append(entry)
        configs=dict(dataset.get('configuration',{}))
        configs['Training Usage']={'name':'Training Usage','type':'json','value':json.dumps(usage,ensure_ascii=False)}
        self.call('tasks.edit',{'task':dataset_id,'force':True,'configuration':configs})

    def update_description(self,kind,id,description):
        if not isinstance(description,str) or len(description)>4000:raise ValueError('설명은 4,000자 이내로 입력하세요.')
        task=self.get_dataset_version(kind,id)
        self.call('tasks.edit',{'task':task['id'],'force':True,'comment':description.strip()})
        return dict(ok=True,id=id,description=description.strip())

    def dataset_details(self,kind,id):
        task=self.get_dataset_version(kind,id);manifest=self.get_dataset_manifest(kind,id)
        parent_id=task.get('runtime',{}).get('dataset_parent_id') or None
        parent_manifest=self.get_dataset_manifest(kind,parent_id) if parent_id else None
        current=set(manifest.get('selected_files',[]));previous=set((parent_manifest or {}).get('selected_files',[]))
        added=sorted(current-previous) if parent_manifest else sorted(current)
        removed=sorted(previous-current) if parent_manifest else []
        usage=self._config_json(task,'Training Usage',[])
        # Backfill historical runs created before Dataset-side reverse links existed.
        known={row.get('task_id') for row in usage if isinstance(row,dict)} if isinstance(usage,list) else set()
        for page in range(20):
            rows=self.call('tasks.get_all',{'page':page,'page_size':100,'only_fields':['id','name','created','last_update','status','type','configuration'],'order_by':['-created']}).get('tasks',[])
            for training in rows:
                metadata=self._config_json(training,'MLOps Dataset',{})
                if isinstance(metadata,dict) and metadata.get('dataset_id')==id and training.get('id') not in known:
                    usage.append(dict(task_id=training.get('id'),name=training.get('name') or training.get('id'),model_type=metadata.get('dataset_name') or kind,status=training.get('status'),used_at=training.get('created')))
                    known.add(training.get('id'))
            if len(rows)<100:break
        refreshed=[]
        for row in usage if isinstance(usage,list) else []:
            if not isinstance(row,dict):continue
            item=dict(row);task_id=item.get('task_id')
            if task_id:
                try:
                    training=self.call('tasks.get_by_id',{'task':task_id})['task']
                    item.update(name=training.get('name') or item.get('name'),status=training.get('status') or item.get('status'),last_update=training.get('last_update'))
                except Exception:pass
            refreshed.append(item)
        files=manifest.get('selected_files',[])
        return dict(id=id,description=task.get('comment',''),selected_files=files,
                    selected_folders=manifest.get('selected_folders',[]),file_count=len(files),
                    splits={key:len(manifest.get(key,[])) for key in ('train','valid','test')},
                    changes=dict(added_count=len(added),removed_count=len(removed),added=added,removed=removed),
                    training_usage=sorted(refreshed,key=lambda row:row.get('used_at') or '',reverse=True))
    def project(self,name,tags):
        projects=self.call('projects.get_all',{'name':'^'+re.escape(name)+'$','search_hidden':True}).get('projects',[])
        if projects:return projects[0]['id']
        return self.call('projects.create',{'name':name,'system_tags':tags})['id']
    def create_dataset_version(self,kind,parent,manifest,version=None,description=None):
        versions=self.list_dataset_versions(kind)
        latest=versions[0]['version'] if versions else '0'
        parts=latest.split('.')
        version=version or ('.'.join(parts[:-1]+[str(int(parts[-1])+1)]) if all(p.isdigit() for p in parts) else str(time.time_ns()))
        if not isinstance(version,str) or not re.fullmatch(r'[\w][\w._-]{0,63}',version,re.UNICODE):raise ValueError('버전은 영문·숫자로 시작하고 영문·숫자·점·밑줄·하이픈만 사용할 수 있습니다.')
        if any(v['version']==version for v in versions):raise ValueError('이미 존재하는 Dataset version입니다.')
        if parent and self.get_dataset_version(kind,parent)['status'] not in {'completed','published'}:raise ValueError('확정된 Dataset 버전만 부모로 연결할 수 있습니다.')
        self.project('Dataset',[]);self.project('Dataset/.datasets',['hidden'])
        project=self.project('Dataset/.datasets/'+NAMES[kind],['dataset','hidden'])
        id=self.call('tasks.create',{'name':NAMES[kind],'project':project,'type':'data_processing','system_tags':['dataset'],'tags':['MLOps'],'comment':description or 'Created from the MLOps folder tree over REST API.'})['id']
        self.call('tasks.started',{'task':id,'force':True})
        return dict(id=id,version=version,parent_id=parent)
    def graph(self,kind):
        versions=self.list_dataset_versions(kind)
        nodes=[]
        for version in versions:
            task=self.get_dataset_version(kind,version['id']);runtime=task.get('runtime',{})
            parent=runtime.get('dataset_parent_id') or None
            if not parent:
                try:
                    struct=json.loads(task.get('configuration',{}).get('Dataset Struct',{}).get('value','{}'))
                    own=next(v for v in struct.values() if v.get('job_id')==task['id']);indices={k:v.get('job_id') for k,v in struct.items()}
                    parents=own.get('parents',[]);parent=indices.get(str(parents[0])) if parents else None
                except (ValueError,KeyError,TypeError,StopIteration):parent=None
            nodes.append(dict(id=task['id'],name=task['name'],version=runtime.get('version',''),branch=runtime.get('dataset_branch') or 'v1',parent_id=parent,created_at=task.get('created'),last_update=task.get('last_update'),size=runtime.get('ds_total_size',0),compressed_size=runtime.get('ds_total_size_compressed',0),file_count=runtime.get('ds_file_count',0)+runtime.get('ds_link_count',0),status=task.get('status'),description=task.get('comment',''),modality=runtime.get('dataset_modality','')))
        known={n['id'] for n in nodes};latest=max(nodes,key=lambda n:n.get('created_at') or '')['id'] if nodes else None
        for node in nodes:
            if node['parent_id'] not in known:node['parent_id']=None
            node['children']=[dict(id=c['id'],version=c['version']) for c in nodes if c['parent_id']==node['id']]
            node['latest']=node['id']==latest
        return dict(dataset_name=NAMES[kind],project='Dataset',branches=sorted({n['branch'] for n in nodes}),nodes=nodes,edges=[dict(source=n['parent_id'],target=n['id']) for n in nodes if n['parent_id']])
    def upload_bytes(self,task_id,dataset_name,key,name,data,content_type='application/json'):
        import uuid
        boundary='mlops-'+uuid.uuid4().hex;path=f'Dataset/.datasets/{dataset_name}/{dataset_name}.{task_id}/artifacts/{key}/{name}'
        opening=(f'--{boundary}\r\nContent-Disposition: form-data; name="{path}"; filename="{path}"\r\nContent-Type: {content_type}\r\n\r\n').encode();closing=(f'\r\n--{boundary}--\r\n').encode()
        req=urllib.request.Request(FILES+'/',data=opening+data+closing,headers={'Cookie':self.cookie,'Content-Type':'multipart/form-data; boundary='+boundary},method='POST')
        with urllib.request.urlopen(req,timeout=60) as response:
            if response.status!=200:raise RuntimeError('Dataset 아티팩트 업로드 실패')
        return dict(key=key,type='dict',mode='output',uri=FILES+'/'+path,hash=hashlib.sha256(data).hexdigest(),content_size=len(data),timestamp=int(time.time()),type_data={'content_type':content_type,'preview':'MLOps Dataset '+key})
    def create_branch(self,kind,parent_id,version,description='',branch_name=None,new_branch=False):
        parent=self.get_dataset_version(kind,parent_id);parent_state=self.state(parent);manifest=self.get_dataset_manifest(kind,parent_id)
        parent_branch=parent.get('runtime',{}).get('dataset_branch') or 'v1';branch_name=branch_name or parent_branch
        if not isinstance(branch_name,str) or not re.fullmatch(r'[\w][\w._-]{0,63}',branch_name,re.UNICODE):raise ValueError('브랜치 이름은 영문·숫자로 시작하고 영문·숫자·점·밑줄·하이픈만 사용할 수 있습니다.')
        existing_branches=self.graph(kind).get('branches',[parent_branch])
        if new_branch and branch_name in existing_branches:raise ValueError('이미 존재하는 브랜치 이름입니다.')
        if not new_branch and branch_name not in existing_branches:raise ValueError('존재하지 않는 브랜치입니다. 새 브랜치 생성을 사용하세요.')
        node=None
        try:
            node=self.create_dataset_version(kind,parent_id,manifest,version=version,description=description)
            state=dict(parent_state);graph=dict(state.get('dependency_graph',{}));graph[node['id']]=[parent_id];state.update(id=node['id'],dirty=False,dependency_graph=graph)
            lookup=dict(state.get('dependency_chunk_lookup',{}));lookup[node['id']]=0;state['dependency_chunk_lookup']=lookup
            manifest={**manifest,'dataset_version':version,'dataset_branch':branch_name,'parent_version':parent.get('runtime',{}).get('version'),'source_node':{'project':'Dataset','dataset':NAMES[kind],'version':version,'id':node['id'],'parent_version':parent.get('runtime',{}).get('version')}}
            state_data=json.dumps(state,ensure_ascii=False).encode();manifest_data=json.dumps(manifest,ensure_ascii=False).encode()
            artifacts=[self.upload_bytes(node['id'],NAMES[kind],'state','state.json',state_data),self.upload_bytes(node['id'],NAMES[kind],'manifest','manifest.json',manifest_data)]
            struct=json.loads(parent.get('configuration',{}).get('Dataset Struct',{}).get('value','{}'));indices={v.get('job_id'):k for k,v in struct.items()};index=str(max([int(k) for k in struct] or [-1])+1)
            struct[index]=dict(job_id=node['id'],status='completed',last_update=int(time.time()),parents=[indices[parent_id]] if parent_id in indices else [],job_size=state.get('total_size',0),name=NAMES[kind],version=version)
            uploaded=dict(artifacts=artifacts,entries=state.get('dataset_file_entries',[])+state.get('dataset_link_entries',[]),struct=struct,archive_size=parent.get('runtime',{}).get('ds_total_size_compressed',0),changes=dict(ds_change_add=0,ds_change_remove=0,ds_change_modify=0,ds_change_size=0))
            self.upload_dataset_files(node,uploaded);linked=self.finalize_dataset_version(node,manifest,uploaded,parent)
            return dict(ok=True,node=linked,graph=self.graph(kind))
        except Exception:
            if node:
                try:self.call('tasks.failed',{'task':node['id'],'force':True,'status_reason':'Dataset branch creation failed'})
                except Exception:pass
            raise
    def dataset_deletion_plan(self, task_ids):
        """Return a de-duplicated, child-first deletion plan for Dataset tasks."""
        selected = list(dict.fromkeys(task_ids))
        nodes = {}
        children = {}
        for kind in NAMES:
            for node in self.graph(kind).get('nodes', []):
                item = {**node, 'dataset_type': kind, 'dataset_name': NAMES[kind]}
                nodes[item['id']] = item
                children.setdefault(item['id'], [])
        for node in nodes.values():
            parent_id = node.get('parent_id')
            if parent_id in nodes:
                children.setdefault(parent_id, []).append(node['id'])

        selected_dataset_ids = [task_id for task_id in selected if task_id in nodes]
        visited = set()
        visiting = set()
        descendant_ids = set()
        delete_order = []

        def visit(task_id, root_id):
            if task_id in visited:
                if task_id != root_id:
                    descendant_ids.add(task_id)
                return
            if task_id in visiting:
                raise ValueError('Dataset 관계에 순환 참조가 있어 삭제할 수 없습니다.')
            visiting.add(task_id)
            for child_id in children.get(task_id, []):
                descendant_ids.add(child_id)
                visit(child_id, root_id)
            visiting.remove(task_id)
            visited.add(task_id)
            delete_order.append(task_id)

        for task_id in selected_dataset_ids:
            visit(task_id, task_id)

        def public(task_id):
            node = nodes[task_id]
            return {
                'id': task_id,
                'dataset_name': node.get('dataset_name') or node.get('name') or 'Dataset',
                'version': node.get('version') or '',
                'parent_id': node.get('parent_id'),
            }

        return {
            'selected_dataset_ids': selected_dataset_ids,
            'selected': [public(task_id) for task_id in selected_dataset_ids],
            'descendants': [public(task_id) for task_id in delete_order if task_id in descendant_ids],
            'delete_order': [public(task_id) for task_id in delete_order],
            'requires_confirmation': bool(descendant_ids),
        }

    def children(self,task_id):
        for kind in NAMES:
            graph=self.graph(kind)
            if any(n['id']==task_id for n in graph['nodes']):return [n for n in graph['nodes'] if n['parent_id']==task_id]
        return []
    def upload_dataset_files(self,node,uploaded):
        self.call('tasks.add_or_update_artifacts',{'task':node['id'],'artifacts':uploaded['artifacts']})
    def finalize_dataset_version(self,node,manifest,uploaded,parent_task=None):
        id=node['id'];parent=node['parent_id'];parent_version=parent_task.get('runtime',{}).get('version') if parent_task else None
        config={'Dataset Struct':{'name':'Dataset Struct','type':'json','value':json.dumps(uploaded['struct'])},'MLOps Manifest':{'name':'MLOps Manifest','type':'json','value':json.dumps({k:manifest.get(k) for k in ['dataset_type','selected_folders','file_count','dataset_branch']})},'Dataset Content':{'name':'Dataset Content','type':'CSV','value':'File Name,File Size,Hash (SHA2)\n'+'\n'.join(f"{e['relative_path']},{e['size']},{e['hash']}" for e in uploaded['entries'])}}
        runtime=dict(version=node['version'],dataset_branch=manifest.get('dataset_branch') or (parent_task or {}).get('runtime',{}).get('dataset_branch') or 'v1',orig_dataset_name=NAMES[manifest['dataset_type']],orig_dataset_id=id,ds_file_count=len(uploaded['entries']),ds_link_count=0,ds_total_size=sum(e['size'] for e in uploaded['entries']),ds_total_size_compressed=uploaded['archive_size'],dataset_parent_version=parent_version or '',dataset_parent_id=parent or '',dataset_modality=manifest.get('modality') or '',**uploaded['changes'])
        self.call('tasks.edit',{'task':id,'force':True,'runtime':runtime,'configuration':config,'hyperparams':{'properties':{'version':{'section':'properties','name':'version','value':node['version'],'type':'str'}}}})
        self.call('tasks.completed',{'task':id,'force':True})
        task=self.get_dataset_version(manifest['dataset_type'],id)
        if task['status']!='completed' or task.get('runtime',{}).get('version')!=node['version']:raise RuntimeError('Dataset version 확정 검증 실패')
        return dict(project='Dataset',dataset=NAMES[manifest['dataset_type']],version=node['version'],branch=runtime['dataset_branch'],id=id,parent_id=parent,parent_version=parent_version)
