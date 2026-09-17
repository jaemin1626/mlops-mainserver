#!/usr/bin/env python3
"""Read-only server inventory; deliberately excludes credentials and connections."""
import json
import subprocess
import sys
import datetime
from pathlib import Path
from vlm_options import SPECS
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'mount/scripts'))
import train_env

def resources():
    env = train_env.merged_env('vlm')
    keys = {spec[1] for spec in SPECS.values() if spec[1]} | {'IMAGE_MODEL','VIDEO_MODEL','BOTH_MODEL'}
    defaults = {key:env.get(key,'') for key in keys}
    gpu = subprocess.run(['nvidia-smi','--query-gpu=index,name,memory.free,memory.total','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=15,check=True)
    gpus=[]
    for line in gpu.stdout.splitlines():
        index,name,free,total=[part.strip() for part in line.split(',')]
        gpus.append(dict(id=index,name=name,free_mb=int(free),total_mb=int(total)))
    models=[]
    weights=ROOT/'VLM/weights'
    for modality in ['image','video','both']:
        folder=weights/('Image' if modality=='image' else 'Video')
        if not folder.is_dir():continue
        candidates=[folder]
        for candidate in candidates:
            directory=candidate.parent if candidate.is_file() else candidate
            if (directory/'config.json').is_file() and directory.resolve().is_relative_to(weights.resolve()):
                models.append(dict(path='/workspace/'+str(directory.relative_to(ROOT)),label=str(directory.relative_to(weights)),modality=modality))
    trained_root=ROOT/'VLM/runs/train'
    trained_models=[]
    for modality in ['image','video','both']:
        modality_root=trained_root/modality
        if not modality_root.is_dir():continue
        for directory in modality_root.iterdir():
            if not directory.is_dir() or directory.name.endswith('_plots'):continue
            marker=directory/'adapter_config.json';full_config=directory/'config.json';weights_file=directory/'adapter_model.safetensors'
            if not ((marker.is_file() and weights_file.is_file()) or full_config.is_file()):continue
            metadata={};metadata_path=directory/'deployment_metadata.json'
            try:
                if metadata_path.is_file():metadata=json.loads(metadata_path.read_text(encoding='utf-8'))
            except (OSError,ValueError):metadata={}
            adapter={}
            try:
                if marker.is_file():adapter=json.loads(marker.read_text(encoding='utf-8'))
            except (OSError,ValueError):adapter={}
            stat=directory.stat()
            trained_models.append(dict(path='/workspace/'+str(directory.relative_to(ROOT)),label=metadata.get('model_name') or directory.name,model_name=metadata.get('model_name') or directory.name,modality=modality,base_model=metadata.get('base_model') or adapter.get('base_model_name_or_path') or '',epoch=metadata.get('epoch'),created_at=metadata.get('created_at') or datetime.datetime.fromtimestamp(stat.st_mtime,datetime.timezone.utc).isoformat(),status=metadata.get('status') or 'completed',size=sum(item.stat().st_size for item in directory.rglob('*') if item.is_file())))
    trained_models.sort(key=lambda item:item['created_at'],reverse=True)
    datasets=[]
    for base in [ROOT/'VLM/data/vlm',ROOT/'VLM/annotation/vlm', ROOT/'Dataset/vlm']:
        if not base.is_dir():continue
        paths=sorted(base.rglob('*.json')) if base!=ROOT/'Dataset/vlm' else sorted(p for folder in ['image_json','video_json','images_json','videos_json'] for p in (base/folder).glob('*.json'))
        paths += [base/m/'latest'/f for m in ['image','video','both'] for f in ['train.json','valid.json']]
        for path in paths:
            if not path.is_file() or not path.resolve().is_relative_to(base.resolve()):continue
            relative=str(path.relative_to(ROOT))
            if any(x in path.name for x in ['manifest','metrics','config']):continue
            modality=next((m for m in ['image','video','both'] if m in path.parts or m+'_json' in path.parts or {'image':'images_json','video':'videos_json','both':'both_json'}[m] in path.parts), 'both')
            datasets.append(dict(path='/workspace/'+relative,label=relative,modality=modality,role='validation' if path.name in {'valid.json','val.json','test.json'} else 'train'))
    datasets=list({d['path']:d for d in datasets}.values())[:1000]
    automatic={}
    for modality in ['image','video','both']:
        latest=ROOT/'VLM/annotation/vlm'/modality/'latest'
        legacy=ROOT/'VLM/annotation/vlm/latest'
        def auto_file(key,filename):
            explicit=env.get(key,'').strip()
            if explicit:return [explicit]
            for base in [latest,legacy]:
                if (base/filename).is_file():return ['/workspace/'+str((base/filename).relative_to(ROOT))]
            if key=='VAL_JSON':return []
            return [d['path'] for d in datasets if d['role']=='train' and '/Dataset/' in d['path'] and (d['modality']==modality or modality=='both')]
        automatic[modality]={'train_json':auto_file('TRAIN_JSON','train.json'),'val_json':auto_file('VAL_JSON','valid.json')}
    launcher=(ROOT/'scripts/train.sh').read_text()
    env_source=(ROOT/'mount/scripts/train_env.py').read_text()
    supported=all(flag in launcher and (not key or key in env_source) for flag,key,_ in SPECS.values() if flag.startswith(('--lora-','--video-','--gradient-checkpointing','--validation-','--max-samples','--eval-steps','--logging-steps','--save-')))
    dataset_root=ROOT/'Dataset/vlm'
    folders=[p.relative_to(dataset_root).as_posix() for p in sorted(dataset_root.rglob('*')) if p.is_dir() and not p.is_symlink() and p.resolve().is_relative_to(dataset_root.resolve())]
    return dict(folders=folders,defaults=defaults,gpus=gpus,models=models,trained_models=trained_models,datasets=datasets,automatic=automatic,advanced_supported=supported)

if __name__=='__main__':
    try: print(json.dumps(resources(),ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'error':str(exc)}));sys.exit(1)
