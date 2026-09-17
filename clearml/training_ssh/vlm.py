"""Validated VLM requests using the existing shared train.sh entrypoint."""
import json
import math
import re
import shlex
import subprocess
from pathlib import PurePosixPath
from client import ssh_command, TRAINING_ROOT
from vlm_options import SPECS, LORA, VIDEO, value_valid
SCRIPT=TRAINING_ROOT+'/scripts/train.sh'

def resources():
    from detector import Jobs
    result=subprocess.run(ssh_command('python3 '+TRAINING_ROOT+'/scripts/mlops_vlm_probe.py'),capture_output=True,text=True,timeout=30,env=Jobs.child_env())
    if result.returncode:raise RuntimeError('VLM 서버 설정 조회 실패: '+result.stdout[-1000:])
    return json.loads(result.stdout)


def container_path(value,kind):
    if '\\' in value or '..' in PurePosixPath(value).parts:raise ValueError('상위 경로 이동 불가')
    if value.startswith(TRAINING_ROOT+'/'):value='/workspace/'+value.removeprefix(TRAINING_ROOT+'/')
    if kind=='model' and not value.startswith('/'):value='/workspace/VLM/'+str(PurePosixPath(value))
    path=PurePosixPath(value)
    roots=['/workspace/VLM/weights'] if kind=='model' else ['/workspace/VLM/data/vlm','/workspace/VLM/annotation/vlm','/workspace/Dataset/vlm']
    if not any(path.is_relative_to(root) for root in roots) or kind=='json' and path.suffix!='.json':raise ValueError('허용된 모델·데이터 경로를 선택하세요.')
    return str(path)

def prepare(params,catalog=None):
    if not isinstance(params,dict) or params.get('type')!='vlm':raise ValueError('type must be vlm')
    if params.keys()-({'type'}|SPECS.keys()):raise ValueError('지원하지 않는 VLM 설정')
    catalog=catalog if catalog is not None else resources()
    if not catalog.get('advanced_supported'):raise RuntimeError('학습 서버 고급 설정 연동 미적용')
    defaults=catalog['defaults']; normalized=dict(params)
    for k,v in params.items():
        if k!='type':value_valid(k,v)
    modality=params.get('modality') or defaults.get('TRAIN_MODALITY') or 'both'
    mode=params.get('mode') or defaults.get('TRAIN_MODE') or 'lora'
    normalized.update(modality=modality,mode=mode)
    fixed='/workspace/VLM/weights/'+('Image' if modality=='image' else 'Video')
    normalized['model']=fixed
    params={**params,'model':fixed}
    for key in ['train_json','val_json']:
        if not params.get(key):raise ValueError('폴더를 선택하고 train.json · valid.json을 생성하세요.')
        path=PurePosixPath(container_path(params[key],'json'))
        expected=PurePosixPath('/workspace/VLM/data/vlm')/modality
        if not path.is_relative_to(expected) or path.name!=('train.json' if key=='train_json' else 'valid.json'):raise ValueError('학습 대상에 맞는 생성 JSON을 사용하세요.')
    if PurePosixPath(container_path(params['train_json'],'json')).parent!=PurePosixPath(container_path(params['val_json'],'json')).parent:raise ValueError('같은 분할의 학습·검증 JSON을 사용하세요.')
    if mode=='full' and params.keys()&LORA:raise ValueError('full 방식에서는 LoRA 설정을 전달할 수 없습니다.')
    if modality=='image' and params.keys()&VIDEO:raise ValueError('image 대상에서는 영상 설정을 전달할 수 없습니다.')
    effective={};sources={}
    code={'epochs':3,'batch':1,'gradient_accumulation':8,'workers':2,'learning_rate':0.0002 if mode=='lora' else 0.00001,'lora_rank':16,'lora_alpha':16,'lora_dropout':0.05,'gradient_checkpointing':mode=='full' or modality in {'video','both'},'video_max_pixels':200704,'validation_ratio':0.1,'validation_seed':42,'eval_steps':100,'logging_steps':10}
    for k,(_,env_key,kind) in SPECS.items():
        if k in LORA and mode=='full' or k in VIDEO and modality=='image':continue
        env_key=(modality.upper()+'_MODEL') if k=='model' else env_key
        server=defaults.get(env_key,'')
        v=params[k] if k in params else server if server!='' else code.get(k)
        sources[k]='사용자 지정' if k in params else '서버 설정' if server!='' else '코드 기본값 / 자동'
        if v is not None and v!='':
            if isinstance(v,str) and (kind.startswith('int:') or kind=='integer'):v=int(v)
            elif isinstance(v,str) and kind in {'positive','ratio','dropout'}:v=float(v)
            elif isinstance(v,str) and kind=='bool':
                if v.lower() not in {'true','false','1','0','yes','no','on','off'}:raise ValueError('서버 boolean 설정 오류')
                v=v.lower() in {'true','1','yes','on'}
            value_valid(k,v)
        else:v=None
        if v is not None and kind in {'model','json'}:
            v=container_path(v,kind)
            candidates=catalog['models'] if kind=='model' else catalog['datasets']
            if not any(d['path']==v and (kind!='model' or d['modality']==modality) for d in candidates):raise ValueError(k+': 서버 목록에서 접근 가능한 항목을 선택하세요.')
            if k in params:normalized[k]=v
        effective[k]=v
    gpu=effective.get('gpu')
    if not gpu:raise ValueError('사용할 GPU를 선택하세요.')
    selected=gpu.split(',')
    if len(set(selected))!=len(selected) or not set(selected)<={g['id'] for g in catalog['gpus']}:raise ValueError('사용 가능한 GPU 목록에서 선택하세요.')
    normalized.pop('save_steps',None);normalized.pop('save_total_limit',None)
    effective['save_steps']=None;effective['save_total_limit']=None
    effective['eval_strategy']='steps' if effective['eval_steps']>0 else 'epoch'
    effective['save_strategy']='no'
    sources['save_steps']=sources['save_total_limit']=sources['save_strategy']='마지막 epoch 완료 후 한 번 저장'
    sources['eval_strategy']='코드 동작'
    auto=catalog['automatic'][modality]
    if not effective.get('train_json') and not auto['train_json']:raise ValueError('자동 탐색할 학습 JSON이 없습니다. 데이터셋을 선택하세요.')
    args=[SCRIPT,'--type','vlm']
    for key,(flag,_,_) in SPECS.items():
        if key in normalized:args.extend([flag,str(normalized[key]).lower() if type(normalized[key]) is bool else str(normalized[key])])
    warnings=['선택한 폴더를 9:1로 무작위 분할한 학습·검증 JSON을 사용합니다.','짧은 학습은 로그 주기가 1로 조정될 수 있습니다.','체크포인트는 마지막 epoch 학습 완료 후 한 번만 저장합니다.']
    return dict(params=normalized,effective=effective,sources=sources,command=shlex.join(args),effective_batch=effective['batch']*len(selected)*effective['gradient_accumulation'],automatic=auto,warnings=warnings)
