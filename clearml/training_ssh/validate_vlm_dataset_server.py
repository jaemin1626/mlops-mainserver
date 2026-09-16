import sys,json,tempfile,shutil
from pathlib import Path
sys.path.insert(0,'/home/intellivix/train/scripts')
from mlops_vlm_dataset import build,ROOT
with tempfile.TemporaryDirectory() as tmp:
    root=Path(tmp);helpers=root/'VLM/scripts/data';helpers.mkdir(parents=True)
    for name in ['vlm_dataset_utils.py','split_dataset.py']:shutil.copy2(ROOT/'VLM/scripts/data'/name,helpers/name)
    dataset=root/'Dataset/vlm'
    for kind,count in [('images',10),('videos',2)]:
        media=dataset/kind/'sample';labels=dataset/(kind+'_json')/'sample';media.mkdir(parents=True);labels.mkdir(parents=True)
        for i in range(count):
            suffix='.jpg' if kind=='images' else '.mp4';(media/(str(i)+suffix)).write_bytes(b'fixture')
            (labels/(str(i)+'.json')).write_text(json.dumps({'media':'../'+kind+'/sample/'+str(i)+suffix,'conversations':[{'from':'human','value':'question'},{'from':'gpt','value':'answer'}]}))
    r=build(root,{'folders':['images/sample','images_json/sample'],'modality':'image'});assert (r['train'],r['valid'],r['duplicates'])==(9,1,0),r
    r=build(root,{'folders':['images','videos'],'modality':'both'});assert r['train']+r['valid']==12,r
    train=json.loads((root/r['train_json'].removeprefix('/workspace/')).read_text());valid=json.loads((root/r['val_json'].removeprefix('/workspace/')).read_text());assert not {x.get('image',x.get('video')) for x in train}&{x.get('image',x.get('video')) for x in valid}
    r=build(root,{'folders':['images','videos'],'modality':'video'});assert (r['train'],r['valid'],r['skipped'])==(1,1,10),r
    for folders in [['../'],['unknown']]:
        try:build(root,{'folders':folders,'modality':'image'})
        except ValueError:pass
        else:raise AssertionError('invalid folder accepted')
print('PASS: folder recursion/mirrored labels, 9:1 split, modality filter, no train/validation overlap, invalid path rejection')
