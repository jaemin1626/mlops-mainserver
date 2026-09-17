#!/usr/bin/env python3
"""Remote authoritative dataset selection, split generation and immutable uploads."""
import datetime
import hashlib
import http.client
import json
import math
import os
import random
import re
import sys
import uuid
import zipfile
from pathlib import Path
from urllib.parse import urlparse,quote
ROOT=Path(__file__).resolve().parent.parent
EXT={'.jpg','.jpeg','.png','.bmp','.webp','.tif','.tiff'}

def path_in(root,raw):
    if not isinstance(raw,str) or not raw or len(raw)>2048 or Path(raw).is_absolute() or '..' in Path(raw).parts or any(ord(c)<32 or ord(c)==127 for c in raw):raise ValueError('올바른 상대 데이터 경로가 아닙니다.')
    p=(root/raw).resolve()
    if not p.is_relative_to(root.resolve()):raise ValueError('데이터 경로가 허용 범위를 벗어납니다.')
    return p

def vlm_path_visible(path, modality):
    """Expose only user-facing Images/Videos trees; JSON and annotation stay internal."""
    if modality not in {'image','video','both'}:
        return False
    parts=Path(path).parts
    if not parts:
        return False
    top=parts[0].lower()
    allowed={'image','images'} if modality=='image' else {'video','videos'} if modality=='video' else {'image','images','video','videos'}
    return top in allowed and not any(part.lower()=='annotation' or part.lower().endswith('_json') for part in parts)

def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda:stream.read(1024*1024),b''):h.update(data)
    return h.hexdigest()

def inventory(root,kind,modality='both',classes=None):
    if kind not in {'detector','vlm'}:raise ValueError('Invalid dataset type')
    dataset=(root/'Dataset'/kind).resolve()
    if not dataset.is_dir():raise ValueError('학습 데이터 폴더가 없습니다.')
    folders=['.']+[p.relative_to(dataset).as_posix() for p in sorted(dataset.rglob('*')) if p.is_dir() and not p.is_symlink() and p.resolve().is_relative_to(dataset)]
    records={};skipped=0
    if kind=='detector':
        for p in sorted(dataset.rglob('*')):
            if not p.is_file() or p.suffix.lower() not in EXT:continue
            if not p.resolve().is_relative_to(dataset) or p.stat().st_size==0:skipped+=1;continue
            parts=list(p.relative_to(dataset).parts);indices=[i for i,c in enumerate(parts[:-1]) if c=='images']
            if indices:parts[indices[-1]]='labels'
            label=(dataset/Path(*parts)).with_suffix('.txt')
            if not label.is_file() or not label.resolve().is_relative_to(dataset):skipped+=1;continue
            max_class_id=-1
            try:
                for line in label.read_text(encoding='utf-8').splitlines():
                    if not line.strip():continue
                    bits=line.split()
                    if len(bits)!=5 or not bits[0].isascii() or not bits[0].isdigit():raise ValueError('YOLO label format')
                    class_id=int(bits[0]);max_class_id=max(max_class_id,class_id)
                    values=[float(v) for v in bits[1:]]
                    if not all(math.isfinite(v) and 0<=v<=1 for v in values) or values[2]<=0 or values[3]<=0:raise ValueError('YOLO box range')
            except (ValueError,UnicodeError):skipped+=1;continue
            key=p.resolve().relative_to(dataset).as_posix();records[key]=dict(path=key,label=label.relative_to(dataset).as_posix(),size=p.stat().st_size,max_class_id=max_class_id)
    else:
        if modality not in {'image','video','both'}:raise ValueError('Invalid VLM modality')
        sys.path.insert(0,str(root/'VLM/scripts/data'));os.environ['DATASET_ROOT']=str(root/'Dataset')
        import vlm_dataset_utils as utils
        for p in sorted(dataset.rglob('*.json')):
            # Data Studio review/workflow state is not a training annotation.
            if p.name.endswith('.meta.json'):continue
            if not p.resolve().is_relative_to(dataset):continue
            try:samples=utils.load_json_samples(p)
            except (SystemExit,UnicodeError):skipped+=1;continue
            for sample in samples:
                try:row=utils.normalize_tagging_sample(sample,p,dataset)
                except (ValueError,OSError):skipped+=1;continue
                if row is None or not utils.example_matches_modality(row,modality):skipped+=1;continue
                media=utils.resolve_media_path(utils.example_media_path(row))
                conv=row.get('conversations')
                if not media.is_relative_to(dataset) or not isinstance(conv,list) or not conv or not all(isinstance(c,dict) and isinstance(c.get('value'),str) and c.get('from') in {'human','gpt','system'} for c in conv):skipped+=1;continue
                key=media.relative_to(dataset).as_posix();label=p.relative_to(dataset).as_posix()
                if key in records:records[key]['labels'].append(label);continue
                records[key]=dict(path=key,label=label,labels=[label],size=media.stat().st_size,row=row)
    if kind=='vlm':
        folders=['.']+[folder for folder in folders if folder!='.' and vlm_path_visible(folder,modality)]
        records={key:value for key,value in records.items() if vlm_path_visible(value['path'],modality)}
    return dict(dataset_type=kind,root=str(root/'Dataset'/kind),folders=folders,records=list(records.values()),skipped=skipped)

