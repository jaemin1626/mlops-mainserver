#!/usr/bin/env python3
"""Prepare selected VLM folders using the project's existing normalization helpers."""
import datetime
import fcntl
import json
import os
import random
import sys
import tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent

def build(root, query):
    dataset=(root/'Dataset/vlm').resolve()
    modality=query.get('modality')
    folders=query.get('folders')
    if query.keys()-{'modality','folders'} or modality not in {'image','both','video'}:
        raise ValueError('지원하지 않는 데이터 설정')
    if not isinstance(folders,list) or not 1<=len(folders)<=100:
        raise ValueError('폴더를 1~100개 선택하세요.')
    sys.path.insert(0,str(root/'VLM/scripts/data'))
    os.environ['DATASET_ROOT']=str(root/'Dataset')
    import vlm_dataset_utils as utils
    from split_dataset import split_records
    paths=set()
    for raw in folders:
        if not isinstance(raw,str) or not raw or len(raw)>1024 or any(ord(c)<32 for c in raw) or Path(raw).is_absolute() or '..' in Path(raw).parts:
            raise ValueError('올바른 상대 폴더를 선택하세요.')
        folder=(dataset/raw).resolve()
        if not folder.is_relative_to(dataset) or not folder.is_dir():raise ValueError('데이터 폴더를 찾을 수 없습니다.')
        sources=[folder]
        parts=Path(raw).parts
        if parts[0] in {'images','videos'}:
            mirrored=(dataset/(parts[0]+'_json')/Path(*parts[1:])).resolve()
            if mirrored.is_relative_to(dataset) and mirrored.is_dir():sources.append(mirrored)
        for source in sources:paths.update(
            p.resolve() for p in source.rglob('*.json')
            if not p.name.endswith('.meta.json') and p.resolve().is_relative_to(dataset)
        )
    rows=[];seen=set();skipped=0;duplicates=0
    for path in sorted(paths):
        try:samples=utils.load_json_samples(path)
        except SystemExit as exc:raise ValueError(str(exc)) from exc
        for sample in samples:
            row=utils.normalize_tagging_sample(sample,path,dataset)
            if row is None or not utils.example_matches_modality(row,modality):skipped+=1;continue
            media=utils.resolve_media_path(utils.example_media_path(row))
            if not media.is_relative_to(dataset):raise ValueError('Dataset/vlm 외부 미디어는 사용할 수 없습니다.')
            conversations=row.get('conversations')
            if not isinstance(conversations,list) or not conversations or not all(isinstance(c,dict) and isinstance(c.get('value'),str) for c in conversations):
                raise ValueError('VLM conversations 라벨이 올바르지 않습니다: '+str(path.relative_to(dataset)))
            if str(media) in seen:duplicates+=1;continue
            seen.add(str(media));rows.append(row)
    if len(rows)<2:raise ValueError('선택한 학습 대상에 맞는 유효한 라벨이 최소 2개 필요합니다.')
    seed=random.SystemRandom().randrange(2**32)
    train,valid=split_records(rows,0.1,seed)
    day=datetime.datetime.now().strftime('%Y%m%d')
    output=root/'VLM/data/vlm'/modality/day
    if not output.resolve().is_relative_to((root/'VLM/data/vlm').resolve()):raise ValueError('Invalid output directory')
    output.mkdir(parents=True,exist_ok=True)
    files={}
    for name,data in [('train.json',train),('valid.json',valid)]:
        with tempfile.NamedTemporaryFile(mode='w',encoding='utf-8',dir=output,delete=False) as stream:
            json.dump(data,stream,ensure_ascii=False,indent=2);stream.write('\n');tmp=stream.name
        os.replace(tmp,output/name)
        files[name]='/workspace/'+str((output/name).relative_to(root))
    return dict(ok=True,train=len(train),valid=len(valid),skipped=skipped,duplicates=duplicates,seed=seed,files=files,train_json=files['train.json'],val_json=files['valid.json'])

if __name__=='__main__':
    try:
        with open(ROOT/'VLM/.mlops_dataset.lock','w') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            print(json.dumps(build(ROOT,json.load(sys.stdin)),ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'error':str(exc)},ensure_ascii=False));sys.exit(1)
