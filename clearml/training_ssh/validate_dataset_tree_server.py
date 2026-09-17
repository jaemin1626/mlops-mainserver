"""Run on the training server to check tree selection using disposable fixtures."""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
sys.path.insert(0,os.environ.get('TRAINING_SSH_ROOT','/home/intellivix/train')+'/scripts')
from mlops_dataset_tree import ROOT,inventory,select,prepare,upload
with tempfile.TemporaryDirectory() as tmp:
    root=Path(tmp);detector=root/'Dataset/detector/trainset';detector.mkdir(parents=True)
    for i in range(10):
        (detector/f'{i}.jpg').write_bytes(b'fixture image '+str(i).encode());(detector/f'{i}.txt').write_text('0 0.5 0.5 0.2 0.2\n')
    (detector/'missing.jpg').write_bytes(b'no label');(detector/'bad.jpg').write_bytes(b'bad box');(detector/'bad.txt').write_text('0 0.5 0.5 -1 2')
    cat=inventory(root,'detector');assert len(cat['records'])==10 and cat['skipped']==2
    q={'dataset_type':'detector','selected_folders':['.','trainset'],'classes':['person']}
    state,_=select(root,q);assert len(state['selected_files'])==10 and (len(state['train']),len(state['valid']))==(9,1)
    mismatch=detector/'class-mismatch';mismatch.mkdir()
    for i in range(2):
        (mismatch/f'{i}.jpg').write_bytes(b'mismatch');(mismatch/f'{i}.txt').write_text('2 0.5 0.5 0.2 0.2\n')
    try:prepare(root,{'dataset_type':'detector','selected_folders':['trainset/class-mismatch'],'classes':['person','car']})
    except ValueError as exc:
        assert '최대 클래스 번호는 2' in str(exc) and '클래스는 2개' in str(exc),exc
    else:raise AssertionError('class count mismatch accepted')
    shutil.rmtree(mismatch)
    first=prepare(root,q);snapshot=(root/first['manifest']['bundle'].removeprefix('/workspace/')/'manifest.json').read_text()
    source=first['manifest'];q.update(source_manifest=source,selected_files=source['selected_files'][:5]);second=prepare(root,q)
    assert first['token']!=second['token'] and second['manifest']['file_count']==5
    assert (root/first['manifest']['bundle'].removeprefix('/workspace/')/'manifest.json').read_text()==snapshot
    assert not set(second['manifest']['train'])&set(second['manifest']['valid'])
    helpers=root/'VLM/scripts/data';helpers.mkdir(parents=True)
    for name in ['vlm_dataset_utils.py','split_dataset.py']:shutil.copy2(ROOT/'VLM/scripts/data'/name,helpers/name)
    vlm=root/'Dataset/vlm'
    for kind,count in [('images',10),('videos',2)]:
        media=vlm/kind/'sample';labels=vlm/(kind+'_json')/'sample';media.mkdir(parents=True);labels.mkdir(parents=True)
        for i in range(count):
            suffix='.jpg' if kind=='images' else '.mp4';(media/f'{i}{suffix}').write_bytes(b'fixture')
            (labels/f'{i}.json').write_text(json.dumps({'media':'../'+kind+'/sample/'+str(i)+suffix,'conversations':[{'from':'human','value':'question'},{'from':'gpt','value':'answer'}]}))
    for modality,count in [('image',10),('video',2),('both',12)]:
        state,_=select(root,{'dataset_type':'vlm','modality':modality,'selected_folders':['images','images_json','videos']});assert state['file_count']==count
    for folders in [['../'],['unknown']]:
        try:select(root,{'dataset_type':'detector','selected_folders':folders})
        except ValueError:pass
        else:raise AssertionError('invalid folder accepted')
print('PASS: tree recursion, path deduplication, YOLO validation, media/JSON pairing, modality filters, disjoint split preservation, additions/removals and immutable generated bundles')