def in_folder(path,folder):return folder=='.' or path==folder or path.startswith(folder.rstrip('/')+'/')

def select(root,q):
    kind=q['dataset_type'];catalog=inventory(root,kind,q.get('modality','both'),q.get('classes'))
    folders=q.get('selected_folders',[])
    if not isinstance(folders,list) or len(folders)>10000:raise ValueError('Invalid selected folders')
    dataset=(root/'Dataset'/kind).resolve()
    for folder in folders:
        p=path_in(dataset,folder)
        if not p.is_dir():raise ValueError('선택한 폴더가 없습니다.')
    exact=q.get('selected_files')
    if exact is not None and (not isinstance(exact,list) or len(exact)>200000 or not all(isinstance(p,str) for p in exact)):raise ValueError('Invalid selected files')
    if exact is not None:
        for p in exact:path_in(dataset,p)
        exact=set(exact)
    rows=[r for r in catalog['records'] if (r['path'] in exact if exact is not None else any(in_folder(r['path'],f) or any(in_folder(p,f) for p in r.get('labels',[r['label']])) for f in folders))]
    classes=q.get('classes')
    if kind=='detector' and isinstance(classes,list) and classes:
        max_id=max((r.get('max_class_id',-1) for r in rows),default=-1)
        if max_id>=len(classes):
            raise ValueError(f'선택한 TXT 라벨의 최대 클래스 번호는 {max_id}입니다. 검출기 학습 클래스는 {len(classes)}개이므로 클래스 번호 0~{len(classes)-1}만 사용할 수 있습니다. 클래스명을 {max_id+1}개 이상 정의하세요.')
    source=q.get('source_manifest') or {};previous={k:set(source.get(k,[])) for k in ['train','valid','test']}
    selected={r['path'] for r in rows};splits={k:[] for k in previous};unassigned=[]
    for path in sorted(selected):
        assigned=next((k for k in previous if path in previous[k]),None)
        if assigned:splits[assigned].append(path)
        else:unassigned.append(path)
    # Stable preview split; source members retain their previous split whenever possible.
    random.Random(42).shuffle(unassigned)
    validation=max(1,round(len(unassigned)*.1)) if len(unassigned)>1 else 0
    splits['valid'].extend(unassigned[:validation]);splits['train'].extend(unassigned[validation:])
    if len(selected)>1 and not splits['valid'] and len(splits['train'])>1:splits['valid'].append(splits['train'].pop())
    if selected and not splits['train']:
        donor='valid' if splits['valid'] else 'test';splits['train'].append(splits[donor].pop())
    public=[{k:v for k,v in r.items() if k not in {'row','max_class_id'}} for r in rows]
    return dict(dataset_type=kind,selected_folders=folders,selected_files=sorted(selected),train_files=splits['train'],valid_files=splits['valid'],test_files=splits['test'],source_node=source.get('source_node'),file_count=len(selected),skipped=catalog['skipped'],files=public,**splits),rows

def prepare(root,q):
    manifest,rows=select(root,q)
    if len(rows)<2:raise ValueError('유효한 학습 데이터가 최소 2개 필요합니다.')
    kind=q['dataset_type'];dataset=(root/'Dataset'/kind).resolve();classes=q.get('classes',[]);dataset_only=q.get('dataset_only') is True
    if kind=='detector' and not dataset_only:
        if not classes or len(set(classes))!=len(classes) or not all(isinstance(c,str) and c.strip() and len(c)<121 and not any(ord(x)<32 for x in c) for c in classes):raise ValueError('중복 없이 학습 클래스를 입력하세요.')
    stamp=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).strftime('%Y%m%d%H%M%S')+'-'+uuid.uuid4().hex[:8]
    output=root/('Detector/data/generated' if kind=='detector' else 'VLM/data/vlm/'+q.get('modality','both'))/stamp
    output.mkdir(parents=True,exist_ok=False);remote='/workspace/'+output.relative_to(root).as_posix()
    manifest.update(dataset_only=dataset_only,created=datetime.datetime.now(datetime.timezone.utc).isoformat(),modality=q.get('modality'),classes=classes,token=stamp,bundle=remote,files=[])
    paths={p for row in rows for p in [row['path'],row['label']]}
    for path in sorted(paths):
        file=path_in(dataset,path);manifest['files'].append(dict(path=path,size=file.stat().st_size,hash=sha(file)))
    lookup={r['path']:r for r in rows};files={}
    for key in ['train','valid','test']:
        filename=key+('.txt' if kind=='detector' else '.json')
        data='\n'.join('/workspace/Dataset/'+kind+'/'+p for p in manifest[key])+'\n' if kind=='detector' else json.dumps([lookup[p]['row'] for p in manifest[key]],ensure_ascii=False,indent=2)+'\n'
        (output/filename).write_text(data,encoding='utf-8');files[key]=remote+'/'+filename
    if kind=='detector' and not dataset_only:
        yaml='path: /workspace/Dataset/detector\ntrain: '+files['train']+'\nval: '+files['valid']+'\ntest: '+files['test']+'\nnames:\n'+'\n'.join('  '+str(i)+': '+json.dumps(c,ensure_ascii=False) for i,c in enumerate(classes))+'\n'
        (output/'data.yaml').write_text(yaml,encoding='utf-8');files['data']=remote+'/data.yaml';manifest['yaml']=yaml
    manifest['generated_files']=files;(output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return dict(ok=True,manifest=manifest,token=stamp,train=len(manifest['train']),valid=len(manifest['valid']),test=len(manifest['test']),files=files,data='data/generated/'+stamp+'/data.yaml' if kind=='detector' else None,train_json=files['train'] if kind=='vlm' else None,val_json=files['valid'] if kind=='vlm' else None,yaml=manifest.get('yaml'))

def bundle(root,q):
    kind=q['dataset_type'];token=q['token'];modality=q.get('modality','both')
    if kind not in {'detector','vlm'} or modality not in {'image','video','both'} or not re.fullmatch(r'\d{14}-[a-f0-9]{8}',token):raise ValueError('Invalid dataset bundle')
    directory=root/('Detector/data/generated' if kind=='detector' else 'VLM/data/vlm/'+modality)/token
    if not directory.resolve().is_relative_to(root.resolve()):raise ValueError('Invalid bundle path')
    manifest=json.loads((directory/'manifest.json').read_text())
    return directory,manifest

def upload_file(path,uri,cookie,allowed_netloc):
    parsed=urlparse(uri)
    if parsed.scheme!='http' or parsed.netloc!=allowed_netloc:raise ValueError('Invalid ClearML upload destination')
    conn=http.client.HTTPConnection(parsed.hostname,parsed.port,timeout=180)
    boundary='mlops-'+uuid.uuid4().hex
    object_name=parsed.path.lstrip('/')
    opening=('--'+boundary+'\r\nContent-Disposition: form-data; name="'+object_name+'"; filename="'+object_name+'"\r\nContent-Type: application/octet-stream\r\n\r\n').encode()
    closing=('\r\n--'+boundary+'--\r\n').encode()
    conn.putrequest('POST','/');conn.putheader('Content-Length',str(path.stat().st_size+len(opening)+len(closing)));conn.putheader('Content-Type','multipart/form-data; boundary='+boundary);conn.putheader('Cookie',cookie);conn.endheaders();conn.send(opening)
    with path.open('rb') as stream:
        for data in iter(lambda:stream.read(1024*1024),b''):conn.send(data)
    conn.send(closing)
    response=conn.getresponse();response.read()
    if response.status not in {200,201,204}:raise RuntimeError('Dataset 파일 업로드 실패: '+str(response.status))
    conn.close()

def upload(root,q):
    files_host=q.get('files_host','');parsed_host=urlparse(files_host)
    if parsed_host.scheme!='http' or not parsed_host.netloc:raise ValueError('Invalid ClearML files host')
    directory,manifest=bundle(root,q);kind=manifest['dataset_type'];id=q['node']['id']
    if not re.fullmatch('[a-f0-9]{32}',id):raise ValueError('Invalid dataset version ID')
    dataset=(root/'Dataset'/kind).resolve();archive=directory/'dataset.zip';entries=[]
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=1) as z:
        for file in manifest['files']:
            path=path_in(dataset,file['path'])
            if not path.is_file() or path.stat().st_size!=file['size'] or sha(path)!=file['hash']:raise ValueError('선택한 데이터가 변경됐습니다. 다시 생성하세요: '+file['path'])
            relative=kind+'/'+file['path'];z.write(path,relative);entries.append(dict(relative_path=relative,size=file['size'],hash=file['hash'],parent_dataset_id=id,artifact_name='data'))
        for name in ['manifest.json','train'+('.txt' if kind=='detector' else '.json'),'valid'+('.txt' if kind=='detector' else '.json'),'test'+('.txt' if kind=='detector' else '.json')]+(['data.yaml'] if kind=='detector' and not manifest.get('dataset_only') else []):
            path=directory/name;relative='mlops/'+q['token']+'/'+name;z.write(path,relative);entries.append(dict(relative_path=relative,size=path.stat().st_size,hash=sha(path),parent_dataset_id=id,artifact_name='data'))
    parent=q.get('parent_state') or {};graph=parent.get('dependency_graph',{}).copy();graph[id]=[q['node']['parent_id']] if q['node'].get('parent_id') else []
    state=dict(id=id,dirty=False,file_count=len(entries),total_size=sum(e['size'] for e in entries),dataset_file_entries=entries,dataset_link_entries=[],dependency_graph=graph,dependency_chunk_lookup={**parent.get('dependency_chunk_lookup',{}),id:1})
    (directory/'state.json').write_text(json.dumps(state,ensure_ascii=False))
    old={f['relative_path']:f.get('hash') for f in parent.get('dataset_file_entries',[])};new={f['relative_path']:f['hash'] for f in entries};changes=dict(ds_change_add=len(new.keys()-old.keys()),ds_change_remove=len(old.keys()-new.keys()),ds_change_modify=sum(new[k]!=old[k] for k in new.keys()&old.keys()),ds_change_size=state['total_size']-parent.get('total_size',0))
    struct=q.get('parent_struct',{}).copy();indices={v['job_id']:k for k,v in struct.items()};index=str(max([int(k) for k in struct] or [-1])+1);parentid=q['node'].get('parent_id');struct[index]=dict(job_id=id,status='completed',last_update=int(datetime.datetime.now().timestamp()),parents=[indices[parentid]] if parentid in indices else [],job_size=state['total_size'],name='Detector' if kind=='detector' else 'VLM',version=q['node']['version'])
    prefix=files_host.rstrip('/')+'/Dataset/.datasets/'+('Detector' if kind=='detector' else 'VLM')+'/'+('Detector' if kind=='detector' else 'VLM')+'.'+id+'/artifacts/'
    artifacts=[]
    for key,name,type in [('data','dataset.zip','custom'),('state','state.json','dict'),('manifest','manifest.json','dict')]:
        path=directory/name;uri=prefix+key+'/'+quote(name);upload_file(path,uri,q['cookie'],parsed_host.netloc);artifacts.append(dict(key=key,type=type,mode='output',uri=uri,hash=sha(path),content_size=path.stat().st_size,timestamp=int(datetime.datetime.now().timestamp()),type_data={'content_type':'application/zip' if key=='data' else 'application/json','preview':'MLOps Dataset '+key}))
    size=archive.stat().st_size;archive.unlink()
    return dict(artifacts=artifacts,entries=entries,struct=struct,archive_size=size,changes=changes)

if __name__=='__main__':
    try:
        q=json.load(sys.stdin);op=q.pop('operation')
        if op=='inventory':
            result=inventory(ROOT,q['dataset_type'],q.get('modality','both'));result['records']=[{k:v for k,v in r.items() if k!='row'} for r in result['records']]
        elif op=='select':result,_=select(ROOT,q)
        elif op=='prepare':result=prepare(ROOT,q)
        elif op=='bundle':_,result=bundle(ROOT,q)
        elif op=='upload':result=upload(ROOT,q)
        else:raise ValueError('Unsupported dataset operation')
        print(json.dumps(result,ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'error':str(exc)},ensure_ascii=False));sys.exit(1)
